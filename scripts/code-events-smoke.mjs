#!/usr/bin/env node
// Offline unit tests for the Code translators (mobile/code-transcript.mjs) and
// the id/enum derivations they build on (mobile/code-ids.mjs).
//
// The transcript cases run against the fixture recorded from a live Claudesk
// bridge (scripts/fixtures/desktop-chat-probe.json — a Chat session, but the
// transcript entry format is the LocalSessions one the Code surface reads, and
// it deliberately contains thinking, a refused tool call and a tool result).
// Anything the probe still has to settle is covered with a synthetic record.
import assert from "node:assert/strict";
import { decodeClientEvent, decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";
import { readFile } from "node:fs/promises";
import {
  BRIDGE_ENVIRONMENT_ID,
  CLOUD_ENVIRONMENT_ID,
  bridgeEnvironment,
  channelEmptyPage,
  channelMessageForEnvelope,
  channelResource,
  cloudEnvironment,
  eventEnvelopeForEntry,
  eventEnvelopes,
  olderCursorFor,
  pageEvents,
  parseCursor,
  sessionResource,
  sessionResponse,
  sseFrameForEntry,
  streamJsonFor,
} from "../mobile/code-transcript.mjs";
import { createCodeEventTranslator, frameFromPayload, isCodeRecord, watchFrameFromPayload } from "../mobile/code-events.mjs";
import {
  CODE_ID_PREFIX,
  SESSION_LIFECYCLE_STATUS,
  SESSION_STATUS,
  SESSION_WORKER_STATUS,
  STATUS_BUCKET,
  WORKER_STATUS,
  codeIdFor,
  resourceWorkerStatusOf,
  desktopSessionIdFor,
  isCodeId,
  sessionStatusOf,
  statusBucketOf,
} from "../mobile/code-ids.mjs";

const probe = JSON.parse(await readFile(new URL("./fixtures/desktop-chat-probe.json", import.meta.url), "utf8"));

// ---- ids ----
assert.equal(codeIdFor("abc-123"), "code_abc-123");
assert.equal(desktopSessionIdFor("code_abc-123"), "abc-123");
assert.equal(desktopSessionIdFor("local_abc-123"), null, "a Chat id is not a Code id");
assert.ok(isCodeId(codeIdFor("x")));
assert.ok(!isCodeId(CODE_ID_PREFIX), "the bare prefix is not an id");
// The bridge's own sessionId charset (realtime.mjs) must accept a Code id.
assert.match(codeIdFor("0f5c3a2e-1111-2222-3333-444455556666"), /^[A-Za-z0-9_-]+$/);

// ---- enum values are literal, and the derivations are total ----
for (const status of Object.values(SESSION_STATUS)) {
  assert.ok(Object.values(STATUS_BUCKET).includes(statusBucketOf(status)), `bucket for ${status}`);
}
assert.equal(statusBucketOf(SESSION_STATUS.requiresAction), STATUS_BUCKET.blocked);
assert.equal(statusBucketOf(SESSION_STATUS.running), STATUS_BUCKET.working);
assert.equal(statusBucketOf(SESSION_STATUS.idle), STATUS_BUCKET.completed);
assert.equal(sessionStatusOf({ isRunning: true }), SESSION_STATUS.running);
// Desktop has both `isRunning` (process live) and `turnRunning` (turn in
// flight). A warm session with no turn in flight reads as idle, not running.
assert.equal(sessionStatusOf({ isRunning: true, turnRunning: true }), SESSION_STATUS.running);
assert.equal(sessionStatusOf({ isRunning: true, turnRunning: false }), SESSION_STATUS.idle, "a warm session with no turn in flight is idle");
assert.equal(sessionStatusOf({ isArchived: true }), SESSION_STATUS.archived);
assert.equal(sessionStatusOf({}), SESSION_STATUS.idle);
assert.equal(sessionStatusOf({}, { pendingApproval: true }), SESSION_STATUS.requiresAction, "an open prompt outranks a running worker");

// ---- one Desktop record -> SessionResponse / SessionResource ----
const record = {
  sessionId: "d1f2e3a4-0000-1111-2222-333344445555",
  title: "Fix the flaky test",
  cwd: "/workspace/Claudesk",
  model: "claude-sonnet-5-5",
  permissionMode: "acceptEdits",
  effort: "high",
  createdAt: Date.parse("2026-10-02T10:00:00.000Z"),
  lastActivityAt: Date.parse("2026-10-02T10:05:00.000Z"),
  isRunning: false,
};
const row = sessionResponse(record, { meta: { unread: true } });
assert.equal(row.id, "code_d1f2e3a4-0000-1111-2222-333344445555");
assert.equal(desktopSessionIdFor(row.id), record.sessionId, "the desktop id survives the round trip");
assert.equal(row.environment_id, BRIDGE_ENVIRONMENT_ID);
assert.equal(row.environment_kind, "bridge", "enum values are literal, never snake-cased keys");
// The row's `status` is the lifecycle axis, not the rich SessionStatus the
// detail record reports.
assert.equal(row.status, SESSION_LIFECYCLE_STATUS.active);
assert.equal(sessionResponse({ ...record, isArchived: true }).status, SESSION_LIFECYCLE_STATUS.archived);
assert.equal(row.status_bucket, STATUS_BUCKET.completed);
assert.equal(row.created_at, "2026-10-02T10:00:00.000Z");
// Keys are snake_case for the app's .convertFromSnakeCase decoder.
assert.ok(Object.keys(row).every((key) => key === key.toLowerCase()), "no camelCase keys on the wire");
assert.ok("last_event_at" in row && "session_context" in sessionResource(record));
assert.deepEqual(row.tags, []);
assert.equal(row.unread, true);

// `revision` is a `Foundation.Date?` on the wire, not a change counter: an
// integer there fails the decode of the whole `SessionResource`. A numeric
// millisecond input is emitted as ISO-8601, like every other Date on this DTO.
const revisionMs = 1759396800000;
const detail = sessionResource(record, { revision: revisionMs });
assert.equal(detail.session_status, SESSION_STATUS.idle);
assert.equal(detail.permission_mode, "acceptEdits");
assert.equal(detail.session_context.cwd, "/workspace/Claudesk");
assert.equal(detail.revision, new Date(revisionMs).toISOString());
assert.equal(detail.status_bucket, STATUS_BUCKET.completed);
// The detail record's worker axis is WorkerStatus (processing | idle) — a
// running turn is `processing`, and `running` is not a case it has. The row
// keeps the richer SessionWorkerStatus.
assert.equal(detail.worker_status, WORKER_STATUS.idle);
assert.equal(row.worker_status, SESSION_WORKER_STATUS.idle);
const runningRecord = { ...record, isRunning: true, turnRunning: true };
assert.equal(sessionResource(runningRecord).worker_status, WORKER_STATUS.processing);
assert.equal(sessionResponse(runningRecord).worker_status, SESSION_WORKER_STATUS.running);
assert.equal(
  sessionResource(record, { pendingApproval: true }).worker_status,
  WORKER_STATUS.processing,
  "an open prompt is processing on the detail axis",
);
assert.equal(resourceWorkerStatusOf({}, { pendingApproval: true }), WORKER_STATUS.processing);
// SessionResource.connectionStatus has no unspecified/unknown case.
assert.equal(sessionResource({ ...record, connectionStatus: "unknown" }).connection_status, "connected");

// ---- independently recovered wire contract ----
const envelopes = eventEnvelopes(probe.transcript);
const decoded = decodeClientEventsResponse({ data: envelopes, next_cursor: null });
assert.equal(decoded.length, probe.transcript.length);
assert.deepEqual(envelopes.map((event) => event.sequence_num), envelopes.map((_, i) => String(i + 1)));
assert.equal(eventEnvelopes(probe.transcript, { startSequence: 100 })[0].sequence_num, "100");
assert.throws(() => eventEnvelopeForEntry(probe.transcript[0], 0), /positive/);
assert.throws(() => decodeClientEvent({ ...envelopes[0], sequence_num: 1 }), /String/);
assert.throws(() => decodeClientEvent({ ...envelopes[0], sequence_num: "0" }), /zero/);
// These were the two old responses. Neither is a wire SessionEventEnvelope.
assert.throws(() => decodeClientEventsResponse({ data: [{ sequence_num: 0, message: { user: probe.transcript[0] } }] }));
assert.throws(() => decodeClientEvent({ client_event: { sdk_message: { user: probe.transcript[0] } } }));

assert.equal(decoded[0].message.type, "user");
assert.equal(decoded[0].message.message.content, "Reply with exactly one word: pong");
assert.equal(decoded.find((row) => row.message.type === "assistant" && row.message.message.content.some((block) => block.type === "text")).message.message.content.find((block) => block.type === "text").text, "pong");
for (let i = 0; i < envelopes.length; i++) {
  assert.equal(envelopes[i].event_type, probe.transcript[i].type);
  assert.deepEqual(envelopes[i].payload.message, probe.transcript[i].message, "all content blocks survive intact");
  assert.deepEqual(sseFrameForEntry(probe.transcript[i], i + 1).data, envelopes[i], "history and SSE share the exact wire payload");
}
const blocks = decoded.flatMap((row) => Array.isArray(row.message.message?.content) ? row.message.message.content : []);
assert.ok(blocks.some((block) => block.type === "thinking"));
const use = blocks.find((block) => block.type === "tool_use");
const result = blocks.find((block) => block.type === "tool_result");
assert.ok(use && result);
assert.equal(use.name, "Read", "Code uses SDK tool names, not Chat's translated names");
assert.equal(result.tool_use_id, use.id);

const raw = { type: "assistant", uuid: "a1", parent_tool_use_id: "tool-parent", isReplay: true,
  message: { role: "assistant", content: [{ type: "tool_use", name: "Task", input: { camelCaseKey: 1 } }] } };
const sdk = streamJsonFor(raw);
assert.equal(sdk.parent_tool_use_id, "tool-parent", "snake_case SDK fields are retained");
assert.equal(sdk.is_replay, true, "Desktop camelCase fields are normalized");
assert.deepEqual(sdk.message.content[0].input, { camelCaseKey: 1 }, "arbitrary tool dictionaries are not rewritten");
assert.equal(sdk.assistant, undefined, "SdkMessage is not a single-key enum wrapper");
assert.equal(streamJsonFor({ type: "result", duration_ms: 42, is_error: false }).duration_ms, 42);
assert.equal(streamJsonFor({ uuid: "r1", message: { type: "result", subtype: "success", duration_ms: 42 } }).uuid, "r1");
assert.equal(streamJsonFor({ type: "system", subtype: "init" }).type, "system");
assert.equal(streamJsonFor({ type: "future_sdk_type", uuid: "x" }).type, "future_sdk_type");
assert.deepEqual(eventEnvelopes([{ type: "system" }]), []);
const updated = { ...probe.transcript[0], isReplay: true };
const deduped = eventEnvelopes([probe.transcript[0], probe.transcript[1], updated]);
assert.equal(deduped.length, 2);
assert.equal(deduped[0].sequence_num, "1");
assert.equal(deduped[0].payload.is_replay, true);

// ---- pagination, including string sequence numbers crossing 9 -> 10 ----
assert.deepEqual(parseCursor(olderCursorFor(12)), { v: 1, dir: "older", seq: 12 });
assert.equal(parseCursor("not-base64!!"), null);
const walk = [];
let page = pageEvents(envelopes, { limit: 3 });
for (;;) {
  walk.unshift(...page.data);
  if (!page.has_more) break;
  page = pageEvents(envelopes, { cursor: page.next_cursor, limit: 3 });
}
assert.deepEqual(walk, envelopes, "walking pages gives every event once");
assert.equal(page.next_cursor, null);
assert.deepEqual(pageEvents([], { limit: 10 }), { data: [], next_cursor: null, has_more: false });
assert.deepEqual(pageEvents(envelopes, { cursor: olderCursorFor(1), limit: 5 }).data, []);
assert.throws(() => pageEvents(envelopes, { cursor: "nonsense" }), /invalid cursor/);
const large = Array.from({ length: 1200 }, (_, i) => ({ sequence_num: String(i + 1) }));
assert.equal(pageEvents(large, { limit: 500 }).data.length, 500);
assert.equal(pageEvents(large, { limit: 100000 }).data.length, 1000);

// ---- seeded live numbering, replay, and simultaneous subscribers ----
assert.ok(isCodeRecord({ data: { surface: "LocalSessions" } }));
assert.ok(!isCodeRecord({ data: { surface: "LocalAgentModeSessions" } }));
const translator = createCodeEventTranslator();
translator.seed(envelopes);
const replay = translator.accept({ method: "onOnEvent", payload: probe.transcript[0] })[0];
assert.deepEqual(replay.data, envelopes[0]);
assert.equal(translator.resumeFrom(), envelopes.length + 1);
const next = { ...probe.transcript[0], uuid: "next" };
const liveRecord = { method: "onOnEvent", payload: { entry: next } };
const frame = translator.accept(liveRecord)[0];
assert.equal(frame.data.sequence_num, String(envelopes.length + 1));
assert.equal(decodeClientEvent(frame.data).message.uuid, "next");
assert.deepEqual(translator.accept(liveRecord)[0], frame, "a second listener receives the same sequence");
translator.acceptWatch(liveRecord);
assert.equal(translator.resumeFrom(), envelopes.length + 2, "watch does not consume an extra sequence");
assert.deepEqual(frameFromPayload("onOnEvent", { removed: true, entry: next }), []);
assert.deepEqual(frameFromPayload("onOnEvent", { type: "system" }), []);
assert.deepEqual(frameFromPayload("onOnSomethingElse", next), []);
assert.equal(watchFrameFromPayload("onOnEvent", next)[0].event, "upserted");
assert.equal(watchFrameFromPayload("onOnEvent", { removed: true, entry: next })[0].event, "deleted");
// `SessionWatchEvent` is `upserted(SessionResource) | deleted(SessionTag)`: the
// list leg's `data` is the case payload, so `upserted` carries a whole
// SessionResource (built by the engine, which alone has the record) and
// `deleted` the session's tagged id string — not a transcript envelope.
const upsertPayload = { id: "code_s1", status: "idle" };
assert.deepEqual(
  watchFrameFromPayload("onOnEvent", next, 1, { sessionId: "s1", resourceFor: () => upsertPayload })[0].data,
  upsertPayload,
);
assert.equal(watchFrameFromPayload("onOnEvent", { removed: true, entry: next }, 1, { sessionId: "s1" })[0].data, "code_s1");
const prompt = { requestId: "req-1", sessionId: "s1", toolName: "Bash", input: { command: "ls" } };
assert.deepEqual(translator.accept({ method: "onOnToolPermissionRequest", payload: prompt }), []);
assert.deepEqual(translator.permissions(), [prompt]);
assert.equal(translator.resolvePermission("req-1"), true);
assert.deepEqual(translator.permissions(), []);

const environment = bridgeEnvironment({ name: "Claudesk Desktop", cliVersion: "2.1.284" });
assert.equal(environment.kind, "bridge");
assert.equal(environment.environment_id, BRIDGE_ENVIRONMENT_ID);
assert.equal(environment.bridge_info.spawn_mode, "sameDir");
// `config` is a Swift enum with associated values, so its payload nests under
// the case name — a flat `config` at this level fails to decode the resource.
assert.deepEqual(Object.keys(environment.config), ["paired"]);
// The inner `environmentType` is a `ConfigType` — anthropic | byoc | bridge |
// unknown, with NO `paired` case — so the paired payload reports `bridge`. A
// literal `"paired"` fails the whole `EnvironmentConfiguration` and drops the
// row (and, all-or-nothing, every other row of the list).
assert.equal(environment.config.paired._0.environment_type, "bridge");
assert.equal(bridgeEnvironment({ online: false }).state, "unknown");

// ---- the cloud environment offered as the picker's "Cloud environments" row --
// The picker splits the list by kind into "Cloud environments" (anthropicCloud)
// and "Remote control" (bridge). A bridge-only list leaves the cloud section
// empty, which is the "Create a cloud environment to get started" onboarding
// state that blocks starting a session.
const cloud = cloudEnvironment({ name: "Claudesk Desktop" });
assert.equal(cloud.kind, "anthropicCloud");
assert.equal(cloud.environment_id, CLOUD_ENVIRONMENT_ID);
assert.deepEqual(Object.keys(cloud.config), ["anthropic"], "the case name is the only key");
// The case name's value is the nested container of associated values, keyed
// `_0` for the single unlabelled payload (SE-0295).
assert.deepEqual(Object.keys(cloud.config.anthropic), ["_0"]);
assert.equal(cloud.config.anthropic._0.environment_type, "anthropic");
// `bridgeInfo` is not *read* for a cloud row (the app classifies by `kind`),
// but it is still *decoded* whatever the kind, and the list decodes
// all-or-nothing. A struct-typed property fails to decode only when the value
// is `null` and the property is non-optional; a well-formed object decodes
// either way. So the cloud record carries one too rather than risking the
// whole `[EnvironmentResource]` on a null.
assert.equal(cloud.bridge_info.machine_name, "Claudesk Desktop");
assert.equal(cloud.bridge_info.spawn_mode, "sameDir");
assert.ok(Number.isFinite(Date.parse(cloud.created_at)), "createdAt is a non-null ISO date");
// The same "never null an unconfirmed-optional field" rule applies to the
// anthropic config's network settings; a null here would fail a non-optional
// `CCRNetworkConfig` and drop the row.
assert.deepEqual(cloud.config.anthropic._0.network_config, { allowed_hosts: [], allow_default_hosts: true });
assert.equal(cloud.state, "active");
assert.equal(cloudEnvironment({ online: false }).state, "unknown");
// The two advertised records are distinct ids, so a session can name either.
assert.notEqual(CLOUD_ENVIRONMENT_ID, BRIDGE_ENVIRONMENT_ID);

// A session created against the cloud row reports the cloud environment and
// kind; one with no recorded environment keeps the bridge default.
const cloudSession = sessionResource({ sessionId: "s1", title: "t" }, {
  meta: { environment_id: CLOUD_ENVIRONMENT_ID },
});
assert.equal(cloudSession.environment_id, CLOUD_ENVIRONMENT_ID);
assert.equal(cloudSession.environment_kind, "anthropicCloud");
const bridgeSession = sessionResponse({ sessionId: "s2" }, { meta: {} });
assert.equal(bridgeSession.environment_id, BRIDGE_ENVIRONMENT_ID);
assert.equal(bridgeSession.environment_kind, "bridge");

// ---- channels: the conversation addressed as a claude.ai channel ----
// A ChannelMessage must carry every field its decoder declares non-optional
// (id, in_timeline, server_notice, attachments, participant_account_ids). The
// channel pages must likewise carry the non-optional keys of each response type,
// or an empty state still fails to decode on device.
const channelEnvelope = eventEnvelopeForEntry({
  uuid: "u-1", type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
}, 1);
const channelMessage = channelMessageForEnvelope(channelEnvelope, { channelId: codeIdFor("d1") });
assert.ok(channelMessage, "a text turn maps to a ChannelMessage");
assert.equal(channelMessage.id, "u-1");
assert.equal(channelMessage.body, "hello there");
assert.equal(channelMessage.in_timeline, true);
assert.equal(channelMessage.server_notice, false);
assert.deepEqual(channelMessage.attachments, []);
assert.deepEqual(channelMessage.participant_account_ids, []);
assert.ok(Number.isFinite(Date.parse(channelMessage.created_at)), "createdAt is an ISO date");
// A tool-only turn has no display text and is not a timeline message.
assert.equal(channelMessageForEnvelope(eventEnvelopeForEntry({
  uuid: "u-2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
}, 2)), null);
// Every channel read answers the keys its response type declares non-optional.
const pageKeys = (page, keys) => keys.every((key) => key in page);
assert.ok(pageKeys(channelEmptyPage("threads"), ["sections"]));
assert.ok(pageKeys(channelEmptyPage("pull_requests"), ["data", "next_cursor", "total", "truncated", "source"]));
assert.ok(pageKeys(channelEmptyPage("artifacts"), ["data", "next_cursor", "total", "truncated"]));
assert.ok(pageKeys(channelEmptyPage("files"), ["entries", "next_cursor"]));
assert.ok(pageKeys(channelEmptyPage("messages"), ["data", "next_cursor"]));
assert.equal(channelEmptyPage("pull_requests").source, "unspecified");
// Channel = {storage, name}; both non-optional.
const channel = channelResource("code_d1");
assert.ok("storage" in channel && "name" in channel);

console.log("code-events-smoke: ok");
