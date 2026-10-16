import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";

// The pool API over the real HTTP surface: the other smokes drive the backend
// directly, so nothing there proves the bridge actually routes these paths, on a
// tenant only, with the refusals they promise. This boots the bridge twice —
// once as a tenant with runners on, once as the deployment's own instance — and
// asks both.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;

// The bridge reads release.json beside itself; the image provides it, a checkout
// keeps it in config/. Supply one for the run and take it away again.
const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));

const stateDir = mkdtempSync(join(tmpdir(), "code-runners-http-"));
const children = [];

// Read an SSE stream until it has carried `frames` client events (or it goes
// quiet), then drop the connection — the stream tails forever by design.
async function readStream(port, path, frames, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
      if (chunks.join("").split("event: client_event").length - 1 >= frames) break;
    }
  } catch {
    // Aborted once enough frames arrived, or the timeout fired; either way the
    // text collected so far is what the assertions read.
  }
  clearTimeout(timer);
  controller.abort();
  return chunks.join("");
}

async function boot({ port, env }) {
  const started = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      // Nothing is listening here: a request that reached for the auth service
      // or the Desktop fails loudly rather than quietly succeeding.
      AUTH_IDENTITY_URL: "http://127.0.0.1:9",
      COWORK_INTERNAL_URL: "http://127.0.0.1:9",
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
    return { status: response.status, type: response.headers.get("content-type") || "",
      body: await response.text() };
  };
}

