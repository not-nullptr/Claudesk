// Desktop's Claude Code session events (LocalSessions.onOnEvent, relayed by the
// bridge as `desktop-ipc` SSE records) -> the app's SSE frames.
//
// There are TWO Code SSE protocols, and this module serves both:
//
//   GET /v1/code/sessions/watch          (SessionWatchWire)
//     { event: "upserted", data: <SessionEventEnvelope> }
//     { event: "deleted",  data: { session_id, event_id } }
//
//   GET /v1/code/sessions/{id}/events/stream   (SessionStreamWire)
//     { event: "client_event", data: { client_event: { sdk_message: <SdkMessage> } } }
//
// The list screen subscribes to `watch`; the session detail screen opens
// `events/stream` for the transcript. The two do NOT share a frame shape — the
// app decodes `SessionSseFrame` on the transcript leg and `SessionWatchFrame`
// on the list leg, and feeding one the other's envelope is what made a session
// open to "the messages failed to load". `frameFromPayload` produces the
// transcript-leg frame; `watchFrameFromPayload` produces the list-leg one.
//
// The Desktop record the bridge relays looks like the Chat one:
//   { surface: "LocalSessions", method: "onOnEvent", payload: <entry-or-update> }
// and a permission prompt arrives the same way under
// `onOnToolPermissionRequest`.

import { eventEnvelopeForEntry, sseFrameForEntry } from "./code-transcript.mjs";

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
 * One relayed LocalSessions record -> the session-detail transcript frames.
 *
 * These are `SessionSseFrame` records for `GET …/events/stream`: a
 * `client_event` whose payload is a stream-json message. A removal has no frame
 * of its own on this leg, so it yields nothing (the app re-reads on reconnect).
 *
 * @returns {Array<{ event: "client_event", data: object }>}
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
  // A removal (rewind, deleted entry) carries no content to render here.
  if (payload?.removed || payload?.deleted || entry?.removed) return [];
  if (!entry.uuid) return [];
  return [sseFrameForEntry(entry)];
}

/**
 * One relayed LocalSessions record -> zero or more `SessionWatchFrame`s for the
 * LIST leg (`GET /v1/code/sessions/watch`). This is a different protocol from
 * `frameFromPayload`: the list screen's `SessionWatchEvent` is
 * `upserted | deleted` over the whole session, not a transcript `client_event`.
 *
 * The payload carried here is the `SessionEventEnvelope`, unchanged from
 * before the transcript-leg fix — the list leg was not the failing one and its
 * exact payload is still being probed, so this keeps it byte-identical.
 *
 * @returns {Array<{ event: "upserted" | "deleted", data: object }>}
 */
export function watchFrameFromPayload(method, payload, sequence = 0) {
  if (method !== "onOnEvent") return [];
  const entry = entryPayload(payload);
  if (!entry) return [];
  if (payload?.removed || payload?.deleted || entry?.removed) {
    return [{ event: "deleted", data: { session_id: payload?.sessionId ?? entry?.sessionId ?? null, event_id: entry?.uuid ?? null } }];
  }
  if (!entry.uuid) return [];
  return [{ event: "upserted", data: eventEnvelopeForEntry(entry, sequence) }];
}

/**
 * Stateful translation for one watched session.
 *
 * The transcript-leg frames carry the message content itself, so the only state
 * kept here is which entries have been seen — the sequence counter backs
 * `resumeFrom()`, the `from_sequence_num` a reconnecting client asks to resume
 * at, and a Desktop replay on reconnect must not advance it.
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
        // Count each distinct entry once, so `resumeFrom()` stays a floor the
        // client can resume at even if Desktop replays rows on reconnect.
        const entry = entryPayload(payload);
        if (entry?.uuid && !seen.has(entry.uuid)) {
          seen.set(entry.uuid, nextSequence);
          nextSequence += 1;
        }
        frames.push(frame);
      }
      return frames;
    },

    /**
     * The same record, framed for the LIST leg (`SessionWatchFrame`). Shares
     * this translator's `seen` map and sequence counter, so the two legs agree
     * on ordering for a session watched on both.
     *
     * @param {{ method?: string, payload?: object }} record
     */
    acceptWatch({ method, payload } = {}) {
      const entry = entryPayload(payload);
      const frames = watchFrameFromPayload(method, payload, nextSequence);
      if (entry?.uuid && !seen.has(entry.uuid)) {
        seen.set(entry.uuid, nextSequence);
        nextSequence += 1;
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
