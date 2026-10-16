import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunnerBackend, poolEnvironment } from "../bridge/code-runners.mjs";

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

  // Placing a session: the create body is the Desktop main process's own shape,
  // and only an environment that is one of this instance's pools may run it —
  // there is no local executor here to fall back to.
  const placed = await backend.createSession({
    body: {
      title: "hello",
      environment_id: primary.pool_id,
      config: { sources: [{ type: "git_repository", url: "https://example.invalid/r.git", revision: "refs/heads/main" }] },
    },
  });
  assert.equal(placed.session.status, "pending");
  assert.equal(placed.session.environment_id, primary.pool_id);
  assert.equal((await backend.session(placed.session.id)).session.title, "hello");
  assert.equal(await backend.session("no-such-session"), null);
  assert.equal(
    (await backend.createSession({ body: { environment_id: "00000000-0000-4000-8000-000000000000" } }))
      .unsupported,
    true,
    "a session for anything but this instance's own pool is refused",
  );
  const offered = await backend.pollSpawnHints({ headers: auth });
  assert.ok(offered.hints.some((hint) => hint.session_uuid === placed.session.id),
    "a placed session is offered to the pool's runners");

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
const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
assert.equal(
  (compose.match(/CLAUDESK_CODE_RUNNERS: "\$\{CLAUDESK_CODE_RUNNERS:-0\}"/g) || []).length, 1,
  "the bridge service must pass CLAUDESK_CODE_RUNNERS through",
);

process.stdout.write("code-runners-smoke: pools, runner polling and byoc environments hold\n");