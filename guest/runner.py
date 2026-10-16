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

Stdlib only, on purpose: the guest is a stock Ubuntu image, and this must not
depend on anything we would have to install into it.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"


def env(name, default=""):
    return os.environ.get(name, default).strip()


BASE = env("CLAUDESK_RUNNER_BASE", "http://10.0.2.2:8080").rstrip("/")
SECRET = env("CLAUDESK_RUNNER_SECRET")
CLAUDE_BIN = env("CLAUDESK_RUNNER_CLAUDE_BIN", "/opt/cowork/claude-bin")
CHECKOUT = env("CLAUDESK_RUNNER_CHECKOUT", "/sessions")
POLL_SECONDS = float(env("CLAUDESK_RUNNER_POLL_SECONDS", "5") or 5)
# How the binary is asked to answer one prompt. `--print` is Claude Code's
# non-interactive form; a deployment that wants something else sets this.
AGENT_ARGS = env("CLAUDESK_RUNNER_AGENT_ARGS", "--print").split()
ONCE = "--once" in sys.argv[1:]


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
    prompt = prompt_of((history or {}).get("data") if isinstance(history, dict) else [])

    if not os.path.exists(CLAUDE_BIN):
        finish("report-failure", {"reason": "%s is not present in the guest" % CLAUDE_BIN,
                                  "setup_failure_kind": "missing_binary"})
        log("session %s: no agent at %s" % (session, CLAUDE_BIN))
        return session, 127

    argv = [CLAUDE_BIN] + AGENT_ARGS + [prompt]
    # The checkout is where the session's work happens; a guest without it (a
    # fresh image, a stopped VM) still runs, from /, rather than failing the
    # session on a directory.
    cwd = CHECKOUT if os.path.isdir(CHECKOUT) else "/"
    log("session %s: running %s in %s" % (session, " ".join(argv[:2]), cwd))
    try:
        completed = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                                   timeout=float(env("CLAUDESK_RUNNER_TIMEOUT_SECONDS", "1800") or 1800))
        output = (completed.stdout or "") + (completed.stderr or "")
        code = completed.returncode
    except Exception as error:  # noqa: BLE001 - anything here is a failed session
        output, code = str(error), 126
    text = output.strip()
    if text:
        write({"type": "assistant",
               "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
    if code == 0:
        finish("release", {})
    else:
        finish("report-failure", {"reason": "agent exited %s" % code,
                                  "failure_kind": "agent_failed"})
    log("session %s: agent exited %s" % (session, code))
    return session, code


def main():
    if not SECRET:
        log("CLAUDESK_RUNNER_SECRET is not set; refusing to poll")
        return 2
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
