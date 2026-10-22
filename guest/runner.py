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
import http.client
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# 2.7.0: The Code surface's context meter asks the agent's own control protocol
# (`get_context_usage`). Stream-json assistant messages carry zero usage on a
# gateway that reports it only in `message_delta`, so the renderer's own
# fallback reads 0; the runner asks at turn end, while the live child still
# holds the conversation, and serves that answer over the UI request lane.
# Never estimated here: the runner only relays what the agent published.
#
# 2.6.0: A message sent while a turn runs is steered into the live child. Its
# stdin stays open and the runner watches the transcript: each new client
# message is written to the agent, and a real prompt is followed by the CLI's
# native `interrupt` request with `send_now`, which stops the running turn and
# runs the message now. Each result is written as it arrives, so the stopped
# turn and the steered one close separately. The delivery floor also answers
# anything the watch missed at the next turn.
#
# 2.5.0: The turn answers every client message above the bridge's delivery
# floor — including one typed while the previous turn ran, which used to sit
# before that turn's `result` and be dropped — and each is sent to the agent
# with its own bridge uuid. A rewind the bridge answered for the surface is
# applied to the agent's transcript at the next turn (the agent's own
# `rewind_conversation` control request), so the model forgets what the user
# took back rather than just the page.
#
# 2.4.0: Every turn ends with a result. A failure, a timeout or a broken event
# stream writes the terminal the transcript reader closes a turn on (reopening
# the stream, or posting the result on its own when it cannot), the poll reports
# the sessions this runner holds so the bridge can reap a turn whose runner
# vanished, and the agent's process group — not just its pid — is signalled.
VERSION = "2.7.0"


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
# The account's workspace, as the container and the folder picker spell it.
# Inside the guest the host root is at SHARED_ROOT, so the workspace would only
# be reachable at `<SHARED_ROOT>/workspace`; the runner bind-mounts it back at
# this same path, so a shell (and the agent's own cwd) sees `/workspace` and
# the files are the shared ones, not an empty directory in the guest image.
HOST_WORKSPACE = "/workspace"
WORKSPACE_ALIAS = env("CLAUDESK_RUNNER_WORKSPACE_ALIAS", HOST_WORKSPACE)
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
# Optional wall clock for one turn. Zero — the default — means no cap: an
# agent doing real work may run far longer than half an hour, and killing it
# at an arbitrary mark threw away the turn. A deployment that wants a hard
# stop sets CLAUDESK_RUNNER_TIMEOUT_SECONDS to a positive number of seconds;
# an empty value or zero disables it.
def env_seconds(name):
    raw = env(name)
    if not raw:
        return 0.0
    try:
        value = float(raw)
    except ValueError:
        return 0.0
    return value if value > 0 else 0.0


TURN_TIMEOUT = env_seconds("CLAUDESK_RUNNER_TIMEOUT_SECONDS")
# How long the agent gets to answer a `rewind_conversation` request at the
# start of a turn. It answers from its own transcript in-process; a build that
# cannot answer must not hold the user's next message behind it.
REWIND_TIMEOUT = float(env("CLAUDESK_RUNNER_REWIND_TIMEOUT_SECONDS", "10") or 0)
# A turn holds the child open after its prompt so a message sent while the
# agent works reaches it natively: the message goes on stdin and the CLI's
# `interrupt` request with `send_now` stops the running turn for it (the same
# protocol the Cloud Code surface uses). These pace that watch, and bound how
# long an idle child is kept after its last result before the turn releases.
STEER_POLL_SECONDS = float(env("CLAUDESK_RUNNER_STEER_POLL_SECONDS", "0.4") or 0)
# After a steered turn's last result the child still has to drain the queries
# its stdin already carried; its own EOF exit is prompt, and this only bounds a
# build that keeps waiting after input ended.
STEER_EXIT_GRACE_SECONDS = env_seconds("CLAUDESK_RUNNER_STEER_EXIT_GRACE_SECONDS") or 30.0
# A placed session and its first message are two requests from the composer.
# A claim that lands between them reads an empty transcript; wait this long for
# the send to arrive before releasing the session back to the bridge.
PROMPT_GRACE_SECONDS = float(env("CLAUDESK_RUNNER_PROMPT_GRACE_SECONDS", "3") or 0)
# How many turns may run at once. The protocol hands out every hint it has, and
# one VM sized for one agent cannot hold an unbounded number of them; excess
# hints wait on this semaphore instead of stampeding the guest.
MAX_TURNS = int(env("CLAUDESK_RUNNER_MAX_TURNS", "4") or 4)
# Durable events read from the tail before a turn starts. The whole transcript
# is not needed: the last user message, the conversation to resume and the
# latest control requests all sit near the end.
HISTORY_TAIL = int(env("CLAUDESK_RUNNER_HISTORY_TAIL", "500") or 500)
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


def open_event_stream(path, token):
    """Open the turn's event stream: one chunked upload, many events.

    The agent emits an event per token. Posting each on its own request made
    the transcript's throughput a function of the round trip and of the
    bridge's store write, which is the wrong shape for a stream of kilobytes.
    This holds one HTTP request open for the turn instead: each event is an
    NDJSON line written to the socket as it arrives, and the bridge appends it
    to the session's own log. A keepalive line every 20 s keeps a long
    thinking pause from tripping the server's request timeout.

    Returns (write, close). `write` takes one event payload; `close` finishes
    the upload and raises if the bridge refused it.
    """
    parsed = urllib.parse.urlsplit(BASE)
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=30)
    else:
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=30)
    connection.putrequest("POST", path, skip_accept_encoding=True)
    connection.putheader("content-type", "application/x-ndjson")
    connection.putheader("authorization", "Bearer %s"
                         % (token or RUNNER_TOKEN or SECRET))
    connection.putheader("transfer-encoding", "chunked")
    connection.endheaders()
    lock = threading.Lock()
    closed = [False]
    stop = threading.Event()

    def send_line(line):
        data = line.encode("utf-8")
        connection.send(("%x\r\n" % len(data)).encode("ascii") + data + b"\r\n")

    def write(payload):
        line = json.dumps({"payload": payload}) + "\n"
        with lock:
            if closed[0]:
                raise RuntimeError("the event stream is closed")
            send_line(line)

    def keepalive_loop():
        while not stop.wait(20.0):
            with lock:
                if closed[0]:
                    return
                try:
                    send_line('{"keepalive":true}\n')
                except Exception:  # noqa: BLE001 - a dead stream shows at close
                    return

    keepalive = threading.Thread(target=keepalive_loop, daemon=True)
    keepalive.start()

    def close():
        stop.set()
        with lock:
            if closed[0]:
                return
            closed[0] = True
            try:
                connection.send(b"0\r\n\r\n")
                response = connection.getresponse()
                status = response.status
                body = response.read().decode("utf-8", "replace")
            finally:
                connection.close()
        if status != 200:
            raise RuntimeError("events stream answered %s: %s" % (status, body[:200]))

    return write, close


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
    # The bridge reconciles sessions it believes are running against the turns
    # a live runner actually holds. Sending the claim set is what lets it tell
    # "this turn is slow" from "the runner that had it disappeared".
    return expect(request("/v1/code/runners/self-hosted/spawn-hints/poll",
                          claims_snapshot(), headers=headers), "poll")


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


def message_blocks(payload):
    """The stream-json content blocks of a user payload, or [] when it has
    nothing the agent can be asked (a tool result, an empty send).

    The opening message may carry image blocks beside the text (a fire with
    images). The agent's stream-json input takes the same block list, so each
    message is forwarded as it arrived rather than flattened to text.
    """
    content = (payload.get("message") or {}).get("content")
    blocks = []
    if isinstance(content, str):
        if content.strip():
            blocks.append({"type": "text", "text": content})
    elif isinstance(content, list):
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
    return blocks


def is_steerable(payload, blocks):
    """Is a delivered mid-turn message one the running turn should stop for?

    A system reminder (`shouldQuery: false`) or an image-only attachment
    carrier belongs to the turn but is not something the person just pressed
    send on; only a real prompt escalates the CLI's send-now interrupt.
    """
    if payload.get("shouldQuery") is False:
        return False
    return bool(blocks)


