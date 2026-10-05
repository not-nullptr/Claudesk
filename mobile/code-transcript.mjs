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
// Code transcript payloads retain SDK tool names and content blocks. The tool
// display helpers below remain available to callers needing Chat-style labels.

import { readFileSync } from "node:fs";
import { describeTool, resultText, trimInput } from "./blocks.mjs";
import { isHumanEntry } from "./transcript.mjs";

// The environment by-id decode fails the same silent way the repo list did
// (Sentry only). CLAUDE_MOBILE_ENV_MODE, or the file /data/env-mode read per
// request, selects a shape to bisect the failing field without a restart:
//   default  as built        nobridge  omit bridge_info
//   date0    drop ms from created_at     cfgflat  config without the `_0` level
//   minimal  only kind/id/name           wrapped  { "environment": <record> }
function environmentMode() {
  try {
    const fromFile = readFileSync("/data/env-mode", "utf8").trim();
    if (fromFile) return fromFile;
  } catch { /* no override file */ }
  return process.env.CLAUDE_MOBILE_ENV_MODE || "default";
}
import {
  BRIDGE_SPAWN_MODE,
  ENVIRONMENT_KIND,
  codeIdFor,
  connectionStatusOf,
  resourceConnectionStatusOf,
  resourceWorkerStatusOf,
  sessionLifecycleStatusOf,
  sessionStatusOf,
  statusBucketOf,
  workerStatusOf,
} from "./code-ids.mjs";

// The single "environment" a self-hosted Desktop presents: the paired bridge.
// The app lists it under Devices and lets a session be created against it.
export const BRIDGE_ENVIRONMENT_ID = "anthropic-bridge-local";

// The environment a "cloud" session runs in. A self-hosted Desktop has no
// Anthropic-hosted cloud, but the app's new-session picker splits the list by
// `kind` into TWO sections — "Cloud environments" (anthropicCloud) and "Remote
// control" (bridge) — and with no anthropicCloud row the cloud section renders
// its onboarding empty state ("Create a cloud environment to get started",
// Localizable key `environments_empty_state`), which is what blocks starting a
// session at all. Advertising the SAME Desktop as an anthropicCloud record puts
// a selectable row in that section; a session created against it runs on the
// Desktop exactly like a bridge one, because the facade ignores the runner kind
// when it starts the turn (see code-engine.createSession).
//
// The id is the app's own deviceless-cloud label; it is stable so a session's
// `environment_id` keeps resolving after a restart.
export const CLOUD_ENVIRONMENT_ID = "anthropic-cloud-local";

// The picker decodes the environment list ALL-OR-NOTHING: one field the app
// cannot decode fails the whole `[EnvironmentResource]`, and with it every row —
// which is the "Create a cloud environment to get started" empty state. `null`
// is the only value that can fail a field the app declares non-optional, so the
// fields whose optionality the binary's field metadata did NOT confirm optional
// are never emitted as null. A non-null value decodes whether the property is
// `T` or `T?`; null decodes only for `T?`. Fields the metadata DID confirm
// optional (mangled `…Sg`, e.g. `initScript`/`branch`/`gitRepoUrl`/`cliVersion`)
// stay null so they read as absent rather than as an empty string.
//
// Real environments always carry a creation time, and `createdAt` shares its
// exact field encoding with the session DTO's `createdAt` — a field the app
// already decodes from this facade's ISO-8601 strings. Mirror that here.
const ENVIRONMENT_CREATED_AT = new Date().toISOString();

function bridgeInfoFor({ name, online, cliVersion }) {
  return {
    max_sessions: 1,
    machine_name: name,
    directory: "/workspace",
    // Never null a String. The app's decoder says
    // "Cannot get value of type String -- found null value instead" for a
    // non-optional String that is present as null, and which of these the field
    // metadata really marks optional turned out to be wrong for at least one of
    // them. `""` decodes for `String` and `String?` alike; null does not.
    branch: "",
    git_repo_url: "",
    online,
    spawn_mode: BRIDGE_SPAWN_MODE.sameDir,
    cli_version: cliVersion ?? "",
  };
}

