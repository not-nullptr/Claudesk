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
result and partial update is written back as an event as it happens; stderr is
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

VERSION = "2.0.0"


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


def request(path, body=None, token=None, method=None):
    """One call to the bridge. Returns (status, parsed-body-or-text)."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 method=method or ("POST" if body is not None else "GET"))
    req.add_header("content-type", "application/json")
    req.add_header("authorization", "Bearer %s" % (token or SECRET))
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
    body = expect(request("/v1/code/runners/self-hosted/runners/register", {
        "runner_version": VERSION,
        "use_anthropic_git_proxy": False,
        "client_label": "claudesk-guest-runner",
    }), "register")
    log("registered as %s" % body["runner_id"])
    return body["runner_id"]


def poll():
    return expect(request("/v1/code/runners/self-hosted/spawn-hints/poll", {}), "poll")


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


def run_agent(argv, cwd, prompt, write):
    """One headless turn of the agent: the prompt in, the event stream out.

    The prompt is a stream-json user message on stdin — the channel the SDK
    uses — and stdin ends there, which is what tells the agent the turn's input
    is complete. Every assistant message, tool result and partial update is
    queued to a writer thread so a slow bridge never stalls the agent's own
    output pipe. Returns (exit code, result event or None, timed out, forwarded
    count, write failures, stderr lines).
    """
    environment = dict(os.environ)
    if os.path.isdir(RUNNER_HOME):
        environment["HOME"] = RUNNER_HOME
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
        message = {"type": "user",
                   "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
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
    prompt = prompt_of(events)
    resume = resume_id(events)

    # The session's own settings — the composer's model choice among them —
    # ride the session document; the agent must be asked with them or it
    # answers as whatever its default is.
    model, permission_mode = session_settings(session)

    if not (os.path.isfile(CLAUDE_BIN) and os.access(CLAUDE_BIN, os.X_OK)):
        # A directory here is the classic miss (the product's own path is one);
        # resolution above should have taken it, so what lands here is genuinely
        # absent or not executable — say which.
        reason = "%s is not an executable file in the guest" % CLAUDE_BIN
        finish("report-failure", {"reason": reason, "setup_failure_kind": "missing_binary"})
        log("session %s: %s" % (session, reason))
        return session, 127

    if not prompt.strip():
        reason = "the session's transcript carries no user message to answer"
        finish("report-failure", {"reason": reason, "failure_kind": "bad_input"})
        log("session %s: %s" % (session, reason))
        return session, 2

    argv = [CLAUDE_BIN] + AGENT_ARGS
    if model is not None:
        argv += ["--model", model]
    if permission_mode is not None:
        argv += ["--permission-mode", permission_mode]
    # The checkout is where the session's work happens; a guest without it (a
    # fresh image, a stopped VM) still runs, from /, rather than failing the
    # session on a directory.
    cwd = CHECKOUT if os.path.isdir(CHECKOUT) else "/"
    started = time.time()
    log("session %s: turn with %s (model %s, resume %s)" % (
        session, " ".join(AGENT_ARGS), model or "default", resume or "none"))

    def turn(extra):
        return run_agent(argv + extra, cwd, prompt, write)

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
    """The model and permission mode the session was placed with.

    They live on the session document's `config` (the create body's own
    shape); absent, the agent's defaults stand.
    """
    status, document = request("/v1/code/sessions/%s" % quoted_id(session_id))
    if status != 200 or not isinstance(document, dict):
        return None, None
    config = (document.get("session") or {}).get("config") or {}
    model = config.get("model")
    permission_mode = config.get("permission_mode")
    return (
        model if isinstance(model, str) and model else None,
        permission_mode if isinstance(permission_mode, str) and permission_mode else None,
    )


def quoted_id(session_id):
    return urllib.parse.quote(str(session_id), safe="")


def prepare_home():
    try:
        os.makedirs(RUNNER_HOME, mode=0o700, exist_ok=True)
    except OSError as error:
        log("could not create %s (%s); the agent keeps the service's HOME" % (RUNNER_HOME, error))


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
    while True:
        try:
            polled = poll()
        except Exception as error:  # noqa: BLE001 - the bridge may not be up yet
            log("poll failed: %s" % error)
            if ONCE:
                return 1
            time.sleep(POLL_SECONDS)
            continue
        hints = polled.get("hints") or []
        if not hints:
            if ONCE:
                log("no work (pending=%s)" % polled.get("pending_count", 0))
                return 0
            time.sleep(POLL_SECONDS)
            continue
        for hint in hints:
            try:
                run_session(hint)
            except Exception as error:  # noqa: BLE001 - keep serving the pool
                log("session %s failed: %s" % (hint.get("session_uuid"), error))
        if ONCE:
            return 0


if __name__ == "__main__":
    sys.exit(main())
