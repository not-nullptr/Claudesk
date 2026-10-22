import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
let gateway = null;
let tenantWorkspace = null;
let internalWrapper = null;

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
      // This smoke drives the pool/environment routes as the browser would;
      // the tenant API gate has its own smoke (bridge-auth-smoke.mjs).
      CLAUDESK_BRIDGE_AUTH: "0",
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
  // The account's gateway, stood in for: the bridge forwards the runner's model
  // calls to it, so the smoke records what arrived and answers in wire shapes.
  const gatewayHits = [];
  gateway = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      gatewayHits.push({
        url: request.url,
        authorization: request.headers.authorization || "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.url.startsWith("/v1/models")) {
        // The prefixed route the chain serves; the bare alias the app probes
        // is what the bridge has to resolve to it.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [{ id: "anthropic/claude-opus-5-5" }],
          has_more: false,
        }));
      } else if (request.url === "/v1/messages") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
        response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 3 }));
      }
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;

  // The account workspace the create validation confines a session's folder to.
  tenantWorkspace = mkdtempSync(join(tmpdir(), "code-runners-workspace-"));
  mkdirSync(join(tenantWorkspace, "repo"), { recursive: true });

  const tenantPort = 8156;
  const tenantRequest = await boot({
    port: tenantPort,
    env: {
      CLAUDESK_TENANT: "1", CLAUDESK_CODE_RUNNERS: "1", CLAUDESK_CODE_RUNNER_POOL: "smoke-pool",
      CLAUDE_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      CLAUDE_GATEWAY_API_KEY: "smoke-gateway-key",
      COWORK_REMOTE_WORKSPACE_ROOT: tenantWorkspace,
    },
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

  // The pool is the tenant's place from the moment it exists — placing a
  // session wakes the VM — so a fresh account sees it before any runner polls.
  const early = JSON.parse((await tenantRequest(environmentsPath)).body);
  assert.equal(early.environments.length, 1,
    "the instance's pool is advertised before a runner claims it");
  assert.equal(early.environments[0].environment_id, poolId);
  assert.equal(early.environments[0].state, "active");
  assert.deepEqual(JSON.parse((await tenantRequest("/v1/environments")).body).environments,
    early.environments, "and the sheet's own leg says the same");

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
  // the dispatch chain the tenant's Code surface rides. The body is the
  // renderer's own serializer's shape — a pool worker names its place with
  // `self_hosted_runner_pool_id` — and the document reads in the app's
  // vocabulary (`active`, no worker status → its normalizer paints pending).
  const placed = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "from the smoke", self_hosted_runner_pool_id: poolId,
      config: { sources: [{ type: "git_repository", url: "https://example.invalid/r.git", revision: "refs/heads/main" }] } }),
  });
  assert.equal(placed.status, 201, placed.body);
  const placedSession = JSON.parse(placed.body).session;
  assert.equal(placedSession.status, "active");
  assert.equal(placedSession.worker_status, undefined);
  assert.equal(placedSession.environment_id, poolId);
  assert.equal(placedSession.self_hosted_runner_pool_id, poolId);
  assert.equal(placedSession.self_hosted_runner_state.pool_name, "smoke-pool");

  // The list the surface reads on every open — it was 404ing, four times a load.
  const listed = await tenantRequest("/v1/code/sessions");
  assert.equal(listed.status, 200, listed.body);
  const listBody = JSON.parse(listed.body);
  assert.equal(listBody.data.length, 1);
  assert.equal(listBody.data[0].id, placedSession.id);
  assert.deepEqual(listBody.data[0].tags, [], "a row carries the tags the reader filters on");
  assert.equal(listBody.has_more, false);
  assert.equal(listBody.last_id, placedSession.id, "the pager resumes from last_id");

  // The chat recents' own list request (shared-2's remote-cowork read): the
  // tag must narrow the page, or the Code row it just placed is painted as a
  // Chat row. This is the exact URL the renderer composes.
  const remoteCoworkList = await tenantRequest(
    "/v1/code/sessions?tags=cowork-remote&include_trigger_sessions=true&limit=100");
  assert.equal(remoteCoworkList.status, 200, remoteCoworkList.body);
  assert.deepEqual(JSON.parse(remoteCoworkList.body).data, [],
    "the remote-cowork list carries no untagged Code row");

  const detail = await tenantRequest(`/v1/code/sessions/${placedSession.id}`);
  assert.equal(detail.status, 200, detail.body);
  assert.equal(JSON.parse(detail.body).session.title, "from the smoke");

  // The composer places the session and posts the first message as two
  // requests. Nothing is offered in between: a runner claiming the empty
  // transcript reported "the session's transcript carries no user message to
  // answer" for a turn that had not been sent yet.
  const unprompted = JSON.parse((await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "placed, not sent yet", environment_id: poolId }),
  })).body).session;
  let waiting = JSON.parse((await tenantRequest(
    "/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" })).body).hints;
  assert.equal(waiting.some((hint) => hint.session_uuid === placedSession.id), false,
    "a placed session is not offered before its first message");
  assert.equal(waiting.some((hint) => hint.session_uuid === unprompted.id), false,
    "and neither is a session that has none at all");
  await tenantRequest(`/v1/code/sessions/${unprompted.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGk=" },
      }] } } }] }),
  });
  waiting = JSON.parse((await tenantRequest(
    "/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" })).body).hints;
  assert.ok(waiting.some((hint) => hint.session_uuid === unprompted.id),
    "an image-only send is a prompt, and wakes the held poll");

  // A staged attachment arrives beside the message (`staged_files`), not in
  // its text, and a file-only send has no text at all. The bridge must store
  // the reminder the guest agent reads, or the attachment is staged but
  // invisible — and the turn has nothing to answer. Paths outside the shared
  // workspace never enter the transcript.
  await tenantRequest(`/v1/code/sessions/${unprompted.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [
      { payload: { type: "user", message: { role: "user", content: "" },
        staged_files: [{ file_name: "fig-file.zip",
          mount_path: "/workspace/.claudesk-attachments/cse_abc/fig-file.zip" }] } },
      { payload: { type: "user", message: { role: "user", content: "" },
        staged_files: [{ file_name: "host-file", mount_path: "/etc/passwd" }] } },
    ] }),
  });
  const stagedHistory = JSON.parse((await tenantRequest(
    `/v1/code/sessions/${unprompted.id}/events`)).body).data;
  const reminders = stagedHistory.filter((event) =>
    typeof event.payload?.message?.content === "string"
    && event.payload.message.content.includes("<uploaded_files>"));
  assert.equal(reminders.length, 1, "exactly the workspace path is announced");
  assert.match(reminders[0].payload.message.content,
    /<file_path>\/workspace\/\.claudesk-attachments\/cse_abc\/fig-file\.zip<\/file_path>/);
  assert.equal(reminders[0].payload.message.content.includes("/etc/passwd"), false,
    "a staged path outside the workspace is never handed to the agent");

  // The send that completes the placed session.
  await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "over http" } } }] }),
  });
  const offered = await tenantRequest("/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" });
  const hints = JSON.parse(offered.body).hints;
  assert.ok(hints.some((hint) => hint.session_uuid === placedSession.id),
    "the pool's runner is offered the session once its message lands");

  // A runner that says how long it is willing to wait gets an empty poll held
  // open until work appears: the placement wakes it on that same request, so
  // pickup is immediate instead of "on the next tick". Opt-in by header — a
  // caller that asks nothing still gets the prompt answer above.
  const holdStartedAt = Date.now();
  const heldPoll = tenantRequest("/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: { ...auth, "x-claudesk-poll-wait": "5" }, body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const latePlaced = JSON.parse((await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A routine fire carries its prompt in the create body; that is a session
    // the pool may take at once, unlike a composer placement.
    body: JSON.stringify({ title: "woken by the hold", environment_id: poolId,
      events: [{ payload: { type: "user",
        message: { role: "user", content: "routine prompt" } } }] }),
  })).body).session;
  const woken = JSON.parse((await heldPoll).body);
  assert.ok(Date.now() - holdStartedAt < 2000,
    "the held poll answered as soon as the session was placed");
  assert.ok(woken.hints.some((hint) => hint.session_uuid === latePlaced.id),
    "and carried the new session on the same request");

  // The session's events over HTTP, in the app's own contract (checked with the
  // in-tree model), and the SSE stream the Desktop main process reads.
  const appended = await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [
      { payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } },
    ] }),
  });
  assert.equal(appended.status, 200, appended.body);
  assert.equal(JSON.parse(appended.body).data.length, 1,
    "the transcript already holds the user's message from the send above");

  const history = await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`);
  assert.equal(history.status, 200, history.body);
  const decoded = decodeClientEventsResponse(JSON.parse(history.body));
  assert.equal(decoded.length, 2, "the history satisfies the app's envelope contract");
  assert.equal(decoded[0].sequence, 1n);

  const resumed = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?after_sequence_num=1`);
  assert.equal(JSON.parse(resumed.body).data.length, 1, "after_sequence_num resumes");

  // The renderer's pager uses `cursor` with either sort. Both directions must
  // move the window — the full-transcript walk (ascending) and the scrollback
  // read (newest first) — or the transcript stops at the first page.
  const newestPage = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?sort_order=desc&limit=1`);
  const newest = JSON.parse(newestPage.body);
  assert.deepEqual(newest.data.map((event) => event.sequence_num), ["2"]);
  assert.equal(newest.next_cursor, "2", "a newest-first page points at its oldest event");
  const olderPage = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?sort_order=desc&limit=1&cursor=2`);
  const older = JSON.parse(olderPage.body);
  assert.deepEqual(older.data.map((event) => event.sequence_num), ["1"],
    "a newest-first cursor resumes below the page edge");
  assert.equal(older.next_cursor, null);
  const firstAsc = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?sort_order=asc&limit=1`);
  const oldest = JSON.parse(firstAsc.body);
  assert.equal(oldest.next_cursor, "1");
  const continued = await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events?sort_order=asc&limit=1&cursor=1`);
  assert.deepEqual(JSON.parse(continued.body).data.map((event) => event.sequence_num), ["2"],
    "an ascending cursor resumes above the page edge");
  assert.equal(
    (await tenantRequest(`/v1/code/sessions/${placedSession.id}/events?cursor=bogus`)).status,
    400, "a cursor that is not a sequence is refused rather than ignored");

  // The stream replays the history as `client_event` frames, then tails it.
  const frames = await readStream(tenantPort, `/v1/code/sessions/${placedSession.id}/events/stream`, 2);
  assert.ok(frames.includes("event: client_event"), "the stream names its frames client_event");
  const streamed = frames.split("event: client_event").slice(1)
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6).split("\n")[0]));
  assert.deepEqual(streamed.map((event) => event.sequence_num), ["1", "2"],
    "the stream replays the history in order");
  assert.equal(decodeClientEventsResponse({ data: streamed }).length, 2);

  // The stream opens with the connection frame its reader gates on (the same
  // contract the phone's facade carries — without it the page says
  // "Connecting…" forever, however many events arrive), and every transcript
  // frame carries its sequence as the SSE `id:` — the cursor the reader
  // resumes from. A frame without one cannot advance it, which is what left
  // rows unplaced.
  assert.ok(frames.startsWith("event: session_update\n"),
    "the stream opens with session_update, before the history");
  assert.match(frames, /event: session_update\ndata: \{"connection_status":"connected"\}\n\n/);
  assert.ok(frames.includes("id: 1\nevent: client_event"), "frames carry their sequence as the SSE id");
  assert.ok(frames.includes("id: 2\nevent: client_event"));

  // Token-level stream events are live transport, not history. An open stream
  // receives one as it is appended; a later read of the transcript does not,
  // which is what keeps a reload (and the bridge's heap) proportional to the
  // conversation rather than to every delta the model ever emitted.
  const liveFrames = readStream(
    tenantPort, `/v1/code/sessions/${placedSession.id}/events/stream`, 3);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const partial = await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "li" } } } }] }),
  });
  assert.equal(partial.status, 200, partial.body);
  const liveText = await liveFrames;
  assert.ok(liveText.includes('"type":"stream_event"'),
    "a partial reaches the open stream immediately");
  const afterPartial = JSON.parse(
    (await tenantRequest(`/v1/code/sessions/${placedSession.id}/events`)).body);
  assert.deepEqual(afterPartial.data.map((event) => event.sequence_num), ["1", "2"],
    "the live-only partial is never written to the transcript");

  // A stream for a session that does not exist yet opens empty rather than
  // 404ing — the app opens it to receive the turn it is about to send, and a
  // 404 here is the "Connecting" loop.
  const unknownStream = await readStream(tenantPort,
    "/v1/code/sessions/cse_ffffffffffff_01111111111111111111111111/events/stream", 0, 1500);
  assert.ok(unknownStream.startsWith("event: session_update\ndata: {\"connection_status\":\"connected\"}\n\n"),
    "an unknown session's stream opens empty, not 404");

  // Who wrote an event rides the envelope: the renderer's `client`, the
  // runner's `worker`. The readers route on it — a user-shaped frame is
  // dropped unless its source is `worker` (a tool result must not read as a
  // human message), and a client echo is held out of the transcript until the
  // server reports it processed.
  assert.deepEqual(JSON.parse(history.body).data.map((event) => event.source),
    ["client", "client"], "the renderer's writes are marked as client events");

  // The send acknowledgement: a runner taking the session is what "processed"
  // means on the wire. The client message the turn answers is stamped
  // `processing_at`, and the stream carries a `delivery_update` naming it —
  // the frame the page clears its "Sending…" state on, and the one that
  // releases the held echo of the user's own message into the transcript.
  const taken = await tenantRequest(
    `/v1/code/runners/self-hosted/sessions/${placedSession.id}/token`,
    { method: "POST", headers: auth, body: "{}" });
  assert.equal(taken.status, 200, taken.body);
  const afterTake = JSON.parse((await tenantRequest(
    `/v1/code/sessions/${placedSession.id}/events`)).body).data;
  const userEvent = afterTake.find((event) => event.payload.type === "user");
  assert.equal(typeof userEvent.processing_at, "string",
    "the message the turn answers is stamped as processed");
  assert.equal(afterTake.find((event) => event.payload.type === "assistant").processing_at,
    undefined, "the assistant's own rows are not client messages");
  const deliveryFrames = await readStream(tenantPort,
    `/v1/code/sessions/${placedSession.id}/events/stream`, 0, 1500);
  assert.match(deliveryFrames,
    /event: delivery_update\ndata: \{"event_id":"[0-9a-f-]{36}","status":"PROCESSING","timestamp":"[^"]+"\}\n\n/,
    "the stream acknowledges the client event, which clears the composer's Sending state");

  // Stop, over the REST spelling the mobile facade and routine cancel use. The
  // Code surface posts a control request through the events leg instead (pinned
  // in the backend smoke); both must reach the runner that is holding the turn.
  const interrupted = await tenantRequest(`/v1/code/sessions/${placedSession.id}/interrupt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(interrupted.status, 200, interrupted.body);
  const cancelledPoll = await tenantRequest(
    "/v1/code/runners/self-hosted/spawn-hints/poll",
    { method: "POST", headers: auth, body: "{}" });
  assert.ok(JSON.parse(cancelledPoll.body).cancellations
    .some((entry) => entry.session_uuid === placedSession.id),
  "the poll the guest runner is holding names the session to stop");
  // Idempotent: the button is pressed exactly when a turn is believed live.
  assert.equal((await tenantRequest(`/v1/code/sessions/${placedSession.id}/stop`, {
    method: "POST", body: "{}",
  })).status, 200, "stop is the same leg, and a second stop is still fine");
  assert.equal((await tenantRequest("/v1/code/sessions/no-such-session/interrupt", {
    method: "POST", body: "{}",
  })).status, 404, "an unknown session is a 404, not a silent success");

  // A session for an environment this instance does not run is refused, not
  // quietly run locally.
  const elsewhere = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment_id: "00000000-0000-4000-8000-000000000000" }),
  });
  assert.equal(elsewhere.status, 400, elsewhere.body);

  // The original (v1) events leg: what the renderer actually sends its first
  // message over when its `ccr_v2_send_events_web` gate reads false — which is
  // what the Desktop build's hardcoded feature table carries. Before this leg
  // was answered the POST landed on the app-HTML catch-all (a 200 of HTML),
  // which the client's API layer classifies as "Service temporarily
  // unreachable". Both generations write one log.
  const v1Append = await tenantRequest(`/v1/sessions/${placedSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "sent over the v1 leg" } } }] }),
  });
  assert.equal(v1Append.status, 200, v1Append.body);
  // 3 was the live-only partial above: durable and volatile events share one
  // counter, so a reader's cursor never moves backwards.
  assert.equal(JSON.parse(v1Append.body).data[0].sequence_num, "4");
  const v1History = JSON.parse((await tenantRequest(`/v1/sessions/${placedSession.id}/events`)).body);
  assert.equal(decodeClientEventsResponse(v1History).length, 3,
    "both events legs read and write one log");

  // An API-shaped path with no route answers the API's own envelope — never the
  // app's HTML page, which a JSON reader classifies as an upstream failure.
  const unknownV1 = await tenantRequest("/v1/code/no-such-thing", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(unknownV1.status, 404, unknownV1.body);
  assert.ok(unknownV1.type.includes("json"), `expected JSON, got ${unknownV1.type}`);
  assert.equal(unknownV1.body.includes("<!doctype"), false,
    "an API path never gets the app HTML");

  // The runner's model calls, over the one address the guest is certain to
  // reach: refused without the pool secret, forwarded verbatim with it, with
  // the account's own gateway credential attached by the bridge.
  const anonymousModel = await tenantRequest("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(anonymousModel.status, 401, "a model call without the pool secret is refused");

  const modelCall = await tenantRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`,
      "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      // The auto-mode classifier's fallback id carries the long-context
      // spelling; the gateway route it names does not.
      model: "smoke[1m]", messages: [],
      thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
      context_management: { edits: [] },
    }),
  });
  assert.equal(modelCall.status, 200, modelCall.body);
  assert.ok(modelCall.type.includes("text/event-stream"), modelCall.type);
  assert.ok(modelCall.body.includes("message_stop"), "the stream passes through untouched");
  assert.equal(gatewayHits.at(-1).authorization, "Bearer smoke-gateway-key",
    "the account's own gateway credential is attached by the bridge");
  // The chain cannot carry the newest fields to the provider (it drops the
  // beta headers that would enable them), so the bridge normalizes them away —
  // and the rest of the body survives that surgery.
  const forwarded = JSON.parse(gatewayHits.at(-1).body);
  assert.equal(forwarded.thinking.display, undefined,
    "thinking.display is dropped for the gateway");
  assert.equal(forwarded.thinking.type, "enabled", "the rest of thinking survives");
  assert.equal("context_management" in forwarded, false,
    "context_management is dropped for the gateway");
  assert.equal(forwarded.model, "smoke",
    "the long-context spelling resolves to the route the gateway serves");

  const tokenCount = await tenantRequest("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "smoke", messages: [] }),
  });
  assert.equal(JSON.parse(tokenCount.body).input_tokens, 3, "count_tokens is forwarded too");
  assert.equal(gatewayHits.at(-1).url, "/v1/messages/count_tokens", "the path is preserved");
  assert.equal(JSON.parse(gatewayHits.at(-1).body).model, "smoke",
    "an id without the spelling is forwarded untouched");

  // A gateway can advertise an Anthropic-family alias the provider-prefixed
  // route actually serves (the chain lists `claude-opus-5-5` under
  // `/v1/models?limit=1000`, but `/v1/messages` only routes
  // `anthropic/claude-opus-5-5`). Resolve the bare alias to the one listed
  // route, so a model pick or the health probe's fallback does not fail.
  const aliasCall = await tenantRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`,
      "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-5-5[1m]", messages: [] }),
  });
  assert.equal(aliasCall.status, 200, aliasCall.body);
  assert.equal(JSON.parse(gatewayHits.at(-1).body).model, "anthropic/claude-opus-5-5",
    "the bare alias resolves to the provider-prefixed route the gateway lists");
  const modelListHit = gatewayHits.find((hit) => hit.url.startsWith("/v1/models"));
  assert.ok(modelListHit, "the bridge read the gateway's model list once");
  assert.equal(modelListHit.authorization, "Bearer smoke-gateway-key",
    "and authenticated it with the account's own gateway credential");

  // The org's environment capabilities — asked for wherever a session can be
  // placed, and parsed strictly: `version` and `repositories` are required and
  // `absent`/`unreadable` are read unconditionally.
  const capabilities = await tenantRequest(
    "/v1/environment_providers/private/organizations/00000000-0000-4000-8000-000000000000/capabilities");
  assert.equal(capabilities.status, 200, capabilities.body);
  const provider = JSON.parse(capabilities.body);
  assert.equal(provider.version, 1);
  assert.deepEqual(provider.repositories, []);
  assert.deepEqual(provider.absent, []);
  assert.deepEqual(provider.unreadable, []);
  assert.deepEqual(provider.session_files, { upload: true, download: true });
  assert.equal(provider.vcs.push, false, "nothing here pushes the runner's checkout anywhere");
  // With selfHostedSessions declared, the renderer's Code frame reads the
  // Routines capability from this document; without it the nav entry and the
  // `/code/routines` route are filtered out before any gate is consulted.
  assert.equal(provider.routines.enabled, true,
    "the instance declares the routine surface it serves");
  assert.equal(provider.routines.delete_removes_runs, true,
    "deleting a routine is also the end of its runs");
  assert.equal(provider.routines.persist_session, false,
    "a fire starts a fresh session rather than resuming one");

  // The session's edit legs — the calls the Code page makes once a session
  // exists. Rename/tags/metadata arrive through one PUT; archive, mark_read
  // and the MCP editor's save are their own POST/PUT; delete is a DELETE.
  const renamed = await tenantRequest(`/v1/code/sessions/${placedSession.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "renamed over http", add_tags: ["smoke"],
      client_metadata: { last_seen_cwd: "/workspace" } }),
  });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal(JSON.parse(renamed.body).session.title, "renamed over http");
  assert.deepEqual(JSON.parse(renamed.body).session.tags, ["smoke"]);
  assert.equal(JSON.parse(renamed.body).session.client_metadata.last_seen_cwd, "/workspace");

  const markedRead = await tenantRequest(`/v1/code/sessions/${placedSession.id}/mark_read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_id: "1" }),
  });
  assert.equal(markedRead.status, 200, markedRead.body);
  assert.equal(JSON.parse(markedRead.body).session.id, placedSession.id);

  const mcpSaved = await tenantRequest(`/v1/code/sessions/${placedSession.id}/mcp-servers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mcp_servers: [] }),
  });
  assert.equal(mcpSaved.status, 200, mcpSaved.body);

  const heartbeat = await tenantRequest("/v1/code/sessions/heartbeat_check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_ids: [placedSession.id] }),
  });
  assert.deepEqual(JSON.parse(heartbeat.body), { results: [], checks_enabled: false },
    "the heartbeat probe declines the protocol rather than pretending to check");

  // The session list's own stream: held open, quiet, carrying the content type
  // its reader requires (it treats a 400/404 here as fatal for the surface).
  const watchController = new AbortController();
  const watchTimer = setTimeout(() => watchController.abort(), 5000);
  const watchResponse = await fetch(
    `http://127.0.0.1:${tenantPort}/v1/code/sessions/watch?exclude_tags=-`,
    { headers: { accept: "text/event-stream" }, signal: watchController.signal });
  assert.equal(watchResponse.status, 200);
  assert.match(watchResponse.headers.get("content-type") || "", /text\/event-stream/,
    "the watch stream must carry the content type its reader requires");
  let watchHead = "";
  for await (const chunk of watchResponse.body) {
    watchHead += Buffer.from(chunk).toString("utf8");
    if (watchHead.includes(": connected")) break;
  }
  clearTimeout(watchTimer);
  watchController.abort();
  assert.ok(watchHead.includes(": connected"), "and it opens with a comment frame");

  // Title generation — the custom-3p stubs the Desktop main answers in-process,
  // served here too because a browser page fetches its own origin, never
  // through that process.
  const titleAndBranch = await tenantRequest(
    "/api/organizations/00000000-0000-4000-8000-000000000001/dust/generate_title_and_branch",
    { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ first_session_message: "Add a dark mode toggle to the settings page, with tests",
        title_style: "default" }) });
  assert.equal(titleAndBranch.status, 200, titleAndBranch.body);
  const naming = JSON.parse(titleAndBranch.body);
  assert.equal(naming.title, "Add a dark mode toggle to the settings page, with tests");
  assert.equal(naming.branch_name, "add-a-dark-mode-toggle-to-the-settings-page-with",
    "the branch is the title's slug, capped");
  const sessionTitle = await tenantRequest(
    "/api/organizations/00000000-0000-4000-8000-000000000001/dust/generate_session_title",
    { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ first_session_message: "## Fix the flaky test\nand more" }) });
  assert.equal(JSON.parse(sessionTitle.body).title, "Fix the flaky test",
    "a markdown heading is stripped for the title");
  const commandNames = await tenantRequest(
    "/api/organizations/00000000-0000-4000-8000-000000000001/dust/command_display_names",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.deepEqual(JSON.parse(commandNames.body), { results: [] });

  const archived = await tenantRequest(`/v1/code/sessions/${placedSession.id}/archive`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(archived.status, 200, archived.body);
  assert.equal(JSON.parse(archived.body).session.status, "archived");
  const activeList = JSON.parse((await tenantRequest("/v1/code/sessions?statuses=active&statuses=paused")).body);
  assert.equal(activeList.data.some((row) => row.id === placedSession.id), false,
    "an archived session leaves the default list");
  const archivedList = JSON.parse((await tenantRequest("/v1/code/sessions?statuses=archived")).body);
  assert.equal(archivedList.data.some((row) => row.id === placedSession.id), true);

  const deleted = await tenantRequest(`/v1/code/sessions/${placedSession.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal((await tenantRequest(`/v1/code/sessions/${placedSession.id}`)).status, 404,
    "a deleted session is gone");

  // Start options: a self-hosted session can name the folder, branch and
  // worktree the guest runner must honour. The create document echoes them, and
  // a folder outside the account workspace is refused before it reaches the
  // runner.
  const withOptions = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "with start options", environment_id: poolId,
      config: { cwd: join(tenantWorkspace, "repo"), source_branch: "feature",
        use_worktree: true } }),
  });
  assert.equal(withOptions.status, 201, withOptions.body);
  const startOptionsDoc = JSON.parse(withOptions.body).session;
  assert.equal(startOptionsDoc.config.cwd, join(tenantWorkspace, "repo"),
    "the session echoes the chosen folder");
  assert.equal(startOptionsDoc.config.source_branch, "feature",
    "the session echoes the chosen branch");
  assert.equal(startOptionsDoc.config.use_worktree, true,
    "the session echoes the worktree flag");

  const outside = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "outside", environment_id: poolId,
      config: { cwd: "/etc" } }),
  });
  assert.equal(outside.status, 400, outside.body);
  const missing = await tenantRequest("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "missing", environment_id: poolId,
      config: { cwd: join(tenantWorkspace, "missing") } }),
  });
  assert.equal(missing.status, 400, "a folder that does not exist is refused");

  // --- the deployment's own instance --------------------------------------
  // --- the admin dashboard's instance actions ------------------------------
  // authd calls these over the deployment network; the bridge forwards them to
  // the Desktop wrapper. A shared secret is the pass, and the family is closed
  // without it (the reverse proxy never forwards /internal/*, but gateway_net
  // is shared with the gateway stack).
  const wrapperHits = [];
  internalWrapper = http.createServer((request, response) => {
    wrapperHits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      value: {
        running: request.url === "/vm/status",
        pid: 4242,
        reason: "idle",
        started: request.url === "/vm/restart",
      },
    }));
  });
  await new Promise((resolve) => internalWrapper.listen(0, "127.0.0.1", resolve));
  const internalPort = 8155;
  const internalRequest = await boot({
    port: internalPort,
    env: {
      CLAUDESK_TENANT: "1",
      CLAUDESK_INTERNAL_SECRET: "smoke-secret",
      COWORK_INTERNAL_URL: `http://127.0.0.1:${internalWrapper.address().port}`,
    },
  });
  const internalAuth = { "x-claudesk-internal-secret": "smoke-secret" };
  const noSecret = await internalRequest("/internal/vm/status");
  assert.equal(noSecret.status, 404, "the internal family is closed without the secret");
  const wrongSecret = await internalRequest("/internal/vm/status", {
    headers: { "x-claudesk-internal-secret": "not-the-secret" },
  });
  assert.equal(wrongSecret.status, 404, "a wrong secret is indistinguishable from no route");
  const status = await internalRequest("/internal/vm/status", { headers: internalAuth });
  assert.equal(status.status, 200, status.body);
  assert.equal(JSON.parse(status.body).value.pid, 4242,
    "the wrapper's status is passed through");
  const restart = await internalRequest("/internal/vm/restart", {
    method: "POST", headers: { ...internalAuth, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(restart.status, 200, restart.body);
  assert.equal(JSON.parse(restart.body).value.started, true,
    "the restart action reaches the wrapper");
  assert.deepEqual(wrapperHits, ["GET /vm/status", "POST /vm/restart"],
    "only the two VM actions are proxied, method for method");
  const wrongMethod = await internalRequest("/internal/vm/status", {
    method: "POST", headers: internalAuth,
  });
  assert.equal(wrongMethod.status, 404, "an action answers only its own method");

  const ownerPort = 8157;
  const ownerRequest = await boot({ port: ownerPort, env: { CLAUDESK_TENANT: "0" } });

  // Without the tenant flag the pool API is not routed at all: the request falls
  // through to the app, so it must not answer a pool document.
  const ownerPools = await ownerRequest("/v1/code/runners/self-hosted/pools");
  assert.equal(ownerPools.body.includes("\"pools\""), false,
    "the operator's instance must not serve the self-hosted pool API");
  const ownerModel = await ownerRequest("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(ownerModel.status, 404,
    "and the model passthrough belongs to a tenant with runners, not to it");
} finally {
  for (const child of children) child.kill("SIGTERM");
  if (internalWrapper !== null) {
    internalWrapper.closeAllConnections?.();
    internalWrapper.close();
  }
  if (gateway !== null) {
    // The bridges keep their upstream connection to the stub alive; close
    // those too or `close()` waits on them and the smoke never finishes.
    gateway.closeAllConnections?.();
    gateway.close();
  }
  // A bridge shutting down writes one last notice into the state dir; give it
  // a beat before the dir goes, or the rm runs against a racing write.
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (tenantWorkspace) rmSync(tenantWorkspace, { recursive: true, force: true });
}

process.stdout.write("code-runners-http-smoke: the pool API is routed for a tenant and nobody else\n");
