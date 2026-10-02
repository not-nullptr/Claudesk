import http from "node:http";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  connectMethods,
  connectRequestMessages,
  connectResponseMessages,
  connectStreamingMethods,
  normalizeConnectMethod,
  BARD_SERVICE,
  RECENTS_SERVICE,
} from "./connect.mjs";
import { createAuthService, AuthError } from "./auth.mjs";
import { createEngine, CompletionError } from "./engine.mjs";
import { createMobileStore } from "./store.mjs";
import { createDesktopClient } from "./desktop-client.mjs";
import { createCapture, describeBody } from "./capture.mjs";
import { loadSchema, encodeProto, decodeProto } from "./proto.mjs";

const host = process.env.CLAUDE_MOBILE_HOST || "0.0.0.0";
const port = Number(process.env.CLAUDE_MOBILE_PORT || 8081);
const dataDir = process.env.CLAUDE_MOBILE_DATA_DIR || "/config/mobile-api";
const schemaPath = process.env.CLAUDE_MOBILE_PROTO_SCHEMA
  || "/app/schema/Claude-Mobile-Proto-Schema-1.260925.19.json";

const store = createMobileStore({ dataDir });
const auth = createAuthService({ store });
const desktop = createDesktopClient();
const capture = createCapture({ dataDir });
await store.ensureDirs();
const archivedLegacy = await store.archiveLegacyConversations();
if (archivedLegacy) {
  console.log(`[mobile-api] moved ${archivedLegacy} pre-Claudesk conversation file(s) to legacy-conversations/`);
}
const engine = createEngine({ store, desktop });
const identity = await engine.getIdentity();

