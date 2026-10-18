#!/usr/bin/env python3
"""Claudesk's guest-side Code runner.

Runs inside the Cowork VM, as a systemd service installed into the guest's own
rootfs by scripts/install-guest-runner.sh. It speaks the self-hosted pool
protocol to the bridge (the tenant's own instance, reachable from the guest
through QEMU's user-mode networking at 10.0.2.2), takes the sessions the pool
offers, runs Claude Code on each in the guest, and writes the transcript back.

Why this and not `claude self-hosted-runner`: the agent must execute *inside the
VM*, and the only process host Claude Code offers is local — its SSH session
host keeps the agent in the container and merely runs commands remotely. This
service is the guest's own; nothing about the session leaves the VM except the
events it writes to the bridge. See docs/code-in-cowork-vm.md.

The agent is asked the way the product's own runner asks its child — read from
the shipped binary: `--print`, stream-json in and out, `--verbose`, partial
messages, the session's model and permission mode — minus the `--sdk-url`
transport, which the compiled binary only allows for Anthropic's own hosts. The
prompt is a stream-json user message on the agent's stdin, never an argument, so
the agent is never started "without a prompt"; every assistant message, tool
result, partial update and the turn's own `result` message (the terminal the
reader closes a turn on) is written back as an event as it happens; stderr is
the agent's own logging and stays out of the transcript; and later turns
`--resume` the conversation id the agent stamped on its own events.

Stdlib only, on purpose: the guest is a stock Ubuntu image, and this must not
depend on anything we would have to install into it.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "2.1.0"


def env(name, default=""):
    return os.environ.get(name, default).strip()


BASE = env("CLAUDESK_RUNNER_BASE", "http://10.0.2.2:8080").rstrip("/")
SECRET = env("CLAUDESK_RUNNER_SECRET")


def resolve_claude_bin(configured):
    """The agent binary, from whatever the deployment configured.

    The guest's own product binary lives at `/opt/cowork/claude-bin`, and that
    path is a *directory* — the runnable is `claude` inside it, staged there by
    the guest's own daemon. Accept either the directory or the executable
    itself, and keep the well-known locations as fallbacks, so a deployment
    that names the directory (the product's own spelling) still runs. What the
    installer stages is `/opt/claudesk/claude`.
    """
    candidates = [configured]
    if configured:
        candidates.append(os.path.join(configured, "claude"))
    candidates += ["/opt/claudesk/claude", "/opt/cowork/claude-bin/claude",
                   "/usr/local/bin/claude"]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return configured


CLAUDE_BIN = resolve_claude_bin(env("CLAUDESK_RUNNER_CLAUDE_BIN", "/opt/claudesk/claude"))
CHECKOUT = env("CLAUDESK_RUNNER_CHECKOUT", "/sessions")
# The host filesystem root shared into the guest as one virtiofs mount
# (`claudeshared`, mounted by the guest's own coworkd). A session placed with a
# folder names a host path — the account's `/workspace/...` — so its guest path
# is that path joined onto this root. Overridable for a deployment whose guest
# mounts the share elsewhere.
SHARED_ROOT = env("CLAUDESK_RUNNER_SHARED_ROOT", "/mnt/.virtiofs-root")
POLL_SECONDS = float(env("CLAUDESK_RUNNER_POLL_SECONDS", "5") or 5)
# How the agent is asked — flag for flag what the product's own runner passes
# its child (from the shipped binary's spawn: `--print`, stream-json both ways,
# partial messages), minus `--sdk-url`, whose compiled host allowlist only
# admits Anthropic's own endpoints. `--verbose` is required with
# `--output-format stream-json` under `--print`; `--include-partial-messages` is
# what lets the desktop stream text as it is written. A deployment with a
# different agent replaces this whole list.
AGENT_ARGS = env("CLAUDESK_RUNNER_AGENT_ARGS",
                 "--print --input-format stream-json --output-format stream-json"
                 " --verbose --include-partial-messages").split()
# The agent's HOME. The service runs with ProtectHome=read-only, so the guest
# image's /root stays untouched; a directory of the runner's own also gives the
# agent a writable place for the transcripts `--resume` replays, and keeps the
# guest image's own Claude settings (meant for the product's session-bound
# binary) out of the plain binary this runner stages.
RUNNER_HOME = env("CLAUDESK_RUNNER_HOME", "/var/lib/claudesk-runner/home")
# One turn's wall clock. Long enough for real work, short enough that a wedged
# agent does not hold the session forever.
TURN_TIMEOUT = float(env("CLAUDESK_RUNNER_TIMEOUT_SECONDS", "1800") or 1800)
ONCE = "--once" in sys.argv[1:]

RE_SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def log(message):
    sys.stdout.write("[guest-runner] %s\n" % message)
    sys.stdout.flush()


# The per-runner credential handed out by register(). Polls and results use it
# after registration so the bridge can attribute a poll to *this* runner; with
# the shared pool secret it could only say "someone on the pool polled", which
# left dead registrations looking online forever.
RUNNER_TOKEN = ""


def request(path, body=None, token=None, method=None, headers=None):
    """One call to the bridge. Returns (status, parsed-body-or-text)."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 method=method or ("POST" if body is not None else "GET"))
    req.add_header("content-type", "application/json")
    req.add_header("authorization", "Bearer %s" % (token or RUNNER_TOKEN or SECRET))
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            text = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        status = error.code
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text


def expect(answer, what):
    status, body = answer
    if status != 200:
        raise RuntimeError("%s answered %s: %s" % (what, status, str(body)[:200]))
    return body


def register():
    global RUNNER_TOKEN
    body = expect(request("/v1/code/runners/self-hosted/runners/register", {
        "runner_version": VERSION,
        "use_anthropic_git_proxy": False,
        "client_label": "claudesk-guest-runner",
    }), "register")
    RUNNER_TOKEN = body.get("runner_token") or ""
    log("registered as %s" % body["runner_id"])
    return body["runner_id"]


def poll():
    """An empty poll is held open by the bridge until there is work.

    The runner cannot be dialled (the guest sits behind QEMU's user-mode
    networking, with nothing forwarded in), so it is the side that opens the
    connection — and it keeps that one request open. The bridge answers it the
    instant a session is placed or requeued, which makes pickup immediate
    rather than "on the next tick". The value below is a ceiling, not a delay.
    """
    headers = {}
    try:
        wait = float(env("CLAUDESK_RUNNER_POLL_WAIT", "20") or 0)
    except ValueError:
        wait = 0
    # `--once` is a one-shot probe (smokes, `--status` runs): it wants the
    # immediate answer, not the held one.
    if wait > 0 and not ONCE:
        headers["x-claudesk-poll-wait"] = str(wait)
    return expect(request("/v1/code/runners/self-hosted/spawn-hints/poll", {},
                          headers=headers), "poll")


def prompt_of(events):
    """The last user message a session carries — what the agent is asked."""
    for event in reversed(events or []):
        payload = event.get("payload") or {}
        if payload.get("type") != "user":
            continue
        content = (payload.get("message") or {}).get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text = "\n".join(part.get("text", "") for part in content
                             if isinstance(part, dict) and part.get("type") == "text")
            if text:
                return text
    return ""


def content_of(events):
    """The last user message's content blocks — text and images.

    The bridge's opening turn may carry image blocks beside the text (a fire
    with images). The agent's stream-json input takes the same block list, so
    the turn is forwarded as it arrived rather than flattened to text.
    """
    for event in reversed(events or []):
        payload = event.get("payload") or {}
        if payload.get("type") != "user":
            continue
        content = (payload.get("message") or {}).get("content")
        if isinstance(content, str):
            if content.strip():
                return [{"type": "text", "text": content}]
            continue
        if not isinstance(content, list):
            continue
        blocks = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    blocks.append({"type": "text", "text": text})
            elif part.get("type") == "image":
                source = part.get("source")
                if (isinstance(source, dict)
                        and source.get("type") == "base64"
                        and isinstance(source.get("data"), str)
                        and source.get("data")):
                    blocks.append({"type": "image", "source": {
                        "type": "base64",
                        "media_type": source.get("media_type") or "image/png",
                        "data": source["data"],
                    }})
        if blocks:
            return blocks
    return []


def resume_id(events):
    """The conversation to `--resume`, read off the agent's own events.

    Every message the agent emits carries its session uuid — the agent's own,
    distinct from the bridge's session id (a `cse_…` handle). The last one seen
    is the conversation to continue; on a first turn there is none and a fresh
    conversation starts. Read back from the transcript rather than kept in a
    file of our own, so the transcript stays the one source of truth.
    """
    for event in reversed(events or []):
        payload = event.get("payload") or {}
        if payload.get("type") != "assistant":
            continue
        candidate = payload.get("session_id")
        if isinstance(candidate, str) and RE_SESSION_ID.match(candidate):
            return candidate
    return ""


def latest_control_request(events, subtype):
    """The last client control request of one subtype in the session log.

    The renderer changes a running session's model or permission mode by
    appending a `control_request` event (`set_model`, `set_permission_mode`)
    rather than by re-creating the session. The agent is spawned fresh for each
    turn, so the runner can honour those requests by reading the latest one and
    applying it to the turn's argv — otherwise the change is written down and
    never reaches the process the user is talking to. Payloads are taken
    directly and from the `internal_anthropic_catchall` wrapper older callers
    used for the same control request.
    """
    found = None
    for event in events or []:
        payload = event.get("payload") if isinstance(event, dict) else None
        if not isinstance(payload, dict):
            continue
        if payload.get("type") == "control_request":
            request = payload.get("request")
        else:
            catchall = payload.get("internal_anthropic_catchall")
            request = catchall.get("request") if isinstance(catchall, dict) else None
        if not isinstance(request, dict) or request.get("subtype") != subtype:
            continue
        found = request
    return found


def run_git(directory, *arguments):
    """Run git in `directory`; returns (ok, output). Never raises.

    Every invocation disables `core.fsmonitor`: the workspace is writable by the
    agent, and a repo config that names a program must not get one executed
    even here, in the guest (the host never runs git over workspace content at
    all).
    """
    try:
        completed = subprocess.run(
            ["git", "-C", directory, "-c", "core.fsmonitor=false"] + list(arguments),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=120, check=False)
    except FileNotFoundError:
        return False, "git is not installed in the guest"
    except (OSError, subprocess.SubprocessError) as error:
        return False, "git could not run: %s" % error
    return completed.returncode == 0, (completed.stdout or "").strip()


def guest_folder(host_path):
    """Map a host path the composer chose onto the guest's shared mount.

    The guest sees the host's filesystem at SHARED_ROOT, so `/workspace/x` is
    `<SHARED_ROOT>/workspace/x`. A path already expressed in guest terms is
    accepted as-is; anything that is not a directory here is None.
    """
    if not isinstance(host_path, str) or not host_path.startswith("/"):
        return None
    if host_path == SHARED_ROOT or host_path.startswith(SHARED_ROOT + "/"):
        return host_path if os.path.isdir(host_path) else None
    candidate = os.path.join(SHARED_ROOT, host_path.lstrip("/"))
    return candidate if os.path.isdir(candidate) else None


def session_workdir(session, config):
    """The directory the agent runs in, from the session's start options.

    The composer may place a session with a folder (`cwd`), a branch
    (`source_branch`) and an isolated worktree (`use_worktree`). Returns
    `(cwd, error)`: an option the guest cannot honour is an error the caller
    reports as the session's failure, never a silent fallback — the person
    picked that folder and branch. With no folder the runner keeps its own
    checkout, exactly as before.
    """
    folder = config.get("cwd")
    branch = config.get("source_branch")
    branch = branch.strip() if isinstance(branch, str) else ""
    worktree = config.get("use_worktree") is True

    if not isinstance(folder, str) or not folder:
        return (CHECKOUT if os.path.isdir(CHECKOUT) else "/"), None

    directory = guest_folder(folder)
    if directory is None:
        return None, ("the session's folder %s is not visible in the guest "
                      "(expected under %s)" % (folder, SHARED_ROOT))

    ok, top = run_git(directory, "rev-parse", "--show-toplevel")
    repo = top if ok and top and os.path.isdir(top) else None
    if (branch or worktree) and not repo:
        return None, ("the session's folder is not a git repository, so its "
                      "branch/worktree options cannot be honoured")

    def inside_worktree(worktree_path):
        # Run where the person pointed: a folder below the repository root
        # keeps its relative place inside the isolated copy when it exists.
        if directory == repo:
            return worktree_path
        relative = os.path.relpath(directory, repo)
        candidate = os.path.join(worktree_path, relative)
        return candidate if os.path.isdir(candidate) else worktree_path

    if not worktree:
        if branch:
            ok, output = run_git(repo, "checkout", branch)
            if not ok:
                return None, ("could not check out branch %s: %s"
                              % (branch, output[-400:] or "git failed"))
            log("session checkout %s on branch %s" % (repo, branch))
        return directory, None

    # Worktree sessions are deterministic per session, so a later turn resumes
    # in the same copy. The branch starts from the selected branch (or HEAD)
    # and is named after the session; a collision gets a suffix.
    suffix = re.sub(r"[^A-Za-z0-9_-]", "", session)[-12:] or "session"
    worktree_path = os.path.join(repo, ".claude", "worktrees", suffix)
    if os.path.isdir(worktree_path):
        log("session reusing worktree %s" % worktree_path)
        return inside_worktree(worktree_path), None
    start = branch or "HEAD"
    branch_name = "claude/" + suffix
    output = ""
    for attempt in range(1, 20):
        ok, output = run_git(repo, "worktree", "add", "-b", branch_name,
                             worktree_path, start)
        if ok:
            log("session worktree %s (branch %s from %s)"
                % (worktree_path, branch_name, start))
            return inside_worktree(worktree_path), None
        if "already exists" not in output.lower():
            break
        branch_name = "claude/%s-%d" % (suffix, attempt + 1)
    return None, ("could not create a worktree in %s: %s"
                  % (repo, output[-400:] or "git failed"))


# --- UI requests -----------------------------------------------------------
#
# The web Code composer asks the guest — not the host — for its folder listing
# and git metadata, so nothing in the privileged tenant container reads the
# workspace. A request rides the runner's poll (`requests` beside `hints`) and
# is answered by posting to the pool's result leg.

def respond_to_request(request_id, result=None, error=None):
    body = {"request_id": request_id}
    if error is not None:
        body["error"] = str(error)[:500]
    else:
        body["result"] = result
    try:
        expect(request("/v1/code/runners/self-hosted/requests/result", body),
               "request result")
    except Exception as failure:  # noqa: BLE001 - the UI request is best-effort
        log("could not answer request %s: %s" % (request_id, failure))


def host_path_of(guest_path):
    """The host path a guest path under the shared root stands for."""
    root = os.path.realpath(SHARED_ROOT)
    guest = os.path.realpath(guest_path)
    if guest == root:
        return "/"
    return "/" + os.path.relpath(guest, root)


def contained_path(host_path, root=None):
    """Map a host path onto the shared mount, confined to `root` if given.

    Returns (guest_path, guest_root). Raises ValueError for anything that is
    not under the shared mount or escapes the given workspace root — including
    through a symlink.
    """
    if not isinstance(host_path, str) or not host_path.startswith("/"):
        raise ValueError("a host path is required")
    mounted = os.path.realpath(SHARED_ROOT)
    guest = os.path.realpath(os.path.join(mounted, host_path.lstrip("/")))
    if guest != mounted and not guest.startswith(mounted + os.sep):
        raise ValueError("the path is outside the shared workspace")
    if root is None:
        return guest, mounted
    if not isinstance(root, str) or not root.startswith("/"):
        raise ValueError("a workspace root is required")
    guest_root = os.path.realpath(os.path.join(mounted, root.lstrip("/")))
    if guest_root != mounted and not guest_root.startswith(mounted + os.sep):
        raise ValueError("the workspace root is outside the shared workspace")
    if guest != guest_root and not guest.startswith(guest_root + os.sep):
        raise ValueError("the path is outside the workspace")
    return guest, guest_root


def list_folders(params):
    root = params.get("root") or "/workspace"
    guest, guest_root = contained_path(params.get("path") or root, root)
    if not os.path.isdir(guest):
        raise ValueError("workspace path is not a folder")
    folders = []
    truncated = False
    try:
        entries = sorted(os.scandir(guest), key=lambda entry: entry.name.casefold())
    except OSError as error:
        raise ValueError("could not read the folder: %s" % error)
    for entry in entries:
        try:
            if not entry.is_dir():
                continue
            real = os.path.realpath(entry.path)
            if real != guest_root and not real.startswith(guest_root + os.sep):
                continue
            folders.append({"name": entry.name, "path": host_path_of(real)})
            if len(folders) == 1000:
                truncated = True
                break
        except OSError:
            continue
    return {
        "root": host_path_of(guest_root),
        "path": host_path_of(guest),
        "parent": None if guest == guest_root else host_path_of(os.path.dirname(guest)),
        "folders": folders,
        "truncated": truncated,
    }


def create_folder(params):
    root = params.get("root") or "/workspace"
    name = params.get("name")
    if (not isinstance(name, str) or not name or name in (".", "..")
            or "/" in name or "\\" in name or len(name) > 255
            or any(ord(character) < 32 or ord(character) == 127 for character in name)):
        raise ValueError("folder name is invalid")
    parent, guest_root = contained_path(params.get("path") or root, root)
    target = os.path.join(parent, name)
    try:
        os.mkdir(target)
    except FileExistsError:
        raise ValueError("a folder with that name already exists")
    except OSError as error:
        raise ValueError("could not create the folder: %s" % error)
    real = os.path.realpath(target)
    if real != guest_root and not real.startswith(guest_root + os.sep):
        raise ValueError("could not create the folder")
    return {"path": host_path_of(real), "name": name}


def remote_slug(url):
    """`owner/name` from the remote URL forms git accepts, or None."""
    for pattern in (
        r"^[^@]+@[^:]+:([^/]+/[^/]+?)(?:\.git)?$",
        r"^[a-z][a-z0-9+.-]*://[^/]+/([^/]+/[^/]+?)(?:\.git)?$",
    ):
        match = re.match(pattern, url.strip())
        if match:
            return match.group(1)
    return None


def git_info(params):
    guest, _ = contained_path(params.get("path"))
    ok, _ = run_git(guest, "rev-parse", "--is-inside-work-tree")
    if not ok:
        return None
    ok, top = run_git(guest, "rev-parse", "--show-toplevel")
    repo = top if ok and top else guest
    ok, branch = run_git(repo, "symbolic-ref", "--short", "HEAD")
    branch = branch if ok and branch else None
    default = None
    ok, head = run_git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if ok and head:
        default = head.split("/", 1)[1] if head.startswith("origin/") else head
    if not default:
        for candidate in ("main", "master"):
            ok, _ = run_git(repo, "rev-parse", "--verify", "--quiet", candidate)
            if ok:
                default = candidate
                break
    ok, remote = run_git(repo, "remote", "get-url", "origin")
    return {
        "repo": remote_slug(remote) if ok else None,
        "branch": branch,
        "defaultBranch": default,
    }


def list_branches(params):
    guest, _ = contained_path(params.get("path"))
    ok, top = run_git(guest, "rev-parse", "--show-toplevel")
    if not ok or not top:
        return []
    ok, output = run_git(top, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    if not ok:
        return []
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def worktree_state(params):
    guest, _ = contained_path(params.get("path"))
    ok, top = run_git(guest, "rev-parse", "--show-toplevel")
    if not ok or not top:
        return "unknown"
    ok, output = run_git(top, "status", "--porcelain")
    if not ok:
        return "unknown"
    return "dirty" if output.strip() else "clean"


def branch_switch_conflict(params):
    """True when switching to `branch` is blocked, matching the renderer.

    The hook's name is read literally by its caller: a true answer opens the
    dirty-tree/conflict dialog instead of applying the switch, and its fallback
    is `isWorkingTreeDirty` (true = blocked). So this answers "conflict?", not
    "safe?": a missing branch or one already checked out in another worktree is
    a conflict; anything else is not.
    """
    guest, _ = contained_path(params.get("path"), params.get("root"))
    ok, top = run_git(guest, "rev-parse", "--show-toplevel")
    if not ok or not top:
        return False
    branch = params.get("branch")
    if not isinstance(branch, str) or not branch:
        return False
    ok, _ = run_git(top, "rev-parse", "--verify", "--quiet", branch)
    if not ok:
        return True
    ok, output = run_git(top, "worktree", "list", "--porcelain")
    if not ok:
        return False
    current = None
    for line in output.splitlines():
        if line.startswith("worktree "):
            current = line[len("worktree "):]
        elif line.startswith("branch ") and current is not None:
            ref = line[len("branch "):]
            if ref == "refs/heads/" + branch and os.path.realpath(current) != os.path.realpath(top):
                return True
    return False


REQUEST_HANDLERS = {
    "branch_switch_conflict": branch_switch_conflict,
    "create_folder": create_folder,
    "git_info": git_info,
    "list_branches": list_branches,
    "list_folders": list_folders,
    "worktree_state": worktree_state,
}


def handle_runner_request(item):
    request_id = item.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        return
    handler = REQUEST_HANDLERS.get(item.get("method"))
    params = item.get("params") if isinstance(item.get("params"), dict) else {}
    if handler is None:
        respond_to_request(request_id, error="unknown request method")
        return
    try:
        result = handler(params)
    except Exception as error:  # noqa: BLE001 - reported to the UI
        log("request %s failed: %s" % (request_id, error))
        respond_to_request(request_id, error=str(error))
    else:
        respond_to_request(request_id, result=result)


def run_agent(argv, cwd, content, write):
    """One headless turn of the agent: the prompt in, the event stream out.

    `content` is the user message's content — a string, or the block list the
    transcript carries (text and images) — written as a stream-json user
    message on stdin, the channel the SDK uses. Stdin ends there, which is what
    tells the agent the turn's input is complete. Every assistant message, tool
    result and partial update is queued to a writer thread so a slow bridge
    never stalls the agent's own output pipe. Returns (exit code, result event
    or None, timed out, forwarded count, write failures, stderr lines).
    """
    environment = dict(os.environ)
    if os.path.isdir(RUNNER_HOME):
        environment["HOME"] = RUNNER_HOME
    # The service runs as root (it is the guest's own systemd unit), and the
    # agent refuses bypass permissions as root unless it is told it is inside a
    # sandbox. It is: this process only exists to spawn agents inside the
    # account's Cowork VM. Without this, a session placed in bypass mode is
    # clamped to Accept edits.
    environment.setdefault("IS_SANDBOX", "1")
    process = subprocess.Popen(argv, cwd=cwd, env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1,
                               encoding="utf-8", errors="replace")
    errors = []

    def drain_errors():
        for line in process.stderr:
            line = line.rstrip()
            if line:
                errors.append(line)

    threading.Thread(target=drain_errors, daemon=True).start()

    pending = queue.Queue()
    failures = []

    def writer():
        while True:
            payload = pending.get()
            if payload is None:
                return
            if failures:
                continue
            try:
                write(payload)
            except Exception as error:  # noqa: BLE001 - the run cannot land without this
                failures.append(str(error))

    writer_thread = threading.Thread(target=writer, daemon=True)
    writer_thread.start()

    timed_out = []
    watchdog = threading.Timer(TURN_TIMEOUT, lambda: (timed_out.append(True), process.kill()))
    watchdog.start()

    def end_after_result():
        # A build that keeps waiting for more input after its result must not
        # hold the session; stdin has already ended, so give it a moment to
        # exit on its own, then end it.
        for _ in range(6):
            if process.poll() is not None:
                return
            time.sleep(0.5)
        process.terminate()
        time.sleep(2)
        if process.poll() is None:
            process.kill()

    forwarded = 0
    result = None
    try:
        blocks = ([{"type": "text", "text": content}]
                  if isinstance(content, str) else content)
        message = {"type": "user",
                   "message": {"role": "user", "content": blocks},
                   "parent_tool_use_id": None,
                   "session_id": ""}
        try:
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
        except OSError:
            pass  # the agent died before reading; its exit says why
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                log("agent printed a non-json line: %s" % line[:200])
                continue
            kind = event.get("type")
            if kind in ("assistant", "user", "stream_event"):
                pending.put(event)
                forwarded += 1
            elif kind == "result":
                result = event
                threading.Thread(target=end_after_result, daemon=True).start()
            elif kind == "system" and event.get("subtype") == "init":
                log("agent %s initialized (model %s, permission %s)" % (
                    event.get("claude_code_version"), event.get("model"),
                    event.get("permissionMode")))
        code = process.wait()
    finally:
        watchdog.cancel()
        pending.put(None)
        writer_thread.join(timeout=60)
    return code, result, bool(timed_out), forwarded, failures, errors


def run_session(hint):
    session = hint["session_uuid"]
    quoted = urllib.parse.quote(session)
    token = expect(request("/v1/code/runners/self-hosted/sessions/%s/token" % quoted,
                           {}), "token")["session_token"]

    def write(payload):
        expect(request("/v1/code/sessions/%s/events" % quoted, {"payload": payload}, token),
               "events")

    def finish(path, body):
        expect(request("/v1/code/runners/self-hosted/sessions/%s/%s" % (quoted, path),
                       body, token), path)

    status, history = request("/v1/code/sessions/%s/events" % quoted, token=token)
    events = (history or {}).get("data") if isinstance(history, dict) else []
    content = content_of(events)
    resume = resume_id(events)

    # The session's own settings — the composer's model choice among them —
    # ride the session document; the agent must be asked with them or it
    # answers as whatever its default is. The same config carries the start
    # options (folder, branch, worktree).
    config = session_settings(session)
    model = config.get("model")
    model = model if isinstance(model, str) and model else None
    permission_mode = config.get("permission_mode")
    permission_mode = (permission_mode if isinstance(permission_mode, str)
                       and permission_mode else None)
    effort = config.get("effort_level")
    effort = effort if isinstance(effort, str) and effort else None
    # A change made while the session is already running is a control request
    # in the transcript, not a rewritten session document. The latest one wins
    # over the create config (the start intent emits the same subtype, so this
    # also covers a mode the create body dropped).
    control = latest_control_request(events, "set_permission_mode")
    if isinstance(control, dict):
        mode = control.get("mode")
        if isinstance(mode, str) and mode:
            permission_mode = mode
    control = latest_control_request(events, "set_model")
    if isinstance(control, dict):
        chosen = control.get("model")
        if isinstance(chosen, str) and chosen:
            model = chosen

    if not (os.path.isfile(CLAUDE_BIN) and os.access(CLAUDE_BIN, os.X_OK)):
        # A directory here is the classic miss (the product's own path is one);
        # resolution above should have taken it, so what lands here is genuinely
        # absent or not executable — say which.
        reason = "%s is not an executable file in the guest" % CLAUDE_BIN
        finish("report-failure", {"reason": reason, "setup_failure_kind": "missing_binary"})
        log("session %s: %s" % (session, reason))
        return session, 127

    if not content:
        reason = "the session's transcript carries no user message to answer"
        finish("report-failure", {"reason": reason, "failure_kind": "bad_input"})
        log("session %s: %s" % (session, reason))
        return session, 2

    argv = [CLAUDE_BIN] + AGENT_ARGS
    if model is not None:
        argv += ["--model", model]
    if permission_mode is not None:
        argv += ["--permission-mode", permission_mode]
    if effort is not None:
        argv += ["--effort", effort]
    # The working directory comes from the session's start options. With none,
    # the checkout is where the work happens; a guest without it (a fresh
    # image, a stopped VM) still runs, from /, rather than failing the session
    # on a directory.
    cwd, workdir_error = session_workdir(session, config)
    if workdir_error is not None:
        finish("report-failure", {"reason": workdir_error,
                                  "failure_kind": "setup_failed"})
        log("session %s: %s" % (session, workdir_error))
        return session, 2
    started = time.time()
    log("session %s: turn with %s (model %s, effort %s, permission %s, resume %s)" % (
        session, " ".join(AGENT_ARGS), model or "default", effort or "default",
        permission_mode or "default", resume or "none"))

    def turn(extra):
        return run_agent(argv + extra, cwd, content, write)

    code, result, timed_out, forwarded, failures, errors = turn(
        ["--resume", resume] if resume else [])
    if (resume and forwarded == 0 and failures == [] and result is not None
            and result.get("is_error")
            and any("No conversation found" in line for line in errors)):
        # The agent's own transcripts are gone (rebuilt image, wiped home);
        # the bridge transcript still has the conversation, the agent does
        # not — start a fresh one rather than failing the turn.
        log("session %s: no conversation %s in the guest; starting a new one"
            % (session, resume))
        code, result, timed_out, forwarded, failures, errors = turn([])
    duration = time.time() - started
    if result is not None:
        log("session %s: turn done in %.1fs (%s events, %s turns, cost %s)" % (
            session, duration, forwarded, result.get("num_turns"),
            result.get("total_cost_usd")))
    # The turn's own `result` message belongs in the transcript too: it is the
    # terminal the reader closes the turn on (the SDK stream carries it, the
    # wire contract lists it as a transcript type, and a reader that never
    # sees one holds the turn open — rows around tool calls stay unplaced).
    # Written after the retry decision, so a discarded first attempt leaves
    # nothing behind.
    if result is not None and not failures:
        try:
            write(result)
        except Exception as error:  # noqa: BLE001 - recorded with the run
            failures.append(str(error))

    if failures:
        finish("report-failure", {"reason": "could not write events: %s" % failures[0][:300],
                                  "failure_kind": "agent_failed"})
    elif timed_out:
        finish("report-failure", {"reason": "agent ran longer than %ss" % int(TURN_TIMEOUT),
                                  "failure_kind": "timeout"})
    elif code == 0 and result is not None and not result.get("is_error"):
        finish("release", {})
    else:
        reason = ""
        if result is not None and isinstance(result.get("result"), str) and result["result"].strip():
            reason = result["result"].strip()
        elif errors:
            reason = errors[-1]
        elif result is None and code == 0:
            reason = "agent exited 0 without a result message"
        else:
            reason = "agent exited %s" % code
        finish("report-failure", {"reason": reason[:600], "failure_kind": "agent_failed"})
    log("session %s: agent exited %s" % (session, code))
    return session, code


def session_settings(session_id):
    """The config the session was placed with.

    The create body's own shape: `model`, `permission_mode`, and the start
    options `cwd`, `source_branch` and `use_worktree`. Absent, the agent's
    defaults stand and the runner keeps its checkout.
    """
    status, document = request("/v1/code/sessions/%s" % quoted_id(session_id))
    if status != 200 or not isinstance(document, dict):
        return {}
    config = (document.get("session") or {}).get("config")
    return config if isinstance(config, dict) else {}


def quoted_id(session_id):
    return urllib.parse.quote(str(session_id), safe="")


def prepare_home():
    try:
        os.makedirs(RUNNER_HOME, mode=0o700, exist_ok=True)
    except OSError as error:
        log("could not create %s (%s); the agent keeps the service's HOME" % (RUNNER_HOME, error))


def run_sessions_forever(session_queue):
    """Run session turns off the poll thread.

    A turn can last as long as TURN_TIMEOUT, and the Code UI's folder and git
    lookups ride the same poll as work. Running the agent inline meant the
    runner stopped polling for the whole turn, so those lookups timed out
    whenever a session was active — exactly when the user is in the Code
    surface. One worker keeps turns serialized (the previous behavior) while
    the poll loop stays free to answer UI requests.
    """
    while True:
        hint = session_queue.get()
        try:
            run_session(hint)
        except Exception as error:  # noqa: BLE001 - keep serving the pool
            log("session %s failed: %s" % (hint.get("session_uuid"), error))


def main():
    if not SECRET:
        log("CLAUDESK_RUNNER_SECRET is not set; refusing to poll")
        return 2
    if "--output-format" not in AGENT_ARGS:
        log("warning: CLAUDESK_RUNNER_AGENT_ARGS lacks stream-json output; "
            "the transcript cannot be read from it")
    prepare_home()
    log("polling %s (agent %s, checkout %s)" % (BASE, CLAUDE_BIN, CHECKOUT))
    register()
    # `--once` is a probe: it runs whatever it is handed inline and returns.
    # The service keeps a single worker for turns so the poll never blocks.
    session_queue = queue.Queue()
    if not ONCE:
        threading.Thread(target=run_sessions_forever, args=(session_queue,),
                         name="claudesk-session-worker", daemon=True).start()
    while True:
        started = time.time()
        try:
            polled = poll()
        except Exception as error:  # noqa: BLE001 - the bridge may not be up yet
            log("poll failed: %s" % error)
            if ONCE:
                return 1
            time.sleep(POLL_SECONDS)
            continue
        # The web Code composer's folder/git lookups ride the same poll. They
        # are answered from inside the VM, before any session is started.
        requests = polled.get("requests") or []
        for item in requests:
            handle_runner_request(item)
        hints = polled.get("hints") or []
        if not hints:
            if ONCE:
                log("no work (pending=%s)" % polled.get("pending_count", 0))
                return 0
            # A held poll already answered as soon as there was work — or
            # paced the wait when there was none — so it needs no extra sleep.
            # Only an immediate answer (an older bridge without the hold) does.
            # A poll that carried UI requests *is* such an immediate answer,
            # but it did work: sleeping here made every request after the first
            # wait out POLL_SECONDS for the next poll. Go straight back to a
            # held poll instead.
            if not requests and time.time() - started < 1.0:
                time.sleep(POLL_SECONDS)
            continue
        for hint in hints:
            if not ONCE:
                session_queue.put(hint)
                continue
            try:
                run_session(hint)
            except Exception as error:  # noqa: BLE001 - keep serving the pool
                log("session %s failed: %s" % (hint.get("session_uuid"), error))
        if ONCE:
            return 0


if __name__ == "__main__":
    sys.exit(main())
