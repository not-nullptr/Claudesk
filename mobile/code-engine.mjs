// Code engine for the mobile facade. A mobile Code session is a Desktop Claude
// Code session (LocalSessions), addressed as "code_" + Desktop's own session id,
// so the same session is visible in the Claudesk web UI and on the phone.
//
// It mirrors engine.mjs, with one structural difference: Chat hands out
// projected *messages*, Code hands out the event stream itself
// (SessionEventEnvelope) plus the paged history, because the app's transcript
// pane and pager are sequence-number driven. The projections are
// SessionResponse / SessionResource, and the history window is a page of
// envelopes.
//
// Everything the live probe (scripts/code-session-probe.mjs) can still correct
// is behind `ipcArgs`, so a wrong argument order is a one-line change.

import { randomUUID } from "node:crypto";
import { DesktopError } from "./desktop-client.mjs";
import { codeIdFor, desktopSessionIdFor, sessionStatusOf } from "./code-ids.mjs";
import { eventEnvelopes, pageEvents, sessionResource, sessionResponse } from "./code-transcript.mjs";
import { createCodeEventTranslator, isCodeRecord } from "./code-events.mjs";

const SURFACE = "LocalSessions";
// Desktop local session ids are uuid-shaped for Code; the bridge only needs
// them to be a safe path/query token, so accept the wider class Desktop uses
// rather than the uuid pattern Chat enforces.
const desktopIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const cacheTtlMs = 2000;
const pageLimit = 200;

function nowIso() {
  return new Date().toISOString();
}