let schema = null;
try {
  schema = await loadSchema(schemaPath);
} catch (error) {
  console.error(`[mobile-api] proto schema unavailable (${error.message}); JSON connect only`);
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

const MIME_TO_PROTO = new Map([
  ["application/proto", true],
  ["application/connect+proto", true],
  ["application/json", false],
  ["application/connect+json", false],
]);

function readJson(request, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value, extraHeaders = {}) {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function sendErrorEnvelope(response, status, type, message, extraHeaders = {}) {
  sendJson(response, status, {
    type: "error",
    error: { type, message },
  }, extraHeaders);
}

function sendSseRecord(response, event, data) {
  if (response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function orgUuidFromPath(pathname) {
  const match = pathname.match(/^\/api\/organizations\/([0-9a-f-]{36})(\/|$)/i);
  return match ? match[1].toLowerCase() : null;
}

async function selectedModel() {
  const saved = await store.readJsonFile("model-selection.json", null);
  return typeof saved?.model === "string" ? saved.model : "";
}

function accountObject() {
  return {
    uuid: identity.accountUuid,
    email_address: identity.email,
    full_name: "Local user",
    display_name: "Local user",
    created_at: identity.createdAt,
    updated_at: identity.createdAt,
    is_verified: true,
    is_anonymous: false,
    settings: accountSettings(),
    memberships: [{
      role: "owner",
      created_at: identity.createdAt,
      updated_at: identity.createdAt,
      organization: organizationObject(),
    }],
  };
}

function accountSettings() {
  return {
    has_finished_claudeai_onboarding: true,
    preview_feature_uses_artifacts: false,
    enabled_web_search: false,
    enabled_mcp_tools: {},
    enabled_connector_suggestions: false,
    enabled_monkeys_in_a_barrel: false,
    enabled_model_auto_fallback: false,
    grove_enabled: false,
    village_weaver_eligible: false,
    dismissed_claudeai_banners: [],
  };
}

// Upgraded plan + code/cowork capabilities so the mobile client unlocks the
// Claude Code surface.
function organizationObject() {
  return {
    uuid: identity.orgUuid,
    name: "Self-hosted",
    capabilities: ["chat", "claude_code"],
    analytics_subscription_plan: "max",
    plan_display_name: "Max",
    settings: {},
  };
}

function isSecureRequest(request) {
  return request.headers["x-forwarded-proto"] === "https"
    || (request.socket?.encrypted ?? false);
}

function parseCookie(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string" || !header.length) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function parseMultipart(buffer, contentTypeHeader) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentTypeHeader || "");
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const bodyStart = start + boundary.length;
    const next = buffer.indexOf(boundary, bodyStart);
    if (next === -1) break;
    // Each segment between boundaries is prefixed with CRLF and suffixed with CRLF.
    const segment = buffer.subarray(bodyStart + 2, next - 2);
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headers = segment.subarray(0, headerEnd).toString("utf8");
    const body = segment.subarray(headerEnd + 4);
    parts.push({ headers, body });
    start = next;
  }
  return parts;
}

// Decodes a Connect unary request body.
function decodeConnectRequest(request, rawBody) {
  const contentType = request.headers["content-type"] || "application/json";
  const isProto = MIME_TO_PROTO.get(contentType.split(";")[0].trim()) ?? false;
  const encoding = (request.headers["connect-content-encoding"] || "").toLowerCase();
  let payload = rawBody;
  if (encoding === "gzip") payload = gunzipSync(payload);
  else if (encoding && encoding !== "identity") {
    throw Object.assign(new Error(`unsupported connect content encoding ${encoding}`), { status: 415 });
  }
  if (!contentType.startsWith("application/connect+")) {
    // Plain application/json or application/proto unary body: no envelope.
    if (!isProto) return JSON.parse(payload.toString("utf8") || "{}");
    const methodName = normalizeConnectMethod(
      new URL(request.url || "/", "http://localhost").pathname,
    );
    return decodeProto(schema, connectRequestMessages[methodName] || "", payload);
  }
  // Connect envelope: 1 flag byte + 4 byte length + payload.
  if (payload.length < 5) return {};
  const flags = payload[0];
  const length = payload.readUInt32BE(1);
  const framed = payload.subarray(5, 5 + length);
  if (!isProto) return JSON.parse(framed.toString("utf8") || "{}");
  const methodName = normalizeConnectMethod(
    new URL(request.url || "/", "http://localhost").pathname,
  );
  return decodeProto(schema, connectRequestMessages[methodName] || "", framed);
}

function encodeConnectResponse(request, method, value) {
  const contentType = request.headers["content-type"] || "application/json";
  const isProto = MIME_TO_PROTO.get(contentType.split(";")[0].trim()) ?? false;
  if (isProto) {
    const responseName = connectResponseMessages[method];
    if (!responseName) throw new Error(`no proto response schema for ${method}`);
    return encodeProto(schema, responseName, value);
  }
  return Buffer.from(JSON.stringify(value), "utf8");
}

function isStreamingConnectMethod(method) {
  return method === `${BARD_SERVICE}/StreamTimeline`
    || method === `${RECENTS_SERVICE}/StreamRecents`;
}

async function handleAuth(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/legal") {
    sendJson(response, 200, {});
    return true;
  }
  if (url.pathname === "/api/bootstrap" || url.pathname === "/api/bootstrap/device") {
    sendJson(response, 200, { growthbook: { features: {}, experiments: [] } });
    return true;
  }
  if (url.pathname === "/api/supported_regions") {
    sendJson(response, 200, {
      regions: {
        GB: { claudeai_supported: true, phone_verification_supported: false },
        US: { claudeai_supported: true, phone_verification_supported: false },
      },
      phone_verification_allowed_regions: [],
    });
    return true;
  }
  if (url.pathname === "/api/auth/send_magic_link" && request.method === "POST") {
    const body = await readJson(request);
    try {
      const value = await auth.sendMagicLink(request);
      sendJson(response, 200, value);
    } catch (error) {
      if (error instanceof AuthError) {
        sendErrorEnvelope(response, error.status, error.type, error.message,
          error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
      } else throw error;
    }
    return true;
  }
  if (url.pathname === "/api/auth/send_code" && request.method === "POST") {
    const body = await readJson(request);
    try {
      await auth.sendMagicLink(request);
      sendJson(response, 200, { sent: true, length: 6 });
    } catch (error) {
      if (error instanceof AuthError) {
        sendErrorEnvelope(response, error.status, error.type, error.message);
      } else throw error;
    }
    return true;
  }
  if (url.pathname === "/api/auth/verify_magic_link" && request.method === "POST") {
    const body = await readJson(request);
    const email = body.credentials?.email_address || body.credentials?.emailAddress
      || body.email_address || "";
    try {
      const { token } = await auth.verifyMagicLink(request, email, body);
      const forwardedProto = request.headers["x-forwarded-proto"];
      sendJson(response, 200, { created: false }, {
        "Set-Cookie": auth.sessionCookie(token, forwardedProto === "https"),
      });
    } catch (error) {
      if (error instanceof AuthError) {
        sendErrorEnvelope(response, error.status, error.type, error.message,
          error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
      } else throw error;
    }
    return true;
  }
  return false;
}

async function handleAccountRoutes(request, response, url) {
  const path = url.pathname;
  if (path === "/api/account" || path === "/api/account_profile") {
    sendJson(response, 200, accountObject());
    return true;
  }
  if (path === "/api/organizations") {
    sendJson(response, 200, [organizationObject()]);
    return true;
  }
  if (path === "/api/account/settings") {
    if (request.method === "GET") {
      sendJson(response, 200, accountSettings());
    } else {
      await readJson(request);
      sendJson(response, 200, {});
    }
    return true;
  }
  if (path === "/api/account/standing") {
    sendJson(response, 200, { banned_at: null, hide_steps_card: true });
    return true;
  }
  if (path === "/api/account/current_appeal") {
    sendJson(response, 200, null);
    return true;
  }
  if (path === "/api/accounts/me/consents/check") {
    sendJson(response, 200, { has_consent: false });
    return true;
  }
  if (path === "/api/accounts/me/consents") {
    sendJson(response, 200, []);
    return true;
  }
  if (path === "/api/accounts/me/consents/revoke") {
    sendJson(response, 200, {});
    return true;
  }
  if (path === "/api/auth/trusted_devices") {
    sendJson(response, 200, []);
    return true;
  }
  if (path === "/api/auth/session_reattest/device_key/challenge") {
    sendJson(response, 200, { challenge: "self-hosted-challenge" });
    return true;
  }
  if (path === "/api/auth/session_reattest/device_key") {
    sendJson(response, 200, {});
    return true;
  }
  if (path === "/api/event_logging/v2/batch"
    || path === "/api/experiences/track"
    || path === "/api/experiences/action"
    || path === "/api/account/accept_legal_docs"
    || path === "/api/account/grove_notice_viewed"
    || path === "/api/notification/push/track_open"
    || path === "/api/notification/live-activity/start-token"
    || path === "/api/notification/live-activity/token"
    || path === "/api/notification/live-activity/user-dismiss"
    || path === "/api/reflections/time_spent") {
    await readJson(request).catch(() => ({}));
    sendJson(response, 200, {});
    return true;
  }
  return false;
}

async function handleBootstrapRoute(request, response, url) {
  const match = url.pathname.match(/^\/api\/bootstrap\/([0-9a-f-]{36})\/app_start$/i);
  if (!match || request.method !== "GET") return false;
  const models = await engine.listModels();
  const chosen = await selectedModel();
  const defaultModel = models.some((model) => model.id === chosen) ? chosen : models[0]?.id;
  sendJson(response, 200, {
    account: accountObject(),
    org_growthbook: { features: {}, experiments: [] },
    current_user_access: {
      features: [],
      account_features: [],
      organization_permissions: [],
    },
    model_selector_state: [{ id: "chat", model: defaultModel }],
    model_selector_config: [
      { id: "chat", models },
    ],
  });
  return true;
}

async function handleOptionalEmptyRoutes(request, response, url) {
  const org = orgUuidFromPath(url.pathname);
  if (!org) return false;
  const rest = url.pathname.replace(/^\/api\/organizations\/[0-9a-f-]{36}\/?/i, "");
  const isEmptyList = [
    "projects",
    "published_artifacts",
    "artifacts",
    "composer_notices",
    "members/display_info",
    "cowork/sessions",
    "cowork/remote_devices",
    "skills/list-skills",
    "mcp/remote_servers",
    "notification/channels",
  ].includes(rest);
  if (isEmptyList && request.method === "GET") {
    sendJson(response, 200, []);
    return true;
  }
  const isNoOpObject = [
    "memory/settings",
    "reflections/settings",
    "sync/auth/status",
    "notification/preferences",
    "cowork_settings",
    "permission_mode_policy",
  ].includes(rest);
  if (isNoOpObject && request.method === "GET") {
    const defaults = {
      "memory/settings": {
        is_memory_enabled: false,
        is_melange_memory_enabled: false,
        is_memory_search_enabled: false,
      },
      "reflections/settings": { verdict: null },
      "sync/auth/status": { connected: false },
      "notification/preferences": { preferences: {}, effective_push: {} },
      "cowork_settings": { skip_approvals_enabled: false, auto_mode_enabled: false },
      "permission_mode_policy": {
        auto_permissions: { allowed: false, managed: false },
        bypass_permissions: { allowed: false, managed: false },
      },
    };
    sendJson(response, 200, defaults[rest]);
    return true;
  }
  if (rest === "mcp/v2/bootstrap" && request.method === "POST") {
    response.writeHead(200, SSE_HEADERS);
    sendSseRecord(response, "server_list", { servers: [] });
    sendSseRecord(response, "first_pass_complete", {});
    sendSseRecord(response, "completed", {});
    response.end();
    return true;
  }
  if (rest === "experiences/track" || rest === "experiences/action"
    || rest === "reflections/time_spent") {
    await readJson(request).catch(() => ({}));
    sendJson(response, 200, {});
    return true;
  }
  return false;
}

async function handleConversationRoutes(request, response, url) {
  const org = orgUuidFromPath(url.pathname);
  if (!org) return false;
  const rest = url.pathname.replace(/^\/api\/organizations\/[0-9a-f-]{36}\/?/i, "");

  let match;
  if (rest === "files/prepare-upload" && request.method === "POST") {
    const body = await readJson(request);
    const uploads = (Array.isArray(body.files) ? body.files : []).map((file) => {
      const fileUuid = randomUUID();
      return {
        file_uuid: fileUuid,
        filesystem_id: "self-hosted",
        path: `/${fileUuid}/${file.name || "attachment"}`,
      };
    });
    sendJson(response, 200, { uploads });
    return true;
  }
  if (rest === "files" && request.method === "POST") {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        sendErrorEnvelope(response, 413, "invalid_request", "attachment too large");
        return true;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const parts = parseMultipart(raw, request.headers["content-type"]);
    if (!parts) {
      sendErrorEnvelope(response, 400, "invalid_request", "expected multipart body");
      return true;
    }
    const pathPart = parts.find((part) => /name="path"/.test(part.headers));
    const filePart = parts.find((part) => /filename=/.test(part.headers));
    if (!pathPart || !filePart) {
      sendErrorEnvelope(response, 400, "invalid_request", "missing path or file part");
      return true;
    }
    const uploadPath = pathPart.body.toString("utf8").trim();
    const fileUuid = uploadPath.split("/").find((part) => /^[0-9a-f-]{36}$/i.test(part))
      || randomUUID();
    const fileName = /filename="?([^";]+)"?/.exec(filePart.headers)?.[1] || "attachment";
    const bytes = filePart.body;
    const extracted = await extractAttachmentText(bytes, fileName);
    const fileObject = {
      uuid: fileUuid,
      id: fileUuid,
      file_uuid: fileUuid,
      file_name: fileName,
      file_size: bytes.length,
      file_type: detectedType(bytes, fileName),
      extracted_content: extracted,
      created_at: new Date().toISOString(),
      url: `/files/${fileUuid}`,
      download_url: `/files/${fileUuid}`,
    };
    await store.saveUploadedFile(fileUuid, fileObject, bytes);
    sendJson(response, 200, fileObject);
    return true;
  }

  if (rest === "model_selector_state/chat") {
    if (request.method === "GET") {
      sendJson(response, 200, { id: "chat", model: (await selectedModel()) || (await engine.defaultModel()) });
      return true;
    }
    if (["PUT", "POST", "PATCH"].includes(request.method)) {
      const body = await readJson(request);
      if (typeof body.model === "string" && body.model) {
        await store.writeJsonFile("model-selection.json", { model: body.model });
      }
      sendJson(response, 200, { id: "chat", model: (await selectedModel()) || body.model });
      return true;
    }
  }

  match = rest.match(/^(chat_conversations_v2|chat_conversations)$/);
  if (match && request.method === "GET") {
    const conversations = await engine.listConversations();
    const filtered = url.searchParams.get("starred") === "true"
      ? conversations.filter((conversation) => conversation.is_starred)
      : conversations;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 250));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const page = filtered.slice(offset, offset + limit)
      .map((conversation) => engine.mapConversation(conversation));
    if (match[1] === "chat_conversations") {
      sendJson(response, 200, page);
    } else {
      sendJson(response, 200, { data: page, has_more: offset + limit < filtered.length });
    }
    return true;
  }
  if (match && request.method === "POST") {
    const body = await readJson(request);
    const conversation = await engine.createConversation({
      uuid: body.uuid,
      name: body.name || "",
      model: body.model || undefined,
      isTemporary: Boolean(body.is_temporary),
    });
    sendJson(response, 200, engine.mapConversation(conversation));
    return true;
  }

  match = rest.match(/^chat_conversations\/([0-9a-f-]{36})(?:\/(.*))?$/i);
  if (!match) return false;
  const conversationId = match[1];
  const action = match[2] || "";

  if (!action && request.method === "GET") {
    const conversation = await engine.getConversation(conversationId);
    sendJson(response, 200, engine.mapConversationWithMessages(conversation), {
      ETag: `"rev-${conversation.revision || 0}"`,
    });
    return true;
  }
  if (!action && (request.method === "PATCH" || request.method === "PUT")) {
    const body = await readJson(request);
    const conversation = await engine.updateConversation(conversationId, body);
    sendJson(response, 200, engine.mapConversation(conversation));
    return true;
  }
  if (!action && request.method === "DELETE") {
    await engine.deleteConversation(conversationId);
    sendJson(response, 200, {});
    return true;
  }

  const simpleActions = {
    "star": { is_starred: true },
    "unstar": { is_starred: false },
    "archive": { is_archived: true },
    "unarchive": { is_archived: false },
  };
  if (simpleActions[action] && request.method === "POST") {
    const conversation = await engine.updateConversation(conversationId, simpleActions[action]);
    sendJson(response, 200, engine.mapConversation(conversation));
    return true;
  }
  if (action === "title" && request.method === "POST") {
    const body = await readJson(request);
    await engine.updateConversation(conversationId, { name: body.name || body.title || "" });
    sendJson(response, 200, { title: body.name || body.title || "" });
    return true;
  }
  if (action === "serving" && (request.method === "GET" || request.method === "POST")) {
    sendJson(response, 200, { connector_domains_withheld: [] });
    return true;
  }
  if (action === "stop_response" && request.method === "POST") {
    await readJson(request).catch(() => ({}));
    engine.abortActiveTurn(conversationId);
    sendJson(response, 200, {});
    return true;
  }
  if ((action === "completion" || action === "append_message" || action === "retry_completion")
    && request.method === "POST") {
    await handleCompletion(request, response, conversationId);
    return true;
  }
  return false;
}

