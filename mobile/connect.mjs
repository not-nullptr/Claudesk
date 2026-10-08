// Connect RPC adapter: builds proto3-JSON-style (camelCase) response objects
// for the Conversation (Bard) and Recents surfaces, driven by the recovered
// schema field tables in docs/mobile-spec. Streaming methods
// (StreamTimeline/StreamRecents) are long-lived and handled directly by
// server.mjs; everything here is unary.

export const BARD_SERVICE = "anthropic.bard.api.v1alpha.ConversationService";
export const RECENTS_SERVICE = "anthropic.claudeai_chats.api.v1alpha.RecentsService";

// Request/response message names for generic proto encoding (§8.1 media
// types). Names match the recovered schema tables exactly.
export const connectRequestMessages = {
  [`${BARD_SERVICE}/GetNewConversationDefaults`]: "BardGetNewConversationDefaultsRequest",
  [`${BARD_SERVICE}/ReadConversation`]: "BardReadConversationRequest",
  [`${BARD_SERVICE}/ReadConversationHistory`]: "BardReadConversationHistoryRequest",
  [`${BARD_SERVICE}/ReadCoworkSession`]: "BardReadCoworkSessionRequest",
  [`${BARD_SERVICE}/PerformAction`]: "BardPerformActionRequest",
  [`${BARD_SERVICE}/ReportViewing`]: "BardReportViewingRequest",
  [`${RECENTS_SERVICE}/ListRecents`]: "Anthropic_ClaudeaiChats_Api_V1alpha_ListRecentsRequest",
  [`${RECENTS_SERVICE}/ListRecentGroups`]: "Anthropic_ClaudeaiChats_Api_V1alpha_ListRecentGroupsRequest",
  [`${RECENTS_SERVICE}/StreamRecents`]: "Anthropic_ClaudeaiChats_Api_V1alpha_StreamRecentsRequest",
};

export const connectResponseMessages = {
  [`${BARD_SERVICE}/GetNewConversationDefaults`]: "BardGetNewConversationDefaultsResponse",
  [`${BARD_SERVICE}/ReadConversation`]: "BardReadConversationResponse",
  [`${BARD_SERVICE}/ReadConversationHistory`]: "BardReadConversationHistoryResponse",
  [`${BARD_SERVICE}/ReadCoworkSession`]: "BardReadCoworkSessionResponse",
  [`${BARD_SERVICE}/PerformAction`]: "BardPerformActionResponse",
  [`${BARD_SERVICE}/ReportViewing`]: "BardReportViewingResponse",
  [`${BARD_SERVICE}/StreamTimeline`]: "BardStreamTimelineResponse",
  [`${RECENTS_SERVICE}/ListRecents`]: "Anthropic_ClaudeaiChats_Api_V1alpha_ListRecentsResponse",
  [`${RECENTS_SERVICE}/ListRecentGroups`]: "Anthropic_ClaudeaiChats_Api_V1alpha_ListRecentGroupsResponse",
  [`${RECENTS_SERVICE}/StreamRecents`]: "Anthropic_ClaudeaiChats_Api_V1alpha_StreamRecentsResponse",
};

// Streaming methods implemented directly by server.mjs.
export const connectStreamingMethods = new Set([
  `${BARD_SERVICE}/StreamTimeline`,
  `${RECENTS_SERVICE}/StreamRecents`,
]);

