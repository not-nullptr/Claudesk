// Translation from Desktop's Claude Code session objects to the claude.ai
// "Code" DTOs the iOS app decodes. Nothing here talks to the network; it is the
// pure half of the Code surface, so it can be unit-tested against a recorded
// probe fixture (scripts/fixtures/desktop-code-probe.json).
//
// Two casing rules, both proven in docs/mobile-code-re-findings.md:
//   - dictionary keys are snake_case (the app's JSONDecoder runs
//     `.convertFromSnakeCase`), and
//   - enum *values* are literal strings, because the key strategy never
//     touches them.
//
// The tool rendering deliberately reuses blocks.mjs: Desktop's Code tool names
// (Bash/Read/Write/Edit/Glob/Grep/WebSearch/...) are the same catalog the Chat
// surface already maps, so tool rows look identical on both tabs.

import { describeTool, resultText, trimInput } from "./blocks.mjs";
import { isHumanEntry, splitMentions } from "./transcript.mjs";
import {
  BRIDGE_SPAWN_MODE,
  ENVIRONMENT_KIND,
  codeIdFor,
  connectionStatusOf,
  sessionStatusOf,
  statusBucketOf,
  workerStatusOf,
} from "./code-ids.mjs";

// The single "environment" a self-hosted Desktop presents: the paired bridge.
// The app lists it under Devices and lets a session be created against it.
export const BRIDGE_ENVIRONMENT_ID = "anthropic-bridge-local";

export function bridgeEnvironment({ name = "Claudesk Desktop", online = true, cliVersion = null } = {}) {
  return {
    kind: ENVIRONMENT_KIND.bridge,
    environment_id: BRIDGE_ENVIRONMENT_ID,
    name,
    created_at: null,
    state: online ? "active" : "unknown",
    config: {
      environment_type: "paired",
      machine_name: name,
      directory: "/workspace",
      branch: null,
      git_repo_url: null,
    },
    bridge_info: {
      max_sessions: 1,
      machine_name: name,
      directory: "/workspace",
      branch: null,
      git_repo_url: null,
      online,
      spawn_mode: BRIDGE_SPAWN_MODE.sameDir,
      cli_version: cliVersion,
    },
  };
}