// Streams one assistant turn over SSE in the mobile contract (§6.2), while
// persisting canonical state so reopening or another surface sees the same IDs.
async function handleCompletion(request, response, conversationId) {
  const body = await readJson(request, 72 * 1024 * 1024);
  let conversation;
  try {
    conversation = await engine.getConversation(conversationId);
  } catch (error) {
    // A new chat carries a client-generated UUID plus create_conversation_params
    // on its first completion; the conversation does not exist yet.
    if (error.status !== 404) throw error;
    const params = body.create_conversation_params || {};
    conversation = await engine.createConversation({
      uuid: conversationId,
      name: params.name || "",
      model: params.model || body.model || (await selectedModel()) || undefined,
      isTemporary: Boolean(params.is_temporary),
    });
  }
  const isRetry = new URL(request.url, "http://localhost").pathname
    .endsWith("/retry_completion");
  const turn = await engine.prepareTurn({ conversation, body, retry: isRetry });

  response.writeHead(200, SSE_HEADERS);
  let accumulatedText = "";
  let stopReason = "end_turn";
  const abort = new AbortController();
  engine.registerActiveTurn(conversationId, {
    abort,
    assistantUuid: turn.assistantMessage?.uuid || turn.assistantUuid,
  });
  response.on("close", () => {
    if (!response.writableEnded) abort.abort(new Error("client disconnected"));
  });
  const finish = async () => {
    engine.clearActiveTurn(conversationId);
    await engine.finishAssistantTurn(
      conversation,
      turn.assistantMessage?.uuid || turn.assistantUuid,
      accumulatedText,
      stopReason,
    );
  };
  try {
    for await (const event of engine.streamAssistantTurn(conversation, {
      humanMessage: turn.humanMessage,
      assistantUuid: turn.assistantMessage?.uuid || turn.assistantUuid,
      model: turn.model,
      signal: abort.signal,
      plan: turn.plan,
    })) {
      if (event.event === "content_block_delta" && event.data?.delta?.type === "text_delta") {
        accumulatedText += event.data.delta.text;
      }
      if (event.event === "message_delta") {
        stopReason = event.data?.delta?.stop_reason || stopReason;
      }
      sendSseRecord(response, event.event, event.data);
    }
    await finish();
  } catch (error) {
    engine.clearActiveTurn(conversationId);
    if (error.name === "AbortError" || /aborted/i.test(String(error.message))) {
      stopReason = "user_canceled";
      sendSseRecord(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "user_canceled", stop_sequence: null },
      });
      sendSseRecord(response, "message_stop", { type: "message_stop" });
      await finish().catch(() => {});
      return;
    }
    console.error(`[mobile-api] completion failed: ${error.message}`);
    const status = error.upstreamStatus === 429 ? 429 : 502;
    const type = error.upstreamType || "api_error";
    await finish().catch(() => {});
    sendSseRecord(response, "error", {
      type: "error",
      error: { type, message: error.message },
    });
    response.end();
    return;
  }
  response.end();
}

