import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { createRunnerBackend, poolEnvironment } from "../bridge/code-runners.mjs";
import { decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

// The runner substrate a tenant's Code uses instead of its own container: a
// self-hosted pool the Claude Code runner registers with and polls, and the
// `byoc` environment the Code surface offers. The wire shapes come from the
// runner client in the Claude Code binary; this pins the ones we answer.
const stateDir = await mkdtemp(join(tmpdir(), "code-runners-"));
const log = { log() {} };

try {
  const backend = createRunnerBackend({ stateDir, log, poolName: "dev-box" });

  // The deployment names the pool, so a runner can be pointed at it without
  // anyone clicking through the admin UI.
  const primary = await backend.primaryPool();
  assert.ok(primary?.pool_id?.startsWith("ccpool_"), "the named pool exists and is ccpool_-prefixed");
  assert.ok(primary.secret.length > 20, "the pool has a minted secret");
  assert.equal(primary.name, "dev-box");

  const auth = { authorization: `Bearer ${primary.secret}` };
  const wrong = { authorization: "Bearer not-the-secret" };

  // Nothing is advertised until a runner exists: a pool the bridge minted at
  // start-up is not a place anything can run yet, and offering it would let a
  // session be placed where nothing polls.
  assert.deepEqual((await backend.environmentList()).environments, [],
    "a pool with no runner is not offered as a place");
  assert.equal((await backend.environment(primary.pool_id)).state, "unknown");

  // No secret, or the wrong one, is the same answer: no pool.
  assert.equal((await backend.registerRunner({ headers: {}, body: {} })).unauthorized, true,
    "register without a secret is unauthorized");
  assert.equal((await backend.registerRunner({ headers: wrong, body: {} })).unauthorized, true,
    "register with the wrong secret is unauthorized");

  const registered = await backend.registerRunner({
    headers: auth,
    body: { runner_version: "2.1.295", use_anthropic_git_proxy: false },
  });
  assert.ok(registered.runner_id.startsWith("ccrunner_"), "register answers a runner_id");

  // A pool with nothing queued hands out no work.
  let polled = await backend.pollSpawnHints({ headers: auth });
  assert.deepEqual(polled.hints, [], "an empty pool answers no hints");
  assert.equal(polled.pending_count, 0);
  assert.equal(polled.pool_active_session_count, 0);

  // A queued session is offered exactly once, in the shape the runner's reader
  // requires (session_uuid, attempt, work_order_jwt, sources — all present).
  const queued = await backend.queueSession({ poolId: primary.pool_id, sessionUuid: "session-1" });
  assert.equal(queued.session_uuid, "session-1");
  assert.equal(queued.attempt, 1);
  assert.ok(queued.work_order_jwt.length > 20, "the order carries a work_order_jwt");
  assert.deepEqual(queued.sources, []);

  polled = await backend.pollSpawnHints({ headers: auth });
  assert.equal(polled.hints.length, 1, "the queued session is offered");
  assert.deepEqual(
    Object.keys(polled.hints[0]).sort(),
    ["attempt", "session_uuid", "sources", "work_order_jwt"],
    "a hint carries exactly the fields the runner reads",
  );
  assert.equal(polled.hints[0].session_uuid, "session-1");

  polled = await backend.pollSpawnHints({ headers: auth });
  assert.equal(polled.hints.length, 0, "an offered session is not handed out twice");

  // A nack puts it back with the attempt bumped — the runner's retry signal.
  await backend.nackSpawnHint({ headers: auth, body: { session_uuid: "session-1", attempt: 1 } });
  polled = await backend.pollSpawnHints({ headers: auth });
  assert.equal(polled.hints.length, 1, "a nacked session is offered again");
  assert.equal(polled.hints[0].attempt, 2, "the attempt is bumped on a nack");

  // The admin UI reads the secret back by pool id, not from the list.
  const secrets = await backend.poolSecrets({ poolId: primary.pool_id });
  assert.equal(secrets.pool_secret, primary.secret);
  const listed = await backend.listPools();
  assert.equal(listed.pools[0].secret, undefined, "the pool list never carries the secret");

  // What the Code surface is offered: a byoc environment per pool, and nothing
  // else. The local (this-computer) place is never in the list — that is the
  // guarantee stated where the renderer picks a place, so no session can be
  // started on one locally.
  const listed_environments = await backend.environmentList();
  assert.equal(listed_environments.environments.length, 1);
  assert.equal(listed_environments.has_more, false);
  assert.equal(listed_environments.first_id, primary.pool_id);
  assert.ok(
    listed_environments.environments.every((environment) => environment.kind === "byoc"),
    "a tenant is offered self-hosted environments only — never a local place",
  );
  const [environment] = listed_environments.environments;
  assert.equal(environment.kind, "byoc", "a pool is advertised as a byoc environment");
  assert.equal(environment.environment_id, primary.pool_id);
  assert.equal(environment.config.environment_type, "byoc");
  assert.equal(environment.state, "active");

  // The by-id read the detail screen makes.
  assert.equal((await backend.environment(primary.pool_id)).environment_id, primary.pool_id);
  assert.equal(await backend.environment("no-such-pool"), null);

  // The same record built from a bare pool (no store) keeps its shape.
  const standalone = poolEnvironment({ pool_id: "ccpool_x", name: "n", status: "active", created_at: "t" });
  assert.equal(standalone.kind, "byoc");
  assert.equal(standalone.config.environment_type, "byoc");

  // A pool reaches its sessions.
  const sessions = await backend.poolSessions({ poolId: primary.pool_id });
  assert.equal(sessions.data.length, 1);
  assert.equal(sessions.data[0].session_uuid, "session-1");

  // The runner exchanges its assignment for a session token, then reports on the
  // run with it. The token is minted once — a reconnecting runner keeps it.
  const token = await backend.issueSessionToken({ headers: auth, sessionId: "session-1" });
  assert.match(token.session_token, /^ccsess_/, "a session token is minted for the runner");
  assert.equal(
    (await backend.issueSessionToken({ headers: auth, sessionId: "session-1" })).session_token,
    token.session_token,
    "a reconnecting runner keeps the session token it already holds",
  );
  const sessionAuth = { authorization: `Bearer ${token.session_token}` };
  assert.equal(
    (await backend.issueSessionToken({ headers: wrong, sessionId: "session-1" })).unauthorized,
    true,
    "the session legs refuse a secret that names nothing",
  );
  assert.equal(
    (await backend.issueSessionToken({ headers: sessionAuth, sessionId: "nope" })),
    null,
    "an unknown session is not found",
  );

  const failure = await backend.reportSessionFailure({
    headers: sessionAuth,
    sessionId: "session-1",
    body: { reason: "checkout failed", setup_failure_kind: "git" },
  });
  assert.deepEqual(failure, { excluded_count: 0, stuck: false },
    "report-failure answers the pool-health numbers the runner reads back");
  assert.equal((await backend.poolSessions({ poolId: primary.pool_id })).data[0].state, "failed",
    "a reported failure is recorded on the session");

  // Retry-spawn is the operator's Activity → Retry: back to pending, one more
  // attempt, and a fresh token (the old one must not keep working).
  await backend.retrySpawn({ headers: sessionAuth, sessionId: "session-1" });
  const retried = (await backend.poolSessions({ poolId: primary.pool_id })).data[0];
  assert.equal(retried.state, "pending");
  assert.equal(retried.attempt, 3, "retry-spawn bumps the attempt");
  assert.equal((await backend.issueSessionToken({ headers: sessionAuth, sessionId: "session-1" })).unauthorized,
    true, "the retired token no longer authenticates after a retry");

  // Placing a session: the create body is the renderer's own serializer's
  // shape — a pool worker names its place with `self_hosted_runner_pool_id` —
  // and only a place that is one of this instance's pools may run it; there is
  // no local executor here to fall back to. The document reads in the app's
  // vocabulary: `active` with no worker status is what its normalizer paints
  // as pending.
  const placed = await backend.createSession({
    body: {
      title: "hello",
      self_hosted_runner_pool_id: primary.pool_id,
      config: { sources: [{ type: "git_repository", url: "https://example.invalid/r.git", revision: "refs/heads/main" }] },
      tags: ["smoke"],
    },
  });
  assert.equal(placed.session.status, "active");
  assert.equal(placed.session.worker_status, undefined,
    "a session no runner has taken reads pending to the app");
  assert.equal(placed.session.environment_id, primary.pool_id);
  assert.equal(placed.session.self_hosted_runner_pool_id, primary.pool_id);
  assert.deepEqual(placed.session.tags, ["smoke"]);
  assert.equal(placed.session.config.sources.length, 1, "the create body's sources are echoed back");
  assert.equal(placed.session.self_hosted_runner_state.pool_name, "dev-box",
    "the session carries its pool's name for the pool-wait UI");
  assert.equal(placed.session.self_hosted_runner_state.assigned_runner_label, undefined,
    "and claims no runner until one has actually taken it");
  assert.equal((await backend.session("session-1")).session.self_hosted_runner_state
    .assigned_runner_label, registered.runner_id,
    "a claimed session names the runner, which is what ends the wait card");
  assert.equal((await backend.session(placed.session.id)).session.title, "hello");
  assert.equal(await backend.session("no-such-session"), null);
  assert.equal(
    (await backend.createSession({ body: { environment_id: "00000000-0000-4000-8000-000000000000" } }))
      .unsupported,
    true,
    "a session for anything but this instance's own pool is refused",
  );
  assert.equal(
    (await backend.createSession({ body: { self_hosted_runner_pool_id: "ccpool_nope" } })).unsupported,
    true,
    "and a pool worker naming a foreign pool is refused the same way",
  );
  const offered = await backend.pollSpawnHints({ headers: auth });
  assert.ok(offered.hints.some((hint) => hint.session_uuid === placed.session.id),
    "a placed session is offered to the pool's runners");
  assert.equal(
    offered.hints.find((hint) => hint.session_uuid === placed.session.id).sources.length,
    1,
    "the runner's hint carries the create body's sources — they live in `config` now",
  );
  assert.match(placed.session.id, /^cse_[0-9a-z]{32}$/,
    "a session id speaks the wire's generation — a bare uuid reads as a local session to the app");
  const sessionSuffix = placed.session.id.replace(/^cse_/, "");
  assert.equal((await backend.session(`session_${sessionSuffix}`)).session.id, placed.session.id,
    "and answers under the display generation's `session_` spelling too");

  // A session's events: the runner writes the transcript, the renderer reads it,
  // and the envelopes are the app's own contract — checked with the in-tree
  // model rather than our idea of the shape (event_id non-empty, sequence_num a
  // positive digit string, a JSONObject payload).
  await backend.appendEvents({
    sessionId: placed.session.id,
    body: {
      events: [
        { payload: { type: "user", message: { role: "user", content: "hi" } } },
        { payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } },
      ],
    },
  });
  const history = await backend.listEvents({ sessionId: placed.session.id, searchParams: new URLSearchParams() });
  const decoded = decodeClientEventsResponse(history);
  assert.equal(decoded.length, 2, "both events are on the wire");
  assert.deepEqual(history.data.map((event) => event.sequence_num), ["1", "2"],
    "sequence numbers are positive digit strings, assigned by the store");
  assert.equal(decoded[1].message.type, "assistant");

  const resumed = await backend.listEvents({
    sessionId: placed.session.id,
    searchParams: new URLSearchParams({ after_sequence_num: "1" }),
  });
  assert.equal(resumed.data.length, 1, "after_sequence_num resumes the history");

  // A runner writes one message at a time, and takes the next sequence.
  await backend.appendEvents({
    sessionId: placed.session.id,
    body: { payload: { type: "user", message: { role: "user", content: "again" } } },
  });
  const tail = await backend.listEvents({ sessionId: placed.session.id, searchParams: new URLSearchParams() });
  assert.equal(tail.data.length, 3);
  assert.equal((await backend.eventsAfter(placed.session.id, 1)).length, 2);
  assert.equal(await backend.appendEvents({ sessionId: "no-such-session", body: {} }), null);

  // The create body may carry the session's first events; they land in the
  // same log, and deleting the session takes its log with it.
  const withEvents = await backend.createSession({
    body: { self_hosted_runner_pool_id: primary.pool_id,
      events: [{ payload: { type: "control_request", request: { subtype: "initialize" } } }] },
  });
  assert.equal((await backend.listEvents({ sessionId: withEvents.session.id, searchParams: new URLSearchParams() }))
    .data.length, 1, "the create body's first events land in the log");
  assert.deepEqual(await backend.deleteSession({ sessionId: withEvents.session.id }), {});
  assert.equal(await backend.session(withEvents.session.id), null, "a deleted session is gone");
  assert.equal(await backend.deleteSession({ sessionId: "no-such-session" }), null);

  // The edit legs the Code page uses once a session exists: one PUT for
  // rename/tags/metadata, archive, mark_read, the MCP editor's save.
  const renamed = await backend.updateSession({
    sessionId: placed.session.id,
    body: { title: "renamed by the reader", add_tags: ["pinned"], remove_tags: ["smoke"],
      client_metadata: { last_seen_cwd: "/workspace" } },
  });
  assert.equal(renamed.session.title, "renamed by the reader");
  assert.deepEqual(renamed.session.tags, ["pinned"]);
  assert.equal(renamed.session.client_metadata.last_seen_cwd, "/workspace");
  assert.equal((await backend.updateSession({ sessionId: "no-such-session", body: {} })), null);
  assert.equal((await backend.setSessionMcpServers({
    sessionId: placed.session.id, body: { mcp_servers: [{ name: "docs", type: "http", url: "https://example.invalid/mcp" }] },
  })).session.config.mcp_servers.length, 1);
  assert.equal((await backend.markSessionRead({ sessionId: placed.session.id })).session.unread, undefined,
    "mark_read leaves a session read");
  const archived = await backend.archiveSession({ sessionId: placed.session.id });
  assert.equal(archived.session.status, "archived");
  const activeOnly = await backend.listSessions({
    searchParams: new URLSearchParams("statuses=active&statuses=paused"),
  });
  assert.equal(activeOnly.data.some((row) => row.id === placed.session.id), false,
    "an archived session leaves the list the sidebar reads");
  const archivedOnly = await backend.listSessions({ searchParams: new URLSearchParams("statuses=archived") });
  assert.equal(archivedOnly.data.some((row) => row.id === placed.session.id), true);

  // Removing the pool takes its runners and stops handing out work.
  await backend.removePool({ poolId: primary.pool_id });
  assert.equal((await backend.listPools()).pools.length, 0);
  assert.equal((await backend.primaryPool()), null);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

// The bridge must actually route this, and only for a tenant with the feature
// on — a second instance of the substrate that nobody calls would be worse than
// none.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");
assert.match(
  serverSource,
  /tenantInstance\s*&&\s*process\.env\.CLAUDESK_CODE_RUNNERS === "1"/,
  "the pool API is served only on a tenant instance",
);
assert.ok(
  serverSource.includes('url.pathname.startsWith("/v1/code/runners/")'),
  "the bridge routes /v1/code/runners/* through the backend",
);
assert.ok(
  serverSource.includes("await handleCodeRunnerApi(request, response, url)"),
  "and delegates to the runner handler",
);
assert.ok(
  serverSource.includes('url.pathname.startsWith("/v1/environment_providers/")'),
  "the environment list a tenant's Code surface reads is served here too",
);
// The web Code surface reads `claude_code_web` out of the access document, and
// the composer derives `remoteSessionsAllowed` from it before it will offer any
// environment at all — so a tenant has to declare it, with or without the web
// shell, while the operator's own instance is left to upstream. Exercised, not
// grepped: the grant is evaluated against a real document.
const grants = section(serverSource, "function grantTenantCodeEntitlements(",
  "function grantWebShellEntitlements(");
const gateGrant = section(serverSource, "const tenantCodeGates", "function grantWebShellEntitlements(");
const gateKey = section(serverSource, "function growthbookKey(", "function grantWebShellGates(");

function granted(codeRunners, initial = []) {
  const sandbox = { codeRunnersEnabled: codeRunners };
  vm.runInNewContext(
    `const codeRunnersEnabled = ${codeRunners};
     ${grants}
     const document = { current_user_access: { features: ${JSON.stringify(initial)} }, features: [] };
     grantTenantCodeEntitlements(document);
     result = document.current_user_access.features;`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}
const tenant = Object.fromEntries(granted(true).map((entry) => [entry.feature, entry.status]));
assert.equal(tenant.claude_code_web, "available",
  "the composer's remoteSessionsAllowed is derived from this entry");
assert.equal(tenant.claude_code_self_hosted_runners, "available",
  "and the pools query — the menu's self-hosted section — is enabled on this one");
assert.deepEqual(granted(false), [],
  "the operator's own instance keeps whatever upstream said");

// An entry the upstream already carries is never overwritten, whatever its
// status — that is what keeps this from silently undoing org policy.
const blocked = granted(true, [{ feature: "claude_code_web", status: "blocked_by_entitlement" }]);
assert.equal(blocked.find((entry) => entry.feature === "claude_code_web").status,
  "blocked_by_entitlement", "an upstream verdict survives the grant");

// The rollout gate the self-hosted-runners check falls back to, granted the way
// `bad_moon_rising` is — by the key the renderer addresses it by.
function gated(codeRunners, initial = {}) {
  const sandbox = { codeRunnersEnabled: codeRunners };
  vm.runInNewContext(
    `const codeRunnersEnabled = ${codeRunners};
     ${gateKey}
     ${gateGrant}
     const document = { growthbook: { features: ${JSON.stringify(initial)} } };
     grantTenantCodeGates(document);
     result = document.growthbook.features;`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}
let key = null;
{
  const sandbox = {};
  vm.runInNewContext(`${gateKey}\nresult = growthbookKey("claude_ai_tamarind")`, sandbox);
  key = sandbox.result;
}
assert.equal(gated(true)[key]?.defaultValue, true,
  "a tenant grants the self-hosted-runners rollout gate");
assert.deepEqual(gated(false), {},
  "and the operator's instance is left alone");
assert.deepEqual(gated(true, { [key]: { defaultValue: false } }),
  { [key]: { defaultValue: false } },
  "an upstream verdict on the gate is left alone too");

// The one flag the renderer's whole remote-place machinery reads from the page:
// `shared-50`'s `RM` turns `appFeatures.selfHostedSessions.status` into the
// `remoteSessionsAllowed` every session-target and the pools query start from,
// and in a browser `appFeatures` is exactly the preload table this bridge hands
// the page — the Desktop wrapper's relay whitelist drops selfHostedSessions, and
// the renderer's async resample needs a native surface the web shell does not
// shim, so without this entry the composer's places menu is Local-only however
// the bootstrap is granted. Exercised, not grepped: the table builder runs
// against the relayed table.
const bootTable = section(serverSource, "function withSelfHostedSessions(",
  "function grantWebShellEntitlements(");

function bootFeatures(codeSurface, initial) {
  const sandbox = {};
  vm.runInNewContext(
    `const codeSurfaceEnabled = ${codeSurface};
     ${bootTable}
     result = withSelfHostedSessions(${JSON.stringify(initial)});`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}
assert.equal(bootFeatures(true, {}).selfHostedSessions?.status, "supported",
  "a tenant declares the self-hosted sessions its runners serve");
assert.equal(
  bootFeatures(true, { selfHostedSessions: { status: "unavailable" } })
    .selfHostedSessions.status,
  "supported",
  "overriding a relayed table that omits or denies it — the claim is the deployment's to make",
);
assert.deepEqual(bootFeatures(false, { chatIn3p: { status: "supported" } }),
  { chatIn3p: { status: "supported" } },
  "while the operator's instance keeps exactly the relayed table");
assert.ok(
  serverSource.includes("withSelfHostedSessions(await desktop.bootFeatures())"),
  "and the browser's preload config is built through the table builder",
);

const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
assert.equal(
  (compose.match(/CLAUDESK_CODE_RUNNERS: "\$\{CLAUDESK_CODE_RUNNERS:-0\}"/g) || []).length, 1,
  "the bridge service must pass CLAUDESK_CODE_RUNNERS through",
);

process.stdout.write("code-runners-smoke: pools, runner polling and byoc environments hold\n");