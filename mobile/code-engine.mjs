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
import { SESSION_STATUS, codeIdFor, desktopSessionIdFor, sessionStatusOf } from "./code-ids.mjs";
import { eventEnvelopes, folderDirectoryFromEnvironmentId, pageEvents, sessionResource, sessionResponse } from "./code-transcript.mjs";
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

// `SdkPermissionMode` values Desktop accepts. The app's Code composer offers
// only Manual / Accept edits / Plan / Auto — it has no Bypass row in this build
// (`bypassPermissions` exists as a wire value only; "Skip all approvals" is the
// Cowork mode). CLAUDE_MOBILE_PERMISSION_MODE=bypassPermissions forces the mode
// on every session `start`, so Code runs without prompts even though the UI
// cannot select it.
const SDK_PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan", "auto"]);
const FORCED_PERMISSION_MODE = SDK_PERMISSION_MODES.has(process.env.CLAUDE_MOBILE_PERMISSION_MODE)
  ? process.env.CLAUDE_MOBILE_PERMISSION_MODE
  : null;

function asCodeError(error) {
  if (error instanceof CodeError) return error;
  if (error instanceof DesktopError) {
    return new CodeError(`Claudesk is unavailable: ${error.message}`, error.status === 503 ? 503 : 502);
  }
  return new CodeError(error?.message || "unexpected error", 502);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arguments for each LocalSessions IPC call, in one place.
 *
 * These are no longer guesses. Desktop's own IPC schema is readable from the
 * installed app's ASAR (`/usr/lib/claude-desktop/resources/app.asar` →
 * `/.vite/build/index.chunk-*.js`): each interface registers as
 * `[methodName, [[paramName, validator], ...], resultValidator]`, and the
 * validators are `F = typeof === "string"`, `L = optional`, `z = array-of`.
 * The signatures below are transcribed from that registry, so a mismatch here
 * is a bug against a known contract rather than an unknown.
 *
 * `sessionId` is a plain string everywhere — no prefix or brand — so the
 * facade's `code_` tag is stripped before the call and never leaves this file.
 */