// `EnvironmentConfiguration` is a Swift enum with associated values, so its
// synthesised Codable is a keyed container holding ONE key — the case name —
// whose value is a nested keyed container of the case's associated values,
// keyed by label or `_0` when unlabelled (SE-0295; Apple's own example:
// `case upc(Int, Int, Int, Int)` encodes as `{"upc":{"_0":8,"_1":…}}`). The
// payload therefore sits under `_0`, not directly under the case name. Missing
// that level throws `keyNotFound(_0)`, which fails the whole
// `EnvironmentConfiguration`, then the whole `EnvironmentResource`, and reaches
// the app as ModelDecodingError(kind: unexpected_schema) — naming neither the
// field nor the level. Set CLAUDE_MOBILE_ENVIRONMENT_CONFIG_SHAPE=direct to
// emit the old (wrong) flat shape for comparison.
const CONFIG_SHAPE = process.env.CLAUDE_MOBILE_ENVIRONMENT_CONFIG_SHAPE || "boxed";
function environmentCase(caseName, payload) {
  return CONFIG_SHAPE === "direct" ? { [caseName]: payload } : { [caseName]: { _0: payload } };
}

export function bridgeEnvironment({ name = "Claudesk Desktop", online = true, cliVersion = null } = {}) {
  return {
    kind: ENVIRONMENT_KIND.bridge,
    environment_id: BRIDGE_ENVIRONMENT_ID,
    name,
    created_at: ENVIRONMENT_CREATED_AT,
    state: online ? "active" : "unknown",
    // `config` is `EnvironmentConfiguration`, an enum with associated values,
    // so a flat `{environment_type: …}` at `config`'s top level does not decode:
    // the payload nests under the case name and, within that, under the
    // associated value's key (`_0`) — see environmentCase above.
    // `environmentType` inside the payload is a `ConfigType` — `anthropic |
    // byoc | bridge | unknown`, a case set with NO `paired` member — so the
    // paired payload carries `bridge`, the same axis value its `kind` reports.
    config: environmentCase("paired", {
      environment_type: "bridge",
      machine_name: name,
      directory: "/workspace",
      branch: "",
      git_repo_url: "",
    }),
    bridge_info: bridgeInfoFor({ name, online, cliVersion }),
  };
}

// The anthropicCloud record that fills the picker's "Cloud environments"
// section. Its `config` is the `EnvironmentConfiguration.anthropic` case, so —
// like the bridge record — the payload nests under the case name and the inner
// `environment_type` literal is "anthropic". `bridgeInfo` is null: the app only
// reads it for `kind == bridge`. The `state`/`online` axis is the same Desktop
// health the bridge record uses, so a Desktop that is down is shown as unknown
// here too rather than as a usable cloud.
export function cloudEnvironment({ name = "Claudesk Desktop", online = true, cliVersion = null } = {}) {
  const record = {
    kind: ENVIRONMENT_KIND.anthropicCloud,
    environment_id: CLOUD_ENVIRONMENT_ID,
    name,
    created_at: ENVIRONMENT_CREATED_AT,
    state: online ? "active" : "unknown",
    config: environmentCase("anthropic", {
      environment_type: "anthropic",
      cwd: "/workspace",
      init_script: "",
      environment: {},
      languages: [],
      // `networkConfig`’s optionality is not recoverable from the metadata;
      // a well-formed, permissive value decodes whether it is `CCRNetworkConfig`
      // or `CCRNetworkConfig?`, while `null` would fail the former.
      network_config: { allowed_hosts: [], allow_default_hosts: true },
    }),
    // `bridgeInfo` sits on every `EnvironmentResource`; the app classifies the
    // row by `kind` and only reads `bridgeInfo` for the bridge kind. Emitting
    // the same Desktop descriptor here is ignored by a cloud row but decodes if
    // the property is non-optional — `null` would fail that case.
    bridge_info: bridgeInfoFor({ name, online, cliVersion }),
  };
  const mode = environmentMode();
  if (mode === "nobridge") delete record.bridge_info;
  else if (mode === "date0") record.created_at = String(record.created_at).replace(/\.\d+Z$/, "Z");
  else if (mode === "cfgflat" && CONFIG_SHAPE !== "direct") record.config = { anthropic: record.config.anthropic._0 };
  else if (mode === "minimal") { delete record.bridge_info; delete record.created_at; delete record.state; }
  else if (mode === "wrapped") return { environment: record };
  return record;
}

