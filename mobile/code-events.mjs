// Desktop's Claude Code session events (LocalSessions.onOnEvent, relayed by the
// bridge as `desktop-ipc` SSE records) -> the app's `SessionWatchFrame`s.
//
// The app's live channel (GET /v1/code/sessions/watch) emits one frame per
// record:
//   { event: "upserted", data: <SessionEventEnvelope>, ... }
//   { event: "deleted",  data: { session_id, event_id } }
//
// Where events.mjs folds a Chat turn's Anthropic stream events into one
// message, a Code conversation is *event-sourced*: every Desktop transcript
// entry is already a discrete, ordered record, and the phone's pager
// (SessionTranscriptPager) keys off its sequence number. So the translation is
// mostly a reshape plus a monotonic sequence counter, and the shape-specific
// part is confined to `frameFromPayload` — the one function the live probe in
// scripts/code-session-probe.mjs is expected to correct.
//
// The Desktop record the bridge relays looks like the Chat one:
//   { surface: "LocalSessions", method: "onOnEvent", payload: <entry-or-update> }
// and a permission prompt arrives the same way under
// `onOnToolPermissionRequest`.

import { eventEnvelopeForEntry } from "./code-transcript.mjs";

// Is this relayed `desktop-ipc` record ours? The bridge broadcasts every
// relayed record on every SSE connection regardless of mode
// (bridge/realtime.mjs pollDesktopEvents), so the mode is not a filter — the
// surface is.
export function isCodeRecord(record) {
  return record?.data?.surface === "LocalSessions";
}

// A transcript entry is identified by `uuid` (see transcript.mjs), so that is
// what tells an entry apart from a wrapper object. Desktop has been seen to
// relay the entry either directly or under `entry`; the probe settles which,
// but accepting both keeps a rename from silently dropping every event.
function entryPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.uuid || payload.type) return payload;
  const wrapped = payload.entry ?? payload.message ?? null;
  return wrapped && typeof wrapped === "object" ? wrapped : null;
}

/**
 * One relayed LocalSessions record -> zero or more SessionWatchFrame frames.
 *
 * @returns {Array<{ event: "upserted" | "deleted", data: object }>}
 */
export function frameFromPayload(method, payload) {
  if (method === "onOnToolPermissionRequest") {
    // A permission prompt is not a transcript event the pane draws; the route
    // layer turns it into a session-status change and the prompts endpoint.
    return [];
  }
  if (method !== "onOnEvent") return [];
  const entry = entryPayload(payload);
  if (!entry) return [];
  // Desktop signals a removal (rewind, deleted entry) rather than an upsert.
  if (payload?.removed || payload?.deleted || entry?.removed) {
    return [{ event: "deleted", data: { session_id: payload?.sessionId ?? entry?.sessionId ?? null, event_id: entry?.uuid ?? null } }];
  }
  if (!entry.uuid) return [];
  // Rows Desktop replays on reconnect land here too; the app de-dupes on
  // event_id, and the sequence number stays monotonic because the caller
  // assigns it.
  return [{ event: "upserted", data: entry }];
}

/**
 * Stateful translation for one watched session.
 *
 * Sequence numbers are assigned here, contiguously from `startSequence`, and
 * every event is remembered by id so a Desktop replay on reconnect is returned
 * at its ORIGINAL sequence number (the app keys history off `sequenceNum`, so
 * re-sequencing a replay would rewrite its transcript).
 *
 * @param {{ sessionId?: string, startSequence?: number }} options
 */
export function createCodeEventTranslator({ sessionId = null, startSequence = 0 } = {}) {
  const seen = new Map(); // event_id -> sequence_num
  let nextSequence = startSequence;
  const pendingPermissions = new Map();

  return {
    get nextSequence() {
      return nextSequence;
    },

    /**
     * Translate one relayed record. Returns the app-facing frames, and records
     * a permission prompt as a side effect.
     *
     * @param {{ method?: string, payload?: object }} record
     */
    accept({ method, payload } = {}) {
      if (method === "onOnToolPermissionRequest") {
        const id = payload?.requestId ?? payload?.id ?? null;
        if (id) pendingPermissions.set(id, payload);
      }
      const frames = [];
      for (const frame of frameFromPayload(method, payload)) {
        if (frame.event === "deleted") {
          frames.push(frame);
          continue;
        }
        const entry = frame.data;
        const known = seen.get(entry.uuid);
        const sequence = known ?? nextSequence;
        if (known === undefined) {
          seen.set(entry.uuid, sequence);
          nextSequence += 1;
        }
        frames.push({
          event: "upserted",
          data: eventEnvelopeForEntry(entry, sequence),
        });
      }
      return frames;
    },

    /** The sequence to resume the SSE stream from (one past the last emitted). */
    resumeFrom() {
      return nextSequence;
    },

    /** Open permission prompts, keyed by request id, for the prompts endpoint. */
    permissions() {
      return [...pendingPermissions.values()];
    },

    /** A prompt was answered (or withdrawn) — stop surfacing it. */
    resolvePermission(requestId) {
      return pendingPermissions.delete(requestId);
    },
  };
}
