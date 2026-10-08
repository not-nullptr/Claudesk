import { randomUUID } from "node:crypto";
import { bardSegments, messageText } from "./blocks.mjs";
import { DesktopError } from "./desktop-client.mjs";
import { createTurnTranslator } from "./events.mjs";
import { transcriptToMessages } from "./transcript.mjs";

// Chat engine for the mobile facade. Claude Desktop (through the Claudesk
// bridge) is the source of truth: a mobile conversation is a Desktop Chat
// session whose id is "local_" + the conversation uuid, so the same chat is
// visible in the Claudesk web UI and on the phone. The `conversation` objects
// handed to server.mjs and connect.mjs are projections of the Desktop
// transcript, with a small amount of mobile-only state (stars, drafts, the
// assistant uuids the app chose) kept in chat-meta.json.
//
// Desktop Chat transcripts are linear, so edit and retry follow the Claudesk
// web UI: rewind(sessionId, humanMessageUuid) discards that message and
// everything after it, and the new text is sent as a fresh turn.

const SURFACE = "LocalAgentModeSessions";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// claude.ai parents the first message of a conversation on this constant.
const rootParentUuid = "00000000-0000-4000-8000-000000000000";
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const cacheTtlMs = 2000;
const modelsTtlMs = 5 * 60 * 1000;
const draftTtlMs = 7 * 24 * 60 * 60 * 1000;
const silenceReconcileMs = 20000;
const silenceGiveUpMs = 90000;

function nowIso() {
  return new Date().toISOString();
}

function isoFrom(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : nowIso();
}

const sessionIdFor = (uuid) => `local_${uuid}`;
const conversationUuidFor = (sessionId) => String(sessionId).replace(/^local_/, "");
// The bridge's discriminator: a Cowork session is any LocalAgentModeSessions row
// that is not Chat (bridge/server.mjs `isChatSession`). Chat and Cowork share
// the surface, the transcript format and the start/sendMessage calls, so the
// phone surface differs only in this flag. Cowork ids are Desktop session ids,
// seen verbatim when they are not the `local_<uuid>` shape Chat uses.
const sessionIdPattern = /^[A-Za-z0-9_-]+$/;
const isCoworkSession = (session) => Boolean(session) && session.sessionType !== "chat";

// CLAUDE_MOBILE_COWORK=0 withdraws the whole Cowork surface without a rebuild.
const coworkEnabled = () => process.env.CLAUDE_MOBILE_COWORK !== "0";

function textContent(text, closed = true) {
  return [{ type: "text", text, citations: [], is_closed: closed }];
}

// BardStopReason enum numbers from the recovered schema.
const bardStopReasonNumber = {
  end_turn: 1,
  max_tokens: 2,
  tool_use: 3,
  refusal: 4,
  stop_sequence: 5,
  pause_turn: 7,
  "model-context": 9,
  user_canceled: 10,
  error: 11,
};

