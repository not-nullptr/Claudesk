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
import { readFile } from "node:fs/promises";
import {
  BRIDGE_ENVIRONMENT_ID,
  bridgeEnvironment,
  eventEnvelopeForEntry,
  eventEnvelopes,
  olderCursorFor,
  pageEvents,
  parseCursor,
  sessionResource,
  sessionResponse,
  toolCallFromUse,
  toolResultOutput,
} from "../mobile/code-transcript.mjs";
import { createCodeEventTranslator, frameFromPayload, isCodeRecord } from "../mobile/code-events.mjs";
import {
  CODE_ID_PREFIX,
  SESSION_STATUS,
  STATUS_BUCKET,
  codeIdFor,
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
assert.equal(row.status, SESSION_STATUS.idle);
assert.equal(row.status_bucket, STATUS_BUCKET.completed);
assert.equal(row.created_at, "2026-10-02T10:00:00.000Z");
// Keys are snake_case for the app's .convertFromSnakeCase decoder.
assert.ok(Object.keys(row).every((key) => key === key.toLowerCase()), "no camelCase keys on the wire");
assert.ok("last_event_at" in row && "session_context" in sessionResource(record));
assert.deepEqual(row.tags, []);
assert.equal(row.unread, true);

const detail = sessionResource(record, { revision: 7 });
assert.equal(detail.session_status, SESSION_STATUS.idle);
assert.equal(detail.permission_mode, "acceptEdits");
assert.equal(detail.session_context.cwd, "/workspace/Claudesk");
assert.equal(detail.revision, 7);
assert.equal(detail.status_bucket, STATUS_BUCKET.completed);

// ---- transcript entries -> envelopes, in order, starting at 0 ----
const envelopes = eventEnvelopes(probe.transcript);
assert.ok(envelopes.length > 0);
assert.deepEqual(
  envelopes.map((envelope) => envelope.sequence_num),
  envelopes.map((_, index) => index),
  "sequence numbers are contiguous from 0",
);
assert.ok(envelopes.every((envelope) => envelope.event_id), "every envelope carries Desktop's entry uuid");
assert.ok(envelopes.every((envelope) => envelope.created_at), "…and its timestamp");
assert.equal(
  new Set(envelopes.map((envelope) => envelope.event_id)).size,
  envelopes.length,
  "event ids are unique",
);
const startSequence = eventEnvelopes(probe.transcript, { startSequence: 100 })[0].sequence_num;
assert.equal(startSequence, 100, "a resuming floor can be supplied");

// The kinds present, and how the app's transcript pane pairs them.
const kinds = new Set(envelopes.map((envelope) => envelope.event_type));
assert.ok(kinds.has("user_message") && kinds.has("assistant_text"), "both sides of a turn are represented");
assert.ok(kinds.has("thinking"), "reasoning is carried");
assert.ok(kinds.has("tool_use") && kinds.has("tool_result"), "tool calls are carried");

// A Desktop entry that is nothing but a stop_reason (no text, no tool) becomes a
// turn-closing `result`. Real transcripts spell that as a final text entry, so it
// is asserted on a synthetic one.
const closing = eventEnvelopeForEntry({ uuid: "u-close", timestamp: "2026-10-02T10:00:00.000Z", message: { role: "assistant", stop_reason: "end_turn" } }, 3);
assert.equal(closing.event_type, "result");
assert.equal(closing.payload.stop_reason, "end_turn");

const humanEnvelope = envelopes.find((envelope) => envelope.event_type === "user_message");
assert.equal(humanEnvelope.source, "human");
assert.equal(humanEnvelope.payload.text, "Reply with exactly one word: pong");
const assistantEnvelopes = envelopes.filter((envelope) => envelope.payload.type === "assistant_text");
assert.ok(assistantEnvelopes.every((envelope) => envelope.source === "assistant"));
assert.equal(assistantEnvelopes[0].payload.text, "pong");

// A tool_use envelope carries the app's rich ToolCall, rendered by blocks.mjs so
// Code and Chat show the same row.
const toolEnvelope = envelopes.find((envelope) => envelope.event_type === "tool_use");
assert.equal(toolEnvelope.payload.tool_call.name, "view", "Read is presented under claude.ai's file-view name");
assert.equal(toolEnvelope.payload.tool_call.display_name, "Read");
assert.equal(toolEnvelope.payload.tool_call.status, "complete");
assert.ok(toolEnvelope.payload.tool_call.input.file_path, "the input summary survives");
assert.deepEqual(toolEnvelope.payload.tool_call.subagent_tool_calls, []);
// A tool_result envelope carries display text and the pairing id.
const resultEnvelope = envelopes.find((envelope) => envelope.event_type === "tool_result");
assert.equal(resultEnvelope.payload.tool_use_id, toolEnvelope.payload.tool_call.id, "the result pairs with the use");
assert.match(resultEnvelope.payload.text, /outside this session's scratch directory/);
assert.equal(resultEnvelope.payload.is_error, true);

// ---- toolCallFromUse / toolResultOutput ----
const bash = toolCallFromUse({ id: "toolu_1", name: "mcp__workspace__bash", input: { command: "ls -la" } }, { status: "running" });
assert.equal(bash.display_name, "Bash");
assert.equal(bash.status, "running");
assert.equal(bash.input.command, "ls -la");
assert.equal(toolCallFromUse({ id: "toolu_2", name: "WebSearch", input: { query: "claude code" } }).display_name, "Web search");
assert.equal(toolResultOutput([{ type: "text", text: "a.txt\nb.txt" }]), "a.txt\nb.txt");
assert.equal(toolResultOutput("plain"), "plain");
// A Write call's whole file is trimmed rather than forwarded at full size.
const big = toolCallFromUse({ id: "toolu_3", name: "Write", input: { file_path: "/tmp/x", content: "y".repeat(9000) } });
assert.ok(big.input.content.length < 9000, "a large tool input is trimmed");

// ---- an empty payload never renders as a blank row ----
assert.equal(eventEnvelopeForEntry({ type: "system", uuid: null }, 0).event_type, "unknown");
assert.equal(eventEnvelopes([{ type: "system", uuid: null }]).length, 0, "a content-free entry produces no envelope");

// ---- cursor round trip and paging ----
const cursor = olderCursorFor(12);
assert.deepEqual(parseCursor(cursor), { v: 1, dir: "older", seq: 12 });
assert.equal(parseCursor("not-base64!!"), null);
assert.equal(parseCursor(Buffer.from(JSON.stringify({ v: 2, dir: "older", seq: 1 })).toString("base64url")), null, "an unknown cursor version is refused");

const numbered = envelopes;
const newest = pageEvents(numbered, { limit: 4 });
assert.equal(newest.data.length, 4);
assert.equal(newest.has_more, true);
assert.equal(newest.data.at(-1).sequence_num, numbered.length - 1, "the newest page ends at the newest event");
assert.equal(newest.next_cursor, olderCursorFor(newest.data[0].sequence_num), "the cursor names the first event not to re-send");

const older = pageEvents(numbered, { cursor: newest.next_cursor, limit: 4 });
assert.equal(older.data.at(-1).sequence_num, newest.data[0].sequence_num - 1, "the older page is contiguous — no gap, no overlap");
const seen = [...older.data, ...newest.data].map((envelope) => envelope.sequence_num);
assert.deepEqual(seen, seen.slice().sort((a, b) => a - b), "concatenating pages stays ascending");

// Walk the whole transcript back to the start.
const walk = [];
let page = pageEvents(numbered, { limit: 3 });
for (;;) {
  walk.unshift(...page.data);
  if (!page.has_more) break;
  page = pageEvents(numbered, { cursor: page.next_cursor, limit: 3 });
}
assert.deepEqual(walk.map((envelope) => envelope.sequence_num), numbered.map((envelope) => envelope.sequence_num));
assert.equal(page.next_cursor, null, "the oldest page has no older cursor");

// Edges: an empty transcript, and a cursor past the end.
assert.deepEqual(pageEvents([], { limit: 10 }), { data: [], next_cursor: null, has_more: false });
assert.deepEqual(pageEvents(numbered, { cursor: olderCursorFor(0), limit: 5 }).data, []);
assert.throws(() => pageEvents(numbered, { cursor: "nonsense" }), /invalid cursor/);
// The page size is clamped rather than trusted.
assert.equal(pageEvents(numbered, { limit: 100000 }).data.length, Math.min(numbered.length, 200));

// ---- live records -> SessionWatchFrame ----
assert.ok(isCodeRecord({ data: { surface: "LocalSessions", method: "onOnEvent" } }));
assert.ok(!isCodeRecord({ data: { surface: "LocalAgentModeSessions", method: "onOnEvent" } }), "a Chat relay is not a Code record");
assert.ok(!isCodeRecord(null));

const translator = createCodeEventTranslator({ sessionId: "s1", startSequence: 40 });
const first = translator.accept({ method: "onOnEvent", payload: probe.transcript[0] });
assert.equal(first.length, 1);
assert.equal(first[0].event, "upserted");
assert.equal(first[0].data.event_type, "user_message");
assert.equal(first[0].data.sequence_num, 40, "the floor is honoured");
assert.equal(translator.resumeFrom(), 41);
// The same entry replayed (Desktop re-sends the tail on reconnect) keeps its
// original sequence number, so the app's pager does not rewrite history.
const replay = translator.accept({ method: "onOnEvent", payload: probe.transcript[0] });
assert.equal(replay[0].data.sequence_num, 40);
assert.equal(translator.resumeFrom(), 41, "a replay does not advance the counter");
// The next distinct entry advances.
assert.equal(translator.accept({ method: "onOnEvent", payload: probe.transcript[1] })[0].data.sequence_num, 41);

// A removal is a deletion frame, never an upsert of an empty row.
const removed = translator.accept({ method: "onOnEvent", payload: { removed: true, entry: { uuid: "u-gone" } } });
assert.deepEqual(removed, [{ event: "deleted", data: { session_id: null, event_id: "u-gone" } }]);
// Nothing renderable produces no frame at all.
assert.deepEqual(translator.accept({ method: "onOnEvent", payload: { entry: { type: "system" } } }), []);
assert.deepEqual(translator.accept({ method: "onOnEvent", payload: null }), []);
assert.deepEqual(translator.accept({ method: "onOnSomethingElse", payload: probe.transcript[0] }), []);

// A permission prompt is recorded rather than drawn, and answering clears it.
const prompt = { requestId: "req-1", sessionId: "s1", toolName: "Bash", input: { command: "ls" } };
assert.deepEqual(translator.accept({ method: "onOnToolPermissionRequest", payload: prompt }), []);
assert.deepEqual(translator.permissions(), [prompt]);
assert.equal(translator.resolvePermission("req-1"), true);
assert.deepEqual(translator.permissions(), []);

// ---- the bridge environment offered as a runner ----
const environment = bridgeEnvironment({ name: "Claudesk Desktop", cliVersion: "2.1.284" });
assert.equal(environment.kind, "bridge");
assert.equal(environment.environment_id, BRIDGE_ENVIRONMENT_ID);
assert.equal(environment.bridge_info.spawn_mode, "same-dir");
assert.equal(environment.bridge_info.cli_version, "2.1.284");
assert.equal(environment.state, "active");
assert.equal(bridgeEnvironment({ online: false }).state, "unknown");

console.log("code-events-smoke: ok");
