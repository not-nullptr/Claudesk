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
  let wakes = 0;
  const backend = createRunnerBackend({
    stateDir,
    log,
    poolName: "dev-box",
    wakeRunner: () => { wakes += 1; },
  });

  // The deployment names the pool, so a runner can be pointed at it without
  // anyone clicking through the admin UI.
  const primary = await backend.primaryPool();
  assert.ok(primary?.pool_id?.startsWith("ccpool_"), "the named pool exists and is ccpool_-prefixed");
  assert.ok(primary.secret.length > 20, "the pool has a minted secret");
  assert.equal(primary.name, "dev-box");

  const auth = { authorization: `Bearer ${primary.secret}` };
  const wrong = { authorization: "Bearer not-the-secret" };

  // The pool is the instance's place from the moment it exists, whether or not
  // its runner has polled yet: the Code composer and the routine form offer it,
  // and placing a session wakes the VM. (A fresh account otherwise saw an empty
  // environment picker until it had started a session elsewhere.)
  const beforeRunner = (await backend.environmentList()).environments;
  assert.equal(beforeRunner.length, 1, "the pool is offered before a runner registers");
  assert.equal(beforeRunner[0].environment_id, primary.pool_id);
  assert.equal(beforeRunner[0].state, "active");
  assert.equal((await backend.environment(primary.pool_id)).state, "active");

  // No secret, or the wrong one, is the same answer: no pool.
  assert.equal((await backend.registerRunner({ headers: {}, body: {} })).unauthorized, true,
    "register without a secret is unauthorized");
  assert.equal((await backend.registerRunner({ headers: wrong, body: {} })).unauthorized, true,
    "register with the wrong secret is unauthorized");

  // A runner older than 2.0.2 ignores the UI-request lane on its poll. The
  // bridge must say so at once (and why), not wait out the request timeout.
  const oldRunner = await backend.registerRunner({
    headers: auth,
    body: { runner_version: "2.0.1" },
  });
  await backend.pollSpawnHints({ headers: auth });
  await assert.rejects(
    () => backend.listRunnerFolders({ root: "/workspace", path: "/workspace" }),
    (error) => error.statusCode === 501 && /2\.0\.2/.test(error.message),
    "an old guest runner is refused with an actionable version error",
  );
  await backend.deregisterRunner({ headers: auth, body: { runner_id: oldRunner.runner_id } });

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
  // A session is work only once it has a prompt, so the seam states one.
  const queued = await backend.queueSession({
    poolId: primary.pool_id, sessionUuid: "session-1", prompt: "hello",
  });
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

  // A poll whose connection died must not claim anything. The guest VM can
  // suspend with its held poll still open on the bridge; when the pool was
  // then woken, the dead request used to take the session — leaving it
  // `offered` with no runner holding it and no client that received it.
  await backend.queueSession({
    poolId: primary.pool_id, sessionUuid: "dead-poll", prompt: "dead poll",
  });
  const deadPoll = await backend.pollSpawnHints({
    headers: auth,
    request: { socket: { destroyed: true, once() {}, off() {} } },
  });
  assert.deepEqual(deadPoll.hints, [], "a dead poll is handed nothing");
  const livePoll = await backend.pollSpawnHints({
    headers: auth,
    request: { socket: { destroyed: false, once() {}, off() {} } },
  });
  assert.ok(livePoll.hints.some((hint) => hint.session_uuid === "dead-poll"),
    "the placement is still there for the next live poll");
  await backend.deleteSession({ sessionId: "dead-poll" });

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
      config: {
        sources: [{ type: "git_repository", url: "https://example.invalid/r.git", revision: "refs/heads/main" }],
        cwd: "/workspace/project",
        source_branch: "main",
        model: "claude-sonnet-5-5[1m]",
        permission_mode: "bypassPermissions",
        effort_level: "max",
      },
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
  // The renderer's session normalizer reads the model/effort from
  // `session_context` and the permission mode as its own top-level field; the
  // create config alone is the guest runner's spelling and invisible to it.
  assert.equal(placed.session.session_context.model, "claude-sonnet-5-5[1m]",
    "the session document carries the started model in the renderer's shape");
  assert.equal(placed.session.session_context.effort_level, "max");
  assert.equal(placed.session.session_context.cwd, "/workspace/project",
    "the folder the session starts in travels in the renderer's own block");
  assert.deepEqual(placed.session.repo_info, { owner: "", name: "project", branch: "main" },
    "and the folder is the row's repository info, so the sidebar groups and prefills it");
  assert.equal(placed.session.permission_mode, "bypassPermissions",
    "and the started permission mode where the composer reads it");
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
  // Placement and the first message are two requests from the composer. A
  // session with no prompt is not work: offering it made the runner claim an
  // empty transcript and report "no user message to answer" before the send
  // landed. It becomes work the moment the message is appended.
  const unprompted = await backend.createSession({
    body: { title: "placed, not sent yet", self_hosted_runner_pool_id: primary.pool_id },
  });
  let waiting = await backend.pollSpawnHints({ headers: auth });
  assert.equal(
    waiting.hints.some((hint) => hint.session_uuid === unprompted.session.id), false,
    "a session with no user message is not offered",
  );
  assert.equal(
    waiting.hints.some((hint) => hint.session_uuid === placed.session.id), false,
    "nor is a placed session whose message has not arrived",
  );
  await backend.appendEvents({
    sessionId: unprompted.session.id,
    body: { events: [{ payload: { type: "user",
      message: { role: "user", content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGk=" },
      }] } } }] },
  });
  waiting = await backend.pollSpawnHints({ headers: auth });
  assert.ok(waiting.hints.some((hint) => hint.session_uuid === unprompted.session.id),
    "an image-only prompt is a prompt too, and wakes the pool");

  // The placed session's own prompt is the send the composer posts next.
  await backend.appendEvents({
    sessionId: placed.session.id,
    body: { events: [{ payload: { type: "user",
      message: { role: "user", content: "hi" } } }] },
  });
  const offered = await backend.pollSpawnHints({ headers: auth });
  assert.ok(offered.hints.some((hint) => hint.session_uuid === placed.session.id),
    "a placed session is offered once its message lands");
  assert.equal(
    offered.hints.find((hint) => hint.session_uuid === placed.session.id).sources.length,
    1,
    "the runner's hint carries the create body's sources — they live in `config` now",
  );
  assert.match(placed.session.id, /^cse_[0-9a-f]{12}_01[1-9A-HJ-NP-Za-km-z]{22}$/,
    "a session id speaks the wire's encoding — a bare uuid reads as a local session to the app, "
    + "and the runner decodes the trailing base58 segment back into the session's uuid");
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

  // The renderer pages the transcript with `cursor`, not `after_sequence_num`:
  // an ascending walk (the full-transcript load) continues above the page's
  // last sequence, and a newest-first scrollback read continues below its
  // oldest. The cursor has to move the window or the reader sees the same page
  // again and stops.
  const firstAsc = await backend.listEvents({
    sessionId: placed.session.id,
    searchParams: new URLSearchParams({ sort_order: "asc", limit: "2" }),
  });
  assert.deepEqual(firstAsc.data.map((event) => event.sequence_num), ["1", "2"]);
  assert.equal(firstAsc.next_cursor, "2", "an ascending page points past its last event");
  const nextAsc = await backend.listEvents({
    sessionId: placed.session.id,
    searchParams: new URLSearchParams({ sort_order: "asc", limit: "2", cursor: firstAsc.next_cursor }),
  });
  assert.deepEqual(nextAsc.data.map((event) => event.sequence_num), ["3"],
    "an ascending cursor resumes strictly above the page edge");
  assert.equal(nextAsc.next_cursor, null);

  const firstDesc = await backend.listEvents({
    sessionId: placed.session.id,
    searchParams: new URLSearchParams({ sort_order: "desc", limit: "2" }),
  });
  assert.deepEqual(firstDesc.data.map((event) => event.sequence_num), ["3", "2"]);
  assert.equal(firstDesc.next_cursor, "2", "a newest-first page points at its oldest event");
  const nextDesc = await backend.listEvents({
    sessionId: placed.session.id,
    searchParams: new URLSearchParams({ sort_order: "desc", limit: "2", cursor: firstDesc.next_cursor }),
  });
  assert.deepEqual(nextDesc.data.map((event) => event.sequence_num), ["1"],
    "a newest-first cursor resumes strictly below the page edge");
  assert.equal(nextDesc.next_cursor, null);
  await assert.rejects(
    backend.listEvents({ sessionId: placed.session.id,
      searchParams: new URLSearchParams({ sort_order: "asc", cursor: "not-a-sequence" }) }),
    (error) => error.statusCode === 400,
    "a cursor that is not a sequence is refused rather than ignored",
  );
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

  // A running session's settings change through control requests in its event
  // log; the session document follows them, so reopening it shows the change.
  const switched = await backend.createSession({
    body: {
      self_hosted_runner_pool_id: primary.pool_id,
      config: { sources: [], model: "model-before", permission_mode: "acceptEdits",
        effort_level: "high" },
    },
  });
  await backend.appendEvents({ sessionId: switched.session.id, body: { events: [
    { payload: { type: "control_request", request: { subtype: "set_model", model: "model-after" } } },
    { payload: { type: "control_request", request: { subtype: "set_permission_mode", mode: "plan" } } },
    { payload: { type: "control_request",
      request: { subtype: "apply_flag_settings", settings: { effortLevel: "max" } } } },
  ] } });
  const switchedDoc = (await backend.session(switched.session.id)).session;
  assert.equal(switchedDoc.session_context.model, "model-after",
    "a set_model control request updates the session's own model");
  assert.equal(switchedDoc.permission_mode, "plan",
    "a set_permission_mode control request updates the session's permission mode");
  assert.equal(switchedDoc.session_context.effort_level, "max",
    "an apply_flag_settings control request updates the session's effort");
  await backend.deleteSession({ sessionId: switched.session.id });

  // The browser send path carries the composer's *spawn* permission mode in
  // the same batch as the first user message. Until the folder's stored picks
  // settle that value is the failsafe "default" — a session started in bypass
  // must not be demoted to Manual by its own first message.
  const failsafe = await backend.createSession({
    body: {
      self_hosted_runner_pool_id: primary.pool_id,
      config: { sources: [], permission_mode: "bypassPermissions" },
    },
  });
  await backend.appendEvents({ sessionId: failsafe.session.id, body: { events: [
    { payload: { type: "control_request",
      request: { subtype: "set_permission_mode", mode: "default" } } },
    { payload: { type: "user", message: { role: "user", content: "hi" } } },
  ] } });
  assert.equal((await backend.session(failsafe.session.id)).session.permission_mode,
    "bypassPermissions",
    "the batched failsafe default must not demote the started permission mode");
  const failsafeEvents = await backend.eventsAfter(failsafe.session.id, 0);
  assert.ok(!failsafeEvents.some((event) =>
    (event.payload ?? event).type === "control_request"
    && (event.payload ?? event).request?.subtype === "set_permission_mode"),
  "the dropped failsafe must not reach the transcript the runner replays");
  // A deliberate switch is its own append (no user message) and still lands.
  await backend.appendEvents({ sessionId: failsafe.session.id, body: { events: [
    { payload: { type: "control_request",
      request: { subtype: "set_permission_mode", mode: "default" } } },
  ] } });
  assert.equal((await backend.session(failsafe.session.id)).session.permission_mode,
    "default", "an explicit in-session switch to Manual still applies");
  await backend.deleteSession({ sessionId: failsafe.session.id });

  // Stop. The Code surface has no interrupt route of its own: its Stop appends
  // an SDK `interrupt` control request to the session's event log. The store
  // must act on it — clear the runner's assignment (the shipped runner aborts
  // on that), hand the id to the guest runner's poll (`cancellations`), and
  // answer the control request so the Stop button settles.
  const stoppable = await backend.createSession({
    body: { self_hosted_runner_pool_id: primary.pool_id },
  });
  await backend.appendEvents({ sessionId: stoppable.session.id, body: { events: [
    { payload: { type: "user", message: { role: "user", content: "long task" } } },
  ] } });
  await backend.pollSpawnHints({ headers: auth });
  const stopToken = await backend.issueSessionToken({
    headers: auth, sessionId: stoppable.session.id,
  });
  assert.equal((await backend.pollSpawnHints({ headers: auth })).cancellations
    .some((entry) => entry.session_uuid === stoppable.session.id), false,
  "a running session is not cancelled until a Stop arrives");

  const stopAppend = await backend.appendEvents({
    sessionId: stoppable.session.id,
    body: { events: [{ payload: { type: "control_request", request_id: "interrupt-smoke",
      request: { subtype: "interrupt" } } }] },
  });
  assert.equal(stopAppend.data.length, 2,
    "the Stop lands with the control_response its button waits on");
  const stopEvents = await backend.eventsAfter(stoppable.session.id, 0);
  const stopAck = stopEvents.find((event) => (event.payload ?? event).type === "control_response");
  assert.equal(stopAck.source, "worker", "the receipt is the worker's own voice");
  assert.deepEqual(stopAck.payload.response,
    { subtype: "success", request_id: "interrupt-smoke", response: {} },
    "the receipt carries the request id the client registered");

  const stopPoll = await backend.pollSpawnHints({ headers: auth });
  const notice = stopPoll.cancellations.find(
    (entry) => entry.session_uuid === stoppable.session.id);
  assert.ok(notice, "the guest runner is told which turn to stop on its poll");
  assert.equal(notice.reason, "interrupt");
  assert.equal(notice.request_id, "interrupt-smoke");
  const workPoll = await backend.pollWork({ headers: auth });
  assert.equal(workPoll.assignment_ids.includes(stoppable.session.id), false,
    "the assignment disappears, which is the shipped runner's abort signal");

  // The turn releases as an interrupted turn would; the notice goes away.
  await backend.releaseSession({
    headers: { authorization: `Bearer ${stopToken.session_token}` },
    sessionId: stoppable.session.id,
  });
  assert.equal(
    (await backend.pollSpawnHints({ headers: auth })).cancellations
      .some((entry) => entry.session_uuid === stoppable.session.id),
    false, "a released turn is no longer cancelled");

  // The next message starts a *new* turn, and the old Stop must not cancel it.
  await backend.appendEvents({ sessionId: stoppable.session.id, body: { events: [
    { payload: { type: "user", message: { role: "user", content: "next turn" } } },
  ] } });
  const afterStop = await backend.pollSpawnHints({ headers: auth });
  assert.ok(afterStop.hints.some((hint) => hint.session_uuid === stoppable.session.id),
    "the message after a Stop is offered to the pool");
  assert.equal(afterStop.cancellations.some(
    (entry) => entry.session_uuid === stoppable.session.id), false,
  "the previous Stop does not cancel the next turn");

  // The REST spelling the routine cancel and the mobile facade use.
  const restStop = await backend.interruptSession({
    sessionId: stoppable.session.id, requestId: "rest-stop",
  });
  assert.equal(restStop.session.id, stoppable.session.id);
  assert.equal(await backend.interruptSession({ sessionId: "no-such-session" }), null,
    "stopping an unknown session is not found");

  // The composer's send-and-interrupt: a Stop and a new message in one batch.
  // The cancelled turn must not swallow the message — the release puts the
  // session back on the pool so the next turn answers it.
  const interrupting = await backend.createSession({
    body: { self_hosted_runner_pool_id: primary.pool_id },
  });
  await backend.appendEvents({ sessionId: interrupting.session.id, body: { events: [
    { payload: { type: "user", message: { role: "user", content: "first" } } },
  ] } });
  await backend.pollSpawnHints({ headers: auth });
  const interruptingToken = await backend.issueSessionToken({
    headers: auth, sessionId: interrupting.session.id,
  });
  await backend.appendEvents({ sessionId: interrupting.session.id, body: { events: [
    { payload: { type: "control_request", request_id: "interrupt-and-send",
      request: { subtype: "interrupt" } } },
    { payload: { type: "user", message: { role: "user", content: "second" } } },
  ] } });
  await backend.releaseSession({
    headers: { authorization: `Bearer ${interruptingToken.session_token}` },
    sessionId: interrupting.session.id,
  });
  const nextTurn = await backend.pollSpawnHints({ headers: auth });
  assert.ok(nextTurn.hints.some((hint) => hint.session_uuid === interrupting.session.id),
    "the message sent with the Stop starts the next turn");
  assert.equal(nextTurn.cancellations.some(
    (entry) => entry.session_uuid === interrupting.session.id), false,
  "and the Stop does not cancel that new turn");
  await backend.deleteSession({ sessionId: interrupting.session.id });

  // Deleting a session that may still be running leaves a tombstone the
  // runner's poll names — the record is gone, so nothing else can carry it.
  const doomed = await backend.createSession({
    body: { self_hosted_runner_pool_id: primary.pool_id },
  });
  await backend.issueSessionToken({ headers: auth, sessionId: doomed.session.id });
  await backend.deleteSession({ sessionId: doomed.session.id });
  const tombstoned = await backend.pollSpawnHints({ headers: auth });
  assert.ok(tombstoned.cancellations.some((entry) =>
    entry.session_uuid === doomed.session.id && entry.reason === "deleted"),
  "a deleted running session is cancelled on the runner's next poll");
  await backend.deleteSession({ sessionId: stoppable.session.id });

  // A routine fire's session names the routine it ran. The Code routine page
  // reads its history as `?trigger_id=`, the routines rollup as
  // `?only_trigger_sessions=true`; ordinary lists leave those runs out and
  // `include_trigger_sessions=true` brings them back. Without the filters
  // every session was history of every routine.
  const routineRun = await backend.createSession({
    body: {
      self_hosted_runner_pool_id: primary.pool_id,
      title: "routine run",
      trigger_id: "trig_smoke",
      origin: "fire_routine",
    },
  });
  assert.equal(routineRun.session.trigger_id, "trig_smoke");
  assert.equal(routineRun.session.origin, "fire_routine");
  const triggerRuns = await backend.listSessions({
    searchParams: new URLSearchParams("trigger_id=trig_smoke"),
  });
  assert.deepEqual(triggerRuns.data.map((row) => row.id), [routineRun.session.id],
    "trigger_id narrows the list to one routine's runs");
  const ordinary = await backend.listSessions({ searchParams: new URLSearchParams() });
  assert.equal(ordinary.data.some((row) => row.id === routineRun.session.id), false,
    "a routine run stays out of the ordinary Code list");
  assert.equal(ordinary.data.some((row) => row.id === placed.session.id), true,
    "an ordinary session is still listed");
  const included = await backend.listSessions({
    searchParams: new URLSearchParams("include_trigger_sessions=true"),
  });
  assert.equal(included.data.some((row) => row.id === routineRun.session.id), true,
    "include_trigger_sessions brings routine runs back");
  const onlyTrigger = await backend.listSessions({
    searchParams: new URLSearchParams("only_trigger_sessions=true"),
  });
  assert.deepEqual(onlyTrigger.data.map((row) => row.id), [routineRun.session.id],
    "only_trigger_sessions is the rollup's read");

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
  // The renderer's chat recents ask this same list for its remote-cowork tag.
  // The list has always answered by status; tags must narrow it too, or every
  // Code row comes back as a Chat row (see docs/web-shell.md).
  const tagged = await backend.listSessions({
    searchParams: new URLSearchParams("tags=pinned"),
  });
  assert.equal(tagged.data.some((row) => row.id === placed.session.id), true,
    "a row carrying the requested tag is listed");
  const remoteCowork = await backend.listSessions({
    searchParams: new URLSearchParams("include_trigger_sessions=true&tags=cowork-remote"),
  });
  assert.equal(remoteCowork.data.some((row) => row.id === placed.session.id), false,
    "a Code session without the tag is not a remote-cowork row");
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

  // A restarted runner re-registers with the same client label; it replaces
  // its old record, and a token-authenticated poll is attributed to it alone
  // instead of refreshing every stale registration on the pool.
  await backend.registerRunner({
    headers: auth,
    body: { runner_version: "2.0.4", client_label: "claudesk-guest-runner" },
  });
  const relabelled = await backend.registerRunner({
    headers: auth,
    body: { runner_version: "2.0.5", client_label: "claudesk-guest-runner" },
  });
  const stored = JSON.parse(await readFile(join(stateDir, "code-runners.json"), "utf8"));
  assert.equal(stored.runners.filter(
    (runner) => runner.client_label === "claudesk-guest-runner").length, 1,
  "a re-registering runner replaces its previous record");
  await backend.pollSpawnHints({
    headers: { authorization: `Bearer ${relabelled.runner_token}` },
  });
  const status = await backend.runnerStatus();
  assert.equal(status.attributed, true, "a token poll names the runner that made it");
  assert.equal(status.live_version, "2.0.5",
    "the live runner is the one that polled, not every registration on the pool");
  assert.equal(status.request_lane, true);

  // A turn whose runner vanished is closed by the bridge, not left `active`
  // forever. The session's transcript gets the terminal its reader closes on,
  // and the unanswered message goes back on the pool so the next runner picks
  // it up instead of the page hanging on "Sending…".
  const runnerAuth = { authorization: `Bearer ${relabelled.runner_token}` };
  const lost = await backend.createSession({
    body: {
      environment_id: primary.pool_id,
      events: [{ payload: { type: "user",
        message: { role: "user", content: "run this and do not come back" } } }],
    },
  });
  const lostId = lost.session.id;
  const offeredLost = await backend.pollSpawnHints({
    headers: runnerAuth, body: { running: [], claimed: [] },
  });
  assert.ok(offeredLost.hints.some((hint) => hint.session_uuid === lostId),
    "the placed session is offered");
  const lostToken = await backend.issueSessionToken({ headers: runnerAuth, sessionId: lostId });
  assert.match(lostToken.session_token, /^ccsess_/);
  // The runner polls again without holding it: the VM stopped, the guest
  // restarted, or the process died mid-turn.
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  await backend.reapNow(Date.now() + 120000);
  const lostDoc = await backend.session(lostId);
  assert.equal(lostDoc.session.worker_status, undefined,
    "a requeued turn waits for the pool (the renderer's pending state)");
  const lostEvents = decodeClientEventsResponse(
    await backend.listEvents({ sessionId: lostId, searchParams: new URLSearchParams() }));
  assert.equal(lostEvents.at(-1).message.type, "result",
    "the reaped turn still ends with the terminal the reader closes on");
  assert.equal(lostEvents.at(-1).message.is_error, true);
  assert.match(String(lostEvents.at(-1).message.result), /runner/,
    "the terminal says the runner was lost");
  const lostRow = (await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === lostId);
  assert.equal(lostRow.state, "pending", "the unanswered message is put back on the pool");

  // The same loss on a turn that already had its terminal releases it instead:
  // there is nothing left to retry, and the session reads idle.
  const finished = await backend.createSession({
    body: {
      environment_id: primary.pool_id,
      events: [{ payload: { type: "user",
        message: { role: "user", content: "this one answered" } } }],
    },
  });
  const finishedId = finished.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const finishedToken = await backend.issueSessionToken({
    headers: runnerAuth, sessionId: finishedId,
  });
  await backend.appendWorkerEvents({
    headers: { authorization: `Bearer ${finishedToken.session_token}` },
    sessionId: finishedId,
    body: { events: [{ payload: { type: "result", subtype: "success",
      is_error: false, result: "done", session_id: "" } }] },
  });
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  await backend.reapNow(Date.now() + 120000);
  assert.equal((await backend.session(finishedId)).session.worker_status, "idle",
    "a turn that already ended is released, not retried");
  const finishedRow = (await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === finishedId);
  assert.equal(finishedRow.state, "released");

  // A runner that still claims the session is believed, however old the turn
  // is: a long tool call is not a lost runner.
  const stillHeld = await backend.createSession({
    body: { environment_id: primary.pool_id },
  });
  const heldId = stillHeld.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  await backend.issueSessionToken({ headers: runnerAuth, sessionId: heldId });
  await backend.pollSpawnHints({
    headers: runnerAuth, body: { running: [heldId], claimed: [heldId] },
  });
  await backend.reapNow(Date.now() + 120000);
  assert.equal((await backend.session(heldId)).session.worker_status, "running",
    "a claimed turn is never reaped");

  // An offer whose claim never arrives (the poll's answer was lost) is
  // re-offered once its lease expires.
  const stranded = await backend.createSession({
    body: { environment_id: primary.pool_id },
  });
  const strandedId = stranded.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  await backend.reapNow(Date.now() + 61000);
  const strandedRow = (await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === strandedId);
  assert.equal(strandedRow.state, "pending",
    "an unclaimed offer returns to the pool after its lease");

  // A message typed while a turn is running is answered by the *next* turn:
  // it must not start a second runner beside the live one, and the release
  // that ends the current turn puts the session back on the pool instead of
  // leaving the message stranded on "Sending…".
  const midTurn = await backend.createSession({ body: { environment_id: primary.pool_id } });
  const midId = midTurn.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const midToken = await backend.issueSessionToken({ headers: runnerAuth, sessionId: midId });
  // The guest reports how far its transcript read went right after claiming.
  // Nothing is in the log yet, so the message below is unambiguously mid-turn.
  await backend.recordClaim({
    headers: runnerAuth, sessionId: midId, body: { through_sequence_num: 0 },
  });
  await backend.appendEvents({
    sessionId: midId,
    body: { events: [{ payload: { type: "user",
      message: { role: "user", content: "sent while the turn was running" } } }] },
  });
  assert.equal((await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === midId).state, "active",
  "a mid-turn message does not start a second turn");
  await backend.releaseSession({
    headers: { authorization: `Bearer ${midToken.session_token}` },
    sessionId: midId,
  });
  assert.equal((await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === midId).state, "pending",
  "the release requeues the mid-turn message");
  assert.ok(wakes > 0, "a requeue asks the Desktop to start the VM");

  // The same arrival that is *not* mid-turn: an opening message appended
  // between the claim and the runner's transcript read. The read-through
  // report names it as consumed, so the release stays idle instead of starting
  // a duplicate turn with the same prompt.
  const opening = await backend.createSession({ body: { environment_id: primary.pool_id } });
  const openingId = opening.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const openingToken = await backend.issueSessionToken({ headers: runnerAuth, sessionId: openingId });
  await backend.appendEvents({
    sessionId: openingId,
    body: { events: [{ payload: { type: "user",
      message: { role: "user", content: "the opening message" } } }] },
  });
  const openingHistory = await backend.listEvents({
    sessionId: openingId, searchParams: new URLSearchParams(),
  });
  const highest = Math.max(...openingHistory.data.map((event) => Number(event.sequence_num)));
  await backend.recordClaim({
    headers: runnerAuth, sessionId: openingId, body: { through_sequence_num: highest },
  });
  await backend.releaseSession({
    headers: { authorization: `Bearer ${openingToken.session_token}` },
    sessionId: openingId,
  });
  assert.equal((await backend.poolSessions({ poolId: primary.pool_id }))
    .data.find((row) => row.session_uuid === openingId).state, "released",
  "a message the turn's read included is not requeued");
  await backend.deleteSession({ sessionId: openingId });

  // The next hint names the delivery floor. A mid-turn message lands above the
  // running turn's claim but *before* its result, so a guest that read "after
  // the last result" dropped it while the page kept showing "Sending…".
  const floorSession = await backend.createSession({
    body: { environment_id: primary.pool_id },
  });
  const floorId = floorSession.session.id;
  await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const floorToken = await backend.issueSessionToken({ headers: runnerAuth, sessionId: floorId });
  const firstUser = { payload: { type: "user",
    uuid: "aaaaaaaa-1111-4111-8111-111111111111",
    message: { role: "user", content: "the opening message" } } };
  const midUser = { payload: { type: "user",
    uuid: "bbbbbbbb-2222-4222-8222-222222222222",
    message: { role: "user", content: "typed while it worked" } } };
  await backend.appendEvents({ sessionId: floorId, body: { events: [firstUser] } });
  await backend.recordClaim({
    headers: runnerAuth, sessionId: floorId, body: { through_sequence_num: 1 },
  });
  await backend.appendEvents({ sessionId: floorId, body: { events: [midUser] } });
  await backend.releaseSession({
    headers: { authorization: `Bearer ${floorToken.session_token}` }, sessionId: floorId,
  });
  polled = await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const floorHint = polled.hints.find((hint) => hint.session_uuid === floorId);
  assert.equal(floorHint.prompt_after_sequence_num, 1,
    "the hint names the highest sequence the agent was actually given");
  const aboveFloor = await backend.listEvents({
    sessionId: floorId, searchParams: new URLSearchParams({ after_sequence_num: "1" }),
  });
  assert.deepEqual(aboveFloor.data.map((event) => event.payload.uuid).filter(Boolean),
    [midUser.payload.uuid],
    "the mid-turn message is above the floor and is answered by the next turn");

  // Rewind. The surface posts a `rewind_conversation` control request; the
  // bridge answers it with the durable worker marker a reopened page rebuilds
  // its truncated transcript from, and leaves it for the guest to apply to the
  // agent's own conversation at the next turn.
  const rewound = await backend.appendEvents({ sessionId: floorId, body: { events: [{
    payload: { type: "control_request", request_id: "rewind-smoke",
      request: { subtype: "rewind_conversation",
        target_message_uuid: firstUser.payload.uuid, interrupt_if_running: false } },
  }] } });
  const marker = rewound.data.find((event) => event.payload.type === "control_response");
  assert.equal(marker.source, "worker", "the marker is the worker's answer");
  assert.equal(marker.payload.response.request_id, "rewind-smoke");
  assert.equal(marker.payload.response.response.rewound, true);
  assert.equal(marker.payload.response.response.targetMessageUuid, firstUser.payload.uuid);
  assert.equal(marker.payload.response.response.prefillText, "the opening message",
    "the marker restores the rewound message's text to the composer");

  // An unknown target is a decline, not a silent success.
  const missing = await backend.appendEvents({ sessionId: floorId, body: { events: [{
    payload: { type: "control_request", request_id: "rewind-missing",
      request: { subtype: "rewind_conversation",
        target_message_uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        interrupt_if_running: false } },
  }] } });
  const declined = missing.data.find((event) => event.payload.type === "control_response");
  assert.equal(declined.payload.response.response.rewound, false);
  assert.equal(declined.payload.response.response.reason, "target_not_found");

  // The pending rewind rides the next hint, and the guest clears it once the
  // agent has answered it.
  await backend.releaseSession({
    headers: { authorization: `Bearer ${floorToken.session_token}` }, sessionId: floorId,
  });
  await backend.appendEvents({ sessionId: floorId, body: { events: [{ payload: {
    type: "user", uuid: "dddddddd-4444-4444-8444-444444444444",
    message: { role: "user", content: "after the rewind" } } }] } });
  polled = await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const rewindHint = polled.hints.find((hint) => hint.session_uuid === floorId);
  assert.equal(rewindHint.pending_rewind.request_id, "rewind-smoke");
  assert.equal(rewindHint.pending_rewind.target_message_uuid, firstUser.payload.uuid);
  await backend.recordClaim({
    headers: runnerAuth, sessionId: floorId,
    body: { through_sequence_num: 4, applied_rewind_request_id: "rewind-smoke" },
  });
  await backend.releaseSession({
    headers: { authorization: `Bearer ${floorToken.session_token}` }, sessionId: floorId,
  });
  await backend.appendEvents({ sessionId: floorId, body: { events: [{ payload: {
    type: "user", uuid: "eeeeeeee-5555-4555-8555-555555555555",
    message: { role: "user", content: "one more" } } }] } });
  polled = await backend.pollSpawnHints({ headers: runnerAuth, body: { running: [], claimed: [] } });
  const clearedHint = polled.hints.find((hint) => hint.session_uuid === floorId);
  assert.equal(clearedHint.pending_rewind, undefined,
    "an applied rewind is not carried to a later turn");
  await backend.deleteSession({ sessionId: floorId });

  // Removing the pool takes its runners and stops handing out work.
  await backend.removePool({ poolId: primary.pool_id });
  assert.equal((await backend.listPools()).pools.length, 0);
  assert.equal((await backend.primaryPool()), null);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