export class CompletionError extends Error {
  constructor(message, status = 502, type = "api_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const notFound = () => new CompletionError("conversation not found", 404, "not_found_error");

function asCompletionError(error) {
  if (error instanceof CompletionError) return error;
  if (error instanceof DesktopError) {
    return new CompletionError(`Claudesk is unavailable: ${error.message}`, error.status === 503 ? 503 : 502);
  }
  return new CompletionError(error?.message || "unexpected error", 502);
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

// Single-consumer async queue with timeouts, used to hand Desktop events to the
// streaming generator.
function createQueue() {
  const items = [];
  let wake = null;
  return {
    push(item) {
      items.push(item);
      const resolve = wake;
      wake = null;
      resolve?.();
    },
    async next(timeoutMs) {
      if (!items.length) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, timeoutMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return items.shift();
    },
  };
}

const DONE = Symbol("done");
const ABORTED = Symbol("aborted");

// CLAUDE_MOBILE_TOOL_BLOCKS=0 hides tool calls and CLAUDE_MOBILE_THINKING=0 hides
// the model's reasoning. How the iOS app draws these rows has not been verified
// on a device, so they are the way back if they misrender.
export function createEngine({
  store,
  desktop,
  log = console,
  toolBlocks = process.env.CLAUDE_MOBILE_TOOL_BLOCKS !== "0",
  thinking = process.env.CLAUDE_MOBILE_THINKING !== "0",
  titles = process.env.CLAUDE_MOBILE_TITLES !== "0",
  // The model the title generator is asked to use (see CLAUDE_TITLE_MODEL).
  // Unset, a title request carries the conversation's own model.
  titleModel = (process.env.CLAUDE_TITLE_MODEL || "").trim(),
}) {
  let identity = null;
  const activeTurns = new Map(); // conversationUuid -> { abort, assistantUuid }
  const liveTurns = new Map(); // conversationUuid -> { humanUuid, humanText, assistantUuid, text }
  const revisionWatchers = new Map(); // conversationUuid -> Set<callback>
  const cache = new Map(); // conversationUuid -> { base, at }
  const revisions = new Map();
  const listeners = new Map(); // sessionId -> Set<fn(payload)>
  const coworkDesktopIds = new Map(); // cowork uuid -> Desktop session id
  const notifyTimers = new Map();
  let lastRevision = 0;
  let subscription = null;
  let modelsCache = null;
  let metaState = null;
  let metaWrite = Promise.resolve();

  async function getIdentity() {
    if (identity) return identity;
    identity = await store.readJsonFile("identity.json", null);
    if (!identity) {
      identity = {
        email: process.env.CLAUDE_MOBILE_API_EMAIL || "",
        accountUuid: randomUUID(),
        orgUuid: randomUUID(),
        plan: process.env.CLAUDE_MOBILE_API_PLAN || "max",
        createdAt: nowIso(),
      };
      await store.writeJsonFile("identity.json", identity);
    }
    return identity;
  }

  // ---------- mobile-only metadata ----------

  async function loadMeta() {
    if (!metaState) {
      metaState = await store.readJsonFile("chat-meta.json", { conversations: {} });
      metaState.conversations ||= {};
      // Drafts are conversations the app created but never sent a message in.
      for (const [uuid, entry] of Object.entries(metaState.conversations)) {
        if (entry.draft && Date.now() - Date.parse(entry.draft.created_at) > draftTtlMs) {
          delete metaState.conversations[uuid];
        }
      }
    }
    return metaState;
  }

  async function updateMeta(uuid, mutate) {
    const state = await loadMeta();
    const entry = state.conversations[uuid] || {};
    mutate(entry);
    state.conversations[uuid] = entry;
    metaWrite = metaWrite
      .then(() => store.writeJsonFile("chat-meta.json", state))
      .catch((error) => log.error(`[mobile-engine] cannot persist chat metadata: ${error.message}`));
    await metaWrite;
    return entry;
  }

  async function dropMeta(uuid) {
    const state = await loadMeta();
    if (!state.conversations[uuid]) return;
    delete state.conversations[uuid];
    metaWrite = metaWrite
      .then(() => store.writeJsonFile("chat-meta.json", state))
      .catch((error) => log.error(`[mobile-engine] cannot persist chat metadata: ${error.message}`));
    await metaWrite;
  }

  // ---------- revisions ----------

  function bumpRevision(uuid) {
    lastRevision = Math.max(lastRevision + 1, Date.now());
    revisions.set(uuid, lastRevision);
    return lastRevision;
  }

  const revisionFor = (uuid) => revisions.get(uuid) ?? bumpRevision(uuid);

  // ---------- Desktop events ----------

  function ensureEvents() {
    if (subscription) return;
    subscription = desktop.subscribe({
      mode: "chat",
      onEvent: handleDesktopEvent,
      onReconnect: () => {
        cache.clear();
        for (const uuid of revisionWatchers.keys()) scheduleNotify(uuid);
      },
    });
  }

  function listen(sessionId, callback) {
    ensureEvents();
    let set = listeners.get(sessionId);
    if (!set) {
      set = new Set();
      listeners.set(sessionId, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (!set.size) listeners.delete(sessionId);
    };
  }

  function handleDesktopEvent(record) {
    if (record.event !== "desktop-ipc") return;
    const { surface, method, payload } = record.data || {};
    if (surface !== SURFACE) return;
    if (method === "onOnToolPermissionRequest") {
      // Chat sessions are not expected to ask; nothing here can answer a prompt.
      log.error(`[mobile-engine] tool permission requested in ${payload?.sessionId ?? "a session"} (requestId=${payload?.requestId ?? "?"}); it will wait for approval in Claudesk`);
      return;
    }
    if (method !== "onOnEvent" || typeof payload?.sessionId !== "string") return;
    for (const callback of listeners.get(payload.sessionId) || []) {
      try {
        callback(payload);
      } catch (error) {
        log.error(`[mobile-engine] event listener failed: ${error.message}`);
      }
    }
    const uuid = conversationUuidFor(payload.sessionId);
    if (!uuidPattern.test(uuid)) return;
    // Turns this service runs keep their cached base and overlay live text; any
    // other activity (the web UI, another client) invalidates the projection.
    if (!activeTurns.has(uuid)) cache.delete(uuid);
    scheduleNotify(uuid);
  }

  function scheduleNotify(uuid, delayMs = 250) {
    if (!revisionWatchers.get(uuid)?.size || notifyTimers.has(uuid)) return;
    notifyTimers.set(uuid, setTimeout(async () => {
      notifyTimers.delete(uuid);
      try {
        bumpRevision(uuid);
        notifyBardWatchers(await loadConversation(uuid));
      } catch {
        // The conversation may have been deleted meanwhile.
      }
    }, delayMs));
  }

  // ---------- conversation projection ----------

  function draftConversation(uuid, entry) {
    return {
      uuid,
      desktopId: null,
      session_type: entry.draft.kind === "cowork" ? "cowork" : "chat",
      cowork: entry.draft.cowork || null,
      name: entry.draft.name || "",
      model: entry.draft.model,
      is_starred: Boolean(entry.is_starred),
      is_archived: false,
      is_temporary: Boolean(entry.draft.is_temporary),
      created_at: entry.draft.created_at,
      updated_at: entry.draft.created_at,
      current_leaf_message_uuid: null,
      settings: conversationSettings(entry),
      revision: revisionFor(uuid),
      is_running: false,
      draft: true,
      messages: [],
    };
  }

  function project(uuid, session, entries, entry) {
    const { messages, leaf } = transcriptToMessages(entries, {
      assistantUuidFor: (humanUuid) => entry?.assistantByHuman?.[humanUuid],
      toolBlocks,
      thinking,
    });
    return {
      uuid,
      desktopId: session.sessionId,
      session_type: isCoworkSession(session) ? "cowork" : "chat",
      cowork: entry?.draft?.cowork || null,
      name: session.title || "",
      model: session.model,
      is_starred: Boolean(entry?.is_starred),
      is_archived: Boolean(session.isArchived),
      is_temporary: Boolean(entry?.is_temporary),
      created_at: isoFrom(session.createdAt),
      updated_at: isoFrom(session.lastActivityAt),
      current_leaf_message_uuid: leaf,
      settings: conversationSettings(entry),
      revision: revisionFor(uuid),
      is_running: Boolean(session.isRunning),
      messages,
    };
  }

  // Overlays the turn this service is streaming: Desktop's transcript lags the
  // live stream, and a new human message may not be in it yet.
  function applyLive(uuid, base) {
    const live = liveTurns.get(uuid);
    if (!live) return base;
    const messages = [...base.messages];
    let humanIndex = messages.findIndex((message) => message.uuid === live.humanUuid);
    if (humanIndex < 0) {
      messages.push({
        uuid: live.humanUuid,
        parent_uuid: messages.at(-1)?.uuid ?? null,
        sender: "human",
        index: messages.length,
        created_at: live.startedAt,
        updated_at: live.startedAt,
        content: textContent(live.humanText),
        attachments: [],
        files: [],
      });
      humanIndex = messages.length - 1;
    }
    const assistant = {
      uuid: live.assistantUuid,
      parent_uuid: live.humanUuid,
      sender: "assistant",
      index: humanIndex + 1,
      created_at: live.startedAt,
      updated_at: nowIso(),
      content: live.blocks.length ? live.blocks : textContent(live.text, false),
      attachments: [],
      files: [],
      live: true,
    };
    const next = messages[humanIndex + 1];
    if (next?.sender === "assistant") messages[humanIndex + 1] = assistant;
    else messages.splice(humanIndex + 1, 0, assistant);
    return {
      ...base,
      messages,
      current_leaf_message_uuid: live.assistantUuid,
      is_running: true,
      revision: revisionFor(uuid),
    };
  }

  // `kind` keeps the two phone surfaces apart: a Chat read must never serve a
  // Cowork session and vice versa, even though Desktop keeps both on one surface.
  async function loadConversation(uuid, { fresh = false, kind = "chat" } = {}) {
    if (kind === "chat" && !uuidPattern.test(String(uuid))) throw notFound();
    if (kind === "cowork" && !sessionIdPattern.test(String(uuid))) throw notFound();
    const hit = cache.get(uuid);
    if (!fresh && hit && (activeTurns.has(uuid) || Date.now() - hit.at < cacheTtlMs)) {
      return applyLive(uuid, { ...hit.base, revision: revisionFor(uuid) });
    }
    const sessionId = kind === "cowork" ? coworkDesktopIdFor(uuid) : sessionIdFor(uuid);
    let session;
    let entries = [];
    try {
      session = await desktop.ipc(SURFACE, "getSession", [sessionId]);
      if (session) entries = (await desktop.ipc(SURFACE, "getTranscript", [sessionId])) || [];
    } catch (error) {
      throw asCompletionError(error);
    }
    const entry = (await loadMeta()).conversations[uuid];
    if (!session) {
      if (entry?.draft) return applyLive(uuid, draftConversation(uuid, entry));
      throw notFound();
    }
    const wanted = kind === "cowork" ? isCoworkSession(session) : session.sessionType === "chat";
    if (!wanted) throw notFound();
    const base = project(uuid, session, entries, entry);
    cache.set(uuid, { base, at: Date.now() });
    return applyLive(uuid, base);
  }

  const getConversation = (uuid) => loadConversation(uuid);
  const getCoworkSession = (uuid) => loadConversation(uuid, { kind: "cowork" });

  // Cowork id mapping. A Desktop session id that looks like `local_<uuid>` gets
  // the same phone uuid Chat uses; anything else is its own uuid, remembered
  // from the last listing so a read maps back to the exact Desktop id.
  function coworkUuidFor(desktopId) {
    const stripped = conversationUuidFor(desktopId);
    return uuidPattern.test(stripped) ? stripped : String(desktopId);
  }

  function coworkDesktopIdFor(uuid) {
    if (coworkDesktopIds.has(uuid)) return coworkDesktopIds.get(uuid);
    return uuidPattern.test(String(uuid)) ? sessionIdFor(uuid) : String(uuid);
  }

  // The Desktop session id a projected conversation came from.
  const desktopIdFor = (conversation) =>
    conversation.desktopId
    || (conversation.session_type === "cowork" ? coworkDesktopIdFor(conversation.uuid) : sessionIdFor(conversation.uuid));

  // Which phone surface an id belongs to, for the Connect actions (rename, star,
  // model, settings) that carry only the id. Chat is tried first because it is
  // the common case; a Cowork id fails the chat read with 404 and falls through.
  async function conversationKind(uuid) {
    if (!coworkEnabled()) return "chat";
    try {
      await loadConversation(uuid, { kind: "chat" });
      return "chat";
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    return "cowork";
  }

  // ---------- conversations ----------

  function mapConversation(conversation) {
    return {
      uuid: conversation.uuid,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      name: conversation.name,
      model: conversation.model,
      is_starred: Boolean(conversation.is_starred),
      is_archived: Boolean(conversation.is_archived),
      is_temporary: Boolean(conversation.is_temporary),
      settings: conversation.settings || { enabled_mcp_tools: {} },
      current_leaf_message_uuid: conversation.current_leaf_message_uuid || null,
      revision: conversation.revision || 0,
    };
  }

  function mapMessage(message) {
    return {
      uuid: message.uuid,
      parent_message_uuid: message.parent_uuid || null,
      created_at: message.created_at,
      updated_at: message.updated_at || message.created_at,
      sender: message.sender,
      index: message.index,
      content: message.content,
      attachments: message.attachments || [],
      files: message.files || [],
    };
  }

  function mapConversationWithMessages(conversation) {
    return {
      ...mapConversation(conversation),
      chat_messages: conversation.messages.map(mapMessage),
      is_wiggle_enabled: false,
    };
  }

  async function createConversation({ uuid, name, model, isTemporary, kind = "chat", cowork = null }) {
    const id = uuidPattern.test(String(uuid)) ? uuid : randomUUID();
    // Never adopt an id that belongs to a session of the other kind: starting a
    // Chat session under a Cowork id would write into that session, and the app
    // opens each surface through its own path.
    let existing;
    try {
      existing = await desktop.ipc(SURFACE, "getSession", [sessionIdFor(id)]);
    } catch (error) {
      throw asCompletionError(error);
    }
    if (existing) {
      const sameKind = kind === "cowork" ? isCoworkSession(existing) : existing.sessionType === "chat";
      if (!sameKind) {
        throw new CompletionError("conversation id is already in use", 409, "invalid_request_error");
      }
      return loadConversation(id, { kind });
    }
    const resolved = model || (await defaultModel());
    const entry = await updateMeta(id, (value) => {
      value.draft = {
        kind,
        name: typeof name === "string" ? name.slice(0, 200) : "",
        model: resolved,
        is_temporary: Boolean(isTemporary),
        created_at: nowIso(),
        ...(cowork ? { cowork } : {}),
      };
    });
    return draftConversation(id, entry);
  }

  async function updateConversation(uuid, patch, kind = "chat") {
    const conversation = await loadConversation(uuid, { kind });
    const sessionId = desktopIdFor(conversation);
    try {
      // The app sends an empty name after a chat's first turn; applying it would
      // erase the title, so only real names are written.
      if (typeof patch.name === "string" && patch.name.trim()) {
        const name = patch.name.trim().slice(0, 200);
        if (conversation.draft) await updateMeta(uuid, (entry) => { entry.draft.name = name; });
        else await desktop.ipc(SURFACE, "updateSession", [sessionId, { title: name }]);
      }
      if (typeof patch.model === "string" && patch.model) {
        if (conversation.draft) await updateMeta(uuid, (entry) => { entry.draft.model = patch.model; });
        else if (patch.model !== conversation.model) await desktop.ipc(SURFACE, "setModel", [sessionId, patch.model]);
      }
      if (patch.effort || patch.thinking_mode) {
        const choice = { effort: patch.effort, thinkingMode: patch.thinking_mode };
        await rememberThinking(uuid, choice);
        if (!conversation.draft) {
          await applyThinking(sessionId, await thinkingFor(conversation.model, choice));
        }
      }
      // Desktop can archive a Chat session but has no way to restore one, so
      // un-archiving is not applied.
      if (patch.is_archived === true && !conversation.draft) {
        await desktop.ipc(SURFACE, "archive", [sessionId]);
      }
    } catch (error) {
      throw asCompletionError(error);
    }
    if (typeof patch.is_starred === "boolean") {
      await updateMeta(uuid, (entry) => { entry.is_starred = patch.is_starred; });
    }
    cache.delete(uuid);
    bumpRevision(uuid);
    const updated = await loadConversation(uuid, { fresh: true, kind });
    notifyBardWatchers(updated);
    return updated;
  }

  async function deleteConversation(uuid, kind = "chat") {
    const conversation = await loadConversation(uuid, { kind });
    abortActiveTurn(uuid);
    notifyBardWatchers({ uuid, deleted: true });
    if (!conversation.draft) {
      try {
        await desktop.ipc(SURFACE, "delete", [desktopIdFor(conversation)]);
      } catch (error) {
        throw asCompletionError(error);
      }
    }
    cache.delete(uuid);
    liveTurns.delete(uuid);
    await dropMeta(uuid);
  }

  async function listConversations() {
    let sessions;
    try {
      sessions = (await desktop.ipc(SURFACE, "getAll", [])) || [];
    } catch (error) {
      throw asCompletionError(error);
    }
    const state = await loadMeta();
    const chats = sessions
      .filter((session) => session?.sessionType === "chat" && uuidPattern.test(conversationUuidFor(session.sessionId)))
      .map((session) => {
        const uuid = conversationUuidFor(session.sessionId);
        const entry = state.conversations[uuid];
        const initial = String(session.initialMessage || "").replace(/\s+/g, " ").trim();
        return {
          uuid,
          name: session.title || initial.slice(0, 60),
          preview: initial.slice(0, 120),
          model: session.model,
          is_starred: Boolean(entry?.is_starred),
          is_archived: Boolean(session.isArchived),
          is_temporary: Boolean(entry?.is_temporary),
          created_at: isoFrom(session.createdAt),
          updated_at: isoFrom(session.lastActivityAt),
          current_leaf_message_uuid: null,
          settings: conversationSettings(entry),
          revision: revisionFor(uuid),
          messages: [],
        };
      });
    const known = new Set(chats.map((conversation) => conversation.uuid));
    const drafts = Object.entries(state.conversations)
      .filter(([uuid, entry]) => entry.draft && entry.draft.kind !== "cowork" && !known.has(uuid))
      .map(([uuid, entry]) => draftConversation(uuid, entry));
    return [...chats, ...drafts].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  // ---------- Cowork ----------

  // The non-chat half of LocalAgentModeSessions, as the phone sees it. Ids are
  // remembered so a later read maps back to the exact Desktop session id.
  async function listCoworkSessions() {
    if (!coworkEnabled()) return [];
    let sessions;
    try {
      sessions = (await desktop.ipc(SURFACE, "getAll", [])) || [];
    } catch (error) {
      throw asCompletionError(error);
    }
    const state = await loadMeta();
    const rows = sessions
      .filter((session) => isCoworkSession(session)
        && sessionIdPattern.test(String(session.sessionId ?? "")))
      .map((session) => {
        const uuid = coworkUuidFor(session.sessionId);
        coworkDesktopIds.set(uuid, session.sessionId);
        const entry = state.conversations[uuid];
        const initial = String(session.initialMessage || "").replace(/\s+/g, " ").trim();
        return {
          uuid,
          name: session.title || initial.slice(0, 60),
          preview: initial.slice(0, 120),
          model: session.model,
          is_starred: Boolean(entry?.is_starred),
          is_archived: Boolean(session.isArchived),
          created_at: isoFrom(session.createdAt),
          updated_at: isoFrom(session.lastActivityAt),
          is_running: Boolean(session.isRunning),
        };
      });
    // A conversation the app opened but has not sent in is a local draft until
    // the first message runs Desktop's start.
    const known = new Set(rows.map((row) => row.uuid));
    const drafts = Object.entries(state.conversations)
      .filter(([uuid, entry]) => entry.draft?.kind === "cowork" && !known.has(uuid))
      .map(([uuid, entry]) => ({
        uuid,
        name: entry.draft.name || "",
        preview: "",
        model: entry.draft.model,
        is_starred: Boolean(entry.is_starred),
        is_archived: false,
        created_at: entry.draft.created_at,
        updated_at: entry.draft.created_at,
        is_running: false,
      }));
    return [...rows, ...drafts].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  // ---------- models ----------

  async function chatModels() {
    if (modelsCache && Date.now() - modelsCache.at < modelsTtlMs) return modelsCache.value;
    try {
      const value = await desktop.chatModels();
      modelsCache = { value, at: Date.now() };
      return value;
    } catch (error) {
      if (modelsCache) return modelsCache.value;
      throw asCompletionError(error);
    }
  }

  async function defaultModel() {
    return (await chatModels()).defaultModel || undefined;
  }

  // The app's own `ThinkingOptions`: `effortOptions` and `modeOptions` are BOTH
  // non-optional `IdentifiedArray`s, and an effort option's `recommended` is a
  // non-optional `Bool`. Desktop's catalog is shaped liberally by comparison —
  // a Code model offers effort only, a mode-only model offers no effort at all,
  // and only the one recommended effort carries the flag. Passed through
  // verbatim, whichever model disagrees with the app fails the decode of the
  // whole `IdentifiedArray<ModelEntry>`, and every model goes with it: the
  // composer keeps whatever label it had and the picker opens on nothing.
  // `badge` is dropped because its `Variant` enum's wire form is unproven and
  // the field is optional anyway.
  function thinkingOptions(thinking) {
    if (!thinking || typeof thinking !== "object") return null;
    const usable = (raw) => (raw && typeof raw.id === "string" && typeof raw.name === "string" ? raw : null);
    const shared = (raw) => ({
      ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
      ...(raw.tooltip && typeof raw.tooltip.content === "string" && raw.tooltip.content
        ? { tooltip: { content: raw.tooltip.content } }
        : {}),
    });
    const options = (list) => (Array.isArray(list) ? list : []).map(usable).filter(Boolean);
    return {
      ...(typeof thinking.description === "string" && thinking.description
        ? { description: thinking.description }
        : {}),
      effort_options: options(thinking.effort_options).map((raw) => ({
        id: raw.id,
        name: raw.name,
        ...shared(raw),
        // `recommended` is always present; Desktop marks at most one option.
        recommended: raw.recommended === true,
      })),
      mode_options: options(thinking.mode_options).map((raw) => ({
        id: raw.id,
        name: raw.name,
        ...shared(raw),
      })),
    };
  }

  // Desktop's own catalog for one surface. The Chat composer reads the `chat`
  // list, the Code composer the `code` one — they are not interchangeable:
  // Code's models offer effort without the thinking-mode switch, and a picker
  // built from the wrong list offers options the surface cannot run. A surface
  // Desktop does not publish falls back to the chat list.
  async function listModels(surface = "chat") {
    const catalog = await chatModels();
    const entry = catalog.surfaces?.[surface] || catalog;
    return (entry.models || []).map((model) => {
      const thinking = thinkingOptions(model.thinking);
      return {
        id: model.id,
        name: model.name,
        short_name: model.name.length > 16 ? `${model.name.slice(0, 15)}…` : model.name,
        section: "main",
        disabled: false,
        capabilities: {},
        ...(model.description ? { description: model.description } : {}),
        // The same effort/mode options the web UI offers; the app builds its
        // effort picker from them.
        ...(thinking ? { thinking } : {}),
        ...(model.supports1mContext ? { supports_1m_context: true } : {}),
      };
    });
  }

  // What the app picked for reasoning, limited to what the model offers. Desktop
  // takes the effort level separately from the on/off thinking switch.
  async function thinkingFor(model, { effort, thinkingMode } = {}) {
    if (!effort && !thinkingMode) return {};
    const { models } = await chatModels().catch(() => ({ models: [] }));
    const config = models.find((item) => item.id === model)?.thinking;
    if (!config) return {};
    const offers = (options, id) => Array.isArray(options) && options.some((option) => option?.id === id);
    return {
      effort: offers(config.effort_options, effort) ? effort : undefined,
      extendedThinking: offers(config.mode_options, thinkingMode) ? thinkingMode !== "off" : undefined,
    };
  }

  // Pushes a pick to an existing Desktop session. Desktop clamps the effort to
  // what the model supports; a failure must not fail the turn.
  async function applyThinking(sessionId, { effort, extendedThinking }) {
    try {
      if (effort) await desktop.ipc(SURFACE, "setEffort", [sessionId, effort]);
      if (extendedThinking !== undefined) await desktop.ipc(SURFACE, "setExtendedThinking", [sessionId, extendedThinking]);
    } catch (error) {
      log.error(`[mobile-engine] cannot apply reasoning settings: ${error.message}`);
    }
  }

  function conversationSettings(entry) {
    const settings = { enabled_mcp_tools: {} };
    if (entry?.thinking?.effort) settings.effort_level_token = entry.thinking.effort;
    if (entry?.thinking?.mode) settings.thinking_mode_token = entry.thinking.mode;
    return settings;
  }

  function bardSettings(settings) {
    return {
      ...(settings?.effort_level_token ? { effortLevelToken: settings.effort_level_token } : {}),
      ...(settings?.thinking_mode_token ? { thinkingModeToken: settings.thinking_mode_token } : {}),
    };
  }

  async function rememberThinking(uuid, { effort, thinkingMode }) {
    if (!effort && !thinkingMode) return;
    await updateMeta(uuid, (entry) => {
      entry.thinking = {
        ...entry.thinking,
        ...(effort ? { effort } : {}),
        ...(thinkingMode ? { mode: thinkingMode } : {}),
      };
    });
  }

  // ---------- turn plumbing ----------

  function registerActiveTurn(conversationUuid, turn) {
    activeTurns.set(conversationUuid, turn);
  }

  function activeTurnFor(conversationUuid) {
    return activeTurns.get(conversationUuid) || null;
  }

  function activeTurnCount() {
    return activeTurns.size;
  }

  function clearActiveTurn(conversationUuid) {
    activeTurns.delete(conversationUuid);
  }

  function abortActiveTurn(conversationUuid) {
    const turn = activeTurns.get(conversationUuid);
    if (turn?.abort) {
      try {
        turn.abort.abort(new Error("client stop request"));
      } catch {
        turn.abort.abort();
      }
    }
  }

  // Attachments the app uploaded to this service (prepare-upload + upload) are
  // referenced from the completion request by uuid or by name and size.
  function normalizeAttachments(input) {
    const found = [];
    const add = (item) => {
      const id = item?.file_uuid || item?.uuid || item?.id || (typeof item === "string" ? item : undefined);
      found.push({
        id: uuidPattern.test(String(id)) ? id : undefined,
        name: item?.file_name ?? item?.fileName,
        size: item?.file_size ?? item?.fileSize,
        type: item?.file_type ?? item?.mediaType ?? item?.media_type,
      });
    };
    for (const group of input) for (const item of Array.isArray(group) ? group : []) add(item);
    const seen = new Set();
    return found.filter((item) => {
      const key = item.id || `${item.name}:${item.size}`;
      if (seen.has(key) || (!item.id && !item.name)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
  }

  async function resolveStored(attachment) {
    if (attachment.id) {
      const stored = await store.readUploadedFile(attachment.id);
      if (stored) return stored;
    }
    return attachment.name ? store.findUpload({ name: attachment.name, size: attachment.size }) : null;
  }

  // Decides how a completion request maps onto Desktop operations.
  async function prepareTurn({ conversation, body, retry = false }) {
    const turnUuids = body.turn_message_uuids || {};
    const model = typeof body.model === "string" && body.model ? body.model : undefined;
    const effort = typeof body.effort === "string" && body.effort ? body.effort : undefined;
    const thinkingMode = typeof body.thinking_mode === "string" && body.thinking_mode ? body.thinking_mode : undefined;
    const assistantRaw = turnUuids.assistant_message_uuid || body.assistant_message_uuid;
    const assistantUuid = uuidPattern.test(String(assistantRaw)) ? assistantRaw : randomUUID();

    if (retry) {
      if (!uuidPattern.test(String(assistantRaw))) {
        throw new CompletionError("assistant_message_uuid is required", 400, "invalid_request_error");
      }
      const assistant = conversation.messages.find(
        (message) => message.uuid === assistantRaw && message.sender === "assistant",
      );
      const human = assistant && conversation.messages.find((message) => message.uuid === assistant.parent_uuid);
      if (!human) throw new CompletionError("message to retry not found", 404, "not_found_error");
      return {
        humanMessage: human,
        assistantUuid,
        model,
        plan: { kind: "retry", humanUuid: human.uuid, text: "", attachments: [], effort, thinkingMode },
      };
    }

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const attachments = normalizeAttachments([body.attachments, body.files]);
    if (!prompt.trim() && !attachments.length) {
      throw new CompletionError("prompt is required", 400, "invalid_request_error");
    }
    const humanRaw = turnUuids.human_message_uuid || body.human_message_uuid;
    const humanUuid = uuidPattern.test(String(humanRaw)) ? humanRaw : randomUUID();
    const parent = typeof body.parent_message_uuid === "string" && body.parent_message_uuid
      ? body.parent_message_uuid
      : null;
    const messages = conversation.messages;

    let kind = conversation.draft ? "start" : "send";
    let rewindTo;
    const existing = messages.find((message) => message.uuid === humanUuid);
    if (existing) {
      // The app resent a message it already sent: the same text is a retried
      // delivery; different text is an edit of that message.
      const sameText = existing.content?.map((part) => part.text).join("") === prompt;
      if (sameText) kind = "replay";
      else {
        kind = "edit";
        rewindTo = humanUuid;
      }
    } else if (!conversation.draft) {
      if (parent === rootParentUuid && messages.length) {
        kind = "edit";
        rewindTo = messages.find((message) => message.sender === "human")?.uuid;
      } else if (parent) {
        const index = messages.findIndex((message) => message.uuid === parent);
        const next = index >= 0 ? messages[index + 1] : undefined;
        if (next?.sender === "human") {
          kind = "edit";
          rewindTo = next.uuid;
        }
      }
    }

    const humanMessage = {
      uuid: humanUuid,
      parent_uuid: parent,
      sender: "human",
      index: messages.length,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: textContent(prompt),
      attachments: [],
      files: [],
    };
    return {
      humanMessage,
      assistantUuid,
      model,
      plan: { kind, humanUuid, text: prompt, attachments, rewindTo, effort, thinkingMode },
    };
  }

  // Turns stored uploads into Desktop arguments: images travel inline, anything
  // else is uploaded under /workspace/RemoteUploads and referenced by an
  // @"path" mention at the start of the message, which is how Claude Code and
  // Chat in the web UI hand files to the model.
  async function buildAttachments(attachments) {
    const images = [];
    const uploads = [];
    const seen = new Set();
    for (const attachment of attachments) {
      const stored = await resolveStored(attachment);
      if (!stored?.bytes) {
        log.error(`[mobile-engine] attachment ${attachment.name || attachment.id} is not available; skipping`);
        continue;
      }
      // The same upload can be listed under both attachments and files.
      const storedId = stored.meta?.file_uuid || stored.meta?.uuid || attachment.id;
      if (storedId) {
        if (seen.has(storedId)) continue;
        seen.add(storedId);
      }
      const name = stored.meta?.file_name || attachment.name || "attachment";
      const type = stored.meta?.file_type || attachment.type || "";
      if (imageTypes.has(type)) images.push({ name, mimeType: type, base64: stored.bytes.toString("base64") });
      else uploads.push({ name, data: stored.bytes });
    }
    const mentions = uploads.length ? (await desktop.upload(uploads)).paths : [];
    return { images, mentions };
  }

  function humanImages(entries, humanUuid) {
    const entry = entries.find((item) => item?.uuid === humanUuid);
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    return blocks
      .filter((block) => block?.type === "image" && block.source?.type === "base64")
      .map((block, index) => ({
        name: `image-${index + 1}`,
        mimeType: block.source.media_type,
        base64: block.source.data,
      }));
  }

  async function dispatch(conversation, plan, assistantUuid, model) {
    const sessionId = desktopIdFor(conversation);
    let { text } = plan;
    let images = [];
    let mentions = [];

    if (plan.kind === "retry") {
      // rewind returns the discarded prompt text; resend it with its images.
      const entries = (await desktop.ipc(SURFACE, "getTranscript", [sessionId])) || [];
      images = humanImages(entries, plan.humanUuid);
      const removed = await desktop.ipc(SURFACE, "rewind", [sessionId, plan.humanUuid]);
      text = typeof removed === "string" && removed ? removed : conversation.messages
        .find((message) => message.uuid === plan.humanUuid)?.content?.map((part) => part.text).join("") || "";
    } else {
      ({ images, mentions } = await buildAttachments(plan.attachments));
      if (plan.kind === "edit" && plan.rewindTo) {
        await desktop.ipc(SURFACE, "rewind", [sessionId, plan.rewindTo]);
      }
    }
    const message = mentions.length
      ? `${mentions.map((path) => `@"${path}"`).join("\n")}\n${text}`.trimEnd()
      : text;

    await updateMeta(conversation.uuid, (entry) => {
      entry.assistantByHuman = { ...(entry.assistantByHuman || {}), [plan.humanUuid]: assistantUuid };
    });

    const thinkingPick = await thinkingFor(model || conversation.model, plan);
    await rememberThinking(conversation.uuid, plan);

    if (plan.kind === "start") {
      const title = (conversation.name || text).replace(/\s+/g, " ").trim().slice(0, 60);
      await desktop.ipc(SURFACE, "start", [{
        sessionId,
        message,
        messageUuid: plan.humanUuid,
        model: model || conversation.model,
        title,
        sessionType: conversation.session_type === "cowork" ? "cowork" : "chat",
        images,
        userSelectedFiles: [],
        userSelectedFolders: [],
        syntheticMessage: false,
        documentFunnelEnabled: false,
        // Cowork carries the paired device (and any attached folders) the app
        // picked; Chat has neither.
        ...(conversation.cowork?.deviceId ? { deviceId: conversation.cowork.deviceId } : {}),
        ...(conversation.cowork?.attachedFolders?.length
          ? { attachedFolders: conversation.cowork.attachedFolders } : {}),
        ...(thinkingPick.extendedThinking !== undefined ? { extendedThinkingEnabled: thinkingPick.extendedThinking } : {}),
      }]);
      // start takes no effort level, so it applies once the session exists.
      await applyThinking(sessionId, { effort: thinkingPick.effort });
      if (titles && !conversation.name && text.trim()) {
        void generateTitle(conversation.uuid, text, model || conversation.model, title, sessionId);
      }
      await updateMeta(conversation.uuid, (entry) => {
        delete entry.draft;
        entry.is_temporary = Boolean(conversation.is_temporary);
      });
    } else {
      if (model && model !== conversation.model) await desktop.ipc(SURFACE, "setModel", [sessionId, model]);
      await applyThinking(sessionId, { effort: thinkingPick.effort });
      // extendedThinking is sendMessage's twelfth argument.
      await desktop.ipc(SURFACE, "sendMessage", [
        sessionId,
        message,
        images.length ? images : undefined,
        undefined,
        plan.humanUuid,
        ...(thinkingPick.extendedThinking === undefined
          ? []
          : [undefined, undefined, undefined, undefined, undefined, undefined, thinkingPick.extendedThinking]),
      ]);
    }
    cache.delete(conversation.uuid);
  }

  // Replaces the provisional title (the first message) with one Desktop writes,
  // as the web UI does for a new chat. Runs in the background; a chat the user
  // renamed in the meantime keeps its name.
  async function generateTitle(uuid, text, model, placeholder, desktopId = null) {
    const sessionId = desktopId || sessionIdFor(uuid);
    try {
      const title = (await desktop.generateTitle({ message: text, model: titleModel || model })).replace(/\s+/g, " ").trim().slice(0, 200);
      if (!title) return;
      const session = await desktop.ipc(SURFACE, "getSession", [sessionId]);
      if (!session || (session.title && session.title !== placeholder)) return;
      await desktop.ipc(SURFACE, "updateSession", [sessionId, { title }]);
      cache.delete(uuid);
      scheduleNotify(uuid, 0);
    } catch (error) {
      log.error(`[mobile-engine] cannot title ${sessionId}: ${error.message}`);
    }
  }

  async function stopSession(sessionId) {
    try {
      await desktop.ipc(SURFACE, "stop", [sessionId]);
    } catch (error) {
      log.error(`[mobile-engine] stop failed: ${error.message}`);
    }
  }

  // The assistant text Desktop has stored for a human turn.
  async function storedAnswer(sessionId, humanUuid) {
    const entries = (await desktop.ipc(SURFACE, "getTranscript", [sessionId])) || [];
    const { messages } = transcriptToMessages(entries, { toolBlocks: false, thinking: false });
    const assistant = messages.find((message) => message.sender === "assistant" && message.parent_uuid === humanUuid);
    return assistant ? messageText(assistant) : "";
  }

  // Streams one assistant turn as canonical SSE events; REST and Connect
  // callers translate those into their wire formats.
  async function* streamAssistantTurn(conversation, { humanMessage, assistantUuid, model, signal, plan }) {
    const uuid = conversation.uuid;
    const sessionId = desktopIdFor(conversation);
    const humanUuid = humanMessage.uuid;
    const translator = createTurnTranslator({
      sessionId,
      humanUuid,
      assistantUuid,
      model: model || conversation.model,
      toolBlocks,
      thinking,
    });
    const queue = createQueue();
    const live = {
      humanUuid,
      humanText: plan.text || humanMessage.content?.map((part) => part.text).join("") || "",
      assistantUuid,
      text: "",
      blocks: [],
      version: -1,
      startedAt: nowIso(),
    };
    const stopListening = listen(sessionId, (payload) => {
      for (const event of translator.accept(payload)) queue.push(event);
      if (translator.version !== live.version) {
        live.version = translator.version;
        live.text = translator.text;
        live.blocks = translator.blocks;
        scheduleNotify(uuid);
      }
      if (translator.finished) queue.push(DONE);
    });
    const onAbort = () => queue.push(ABORTED);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      liveTurns.set(uuid, live);
      scheduleNotify(uuid, 0);
      if (plan.kind === "replay") {
        for (const event of translator.complete(await storedAnswer(sessionId, humanUuid))) yield event;
        return translator.stopReason;
      }
      try {
        await dispatch(conversation, plan, assistantUuid, model);
      } catch (error) {
        throw asCompletionError(error);
      }

      let silentMs = 0;
      while (!translator.finished) {
        if (signal?.aborted) {
          await stopSession(sessionId);
          throw abortError();
        }
        const item = await queue.next(1000);
        if (item === ABORTED) {
          await stopSession(sessionId);
          throw abortError();
        }
        if (item === undefined) {
          silentMs += 1000;
          if (silentMs % silenceReconcileMs === 0) {
            // No events for a while: the stream may have been missed.
            const session = await desktop.ipc(SURFACE, "getSession", [sessionId]).catch(() => null);
            if (session === null || session === undefined) throw new CompletionError("conversation was deleted", 404, "not_found_error");
            if (session.isRunning === false) {
              const answer = await storedAnswer(sessionId, humanUuid).catch(() => "");
              if (answer || silentMs >= silenceGiveUpMs) {
                if (!answer) throw new CompletionError("no response from Claudesk", 502);
                for (const event of translator.complete(answer)) yield event;
                break;
              }
            }
          }
          continue;
        }
        silentMs = 0;
        if (item !== DONE) yield item;
      }
      for (let item = await queue.next(0); item !== undefined; item = await queue.next(0)) {
        if (item !== DONE && item !== ABORTED) yield item;
      }
      if (translator.error) throw new CompletionError(translator.error.message, 502);
      return translator.stopReason;
    } finally {
      stopListening();
      signal?.removeEventListener("abort", onAbort);
      liveTurns.delete(uuid);
      cache.delete(uuid);
    }
  }

  // Called by the REST handler once the stream ends; the assistant text itself
  // already lives in Desktop's transcript.
  async function finishAssistantTurn(conversation) {
    cache.delete(conversation.uuid);
    bumpRevision(conversation.uuid);
    try {
      notifyBardWatchers(await loadConversation(conversation.uuid, { fresh: true }));
    } catch {
      // Deleted while streaming.
    }
  }

  // The app tracks a branch pointer; the Desktop transcript has one branch.
  async function saveConversation(conversation) {
    return conversation;
  }

  // ---------- Connect surface ----------

  // Starts the turn in the background; the app watches progress through
  // ReadConversation / StreamTimeline snapshots.
  async function connectSendMessage({
    conversationId, messageId, assistantMessageId, parentMessageId, text, model, attachments, effort, thinkingMode,
    kind = "chat", cowork = null,
  }) {
    let conversation;
    try {
      conversation = await loadConversation(conversationId, { kind });
    } catch (error) {
      if (error.status !== 404) throw error;
      conversation = await createConversation({ uuid: conversationId, model, kind, cowork });
    }
    if (activeTurns.has(conversationId)) return conversation;
    const turn = await prepareTurn({
      conversation,
      body: {
        prompt: String(text || ""),
        turn_message_uuids: { human_message_uuid: messageId, assistant_message_uuid: assistantMessageId },
        parent_message_uuid: parentMessageId || undefined,
        model,
        effort,
        thinking_mode: thinkingMode,
        attachments: attachments || [],
      },
    });
    const abort = new AbortController();
    registerActiveTurn(conversationId, { abort, assistantUuid: turn.assistantUuid });
    notifyBardWatchers(conversation);
    (async () => {
      try {
        // streamAssistantTurn keeps the live text current for watchers.
        for await (const _event of streamAssistantTurn(conversation, {
          humanMessage: turn.humanMessage,
          assistantUuid: turn.assistantUuid,
          model: turn.model,
          signal: abort.signal,
          plan: turn.plan,
        })) { /* nothing to forward on the Connect path */ }
      } catch (error) {
        if (error.name !== "AbortError") {
          log.error(`[mobile-engine] background turn failed: ${error.message}`);
        }
      } finally {
        clearActiveTurn(conversationId);
        cache.delete(conversationId);
        scheduleNotify(conversationId, 0);
      }
    })();
    return conversation;
  }

  // The Cowork send/create leg. `continueCoworkSessionId` names an existing
  // session; its absence (with a targetDeviceId) means the app is starting one.
  async function connectSendCoworkMessage({
    conversationId, continueCoworkSessionId, messageId, assistantMessageId, parentMessageId,
    text, model, attachments, effort, thinkingMode, deviceId, attachedFolders,
  }) {
    const target = continueCoworkSessionId || conversationId;
    if (!sessionIdPattern.test(String(target ?? ""))) {
      throw new CompletionError("invalid cowork session id", 400, "invalid_request_error");
    }
    return connectSendMessage({
      conversationId: target,
      messageId,
      assistantMessageId,
      parentMessageId,
      text,
      model,
      attachments,
      effort,
      thinkingMode,
      kind: "cowork",
      cowork: { deviceId, attachedFolders },
    });
  }

  // ---------- Recents / Bard projections ----------

  function chatPreview(conversation) {
    if (conversation.preview) return conversation.preview;
    const last = conversation.messages.at(-1);
    const text = last?.content?.find?.((part) => part?.type === "text")?.text || "";
    return text.slice(0, 120);
  }

  async function listRecents({ starredOnly = false, archivedOnly = false } = {}) {
    const conversations = await listConversations();
    return conversations
      .filter((conversation) => (archivedOnly ? conversation.is_archived : !conversation.is_archived))
      .filter((conversation) => !starredOnly || conversation.is_starred)
      .map((conversation) => ({
        uuid: conversation.uuid,
        name: conversation.name || "Chat",
        preview: chatPreview(conversation),
        model: conversation.model,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
        isStarred: Boolean(conversation.is_starred),
        isTemporary: Boolean(conversation.is_temporary),
        currentLeafMessageUuid: conversation.current_leaf_message_uuid || "",
      }));
  }

  // RecentCoworkSession items for RecentsService/ListRecents. `status` uses
  // RecentSessionStatus (ARCHIVED | ACTIVE); the worker oneof messages are empty
  // in the recovered schema, so `running`/`idle` are presence markers only.
  async function listCoworkRecents({ starredOnly = false, archivedOnly = false } = {}) {
    const sessions = await listCoworkSessions();
    return sessions
      .filter((session) => (archivedOnly ? session.is_archived : !session.is_archived))
      .filter((session) => !starredOnly || session.is_starred)
      .map((session) => ({
        id: session.uuid,
        title: session.name || "Cowork",
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        isStarred: Boolean(session.is_starred),
        preview: session.preview,
        unread: false,
        revision: session.updated_at,
        status: session.is_archived ? 2 : 1,
        ...(session.is_running ? { running: {} } : { idle: {} }),
      }));
  }

  // BardReadCoworkSessionResponse: the same BardConversationUpdate a Chat read
  // returns (the transcript is the same JSONL) plus Cowork metadata.
  async function readCoworkSession(id) {
    if (!coworkEnabled()) throw notFound();
    const conversation = await getCoworkSession(id);
    return {
      update: bardSnapshot(conversation),
      olderCursor: "",
      meta: {
        // CoworkSessionStatus: ARCHIVED | ACTIVE.
        sessionStatus: conversation.is_archived ? 2 : 1,
        artifacts: [],
        repositoryNames: [],
      },
    };
  }

  function registerBardWatcher(conversationUuid, callback) {
    let watchers = revisionWatchers.get(conversationUuid);
    if (!watchers) {
      watchers = new Set();
      revisionWatchers.set(conversationUuid, watchers);
    }
    watchers.add(callback);
    ensureEvents();
    return () => watchers.delete(callback);
  }

  function notifyBardWatchers(conversation) {
    if (conversation?.deleted) {
      const watchers = revisionWatchers.get(conversation.uuid);
      if (!watchers?.size) return;
      for (const callback of watchers) {
        try {
          callback(null);
        } catch {
          revisionWatchers.get(conversation.uuid)?.delete(callback);
        }
      }
      revisionWatchers.delete(conversation.uuid);
      return;
    }
    const watchers = revisionWatchers.get(conversation.uuid);
    if (!watchers?.size) return;
    const snapshot = bardSnapshot(conversation);
    for (const callback of watchers) {
      try {
        callback(snapshot);
      } catch {
        revisionWatchers.get(conversation.uuid)?.delete(callback);
      }
    }
  }

  // Bard projection for the Connect surfaces.
  function bardSnapshot(conversation) {
    const running = activeTurns.has(conversation.uuid) || Boolean(conversation.is_running);
    const bardConversation = {
      id: conversation.uuid,
      title: conversation.name || "",
      status: running ? 2 : 1, // STATUS_RUNNING : STATUS_IDLE
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      model: { identifier: conversation.model, default: false },
      currentLeafMessageId: conversation.current_leaf_message_uuid || "",
      settings: bardSettings(conversation.settings),
      isStarred: Boolean(conversation.is_starred),
      isTemporary: Boolean(conversation.is_temporary),
      revisionNs: String(conversation.revision || 0),
    };
    const messages = [];
    const displayGroups = [];
    const contentBlocks = [];
    conversation.messages.forEach((message, index) => {
      const complete = !message.live;
      messages.push({
        id: message.uuid,
        conversationId: conversation.uuid,
        role: message.sender === "human" ? 1 : 2,
        index,
        isComplete: complete,
        createdAt: message.created_at,
        parentMessageId: message.parent_uuid || "",
        stopReason: bardStopReasonNumber[message.stop_reason || "end_turn"] || 0,
        turnStartKind: 1,
      });
      if (message.sender === "human") {
        const groupId = `${message.uuid}-group`;
        displayGroups.push({ id: groupId, messageId: message.uuid, index: 0, style: 1, isComplete: true });
        contentBlocks.push({
          id: `${message.uuid}-text`,
          displayGroupId: groupId,
          index: 0,
          isComplete: true,
          state: 2, // CONTENT_BLOCK_STATE_COMPLETE
          text: messageText({ content: message.content }),
        });
        return;
      }
      const segments = bardSegments(message.uuid, message.content, { live: !complete });
      displayGroups.push(...segments.groups);
      contentBlocks.push(...segments.contentBlocks);
    });
    return {
      replaceAllState: true,
      conversation: bardConversation,
      messages,
      displayGroups,
      contentBlocks,
    };
  }

  // Connect before the first turn: Desktop starts streaming the moment a message
  // is dispatched, and events sent before the subscription is up are lost.
  ensureEvents();

  return {
    getIdentity,
    mapConversation,
    mapConversationWithMessages,
    listConversations,
    listCoworkSessions,
    getConversation,
    getCoworkSession,
    conversationKind,
    createConversation,
    updateConversation,
    deleteConversation,
    listModels,
    defaultModel,
    prepareTurn,
    finishAssistantTurn,
    streamAssistantTurn,
    saveConversation,
    registerActiveTurn,
    activeTurnFor,
    activeTurnCount,
    clearActiveTurn,
    abortActiveTurn,
    bardSnapshot,
    registerBardWatcher,
    notifyBardWatchers,
    listRecents,
    listCoworkRecents,
    readCoworkSession,
    connectSendMessage,
    connectSendCoworkMessage,
  };
}