async function extractAttachmentText(bytes, fileName) {
  if (!bytes.length) return "";
  const isTextLike = /\.(txt|md|json|csv|xml|html?|ya?ml|log|ts|js|mjs|cjs|py|sh|toml)$/i.test(fileName)
    || bytes.subarray(0, 512).every((byte) => byte === 0x09 || byte === 0x0a
      || byte === 0x0d || (byte >= 0x20 && byte < 0x7f));
  if (!isTextLike) return "";
  const text = bytes.toString("utf8");
  return text.slice(0, 1024 * 1024);
}

function detectedType(bytes, fileName) {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (/\.json$/i.test(fileName)) return "application/json";
  return "text/plain";
}

// Model listing + download routes handy for the mobile UI.
async function handleFileDownload(request, response, url) {
  const match = url.pathname.match(/^\/files\/([0-9a-f-]{36})$/i);
  if (!match || request.method !== "GET") return false;
  const record = await store.readUploadedFile(match[1]);
  if (!record) {
    sendErrorEnvelope(response, 404, "not_found", "file not found");
    return true;
  }
  response.writeHead(200, {
    "Content-Type": record.meta?.file_type || "application/octet-stream",
    "Content-Length": record.bytes.length,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(record.meta?.file_name || "attachment")}"`,
  });
  response.end(record.bytes);
  return true;
}