try {
  // --- a tenant with self-hosted runners on --------------------------------
  const tenantPort = 8156;
  const tenantRequest = await boot({
    port: tenantPort,
    env: { CLAUDESK_TENANT: "1", CLAUDESK_CODE_RUNNERS: "1", CLAUDESK_CODE_RUNNER_POOL: "smoke-pool" },
  });

  // `/api/health` deliberately answers 503 while nothing answers at the Desktop
  // (the bridge must not claim to be serving one), so the pool routes are what
  // this smoke asks. `tenant` in the health payload is pinned by the other smoke.
  // The deployment named the pool, so it exists without anyone clicking.
  const pools = await tenantRequest("/v1/code/runners/self-hosted/pools");
  assert.equal(pools.status, 200, pools.body);
  const poolList = JSON.parse(pools.body);
  assert.equal(poolList.pools.length, 1);
  const poolId = poolList.pools[0].pool_id;
  assert.ok(poolId.startsWith("ccpool_"), "a pool id is ccpool_-prefixed");
  assert.equal(poolList.pools[0].secret, undefined, "the pool list never carries the secret");

  const environmentsPath =
    "/v1/environment_providers/private/organizations/00000000-0000-4000-8000-000000000000/environments";

  // Before a runner exists there is no place to offer — a tenant's list is
  // empty rather than holding a pool nothing polls.
  const early = JSON.parse((await tenantRequest(environmentsPath)).body);
  assert.deepEqual(early.environments, [],
    "an unclaimed pool is not advertised as a place a session can run");
  assert.deepEqual(JSON.parse((await tenantRequest("/v1/environments")).body).environments, [],
    "and the sheet's own leg says the same");

  // Registration is authenticated by the pool secret alone.
  const registered = await tenantRequest("/v1/code/runners/self-hosted/runners/register", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not-the-secret" },
    body: JSON.stringify({ runner_version: "2.1.295" }),
  });
  assert.equal(registered.status, 401, "a runner with the wrong secret is refused");

  const stored = JSON.parse(readFileSync(join(stateDir, "code-runners.json"), "utf8"));
  const secret = stored.pools[0].secret;
  const auth = { "content-type": "application/json", authorization: `Bearer ${secret}` };
  const accepted = await tenantRequest("/v1/code/runners/self-hosted/runners/register", {
    method: "POST", headers: auth,
    body: JSON.stringify({ runner_version: "2.1.295", use_anthropic_git_proxy: false }),
  });
  assert.equal(accepted.status, 200, accepted.body);
  assert.ok(JSON.parse(accepted.body).runner_id.startsWith("ccrunner_"));

  // With a runner registered the pool becomes a real place — and still the only
  // kind offered.
  const environmentList = JSON.parse((await tenantRequest(environmentsPath)).body);
  assert.equal(environmentList.environments.length, 1);
  assert.equal(environmentList.environments[0].kind, "byoc");
  assert.equal(environmentList.environments[0].environment_id, poolId);
  assert.ok(environmentList.environments.every((environment) => environment.kind === "byoc"),
    "a tenant is never offered a local environment");

  // The new-session sheet reads a *second* environments leg for its places —
  // `/v1/environments`, workspace-scoped — and answering only the provider one
  // left it reporting no local sessions and nothing else to offer.
  const placeList = JSON.parse((await tenantRequest("/v1/environments")).body);
  assert.deepEqual(placeList.environments.map((environment) => environment.environment_id),
    [poolId], "the sheet's own leg answers with the pool");
  assert.equal((await tenantRequest(`/v1/environments/${poolId}`)).status, 200);
  assert.equal((await tenantRequest("/v1/environments/no-such-pool")).status, 404);

  const polled = await tenantRequest("/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" });
  assert.equal(polled.status, 200, polled.body);
  assert.deepEqual(JSON.parse(polled.body).hints, [], "an empty pool offers no work");

  const anonymousPoll = await tenantRequest("/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymousPoll.status, 401, "an unauthenticated poll is refused");

  // Placing a session over HTTP, then watching the same runner be offered it:
  // the dispatch chain the tenant's Code surface rides.
  const placed = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "from the smoke", environment_id: poolId,
      config: { sources: [{ type: "git_repository", url: "https://example.invalid/r.git", revision: "refs/heads/main" }] } }),
  });
  assert.equal(placed.status, 201, placed.body);
  const placedSession = JSON.parse(placed.body).session;
  assert.equal(placedSession.status, "pending");
  assert.equal(placedSession.environment_id, poolId);

  // The list the surface reads on every open — it was 404ing, four times a load.
  const listed = await tenantRequest("/v1/code/sessions");
  assert.equal(listed.status, 200, listed.body);
  const listBody = JSON.parse(listed.body);
  assert.equal(listBody.data.length, 1);
  assert.equal(listBody.data[0].id, placedSession.id);
  assert.deepEqual(listBody.data[0].tags, [], "a row carries the tags the reader filters on");
  assert.equal(listBody.has_more, false);
  assert.equal(listBody.last_id, placedSession.id, "the pager resumes from last_id");

  const detail = await tenantRequest(`/v1/code/sessions/${placedSession.id}`);
  assert.equal(detail.status, 200, detail.body);
  assert.equal(JSON.parse(detail.body).session.title, "from the smoke");

  const offered = await tenantRequest("/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" });
  const hints = JSON.parse(offered.body).hints;
  assert.ok(hints.some((hint) => hint.session_uuid === placedSession.id),
    "the pool's runner is offered the session just placed");

  // The session's events over HTTP, in the app's own contract (checked with the
  // in-tree model), and the SSE stream the Desktop main process reads.
  const appended = await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [
      { payload: { type: "user", message: { role: "user", content: "over http" } } },
      { payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } },
    ] }),
  });
  assert.equal(appended.status, 200, appended.body);
  assert.equal(JSON.parse(appended.body).data.length, 2);

  const history = await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`);
  assert.equal(history.status, 200, history.body);
  const decoded = decodeClientEventsResponse(JSON.parse(history.body));
  assert.equal(decoded.length, 2, "the history satisfies the app's envelope contract");
  assert.equal(decoded[0].sequence, 1n);

  const resumed = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?after_sequence_num=1`);
  assert.equal(JSON.parse(resumed.body).data.length, 1, "after_sequence_num resumes");

  // The stream replays the history as `client_event` frames, then tails it.
  const frames = await readStream(tenantPort, `/v1/code/sessions/${placedSession.id}/events/stream`, 2);
  assert.ok(frames.includes("event: client_event"), "the stream names its frames client_event");
  const streamed = frames.split("event: client_event").slice(1)
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6).split("\n")[0]));
  assert.deepEqual(streamed.map((event) => event.sequence_num), ["1", "2"],
    "the stream replays the history in order");
  assert.equal(decodeClientEventsResponse({ data: streamed }).length, 2);

  // A session for an environment this instance does not run is refused, not
  // quietly run locally.
  const elsewhere = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment_id: "00000000-0000-4000-8000-000000000000" }),
  });
  assert.equal(elsewhere.status, 400, elsewhere.body);

  // --- the deployment's own instance --------------------------------------
  const ownerPort = 8157;
  const ownerRequest = await boot({ port: ownerPort, env: { CLAUDESK_TENANT: "0" } });

  // Without the tenant flag the pool API is not routed at all: the request falls
  // through to the app, so it must not answer a pool document.
  const ownerPools = await ownerRequest("/v1/code/runners/self-hosted/pools");
  assert.equal(ownerPools.body.includes("\"pools\""), false,
    "the operator's instance must not serve the self-hosted pool API");
} finally {
  for (const child of children) child.kill("SIGTERM");
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(stateDir, { recursive: true, force: true });
}

process.stdout.write("code-runners-http-smoke: the pool API is routed for a tenant and nobody else\n");
