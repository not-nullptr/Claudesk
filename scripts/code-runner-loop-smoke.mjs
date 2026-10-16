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

  // A runner that has not registered yet does not make the pool a place.
  assert.deepEqual(
    JSON.parse((await request("/v1/environment_providers/private/organizations/"
      + "00000000-0000-4000-8000-000000000000/environments")).body).environments,
    [],
    "the pool is not a place before a runner claims it",
  );
  await runner.register();
  const places = JSON.parse((await request("/v1/environment_providers/private/organizations/"
    + "00000000-0000-4000-8000-000000000000/environments")).body).environments;
  assert.equal(places.length, 1);
  assert.equal(places[0].environment_id, poolId, "registering makes the pool a place");

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

  // The runner is offered it, runs it, and releases it.
  const offered = await runner.poll();
  assert.equal(offered.hints.length, 1, "the runner is offered the placed session");
  assert.equal(offered.hints[0].session_uuid, sessionId);
  const ran = await runner.runSession(offered.hints[0], { message: "ran on the runner" });
  assert.equal(ran.session_uuid, sessionId);
  assert.equal(ran.events, 1, "the runner's transcript write is recorded");

  // What the app then reads: the transcript under its own contract, and the
  // session no longer offered to anyone.
  const history = JSON.parse(
    (await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded = decodeClientEventsResponse(history);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].message.type, "assistant");
  assert.equal(decoded[0].message.message.content[0].text, "ran on the runner");
  assert.deepEqual((await runner.poll()).hints, [],
    "a released session is not handed out again");
} finally {
  if (child) child.kill("SIGTERM");
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

process.stdout.write("code-runner-loop-smoke: a session is placed, run by a runner and read back\n");