const ipcArgs = {
  getAll: () => [],
  getSession: (desktopId) => [desktopId],
  getTranscript: (desktopId) => [desktopId],
  // `start` takes one argument named `info`; its validator requires BOTH
  // `cwd` and `message` to be strings. Omitting `cwd` is what made every
  // earlier probe shape fail identically ("Argument \"info\" at position 0").
  start: (desktopId, { cwd, message, messageUuid, model, title, permissionMode }) => [{
    cwd,
    message,
    sessionId: desktopId,
    ...(messageUuid ? { messageUuid } : {}),
    ...(model ? { model } : {}),
    ...(title ? { title } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  }],
  // `messageUuid` is the EIGHTH positional argument, not the third: Desktop's
  // implementation is
  //   sendMessage(sessionId, message, images, toolStates, attachments,
  //               priority, steeringGates, messageUuid, …)
  // (read off `/.vite/build/index.chunk-*.js` in the installed ASAR). The
  // optional slots before it must still be passed as `undefined` to reach its
  // position; sending it earlier puts a string where `attachments` is expected
  // and Desktop rejects the call, which is the 502 on every follow-up message.
  sendMessage: (desktopId, { message, messageUuid }) => [
    desktopId, message, undefined, undefined, undefined, undefined, undefined, messageUuid,
  ],
  interrupt: (desktopId) => [desktopId],
  delete: (desktopId) => [desktopId],
  setModel: (desktopId, model) => [desktopId, model],
  // The parameter is `effortLevel`, not `effort` (positional, so it still
  // transmits — named correctly here for the record).
  setEffort: (desktopId, effortLevel) => [desktopId, effortLevel],
  setPermissionMode: (desktopId, mode) => [desktopId, mode],
  updateSession: (desktopId, patch) => [desktopId, patch],
  archive: (desktopId) => [desktopId],
  // Two arguments, `requestId` first — NOT sessionId-first — and the second is
  // `decision`, whose values are `once | always | deny` (read off Desktop's own
  // call site). `updatedInput` is an optional third, sent only with an edit.
  respondToToolPermission: (requestId, decision, updatedInput) => [
    requestId,
    decision,
    ...(updatedInput === undefined ? [] : [updatedInput]),
  ],
  getDefaultWorkspaceFolders: () => [],
};

export function createCodeEngine({
  store,
  desktop,
  log = console,
  titles = process.env.CLAUDE_MOBILE_TITLES !== "0",
}) {
  const cache = new Map(); // desktopId -> { base, at }
  const records = new Map(); // desktopId -> Desktop session record (sync mirror of `cache`)
  const revisions = new Map(); // desktopId -> number
  const listeners = new Map(); // desktopId -> Set<fn({method, payload})>
  const allListeners = new Set(); // fn({method, payload}, desktopId)
  const translators = new Map(); // desktopId -> code-events translator
  const permissionRequests = new Map(); // requestId -> { sessionId, payload }
  const activeTurns = new Map(); // desktopId -> { abort }
  // `${desktopId}:${messageUuid}` already handed to Desktop. The app can deliver
  // the same user message on more than one leg (`POST /events` and its retries),
  // and Desktop would start/send it twice; the client message id makes the
  // dispatch idempotent.
  const dispatched = new Set();
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
        records.clear();
        for (const desktopId of listeners.keys()) bumpRevision(desktopId);
      },
    });
  }

  // The list-watch leg (`GET /v1/code/sessions/watch`) carries whole
  // `SessionResource`s, but the pure translator has only the relayed transcript
  // entry. The engine is the one place with the session record and its mobile
  // metadata, so it builds the resource here, synchronously, from the same
  // mirror `loadSession`/`listSessions` keep. A session the engine has not seen
  // yet still yields a decodable resource (a bare id) that the app replaces on
  // its next list read.
  function watchResourceFor(desktopId) {
    const record = records.get(desktopId) || { sessionId: desktopId };
    return sessionResource(record, {
      meta: metaState?.sessions?.[desktopId] || {},
      pendingApproval: hasPendingPermission(desktopId),
    });
  }

  function translatorFor(desktopId) {
    let translator = translators.get(desktopId);
    if (!translator) {
      translator = createCodeEventTranslator({
        sessionId: desktopId,
        resourceFor: () => watchResourceFor(desktopId),
      });
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
    if (!desktopId) {
      log.log("[mobile-code] relay onOnEvent dropped: no sessionId in payload");
      return;
    }
    // Diagnostics for the live-turn path: a watched session that receives no
    // relayed record is a relay/bridge gap; a record that yields no frame is a
    // translation gap. One line per relayed record, only for sessions someone
    // is actually streaming, so a normal log stays quiet.
    if (listeners.get(desktopId)?.size) {
      // Live events wrap the SDK entry one level down; unwrap for the log so a
      // `message` event reports the message's own type/uuid, not the wrapper's.
      const entry = payload?.entry ?? payload?.message ?? payload;
      log.log(`[mobile-code] relay onOnEvent sid=${desktopId.slice(0, 12)}`
        + ` type=${entry?.type ?? entry?.message?.type ?? "?"}`
        + ` uuid=${String(entry?.uuid ?? "-").slice(0, 8)}`);
    }
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

  // `start` requires a `cwd`, and it must be a path Desktop can actually use
  // (it is a real filesystem read on the Desktop side, not a label). Prefer
  // what the caller asked for, then Desktop's own default workspace folder,
  // then the directory the environment leg already advertises.
  let cachedDefaultCwd = null;
  async function resolveCwd(requested = null) {
    if (requested) return String(requested);
    if (cachedDefaultCwd) return cachedDefaultCwd;
    let folders = [];
    try {
      folders = (await desktop.ipc(SURFACE, "getDefaultWorkspaceFolders", ipcArgs.getDefaultWorkspaceFolders())) || [];
    } catch (error) {
      log.error(`[mobile-code] cannot read default workspace folders: ${error.message}`);
    }
    cachedDefaultCwd = (Array.isArray(folders) && folders.find((folder) => typeof folder === "string")) || "/workspace";
    return cachedDefaultCwd;
  }

  // The new-session picker attaches the repository the session was created
  // against as `config.sources` — `[SessionContextSource]`. That enum is
  // CUSTOM-coded (`ClaudeCodeApi.SessionContextSource.SourceType`, a nested
  // discriminator type in docs/mobile-code-decodable-types.txt), so its JSON is
  // flat: `{ type: "git_repository", url, revision }`. The app builds the url
  // from the GitHubRepo the facade advertised, so it is usually
  // `https://github.com/<owner>/<name>` — but a source may also carry the
  // `file://<path>` we advertise, or a plain path. Read all three so the
  // repository the user picked decides the session's `cwd`.
  //
  // The raw `sources` array is also kept verbatim on the session's meta (see
  // createSession) and echoed back in the session DTOs: it is the app's own
  // encoding of its own Decodable, so a round-trip is guaranteed to decode,
  // whatever the exact discriminator key.
  function sourceUrl(source) {
    if (!source || typeof source !== "object") return null;
    // Flat custom coding (`source.url`), the synthesised SE-0295 nesting
    // (`source.gitRepository.url`), and the snake-cased variant are all read so
    // a shape change upstream cannot silently drop the selection.
    const candidate = source.url
      ?? source.gitRepository?.url
      ?? source.git_repository?.url;
    return typeof candidate === "string" && candidate ? candidate : null;
  }

  function repoNameFromUrl(url) {
    const clean = url.replace(/\.git$/, "").replace(/\/+$/, "");
    const name = clean.split("/").filter(Boolean).pop();
    if (!name) return null;
    try { return decodeURIComponent(name); } catch { return name; }
  }

  function repoNameFromSources(sources) {
    if (!Array.isArray(sources)) return null;
    for (const source of sources) {
      const url = sourceUrl(source);
      const name = url && repoNameFromUrl(url);
      if (name) return name;
    }
    return null;
  }

  // A `file://…` or absolute-path source is a real workspace path and is used
  // as-is; anything else (a github URL) is mapped by its last path segment onto
  // the Desktop workspace folder of the same name.
  function localPathFromSources(sources) {
    if (!Array.isArray(sources)) return null;
    for (const source of sources) {
      const url = sourceUrl(source);
      if (!url) continue;
      if (url.startsWith("file://")) {
        const rest = url.slice("file://".length).replace(/^localhost/, "");
        try { return decodeURIComponent(rest); } catch { return rest; }
      }
      if (url.startsWith("/")) return url;
    }
    return null;
  }

  async function resolveRepoCwd(sources) {
    const direct = localPathFromSources(sources);
    if (direct) return direct;
    const name = repoNameFromSources(sources);
    if (!name) return null;
    const listing = await workspaceFolders();
    const folders = Array.isArray(listing?.folders) ? listing.folders : [];
    const hit = folders.find((folder) =>
      folder && typeof folder.name === "string" && folder.name.toLowerCase() === name.toLowerCase());
    if (hit?.path) return hit.path;
    // The bridge could not list (or did not carry it) — still give Desktop a
    // concrete path rather than falling back to the workspace root, so a session
    // started for "Claudesk" runs in the Claudesk folder.
    const root = typeof listing?.root === "string" && listing.root ? listing.root : "/workspace";
    return `${root.replace(/\/+$/, "")}/${name}`;
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
    records.set(desktopId, session);
    const meta = (await loadMeta()).sessions[desktopId];
    const base = {
      session,
      entries,
      envelopes: eventEnvelopes(entries),
      meta: meta || {},
      pendingApproval: hasPendingPermission(desktopId),
    };
    translatorFor(desktopId).seed(base.envelopes);
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
      records.set(desktopId, session);
      return sessionResponse(session, {
        meta: state.sessions[desktopId] || {},
        pendingApproval: hasPendingPermission(desktopId),
      });
    });
    if (Array.isArray(statuses) && statuses.length) {
      // `statuses` carries the app's *list filter* vocabulary
      // (`SessionListStatusFilter`: active | paused | archived |
      // provisionFailed), which is not the same axis as a row's `status`
      // (`SessionStatus`: idle | running | requires_action | archived | …).
      // Comparing them directly matched nothing, so any filtered request came
      // back empty. Map the filter onto the row's own status instead.
      const matches = (row, filter) => {
        switch (filter) {
          case "archived":
            return row.status === SESSION_STATUS.archived;
          case "active":
            // Everything not archived: a live or finished session.
            return row.status !== SESSION_STATUS.archived;
          case "paused":
            // Nothing in Desktop parks a Code session as "paused"; a session
            // waiting on an approval is the closest thing, and it is already
            // reported as requires_action.
            return row.status === SESSION_STATUS.requiresAction;
          default:
            return row.status === filter;
        }
      };
      rows = rows.filter((row) => statuses.some((filter) => matches(row, filter)));
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
        // The wire `revision` is a Date, so hand over a time — not the
        // change-counter `loadSession` keeps for its own cache.
        revision: loaded.session?.lastActivityAt ?? loaded.session?.createdAt ?? null,
        pendingApproval: loaded.pendingApproval,
      }),
      loaded,
    };
  }

  async function createSession({ title = null, model = null, permissionMode = null, cwd = null, configCwd = null, environmentId = null, sources = null } = {}) {
    const desktopId = randomUUID();
    try {
      const session = await fetchSession(desktopId).catch(() => null);
      if (session) throw new CodeError("session id collision", 409, "invalid_request_error");
    } catch (error) {
      if (error instanceof CodeError) throw error;
      // getSession on an unknown id is expected to fail; that is the happy path.
    }
    // A Code session is created by Desktop's `start`, which needs the first
    // message — so there is nothing to create yet at this point. Record the
    // caller's intent in meta and let the first `sendMessage` run `start` with
    // it (see sendMessage below). `updateSession` is deliberately NOT called:
    // Desktop rejects it for a session that does not exist, so the old code's
    // "prepare the session" step only ever logged an error.
    // Which advertised environment the caller picked. Stored even when null so
    // the row's environment is stable across reads (sessionResource reports the
    // bridge default for an unset one — see environmentForSession).
    const environment_id = typeof environmentId === "string" && environmentId ? environmentId : null;
    // Where the session should run, most specific pick first:
    //   * a top-level `cwd` — an explicit caller argument;
    //   * a repository in `config.sources` — the "Add repository" menu;
    //   * the selected environment's directory — the remote folder picker
    //     advertises one bridge environment per workspace folder, and the app
    //     carries the picked one as `environment_id`;
    //   * `config.cwd` — a directory the app sent directly, or the environment
    //     default it echoes, so a pick above is never overridden by a default.
    // No pick at all leaves the previous default in place. Resolved before the
    // meta write so the very first `sendMessage`'s `start` call runs there.
    const envCwd = folderDirectoryFromEnvironmentId(environmentId);
    const repoCwd = cwd
      || (sources ? await resolveRepoCwd(sources) : null)
      || envCwd
      || (typeof configCwd === "string" && configCwd ? configCwd : null);
    // The picker's effect is invisible on the phone beyond the toast, so leave a
    // line naming the request's sources, environment and the cwd they resolved
    // to. A create that runs in the workspace root with a pick present is the one
    // case this cannot explain from the code alone.
    log.log(`[mobile-code] create ${desktopId} env=${environmentId ?? "-"} cwd=${repoCwd ?? "(default)"} sources=${JSON.stringify(sources ?? [])}`);
    const entry = await updateMeta(desktopId, (state) => {
      state.draft = { title: title || "", model, permission_mode: permissionMode, created_at: nowIso() };
      // Keep the picker's model/mode at the TOP level too. `sendMessage`'s
      // `start` reads `meta.model` / `meta.permission_mode` (the draft is only
      // the create intent), so storing them solely under `draft` made every
      // session start with Desktop's default model — the composer's pick was
      // silently replaced on the first send.
      state.model = model || state.model || null;
      state.permission_mode = permissionMode || state.permission_mode || null;
      state.cwd = repoCwd || state.cwd || null;
      // Keep the app's own `sources` verbatim: the session DTOs echo it so the
      // phone sees the repository it picked (and the resolved cwd) instead of an
      // empty, repo-less session ("Running in the shared directory").
      if (Array.isArray(sources) && sources.length) state.sources = sources;
      if (environment_id) state.environment_id = environment_id;
      if (title) state.title = String(title).slice(0, 200);
    });
    // The reply must report the intent just persisted — the resolved cwd and the
    // picked source — not a bare `{draft}` meta: the app decides the new
    // session's directory from this payload.
    const replyMeta = { ...entry, draft: true, environment_id };
    const record = {
      sessionId: desktopId,
      title: title || "",
      model,
      permissionMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isRunning: false,
    };
    records.set(desktopId, record);
    const resource = sessionResource(record, {
      meta: replyMeta,
      revision: record.lastActivityAt,
    });
    // The app decodes a `/v1/code/sessions` reply through a `session`-keyed
    // envelope (`SessionResponseEnvelope { session: SessionResponse }`), so the
    // create route needs the list-row projection too. Keep it alongside the
    // resource, non-enumerable so it never leaks into the JSON.
    Object.defineProperty(resource, "__sessionResponse", {
      value: sessionResponse(record, { meta: replyMeta }),
      enumerable: false,
    });
    return resource;
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
    records.delete(desktopId);
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

  // The HTTP DTO is ListClientEventsResponse: data: [SessionEventEnvelope].
  // The app builds ClientEventsPage.Row only after decoding these envelopes.
  async function listEvents(id, { cursor = null, limit = 50, sortOrder = "desc" } = {}) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const loaded = await loadSession(desktopId);
    const page = pageEvents(loaded.envelopes, { cursor, limit });
    return {
      data: sortOrder === "asc" ? page.data : [...page.data].reverse(),
      next_cursor: page.next_cursor,
    };
  }

  // The whole ordered transcript, for a caller that streams rather than pages
  // it. Returns the SessionEventEnvelope[] the transcript pane renders; the
  // sequence numbers are contiguous from the session's floor. Named apart from
  // the imported `eventEnvelopes` translator, which turns raw entries into
  // envelopes — this one reads a session's stored ones.
  async function sessionEventEnvelopes(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const loaded = await loadSession(desktopId);
    return loaded.envelopes;
  }

  // The raw Desktop transcript entries, for the transcript-stream leg. That leg
  // exposes the same SDK messages as the paged history read.
  async function sessionTranscript(id) {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const loaded = await loadSession(desktopId);
    return loaded.entries;
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
    const dispatchKey = `${desktopId}:${messageUuid}`;
    if (dispatched.has(dispatchKey)) {
      log.log(`[mobile-code] send ${desktopId} duplicate messageUuid ${messageUuid} ignored`);
      return { messageId: messageUuid, threadRootId: null, createdAt: nowIso() };
    }
    const loaded = await loadSession(desktopId).catch(() => null);
    const exists = Boolean(loaded?.session);
    dispatched.add(dispatchKey);
    try {
      if (!exists) {
        const meta = (await loadMeta()).sessions[desktopId];
        await desktop.ipc(SURFACE, "start", ipcArgs.start(desktopId, {
          cwd: await resolveCwd(loaded?.session?.cwd ?? meta?.cwd ?? null),
          message: body,
          messageUuid,
          model: loaded?.session?.model ?? meta?.model ?? undefined,
          title: meta?.title || body.replace(/\s+/g, " ").trim().slice(0, 60),
          // The composer's permission mode must be set at start, or the first
          // turn runs under Desktop's default and prompts. A facade-level
          // `CLAUDE_MOBILE_PERMISSION_MODE` (e.g. `bypassPermissions`) wins over
          // the app's pick, since the Code composer has no bypass row.
          permissionMode: FORCED_PERMISSION_MODE ?? meta?.permission_mode ?? undefined,
        }));
      } else {
        if (interrupt) await desktop.ipc(SURFACE, "interrupt", ipcArgs.interrupt(desktopId)).catch(() => {});
        await desktop.ipc(SURFACE, "sendMessage", ipcArgs.sendMessage(desktopId, { message: body, messageUuid }));
      }
    } catch (error) {
      dispatched.delete(dispatchKey);
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

  // A branch name derived from the title, in the shape the real generator
  // produces (`lower-kebab`). The facade does not manage git branches; the
  // app only needs a non-empty name back so its new-session flow can continue.
  function branchNameFor(title) {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "");
    return slug || "claude-session";
  }

  // Code's new-session flow POSTs the first message and expects a title and a
  // branch name back *before* it creates the session (the app fires
  // `mobile_code_generate_title_and_branch_failure` when this leg fails). The
  // title comes from the same dust call Chat uses — gated by the titles flag so
  // a disabled generator costs no model request — and the branch is a slug of
  // it. An empty/short message still yields a usable pair.
  async function suggestTitleAndBranch(text) {
    const message = typeof text === "string" ? text.trim() : "";
    let title = "";
    if (message && titles) {
      try {
        title = (await desktop.generateTitle({ message })).replace(/\s+/g, " ").trim().slice(0, 200);
      } catch (error) {
        log.error(`[mobile-code] cannot generate a title: ${error.message}`);
      }
    }
    if (!title && message) title = message.replace(/\s+/g, " ").trim().slice(0, 60);
    return { title, branchName: branchNameFor(title) };
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

  // Desktop's `decision` is one of `once | always | deny`; the app's own
  // vocabulary ("allow"/"deny"/"allow_always") is mapped onto those here. A
  // wrong value would validate (the parameter is a plain string) and then be
  // ignored downstream, so an unknown one is rejected loudly instead.
  const PERMISSION_DECISIONS = { allow: "once", allow_once: "once", allow_always: "always", always: "always", deny: "deny" };

  async function respondToPermission(id, requestId, behavior = "allow") {
    const desktopId = desktopSessionIdFor(id);
    if (!desktopId) throw notFound();
    const decision = PERMISSION_DECISIONS[behavior];
    if (!decision) {
      throw new CodeError(`unknown permission decision: ${behavior}`, 400, "invalid_request_error");
    }
    try {
      await desktop.ipc(SURFACE, "respondToToolPermission", ipcArgs.respondToToolPermission(requestId, decision));
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

  /** The LIST leg's frames (`SessionWatchFrame`), for `GET /v1/code/sessions/watch`. */
  function watchFramesFor(desktopId, { method, payload }) {
    return translatorFor(desktopId).acceptWatch({ method, payload });
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

  // The Desktop's workspace folders, from the bridge. The mobile API has no
  // filesystem of its own — the workspace is on the far side of the bridge — so
  // this is how the "add repository" list is populated.
  async function workspaceFolders(path = null) {
    try {
      return (await desktop.folders(path)) || null;
    } catch (error) {
      log.error(`[mobile-code] cannot list workspace folders: ${error.message}`);
      return null;
    }
  }

  return {
    workspaceFolders,
    listSessions,
    getSession,
    createSession,
    updateSession,
    deleteSession,
    listEvents,
    sessionEventEnvelopes,
    sessionTranscript,
    sendMessage,
    suggestTitleAndBranch,
    interrupt,
    permissionsFor,
    respondToPermission,
    listen,
    listenAll,
    framesFor,
    watchFramesFor,
    resumeFrom,
    awaitTurn,
    activeTurnCount,
    activeTurnFor,
    abortActiveTurn,
    hasPendingPermission,
    ensureEvents,
  };
}