export class CodeError extends Error {
  constructor(message, status = 502, type = "api_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const notFound = () => new CodeError("session not found", 404, "not_found_error");

function asCodeError(error) {
  if (error instanceof CodeError) return error;
  if (error instanceof DesktopError) {
    return new CodeError(`Claudesk is unavailable: ${error.message}`, error.status === 503 ? 503 : 502);
  }
  return new CodeError(error?.message || "unexpected error", 502);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arguments for each LocalSessions IPC call, in one place. See
 * docs/mobile-code-full-parity.md §7: the exact shapes are settled by the live
 * probe, and this is the only place that changes when they are.
 */
const ipcArgs = {
  getAll: () => [[]],
  getSession: (desktopId) => [desktopId],
  getTranscript: (desktopId) => [desktopId],
  start: (desktopId, { message, messageUuid, model, title }) => [{
    sessionId: desktopId,
    message,
    messageUuid,
    ...(model ? { model } : {}),
    ...(title ? { title } : {}),
    sessionType: "code",
  }],
  // sendMessage's tail arguments mirror the Chat surface (images, files,
  // folders, uuid, thinking flags); Code sends text only.
  sendMessage: (desktopId, { message, messageUuid }) => [desktopId, message, undefined, undefined, messageUuid],
  interrupt: (desktopId) => [desktopId],
  delete: (desktopId) => [desktopId],
  setModel: (desktopId, model) => [desktopId, model],
  setEffort: (desktopId, effort) => [desktopId, effort],
  setPermissionMode: (desktopId, mode) => [desktopId, mode],
  updateSession: (desktopId, patch) => [desktopId, patch],
  archive: (desktopId) => [desktopId],
  respondToToolPermission: (desktopId, requestId, behavior) => [desktopId, requestId, behavior],
};

export function createCodeEngine({
  store,
  desktop,
  log = console,
  titles = process.env.CLAUDE_MOBILE_TITLES !== "0",
}) {
  const cache = new Map(); // desktopId -> { base, at }
  const revisions = new Map(); // desktopId -> number
  const listeners = new Map(); // desktopId -> Set<fn({method, payload})>
  const allListeners = new Set(); // fn({method, payload}, desktopId)
  const translators = new Map(); // desktopId -> code-events translator
  const permissionRequests = new Map(); // requestId -> { sessionId, payload }
  const activeTurns = new Map(); // desktopId -> { abort }
  let subscription = null;
  let metaState = null;
  let metaWrite = Promise.resolve();
  let lastRevision = 0;

  // ---------- mobile-only metadata ----------

  async function loadMeta() {
    if (!metaState) {
      metaState = await store.readJsonFile("code-meta.json", { sessions: {} });
      metaState.sessions ||= {};
    }
    return metaState;
  }

  async function updateMeta(desktopId, mutate) {
    const state = await loadMeta();
    const entry = state.sessions[desktopId] || {};
    mutate(entry);
    state.sessions[desktopId] = entry;
    metaWrite = metaWrite
      .then(() => store.writeJsonFile("code-meta.json", state))
      .catch((error) => log.error(`[mobile-code] cannot persist Code metadata: ${error.message}`));
    await metaWrite;
    return entry;
  }

  async function dropMeta(desktopId) {
    const state = await loadMeta();
    if (!state.sessions[desktopId]) return;
    delete state.sessions[desktopId];
    metaWrite = metaWrite
      .then(() => store.writeJsonFile("code-meta.json", state))
      .catch((error) => log.error(`[mobile-code] cannot persist Code metadata: ${error.message}`));
    await metaWrite;
  }

  // ---------- revisions ----------

  function bumpRevision(desktopId) {
    lastRevision = Math.max(lastRevision + 1, Date.now());
    revisions.set(desktopId, lastRevision);
    return lastRevision;
  }

  const revisionFor = (desktopId) => revisions.get(desktopId) ?? bumpRevision(desktopId);

  // ---------- Desktop events ----------

  function ensureEvents() {
    if (subscription) return;
    subscription = desktop.subscribe({
      mode: "code",
      onEvent: handleDesktopEvent,
      onReconnect: () => {
        cache.clear();
        for (const desktopId of listeners.keys()) bumpRevision(desktopId);
      },
    });
  }

  function translatorFor(desktopId) {
    let translator = translators.get(desktopId);
    if (!translator) {
      translator = createCodeEventTranslator({ sessionId: desktopId });
      translators.set(desktopId, translator);
    }
    return translator;
  }

  function listen(desktopId, callback) {
    ensureEvents();
    let set = listeners.get(desktopId);
    if (!set) {
      set = new Set();
      listeners.set(desktopId, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (!set.size) listeners.delete(desktopId);
    };
  }

  // The list screen watches every Code session at once; the callback receives
  // the Desktop id it belongs to.
  function listenAll(callback) {
    ensureEvents();
    allListeners.add(callback);
    return () => allListeners.delete(callback);
  }

  function desktopIdOf(payload) {
    return payload?.sessionId ?? payload?.session_id ?? null;
  }

  function handleDesktopEvent(record) {
    if (record.event !== "desktop-ipc") return;
    if (!isCodeRecord(record)) return;
    const { method, payload } = record.data || {};
    if (method === "onOnToolPermissionRequest") {
      const requestId = payload?.requestId ?? payload?.id ?? null;
      const desktopId = desktopIdOf(payload);
      if (requestId) permissionRequests.set(requestId, { sessionId: desktopId, payload });
      if (desktopId) {
        // A prompt blocks the session until it is answered.
        bumpRevision(desktopId);
        for (const callback of listeners.get(desktopId) || []) {
          try {
            callback({ method, payload });
          } catch (error) {
            log.error(`[mobile-code] permission listener failed: ${error.message}`);
          }
        }
      }
      return;
    }
    if (method !== "onOnEvent") return;
    const desktopId = desktopIdOf(payload?.entry) ?? desktopIdOf(payload);
    if (!desktopId) return;
    const event = { method, payload };
    for (const callback of listeners.get(desktopId) || []) {
      try {
        callback(event);
      } catch (error) {
        log.error(`[mobile-code] event listener failed: ${error.message}`);
      }
    }
    for (const callback of allListeners) {
      try {
        callback(event, desktopId);
      } catch (error) {
        log.error(`[mobile-code] event listener failed: ${error.message}`);
      }
    }
    // A turn this service is streaming keeps its cached base; other activity
    // (the web UI, another client) invalidates the projection.
    if (!activeTurns.has(desktopId)) cache.delete(desktopId);
    bumpRevision(desktopId);
  }

  // ---------- reads ----------

  async function fetchSession(desktopId) {
    return desktop.ipc(SURFACE, "getSession", ipcArgs.getSession(desktopId));
  }

  async function fetchTranscript(desktopId) {
    return (await desktop.ipc(SURFACE, "getTranscript", ipcArgs.getTranscript(desktopId))) || [];
  }

  async function loadSession(desktopId, { fresh = false } = {}) {
    if (!desktopIdPattern.test(String(desktopId))) throw notFound();
    const hit = cache.get(desktopId);
    if (!fresh && hit && (activeTurns.has(desktopId) || Date.now() - hit.at < cacheTtlMs)) {
      return { ...hit.base, revision: revisionFor(desktopId) };
    }
    let session;
    let entries = [];
    try {
      session = await fetchSession(desktopId);
      if (session) entries = await fetchTranscript(desktopId);
    } catch (error) {
      throw asCodeError(error);
    }
    if (!session) throw notFound();
    const meta = (await loadMeta()).sessions[desktopId];
    const base = {
      session,
      entries,
      envelopes: eventEnvelopes(entries),
      meta: meta || {},
      pendingApproval: hasPendingPermission(desktopId),
    };
    cache.set(desktopId, { base, at: Date.now() });
    return { ...base, revision: revisionFor(desktopId) };
  }

  function hasPendingPermission(desktopId) {
    for (const request of permissionRequests.values()) {
      if (request.sessionId === desktopId) return true;
    }
    return false;
  }

  // ---------- list / create / detail ----------

  async function listSessions({ statuses = null, tags = null, limit = null } = {}) {
    let sessions;
    try {
      sessions = (await desktop.ipc(SURFACE, "getAll", ipcArgs.getAll())) || [];
    } catch (error) {
      throw asCodeError(error);
    }
    const state = await loadMeta();
    // The surface is the discriminator, not a field: `LocalSessions.getAll`
    // returns Claude Code sessions and *only* those, and its rows carry no
    // `sessionType` at all (probe, 2026-10: 18 rows, all `local_…`, no
    // sessionType). So keep everything this surface returns; a row without an
    // id is the only thing worth dropping.
    const codes = sessions.filter((session) => {
      const id = session?.sessionId ?? session?.id;
      return typeof id === "string" && id.length > 0;
    });
    let rows = codes.map((session) => {
      const desktopId = String(session.sessionId ?? session.id ?? "");
      return sessionResponse(session, {
        meta: state.sessions[desktopId] || {},
        pendingApproval: hasPendingPermission(desktopId),
      });
    });
    if (Array.isArray(statuses) && statuses.length) {
      const wanted = new Set(statuses);
      rows = rows.filter((row) => wanted.has(row.status));
    }
    if (Array.isArray(tags) && tags.length) {
      const wanted = new Set(tags);
      rows = rows.filter((row) => row.tags.some((tag) => wanted.has(tag)));
    }
    rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), pageLimit) : pageLimit;
    return rows.slice(0, size);
  }

  async function getSession(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const loaded = await loadSession(desktopId);
    return {
      resource: sessionResource(loaded.session, {
        meta: loaded.meta,
        revision: loaded.revision,
        pendingApproval: loaded.pendingApproval,
      }),
      loaded,
    };
  }

  async function createSession({ title = null, model = null, permissionMode = null, cwd = null } = {}) {
    const desktopId = randomUUID();
    try {
      const session = await fetchSession(desktopId).catch(() => null);
      if (session) throw new CodeError("session id collision", 409, "invalid_request_error");
    } catch (error) {
      if (error instanceof CodeError) throw error;
      // getSession on an unknown id is expected to fail; that is the happy path.
    }
    const patch = {};
    if (title) patch.title = String(title).slice(0, 200);
    if (cwd) patch.cwd = cwd;
    if (Object.keys(patch).length) {
      try {
        await desktop.ipc(SURFACE, "updateSession", ipcArgs.updateSession(desktopId, patch));
      } catch (error) {
        log.error(`[mobile-code] cannot prepare session: ${error.message}`);
      }
    }
    await updateMeta(desktopId, (entry) => {
      entry.draft = { title: title || "", model, permission_mode: permissionMode, created_at: nowIso() };
    });
    const record = {
      sessionId: desktopId,
      title: title || "",
      model,
      permissionMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isRunning: false,
    };
    return sessionResource(record, { meta: { draft: true }, revision: revisionFor(desktopId) });
  }

  async function deleteSession(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    abortActiveTurn(desktopId);
    try {
      await desktop.ipc(SURFACE, "delete", ipcArgs.delete(desktopId));
    } catch (error) {
      throw asCodeError(error);
    }
    cache.delete(desktopId);
    translators.delete(desktopId);
    await dropMeta(desktopId);
  }

  async function updateSession(id, patch = {}) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const ipcPatch = {};
    if (typeof patch.title === "string" && patch.title.trim()) ipcPatch.title = patch.title.trim().slice(0, 200);
    try {
      if (Object.keys(ipcPatch).length) {
        await desktop.ipc(SURFACE, "updateSession", ipcArgs.updateSession(desktopId, ipcPatch));
      }
      if (typeof patch.model === "string" && patch.model) {
        await desktop.ipc(SURFACE, "setModel", ipcArgs.setModel(desktopId, patch.model));
      }
      if (typeof patch.effort === "string" && patch.effort) {
        await desktop.ipc(SURFACE, "setEffort", ipcArgs.setEffort(desktopId, patch.effort));
      }
      if (typeof patch.permission_mode === "string" && patch.permission_mode) {
        await desktop.ipc(SURFACE, "setPermissionMode", ipcArgs.setPermissionMode(desktopId, patch.permission_mode));
      }
      if (patch.is_archived === true) {
        await desktop.ipc(SURFACE, "archive", ipcArgs.archive(desktopId));
      }
    } catch (error) {
      throw asCodeError(error);
    }
    cache.delete(desktopId);
    bumpRevision(desktopId);
    return (await getSession(id)).resource;
  }

  // ---------- history ----------

  async function listEvents(id, { cursor = null, limit = 50 } = {}) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const loaded = await loadSession(desktopId);
    const page = pageEvents(loaded.envelopes, { cursor, limit });
    return {
      data: page.data,
      next_cursor: page.next_cursor,
      max_sequence_num: loaded.envelopes.length ? loaded.envelopes.at(-1).sequence_num : null,
      newest_event_id: loaded.envelopes.at(-1)?.event_id ?? null,
      has_more: page.has_more,
    };
  }

