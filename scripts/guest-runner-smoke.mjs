import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";

// The guest-side runner (guest/runner.py), driven against a booted bridge: the
// same loop the VM will run, minus the VM. The agent is a stub script standing
// in for the Claude Code binary the guest carries, so this proves the runner's
// protocol, its prompt handling and its transcript write-back without a guest.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;
const port = 8159;

const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
const work = mkdtempSync(join(tmpdir(), "guest-runner-"));
const stateDir = join(work, "state");
writeFileSync(stateDir, "", { flag: "w+" });
rmSync(stateDir);
// The agent lives where the guest keeps its own: a `claude-bin` directory with
// the runnable inside it — the runner is pointed at the directory and must
// resolve the binary (the product's path is exactly this shape).
const stub_dir = join(work, "claude-bin");
mkdirSync(stub_dir, { recursive: true });
const stub = join(stub_dir, "claude");
writeFileSync(stub, "#!/bin/sh\nprintf 'agent saw: %s %s' \"$1\" \"$2\"\n");
chmodSync(stub, 0o755);
let child;

const request = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
};

function runRunner({ secret, once = true }) {
  return spawnSync("python3", ["-I", `${root}guest/runner.py`, ...(once ? ["--once"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: secret,
      CLAUDESK_RUNNER_CLAUDE_BIN: stub_dir,
      CLAUDESK_RUNNER_CHECKOUT: work,
    },
  });
}

try {
  child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      AUTH_IDENTITY_URL: "http://127.0.0.1:9",
      COWORK_INTERNAL_URL: "http://127.0.0.1:9",
      CLAUDESK_TENANT: "1",
      CLAUDESK_CODE_RUNNERS: "1",
      CLAUDESK_CODE_RUNNER_POOL: "guest-smoke",
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

  // The runner registers on start-up, which is what makes the pool a place.
  const idle = runRunner({ secret });
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /registered as ccrunner_/, idle.stdout);
  assert.match(idle.stdout, /no work/, idle.stdout);

  const places = JSON.parse((await request("/v1/environment_providers/private/organizations/"
    + "00000000-0000-4000-8000-000000000000/environments")).body).environments;
  assert.equal(places.length, 1, "the guest runner's registration makes the pool a place");

  // A session with a prompt, placed the way the Code surface places one.
  const placed = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "guest smoke", environment_id: poolId }),
  });
  const sessionId = JSON.parse(placed.body).session.id;
  await request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "summarise the repo" } } }] }),
  });

  // The runner takes it, runs the agent in the "guest", and writes it back.
  const ran = runRunner({ secret });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`session ${sessionId}`), ran.stdout);
  assert.match(ran.stdout, /agent exited 0/, ran.stdout);

  const history = JSON.parse((await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded = decodeClientEventsResponse(history);
  assert.deepEqual(decoded.map((entry) => entry.message.type), ["user", "assistant"]);
  assert.equal(decoded[1].message.message.content[0].text, "agent saw: -p summarise the repo",
    "the agent ran on the prompt the session carried");
  const releasedDoc = JSON.parse((await request(`/v1/code/sessions/${sessionId}`)).body).session;
  assert.equal(releasedDoc.status, "active", "a session the app reads stays active");
  assert.equal(releasedDoc.worker_status, "idle", "a clean run leaves it idle");

  // A runner with no secret must refuse to poll rather than guess.
  const refused = spawnSync("python3", ["-I", `${root}guest/runner.py`, "--once"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: "" },
  });
  assert.equal(refused.status, 2, "a runner without a secret refuses to start");
  assert.match(refused.stdout, /refusing to poll/);
} finally {
  if (child) child.kill("SIGTERM");
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write("guest-runner-smoke: the guest runner registers, runs an agent and reports\n");
