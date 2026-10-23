import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Every account's Desktop joins the same external gateway_net, and the bridge
// listens on 0.0.0.0 there — the reverse proxy is not in the path between two
// peers. This pins the bridge's own gate: no authd session for this account
// (and no mobile-facade token) means no API, while the guest runner's
// secret-authenticated legs stay reachable.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;

const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));

const stateDir = mkdtempSync(join(tmpdir(), "bridge-auth-"));
const children = [];
const servers = [];

function listen(handler) {
  return new Promise((resolve) => {
    const mock = http.createServer(handler);
    servers.push(mock);
    mock.listen(0, "127.0.0.1", () => resolve(mock));
  });
}

async function boot({ port, env }) {
  const started = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      // The bridge persists its restart notice in the state dir on SIGTERM;
      // the test removes that directory as soon as every child has stopped.
      CLAUDE_REMOTE_SHUTDOWN_NOTICE_MS: "0",
      CLAUDE_REMOTE_LOGIN_SHELL: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(started);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    started.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });
  return async (path, init) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: await response.text() };
  };
}

try {
  // The shared authd: two accounts on the box. The bridge must accept only the
  // one named by CLAUDE_REMOTE_ACCOUNT_EMAIL, not just any live cookie.
  const authd = await listen((request, response) => {
    if (request.url !== "/api/auth/me") {
      response.writeHead(404).end();
      return;
    }
    const cookie = String(request.headers.cookie || "");
    const user = /(?:^|;\s*)session=owner(?:;|$)/.test(cookie)
      ? { id: 1, email: "owner@example.com", first_name: "Owner" }
      : /(?:^|;\s*)session=other(?:;|$)/.test(cookie)
        ? { id: 2, email: "other@example.com", first_name: "Other" }
        : null;
    response.writeHead(user ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(user ? { user } : { error: "no session" }));
  });

  // A stand-in Desktop. The gate is this smoke's subject; only the shape the
  // health route reads is provided. The release must match the bridge's copy.
  const release = JSON.parse(readFileSync(`${root}config/release.json`, "utf8"));
  const desktop = await listen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/runtime") {
      response.end(JSON.stringify({
        ok: true,
        value: {
          renderer: {
            desktopVersion: release.desktopVersion,
            patchRelease: release.patchRelease,
            basePath: `/renderer/${release.desktopVersion}/${release.patchRelease}`,
            patches: [],
          },
        },
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true, surfaces: {}, value: null }));
  });

  const request = await boot({
    port: 8167,
    env: {
      COWORK_INTERNAL_URL: `http://127.0.0.1:${desktop.address().port}`,
      AUTH_IDENTITY_URL: `http://127.0.0.1:${authd.address().port}`,
      CLAUDESK_TENANT: "1",
      CLAUDESK_CODE_RUNNERS: "1",
      CLAUDESK_CODE_RUNNER_POOL: "smoke-pool",
      CLAUDE_REMOTE_ACCOUNT_EMAIL: "owner@example.com",
      CLAUDESK_BRIDGE_TOKEN: "smoke-bridge-token",
      CLAUDE_REMOTE_CODE_ACTIONS: "0",
    },
  });

  const owner = { cookie: "session=owner" };
  const other = { cookie: "session=other" };
  const facade = { "x-claudesk-bridge-token": "smoke-bridge-token" };

  assert.equal((await request("/api/bootstrap")).status, 401,
    "a peer with no session cannot read the bootstrap");
  assert.equal((await request("/api/bootstrap", { headers: other })).status, 403,
    "another account's authd cookie is not this instance's session");
  const ipc = await request("/api/remote/ipc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "FileSystem", method: "listDirectory", args: ["/tmp"] }),
  });
  assert.equal(ipc.status, 401, "the IPC lane is closed to a peer");
  assert.equal((await request("/v1/filestore/fs/createFile", { method: "POST" })).status, 401,
    "the filestore upload is closed to a peer");
  assert.equal((await request("/v1/code/triggers")).status, 401,
    "the routines store is closed to a peer");
  assert.equal((await request("/v1/code/sessions")).status, 401,
    "the Code session list is closed to a peer");

  // Liveness stays open but says nothing about the instance; a session or the
  // facade token gets the full document the UI and the phone read.
  const openHealth = await request("/api/health");
  assert.equal(openHealth.status, 200);
  const openHealthBody = JSON.parse(openHealth.body);
  assert.equal(openHealthBody.ok, true);
  assert.equal(openHealthBody.instance, undefined,
    "an unauthenticated health answer names no instance");
  assert.equal(openHealthBody.surfaces, undefined,
    "an unauthenticated health answer exposes no surfaces");
  const ownerHealth = await request("/api/health", { headers: owner });
  assert.equal(ownerHealth.status, 200);
  assert.ok(JSON.parse(ownerHealth.body).instance,
    "the owner's session gets the full health document");
  const facadeHealth = await request("/api/health", { headers: facade });
  assert.equal(facadeHealth.status, 200);
  assert.ok(JSON.parse(facadeHealth.body).instance,
    "the mobile facade's token gets the same");

  // The facade is server-to-server; its token is a pass for the browser-shaped
  // Code legs too.
  assert.equal((await request("/v1/code/sessions", { headers: facade })).status, 200,
    "the facade token reaches the Code list");

  // The guest runner authenticates by pool secret alone. The gate must not
  // require a browser session on its own legs.
  const stored = JSON.parse(readFileSync(join(stateDir, "code-runners.json"), "utf8"));
  const secret = stored.pools[0].secret;
  const registered = await request("/v1/code/runners/self-hosted/runners/register", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ runner_version: "2.1.295", use_anthropic_git_proxy: false }),
  });
  assert.equal(registered.status, 200, registered.body);
  assert.ok(JSON.parse(registered.body).runner_id.startsWith("ccrunner_"),
    "the runner registers without a browser session");

  // The gate must not blind the Cowork VM's idle monitor. It lives in the
  // Desktop container with no browser session, so it reads liveness
  // unauthenticated; without the Code counts it powered the guest down under a
  // long turn (bridge-wrapper/main.cjs's codeSessionActivity), which surfaced as
  // "the runner went offline; this turn was interrupted". Counts, not identity.
  const placed = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({
      title: "auth smoke",
      self_hosted_runner_pool_id: stored.pools[0].pool_id,
    }),
  });
  assert.equal(placed.status, 201, placed.body);
  const liveness = JSON.parse((await request("/api/health")).body);
  assert.equal(liveness.instance, undefined,
    "the liveness answer still names no instance");
  assert.ok(liveness.codeRunner, "liveness carries the Code counts the idle monitor reads");
  assert.equal(liveness.codeRunner.pending_sessions, 1,
    "a placed turn is visible to the unauthenticated idle monitor");
  assert.equal(liveness.codeRunner.active_sessions, 0);
  assert.equal(liveness.codeRunner.offered_sessions, 0);

  process.stdout.write("bridge-auth-smoke: tenant API gate passed\n");
} finally {
  const exits = children
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .map((child) => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      return exited;
    });
  await Promise.race([
    Promise.all(exits),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  for (const mock of servers) mock.close();
  rmSync(stateDir, { force: true, recursive: true, maxRetries: 20, retryDelay: 50 });
  if (createdRelease) rmSync(releaseFile, { force: true });
}