function iso(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

// Every timestamp on the Code DTOs is `Foundation.Date` — the field's mangled
// type resolves through the executable's chained-fixup import table to
// `_$s10Foundation4DateVMn` — and the app's decoder reads ISO-8601
// (docs/mobile-spec §Dates). `SessionResource.createdAt`/`updatedAt` and
// `SessionResponse.createdAt` are NON-optional, so a record without a usable
// time must still emit a real date: `null` there fails the whole DTO, and with
// it every row of the list. The first usable candidate wins.
function wireDate(...candidates) {
  for (const candidate of candidates) {
    const value = iso(candidate);
    if (value) return value;
  }
  return new Date().toISOString();
}

function desktopIdOf(record) {
  return record?.sessionId ?? record?.session_id ?? record?.id ?? null;
}

// The environment a session reports. Every session runs on the same Desktop, so
// the id is whichever record the picker created it against (meta.environment_id)
// and defaults to the bridge record — the kind follows the id, because the
// detail screen resolves the id back through the environments by-id read.
export function environmentForSession(meta = {}) {
  return meta.environment_id === CLOUD_ENVIRONMENT_ID
    ? { id: CLOUD_ENVIRONMENT_ID, kind: ENVIRONMENT_KIND.anthropicCloud }
    : { id: BRIDGE_ENVIRONMENT_ID, kind: ENVIRONMENT_KIND.bridge };
}

// The list row (ListSessionsResponse.data[]). `SessionResponse` is 23 fields;
// the ones a self-hosted Desktop does not have are emitted as null/[] so the
// app's non-optional decodes still succeed.
export function sessionResponse(record, { meta = {}, pendingApproval = false } = {}) {
  // Only the bucket is derived from this axis on the row; the row's own
  // `status` is the lifecycle one below.
  const sessionStatus = sessionStatusOf(record, { pendingApproval });
  const environment = environmentForSession(meta);
  return {
    id: codeIdFor(desktopIdOf(record)),
    environment_id: environment.id,
    environment_kind: environment.kind,
    title: record?.title || record?.name || "Untitled session",
    status: sessionLifecycleStatusOf(record),
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
    created_at: wireDate(record?.createdAt),
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
    status_bucket: statusBucketOf(sessionStatus),
    connector_domains_withheld: [],
  };
}

// The detail record (GET /v1/code/sessions/{id}, and the body of the create
// reply). `SessionResource` adds the context, permission mode and spawn path;
// `revision` is a millisecond timestamp (see `wireDate`).
export function sessionResource(record, { meta = {}, revision = null, pendingApproval = false } = {}) {
  const sessionStatus = sessionStatusOf(record, { pendingApproval });
  const environment = environmentForSession(meta);
  return {
    id: codeIdFor(desktopIdOf(record)),
    title: record?.title || record?.name || "Untitled session",
    session_status: sessionStatus,
    environment_id: environment.id,
    environment_kind: environment.kind,
    created_at: wireDate(record?.createdAt),
    updated_at: wireDate(record?.lastActivityAt, record?.createdAt),
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
    // The detail record decodes the two-case ConnectionStatus/WorkerStatus, not
    // the row's wider Session* vocabulary.
    connection_status: resourceConnectionStatusOf(record),
    worker_status: resourceWorkerStatusOf(record, { pendingApproval }),
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
    status_bucket: statusBucketOf(sessionStatus),
    // `revision` is a `Foundation.Date?` on this DTO, NOT a counter: an integer
    // here fails the decode of every `SessionResource` — the create reply, the
    // detail read and the watch's `upserted` frame. The session's own
    // last-change time is the date that moves when the record moves, which is
    // what the field tracks, so that is what goes on the wire.
    revision: wireDate(revision, record?.lastActivityAt, record?.createdAt),
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

// ---- Code event wire format -------------------------------------------------
// Both GET /events (data[]) and SSE event: client_event carry this envelope.
// ClientEventsPage.Row and SessionSseFrame are *decoded app models*, not JSON
// wrappers. See docs/mobile-code-wire-correction.md for decoder addresses.

// Desktop already supplies type-discriminated SDK stream-json. Keep the flat
// object and all content blocks; wrapping it in {user: ...} or translating it
// into assistant_text/tool_use destroys the SDK decoder's `type` discriminator.
export function streamJsonFor(entry) {
  if (!entry || typeof entry !== "object") return null;
  const source = entry.message?.type === "result"
    ? { ...entry.message, uuid: entry.message.uuid ?? entry.uuid,
        timestamp: entry.message.timestamp ?? entry.timestamp }
    : entry;
  const out = { ...source };
  // Only normalize declared SDK fields. Never rewrite arbitrary tool inputs,
  // tool results or other user-provided dictionaries recursively.
  for (const field of SDK_CAMEL_FIELDS) {
    if (source[field] === undefined) continue;
    const wire = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (out[wire] === undefined) out[wire] = source[field];
    delete out[field];
  }
  return out;
}

const SDK_CAMEL_FIELDS = [
  "parentToolUseId", "isMeta", "isSynthetic", "isVisibleInTranscriptOnly",
  "toolUseResult", "fileAttachments", "createdAt", "isReplay", "seededKind",
  "isApiErrorMessage", "apiError", "contextUsage", "usageReport",
  "localCommandSource", "toolUseMeta", "narrationBlockIndexes", "apiKeySource",
  "durationMs", "durationApiMs", "isError", "numTurns", "totalCostUsd",
  "permissionDenials", "userMessageUuid", "queuedTurnCount",
];

export function eventEnvelopeForEntry(entry, sequenceNum) {
  if (!Number.isSafeInteger(sequenceNum) || sequenceNum < 1) {
    throw new RangeError("Code event sequence numbers must be positive integers");
  }
  const payload = streamJsonFor(entry);
  return {
    event_id: payload?.uuid ?? null,
    sequence_num: String(sequenceNum),
    event_type: payload?.type ?? "unknown",
    source: isHumanEntry(entry) ? "human" : "assistant",
    payload: payload ?? {},
    created_at: payload?.created_at ?? payload?.timestamp ?? null,
  };
}

export function sseFrameForEntry(entry, sequenceNum) {
  return { event: "client_event", data: eventEnvelopeForEntry(entry, sequenceNum) };
}

export function isRenderableEntry(entry) {
  return typeof entry?.uuid === "string" && entry.uuid.length > 0
    && typeof (entry?.type ?? entry?.message?.type) === "string";
}

export function eventEnvelopes(entries, { startSequence = 1 } = {}) {
  const out = [];
  const seen = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRenderableEntry(entry)) continue;
    // Desktop can replay/update a UUID. It retains its original position.
    const index = seen.get(entry.uuid) ?? out.length;
    seen.set(entry.uuid, index);
    out[index] = eventEnvelopeForEntry(entry, startSequence + index);
  }
  return out;
}

// ---- channels: the same conversation, addressed as a claude.ai "channel" ----
// A Code conversation is readable two ways: as a session
// (/v1/code/sessions/{id}/…) and, by newer clients, as a *channel*
// (/v1/code/channels/{id}/…). The channel id is the same `code_<desktopId>` the
// session carries; ClaudeCodeApi/ChannelMessagesApi.swift is the binary's only
// builder of these paths. A transcript entry maps to one ChannelMessage, whose
// body is the message text and whose id is the event id. `ChannelMessage`'s only
// non-optional fields are id, inTimeline, serverNotice, attachments and
// participantAccountIds, so those are always emitted.
export const CHANNEL_MESSAGE_EVENT = "channel_message_updated";

export function channelMessageForEnvelope(envelope, { channelId = null, accountId = null } = {}) {
  const payload = envelope?.payload ?? {};
  const message = payload.message && typeof payload.message === "object" ? payload.message : payload;
  const body = messageText(message);
  if (body == null) return null;
  const human = envelope?.source === "human";
  return {
    id: envelope?.event_id ?? `msg_${envelope?.sequence_num ?? 0}`,
    thread_root_id: null,
    in_timeline: true,
    author_account_id: human ? accountId : null,
    author_session_id: human ? null : channelId,
    server_notice: false,
    composed: null,
    body,
    attachments: [],
    created_at: envelope?.created_at ?? new Date().toISOString(),
    edited: null,
    reply_count: 0,
    last_reply_at: null,
    has_unread: false,
    thread_status: null,
    thread_preview: null,
    participant_account_ids: [],
    participant_count: 1,
    // `ChannelMessage` declares nine NON-optional fields (fd 104c762ac); the
    // rest of its keys are optional. The four below are the ones that look
    // incidental and are not: omitting any of them throws
    // `ClaudeApiServices.ModelDecodingError` on every `channel_message_updated`
    // frame, which is exactly what the composer decodes when a send's turn
    // arrives. Empty collections are cheap and decode the element type not at
    // all, so they are the honest value for a transcript the facade builds from
    // raw SDK messages.
    bound_sessions: [],
    reactions: [],
    attached_outputs: [],
    links: [],
  };
}

// A channel read the facade has no upstream for still has to decode. Each
// channel response type is answered with the keys it declares as non-optional:
//   ChannelThreadsResponse  {sections}
//   ChannelPullRequestsPage {data,nextCursor,total,truncated,source}
//   ChannelArtifactsPage    {data,nextCursor,total,truncated}
//   ChannelFilesPage        {entries,nextCursor}
//   ChannelTimelineResponse {data,nextCursor}   (the default below)
export function channelEmptyPage(rest) {
  if (/^threads(\/|$)/.test(rest)) return { sections: [] };
  if (/^pull_requests(\/|$)/.test(rest)) {
    return { data: [], next_cursor: null, total: 0, truncated: false, source: "unspecified" };
  }
  if (/^artifacts(\/|$)/.test(rest)) return { data: [], next_cursor: null, total: 0, truncated: false };
  if (/^files(\/|$)/.test(rest)) return { entries: [], next_cursor: null };
  return { data: [], next_cursor: null };
}

// Channel = {storage, name}. `storage` describes where a channel's content
// lives; the Desktop this facade fronts is the only one, so an empty object
// stands in for it.
export function channelResource(id) {
  return {
    id,
    name: "",
    storage: {},
    member: null,
    members: [],
    members_truncated: false,
    has_working_session: false,
    disabled_by_plan: false,
    context_sources: [],
  };
}

// The display text of an SDK message: a bare string, a single text block, or the
// concatenation of its text blocks. Tool-only turns carry no text and are not
// timeline messages, so they map to null.
function messageText(message) {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text || null;
  }
  return null;
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
  // The app pages with `limit=500` on the older-cursor reads (seen on device);
  // capping at 200 made it walk five pages where one was asked for. Cap at a
  // generous ceiling that still bounds one response.
  const size = Math.max(1, Math.min(Math.floor(Number(limit)) || 50, 1000));
  let upper = rows.length; // exclusive index of the newest included envelope
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (!parsed) throw invalidCursor();
    // The cursor names the first sequence NOT to include.
    const index = rows.findIndex((row) => Number(row.sequence_num) >= parsed.seq);
    upper = index < 0 ? rows.length : index;
  }
  const lower = Math.max(0, upper - size);
  const data = rows.slice(lower, upper);
  const hasMore = lower > 0;
  return {
    data,
    next_cursor: hasMore ? olderCursorFor(Number(data[0]?.sequence_num ?? 0)) : null,
    has_more: hasMore,
  };
}