async function handleStreamRecents(request, response) {
  response.writeHead(200, {
    ...SSE_HEADERS,
    "Content-Type": "application/connect+json",
    "Connect-Protocol-Version": "1",
  });
  const push = async (replaceHead = false) => {
    const items = await engine.listRecents({});
    const payload = Buffer.from(JSON.stringify({
      update: {
        replaceHead,
        items: items.map((item) => ({ chat: item })),
        removed: [],
        syncToken: `sync-${Date.now()}`,
      },
    }), "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(payload.length, 1);
    response.write(Buffer.concat([header, payload]));
  };
  await push(true);
  const timer = setInterval(() => {
    push(false).catch(() => clearInterval(timer));
  }, 5000);
  timer.unref?.();
  response.on("close", () => clearInterval(timer));
  const end = encodeConnectFrame(Buffer.from(JSON.stringify({}), "utf8"), 0x02);
  // Keep the stream until disconnect; the end frame is sent on close.
  response.on("close", () => {
    try { response.end(end); } catch { /* response already gone */ }
  });
}

function encodeConnectFrame(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function handleConnectUnary(request, response, url, method) {
  const handler = connectMethods[method];
  if (!handler) {
    await captureUnhandled(request, url, "connect");
    sendErrorEnvelope(response, 404, "not_found", `unknown connect method "${url.pathname}"`);
    return true;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) {
      sendErrorEnvelope(response, 413, "invalid_request", "connect body too large");
      return true;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  let decoded;
  try {
    decoded = decodeConnectRequest(request, rawBody);
  } catch (error) {
    sendErrorEnvelope(response, error.status || 400, "invalid_request",
      `connect decode failed: ${error.message}`);
    return true;
  }
  const isStreaming = connectStreamingMethods.has(method);
  const isProto = (MIME_TO_PROTO.get(
    (request.headers["content-type"] || "application/json").split(";")[0].trim(),
  ) ?? false);
  try {
    const value = await handler({ methodRequest: decoded, method, engine, identity, store, url });
    if (isStreaming) {
      // Served by dedicated streaming handlers; unreachable here.
      return true;
    }
    const payload = encodeConnectResponse(request, method, value);
    if (url.pathname.startsWith("/claudeai-rpc/")) {
      // Connect unary: no envelope for application/json responses on plain
      // HTTP; the client sent framed body so reply framed too.
      const body = request.headers["content-type"]?.startsWith("application/connect+")
        ? encodeConnectFrame(payload, 0)
        : payload;
      response.writeHead(200, {
        "Content-Type": isProto ? "application/proto" : "application/json",
        "Connect-Protocol-Version": "1",
      });
      response.end(body);
    } else {
      // gRPC-style: raw proto body.
      response.writeHead(200, {
        "Content-Type": "application/proto",
        "Grpc-Status": "0",
      });
      response.end(payload);
    }
  } catch (error) {
    console.error(`[mobile-api] connect ${method} failed: ${error.message}`);
    if (error instanceof CompletionError || error?.status) {
      sendErrorEnvelope(response, error.status || 500, error.type || "internal",
        error.message);
    } else {
      sendErrorEnvelope(response, 500, "internal", error.message);
    }
  }
  return true;
}

async function handleConnect(request, response, url) {
  if (!await currentSession(request)) {
    sendErrorEnvelope(response, 401, "authentication_error", "sign in required");
    return;
  }
  const method = normalizeConnectMethod(url.pathname);
  if (isStreamingConnectMethod(method)) {
    if (method === `${BARD_SERVICE}/StreamTimeline`) {
      await handleStreamTimeline(request, response, url);
      return;
    }
    await handleStreamRecents(request, response);
    return;
  }
  await handleConnectUnary(request, response, url, method);
}

// Streams the full Bard timeline, then incremental updates whenever the
// canonical conversation changes. Heartbeats keep intermediate proxies from
// closing the connection.
async function handleStreamTimeline(request, response, url) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      sendErrorEnvelope(response, 413, "invalid_request", "connect body too large");
      return;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  let decoded = {};
  try {
    decoded = decodeConnectRequest(request, rawBody);
  } catch (error) {
    sendErrorEnvelope(response, error.status || 400, "invalid_request",
      `connect decode failed: ${error.message}`);
    return;
  }
  const conversationId = decoded.conversationId || decoded.conversation_id;
  if (!conversationId) {
    sendErrorEnvelope(response, 400, "invalid_request", "conversation_id is required");
    return;
  }
  response.writeHead(200, {
    ...SSE_HEADERS,
    "Content-Type": "application/connect+json",
    "Connect-Protocol-Version": "1",
  });
  const writeUpdate = async (snapshot) => {
    if (response.writableEnded) return;
    const event = {
      event: { update: snapshot ?? null, version: { value: String(Date.now()) } },
    };
    const payload = Buffer.from(JSON.stringify(event), "utf8");
    response.write(encodeConnectFrame(payload, 0));
  };
  const writeHeartbeat = () => {
    if (response.writableEnded) return;
    const heartbeat = Buffer.from(JSON.stringify({ event: { heartbeat: {} } }), "utf8");
    response.write(encodeConnectFrame(heartbeat, 0));
  };
  const emitSnapshot = async () => {
    try {
      const conversation = await engine.getConversation(conversationId);
      await writeUpdate(engine.bardSnapshot(conversation));
    } catch {
      // conversation deleted between watch and snapshot; ignore
    }
  };
  await emitSnapshot();
  const unsubscribe = engine.registerBardWatcher(conversationId, (snapshot) => {
    if (!snapshot) {
      const deleted = { event: { conversationDeleted: { conversationId } } };
      const payload = Buffer.from(JSON.stringify(deleted), "utf8");
      try {
        response.write(encodeConnectFrame(payload, 0));
      } catch { /* response gone */ }
      try { response.end(); } catch { /* already gone */ }
      return;
    }
    void writeUpdate(snapshot);
  });
  const heartbeat = setInterval(() => {
    writeHeartbeat();
  }, 20000);
  heartbeat.unref?.();
  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { response.end(); } catch { /* already closed */ }
  });
}