def content_of(events, after_sequence_num=None):
    """The client user messages this turn answers, each with its uuid.

    Every message belongs to its own turn. The agent's uuid on the message is
    the bridge event's uuid, so the Code surface's rewind (which names a target
    message by uuid) can be handed to the agent unchanged.

    `after_sequence_num` is the bridge's delivery floor: the highest transcript
    sequence the agent was actually given. A message above it was typed while
    a turn ran but arrived after that turn's read, so the agent never saw it —
    it is answered by this turn even though it appears *before* the previous
    turn's `result` in the log. Callers pass the events from that floor (see
    fetch_events_after); without a floor, the tail is read the old way, after
    the last `result`, for a bridge that predates the floor.

    The opening message may carry image blocks beside the text (a fire with
    images). The agent's stream-json input takes the same block list, so each
    message is forwarded as it arrived rather than flattened to text.
    """
    if after_sequence_num is None:
        start = 0
        for index, event in enumerate(events or []):
            payload = (event or {}).get("payload") or {}
            if payload.get("type") == "result":
                start = index + 1
        events = (events or [])[start:]
    else:
        in_range = []
        for event in events or []:
            try:
                sequence = int((event or {}).get("sequence_num") or 0)
            except (TypeError, ValueError):
                continue
            if sequence > after_sequence_num:
                in_range.append(event)
        events = in_range
    messages = []
    for event in events or []:
        if not isinstance(event, dict) or event.get("source") == "worker":
            continue
        payload = event.get("payload") or {}
        if payload.get("type") != "user":
            continue
        blocks = message_blocks(payload)
        if not blocks:
            continue
        message_uuid = payload.get("uuid")
        if not isinstance(message_uuid, str) or not message_uuid:
            message_uuid = event.get("event_id")
        messages.append({
            "uuid": message_uuid if isinstance(message_uuid, str) else "",
            "content": blocks,
        })
    return messages


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


def synthetic_result(reason, resume="", started=None, interrupted=False):
    """The `result` terminal for a turn the agent did not finish itself.

    The session view closes a turn on a `result` message. Every failure path
    used to report the failure only to the bridge, which left the page spinning
    forever (and, on reload, an idle session whose transcript had no reason in
    it). This is the same envelope the SDK emits for an interrupted turn.
    """
    duration = int((time.time() - started) * 1000) if started else 0
    return {
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": True,
        "interrupted": interrupted,
        "result": reason,
        "session_id": resume or "",
        "duration_ms": duration,
        "num_turns": 0,
        "total_cost_usd": 0,
    }


def post_event(session, payload, token=None):
    """Write one event on its own request.

    The turn's events ride one long-lived stream, so when that stream is dead
    the terminal has no way home. This is the fallback: the same append leg the
    renderer uses, authenticated with the runner's own credential (the bridge
    does not require the session token there).
    """
    return request(
        "/v1/code/sessions/%s/events" % urllib.parse.quote(session),
        {"payload": payload},
        token=token or RUNNER_TOKEN or SECRET,
    )


def fetch_history(session, token):
    """The durable events a turn needs, from the tail of the transcript.

    The whole log is not needed: the message(s) this turn answers, the
    conversation to resume and the latest control requests all sit near the
    end. A short session answers in one page; a tail that carries no user
    message falls back to the full read so an unusual session still runs.
    """
    quoted = urllib.parse.quote(session)
    status, document = request(
        "/v1/code/sessions/%s/events?sort_order=desc&limit=%d" % (quoted, HISTORY_TAIL),
        token=token)
    events = (document or {}).get("data") if isinstance(document, dict) else []
    events = list(reversed(events or []))
    if any((((event or {}).get("payload") or {}).get("type") == "user")
           and (event or {}).get("source") != "worker" for event in events):
        return events
    status, document = request("/v1/code/sessions/%s/events" % quoted, token=token)
    return ((document or {}).get("data") or []) if isinstance(document, dict) else []


def fetch_events_after(session, token, after_sequence_num):
    """Every durable event above the bridge's delivery floor, oldest first.

    The turn's own transcript tail can be shorter than the gap between the
    floor and now (a long turn, or a session that has been running for hours),
    and a user message stranded at the floor must not be missed because of it.
    Pages are walked with the events route's own cursor.
    """
    quoted = urllib.parse.quote(session)
    events = []
    cursor = None
    for _ in range(50):
        query = "after_sequence_num=%d&limit=1000" % after_sequence_num
        if cursor is not None:
            query += "&cursor=%s" % urllib.parse.quote(str(cursor))
        status, document = request(
            "/v1/code/sessions/%s/events?%s" % (quoted, query), token=token)
        if status != 200 or not isinstance(document, dict):
            break
        page = document.get("data") or []
        events.extend(page)
        cursor = document.get("next_cursor")
        if not cursor:
            break
    return events


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


def interrupt_requested(events):
    """Did a Stop arrive after the user message this turn would answer?

    A Stop is an `interrupt` control request in the session's own event log.
    One that follows the last client user message (and no newer message has
    come since) means the turn was cancelled before the runner got to it — the
    bridge may have released the session between the poll handing out the hint
    and this claim, and the agent must not start.
    """
    def is_client_turn(event):
        if not isinstance(event, dict) or event.get("source") == "worker":
            return False
        payload = event.get("payload") or {}
        if payload.get("type") != "user":
            return False
        content = (payload.get("message") or {}).get("content")
        if isinstance(content, str):
            return bool(content.strip())
        if isinstance(content, list):
            return any(
                isinstance(part, dict) and part.get("type") == "text"
                and isinstance(part.get("text"), str) and part["text"].strip()
                for part in content)
        return False

    last_user = -1
    for index, event in enumerate(events or []):
        if is_client_turn(event):
            last_user = index
    for event in (events or [])[last_user + 1:]:
        payload = (event or {}).get("payload") or {}
        request = payload.get("request")
        if payload.get("type") != "control_request" or not isinstance(request, dict):
            continue
        if request.get("subtype") == "interrupt":
            return True
    return False


def run_git(directory, *arguments):
    """Run git in `directory`; returns (ok, output). Never raises.

    Every invocation disables `core.fsmonitor`: the workspace is writable by the
    agent, and a repo config that names a program must not get one executed
    even here, in the guest (the host never runs git over workspace content at
    all).

    It also runs with the runner's HOME, where `prepare_home` declares the
    shared tree safe. The workspace belongs to the host user while this service
    is root; without that file git refuses every repository with "detected
    dubious ownership", which made the composer's folder read as not-a-repo —
    no branch picker, no worktree toggle — even though `list_folders` saw the
    directory. The service's own HOME is read-only under ProtectHome, so the
    runner must point git at its own directory rather than rely on the unit's
    environment.
    """
    environment = dict(os.environ)
    if os.path.isdir(RUNNER_HOME):
        environment["HOME"] = RUNNER_HOME
        environment.setdefault("GIT_CONFIG_GLOBAL",
                               os.path.join(RUNNER_HOME, ".gitconfig"))
    environment["GIT_TERMINAL_PROMPT"] = "0"
    try:
        completed = subprocess.run(
            ["git", "-C", directory, "-c", "core.fsmonitor=false"] + list(arguments),
            env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=120, check=False)
    except FileNotFoundError:
        return False, "git is not installed in the guest"
    except (OSError, subprocess.SubprocessError) as error:
        return False, "git could not run: %s" % error
    return completed.returncode == 0, (completed.stdout or "").strip()


def shared_workspace():
    return os.path.join(SHARED_ROOT, "workspace")


def same_directory(left, right):
    try:
        a = os.stat(left)
        b = os.stat(right)
    except OSError:
        return False
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


