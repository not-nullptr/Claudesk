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
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

/** The text of the last user message a session carries — what the runner runs. */
export function promptOf(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const message = events[i]?.payload;
    if (message?.type !== "user") continue;
    const content = message.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
      if (text) return text;
    }
  }
  return "";
}

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
   * Run one offered session: take the session token, then either execute an
   * agent for it (`execute`) or write the transcript directly.
   *
   * With `execute` the runner does what the real one does — read the session's
   * events for the user's prompt, spawn the Claude Code binary on it, write the
   * agent's output back as assistant messages, and release (or report the
   * failure). `execute` is `{ bin, args(prompt), cwd?, env? }`; the default
   * below is `claude --print <prompt>`, the non-interactive form.
   */
  async function runSession(hint, { execute = null, message = "runner: session started" } = {}) {
    const sessionId = encodeURIComponent(hint.session_uuid);
    const { session_token: token } = expect(
      await call(`/v1/code/runners/self-hosted/sessions/${sessionId}/token`), "token");
    const sessionAuth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const write = async (payload) => {
      const wrote = expect(await call(`/v1/code/sessions/${sessionId}/events`, {
        headers: sessionAuth, body: { payload },
      }), "events");
      return wrote.data?.length ?? 0;
    };
    const release = async () => {
      expect(await call(`/v1/code/runners/self-hosted/sessions/${sessionId}/release`), "release");
    };

    if (!execute) {
      const written = await write({ type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: message }] } });
      await release();
      return { session_uuid: hint.session_uuid, events: written, exit: 0 };
    }

    const history = await call(`/v1/code/sessions/${sessionId}/events`,
      { method: "GET", headers: sessionAuth });
    const prompt = promptOf(history.body?.data ?? []);
    let events = 0;
    let output = "";
    const child = spawn(execute.bin, execute.args(prompt), {
      cwd: execute.cwd ?? process.cwd(),
      env: { ...process.env, ...execute.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const text = output.trim();
    if (text) {
      events += await write({ type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] } });
    }
    if (code === 0) {
      await release();
    } else {
      expect(await call(`/v1/code/runners/self-hosted/sessions/${sessionId}/report-failure`, {
        headers: sessionAuth,
        body: { reason: `agent exited ${code}`, failure_kind: "agent_failed" },
      }), "report-failure");
    }
    log(`session ${hint.session_uuid}: agent exited ${code}, ${events} event(s) written`);
    return { session_uuid: hint.session_uuid, events, exit: code };
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
      // Execute an agent for each session instead of writing a canned message.
      // The binary is the one the guest carries (CLAUDE_RUNNER_CLAUDE_BIN in the
      // real runner's own environment); non-interactive, so `--print`.
      exec: { type: "boolean", default: false },
      "claude-bin": { type: "string", default: process.env.CLAUDE_RUNNER_CLAUDE_BIN || "claude" },
      cwd: { type: "string", default: process.env.CLAUDE_RUNNER_CHECKOUT_PATH },
    },
  });
  if (!values.base || !values.secret) {
    process.stderr.write("usage: code-runner-client.mjs --base URL --pool POOL_ID --secret SECRET "
      + "[--once] [--exec [--claude-bin PATH] [--cwd DIR]]\n");
    process.exit(2);
  }
  const log = (line) => process.stdout.write(`[runner] ${line}\n`);
  const client = createRunnerClient({ base: values.base, secret: values.secret, log });
  const execute = values.exec
    ? { bin: values["claude-bin"], args: (prompt) => ["--print", prompt],
        ...(values.cwd ? { cwd: values.cwd } : {}) }
    : null;
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
    const ran = await client.runSession(hint, {
      ...(execute ? { execute } : {}),
      ...(values.message ? { message: values.message } : {}),
    });
    log(`ran ${ran.session_uuid} (${ran.events} event(s) written, exit ${ran.exit})`);
    if (values.once) break;
  }
}