async function handleApi(request, response, url) {
  // Auth-free health check for the container.
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      email: identity.email,
      inference: "applied-3p-config",
      models: await engine.listModels().then((models) => models.length).catch(() => 0),
      activeTurns: engine.activeTurnCount?.() ?? undefined,
    });
    return;
  }

  // Auth-free /api/legal and the auth flow itself.
  if (await handleAuth(request, response, url)) return;

  // Everything else requires a session.
  const session = await currentSession(request);
  if (!session) {
    sendErrorEnvelope(response, 401, "authentication_error", "sign in required");
    return;
  }

  if (await handleAccountRoutes(request, response, url)) return;
  if (await handleBootstrapRoute(request, response, url)) return;
  if (await handleOptionalEmptyRoutes(request, response, url)) return;
  if (await handleFileDownload(request, response, url)) return;
  if (await handleConversationRoutes(request, response, url)) return;

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = session;
    await store.destroySession(token);
    sendJson(response, 200, {}, { "Set-Cookie": auth.clearSessionCookie() });
    return;
  }

  await captureUnhandled(request, url, "rest");
  sendErrorEnvelope(response, 404, "not_found", `unknown API route ${url.pathname}`);
}

// With CLAUDE_MOBILE_CAPTURE=1, remember what the app asked for that this
// service does not implement, with a redacted body.
async function captureUnhandled(request, url, surface) {
  if (!capture.enabled) return;
  try {
    await capture.record({
      kind: "unhandled",
      surface,
      method: request.method,
      path: url.pathname,
      query: [...url.searchParams.keys()],
      contentType: request.headers["content-type"],
      body: await describeBody(request),
    });
  } catch (error) {
    console.error(`[mobile-capture] ${error.message}`);
  }
}

async function currentSession(request) {
  return (await auth.requireSession(request)) || (await bearerSession(request));
}

async function bearerSession(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return (await store.touchSession(token)) ? token : null;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (capture.enabled) {
    response.on("finish", () => {
      void capture.record({
        kind: "request",
        method: request.method,
        path: url.pathname,
        query: [...url.searchParams.keys()],
        status: response.statusCode,
        contentType: request.headers["content-type"],
      }).catch(() => {});
    });
  }
  try {
    if (url.pathname.startsWith("/claudeai-rpc/")
      || url.pathname.includes(`${BARD_SERVICE}/`)
      || url.pathname.includes(`${RECENTS_SERVICE}/`)) {
      await handleConnect(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    sendErrorEnvelope(response, 404, "not_found", "unknown route");
  } catch (error) {
    console.error(`[mobile-api] ${request.method} ${url.pathname} failed: ${error.message}`);
    if (!response.writableEnded) {
      sendErrorEnvelope(response, error.status || 500, error.type || "internal",
        error.message || "internal error");
    }
  }
});

server.listen(port, host, () => {
  console.log(`[mobile-api] listening on ${host}:${port}; data=${dataDir}; claudesk=${desktop.baseUrl}`);
});