// Normalizes /claudeai-rpc/-prefixed or bare service paths to METHOD strings.
export function normalizeConnectMethod(pathname) {
  let path = pathname;
  if (path.startsWith("/claudeai-rpc/")) path = path.slice("/claudeai-rpc".length);
  for (const key of [
    ...Object.keys(connectRequestMessages),
    ...Object.keys(connectResponseMessages),
  ]) {
    if (path === `/${key}`) return key;
  }
  return path.replace(/^\//, "");
}

// §8.3: "For basic chat, implement send/rename/star/model plus harmless
// acknowledgements for refresh/stop/warm-turn."
const UNAVAILABLE_ACTIONS = [
  "CONVERSATION_USER_ACTION_SET_RESEARCH_MODE",
  "CONVERSATION_USER_ACTION_RESEARCH_COMMAND",
  "CONVERSATION_USER_ACTION_START_VOICE_CONVERSATION",
  "CONVERSATION_USER_ACTION_OPEN_FILE_BY_SANDBOX_PATH",
];

const DEFAULT_SETTINGS = {
  enabledWebSearch: false,
  enabledComputerTools: false,
  enabledMcpTools: {},
  enabledArtifacts: true,
};

// RecentSurface CHAT=1 / COWORK=2, SurfaceState OK=1. Advertising both tells the
// app the two surfaces are being served, so neither tab is treated as absent.
const SURFACE_STATUS = [
  { surface: 1, state: 1 },
  { surface: 2, state: 1 },
];

// One RecentItem list mixing chats (`chat`) and Cowork sessions
// (`coworkSession`), newest first — the app splits them by the oneof it finds.
async function recentItems(engine, { starredOnly = false, archivedOnly = false } = {}) {
  const [chats, coworkers] = await Promise.all([
    engine.listRecents({ starredOnly, archivedOnly }),
    engine.listCoworkRecents({ starredOnly, archivedOnly }),
  ]);
  return [
    ...coworkers.map((item) => ({ coworkSession: item })),
    ...chats.map((item) => ({ chat: item })),
  ].sort((a, b) => {
    const at = a.chat ? a.chat.updatedAt : a.coworkSession.updatedAt;
    const bt = b.chat ? b.chat.updatedAt : b.coworkSession.updatedAt;
    return String(bt).localeCompare(String(at));
  });
}

function newConversationDefaults() {
  return {
    workMode: 1, // BardWorkMode.WORK_MODE_CHAT
    unavailableActions: UNAVAILABLE_ACTIONS,
    computerToolsEligible: false,
    nativeAutoModeAvailable: false,
    settings: DEFAULT_SETTINGS,
    maxUploadBytes: "20971520",
    orgUploadMaxBytes: "20971520",
    inlineAttachmentMaxAcceptedBytes: "10485760",
    inlineAttachmentsTotalMaxAcceptedBytes: "52428800",
  };
}

// Reasoning picks travel as BardConversationSettings tokens, either on a send
// (settings_update) or on their own (update_conversation_settings).
function reasoningPick(update) {
  const settings = update?.settings ?? update ?? {};
  const effort = settings.effortLevelToken ?? settings.effort_level_token;
  const mode = settings.thinkingModeToken ?? settings.thinking_mode_token;
  return {
    effort: typeof effort === "string" && effort ? effort : undefined,
    thinkingMode: typeof mode === "string" && mode ? mode : undefined,
  };
}

// A send is a Cowork send when it carries any of the Cowork-only fields the
// schema names (`continueCoworkSessionId`, `targetDeviceId`, `attachedFolders`,
// `creationBind`, a proxy `workModeOverride`, or a seeded continuation). Chat
// sends carry none of them, so the discriminator is exact.
function coworkSendOf(sendMessage, request, conversationId) {
  const continueId = sendMessage.continueCoworkSessionId ?? sendMessage.continue_cowork_session_id;
  const targetDeviceId = sendMessage.targetDeviceId ?? sendMessage.target_device_id;
  const attachedFolders = sendMessage.attachedFolders ?? sendMessage.attached_folders ?? [];
  const creationBind = sendMessage.creationBind ?? sendMessage.creation_bind;
  const noTargetDevice = sendMessage.noTargetDevice ?? sendMessage.no_target_device;
  const workMode = sendMessage.workModeOverride ?? sendMessage.work_mode_override ?? 0;
  const seed = request?.seedCoworkContinuation ?? request?.seed_cowork_continuation;
  const isCowork = Boolean(continueId || targetDeviceId || creationBind || noTargetDevice
    || (Array.isArray(attachedFolders) && attachedFolders.length)
    || Number(workMode) >= 2 || seed);
  if (!isCowork) return null;
  return {
    conversationId,
    continueCoworkSessionId: continueId,
    messageId: sendMessage.messageId ?? sendMessage.message_id,
    assistantMessageId: sendMessage.assistantMessageId ?? sendMessage.assistant_message_id,
    parentMessageId: sendMessage.parentMessageId ?? sendMessage.parent_message_id,
    text: sendMessage.text ?? "",
    model: sendMessage.model?.identifier,
    attachments: sendMessage.attachments ?? [],
    deviceId: targetDeviceId,
    attachedFolders,
    ...reasoningPick(sendMessage.settingsUpdate ?? sendMessage.settings_update),
  };
}

function mutationAck(request, applied) {
  const mutation = request?.header?.mutationId || request?.header?.mutation_id || {};
  return {
    ack: {
      highWaterMark: {
        sessionId: mutation.sessionId || mutation.session_id || "",
        version: Number(mutation.version ?? mutation.version ?? 0),
      },
      applied,
    },
  };
}

const connectMethods = {
  [`${BARD_SERVICE}/GetNewConversationDefaults`]: async () => ({
    regular: newConversationDefaults(),
    temporary: newConversationDefaults(),
  }),

  [`${BARD_SERVICE}/ReadConversation`]: async (ctx) => {
    const request = ctx.methodRequest;
    const conversationId = request.conversationId ?? request.conversation_id;
    const conversation = await ctx.engine.getConversation(conversationId);
    // Revision is an int64 ns counter on the wire; compare as strings to stay
    // below Number precision limits.
    const known = BigInt(request.knownRevisionNs ?? request.known_revision_ns ?? 0);
    const current = BigInt(conversation.revision || 0);
    if (known && known >= current) return { outcome: 2 }; // OUTCOME_NOT_MODIFIED
    return { outcome: 1, update: ctx.engine.bardSnapshot(conversation) };
  },

  [`${BARD_SERVICE}/ReadConversationHistory`]: async (ctx) => {
    const request = ctx.methodRequest;
    const conversationId = request.conversationId ?? request.conversation_id;
    const conversation = await ctx.engine.getConversation(conversationId);
    return {
      update: ctx.engine.bardSnapshot(conversation),
      olderCursor: "",
      outcome: 1,
    };
  },

  // The Cowork read leg. The transport method name is inferred: the request and
  // response messages are recovered in the schema but no service/method is, and
  // ConversationService is where every other Bard* request lives.
  [`${BARD_SERVICE}/ReadCoworkSession`]: async (ctx) => {
    const request = ctx.methodRequest;
    const sessionId = request.sessionId ?? request.session_id;
    return ctx.engine.readCoworkSession(sessionId);
  },

  [`${BARD_SERVICE}/ReportViewing`]: async () => ({}),

  [`${BARD_SERVICE}/PerformAction`]: async (ctx) => {
    const request = ctx.methodRequest;
    const header = request.header || {};
    const conversationId = header.conversationId ?? header.conversation_id;
    const engine = ctx.engine;
    try {
      const sendMessage = request.sendMessage ?? request.send_message;
      if (sendMessage) {
        const cowork = coworkSendOf(sendMessage, request, conversationId);
        if (cowork) {
          await engine.connectSendCoworkMessage(cowork);
        } else {
          await engine.connectSendMessage({
            conversationId,
            messageId: sendMessage.messageId ?? sendMessage.message_id,
            assistantMessageId: sendMessage.assistantMessageId ?? sendMessage.assistant_message_id,
            parentMessageId: sendMessage.parentMessageId ?? sendMessage.parent_message_id,
            text: sendMessage.text ?? "",
            model: sendMessage.model?.identifier,
            attachments: sendMessage.attachments ?? [],
            ...reasoningPick(sendMessage.settingsUpdate ?? sendMessage.settings_update),
          });
        }
        return mutationAck(request, true);
      }
      const stopGeneration = request.stopGeneration ?? request.stop_generation;
      if (stopGeneration) {
        engine.abortActiveTurn(conversationId);
        return mutationAck(request, true);
      }
      const renameConversation = request.renameConversation ?? request.rename_conversation;
      if (renameConversation) {
        await engine.updateConversation(conversationId, {
          name: renameConversation.title || "",
        }, await engine.conversationKind(conversationId));
        return mutationAck(request, true);
      }
      const starConversation = request.starConversation ?? request.star_conversation;
      if (starConversation) {
        const starred = starConversation.starred !== false;
        await engine.updateConversation(conversationId, { is_starred: starred },
          await engine.conversationKind(conversationId));
        return mutationAck(request, true);
      }
      const setConversationModel = request.setConversationModel
        ?? request.set_conversation_model;
      if (setConversationModel) {
        await engine.updateConversation(conversationId, {
          model: setConversationModel.model?.identifier || "",
        }, await engine.conversationKind(conversationId));
        return mutationAck(request, true);
      }
      const updateSettings = request.updateConversationSettings ?? request.update_conversation_settings;
      if (updateSettings) {
        const { effort, thinkingMode } = reasoningPick(updateSettings);
        if (effort || thinkingMode) {
          await engine.updateConversation(conversationId, { effort, thinking_mode: thinkingMode },
            await engine.conversationKind(conversationId));
        }
        return mutationAck(request, true);
      }
      const setCurrentLeaf = request.setCurrentLeaf ?? request.set_current_leaf;
      if (setCurrentLeaf) {
        const kind = await engine.conversationKind(conversationId);
        const conversation = kind === "cowork"
          ? await engine.getCoworkSession(conversationId)
          : await engine.getConversation(conversationId);
        const leaf = setCurrentLeaf.messageId ?? setCurrentLeaf.message_id;
        if (leaf && conversation.messages.some((message) => message.uuid === leaf)) {
          conversation.current_leaf_message_uuid = leaf;
          await engine.saveConversation(conversation);
        }
        return mutationAck(request, true);
      }
      // warmTurn / refreshConversation and the remaining oneof variants are
      // harmless acknowledgements in v1.
      return mutationAck(request, true);
    } catch (error) {
      console.error(`[mobile-connect] perform action failed: ${error.message}`);
      return mutationAck(request, false);
    }
  },

  [`${RECENTS_SERVICE}/ListRecents`]: async (ctx) => {
    const request = ctx.methodRequest;
    const query = request.first ?? request.query ?? {};
    const starredOnly = Boolean(query.starredOnly ?? query.starred_only);
    const archivedOnly = Boolean(query.archivedOnly ?? query.archived_only);
    return {
      data: await recentItems(ctx.engine, { starredOnly, archivedOnly }),
      cursor: "",
      surfaces: SURFACE_STATUS,
      pageOffset: 0,
    };
  },

  [`${RECENTS_SERVICE}/ListRecentGroups`]: async (ctx) => {
    const request = ctx.methodRequest;
    const query = request.first ?? request.query ?? {};
    const wanted = Number(query.groupId ?? query.group_id ?? 0);
    const groups = [];
    if (!wanted || wanted === 1) {
      groups.push({
        id: 1, // RECENT_GROUP_ID_PINNED
        title: "Pinned",
        data: await recentItems(ctx.engine, { starredOnly: true }),
        cursor: "",
      });
    }
    if (!wanted || wanted === 2) {
      groups.push({
        id: 2, // RECENT_GROUP_ID_RECENTS
        title: "Recents",
        data: await recentItems(ctx.engine, {}),
        cursor: "",
      });
    }
    return { groups, surfaces: SURFACE_STATUS };
  },
};

export {
  connectMethods,
  recentItems,
};
