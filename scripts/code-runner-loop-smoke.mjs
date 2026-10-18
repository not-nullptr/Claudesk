import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRunnerClient } from "./code-runner-client.mjs";
import { decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";

// A whole session, driven the way it will be in production: the Code surface
// places one on a self-hosted place, a runner takes it, runs it and reports
// back. Everything but the Claude Code process itself is real here — the bridge
// is booted, the runner talks its own protocol over HTTP, the session's
// transcript goes through the events leg, and the result is read back the way
// the app reads it. The mobile facade has the same kind of harness in
// scripts/lib/fake-claudesk.mjs; this is the runner's.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;
const port = 8158;

const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
const stateDir = mkdtempSync(join(tmpdir(), "code-runner-loop-"));
let child;

const request = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
};

try {
  child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      AUTH_IDENTITY_URL: "http://127.0.0.1:9",
      COWORK_INTERNAL_URL: "http://127.0.0.1:9",
      // One account's own instance, answering its self-hosted pool API.
      CLAUDESK_TENANT: "1",
      CLAUDESK_CODE_RUNNERS: "1",
      CLAUDESK_CODE_RUNNER_POOL: "loop-smoke",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });

  const poolId = JSON.parse((await request("/v1/code/runners/self-hosted/pools")).body)
    .pools[0].pool_id;
  const secret = JSON.parse(readFileSync(join(stateDir, "code-runners.json"), "utf8"))
    .pools[0].secret;

  const runner = createRunnerClient({ base: `http://127.0.0.1:${port}`, secret });

  // The pool is a place before a runner registers: placing a session wakes the
  // VM, so a fresh account's picker is not empty.
  const early = JSON.parse((await request("/v1/environment_providers/private/organizations/"
    + "00000000-0000-4000-8000-000000000000/environments")).body).environments;
  assert.equal(early.length, 1, "the pool is a place before a runner claims it");
  assert.equal(early[0].environment_id, poolId);
  assert.equal(early[0].state, "active");
  await runner.register();
  const places = JSON.parse((await request("/v1/environment_providers/private/organizations/"
    + "00000000-0000-4000-8000-000000000000/environments")).body).environments;
  assert.equal(places.length, 1);
  assert.equal(places[0].environment_id, poolId, "registering keeps the pool a place");

  // A runner with nothing to do is told so, rather than blocking.
  const idle = await runner.poll();
  assert.deepEqual(idle.hints, [], "a pool with no work offers none");

  // The Code surface places a session on that place.
  const placed = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "the loop", environment_id: poolId,
      config: { sources: [{ type: "git_repository", url: "https://example.invalid/r.git",
        revision: "refs/heads/main" }] } }),
  });
  assert.equal(placed.status, 201, placed.body);
  const sessionId = JSON.parse(placed.body).session.id;

  // The user's prompt arrives as a client event, the way the composer sends it.
  await request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "what is this repo" } } }] }),
  });

  // The runner is offered it, runs an agent on it, and releases it. The agent
  // here is a stub standing in for the Claude Code binary the guest carries —
  // everything from the runner's protocol to the transcript it writes is real.
  const offered = await runner.poll();
  assert.equal(offered.hints.length, 1, "the runner is offered the placed session");
  assert.equal(offered.hints[0].session_uuid, sessionId);
  const ran = await runner.runSession(offered.hints[0], {
    execute: { bin: process.execPath,
      args: (prompt) => ["--eval", `process.stdout.write("ran on the runner: " + ${JSON.stringify(prompt)})`] },
  });
  assert.equal(ran.session_uuid, sessionId);
  assert.equal(ran.exit, 0, "the agent exited cleanly");
  assert.equal(ran.events, 1, "the agent's output is written back to the session");

  // What the app then reads: the prompt it sent, the agent's answer, both under
  // its own contract — and the session no longer offered to anyone.
  const history = JSON.parse(
    (await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded = decodeClientEventsResponse(history);
  assert.deepEqual(decoded.map((entry) => entry.message.type), ["user", "assistant"]);
  assert.equal(decoded[1].message.message.content[0].text,
    "ran on the runner: what is this repo", "the agent ran on the prompt the session carried");
  assert.deepEqual((await runner.poll()).hints, [],
    "a released session is not handed out again");

  // An agent that fails is reported rather than released, and its partial output
  // still lands — the operator sees why on the session.
  const second = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "the loop, failing", environment_id: poolId }),
  });
  const secondId = JSON.parse(second.body).session.id;
  await request(`/v1/code/sessions/${secondId}/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "fail please" } } }] }),
  });
  const failing = await runner.runSession((await runner.poll()).hints[0], {
    execute: { bin: process.execPath,
      args: () => ["--eval", 'process.stderr.write("boom"); process.exit(3)'] },
  });
  assert.equal(failing.exit, 3);
  const failed = JSON.parse((await request(`/v1/code/sessions/${secondId}`)).body);
  // The app has no displayed "failed" — the session reads active and idle, and
  // the failure is what the transcript says (and what the pool's own session
  // list — the admin view — records as `state: "failed"`).
  assert.equal(failed.session.status, "active");
  assert.equal(failed.session.worker_status, "idle", "a failed run leaves the session idle");
} finally {
  if (child) child.kill("SIGTERM");
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

process.stdout.write("code-runner-loop-smoke: a session is placed, run by a runner and read back\n");
