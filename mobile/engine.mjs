import { randomUUID } from "node:crypto";
import { startUpstreamCompletion, readUpstreamEvents, listGatewayModels, modelLabel } from "./gateway.mjs";

// Canonical single-user chat engine. Both the REST/SSE surface and the
// Connect/protobuf surface in connect.mjs adapt on top of this model, matching
// the recommended split in docs/mobile-spec: client UUIDs are honored verbatim
// for retries and deduplication, and Anthropic business semantics are not
// reproduced here.

function nowIso() {
  return new Date().toISOString();
}

// Canonical stop reasons for the REST/SSE contract.
function upstreamStopToServerStop(upstreamReason) {
  switch (upstreamReason) {
    case "max_tokens":
    case "tool_use":
    case "refusal":
      return upstreamReason;
    case "model_context_window_exceeded":
      return "model-context";
    case "user_canceled":
      return "user_canceled";
    default:
      return "end_turn";
  }
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

export function createEngine({ store, maxTokens, systemPrompt, log = console }) {
  let identity = null;
  const activeTurns = new Map(); // conversationUuid -> { abort, assistantUuid }
  const revisionWatchers = new Map(); // conversationUuid -> Set<callback>

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

  async function getConversation(uuid) {
    const conversation = await store.readConversation(uuid);
    if (!conversation) {
      throw new CompletionError("conversation not found", 404, "not_found_error");
    }
    return conversation;
  }

  async function saveConversation(conversation) {
    conversation.updated_at = nowIso();
    conversation.revision = (conversation.revision || 0) + 1;
    await store.recordConversation(conversation);
    notifyBardWatchers(conversation);
  }

  async function createConversation({ uuid, name, model, isTemporary }) {
    const resolved = model || (await defaultModel());
    const conversation = {
      uuid: /^[0-9a-f-]{36}$/i.test(String(uuid)) ? uuid : randomUUID(),
      name: typeof name === "string" ? name.slice(0, 200) : "",
      model: resolved,
      is_starred: false,
      is_archived: false,
      is_temporary: Boolean(isTemporary),
      created_at: nowIso(),
      updated_at: nowIso(),
      current_leaf_message_uuid: null,
      settings: { enabled_mcp_tools: {} },
      revision: 0,
      messages: [],
    };
    await store.recordConversation(conversation);
    return conversation;
  }

  async function updateConversation(uuid, patch) {
    const conversation = await getConversation(uuid);
    if (typeof patch.name === "string") conversation.name = patch.name.slice(0, 200);
    if (typeof patch.model === "string" && patch.model) conversation.model = patch.model;
    if (typeof patch.is_starred === "boolean") conversation.is_starred = patch.is_starred;
    if (typeof patch.is_archived === "boolean") conversation.is_archived = patch.is_archived;
    await saveConversation(conversation);
    return conversation;
  }

  async function deleteConversation(uuid) {
    await getConversation(uuid);
    abortActiveTurn(uuid);
    notifyBardWatchers({ uuid, deleted: true });
    await store.deleteConversation(uuid);
  }

  // ---------- models ----------

  async function defaultModel() {
    const models = await listGatewayModels();
    return models.find((id) => /sonnet|claude/i.test(id)) || models[0];
  }

  async function listModels() {
    const ids = await listGatewayModels();
    return ids.map((id) => {
      const label = modelLabel(id) || id.split("/").pop() || id;
      return {
        id,
        name: label,
        short_name: label.length > 16 ? label.slice(0, 15) + "\u2026" : label,
        section: "main",
        disabled: false,
        capabilities: {},
      };
    }).sort((a, b) =>
      (/anthropic\/claude/i.test(a.id) ? 0 : 1)
        - (/anthropic\/claude/i.test(b.id) ? 0 : 1)
      || a.name.localeCompare(b.name));
  }

  // ---------- messages ----------

  async function appendMessage(conversation, { uuid, sender, text, parentUuid, attachments }) {
    const message = {
      uuid: /^[0-9a-f-]{36}$/i.test(String(uuid)) ? uuid : randomUUID(),
      parent_uuid: parentUuid || conversation.current_leaf_message_uuid || null,
      sender,
      index: conversation.messages.length,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: [{ type: "text", text: String(text || ""), citations: [], is_closed: true }],
      attachments: attachments || [],
      files: [],
    };
    conversation.messages.push(message);
    conversation.current_leaf_message_uuid = message.uuid;
    await saveConversation(conversation);
    return message;
  }

  // Streams one assistant turn as canonical SSE events; REST and Connect
  // callers translate those into their wire formats. Persistence of the
  // assistant text is done by finishAssistantTurn at the end.
  async function* streamAssistantTurn(conversation, { humanMessage, assistantUuid, model, signal }) {
    const upstreamMessages = conversation.messages
      .map((message) => ({
        role: message.sender === "human" ? "user" : "assistant",
        content: message.content
          .filter((part) => part?.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n"),
      }))
      .filter((entry) => entry.content.length > 0);

    let upstream;
    try {
      const effectiveModel = model || conversation.model;
      upstream = await startUpstreamCompletion({
        model: effectiveModel,
        messages: upstreamMessages,
        system: await systemPrompt?.build({ modelId: effectiveModel }),
        maxTokens,
        signal,
      });
    } catch (error) {
      const type = error.upstreamType || "api_error";
      const status = error.upstreamStatus === 429 ? 429 : 502;
      throw new CompletionError(
        `inference unavailable: ${error.message}`,
        status,
        type === "rate_limit_error" ? "rate_limit_error" : type,
      );
    }

    let stopReason = "end_turn";
    for await (const event of readUpstreamEvents(upstream.body)) {
      if (event.event === "message_start") {
        yield {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              uuid: assistantUuid,
              parent_uuid: humanMessage?.uuid || null,
              model: event.data?.message?.model || model || conversation.model,
            },
          },
        };
      } else if (event.event === "content_block_start") {
        // Upstream may open thinking blocks; v1 streams text blocks only.
        if (event.data?.content_block?.type !== "text") continue;
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: [], is_closed: false },
          },
        };
      } else if (event.event === "content_block_delta") {
        const delta = event.data?.delta;
        if (delta?.type !== "text_delta" || !delta.text) continue;
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.text },
          },
        };
      } else if (event.event === "content_block_stop") {
        yield {
          event: "content_block_stop",
          data: {
            type: "content_block_stop",
            index: 0,
            stop_timestamp: nowIso(),
          },
        };
      } else if (event.event === "message_delta") {
        stopReason = upstreamStopToServerStop(event.data?.delta?.stop_reason);
        yield {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
          },
        };
      } else if (event.event === "message_stop") {
        yield { event: "message_stop", data: { type: "message_stop" } };
      } else if (event.event === "error") {
        const upstreamType = event.data?.error?.type || "api_error";
        throw new CompletionError(
          `inference stream failed: ${event.data?.error?.message || "upstream error"}`,
          upstreamType === "rate_limit_error" ? 429 : 502,
          upstreamType,
        );
      }
    }
    return stopReason;
  }

  async function finishAssistantTurn(conversation, assistantUuid, text, stopReason) {
    if (!conversation.messages.some((message) => message.uuid === assistantUuid)) {
      await appendMessage(conversation, {
        uuid: assistantUuid,
        sender: "assistant",
        text: "",
      });
    }
    const assistant = conversation.messages.find((message) => message.uuid === assistantUuid);
    assistant.content = [{ type: "text", text: text || "", citations: [], is_closed: true }];
    assistant.stop_reason = stopReason || "end_turn";
    assistant.updated_at = nowIso();
    conversation.current_leaf_message_uuid = assistantUuid;
    await saveConversation(conversation);
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

  // Rewind for retry: regenerate everything after the parent turn.
  function rewindToMessage(conversation, parentMessageUuid) {
    const parentIndex = conversation.messages.findIndex(
      (message) => message.uuid === parentMessageUuid,
    );
    if (parentIndex < 0) return false;
    conversation.messages = conversation.messages.slice(0, parentIndex + 1);
    conversation.current_leaf_message_uuid = parentMessageUuid;
    return true;
  }

  // Validates and normalizes the human/assistant UUID pair, folds extracted
  // attachment text into the prompt, and appends the human turn when needed.
  async function prepareTurn({ conversation, body, retry = false }) {
    const turnUuids = body.turn_message_uuids || {};
    const rawPrompt = typeof body.prompt === "string" ? body.prompt : "";
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    let attachmentText = "";
    for (const attachment of attachments) {
      let extracted = attachment?.extracted_content;
      if (typeof extracted !== "string") {
        // The client only sends name/size here sometimes; recover the server
        // stored extraction from the prepare-upload step.
        const stored = await store.findUpload({
          name: attachment?.file_name,
          size: attachment?.file_size,
        });
        extracted = stored?.meta?.extracted_content;
        if (stored) {
          attachment.extracted_content = extracted;
        }
      }
      if (typeof extracted === "string" && extracted) {
        attachmentText += `\n\n--- Attached file: ${attachment.file_name || "attachment"} ---\n${extracted}`;
      }
    }
    const promptText = rawPrompt + attachmentText;
    const model = typeof body.model === "string" && body.model ? body.model : undefined;

    if (retry) {
      // Retry: the client only supplies the assistant UUID to replace. Strip
      // messages after the assistant's parent, then re-send that branch.
      const assistantUuid = /^[0-9a-f-]{36}$/i.test(String(
        body.turn_message_uuids?.assistant_message_uuid,
      )) ? body.turn_message_uuids.assistant_message_uuid : null;
      if (!assistantUuid) {
        throw new CompletionError("assistant_message_uuid is required", 400, "invalid_request_error");
      }
      const existing = conversation.messages.find((message) => message.uuid === assistantUuid);
      if (existing) {
        conversation.messages = conversation.messages.filter(
          (message) => message.uuid !== assistantUuid && message.parent_uuid !== assistantUuid,
        );
        const parentMessage = existing.parent_uuid
          ? conversation.messages.find((message) => message.uuid === existing.parent_uuid)
          : null;
        conversation.current_leaf_message_uuid = parentMessage?.uuid || null;
      }
      const humanMessage = await appendMessage(conversation, {
        uuid: null,
        sender: "human",
        text: promptText,
        parentUuid: conversation.current_leaf_message_uuid,
      });
      const assistantMessage = await appendMessage(conversation, {
        uuid: assistantUuid,
        sender: "assistant",
        text: "",
        parentUuid: humanMessage.uuid,
      });
      return { humanMessage, assistantMessage, model };
    }

    const humanUuid = /^[0-9a-f-]{36}$/i.test(String(
      turnUuids.human_message_uuid || body.human_message_uuid,
    )) ? (turnUuids.human_message_uuid || body.human_message_uuid) : null;
    const assistantUuidRaw = turnUuids.assistant_message_uuid || body.assistant_message_uuid;
    const assistantUuid = /^[0-9a-f-]{36}$/i.test(String(assistantUuidRaw))
      ? assistantUuidRaw
      : randomUUID();
    const parentMessageUuid = typeof body.parent_message_uuid === "string" && body.parent_message_uuid
      ? body.parent_message_uuid
      : null;

    if (!promptText.trim()) {
      throw new CompletionError("prompt is required", 400, "invalid_request_error");
    }

    // Rewind signals a regenerate/edit request: the resent human turn is
    // appended after the parent, and children of the parent are dropped.
    if (parentMessageUuid) {
      rewindToMessage(conversation, parentMessageUuid);
    }

    const humanIndex = conversation.messages.findIndex(
      (message) => message.uuid === humanUuid,
    );
    let humanMessage;
    if (humanIndex === -1) {
      humanMessage = await appendMessage(conversation, {
        uuid: humanUuid || randomUUID(),
        sender: "human",
        text: promptText,
        parentUuid: conversation.current_leaf_message_uuid,
        attachments: attachments.slice(0, 8),
      });
    } else {
      humanMessage = conversation.messages[humanIndex];
      if (humanMessage.content?.[0]?.text !== promptText) {
        humanMessage.content = [{ type: "text", text: promptText, citations: [], is_closed: true }];
        humanMessage.updated_at = nowIso();
        // Edit: descendants after the edited human turn are regenerated.
        rewindToMessage(conversation, humanUuid);
        humanMessage.index = conversation.messages.indexOf(humanMessage);
      }
      await saveConversation(conversation);
    }
    return { humanMessage, assistantUuid: String(assistantUuid), model };
  }

  // ---------- Connect surface ----------

  // Persist the human turn and kick off the upstream call in the background.
  // Clients observe progress via ReadConversation/StreamTimeline.
  async function connectSendMessage({ conversationId, messageId, assistantMessageId, text, model }) {
    let conversation;
    try {
      conversation = await getConversation(conversationId);
    } catch {
      return null;
    }
    if (activeTurns.has(conversationId)) return conversation;
    const humanMessage = await appendMessage(conversation, {
      uuid: messageId,
      sender: "human",
      text: String(text || ""),
      parentUuid: conversation.current_leaf_message_uuid,
    });
    const assistantId = /^[0-9a-f-]{36}$/i.test(String(assistantMessageId))
      ? assistantMessageId
      : randomUUID();
    const upstreamMessages = conversation.messages
      .map((message) => ({
        role: message.sender === "human" ? "user" : "assistant",
        content: message.content
          .filter((part) => part?.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n"),
      }))
      .filter((entry) => entry.content.length > 0);
    const abort = new AbortController();
    registerActiveTurn(conversationId, { abort, assistantUuid: assistantId });
    notifyBardWatchers(conversation);
    (async () => {
      try {
        const effectiveModel = model || conversation.model;
        const upstream = await startUpstreamCompletion({
          model: effectiveModel,
          messages: upstreamMessages,
          system: await systemPrompt?.build({ modelId: effectiveModel }),
          maxTokens,
          signal: abort.signal,
        });
        let text = "";
        for await (const event of readUpstreamEvents(upstream.body)) {
          if (event.event !== "content_block_delta") continue;
          const delta = event.data?.delta;
          if (delta?.type === "text_delta" && delta.text) text += delta.text;
        }
        await finishAssistantTurn(conversation, assistantId, text, "end_turn");
      } catch (error) {
        console.error(`[mobile-engine] background turn failed: ${error.message}`);
        try {
          await finishAssistantTurn(conversation, assistantId, "", "error");
        } catch {
          // Conversation may have been deleted concurrently.
        }
      } finally {
        clearActiveTurn(conversationId);
        notifyBardWatchers(conversation);
      }
    })();
    return conversation;
  }

  // ---------- Recents / Bard projections ----------

  function chatPreview(conversation) {
    const last = conversation.messages.at(-1);
    const text = last?.content?.find?.((part) => part?.type === "text")?.text || "";
    return text.slice(0, 120);
  }

  function listRecents({ starredOnly = false, archivedOnly = false } = {}) {
    return listConversationsInRange(starredOnly, archivedOnly).then((conversations) =>
      conversations.map((conversation) => ({
        uuid: conversation.uuid,
        name: conversation.name || "Chat",
        preview: chatPreview(conversation),
        model: conversation.model,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
        isStarred: Boolean(conversation.is_starred),
        isTemporary: Boolean(conversation.is_temporary),
        currentLeafMessageUuid: conversation.current_leaf_message_uuid || "",
      })));
  }

  async function listConversationsInRange(starredOnly, archivedOnly) {
    const conversations = await store.listConversations();
    return conversations
      .filter((conversation) => archivedOnly
        ? Boolean(conversation.is_archived)
        : !conversation.is_archived)
      .filter((conversation) => (!starredOnly || Boolean(conversation.is_starred)));
  }

  function registerBardWatcher(conversationUuid, callback) {
    let watchers = revisionWatchers.get(conversationUuid);
    if (!watchers) {
      watchers = new Set();
      revisionWatchers.set(conversationUuid, watchers);
    }
    watchers.add(callback);
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
    const running = activeTurns.has(conversation.uuid);
    const modelId = { identifier: conversation.model, default: false };
    const bardConversation = {
      id: conversation.uuid,
      title: conversation.name || "",
      status: running ? 2 : 1, // STATUS_RUNNING : STATUS_IDLE
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      model: modelId,
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
      const role = message.sender === "human" ? 1 : 2;
      messages.push({
        id: message.uuid,
        conversationId: conversation.uuid,
        role,
        index,
        isComplete: true,
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
        isComplete: true,
      });
      const text = message.content
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n");
      contentBlocks.push({
        id: `${message.uuid}-text`,
        displayGroupId: groupId,
        index: 0,
        isComplete: true,
        state: 2,
        text,
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

  return {
    getIdentity,
    mapConversation,
    mapConversationWithMessages,
    listConversations: () => store.listConversations(),
    getConversation,
    createConversation,
    updateConversation,
    deleteConversation,
    listModels,
    defaultModel,
    prepareTurn,
    appendMessage,
    saveConversation,
    finishAssistantTurn,
    streamAssistantTurn,
    registerActiveTurn,
    activeTurnFor,
    activeTurnCount,
    clearActiveTurn,
    abortActiveTurn,
    rewindToMessage,
    bardSnapshot,
    registerBardWatcher,
    notifyBardWatchers,
    listRecents,
    connectSendMessage,
  };
}