  // ---------- turns ----------

  function activeTurnCount() {
    return activeTurns.size;
  }

  function activeTurnFor(desktopId) {
    return activeTurns.get(desktopId) || null;
  }

  function abortActiveTurn(desktopId) {
    const turn = activeTurns.get(desktopId);
    if (turn?.abort) {
      try {
        turn.abort.abort(new Error("client stop request"));
      } catch {
        turn.abort.abort();
      }
    }
  }

  /**
   * Send a message into a Code session. Mirrors engine.mjs's dispatch: `start`
   * for a session that has never run (it is created here, not by createSession,
   * because Desktop needs the first message to exist at all), `sendMessage`
   * otherwise.
   */
  async function sendMessage(id, { text, clientMessageId = null, interrupt = false } = {}) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const body = String(text ?? "");
    if (!body) throw new CodeError("message body is required", 400, "invalid_request_error");
    const messageUuid = clientMessageId && /^[0-9a-f-]{36}$/i.test(clientMessageId) ? clientMessageId : randomUUID();
    const loaded = await loadSession(desktopId).catch(() => null);
    const exists = Boolean(loaded?.session);
    try {
      if (!exists) {
        await desktop.ipc(SURFACE, "start", ipcArgs.start(desktopId, {
          message: body,
          messageUuid,
          model: loaded?.session?.model ?? undefined,
          title: body.replace(/\s+/g, " ").trim().slice(0, 60),
        }));
      } else {
        if (interrupt) await desktop.ipc(SURFACE, "interrupt", ipcArgs.interrupt(desktopId)).catch(() => {});
        await desktop.ipc(SURFACE, "sendMessage", ipcArgs.sendMessage(desktopId, { message: body, messageUuid }));
      }
    } catch (error) {
      throw asCodeError(error);
    }
    await updateMeta(desktopId, (entry) => {
      delete entry.draft;
      entry.lastMessageAt = nowIso();
    });
    cache.delete(desktopId);
    bumpRevision(desktopId);
    if (titles && !exists && body.trim()) {
      void generateTitle(desktopId, body);
    }
    return { messageId: messageUuid, threadRootId: null, createdAt: nowIso() };
  }

  async function generateTitle(desktopId, text) {
    try {
      const title = (await desktop.generateTitle({ message: text })).replace(/\s+/g, " ").trim().slice(0, 200);
      if (!title) return;
      const session = await fetchSession(desktopId).catch(() => null);
      // Keep a title the user (or Desktop) already chose; only replace the
      // placeholder this service wrote from the first message.
      if (!session || (session.title && session.title !== text.replace(/\s+/g, " ").trim().slice(0, 60))) return;
      await desktop.ipc(SURFACE, "updateSession", ipcArgs.updateSession(desktopId, { title }));
      cache.delete(desktopId);
      bumpRevision(desktopId);
    } catch (error) {
      log.error(`[mobile-code] cannot title ${desktopId}: ${error.message}`);
    }
  }

  async function interrupt(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    abortActiveTurn(desktopId);
    try {
      await desktop.ipc(SURFACE, "interrupt", ipcArgs.interrupt(desktopId));
    } catch (error) {
      throw asCodeError(error);
    }
    bumpRevision(desktopId);
  }

  // ---------- permissions ----------

  function permissionsFor(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) return [];
    return [...permissionRequests.entries()]
      .filter(([, request]) => request.sessionId === desktopId)
      .map(([requestId, request]) => ({ request_id: requestId, session_id: codeIdFor(desktopId), payload: request.payload }));
  }

  async function respondToPermission(id, requestId, behavior = "allow") {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    try {
      await desktop.ipc(SURFACE, "respondToToolPermission", ipcArgs.respondToToolPermission(desktopId, requestId, behavior));
    } catch (error) {
      throw asCodeError(error);
    }
    permissionRequests.delete(requestId);
    cache.delete(desktopId);
    bumpRevision(desktopId);
  }

  /**
   * Translate one relayed record into app frames for a watched session, and
   * record any permission prompt it carried.
   */
  function framesFor(desktopId, { method, payload }) {
    return translatorFor(desktopId).accept({ method, payload });
  }

  /** The sequence to resume this session's SSE stream from. */
  function resumeFrom(desktopId) {
    return translatorFor(desktopId).resumeFrom();
  }

  /**
   * Wait for a turn to go idle, then return the session's newest transcript
   * entries. Used by the send route to close out a turn that the watch stream
   * is rendering live.
   */
  async function awaitTurn(desktopId, { signal = null, timeoutMs = 600000, pollMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return null;
      const session = await fetchSession(desktopId).catch(() => null);
      if (!session) throw notFound();
      if (session.isRunning === false || session.status === "idle") return session;
      await sleep(pollMs);
    }
    return null;
  }

  return {
    listSessions,
    getSession,
    createSession,
    updateSession,
    deleteSession,
    listEvents,
    sendMessage,
    interrupt,
    permissionsFor,
    respondToPermission,
    listen,
    listenAll,
    framesFor,
    resumeFrom,
    awaitTurn,
    activeTurnCount,
    activeTurnFor,
    abortActiveTurn,
    hasPendingPermission,
    ensureEvents,
  };
}