// A placement is the thing that wakes the VM. A headless caller — a routine
// fire, the API hook — has no composer to do it, so the store asks itself; and
// while the session is still waiting with no runner online, every reaper pass
// asks again. That is what recovers a wake lost to an idle power-down or a
// Desktop that refused, instead of leaving the run on "Waiting for a runner…"
// until somebody opens a page. (The cooldown is zero here: the smoke drives the
// passes back to back.)
const headlessDir = await mkdtemp(join(tmpdir(), "code-runners-headless-"));
try {
  let headlessWakes = 0;
  const headless = createRunnerBackend({
    stateDir: headlessDir,
    log,
    poolName: "headless",
    wakeCooldownMs: 0,
    wakeRunner: () => { headlessWakes += 1; },
  });
  const headlessPool = await headless.primaryPool();
  await headless.createSession({ body: { environment_id: headlessPool.pool_id } });
  assert.equal(headlessWakes, 1,
    "placing a session wakes the VM without a caller's help");
  await headless.reapNow();
  assert.equal(headlessWakes, 2,
    "a pending session with no online runner keeps asking for its VM");
  const headlessAuth = { authorization: `Bearer ${headlessPool.secret}` };
  await headless.registerRunner({
    headers: headlessAuth, body: { runner_version: "2.1.295" },
  });
  await headless.pollSpawnHints({ headers: headlessAuth });
  await headless.reapNow();
  assert.equal(headlessWakes, 2,
    "once a runner is back, the waiting session stops waking the VM");
} finally {
  await rm(headlessDir, { recursive: true, force: true });
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
// The runner lives in the Cowork VM, and the VM idles out on its own — a
// placed session must be the thing that wakes it, the way the renderer's own
// computer flow does (ClaudeVM.startVM with no config; the main resolves the
// bundle, the wrapper pins the memory).
assert.ok(
  serverSource.includes('desktop.invoke("ClaudeVM", "startVM", [])'),
  "a placed session asks the Desktop to start the Cowork VM its runner lives in",
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

// Where the Code page's live transcript transport is decided: with
// `ccr_v2_subscribe_sse_web` reading off the subscription hook holds the live
// leg over a WebSocket this bridge does not speak — the page then draws
// history on a reload and never streams. A tenant's deployment serves the SSE
// stream, so the gate is forced on outright (the desktop's table carries it
// evaluated false), and the operator's instance is left alone.
const subscribeGrant = section(serverSource, "const ccrSubscribeSseGate",
  "// The renderer's whole remote-place machinery hangs on one flag");
function subscribed(codeRunners, initial = {}) {
  const sandbox = { codeRunnersEnabled: codeRunners };
  vm.runInNewContext(
    `const codeRunnersEnabled = ${codeRunners};
     ${gateKey}
     ${subscribeGrant}
     const document = { growthbook: { features: ${JSON.stringify(initial)} } };
     grantCcrSubscribeSse(document);
     result = document.growthbook.features;`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}
let sseKey = null;
{
  const sandbox = {};
  vm.runInNewContext(`${gateKey}\nresult = growthbookKey("ccr_v2_subscribe_sse_web")`, sandbox);
  sseKey = sandbox.result;
}
assert.equal(subscribed(true)[sseKey]?.defaultValue, true,
  "a tenant's Code page streams over SSE, the transport this bridge serves");
assert.deepEqual(subscribed(false), {},
  "the operator's instance keeps the upstream transport choice");
assert.equal(subscribed(true, { [sseKey]: { value: false } })[sseKey]?.defaultValue, true,
  "an evaluated false is replaced — off means a WebSocket the bridge does not answer");

// And how the transcript hydrates: `ccr_pewter_heron` on makes the view read
// only the newest window and backfill the rest later (which, over this bridge,
// is the page drawing with nothing and then all of the older history landing
// at once). The desktop's table carries it on, so a tenant forces it off and
// the full transcript is part of the initial read.
const tailFirstGate = section(serverSource, "const ccrTailFirstTranscriptGate",
  "// The renderer's whole remote-place machinery hangs on one flag");
function tailFirst(codeRunners, initial = {}) {
  const sandbox = { codeRunnersEnabled: codeRunners };
  vm.runInNewContext(
    `const codeRunnersEnabled = ${codeRunners};
     ${gateKey}
     ${tailFirstGate}
     const document = { growthbook: { features: ${JSON.stringify(initial)} } };
     disableCcrTailFirstTranscript(document);
     result = document.growthbook.features;`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}
let tailFirstKey = null;
{
  const sandbox = {};
  vm.runInNewContext(`${gateKey}\nresult = growthbookKey("ccr_pewter_heron")`, sandbox);
  tailFirstKey = sandbox.result;
}
assert.equal(tailFirst(true)[tailFirstKey]?.defaultValue, false,
  "a tenant hydrates the whole transcript on load, not just the newest window");
assert.deepEqual(tailFirst(false), {},
  "the operator's instance keeps the upstream hydration choice");
assert.equal(tailFirst(true, { [tailFirstKey]: { defaultValue: true } })[tailFirstKey]?.defaultValue,
  false, "the desktop's custom-3p table carries it on; here it is forced off");
assert.ok(
  /bootstrapResponsePath\.test\(url\.pathname\) && disableCcrTailFirstTranscript\(parsed\)/
    .test(serverSource),
  "and the gate is rewritten on the bootstrap the Code page reads",
);

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
  (compose.match(/CLAUDESK_CODE_RUNNERS: "\$\{CLAUDESK_CODE_RUNNERS:-0\}"/g) || []).length, 2,
  "both the Desktop (for the wrapper's VM-side git reads) and the bridge must pass "
  + "CLAUDESK_CODE_RUNNERS through",
);

process.stdout.write("code-runners-smoke: pools, runner polling and byoc environments hold\n");