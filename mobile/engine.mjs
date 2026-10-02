import { randomUUID } from "node:crypto";
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

export function createEngine({ store, desktop, log = console }) {
  let identity = null;
  const activeTurns = new Map(); // conversationUuid -> { abort, assistantUuid }
  const liveTurns = new Map(); // conversationUuid -> { humanUuid, humanText, assistantUuid, text }
  const revisionWatchers = new Map(); // conversationUuid -> Set<callback>
  const cache = new Map(); // conversationUuid -> { base, at }
  const revisions = new Map();
  const listeners = new Map(); // sessionId -> Set<fn(payload)>
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
      name: entry.draft.name || "",
      model: entry.draft.model,
      is_starred: Boolean(entry.is_starred),
      is_archived: false,
      is_temporary: Boolean(entry.draft.is_temporary),
      created_at: entry.draft.created_at,
      updated_at: entry.draft.created_at,
      current_leaf_message_uuid: null,
      settings: { enabled_mcp_tools: {} },
      revision: revisionFor(uuid),
      is_running: false,
      draft: true,
      messages: [],
    };
  }

  function project(uuid, session, entries, entry) {
    const { messages, leaf } = transcriptToMessages(entries, {
      assistantUuidFor: (humanUuid) => entry?.assistantByHuman?.[humanUuid],
    });
    return {
      uuid,
      name: session.title || "",
      model: session.model,
      is_starred: Boolean(entry?.is_starred),
      is_archived: Boolean(session.isArchived),
      is_temporary: Boolean(entry?.is_temporary),
      created_at: isoFrom(session.createdAt),
      updated_at: isoFrom(session.lastActivityAt),
      current_leaf_message_uuid: leaf,
      settings: { enabled_mcp_tools: {} },
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
      content: textContent(live.text, false),
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

  async function loadConversation(uuid, { fresh = false } = {}) {
    if (!uuidPattern.test(String(uuid))) throw notFound();
    const hit = cache.get(uuid);
    if (!fresh && hit && (activeTurns.has(uuid) || Date.now() - hit.at < cacheTtlMs)) {
      return applyLive(uuid, { ...hit.base, revision: revisionFor(uuid) });
    }
    const sessionId = sessionIdFor(uuid);
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
    // Mobile only ever handles Chat sessions; Code and Cowork stay in Claudesk.
    if (session.sessionType !== "chat") throw notFound();
    const base = project(uuid, session, entries, entry);
    cache.set(uuid, { base, at: Date.now() });
    return applyLive(uuid, base);
  }

  const getConversation = (uuid) => loadConversation(uuid);

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

  async function createConversation({ uuid, name, model, isTemporary }) {
    const id = uuidPattern.test(String(uuid)) ? uuid : randomUUID();
    // Never adopt an id that belongs to a Code or Cowork session: starting a Chat
    // session under it would write into that session.
    let existing;
    try {
      existing = await desktop.ipc(SURFACE, "getSession", [sessionIdFor(id)]);
    } catch (error) {
      throw asCompletionError(error);
    }
    if (existing) {
      if (existing.sessionType !== "chat") {
        throw new CompletionError("conversation id is already in use", 409, "invalid_request_error");
      }
      return loadConversation(id);
    }
    const resolved = model || (await defaultModel());
    const entry = await updateMeta(id, (value) => {
      value.draft = {
        name: typeof name === "string" ? name.slice(0, 200) : "",
        model: resolved,
        is_temporary: Boolean(isTemporary),
        created_at: nowIso(),
      };
    });
    return draftConversation(id, entry);
  }

  async function updateConversation(uuid, patch) {
    const conversation = await getConversation(uuid);
    const sessionId = sessionIdFor(uuid);
    try {
      if (typeof patch.name === "string") {
        const name = patch.name.slice(0, 200);
        if (conversation.draft) await updateMeta(uuid, (entry) => { entry.draft.name = name; });
        else await desktop.ipc(SURFACE, "updateSession", [sessionId, { title: name }]);
      }
      if (typeof patch.model === "string" && patch.model) {
        if (conversation.draft) await updateMeta(uuid, (entry) => { entry.draft.model = patch.model; });
        else if (patch.model !== conversation.model) await desktop.ipc(SURFACE, "setModel", [sessionId, patch.model]);
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
    const updated = await loadConversation(uuid, { fresh: true });
    notifyBardWatchers(updated);
    return updated;
  }

  async function deleteConversation(uuid) {
    const conversation = await getConversation(uuid);
    abortActiveTurn(uuid);
    notifyBardWatchers({ uuid, deleted: true });
    if (!conversation.draft) {
      try {
        await desktop.ipc(SURFACE, "delete", [sessionIdFor(uuid)]);
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
          settings: { enabled_mcp_tools: {} },
          revision: revisionFor(uuid),
          messages: [],
        };
      });
    const known = new Set(chats.map((conversation) => conversation.uuid));
    const drafts = Object.entries(state.conversations)
      .filter(([uuid, entry]) => entry.draft && !known.has(uuid))
      .map(([uuid, entry]) => draftConversation(uuid, entry));
    return [...chats, ...drafts].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
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

  async function listModels() {
    const { models } = await chatModels();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      short_name: model.name.length > 16 ? `${model.name.slice(0, 15)}…` : model.name,
      section: "main",
      disabled: false,
      capabilities: {},
    }));
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
        plan: { kind: "retry", humanUuid: human.uuid, text: "", attachments: [] },
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
      plan: { kind, humanUuid, text: prompt, attachments, rewindTo },
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
    const sessionId = sessionIdFor(conversation.uuid);
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

    if (plan.kind === "start") {
      const title = (conversation.name || text).replace(/\s+/g, " ").trim().slice(0, 60);
      await desktop.ipc(SURFACE, "start", [{
        sessionId,
        message,
        messageUuid: plan.humanUuid,
        model: model || conversation.model,
        title,
        sessionType: "chat",
        images,
        userSelectedFiles: [],
        userSelectedFolders: [],
        syntheticMessage: false,
        documentFunnelEnabled: false,
      }]);
      await updateMeta(conversation.uuid, (entry) => {
        delete entry.draft;
        entry.is_temporary = Boolean(conversation.is_temporary);
      });
    } else {
      if (model && model !== conversation.model) await desktop.ipc(SURFACE, "setModel", [sessionId, model]);
      await desktop.ipc(SURFACE, "sendMessage", [
        sessionId,
        message,
        images.length ? images : undefined,
        undefined,
        plan.humanUuid,
      ]);
    }
    cache.delete(conversation.uuid);
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
    const { messages } = transcriptToMessages(entries);
    const assistant = messages.find((message) => message.sender === "assistant" && message.parent_uuid === humanUuid);
    return assistant?.content?.map((part) => part.text).join("") ?? "";
  }

  // Streams one assistant turn as canonical SSE events; REST and Connect
  // callers translate those into their wire formats.
  async function* streamAssistantTurn(conversation, { humanMessage, assistantUuid, model, signal, plan }) {
    const uuid = conversation.uuid;
    const sessionId = sessionIdFor(uuid);
    const humanUuid = humanMessage.uuid;
    const translator = createTurnTranslator({
      sessionId,
      humanUuid,
      assistantUuid,
      model: model || conversation.model,
    });
    const queue = createQueue();
    const live = {
      humanUuid,
      humanText: plan.text || humanMessage.content?.map((part) => part.text).join("") || "",
      assistantUuid,
      text: "",
      startedAt: nowIso(),
    };
    const stopListening = listen(sessionId, (payload) => {
      for (const event of translator.accept(payload)) queue.push(event);
      if (translator.text !== live.text) {
        live.text = translator.text;
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
    conversationId, messageId, assistantMessageId, parentMessageId, text, model, attachments,
  }) {
    let conversation;
    try {
      conversation = await getConversation(conversationId);
    } catch (error) {
      if (error.status !== 404) throw error;
      conversation = await createConversation({ uuid: conversationId, model });
    }
    if (activeTurns.has(conversationId)) return conversation;
    const turn = await prepareTurn({
      conversation,
      body: {
        prompt: String(text || ""),
        turn_message_uuids: { human_message_uuid: messageId, assistant_message_uuid: assistantMessageId },
        parent_message_uuid: parentMessageId || undefined,
        model,
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
      settings: {},
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
      const groupId = `${message.uuid}-group`;
      displayGroups.push({
        id: groupId,
        messageId: message.uuid,
        index: 0,
        style: 1,
        isComplete: complete,
      });
      contentBlocks.push({
        id: `${message.uuid}-text`,
        displayGroupId: groupId,
        index: 0,
        isComplete: complete,
        state: complete ? 2 : 1, // CONTENT_BLOCK_STATE_COMPLETE : _RUNNING
        text: message.content
          .filter((part) => part?.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n"),
      });
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
    getConversation,
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
    connectSendMessage,
  };
}
