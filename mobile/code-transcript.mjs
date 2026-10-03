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

import { describeTool, resultText, trimInput } from "./blocks.mjs";
import { isHumanEntry } from "./transcript.mjs";
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

// The anthropicCloud record that fills the picker's "Cloud environments"
// section. Its `config` is the `AnthropicEnvironmentConfiguration` case, whose
// `environment_type` literal is "anthropic" (the enum case names are the raw
// values — see the "Wire casing" note above). `bridgeInfo` is omitted: the app
// only reads it for `kind == bridge`. The `state`/`online` axis is the same
// Desktop health the bridge record uses, so a Desktop that is down is shown as
// unknown here too rather than as a usable cloud.
export function cloudEnvironment({ name = "Claudesk Desktop", online = true } = {}) {
  return {
    kind: ENVIRONMENT_KIND.anthropicCloud,
    environment_id: CLOUD_ENVIRONMENT_ID,
    name,
    created_at: null,
    state: online ? "active" : "unknown",
    config: {
      environment_type: "anthropic",
      cwd: "/workspace",
      init_script: null,
      environment: {},
      languages: [],
      network_config: null,
    },
    bridge_info: null,
  };
}

function iso(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
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
  const status = sessionStatusOf(record, { pendingApproval });
  const environment = environmentForSession(meta);
  return {
    id: codeIdFor(desktopIdOf(record)),
    environment_id: environment.id,
    environment_kind: environment.kind,
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
  const environment = environmentForSession(meta);
  return {
    id: codeIdFor(desktopIdOf(record)),
    title: record?.title || record?.name || "Untitled session",
    session_status: status,
    environment_id: environment.id,
    environment_kind: environment.kind,
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
