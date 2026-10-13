import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The login shell puts Claude's own sign-in page in front of the deployment
// before anyone has a session, so the one thing it must never do is answer an
// API request. The bridge refuses the whole surface in that mode — including
// the routes it synthesises itself, like the workspace folder listing — which
// is what keeps an unauthenticated caller away from the Desktop, a store, or
// inference even if the proxy misroutes. This boots the real bridge and asks.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;
const port = 8155;

// The bridge reads release.json beside itself; the image provides it, a
// checkout keeps it in config/. Supply one for the run and take it away again.
const createdRelease = !existsSync(releaseFile);
if (createdRelease) {
  writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
}

async function request(path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
}

const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(port),
    BRIDGE_HOST: "127.0.0.1",
    CLAUDE_REMOTE_LOGIN_SHELL: "1",
    // Nothing is listening here: any request that reached for the auth service
    // or the Desktop would fail loudly rather than quietly succeed.
    AUTH_IDENTITY_URL: "http://127.0.0.1:9",
    COWORK_INTERNAL_URL: "http://127.0.0.1:9",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("listening on")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
});

try {
  await ready;
  for (const path of [
    "/api/bootstrap",
    "/edge-api/bootstrap",
    "/api/remote/folders",
    "/api/remote/account/avatar",
  ]) {
    const { status, body } = await request(path);
    assert.equal(status, 403, `${path} must be refused without a session`);
    assert.match(body, /not signed in/, `${path} must say why`);
  }
  const ipc = await request("/api/remote/ipc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "LocalAgentModeSessions", method: "getAll", args: [] }),
  });
  assert.equal(ipc.status, 403, "the IPC proxy must never be reachable unauthenticated");

  // The page itself is served: inert bytes are not the risk.
  const shell = await request("/remote-preload.js");
  assert.equal(shell.status, 200, "the shell's own assets still serve");

  // The container healthcheck probes this path, so it has to answer — but with
  // liveness only, not the Desktop's surface list the real route reports.
  const health = await request("/api/health");
  assert.equal(health.status, 200, "the healthcheck must still pass in this mode");
  assert.deepEqual(JSON.parse(health.body), { ok: true },
    "health must report liveness, not the Desktop's surfaces");

  console.log("login-shell-smoke: the login shell refuses the API and serves its assets");
} finally {
  child.kill("SIGKILL");
  if (createdRelease) rmSync(releaseFile, { force: true });
}
