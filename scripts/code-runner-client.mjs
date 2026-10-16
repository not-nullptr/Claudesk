// A minimal self-hosted Code runner, as a client of the bridge.
//
//   node code-runner-client.mjs --base URL --pool POOL_ID --secret SECRET [--once]
//
// The real runner is Claude Code itself (`claude self-hosted-runner`); this
// speaks the same protocol so the bridge's side of it can be exercised without a
// Desktop, a guest or Anthropic's cloud — the shape scripts/lib/fake-claudesk.mjs
// gives the mobile facade. It is also a diagnostic: pointed at a live tenant it
// says whether that instance's pool answers and what it offers.
//
// The protocol, read off the runner client in the Claude Code 2.1.295 binary:
//
//   POST /v1/code/runners/self-hosted/runners/register    -> {runner_id}
//   POST /v1/code/runners/self-hosted/spawn-hints/poll    -> {hints:[…]}
//   POST /v1/code/runners/self-hosted/sessions/{id}/token -> {session_token}
//   POST /v1/code/sessions/{id}/events                    (as the runner, with
//                                                         the session token)
//   POST /v1/code/runners/self-hosted/sessions/{id}/release
//
// Auth is the pool secret on every runner call, as `Authorization: Bearer …`.
// See docs/code-in-cowork-vm.md.
import { parseArgs } from "node:util";

export function createRunnerClient({ base, secret, runnerVersion = "2.1.295", log = () => {} }) {
  const root = String(base).replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  async function call(path, { method = "POST", headers = auth, body } = {}) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
    return { status: response.status, body: parsed, text };
  }

  function expect(answer, what) {
    if (answer.status !== 200) {
      throw new Error(`${what} answered ${answer.status}: ${answer.text.slice(0, 200)}`);
    }
    return answer.body;
  }

  /** Register this runner with the pool the secret names. */
  async function register() {
    const body = expect(await call("/v1/code/runners/self-hosted/runners/register", {
      body: { runner_version: runnerVersion, use_anthropic_git_proxy: false,
        client_label: "claudesk-runner-client" },
    }), "register");
    log(`registered as ${body.runner_id}`);
    return body.runner_id;
  }

  /** Poll once; returns the hints the pool is offering. */
  async function poll() {
    return expect(await call("/v1/code/runners/self-hosted/spawn-hints/poll", { body: {} }), "poll");
  }

  /**
   * Run one offered session the way a real runner would: take the session token,
   * write the transcript through the session's own events leg, then release it.
   * Executing Claude Code against the session is what a real runner adds here.
   */
  async function runSession(hint, { message = "runner: session started" } = {}) {
    const sessionId = encodeURIComponent(hint.session_uuid);
    const { session_token: token } = expect(
      await call(`/v1/code/runners/self-hosted/sessions/${sessionId}/token`), "token");
    const wrote = expect(await call(`/v1/code/sessions/${sessionId}/events`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { payload: { type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: message }] } } },
    }), "events");
    expect(await call(`/v1/code/runners/self-hosted/sessions/${sessionId}/release`), "release");
    return { session_uuid: hint.session_uuid, events: wrote.data?.length ?? 0 };
  }

  return { register, poll, runSession };
}

// Pointed at a live instance the script loops; imported by the smoke it does not.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      pool: { type: "string" },
      secret: { type: "string" },
      once: { type: "boolean", default: false },
      poll: { type: "string" },
      message: { type: "string" },
    },
  });
  if (!values.base || !values.secret) {
    process.stderr.write("usage: code-runner-client.mjs --base URL --pool POOL_ID --secret SECRET [--once]\n");
    process.exit(2);
  }
  const log = (line) => process.stdout.write(`[runner] ${line}\n`);
  const client = createRunnerClient({ base: values.base, secret: values.secret, log });
  await client.register();
  const interval = Math.max(1, Number(values.poll ?? 5)) * 1000;
  for (;;) {
    const polled = await client.poll();
    const [hint] = polled.hints ?? [];
    if (!hint) {
      if (values.once) {
        log(`no work (pending=${polled.pending_count ?? 0})`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      continue;
    }
    const ran = await client.runSession(hint, values.message ? { message: values.message } : {});
    log(`ran ${ran.session_uuid} (${ran.events} event(s) written)`);
    if (values.once) break;
  }
}