function iso(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function desktopIdOf(record) {
  return record?.sessionId ?? record?.session_id ?? record?.id ?? null;
}

// The list row (ListSessionsResponse.data[]). `SessionResponse` is 23 fields;
// the ones a self-hosted Desktop does not have are emitted as null/[] so the
// app's non-optional decodes still succeed.
export function sessionResponse(record, { meta = {}, pendingApproval = false } = {}) {
  const status = sessionStatusOf(record, { pendingApproval });
  return {
    id: codeIdFor(desktopIdOf(record)),
    environment_id: BRIDGE_ENVIRONMENT_ID,
    environment_kind: ENVIRONMENT_KIND.bridge,
    title: record?.title || record?.name || "Untitled session",
    status,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    config: {
      sources: [],
      outcomes: [],
      model: record?.model ?? null,
      permission_mode: record?.permissionMode ?? null,
      effort_level: record?.effort ?? null,
      origin: null,
      memory_mode: null,
    },
    worker_status: workerStatusOf(record, { pendingApproval }),
    connection_status: connectionStatusOf(record),
    external_metadata: null,
    created_at: iso(record?.createdAt),
    last_event_at: iso(record?.lastActivityAt),
    updated_at: iso(record?.lastActivityAt ?? record?.createdAt),
    post_turn_summary: null,
    task_summary: null,
    unread: Boolean(meta.unread),
    self_hosted_runner_pool_id: null,
    self_hosted_runner_state: null,
    agent_id: null,
    trigger_id: null,
    bound_device: null,
    status_bucket: statusBucketOf(status),
    connector_domains_withheld: [],
  };
}

// The detail record (GET /v1/code/sessions/{id}). `SessionResource` adds the
// context, permission mode, spawn path and a revision counter.
export function sessionResource(record, { meta = {}, revision = 0, pendingApproval = false } = {}) {
  const status = sessionStatusOf(record, { pendingApproval });
  return {
    id: codeIdFor(desktopIdOf(record)),
    title: record?.title || record?.name || "Untitled session",
    session_status: status,
    environment_id: BRIDGE_ENVIRONMENT_ID,
    environment_kind: ENVIRONMENT_KIND.bridge,
    created_at: iso(record?.createdAt),
    updated_at: iso(record?.lastActivityAt ?? record?.createdAt),
    session_context: {
      sources: [],
      cwd: record?.cwd ?? null,
      outcomes: [],
      custom_system_prompt: null,
      append_system_prompt: null,
      model: record?.model ?? null,
      effort_level: record?.effort ?? null,
      memory_mode: null,
    },
    permission_mode: record?.permissionMode ?? "default",
    bridge_spawn_path: record?.spawnMode ?? BRIDGE_SPAWN_MODE.sameDir,
    connection_status: connectionStatusOf(record),
    worker_status: workerStatusOf(record, { pendingApproval }),
    post_turn_summary: null,
    external_metadata: null,
    unread: Boolean(meta.unread),
    task_summary: null,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    agent_id: null,
    self_hosted_runner_pool_id: null,
    self_hosted_runner_state: null,
    trigger_id: null,
    origin: null,
    bound_device: null,
    status_bucket: statusBucketOf(status),
    revision,
    connector_domains_withheld: [],
  };
}

// ---- tools -----------------------------------------------------------------

// Desktop's tool_use -> the app's rich ToolCall. `displayName` and the input
// summary come from blocks.mjs so Code and Chat render identically.
export function toolCallFromUse(use, { status = "complete", output = null, startedAt = null } = {}) {
  const tool = describeTool(use?.name, use?.input);
  return {
    id: use?.id ?? null,
    name: tool.restName,
    display_name: tool.displayName,
    integration_icon_url: null,
    status,
    input: trimInput(use?.input ?? {}),
    tool_input: trimInput(use?.input ?? {}),
    raw_input: trimInput(use?.input ?? {}, 1),
    output,
    output_images: [],
    subagent_tool_calls: [],
    result_attachments: [],
    dispatch_task: null,
    file_write_kind: null,
    git_operation: null,
    file_metadata: null,
    artifact_id: null,
    artifact_title: null,
    is_background_launch_ack: false,
    subagent_usage: null,
    subagent_report_warning: null,
    started_at: startedAt,
  };
}

// The paired tool_result content, as display text.
export function toolResultOutput(content) {
  return resultText(content).text;
}

// ---- transcript entries -> SessionEventEnvelope[] ---------------------------

const MAX_PAYLOAD_TEXT = 100000;

function clampText(text) {
  const value = String(text ?? "");
  return value.length > MAX_PAYLOAD_TEXT ? `${value.slice(0, MAX_PAYLOAD_TEXT)}…` : value;
}

function contentBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

// One Desktop transcript entry becomes one SessionEventEnvelope. The payload
// carries the same block shapes the REST stream uses, so the app's transcript
// pane renders a Code turn exactly like a Chat one.
export function eventEnvelopeForEntry(entry, sequenceNum) {
  const base = {
    event_id: entry?.uuid ?? null,
    sequence_num: sequenceNum,
    event_type: "unknown",
    source: isHumanEntry(entry) ? "human" : "assistant",
    payload: {},
    created_at: entry?.timestamp ?? null,
  };
  if (isHumanEntry(entry)) {
    const { text, files } = splitMentions(contentBlocks(entry).map((block) => block?.text ?? "").join("\n"));
    return {
      ...base,
      event_type: "user_message",
      payload: { type: "user_message", text: clampText(text), files, client_message_id: entry?.uuid ?? null },
    };
  }
  const blocks = contentBlocks(entry);
  const toolResult = blocks.find((block) => block?.type === "tool_result");
  const toolUse = blocks.find((block) => block?.type === "tool_use");
  const thinking = blocks.find((block) => block?.type === "thinking" && block.thinking);
  const text = blocks.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  if (toolUse) {
    return { ...base, event_type: "tool_use", payload: { type: "tool_use", tool_call: toolCallFromUse(toolUse) } };
  }
  if (toolResult) {
    return {
      ...base,
      event_type: "tool_result",
      payload: {
        type: "tool_result",
        tool_use_id: toolResult.tool_use_id ?? null,
        text: clampText(toolResultOutput(toolResult.content)),
        is_error: Boolean(toolResult.is_error),
      },
    };
  }
  if (text) {
    return { ...base, event_type: "assistant_text", payload: { type: "assistant_text", text: clampText(text) } };
  }
  if (thinking) {
    return { ...base, event_type: "thinking", payload: { type: "thinking", thinking: clampText(thinking.thinking) } };
  }
  // A result-bearing entry closes the turn.
  if (entry?.message?.stop_reason) {
    return {
      ...base,
      event_type: "result",
      payload: { type: "result", stop_reason: entry.message.stop_reason },
    };
  }
  return base;
}

// ---- transcript entries -> SessionSseFrame (the LIVE leg) -------------------
//
// The paged history read above answers with `SessionEventEnvelope`s, but the
// leg the session detail screen actually opens (GET …/events/stream) speaks a
// DIFFERENT protocol: `SessionStreamWire` -> `SessionSseFrame`, a 6-case Swift
// enum decoded from each SSE record's JSON body with a single-key envelope:
//
//   {"client_event": {"sdk_message": <SdkMessage>}}
//
// The app's decoder runs `.convertFromSnakeCase`, so the camelCase `CodingKeys`
// (`clientEvent`, `sdkMessage`) are what it looks for as `client_event` /
// `sdk_message` on the wire (recovered from the binary: the CodingKeys cluster
// at reflstr 0x4ba37f0 and the `client_event`/`ephemeral_event` small-strings
// the SSE dispatcher compares the `event:` name against). The payload is a real
// Claude Code stream-json message, not a bespoke shape.

// One Desktop transcript entry -> the `SdkMessage` case that carries it. The
// Desktop entry already IS the stream-json message for user/assistant turns
// (`{parentUuid, isSidechain, type, message, uuid, timestamp, origin}`), so
// this is a rename-and-pick, not a translation: the app's Sdk*Message structs
// declare the same fields.
export function streamJsonFor(entry) {
  const type = entry?.type;
  const messageType = entry?.message?.type;
  if (type === "user") return { user: pick(entry, SDK_USER_FIELDS) };
  if (type === "assistant") return { assistant: pick(entry, SDK_ASSISTANT_FIELDS) };
  if (type === "system") return { system: pick(entry, SDK_SYSTEM_FIELDS) };
  if (messageType === "result" || entry?.subtype) {
    return { result: pick(entry.message ?? entry, SDK_RESULT_FIELDS) };
  }
  // Anything Desktop relays that the app has no case for still travels as
  // `unknown` rather than being dropped, so a transcript never loses a row.
  return { unknown: entry ?? null };
}

// A whole entry -> the SSE record the transcript leg emits.
// @returns {{ event: "client_event", data: { client_event: object } }}
export function sseFrameForEntry(entry) {
  return { event: "client_event", data: { client_event: { sdk_message: streamJsonFor(entry) } } };
}

// Copy only the declared fields. An absent field is omitted rather than
// nulled, so a key the app declares as optional is simply not present (the
// Swift decoder treats a missing key and an explicit `null` differently, and an
// omitted optional is the safe one).
function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    const value = source?.[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// Field names as the Sdk*Message structs declare them (from the type
// descriptors); the decoder's key strategy accepts them verbatim.
const SDK_USER_FIELDS = [
  "type", "uuid", "message", "parentToolUseId", "isMeta", "isSynthetic",
  "isVisibleInTranscriptOnly", "toolUseResult", "fileAttachments", "timestamp",
  "createdAt", "isReplay", "origin",
];
const SDK_ASSISTANT_FIELDS = [
  "type", "uuid", "message", "parentToolUseId", "isMeta", "isSynthetic", "error",
  "isReplay", "isApiErrorMessage", "apiError", "contextUsage", "usageReport",
  "localCommandSource", "toolUseMeta", "narrationBlockIndexes", "timestamp", "createdAt",
];
const SDK_SYSTEM_FIELDS = ["type", "uuid", "subtype", "apiKeySource", "cwd", "timestamp"];
const SDK_RESULT_FIELDS = [
  "type", "uuid", "subtype", "durationMs", "durationApiMs", "isError", "numTurns",
  "totalCostUsd", "usage", "permissionDenials", "result", "isReplay",
  "userMessageUuid", "queuedTurnCount",
];

// Apply the SAME sequence number to every envelope produced from one entry, so
// the app's pager (a floor of sequence numbers) sees them atomically. Envelopes
// are returned ascending in transcript order.
export function eventEnvelopes(entries, { startSequence = 0 } = {}) {
  const out = [];
  let sequence = startSequence;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const envelope = eventEnvelopeForEntry(entry, sequence);
    // Skip entries that carry nothing to render (e.g. a bare system entry),
    // WITHOUT advancing the counter — so `sequence_num` is a dense index both
    // this paged read and the transcript stream agree on.
    if (!isRenderableEnvelope(envelope)) continue;
    out.push(envelope);
    sequence += 1;
  }
  return out;
}

// Whether an envelope carries something to render. A bare system/stub entry
// does not. Both legs share this rule so `from_sequence_num` means one thing.
export function isRenderableEnvelope(envelope) {
  return envelope.event_type !== "unknown" || Boolean(envelope.event_id);
}

// The same rule, applied to a raw entry, for a caller that streams entries
// directly (the transcript leg) rather than pre-built envelopes.
export function isRenderableEntry(entry) {
  return isRenderableEnvelope(eventEnvelopeForEntry(entry, 0));
}

// ---- paging ----------------------------------------------------------------

// The app reads events ASCENDING above a floor and pages OLDER on demand, so a
// cursor always means "the page strictly before this sequence number". The
// cursor is opaque to the client (base64url JSON), which lets the format change
// without an app update.
export function olderCursorFor(sequenceNum) {
  const payload = JSON.stringify({ v: 1, dir: "older", seq: sequenceNum });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function parseCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed.dir !== "older" || !Number.isInteger(parsed.seq)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function invalidCursor() {
  const error = new Error("invalid cursor");
  error.status = 400;
  error.type = "invalid_request_error";
  return error;
}

/**
 * A window of the transcript, newest-first read.
 *
 * With no cursor the newest `limit` envelopes are returned. With a cursor the
 * window ends just below the cursor's sequence number. `next_cursor` is null
 * once the oldest envelope has been included.
 *
 * @returns {{ data: object[], next_cursor: string | null, has_more: boolean }}
 */
export function pageEvents(envelopes, { cursor = null, limit = 50 } = {}) {
  const rows = Array.isArray(envelopes) ? envelopes : [];
  const size = Math.max(1, Math.min(Number(limit) || 50, 200));
  let upper = rows.length; // exclusive index of the newest included envelope
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (!parsed) throw invalidCursor();
    // The cursor names the first sequence NOT to include.
    const index = rows.findIndex((row) => row.sequence_num >= parsed.seq);
    upper = index < 0 ? rows.length : index;
  }
  const lower = Math.max(0, upper - size);
  const data = rows.slice(lower, upper);
  const hasMore = lower > 0;
  return {
    data,
    next_cursor: hasMore ? olderCursorFor(data[0]?.sequence_num ?? 0) : null,
    has_more: hasMore,
  };
}