# Concurrent turns re-check the late-arriving virtiofs mount; the mount/symlink
# itself must happen once.
WORKSPACE_ALIAS_LOCK = threading.Lock()
# Git setup mutates a shared repository (branch checkout, worktree metadata).
# Turns on the same repo serialize only that setup; the agent turns themselves
# run concurrently. Keys are real paths; the map grows with the folders used,
# which is bounded by the account's workspace.
REPO_SETUP_LOCKS = {}
REPO_SETUP_LOCKS_GUARD = threading.Lock()


def repo_setup_lock(repo):
    """The lock serializing git setup on one repository, created on demand."""
    key = os.path.realpath(repo)
    with REPO_SETUP_LOCKS_GUARD:
        lock = REPO_SETUP_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            REPO_SETUP_LOCKS[key] = lock
        return lock


def ensure_workspace_alias():
    with WORKSPACE_ALIAS_LOCK:
        return _ensure_workspace_alias()


def _ensure_workspace_alias():
    """Make the account's shared workspace visible at `/workspace` in the guest.

    The guest mounts the host's whole filesystem at SHARED_ROOT; `/workspace`
    itself is an empty directory on the guest's own disk. The container, the
    folder picker and the people using them all spell the workspace
    `/workspace`, so a shell command that cd's there landed in that empty
    directory. A bind mount over it (only when it is empty, so nothing local is
    hidden) makes the two the same path. Runs as the runner's root; harmless
    when it cannot mount.
    """
    shared = shared_workspace()
    if not os.path.isdir(shared):
        return False
    if same_directory(WORKSPACE_ALIAS, shared):
        return True
    try:
        os.makedirs(WORKSPACE_ALIAS, exist_ok=True)
    except OSError:
        return False
    try:
        if os.listdir(WORKSPACE_ALIAS):
            return False
    except OSError:
        return False
    try:
        completed = subprocess.run(["mount", "--bind", shared, WORKSPACE_ALIAS],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        completed = None
    if completed is not None and completed.returncode == 0:
        log("workspace alias: %s is the shared workspace (bind mount)" % WORKSPACE_ALIAS)
        return True
    # A guest that cannot mount (no CAP_SYS_ADMIN, a restricted unit) still
    # gets the same path with a symlink over the empty directory. It survives a
    # reboot, and dangles harmlessly until the virtiofs mount is ready.
    try:
        os.rmdir(WORKSPACE_ALIAS)
        os.symlink(shared, WORKSPACE_ALIAS)
    except OSError:
        return False
    log("workspace alias: %s is the shared workspace (symlink)" % WORKSPACE_ALIAS)
    return True


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
    # Once the shared workspace is bound at /workspace, keep that spelling for
    # a folder under it: the agent's cwd and shell commands then read the same
    # path the container and the folder picker use.
    if (host_path == HOST_WORKSPACE or host_path.startswith(HOST_WORKSPACE + "/")) \
            and same_directory(WORKSPACE_ALIAS, shared_workspace()):
        candidate = WORKSPACE_ALIAS + host_path[len(HOST_WORKSPACE):]
        if os.path.isdir(candidate):
            return candidate
    candidate = os.path.join(SHARED_ROOT, host_path.lstrip("/"))
    return candidate if os.path.isdir(candidate) else None


def session_workdir(session, config):
    """The directory the agent runs in, from the session's start options.

    The composer may place a session with a folder (`cwd`), a branch
    (`source_branch`) and an isolated worktree (`use_worktree`). Returns
    `(cwd, error)`: an option the guest cannot honour is an error the caller
    reports as the session's failure, never a silent fallback — the person
    picked that folder and branch. With no folder the session starts in the
    account's shared workspace (at /workspace once the alias is mounted); an
    older guest without the share keeps its own checkout.
    """
    folder = config.get("cwd")
    branch = config.get("source_branch")
    branch = branch.strip() if isinstance(branch, str) else ""
    worktree = config.get("use_worktree") is True

    if not isinstance(folder, str) or not folder:
        shared = shared_workspace()
        if os.path.isdir(shared):
            if same_directory(WORKSPACE_ALIAS, shared):
                return WORKSPACE_ALIAS, None
            return shared, None
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

    if repo is None:
        return directory, None

    # Only the git setup is serialized per repository: a branch checkout
    # mutates the shared checkout and `worktree add` writes `.git/worktrees`;
    # concurrent turns would otherwise race there. Once the working directory
    # is chosen, the agent turns run in parallel — especially two worktree
    # sessions, which is the point of the worktree option.
    with repo_setup_lock(repo):
        if not worktree:
            if branch:
                ok, output = run_git(repo, "checkout", branch)
                if not ok:
                    return None, ("could not check out branch %s: %s"
                                  % (branch, output[-400:] or "git failed"))
                log("session checkout %s on branch %s" % (repo, branch))
            return directory, None

        # Worktree sessions are deterministic per session, so a later turn
        # resumes in the same copy. The branch starts from the selected branch
        # (or HEAD) and is named after the session; a collision gets a suffix.
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
    ok, output = run_git(guest, "rev-parse", "--is-inside-work-tree")
    if not ok:
        # A folder that is not a repository is normal; say why in the journal
        # so a *repository* that git refuses (ownership, a missing mount, a
        # broken .git) is diagnosable instead of silently reading as no-repo.
        log("git_info %s: %s" % (guest, output[:300]))
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


# The Code surface's context meter asks a session for `get_context_usage`; its
# own fallback (the usage on assistant messages) reads 0 here because the
# gateway reports usage in `message_delta` while stream-json assistant messages
# keep `message_start`'s zeros. Only the agent process that ran the
# conversation can compute the breakdown (a resumed process answers from an
# empty live transcript), so the runner asks the agent once, at the end of each
# turn, while that process still exists, and keeps the answer. The conversation
# does not change between turns, so the answer stays true until the next turn;
# a model/permission/effort change makes it stale, and the next turn refreshes
# it. Nothing is estimated here: the document is the agent's own.
CONTEXT_USAGE = {}
CONTEXT_USAGE_LOCK = threading.Lock()
# How long a turn waits for the agent's context answer before ending. The agent
# answers from memory in well under a second; this is a failed-agent ceiling,
# not a computation budget.
CONTEXT_USAGE_WAIT = env_seconds("CLAUDESK_RUNNER_CONTEXT_USAGE_WAIT") or 4.0


def remember_context_usage(session, config, usage):
    if not isinstance(usage, dict) or "rawMaxTokens" not in usage:
        return
    with CONTEXT_USAGE_LOCK:
        CONTEXT_USAGE[session] = {
            "usage": usage,
            "config": {key: config.get(key)
                       for key in ("model", "permission_mode", "effort_level")},
            "at": time.time(),
        }
        # A long-lived guest serves many sessions; the documents are tens of
        # kilobytes each, so keep only the most recently turned ones.
        while len(CONTEXT_USAGE) > 64:
            oldest = min(CONTEXT_USAGE, key=lambda key: CONTEXT_USAGE[key]["at"])
            CONTEXT_USAGE.pop(oldest, None)


def get_context_usage(params):
    """Answer the Code surface's `get_context_usage` from the last turn's agent.

    The request arrives on the runner's poll (the UI request lane) and the
    bridge appends the answer as the `control_response` the renderer is waiting
    on. A session the runner has not turned since it started has no answer:
    saying so is better than inventing one, and the renderer keeps its last
    cached snapshot until the next turn refreshes it.
    """
    session = params.get("session_uuid")
    if not isinstance(session, str) or not session:
        raise ValueError("get_context_usage: session_uuid is required")
    with CONTEXT_USAGE_LOCK:
        entry = CONTEXT_USAGE.get(session)
    if entry is None:
        raise RuntimeError("context usage is not available until this session "
                           "runs a turn on this runner")
    # The answer is the state of the turn that produced it. A model or mode
    # change between turns changes the system prompt and the window, so a
    # mismatched request waits for the next turn rather than showing stale
    # categories.
    for key in ("model", "permission_mode", "effort_level"):
        wanted = params.get(key)
        if wanted is None:
            continue
        if entry["config"].get(key) != wanted:
            raise RuntimeError("the session's settings changed since its last "
                               "turn; context usage refreshes with the next turn")
    return entry["usage"]


REQUEST_HANDLERS = {
    "branch_switch_conflict": branch_switch_conflict,
    "create_folder": create_folder,
    "get_context_usage": get_context_usage,
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


# Sessions whose turn is running right now, each with the Event that tells it
# to stop. Nothing can dial into the guest (QEMU forwards no port in), so the
# runner's held poll is the only inbound channel: the bridge answers a Stop
# with a `cancellations` list, and the main loop applies it here.
RUNNING_TURNS = {}
# Sessions this runner has taken from its poll, including hints whose thread
# has not started yet and turns waiting on the concurrency semaphore. The
# bridge reaps an active/offered session it cannot find in any live runner's
# claim set, so the window between "the poll handed it here" and "the turn
# thread started" must be covered too.
CLAIMED_SESSIONS = set()
RUNNING_TURNS_LOCK = threading.Lock()


def claim_session(session_id):
    if isinstance(session_id, str) and session_id:
        with RUNNING_TURNS_LOCK:
            CLAIMED_SESSIONS.add(session_id)


def claims_snapshot():
    with RUNNING_TURNS_LOCK:
        return {"running": sorted(RUNNING_TURNS), "claimed": sorted(CLAIMED_SESSIONS)}


def register_turn(session_id):
    turn = threading.Event()
    if isinstance(session_id, str) and session_id:
        with RUNNING_TURNS_LOCK:
            RUNNING_TURNS[session_id] = turn
            CLAIMED_SESSIONS.add(session_id)
    return turn


def unregister_turn(session_id):
    if not isinstance(session_id, str) or not session_id:
        return
    with RUNNING_TURNS_LOCK:
        RUNNING_TURNS.pop(session_id, None)
        CLAIMED_SESSIONS.discard(session_id)


def apply_cancellations(items):
    """Signal every running turn the bridge asked to stop."""
    applied = 0
    for item in items or []:
        session_id = item.get("session_uuid") if isinstance(item, dict) else item
        if not isinstance(session_id, str) or not session_id:
            continue
        reason = item.get("reason") if isinstance(item, dict) else None
        with RUNNING_TURNS_LOCK:
            turn = RUNNING_TURNS.get(session_id)
        if turn is not None:
            turn.set()
            applied += 1
            log("cancelling session %s" % session_id)
            continue
        if reason != "interrupt":
            continue
        # No turn on this runner holds it: the stop is for a turn that ended
        # while this service was restarting, so the session would otherwise
        # read "running" forever with nothing behind it. Put it back idle; a
        # deleted session answers 404 and needs no more than that.
        status, _ = request(
            "/v1/code/runners/self-hosted/sessions/%s/release"
            % urllib.parse.quote(session_id), {}, token=RUNNER_TOKEN)
        if status == 200:
            log("session %s: released after a stop with no running turn" % session_id)
    return applied


def run_agent(argv, cwd, messages, write, interrupt=None, rewind=None, steer=None,
              usage_hook=None):
    """One headless turn of the agent: the prompts in, the event stream out.

    `messages` is the ordered list of client user messages this turn answers
    (`{uuid, content}`, see content_of). Each becomes its own stream-json user
    message on stdin, the channel the SDK uses, carrying the bridge event's
    uuid so the conversation's own transcript names the messages the Code
    surface names. The agent answers each as its own query; the stream is
    closed after the last, which is what tells it the input is complete.
    Every assistant message, tool result and partial update is queued to a
    writer thread so a slow bridge never stalls the agent's own output pipe.

    `rewind`, when present, is applied to the agent's conversation before any
    prompt: the agent's own `rewind_conversation` control request truncates
    the transcript at the target message and answers with the `prefillText`
    shape the surface uses. That is what makes a rewound conversation stay
    rewound on the next turn instead of the `--resume` replaying messages the
    user took back.

    `interrupt` is an event set by the poll loop when the bridge carries a
    Stop. The child is signalled the way the terminal would (SIGINT) so it can
    flush and unwind; a child that ignores that is terminated, then killed.

    `steer` keeps stdin open for the life of the turn and polls the bridge for
    client messages that landed after its floor. Each is written to the child
    as a stream-json user message; a real prompt is followed by the CLI's
    native `interrupt` control request with `send_now`, which stops the turn
    under way and runs the message immediately — stock steering, not a queue
    for the next turn (see watch_steering).

    `usage_hook` asks the agent for `get_context_usage` once every message has
    its result, while the live child still holds the conversation (see
    remember_context_usage), and before the input is closed.

    Returns (exit code, result event or None, timed out, interrupted,
    forwarded count, write failures, stderr lines, rewind answered,
    results written live).
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
    # Its own session, so a Stop can signal the whole process group. A tool the
    # agent spawned (a shell, a server) is a grandchild: stopping only the
    # agent would leave it running, and — because it inherits the stdout pipe —
    # would also keep the turn's reader from seeing EOF.
    process = subprocess.Popen(argv, cwd=cwd, env=environment,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, bufsize=1,
                               encoding="utf-8", errors="replace",
                               start_new_session=True)
    errors = []

    def drain_errors():
        for line in process.stderr:
            line = line.rstrip()
            if line:
                errors.append(line)
                # A chatty agent must not grow the guest's heap without bound;
                # only the tail is ever read back as the failure reason.
                if len(errors) > 200:
                    del errors[:100]

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
    watchdog = None
    if TURN_TIMEOUT > 0:
        # The whole group, not just the pid: a tool the agent spawned is a
        # grandchild, and a build that ignores the timeout while a grandchild
        # holds the stdout pipe would leave the reader blocked forever.
        # `signal_group` is defined below; the timer resolves it when it fires.
        watchdog = threading.Timer(
            TURN_TIMEOUT, lambda: (timed_out.append(True), signal_group(signal.SIGKILL)))
        watchdog.start()

    interrupted = []

    def wait_exit(seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if process.poll() is not None:
                return True
            time.sleep(0.1)
        return process.poll() is not None

    def signal_group(number):
        # The child leads its own session (see Popen above), so its pid is the
        # group id and tools it spawned are in the group.
        try:
            os.killpg(process.pid, number)
        except (OSError, AttributeError):
            try:
                process.send_signal(number)
            except (OSError, ValueError):
                pass

    def abort():
        # SIGINT first — the agent treats it the way Ctrl-C stops a turn, so it
        # can flush its stream. A group that ignores it is terminated, then
        # killed: a Stop must never leave a process behind.
        if interrupted:
            return
        interrupted.append(True)
        signal_group(signal.SIGINT)
        if wait_exit(3.0):
            return
        signal_group(signal.SIGTERM)
        if wait_exit(2.0):
            return
        signal_group(signal.SIGKILL)

    interrupt_done = threading.Event()

    def watch_interrupt():
        while not interrupt_done.wait(0.2):
            if interrupt is not None and interrupt.is_set():
                abort()
                return

    if interrupt is not None:
        threading.Thread(target=watch_interrupt, daemon=True).start()

    forwarded = 0
    result_count = 0
    result = None
    results_emitted = 0
    # One result per user message the agent is given, including a steered one
    # (the CLI answers each message as its own query). The watcher increments
    # it; the list keeps the count shared without another lock.
    expected_results = [max(1, len(messages or []))]
    stdin_closed = []
    stdin_lock = threading.Lock()
    steer_stop = threading.Event()
    steer_state = {
        # The transcript sequence this turn has already handed the agent. The
        # watcher reads above it; the initial prompts are at or below it.
        "floor": 0,
        "delivered": set(),
        "steered": False,
        "last_result_at": None,
        "last_delivery_at": None,
        "session": None,
        "token": None,
    }
    if isinstance(steer, dict):
        try:
            steer_state["floor"] = max(0, int(steer.get("floor") or 0))
        except (TypeError, ValueError):
            steer_state["floor"] = 0
        steer_state["session"] = steer.get("session")
        steer_state["token"] = steer.get("token")

    def write_stdin(payload):
        """Write one stream-json line to the live agent, or False once its
        input is complete (the turn is settling or the child is gone)."""
        with stdin_lock:
            if stdin_closed:
                return False
            try:
                process.stdin.write(json.dumps(payload) + "\n")
                process.stdin.flush()
                return True
            except OSError:
                return False  # the agent died before reading; its exit says why

    def close_stdin():
        with stdin_lock:
            if stdin_closed:
                return
            stdin_closed.append(True)
            try:
                process.stdin.close()
            except OSError:
                pass
        # A build that keeps waiting for more input after its result must not
        # hold the session; give it a moment to exit on its own, then end the
        # whole group (a grandchild can hold the stdout pipe open after the
        # agent itself is gone). A steered turn may still be draining queries
        # whose messages were written before the close, so it gets a longer
        # grace than a plain turn.
        grace = STEER_EXIT_GRACE_SECONDS if steer_state["steered"] else 3.0
        threading.Thread(target=end_after_result, args=(grace,), daemon=True).start()

    def end_after_result(grace_seconds=3.0):
        deadline = time.time() + grace_seconds
        while time.time() < deadline:
            if process.poll() is not None:
                return
            time.sleep(0.5)
        signal_group(signal.SIGTERM)
        time.sleep(2)
        if process.poll() is None:
            signal_group(signal.SIGKILL)

    control_responses = {}
    control_lock = threading.Lock()

    def ask_for_context_usage():
        """Ask the agent for this turn's context breakdown before its input ends.

        The agent computes it from the conversation it just ran; the answer is
        kept for the Code meter (see remember_context_usage). One question per
        turn, and a short ceiling so a failed agent cannot hold the release.
        """
        request_id = "context-usage-%d" % int(time.time() * 1000)
        if not write_stdin({
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": "get_context_usage", "detail": "full"},
        }):
            return
        answer = None
        deadline = time.time() + CONTEXT_USAGE_WAIT
        while time.time() < deadline:
            with control_lock:
                answer = control_responses.get(request_id)
            if answer is not None:
                break
            time.sleep(0.1)
        if not isinstance(answer, dict) or answer.get("subtype") != "success":
            return
        try:
            usage_hook(answer.get("response"))
        except Exception as error:  # noqa: BLE001 - best effort
            log("could not remember context usage: %s" % error)

    def stdout_reader():
        # The agent's stream-json on stdout: transcript events to the writer
        # queue, control responses set aside for a request the runner made,
        # and the turn's own `result` terminals. Read on a thread so the
        # runner can write a steer or a rewind while the agent is working.
        nonlocal forwarded, result_count, result, results_emitted
        try:
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
                if kind == "control_response":
                    response = event.get("response")
                    request_id = response.get("request_id") if isinstance(response, dict) else None
                    if isinstance(request_id, str):
                        with control_lock:
                            control_responses[request_id] = response
                    continue
                if kind in ("assistant", "user", "stream_event"):
                    pending.put(event)
                    forwarded += 1
                elif kind == "result":
                    result_count += 1
                    result = event
                    steer_state["last_result_at"] = time.time()
                    # A steered turn has more than one result: the interrupted
                    # turn's, then the message's. Each closes its own turn in
                    # the transcript, so they go out as they arrive; a plain
                    # turn keeps its single result for run_turn to write.
                    if steer_state["steered"]:
                        pending.put(event)
                        results_emitted += 1
                elif kind == "system" and event.get("subtype") == "init":
                    log("agent %s initialized (model %s, permission %s)" % (
                        event.get("claude_code_version"), event.get("model"),
                        event.get("permissionMode")))
        finally:
            # Only after every line has been queued may the writer stop: an
            # assistant message read after the process wait would otherwise
            # land behind the sentinel and never be written.
            pending.put(None)

    def steer_message(event):
        """Deliver one client message above the floor to the live child.

        Returns (written, uuid, answerable). The message goes on stdin first;
        the caller sends the `send_now` interrupt once every message in the
        batch is queued, because one interrupt releases the whole queue — an
        interrupt per message would stop the turn again under the message
        that just started.
        """
        payload = event.get("payload") or {}
        if payload.get("type") != "user":
            return (False, "", False)
        blocks = message_blocks(payload)
        if not blocks:
            return (False, "", False)
        message_uuid = payload.get("uuid")
        if not isinstance(message_uuid, str) or not message_uuid:
            message_uuid = event.get("event_id")
        if not isinstance(message_uuid, str) or not message_uuid:
            message_uuid = str(uuid.uuid4())
        if message_uuid in steer_state["delivered"]:
            return (False, "", False)
        steer_state["delivered"].add(message_uuid)
        outbound = {"type": "user", "uuid": message_uuid,
                    "message": {"role": "user", "content": blocks},
                    "parent_tool_use_id": None, "session_id": ""}
        if not write_stdin(outbound):
            return (False, "", False)
        steer_state["last_delivery_at"] = time.time()
        expected_results[0] += 1
        return (True, message_uuid, is_steerable(payload, blocks))

    def send_steer_interrupt(message_uuid):
        """The CLI's native Send now: stop the running turn for the message
        already queued on stdin and run it immediately. The CLI advertises the
        capability as `interrupt_send_now_v1`; without it the request is a
        plain interrupt and the message runs at the next turn."""
        nonlocal results_emitted
        if not steer_state["steered"]:
            steer_state["steered"] = True
            # A turn that ended just before this message did not close on the
            # page (a plain turn's result is held for run_turn); release it so
            # the steered turn opens on its own.
            if result is not None and results_emitted == 0:
                pending.put(result)
                results_emitted += 1
        write_stdin({
            "type": "control_request",
            "request_id": "steer-%s" % message_uuid,
            "request": {"subtype": "interrupt",
                        "message_uuid": message_uuid,
                        "send_now": True},
        })
        log("session %s: steered the running turn for %s"
            % (steer_state["session"], message_uuid[:8]))

    def watch_steering():
        # The bridge is the only way the guest learns about a message typed
        # while the turn runs (nothing forwards into the VM). Poll its
        # transcript tail and hand each new client message to the child as it
        # appears; the held poll's separate loop cannot do this because the
        # child's stdin belongs to this turn.
        session_id = steer_state["session"]
        token = steer_state["token"]
        if not isinstance(session_id, str) or not session_id:
            return
        quoted_session = urllib.parse.quote(session_id)
        floor = steer_state["floor"]
        while not steer_stop.is_set() and process.poll() is None:
            events = []
            try:
                cursor = None
                for _ in range(5):
                    query = "after_sequence_num=%d&limit=200" % floor
                    if cursor is not None:
                        query += "&cursor=%s" % urllib.parse.quote(str(cursor))
                    status, document = request(
                        "/v1/code/sessions/%s/events?%s" % (quoted_session, query),
                        token=token)
                    if status != 200 or not isinstance(document, dict):
                        break
                    events.extend(document.get("data") or [])
                    cursor = document.get("next_cursor")
                    if not cursor:
                        break
            except Exception as error:  # noqa: BLE001 - steering is best-effort
                log("session %s: steer poll failed: %s" % (session_id, error))
                events = []
            delivered = False
            steer_uuid = None
            for event in events:
                if not isinstance(event, dict) or event.get("source") == "worker":
                    continue
                try:
                    sequence = int(event.get("sequence_num") or 0)
                except (TypeError, ValueError):
                    continue
                if sequence <= floor:
                    continue
                # The watch is a tail cursor: every client event moves it, so
                # a control request does not make the next poll re-read it.
                floor = max(floor, sequence)
                payload = event.get("payload") or {}
                if payload.get("type") != "user":
                    continue
                written, message_uuid, answerable = steer_message(event)
                if written:
                    delivered = True
                    if answerable and steer_uuid is None:
                        steer_uuid = message_uuid
            if steer_uuid is not None:
                # Every message in the batch is queued now; one send_now stops
                # the turn and releases them all, in order.
                send_steer_interrupt(steer_uuid)
            if delivered:
                steer_state["floor"] = floor
                # The bridge stamps the message and, with nothing left above
                # the point, drops the next-turn requeue it queued when the
                # message landed mid-turn (see recordClaim).
                try:
                    request("/v1/code/runners/self-hosted/sessions/%s/claim"
                            % quoted_session,
                            {"through_sequence_num": floor}, token)
                except Exception as error:  # noqa: BLE001 - the next turn retries
                    log("session %s: could not record steered messages: %s"
                        % (session_id, error))
            steer_stop.wait(max(0.1, STEER_POLL_SECONDS))

    reader_thread = threading.Thread(target=stdout_reader, daemon=True)
    reader_thread.start()
    watch_thread = None

    rewind_done = False
    rewind_request_id = ""
    try:
        # The bridge answered a rewind for the surface and queued it for this
        # turn. The agent applies it over the same stdin channel: it truncates
        # its conversation at the target and answers with the prefill text.
        # The prompt is not written until the agent has answered, so it runs
        # against the rewound conversation rather than the one that still
        # remembers the messages the user took back.
        if isinstance(rewind, dict) and isinstance(rewind.get("target_message_uuid"), str) \
                and rewind.get("target_message_uuid"):
            candidate = rewind.get("request_id")
            rewind_request_id = candidate if isinstance(candidate, str) and candidate \
                else str(uuid.uuid4())
            control = {
                "type": "control_request",
                "request_id": rewind_request_id,
                "request": {
                    "subtype": "rewind_conversation",
                    "target_message_uuid": rewind["target_message_uuid"],
                    "interrupt_if_running": False,
                },
            }
            last_seen = rewind.get("last_seen_user_message_uuid")
            if isinstance(last_seen, str) and last_seen:
                control["request"]["last_seen_user_message_uuid"] = last_seen
            write_stdin(control)
            answer = None
            deadline = time.time() + REWIND_TIMEOUT
            while REWIND_TIMEOUT > 0 and time.time() < deadline:
                with control_lock:
                    answer = control_responses.get(rewind_request_id)
                if answer is not None:
                    break
                time.sleep(0.1)
            body = answer.get("response") if isinstance(answer, dict) else None
            # Answered is enough to stop carrying the rewind: an agent that
            # could not find the target (its transcript was rebuilt, or the
            # message never reached it) will never accept it on a later turn.
            rewind_done = isinstance(body, dict)
            log("rewind %s at %s: %s" % (
                rewind.get("target_message_uuid"),
                rewind_request_id or "agent",
                ("applied" if body.get("rewound") is True else "declined")
                if isinstance(body, dict) else "no answer from the agent"))
        for message in messages or []:
            blocks = message.get("content")
            if isinstance(blocks, str):
                blocks = [{"type": "text", "text": blocks}]
            if not isinstance(blocks, list) or not blocks:
                continue
            payload = {"type": "user",
                       "message": {"role": "user", "content": blocks},
                       "parent_tool_use_id": None,
                       "session_id": ""}
            message_uuid = message.get("uuid")
            if isinstance(message_uuid, str) and message_uuid:
                payload["uuid"] = message_uuid
            if not write_stdin(payload):
                break  # the agent died before reading; its exit says why
        # Only now may the watcher hand over new messages: anything it sees
        # must follow the prompts this turn was started for.
        if isinstance(steer, dict):
            watch_thread = threading.Thread(target=watch_steering, daemon=True)
            watch_thread.start()
        # Input stays open while the turn runs: that is what lets a message
        # typed now reach the live child (see watch_steering). The turn ends
        # once every message it has been given has a result; the context
        # question rides the still-open input, then EOF lets the child drain
        # and exit.
        usage_asked = False
        while process.poll() is None:
            if result_count >= expected_results[0]:
                if usage_hook is not None and not usage_asked:
                    usage_asked = True
                    ask_for_context_usage()
                close_stdin()
            time.sleep(0.15)
        code = process.wait()
    finally:
        steer_stop.set()
        if watchdog is not None:
            watchdog.cancel()
        interrupt_done.set()
        close_stdin()
        # The reader closes the writer queue itself at EOF (see stdout_reader);
        # this join only bounds a child whose grandchild keeps stdout open.
        reader_thread.join(timeout=60)
        if reader_thread.is_alive():
            pending.put(None)
        writer_thread.join(timeout=60)
        if watch_thread is not None:
            watch_thread.join(timeout=5)
    return (code, result, bool(timed_out), bool(interrupted), forwarded,
            failures, errors, rewind_done, results_emitted)


def mcp_config_of(servers):
    """The `--mcp-config` document for a session's MCP servers.

    A Code routine fire may bring its own connectors for that run (the bridge's
    `connectors` extension), and the session's MCP editor saves the same field.
    The bridge writes them as a list of `{name, type, url, headers?}`; the
    agent's own `.mcp.json` record shape is accepted too. Only remote servers
    (a URL) are used — a fire must not be able to name a command to execute.
    The document is inline JSON on the agent's argv, so it is scoped to this
    session and disappears with it.
    """
    entries = []
    if isinstance(servers, dict):
        entries = list(servers.items())
    elif isinstance(servers, list):
        for index, entry in enumerate(servers):
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                name = "connector-%d" % (index + 1)
            entries.append((name, entry))
    else:
        return None
    mapping = {}
    for name, entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str) or not url:
            continue
        transport = entry.get("type") or entry.get("transport") or "http"
        transport = (transport if isinstance(transport, str) else "http")
        transport = transport.strip().lower().replace("_", "-")
        if transport in ("streamable-http", "streamable"):
            transport = "http"
        if transport not in ("http", "sse"):
            transport = "http"
        spec = {"type": transport, "url": url}
        headers = entry.get("headers")
        if isinstance(headers, dict) and headers:
            spec["headers"] = {str(key): str(value) for key, value in headers.items()}
        mapping[str(name)] = spec
    return {"mcpServers": mapping} if mapping else None


def run_session(hint, interrupt=None):
    session = hint["session_uuid"]
    quoted = urllib.parse.quote(session)
    token = expect(request("/v1/code/runners/self-hosted/sessions/%s/token" % quoted,
                           {}), "token")["session_token"]
    started = time.time()

    def finish(path, body, strict=True):
        answer = request("/v1/code/runners/self-hosted/sessions/%s/%s" % (quoted, path),
                         body, token)
        if answer[0] == 200:
            return
        # A session deleted while its turn ran is gone by the time the runner
        # reports back; that is the expected outcome of deleting it, not a
        # runner failure. Only the interrupted/released path asks for this.
        if not strict and answer[0] in (404, 410):
            log("session %s: %s answered %s after it was removed"
                % (session, path, answer[0]))
            return
        expect(answer, path)

    def fail(reason, exit_code, **body):
        """End a turn that could not run, with the terminal the reader needs.

        `report-failure` alone leaves the session's transcript without a
        `result`, so the Code view keeps its spinner up for a turn that is
        already over. Write the failure into the transcript first (on its own
        request — there is no turn stream here), then report it.
        """
        try:
            post_event(session, synthetic_result(reason, resume, started), token)
        except Exception as error:  # noqa: BLE001 - report the turn, not this
            log("session %s: could not write the failure result: %s" % (session, error))
        try:
            finish("report-failure", {"reason": reason, **body})
        except Exception as error:  # noqa: BLE001 - the bridge may be down
            log("session %s: could not report the failure: %s" % (session, error))
        log("session %s: %s" % (session, reason))
        return session, exit_code

    # The tail carries the conversation to resume, the latest settings, and a
    # Stop; the prompt itself is read from the bridge's delivery floor when it
    # has one. A message typed while the previous turn ran sits above that
    # floor but *before* the previous turn's `result`, so the old "after the
    # last result" read dropped it and the page kept showing "Sending…".
    floor = hint.get("prompt_after_sequence_num")
    floor = floor if isinstance(floor, int) and not isinstance(floor, bool) and floor >= 0 else None
    events = fetch_history(session, token)
    pending_events = fetch_events_after(session, token, floor) if floor is not None else []
    messages = content_of(pending_events, floor) if floor is not None else content_of(events)
    # The composer places the session first and posts the user's message next.
    # If this claim won the race, give the send a moment to land instead of
    # failing a turn nobody has asked for yet. The bridge withholds a session
    # with no prompt, so this is the stale-bridge path.
    if not messages and PROMPT_GRACE_SECONDS > 0:
        deadline = time.time() + PROMPT_GRACE_SECONDS
        while not messages and time.time() < deadline:
            time.sleep(0.25)
            events = fetch_history(session, token)
            if floor is not None:
                pending_events = fetch_events_after(session, token, floor)
                messages = content_of(pending_events, floor)
            else:
                messages = content_of(events)
        if messages:
            log("session %s: the prompt arrived while the claim was waiting" % session)
    resume = resume_id(events)
    # Tell the bridge how far this turn's transcript read went. Anything a
    # user appends after this point is a message for the *next* turn; anything
    # at or before it is what this turn answers. Without it, an opening message
    # that landed between the claim and this read looked like a mid-turn
    # message and started a duplicate turn.
    highest = max(
        (int(event.get("sequence_num") or 0)
         for event in list(events or []) + list(pending_events or [])),
        default=0,
    )
    try:
        request("/v1/code/runners/self-hosted/sessions/%s/claim" % quoted,
                {"through_sequence_num": highest}, token)
    except Exception as error:  # noqa: BLE001 - the turn can still run
        log("session %s: could not record the read-through point: %s" % (session, error))
    if interrupt_requested(events):
        # The Stop landed between the poll handing out this hint and the claim
        # (the bridge releases the session in that window). Nothing has run
        # yet, so there is no turn to abort — just put the session back idle.
        log("session %s: stopped before the turn started" % session)
        finish("release", {}, strict=False)
        return session, 0

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
    # The effort picker writes the SDK's `apply_flag_settings` request, whose
    # settings carry `effortLevel`. It is the only way a running session's
    # effort changes; the create config is written once. Newer builds may send
    # the same value at the top level, so accept both spellings.
    control = latest_control_request(events, "apply_flag_settings")
    if isinstance(control, dict):
        settings = control.get("settings")
        level = settings.get("effortLevel") if isinstance(settings, dict) else None
        if not isinstance(level, str):
            level = control.get("effortLevel")
        if isinstance(level, str) and level:
            effort = level

    if not (os.path.isfile(CLAUDE_BIN) and os.access(CLAUDE_BIN, os.X_OK)):
        # A directory here is the classic miss (the product's own path is one);
        # resolution above should have taken it, so what lands here is genuinely
        # absent or not executable — say which.
        reason = "%s is not an executable file in the guest" % CLAUDE_BIN
        return fail(reason, 127, setup_failure_kind="missing_binary")

    if not messages:
        # The composer places a session and posts its first message next; a
        # claim that slips between the two reads an empty transcript. That is
        # not a failed turn — there is no turn yet. The bridge withholds a
        # promptless session from the poll and wakes the pool when the message
        # lands, so this is the second line of defence for a stale bridge (or
        # one that handed the session out before the app's send). Release it:
        # the message's own append requeues the session and the next poll runs
        # it, instead of leaving a "couldn't process that message" turn in the
        # transcript.
        finish("release", {})
        log("session %s: no prompt in the transcript yet; released for the send"
            % session)
        return session, 0

    # The session's MCP servers: a routine fire's per-invocation connectors (or
    # the session MCP editor's saved set). This is what makes the URL a fire
    # carried — with whatever per-run id it held — the server the agent dials.
    mcp_config = mcp_config_of(config.get("mcp_servers"))

    argv = [CLAUDE_BIN] + AGENT_ARGS
    if model is not None:
        argv += ["--model", model]
    if permission_mode is not None:
        argv += ["--permission-mode", permission_mode]
    if effort is not None:
        argv += ["--effort", effort]
    if mcp_config is not None:
        argv += ["--mcp-config", json.dumps(mcp_config, separators=(",", ":"))]
    # The working directory comes from the session's start options. With none,
    # the account's shared workspace is where the work happens (see
    # session_workdir). The virtiofs mount can arrive after this service, so
    # re-check the /workspace alias before every turn.
    ensure_workspace_alias()
    cwd, workdir_error = session_workdir(session, config)
    if workdir_error is not None:
        return fail(workdir_error, 2, failure_kind="setup_failed")
    log("session %s: turn with %s (model %s, effort %s, permission %s, "
        "connectors %s, resume %s)" % (
            session, " ".join(AGENT_ARGS), model or "default", effort or "default",
            permission_mode or "default",
            ",".join(mcp_config["mcpServers"]) if mcp_config else "none",
            resume or "none"))
    def open_stream():
        return open_event_stream(
            "/v1/code/sessions/%s/events/stream" % quoted, token)

    # The stream is one long-lived chunked request. A dropped connection must
    # not throw away the rest of the turn: reopen it once and resend the event
    # that failed. Only a second failure falls back to the terminal POST below.
    stream = {}
    stream["write"], stream["close"] = open_stream()

    def write_event(payload):
        try:
            stream["write"](payload)
            return
        except Exception:
            try:
                stream["close"]()
            except Exception:  # noqa: BLE001 - it is already dead
                pass
            stream["write"], stream["close"] = open_stream()
            stream["write"](payload)

    # A rewind the bridge already answered for the page; the agent applies it
    # before this turn's prompts so `--resume` cannot replay what was taken
    # back. The bridge keeps carrying it in the hint until this turn reports
    # that the agent answered it.
    rewind = hint.get("pending_rewind")
    rewind = rewind if isinstance(rewind, dict) else None

    steer = {"session": session, "token": token, "floor": highest}

    # The context meter's answer is refreshed while this turn's process still
    # holds the conversation (see remember_context_usage). The settings that
    # shaped this turn are part of the key: a later change makes the cached
    # answer stale rather than wrong.
    usage_config = {"model": model, "permission_mode": permission_mode,
                    "effort_level": effort}

    def remember_usage(usage):
        remember_context_usage(session, usage_config, usage)

    def turn(extra):
        return run_agent(argv + extra, cwd, messages, write_event, interrupt, rewind,
                         steer, remember_usage)

    (code, result, timed_out, was_interrupted, forwarded, failures, errors,
     rewind_done, results_emitted) = turn(["--resume", resume] if resume else [])
    if (not was_interrupted and resume and forwarded == 0 and failures == []
            and result is not None
            and result.get("is_error")
            and any("No conversation found" in line for line in errors)):
        # The agent's own transcripts are gone (rebuilt image, wiped home);
        # the bridge transcript still has the conversation, the agent does
        # not — start a fresh one rather than failing the turn.
        log("session %s: no conversation %s in the guest; starting a new one"
            % (session, resume))
        (code, result, timed_out, was_interrupted, forwarded, failures, errors,
         rewind_done, results_emitted) = turn([])
    if rewind is not None and rewind_done:
        # The agent answered (applied or declined); stop carrying it in the
        # hint. A timeout — no answer — keeps it for the next turn.
        try:
            request("/v1/code/runners/self-hosted/sessions/%s/claim" % quoted,
                    {"through_sequence_num": highest,
                     "applied_rewind_request_id": rewind.get("request_id")}, token)
        except Exception as error:  # noqa: BLE001 - the next turn can retry it
            log("session %s: could not clear the applied rewind: %s"
                % (session, error))

    # Every turn ends with a `result`: the session view closes the turn on it,
    # and a failure that writes none leaves the page spinning forever. The
    # agent's own terminal wins when it produced one (an error result included:
    # its `result` field is the reason).
    synthesized = False
    if result is None:
        synthesized = True
        if was_interrupted:
            result = synthetic_result("Request interrupted by user", resume, started,
                                      interrupted=True)
        elif timed_out:
            result = synthetic_result(
                "agent ran longer than %ss" % int(TURN_TIMEOUT), resume, started)
        elif code == 0:
            result = synthetic_result(
                "agent exited 0 without a result message", resume, started)
        else:
            reason = errors[-1] if errors else "agent exited %s" % code
            result = synthetic_result(reason, resume, started)

    duration = time.time() - started
    log("session %s: turn done in %.1fs (%s events, %s turns, cost %s)" % (
        session, duration, forwarded, result.get("num_turns"),
        result.get("total_cost_usd")))
    # The turn's own `result` message belongs in the transcript too: it is the
    # terminal the reader closes the turn on (the SDK stream carries it, the
    # wire contract lists it as a transcript type, and a reader that never
    # sees one holds the turn open — rows around tool calls stay unplaced).
    # Written after the retry decision, so a discarded first attempt leaves
    # nothing behind.
    # A plain turn's single result was held by run_agent and is written here.
    # A steered turn already wrote each result as it arrived (the interrupted
    # turn's and the message's own), so writing the last one again would
    # duplicate the terminal the page closes a turn on.
    delivered = results_emitted > 0 and not synthesized
    if not delivered:
        try:
            write_event(result)
            delivered = True
        except Exception as error:  # noqa: BLE001 - fall back to a plain append
            failures.append("result stream: %s" % error)
    try:
        stream["close"]()
    except Exception as error:  # noqa: BLE001 - recorded with the run
        if delivered:
            log("session %s: event stream close failed after the result: %s"
                % (session, error))
        else:
            failures.append("stream close: %s" % error)
    if not delivered:
        # The stream is gone; the append leg is authenticated with the same
        # runner credential and does not need the turn's connection.
        try:
            post_event(session, result, token)
            delivered = True
        except Exception as error:  # noqa: BLE001 - nothing left to try
            failures.append("result fallback: %s" % error)
    if not delivered:
        log("session %s: the turn's result could not be written" % session)

    if failures:
        finish("report-failure", {"reason": "could not write events: %s" % failures[0][:300],
                                  "failure_kind": "agent_failed"})
    elif timed_out:
        finish("report-failure", {"reason": "agent ran longer than %ss" % int(TURN_TIMEOUT),
                                  "failure_kind": "timeout"})
    elif was_interrupted:
        # A Stop is not a failure: the session goes idle and the next message
        # requeues it. A session that was deleted mid-turn is already gone, so
        # the release is allowed to find nothing.
        finish("release", {}, strict=False)
    elif code == 0 and not result.get("is_error"):
        finish("release", {})
    else:
        reason = ""
        if isinstance(result.get("result"), str) and result["result"].strip():
            reason = result["result"].strip()
        elif errors:
            reason = errors[-1]
        else:
            reason = "agent exited %s" % code
        finish("report-failure", {"reason": reason[:600], "failure_kind": "agent_failed"})
    log("session %s: agent exited %s%s" % (
        session, code, " (interrupted)" if was_interrupted else ""))
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
        return
    # The agent runs as the guest's root while the shared workspace's files
    # belong to the host user. Git refuses a repository owned by another user
    # unless it is declared safe; the runner's HOME is the agent's, so declare
    # the shared tree there rather than have every first command fail.
    config = os.path.join(RUNNER_HOME, ".gitconfig")
    if not os.path.exists(config):
        try:
            with open(config, "w", encoding="utf-8") as handle:
                handle.write("[safe]\n\tdirectory = *\n")
            os.chmod(config, 0o600)
        except OSError as error:
            log("could not write %s (%s)" % (config, error))


# One agent process per active turn, and each holds the conversation in memory.
# The VM is sized for a handful; the queue keeps excess hints claimed (so the
# bridge does not reap them) until a slot frees.
TURN_SLOTS = threading.Semaphore(max(1, MAX_TURNS))


def report_unhandled(session_id, error):
    """Close a turn whose thread failed before `run_session` could.

    An exception in the setup path used to be logged only, leaving the bridge
    believing the session was running and the page spinning. There is no turn
    stream here, so both the terminal and the failure go on their own requests,
    authenticated with the runner's credential (the bridge accepts it on both).
    """
    if not isinstance(session_id, str) or not session_id:
        return
    reason = "the runner could not run this turn: %s" % error
    try:
        post_event(session_id, synthetic_result(reason),
                   token=RUNNER_TOKEN or SECRET)
    except Exception as write_error:  # noqa: BLE001 - nothing left to try
        log("session %s: could not write the failure result: %s"
            % (session_id, write_error))
    try:
        expect(request(
            "/v1/code/runners/self-hosted/sessions/%s/report-failure"
            % urllib.parse.quote(session_id),
            {"reason": reason[:600], "failure_kind": "agent_failed"},
            token=RUNNER_TOKEN or SECRET), "report-failure")
    except Exception as report_error:  # noqa: BLE001 - the bridge may be down
        log("session %s: could not report the failure: %s"
            % (session_id, report_error))


def run_session_thread(hint):
    """One session turn on its own thread; failures stay with that session."""
    session_id = hint.get("session_uuid")
    interrupt = register_turn(session_id)
    try:
        with TURN_SLOTS:
            run_session(hint, interrupt)
    except Exception as error:  # noqa: BLE001 - keep serving the pool
        log("session %s failed: %s" % (session_id, error))
        report_unhandled(session_id, error)
    finally:
        unregister_turn(session_id)


def run_sessions_forever(session_queue):
    """Spawn every session hint on its own thread; the semaphore caps the turns.

    A turn can last as long as TURN_TIMEOUT, and the Code UI's folder and git
    lookups ride the same poll as work. Running the agent inline meant the
    runner stopped polling for the whole turn, so those lookups timed out
    whenever a session was active — exactly when the user is in the Code
    surface. Moving turns to a *single* background worker freed the poll but
    kept them serialized, which is not what a self-hosted runner is: the
    protocol hands out spawn hints so each session may run. Sessions are
    independent (own id, transcript, event stream and, with the worktree
    option, own checkout); the only shared state is git setup on a repo, which
    `session_workdir` serializes with a per-repo lock. So one thread per hint,
    with `TURN_SLOTS` bounding how many agents run at once.
    """
    while True:
        hint = session_queue.get()
        name = "claudesk-session-%s" % (str(hint.get("session_uuid") or "?")[-12:])
        threading.Thread(target=run_session_thread, args=(hint,),
                         name=name, daemon=True).start()


def main():
    if not SECRET:
        log("CLAUDESK_RUNNER_SECRET is not set; refusing to poll")
        return 2
    if "--output-format" not in AGENT_ARGS:
        log("warning: CLAUDESK_RUNNER_AGENT_ARGS lacks stream-json output; "
            "the transcript cannot be read from it")
    prepare_home()
    ensure_workspace_alias()
    log("polling %s (agent %s, checkout %s)" % (BASE, CLAUDE_BIN, CHECKOUT))
    register()
    # `--once` is a probe: it runs whatever it is handed inline and returns.
    # The service hands each hint to its own thread so the poll never blocks
    # and sessions run concurrently.
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
        # A Stop is carried on the same held poll: the bridge wakes it and
        # names the sessions whose turn must end. Apply it before the rest so
        # a stop is never queued behind a folder lookup.
        apply_cancellations(polled.get("cancellations") or [])
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
                session_id = hint.get("session_uuid")
                # A duplicate hint is possible when the bridge's offer lease
                # expired while this runner held the session behind the turn
                # cap. The claim already exists, so ignore the second copy
                # rather than run the same session twice.
                with RUNNING_TURNS_LOCK:
                    duplicate = session_id in RUNNING_TURNS
                if duplicate:
                    log("session %s: duplicate hint ignored" % session_id)
                    continue
                # Claim before the thread exists: the next poll (issued
                # immediately) is what tells the bridge this session is held,
                # and the window before the thread starts is exactly where a
                # reaper would otherwise call it lost.
                claim_session(session_id)
                session_queue.put(hint)
                continue
            try:
                run_session(hint)
            except Exception as error:  # noqa: BLE001 - keep serving the pool
                log("session %s failed: %s" % (hint.get("session_uuid"), error))
                report_unhandled(hint.get("session_uuid"), error)
        if ONCE:
            return 0


if __name__ == "__main__":
    sys.exit(main())
