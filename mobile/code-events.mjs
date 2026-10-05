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
//     { event: "client_event", data: <SessionEventEnvelope> }
//
// The transcript dispatcher decodes the envelope and constructs an internal
// SessionSseFrame. It does not expect enum-case wrappers in the JSON body.
// The existing list-watch adapter is separate from the transcript contract.
//
// The Desktop record the bridge relays looks like the Chat one:
//   { surface: "LocalSessions", method: "onOnEvent", payload: <entry-or-update> }
// and a permission prompt arrives the same way under
// `onOnToolPermissionRequest`.

import { isRenderableEntry, sseFrameForEntry } from "./code-transcript.mjs";
import { codeIdFor } from "./code-ids.mjs";

// Is this relayed `desktop-ipc` record ours? The bridge broadcasts every
// relayed record on every SSE connection regardless of mode
// (bridge/realtime.mjs pollDesktopEvents), so the mode is not a filter — the
// surface is.
export function isCodeRecord(record) {
  return record?.data?.surface === "LocalSessions";
}

// A transcript entry is identified by `uuid` (see transcript.mjs). Desktop
// relays its live LocalSessions events as a granular envelope wrapping the SDK
// entry one level down:
//
//   { type: "message", sessionId: <desktop id>, message: <SDK entry> }
//
// (`session_updated` / `commands_changed` wrap no entry and are ignored.) The
// wrapper has a `type` of its own, so the old "has a type ⇒ it is the entry"
// test returned the wrapper, which has no `uuid`, and every live event failed
// `isRenderableEntry` — the turn rendered nothing live while history, built from
// the same SDK entries, worked. Prefer the nested entry when the outer object is
// a wrapper; a real SDK entry carries its `uuid` at the top level.
function entryPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const nested = payload.entry ?? payload.message;
  if (!payload.uuid && nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested;
  }
  if (payload.uuid || payload.type) return payload;
  return null;
}

/**
 * One relayed LocalSessions record -> the session-detail transcript frames.
 *
 * These are wire envelopes for `GET …/events/stream`: a
 * `client_event` whose payload is a stream-json message. A removal has no frame
 * of its own on this leg, so it yields nothing (the app re-reads on reconnect).
 *
 * @returns {Array<{ event: "client_event", data: object }>}
 */
export function frameFromPayload(method, payload, sequence = 1) {
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
  if (!isRenderableEntry(entry)) return [];
  return [sseFrameForEntry(entry, sequence)];
}

/**
 * One relayed LocalSessions record -> zero or more `SessionWatchFrame`s for the
 * LIST leg (`GET /v1/code/sessions/watch`). This is a different protocol from
 * `frameFromPayload`: the list screen's `SessionWatchEvent` is
 * `upserted | deleted` over the whole session, not a transcript `client_event`.
 *
 * `SessionWatchEvent` is `upserted(SessionResource) | deleted(SessionTag)` — a
 * different type from the transcript leg's `SessionEventEnvelope`, and the
 * reason this leg cannot reuse `eventEnvelopeForEntry`. These frames carry the
 * case PAYLOAD; the SSE writer (mobile/server.mjs) wraps each into the app's
 * `SessionWatchFrame` — `{"event":{"<case>":{"_0":<payload>}}}` — because the
 * app decodes the SSE `data` as the frame, not the payload. The translator
 * cannot build a `SessionResource` (it has only the relayed entry, not the
 * session record or its metadata), so the engine supplies one through
 * `resourceFor`.
 *
 * @returns {Array<{ event: "upserted" | "deleted", data: object | string | null }>}
 */
export function watchFrameFromPayload(method, payload, sequence = 1, { sessionId = null, resourceFor = null } = {}) {
  if (method !== "onOnEvent") return [];
  const entry = entryPayload(payload);
  if (!entry) return [];
  if (payload?.removed || payload?.deleted || entry?.removed) {
    return [{ event: "deleted", data: sessionId ? codeIdFor(sessionId) : null }];
  }
  if (!entry.uuid) return [];
  return [{ event: "upserted", data: resourceFor ? resourceFor(sessionId) : null }];
}

/**
 * Stateful translation for one watched session.
 *
 * The transcript-leg frames carry the message content itself, so the only state
 * kept here is which entries have been seen — the sequence counter backs
 * `resumeFrom()` returns the next assignable sequence; a Desktop replay on
 * reconnect must not advance it. The transcript resume floor is last-seen.
 *
 * @param {{ sessionId?: string, startSequence?: number, resourceFor?: (sessionId: string) => object }} options
 */
export function createCodeEventTranslator({ sessionId = null, startSequence = 1, resourceFor = null } = {}) {
  const seen = new Map(); // event_id -> sequence_num
  let nextSequence = startSequence;
  const pendingPermissions = new Map();

  return {
    get nextSequence() {
      return nextSequence;
    },

    // Seed from the same history used by GET /events before following live
    // records. Replays and simultaneous subscribers retain the event's number.
    seed(envelopes) {
      for (const envelope of envelopes) {
        const sequence = Number(envelope.sequence_num);
        seen.set(envelope.event_id, sequence);
        nextSequence = Math.max(nextSequence, sequence + 1);
      }
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
      const entry = entryPayload(payload);
      const sequence = seen.get(entry?.uuid) ?? nextSequence;
      for (const frame of frameFromPayload(method, payload, sequence)) {
        // Count each distinct entry once, so `resumeFrom()` stays a floor the
        // client can resume at even if Desktop replays rows on reconnect.
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
      const frames = watchFrameFromPayload(method, payload, seen.get(entry?.uuid) ?? nextSequence, { sessionId, resourceFor });
      if (frames.some((frame) => frame.event === "upserted") && entry?.uuid && !seen.has(entry.uuid)) {
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
