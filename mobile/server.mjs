import http from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
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
import { createCodeEngine } from "./code-engine.mjs";
import {
  BRIDGE_ENVIRONMENT_ID,
  CLOUD_ENVIRONMENT_ID,
  CHANNEL_MESSAGE_EVENT,
  bridgeEnvironment,
  channelEmptyPage,
  channelMessageForEnvelope,
  channelResource,
  cloudEnvironment,
  folderDirectoryFromEnvironmentId,
  folderEnvironment,
  isRenderableEntry,
  remoteDeviceDirectory,
  sseFrameForEntry,
} from "./code-transcript.mjs";
import { desktopSessionIdFor as codeSessionDesktopId } from "./code-ids.mjs";
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
// Code (Claude Code / LocalSessions) is a parallel engine, not a mode of the
// Chat one: same bridge, different Desktop surface and different DTOs.
const codeEngine = createCodeEngine({ store, desktop });
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

function readJsonUntraced(request, limit = 16 * 1024 * 1024) {
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

// `handleCodeRoutes` shadows this name with a logging wrapper; everywhere else
// reads the body once and moves on.
const readJson = readJsonUntraced;

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

// Log event metadata without printing transcript contents.
function describeSdkMessage(data) {
  return `${data?.event_type ?? "unknown"} sequence=${data?.sequence_num ?? "-"} uuid=${String(data?.event_id ?? "-").slice(0, 8)}`;
}

function orgUuidFromPath(pathname) {
  const match = pathname.match(/^\/api\/organizations\/([0-9a-f-]{36})(\/|$)/i);
  return match ? match[1].toLowerCase() : null;
}

async function selectedModel() {
  const saved = await store.readJsonFile("model-selection.json", null);
  return typeof saved?.model === "string" ? saved.model : "";
}

// The app both writes this field and reads it back, so the bytes it sent are
// the bytes it knows how to decode — echo them and never re-shape them. That
// matters because `ThinkingState` is a hand-written Codable (`effortAndMode`
// exists only in the reflection section, so it is a case name, not a coding
// key), which means its wire form is whatever the app's own `init(from:)` /
// `encode(to:)` pair chose. Both a flat `{effort, mode}` and a re-derived
// `type` tag are guesses at that, and a wrong guess fails the decode of the
// whole model selector.
function cleanThinking(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { ...value };
}

// The model selector is per-surface: the Chat composer reads the `chat` entry,
// the Code composer the `code` one, the Cowork session chat the `cowork` one
// (the app's `ModelSurface` enum is exactly unspecified | chat | cowork |
// code). A surface the bootstrap does not answer gets no model at all, which is
// why a composer on an unlisted surface had no picker and none of the models
// behind it. `Surface` is a RawRepresentable string wrapper and goes out as the
// bare string (the `id: "chat"` entry has always decoded), so an entry for a
// surface the app does not know is ignored rather than fatal — the list is
// deliberately a superset.
const MODEL_SURFACES = ["chat", "cowork", "code"];

// The chat selection predates the per-surface split and keeps its original
// top-level keys so an existing model-selection.json still reads back; every
// other surface is namespaced.
function surfaceKeys(surface) {
  return surface === "chat"
    ? { model: "model", byModel: "thinking_by_model" }
    : { model: `${surface}_model`, byModel: `${surface}_thinking_by_model` };
}

// A PUT body is a ModelSelectorStateBody: `model` and `thinking` are each a
// ModelSelectorEdit — a `{set, unchanged}` payload enum — and Swift nests the
// payload, so accept the bare value, the case wrapper and the `_0` alike.
function editValue(edit) {
  if (typeof edit === "string") return edit;
  if (!edit || typeof edit !== "object") return undefined;
  const inner = "set" in edit ? edit.set : "value" in edit ? edit.value : undefined;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object" && "_0" in inner) return editValue(inner._0);
  return undefined;
}

function editObject(edit) {
  if (!edit || typeof edit !== "object") return undefined;
  const inner = "set" in edit ? edit.set : "value" in edit ? edit.value : edit;
  if (!inner || typeof inner !== "object") return undefined;
  return "_0" in inner ? inner._0 : inner;
}

// `thinking_by_model` is an `IdentifiedArray<ModelThinkingDefault>`: an ARRAY of
// `{id, thinking}`, not the dictionary its name suggests. IdentifiedArray
// decodes all-or-nothing, and SurfaceState sits in the same all-or-nothing
// `states` array, so emitting the wrong container takes the whole model
// selector — every surface — down with it. The stored file is a map; the wire
// is an array. Read either (the app has never been seen to send this field, but
// the file could hold either shape), always write the array.
function thinkingDefaultsFor(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const row of value) {
      if (row && typeof row.id === "string" && row.thinking) out[row.id] = row.thinking;
    }
    return out;
  }
  return value && typeof value === "object" ? value : {};
}

function thinkingDefaultsWire(byModel) {
  return Object.entries(byModel).map(([id, thinking]) => ({ id, thinking }));
}

// SurfaceState for one surface: the selected model plus the app's thinking
// choice (`thinking`) and the choice remembered for each model (`thinking_by_model`).
// `model` is a non-optional String in SurfaceState, so it is always a string —
// omitting it fails the app's decode of the whole bootstrap payload.
async function surfaceSelectorState(surface, fallbackModel) {
  const saved = await store.readJsonFile("model-selection.json", null);
  const keys = surfaceKeys(surface);
  const model = (typeof saved?.[keys.model] === "string" && saved[keys.model]) || fallbackModel || "";
  const byModel = thinkingDefaultsFor(saved?.[keys.byModel]);
  const thinking = cleanThinking(byModel[model]);
  return {
    id: surface,
    model,
    ...(thinking ? { thinking } : {}),
    ...(Object.keys(byModel).length ? { thinking_by_model: thinkingDefaultsWire(byModel) } : {}),
  };
}

async function saveSurfaceSelection(surface, body) {
  const saved = (await store.readJsonFile("model-selection.json", null)) || {};
  const keys = surfaceKeys(surface);
  const next = { ...saved };
  const model = editValue(body?.model);
  if (model) next[keys.model] = model;
  const byModel = { ...thinkingDefaultsFor(saved[keys.byModel]) };
  for (const [id, value] of Object.entries(thinkingDefaultsFor(body?.thinking_by_model))) {
    const pick = cleanThinking(value);
    if (pick) byModel[id] = pick;
  }
  const thinking = cleanThinking(editObject(body?.thinking));
  if (thinking) {
    if (surface === "chat") next.thinking = thinking;
    if (next[keys.model]) byModel[next[keys.model]] = thinking;
  }
  if (Object.keys(byModel).length) next[keys.byModel] = byModel;
  await store.writeJsonFile("model-selection.json", next);
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
      role: plan.membershipRole,
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

// The plan the account claims to be on, using the field values claude.ai
// itself reports. The app decides what to unlock (the Code tab, for one) from
// these, so a free-looking account gets upsells instead of the feature.
//
// `membershipRole` is the decisive one for Code. The app decodes the
// membership role into an enum whose cases are the raw values `user`,
// `developer`, `billing`, `admin`, `owner`, `primary_owner`,
// `membership_admin`, `claude_code_user`, `managed`, `unknown`. Code is
// provisioned to the `claude_code_user` cohort, so an account reported as
// `owner` (what we used to send) is treated as a plain billing owner and the
// Code surface is never offered.
const CODE_CAPABILITY = "claude_code_web";
const PLANS = {
  free: { capabilities: ["chat"], analytics: "free", display: "Free", tier: "default_claude_ai", billing: null, membershipRole: "user" },
  pro: { capabilities: ["chat", "claude_pro"], analytics: "pro", display: "Pro", tier: "default_claude_pro", billing: "stripe_subscription", membershipRole: "claude_code_user" },
  max_5x: { capabilities: ["chat", "claude_max"], analytics: "max", display: "Max", tier: "default_claude_max_5x", billing: "stripe_subscription", membershipRole: "claude_code_user" },
  max_20x: { capabilities: ["chat", "claude_max"], analytics: "max", display: "Max", tier: "default_claude_max_20x", billing: "stripe_subscription", membershipRole: "claude_code_user" },
};
const planName = process.env.CLAUDE_MOBILE_PLAN || "max_20x";
const plan = PLANS[planName] || PLANS.max_20x;

// What app_start must carry for the app to show the Code tab on a paid plan:
// the remote-sessions flag and the claude_code_web access entry. The three
// access lists below are separate surfaces in the app (account-level,
// organization-level and the seat itself); an entry missing from any of them
// can be the one that gates the tab, so a paid plan declares Code in all of
// them.
const paidPlan = plan !== PLANS.free;

// GrowthBook flags that can gate the Code / Cowork surfaces in the iOS app.
// Names are taken from the app's own GrowthBookFeatures table (static analysis
// of the binary), so every key here is one the app actually reads. Each feature
// is emitted in the SDK shape the app's GrowthBookFeatureDefinition expects:
// { key, defaultValue, rules }.
const CODE_FLAGS = [
  "mobile_remote_enabled",
  "mobile_cowork_tab_enabled",
  "claudeai_hub_code_sessions",
  "claudeai_hub_cowork_session_chat",
  "claudeai_code_warm_start",
  "claudeai_code_usage_enabled",
  "claudeai_code_session_drafts",
  "claudeai_code_session_feedback",
  "claudeai_code_sessions_widget_enabled",
  "claudeai_code_sessions_widget_projects_enabled",
  "claudeai_code_session_without_repo",
  "claudeai_code_project_clawd",
  "claudeai_code_project_drawer_pins",
  "claudeai_code_project_opens_to_overview",
  "claudeai_code_project_swipe_to_overview",
  "claudeai_code_project_remote_control",
  "claudeai_code_project_drive_folder_browser",
  "claudeai_code_send_environment_setup",
  // Gates the cross-device / paired-device listing the environment picker draws
  // its "devices" rows from; on so the picker is offered its environments.
  "claudeai_cross_device_sync",
  "claudeai_code_collapse_long_user_messages",
  "claudeai_code_routine_create_form",
  "claudeai_drawer_search",
  "claudeai_projects_nav_kill_switch",
  "claudeai_projects_tab_skip_legacy_fetch",
  "claudeai_continue_on_cloud",
  "claudeai_single_attention_mark",
];

// Kill switches are named "..._kill_switch": they *disable* a surface when on,
// so they get false; every other Code flag defaults to off in the real app and
// we flip it on, making the empirical test unambiguous either way.
// The app's GrowthBook client evaluates features by hashing the flag name and
// looking it up in the features map — base64(sha256(exact_key)), "=" padding
// included. The map must therefore be keyed by the hash, with the plaintext
// name kept in each feature's `key` for attribution.
function hashedFeatureKey(key) {
  return createHash("sha256").update(key, "utf8").digest("base64");
}

function growthbookFeatures() {
  if (!paidPlan) return {};
  const features = {};
  for (const key of CODE_FLAGS) {
    const value = key.endsWith("_kill_switch") ? false : true;
    features[hashedFeatureKey(key)] = { key, defaultValue: value, rules: [] };
  }
  return features;
}

function orgGrowthbook() {
  return { features: growthbookFeatures(), experiments: [] };
}

function userAccess() {
  const codeAccess = paidPlan ? [{ feature: CODE_CAPABILITY, status: "available" }] : [];
  return {
    features: [...codeAccess],
    account_features: [...codeAccess],
    organization_permissions: [...codeAccess],
  };
}

function organizationObject() {
  return {
    uuid: identity.orgUuid,
    name: "Self-hosted",
    capabilities: [...plan.capabilities],
    analytics_subscription_plan: plan.analytics,
    plan_display_name: plan.display,
    rate_limit_tier: plan.tier,
    billing_type: plan.billing,
    settings: {},
  };
}

// The org usage card. Shape recovered from the IPA's `UsageResponse` coding
// keys: `limits` is a list of `MessageLimit` windows (`fiveHour`, `sevenDay`,
// `sevenDayOpus`, `sevenDaySonnet`, `overage`), each a `MessageLimitWindow`
// (`status`, `resetsAt`, `utilization`, `surpassedThreshold`, `period`,
// `limitScope`, `groupUuid`); `spend` and `extraUsage` are the credit blocks.
//
// This deployment has no metered upstream — Claudesk forwards to the account's
// own gateway — so reporting every window at zero utilization is the honest
// answer, and it renders as "no usage" rather than erroring.
function usageObject() {
  const window = (period, limitScope) => ({
    status: "allowed",
    resets_at: null,
    utilization: 0,
    surpassed_threshold: false,
    period,
    limit_scope: limitScope,
    group_uuid: null,
  });
  return {
    limits: [
      window("five_hour", "session"),
      window("seven_day", "weekly_all"),
      window("seven_day_opus", "weekly_model"),
      window("seven_day_sonnet", "weekly_model"),
    ],
    spend: {
      monthly_credit_limit: null,
      is_enabled: false,
      cap: null,
      out_of_credits: false,
      disabled_until: null,
    },
    extra_usage: {
      is_enabled: false,
      monthly_credit_limit: null,
      spend: null,
    },
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
    sendJson(response, 200, { growthbook: { features: growthbookFeatures(), experiments: [] } });
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
  if (/^\/api\/organizations\/[0-9a-f-]{36}\/usage$/i.test(path)) {
    sendJson(response, 200, usageObject());
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
  const models = await engine.listModels("chat");
  const chosen = await selectedModel();
  const defaultModel = models.some((model) => model.id === chosen) ? chosen : models[0]?.id;
  // Each surface gets Desktop's own catalog for it, not the chat list copied
  // three ways: a Code entry offers effort without a thinking mode, and the
  // composer builds its picker from whatever its own surface advertises.
  const configs = await Promise.all(MODEL_SURFACES.map(async (surface) => ({
    id: surface,
    models: await engine.listModels(surface).catch(() => []),
  })));
  sendJson(response, 200, {
    account: accountObject(),
    org_growthbook: orgGrowthbook(),
    current_user_access: userAccess(),
    model_selector_state: await Promise.all(MODEL_SURFACES.map((surface) => surfaceSelectorState(surface, defaultModel))),
    model_selector_config: configs,
  });
  return true;
}

async function handleOptionalEmptyRoutes(request, response, url) {
  const org = orgUuidFromPath(url.pathname);
  if (!org) return false;
  const rest = url.pathname.replace(/^\/api\/organizations\/[0-9a-f-]{36}\/?/i, "");
  // The paired Desktop as a `RemoteDevice`: the Code tab groups a device's
  // directories (`ConnectedDevice.environments`, the bridge environments that
  // share its name) under this record, and remembers the pick. Answering `[]`
  // left every bridge environment floating as its own top-level row.
  if (rest === "cowork/remote_devices" && request.method === "GET") {
    const directory = remoteDeviceDirectory({ online: await desktopReady() });
    console.log(`[mobile-code]   cowork/remote_devices -> ${JSON.stringify(directory)}`);
    sendJson(response, 200, directory);
    return true;
  }
  const isEmptyList = [
    "projects",
    "published_artifacts",
    "artifacts",
    "composer_notices",
    "members/display_info",
    "cowork/sessions",
    "skills/list-skills",
    "mcp/remote_servers",
    "notification/channels",
  ].includes(rest);
  if (isEmptyList && request.method === "GET") {
    sendJson(response, 200, []);
    return true;
  }
  if (rest === "experiences" && request.method === "GET") {
    // The Code tab's bannerMs leg. ExperienceListResponse = {experiences,rules};
    // no server-driven banners/spotlights are configured here, so the lists are
    // empty. The app tolerates an empty list and simply draws no experience.
    sendJson(response, 200, { experiences: [], rules: { global: {}, placements: {} } });
    return true;
  }
  const isNoOpObject = [
    "memory/settings",
    "reflections/settings",
    "sync/auth/status",
    "sync/github/auth",
    "notification/preferences",
    "cowork_settings",
    "permission_mode_policy",
  ].includes(rest);
  if (isNoOpObject && request.method === "GET") {
    // The Code tab gates starting a session on GitHub being connected and shows
    // "Connect to GitHub to start a session" otherwise. There is no upstream
    // GitHub here, but a repo-less cloud session does not need one, so report
    // connected to clear the gate. Set CLAUDE_MOBILE_GITHUB_CONNECTED=0 to get
    // the truthful `false` back.
    const githubConnected = process.env.CLAUDE_MOBILE_GITHUB_CONNECTED !== "0";
    const defaults = {
      "memory/settings": {
        is_memory_enabled: false,
        is_melange_memory_enabled: false,
        is_memory_search_enabled: false,
      },
      "reflections/settings": { verdict: null },
      // The app decodes this whole body into `FirstPartyAuthStatus`, whose one
      // stored property is `github: Bool` (ClaudeData/OrganizationStore.swift
      // keeps it as `_firstPartyAuth`). A body without `github` throws
      // `No value associated with key CodingKeys(stringValue: "github"…)` from
      // the synthesized `FirstPartyAuthStatus.init(from:)` at `Claude+0x10b5770`
      // — observed on-device at +7 s every launch. `connected` is kept because
      // the mobile-API spec documents it; the decoder ignores keys it has no
      // property for, so carrying both satisfies either shape.
      "sync/auth/status": { github: githubConnected, connected: githubConnected },
      // `CodeGitHubAuthStatus` — the Code tab's GitHub gate. The app GETs this
      // and used to fall through to a 404. `ghe_connections: []` is a truthful
      // "no enterprise GitHub connections" (wire casing is snake_case: the
      // shared decoder sets .convertFromSnakeCase) and `github: false` says no
      // github.com connection.
      "sync/github/auth": { github: githubConnected, ghe_connections: [] },
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

// ---- Claude Code surface -------------------------------------------------
// The iOS Code tab loads four legs when it opens (CodeTabLoadResult names them
// sessionsMs / devicesMs / projectsMs / reposMs / bannerMs). The shapes below
// are read from the app's Swift Codable types; see
// docs/mobile-code-re-findings.md for the type descriptors and field lists.
//   GET /v1/code/sessions                                  -> ListSessionsResponse
//   GET /v1/environment_providers/private/organizations/…  -> EnvironmentListResponse
//   GET /api/organizations/…/experiences                   -> ExperienceListResponse
//
// WIRE CASING: the app's shared JSONDecoder sets .convertFromSnakeCase and
// these DTOs carry no custom CodingKeys raw values, so camelCase Swift
// properties — nextCursor, resumeToken, hasMore, firstId, lastId — arrive on
// the wire as snake_case (next_cursor, …). The account endpoint this facade
// already serves proves it (it sends email_address, created_at, …).
// Enum *values* are NOT touched by the strategy: they are the literals the
// app declares as raw values.
// Secrets at rest: none of these responses carries a credential, so nothing
// here is redacted.
async function handleCodeRoutes(request, response, url) {
  const path = url.pathname;
  const method = request.method;

  // One line per Code request, with what it answered. The Code tab fails as a
  // single opaque "Something went wrong" on the phone, so the server log is the
  // only place the failing leg is visible. An SSE leg never emits `finish`
  // while it is open, so it is logged when the headers go out instead — that is
  // the moment its status is known — and `finish` covers the rest.
  const trace = (status) =>
    console.log(`[mobile-code] ${method} ${path}${url.search || ""} -> ${status}`);
  let traced = false;
  response.once("finish", () => {
    if (!traced) trace(response.statusCode);
  });
  response.once("close", () => {
    if (!traced) trace(response.statusCode);
  });
  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = (...args) => {
    traced = true;
    trace(args[0] ?? response.statusCode);
    return originalWriteHead(...args);
  };

  // Every body this surface reads is logged once, before it is handled: the
  // phone shows only "Something went wrong", so the request the app actually
  // sends is the difference between a leg this service implements and one it
  // does not. Shadowing the module-level `readJson` inside this function (all
  // the Code handlers are closed over by it) leaves every other surface quiet.
  let bodyLogged = false;
  const readJson = async (incoming) => {
    const raw = await readJsonUntraced(incoming);
    if (!bodyLogged) {
      bodyLogged = true;
      console.log(`[mobile-code]   body=${JSON.stringify(raw).slice(0, 2000)}`);
    }
    return raw;
  };

  async function fail(error) {
    const status = error?.status || 500;
    sendErrorEnvelope(response, status, error?.type || "internal", error?.message || "internal error");
  }

  // --- title / branch generation ----------------------------------------------
  // The new-session flow asks for a title and a branch name before it creates
  // the session; a 404 here is what the phone reports as
  // `mobile_code_generate_title_and_branch_failure`. `title` is the only field
  // of `GenerateSessionTitleResponse`; `GenerateTitleAndBranchResponse` carries
  // `branchName`, but the type has a hand-written decoder whose wire key is not
  // recoverable from the binary, so answer both spellings — Codable ignores the
  // one it does not want.
  const dustMatch = path.match(/^\/api\/organizations\/[0-9a-f-]{36}\/dust\/(generate_title_and_branch|generate_session_title)$/i);
  if (dustMatch && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const message = typeof body?.first_session_message === "string" ? body.first_session_message
      : typeof body?.firstSessionMessage === "string" ? body.firstSessionMessage
        : "";
    const { title, branchName } = await codeEngine.suggestTitleAndBranch(message).catch(() => ({ title: "", branchName: "claude-session" }));
    sendJson(response, 200, { title, branch_name: branchName, branchName });
    return true;
  }

  // --- sessions list / create -------------------------------------------------
  if (path === "/v1/code/sessions" && method === "GET") {
    try {
      // Is the *list* the leg that fails? With this mode the app decodes an
      // empty page; if the send then stops throwing /v1/code/sessions, it is a
      // list row, not the create reply.
      if (sessionMode() === "list-empty") {
        sendJson(response, 200, { data: [], next_cursor: null, resume_token: null });
        return true;
      }
      const statuses = url.searchParams.getAll("statuses").flatMap((value) => value.split(",")).filter(Boolean);
      const tags = url.searchParams.getAll("tags").flatMap((value) => value.split(",")).filter(Boolean);
      const data = await codeEngine.listSessions({ statuses, tags, limit: url.searchParams.get("limit") });
      // `resume_token` is null: the app only uses it to resume a stream, which
      // this surface resumes by sequence number instead.
      sendJson(response, 200, { data, next_cursor: null, resume_token: null });
    } catch (error) {
      await fail(error);
    }
    return true;
  }
  // A one-shot switch to bisect the session replies on device without a
  // rebuild: CLAUDE_MOBILE_SESSION_CREATE_MODE, or the file /data/session-mode
  // read per request. Values:
  //   full (default) | nostatus | owned | owned0 | camel | status200 | ctxmin
  //   session_res/session_env (+`0`)  wrap the reply as {session: <payload>}
  //   drop:a,b.c,d   remove those keys (dotted paths allowed) from the reply
  //   only:a,b,c     emit only those top-level keys (plus what is required)
  //   list-empty     make GET /v1/code/sessions return an empty page
  function sessionMode() {
    try {
      const value = readFileSync("/data/session-mode", "utf8").trim();
      if (value) return value;
    } catch { /* no override file */ }
    return process.env.CLAUDE_MOBILE_SESSION_CREATE_MODE || "full";
  }

  if (path === "/v1/code/sessions" && method === "POST") {
    try {
      const body = await readJson(request).catch(() => ({}));
      let resource = await codeEngine.createSession({
        title: body.title ?? body.name ?? null,
        model: body.model ?? body.config?.model ?? null,
        permissionMode: body.permission_mode ?? body.config?.permission_mode ?? null,
        // `CreateSessionRequestConfig.cwd` is where the app puts a directly
        // picked directory (the device folder picker); a top-level `cwd` is
        // still accepted for older callers.
        cwd: body.cwd ?? null,
        // `CreateSessionRequestConfig.cwd` is where the app puts a directory it
        // picked directly. It is kept apart from the top-level `cwd` because a
        // repository in `config.sources` is the more specific pick and must win
        // over a `config.cwd` that is only the environment's default directory.
        configCwd: body.config?.cwd ?? null,
        // The repository the picker was created against (`config.sources`); the
        // session's project cwd is that repository's workspace folder.
        sources: body.config?.sources ?? null,
        // Which environment the picker chose. Both ids the facade advertises
        // run on the same Desktop; the session records it so its detail screen's
        // by-id environment read finds the record it was created against.
        environmentId: body.environment_id ?? body.environmentId ?? null,
      });
      const mode = sessionMode();
      if (mode === "nostatus") {
        delete resource.connection_status;
        delete resource.worker_status;
      } else if (mode === "owned") {
        resource = { owned: resource };
      } else if (mode === "owned0") {
        resource = { owned: { _0: resource } };
      } else if (mode === "camel") {
        resource = camelKeys(resource);
      } else if (mode === "session_res" || mode === "session_res0") {
        // `{session: <SessionResource>}`, with or without the SE-0295 `_0`.
        resource = mode.endsWith("0") ? { session: { _0: resource } } : { session: resource };
      } else if (mode === "session_env" || mode === "session_env0") {
        // `{session: <SessionResponse>}` — the SessionResponseEnvelope shape.
        const inner = resource.__sessionResponse ?? resource;
        resource = mode.endsWith("0") ? { session: { _0: inner } } : { session: inner };
      } else if (mode === "ctxmin") {
        // session_context is required and is the only required field the env
        // record does not also exercise; keep just its required keys.
        resource.session_context = { sources: [], outcomes: [] };
      } else if (mode.startsWith("drop:")) {
        for (const key of mode.slice(5).split(",").filter(Boolean)) {
          const parts = key.split(".");
          let target = resource;
          for (let i = 0; i < parts.length - 1 && target; i += 1) target = target[parts[i]];
          if (target && typeof target === "object") delete target[parts[parts.length - 1]];
        }
      } else if (mode.startsWith("only:")) {
        const keep = new Set(mode.slice(5).split(",").filter(Boolean));
        for (const key of Object.keys(resource)) if (!keep.has(key)) delete resource[key];
      }
      console.log(`[mobile-code]   create sources=${JSON.stringify(body.config?.sources ?? null)}`);
      // The create reply decides whether the app can hold the new session at
      // all: `revision` has to be an ISO date, and every date the app decodes
      // must be a string. Logging it here means a capture from a running build
      // proves by itself whether it emits `"revision":"2026-…"` or the bare `0`
      // that predates the wireDate fix — without needing the app-side decode
      // error to say which build is in the container.
      // The app decodes this reply as `SessionResponseEnvelope` — a `session`-keyed
      // envelope, NOT a bare SessionResource — so the default wire shape wraps
      // the list-row projection under `session`. Every other mode above is a
      // bisect override that replaces the shape.
      const reply = mode === "full"
        ? { session: resource.__sessionResponse ?? resource }
        : resource;
      console.log(`[mobile-code]   create mode=${mode} reply=${JSON.stringify(reply).slice(0, 2000)}`);
      sendJson(response, mode === "status200" ? 200 : 201, reply);
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  // --- watch (SSE), before the {id} matchers so "watch" is not read as an id --
  if (path === "/v1/code/sessions/watch" && method === "GET") {
    await streamCodeWatch(request, response, url, null);
    return true;
  }
  const watchMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/watch$/);
  if (watchMatch && method === "GET") {
    await streamCodeWatch(request, response, url, watchMatch[1]);
    return true;
  }

  // --- per-session legs -------------------------------------------------------
  const sessionMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/?$/);
  if (sessionMatch && method === "GET") {
    try {
      const { resource } = await codeEngine.getSession(sessionMatch[1]);
      sendJson(response, 200, resource);
    } catch (error) {
      await fail(error);
    }
    return true;
  }
  if (sessionMatch && method === "PATCH") {
    try {
      const body = await readJson(request).catch(() => ({}));
      sendJson(response, 200, await codeEngine.updateSession(sessionMatch[1], body));
    } catch (error) {
      await fail(error);
    }
    return true;
  }
  if (sessionMatch && method === "DELETE") {
    try {
      await codeEngine.deleteSession(sessionMatch[1]);
      sendJson(response, 200, {});
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  // The transcript's streaming read. The app opens an event *stream* for a
  // session it is showing (the detail screen), separate from the paged `events`
  // read below. Both transcript legs carry SessionEventEnvelope records.
  // It must match before the paged
  // matcher below, which is anchored and would otherwise miss it.
  const eventsStreamMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/events\/stream$/);
  if (eventsStreamMatch && method === "GET") {
    await streamCodeEvents(request, response, url, eventsStreamMatch[1]);
    return true;
  }

  const eventsMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    try {
      const page = await codeEngine.listEvents(eventsMatch[1], {
        cursor: url.searchParams.get("cursor"),
        limit: Number(url.searchParams.get("limit")) || 50,
        sortOrder: url.searchParams.get("sort_order") || "desc",
      });
      console.log(`[mobile-code] events page: ${page.data.length} events has_more=${Boolean(page.next_cursor)}`);
      sendJson(response, 200, page);
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  const promptsMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/pending_prompts$/);
  if (promptsMatch && method === "GET") {
    try {
      const prompts = codeEngine.permissionsFor(promptsMatch[1]);
      sendJson(response, 200, { prompts, permission_suggestions: [] });
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  const permissionMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/permissions\/([^/]+)$/);
  if (permissionMatch && method === "POST") {
    try {
      const body = await readJson(request).catch(() => ({}));
      const behavior = body.behavior || body.decision || body.action || "allow";
      await codeEngine.respondToPermission(permissionMatch[1], permissionMatch[2], behavior);
      sendJson(response, 200, {});
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  // The app pushes its own client events (presence, attestation, the "I loaded
  // these events" ack) to the same collection it reads history from. There is no
  // upstream for them on this facade — Desktop owns the transcript — so accept
  // and discard rather than 404, which is what made the detail screen error.
  if (/^\/v1\/code\/sessions\/[^/]+\/events$/.test(path) && method === "POST") {
    const posted = await readJson(request).catch(() => ({}));
    // The app pushes its own events here (presence, the "I loaded these"
    // ack, attestation) — and, on a bad decode, an error report. Logging the
    // body is how we see the app's own complaint when the screen stays blank.
    console.log(`[mobile-code]   posted=${JSON.stringify(posted).slice(0, 1500)}`);
    sendJson(response, 200, {});
    return true;
  }

  const streamMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/messages\/stream$/);
  if (streamMatch && method === "POST") {
    await streamCodeMessage(request, response, url, streamMatch[1]);
    return true;
  }

  const interruptMatch = path.match(/^\/v1\/code\/sessions\/([^/]+)\/(interrupt|stop)$/);
  if (interruptMatch && method === "POST") {
    try {
      await codeEngine.interrupt(interruptMatch[1]);
      sendJson(response, 200, {});
    } catch (error) {
      await fail(error);
    }
    return true;
  }

  // --- environments: the paired Desktop offered as a runner -------------------
  // Two records, both backed by the same self-hosted Desktop:
  //   * `anthropic_cloud` — the row the new-session picker needs in its "Cloud
  //     environments" section. Without it that section shows the onboarding
  //     empty state and a new session cannot be started.
  //   * `bridge` — the same Desktop as a paired device ("Remote control").
  // The list is newest-first by convention elsewhere, but order is not
  // significant here; `first_id`/`last_id` bracket whatever order is returned.
  // EXPERIMENT (wire casing). The Code REST decoder is assumed to run
  // `.convertFromSnakeCase` (docs/mobile-code-re-findings.md §"Wire casing"), so
  // these records use snake_case keys. A multi-word key that the decoder does
  // NOT convert (`environment_id`, `created_at`, `bridge_info`, …) throws the
  // same opaque `ModelDecodingError(kind: unexpected_schema)` as a genuinely
  // wrong value — and the error names neither. Setting
  // CLAUDE_MOBILE_ENVIRONMENT_WIRE_CASE=camel emits camelCase keys for every
  // environment leg instead; if the app then decodes, the field was never a
  // value at all, it was this leg's key strategy.
  function camelKeys(value) {
    if (Array.isArray(value)) return value.map(camelKeys);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = camelKeys(entry);
      }
      return out;
    }
    return value;
  }
  const ENVIRONMENT_WIRE_CASE = process.env.CLAUDE_MOBILE_ENVIRONMENT_WIRE_CASE || "snake";
  const wireEnvironment = (record) =>
    ENVIRONMENT_WIRE_CASE === "camel" ? camelKeys(record) : record;

  const environmentsBase =
    /^\/v1\/environment_providers\/private\/organizations\/([0-9a-f-]{36})\/environments\/?$/i;
  const environmentsMatch = path.match(environmentsBase);
  if (environmentsMatch && method === "GET") {
    const online = await desktopReady();
    const cliVersion = desktopVersion();
    // The base bridge record represents the paired *device* (its default
    // directory is the workspace root). Each workspace folder is additionally
    // advertised as its own bridge environment: a bridge environment is one
    // working directory on a machine (singular `directory` beside
    // `branch`/`git_repo_url`), and the app's remote folder picker's rows are
    // `Folder { id: CodeEnvironmentTag, name }` — a directory *is* an
    // environment. Same `machine_name`, so the app groups them under the one
    // device and lists them as that device's directories.
    // CLAUDE_MOBILE_ENVIRONMENT_FOLDERS=0 withholds them.
    const folderEnvironments = [];
    const foldersEnabled = (process.env.CLAUDE_MOBILE_ENVIRONMENT_FOLDERS ?? "1") !== "0";
    if (foldersEnabled) {
      const listing = await codeEngine.workspaceFolders();
      const folders = Array.isArray(listing?.folders) ? listing.folders : [];
      for (const folder of folders) {
        if (!folder || typeof folder.path !== "string" || !folder.path) continue;
        folderEnvironments.push(folderEnvironment({
          name: folder.name,
          directory: folder.path,
          online,
          cliVersion,
        }));
      }
      // Whether the folders reached the picker at all is the whole experiment:
      // `enabled` says the build has the feature, `listed` says the bridge
      // folder read worked, and the names are what the device's directories
      // should show.
      console.log(
        `[mobile-code]   environments folders enabled=${foldersEnabled}` +
        ` listed=${folders.length} -> ${folderEnvironments.map((e) => e.name).join(", ") || "(none)"}`,
      );
    } else {
      console.log("[mobile-code]   environments folders enabled=false (CLAUDE_MOBILE_ENVIRONMENT_FOLDERS=0)");
    }
    const environments = [
      cloudEnvironment({ online, cliVersion }),
      bridgeEnvironment({ online, cliVersion }),
      ...folderEnvironments,
    ];
    // The picker's cloud section stays empty on device even though this list is
    // answered and the app demonstrably receives both records (it resolves the
    // bridge out of it). Which side is dropping the cloud row is unsettled, so
    // the advertised set is selectable for a one-shot experiment: with
    // CLAUDE_MOBILE_ENVIRONMENT_MODE=cloud-only the bridge is withheld, which
    // tells apart "the picker auto-selects the bridge and never offers the cloud
    // row" from "cloud rows are suppressed outright". `cloud-only`/`bridge-only`
    // keep the folder environments on the bridge side.
    const mode = process.env.CLAUDE_MOBILE_ENVIRONMENT_MODE || "both";
    const advertised = mode === "cloud-only" ? environments.slice(0, 1)
      : mode === "bridge-only" ? [environments[1], ...folderEnvironments]
      : environments;
    // The app scopes this read to an organization id BOTH in the path and in the
    // `X-Organization-Uuid` header, and can narrow the result with
    // `included_worker_types`. If either the path org or the header org is not
    // the one the facade issues at `/api/organizations`, the app may drop rows
    // after decode while the HTTP leg still looks fine — which matches the empty
    // picker. Printed on every read so one picker open on device settles it.
    const pathOrg = environmentsMatch[1].toLowerCase();
    const headerOrg = String(request.headers["x-organization-uuid"] || "").toLowerCase();
    const orgMismatch = [
      pathOrg !== identity.orgUuid.toLowerCase() ? `path!=issued` : null,
      headerOrg && headerOrg !== identity.orgUuid.toLowerCase() ? `header!=issued` : null,
      headerOrg && headerOrg !== pathOrg ? `header!=path` : null,
    ].filter(Boolean);
    console.log(
      `[mobile-code]   environments(mode=${mode})` +
      ` issued_org=${identity.orgUuid.toLowerCase()}` +
      ` path_org=${pathOrg}` +
      ` header_org=${headerOrg || "-"}` +
      ` worker_types=${url.searchParams.get("included_worker_types") || "-"}` +
      ` query=${url.search || "-"}` +
      (orgMismatch.length ? ` MISMATCH=${orgMismatch.join(",")}` : ""),
    );
    console.log(`[mobile-code]   environments(mode=${mode})=${JSON.stringify(advertised).slice(0, 4000)}`);
    sendJson(response, 200, wireEnvironment({
      environments: advertised,
      has_more: false,
      first_id: advertised[0].environment_id,
      last_id: advertised[advertised.length - 1].environment_id,
    }));
    return true;
  }

  // Creating an environment. The picker's "Create environment" button does not
  // need a real upstream — the Desktop the facade runs against IS the
  // environment — so answer with the cloud record the list already advertises
  // rather than 404ing, which would leave the create sheet stuck. A caller that
  // names its own environment gets that name echoed back on the same record.
  if (environmentsBase.test(path) && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const online = await desktopReady();
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    sendJson(response, 201, wireEnvironment(cloudEnvironment({ online, cliVersion: desktopVersion(), ...(name ? { name } : {}) })));
    return true;
  }

  // The by-id read the detail screen makes to resolve the session's runner. It
  // asks for whichever id the session carries — the cloud or the bridge record
  // above — and gets that single resource back.
  const environmentByIdMatch = path.match(
    /^\/v1\/environment_providers\/private\/organizations\/[0-9a-f-]{36}\/environments\/([^/]+)$/i,
  );
  if (environmentByIdMatch && method === "GET") {
    const id = decodeURIComponent(environmentByIdMatch[1]);
    const online = await desktopReady();
    // Which ids the app asks for by id is the sharpest signal about the picker:
    // a row it decoded but dropped is never resolved back, while a row it
    // offered (or auto-selected) is. Logged so the advertised set can be
    // compared against what the app actually reaches for.
    const mode = process.env.CLAUDE_MOBILE_ENVIRONMENT_MODE || "both";
    console.log(`[mobile-code]   environments/by-id ${id} (mode=${mode})`);
    // In the cloud-only experiment mode the bridge record is withheld from the
    // list, yet the app still resolved this id — so the id it is asking for is
    // not coming from the list but from state the phone persisted itself. With
    // CLAUDE_MOBILE_EXPERIMENT_HIDE_BRIDGE_BY_ID=1 the facade also stops
    // answering it, which makes that stored selection unresolvable and tells
    // apart "the saved bridge id pins the picker" from "the cloud row is
    // suppressed regardless".
    const hideBridgeById = process.env.CLAUDE_MOBILE_EXPERIMENT_HIDE_BRIDGE_BY_ID === "1";
    if (id === BRIDGE_ENVIRONMENT_ID) {
      if (hideBridgeById) {
        sendErrorEnvelope(response, 404, "not_found_error", `unknown environment ${id}`);
        return true;
      }
      const record = bridgeEnvironment({ online, cliVersion: desktopVersion() });
      console.log(`[mobile-code]   environments/by-id ${id} -> ${JSON.stringify(record).slice(0, 4000)}`);
      sendJson(response, 200, wireEnvironment(record));
      return true;
    }
    if (id === CLOUD_ENVIRONMENT_ID) {
      const record = cloudEnvironment({ online, cliVersion: desktopVersion() });
      console.log(`[mobile-code]   environments/by-id ${id} -> ${JSON.stringify(record).slice(0, 4000)}`);
      sendJson(response, 200, wireEnvironment(record));
      return true;
    }
    // A folder environment (one per workspace folder). The path lives in the id,
    // so the record can be rebuilt without the folder listing.
    const folderDirectory = folderDirectoryFromEnvironmentId(id);
    if (folderDirectory) {
      const record = folderEnvironment({
        name: folderDirectory.replace(/\/+$/, "").split("/").pop(),
        directory: folderDirectory,
        online,
        cliVersion: desktopVersion(),
      });
      console.log(`[mobile-code]   environments/by-id ${id} -> folder ${folderDirectory}`);
      sendJson(response, 200, wireEnvironment(record));
      return true;
    }
    sendErrorEnvelope(response, 404, "not_found_error", `unknown environment ${id}`);
    return true;
  }

  // --- channels: the thread/composer surface ----------------------------------
  // Newer clients read and write a Code conversation as a claude.ai "channel" —
  // /v1/code/channels/{channelId}/… — where channelId is the same
  // code_<desktopId> the session carries (ChannelMessagesApi.swift is the
  // binary's only builder of these paths). The JSON reads answer empty pages;
  // the message stream must speak SSE, because a JSON envelope there is a body
  // the thread screen cannot decode. Every leg is logged: a channel leg the
  // phone reaches but the facade answers wrongly is exactly what the filtered
  // [mobile-code] log would otherwise hide.
  const channelByIdMatch = path.match(/^\/v1\/code\/channels\/([^/]+)$/);
  if (channelByIdMatch && method === "GET") {
    const id = decodeURIComponent(channelByIdMatch[1]);
    console.log(`[mobile-code]   channel by-id id=${id}`);
    sendJson(response, 200, channelResource(id));
    return true;
  }
  const channelSubMatch = path.match(/^\/v1\/code\/channels\/([^/]+)\/(.+)$/);
  if (channelSubMatch) {
    const id = decodeURIComponent(channelSubMatch[1]);
    const rest = channelSubMatch[2];
    console.log(`[mobile-code]   channel ${method} ${rest} id=${id}${url.search || ""}`);
    if (rest === "messages/stream") {
      if (method === "POST") await sendChannelMessage(request, response, url, id);
      else await streamChannelTimeline(request, response, url, id);
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, /^messages(\/|$)/.test(rest)
        ? await channelTimelinePage(id)
        : channelEmptyPage(rest));
      return true;
    }
    if (method === "POST") {
      await readJson(request).catch(() => ({}));
      sendJson(response, 200, {});
      return true;
    }
    return true;
  }
  if (path === "/v1/code/channels" && (method === "GET" || method === "POST")) {
    if (method === "POST") await readJson(request).catch(() => ({}));
    console.log(`[mobile-code]   channels collection ${method}`);
    sendJson(response, 200, { data: [], next_cursor: null });
    return true;
  }

  // --- out-of-scope legs: real, clean empty states ----------------------------
  // Routines, git/PR and self-hosted pools are a follow-up; an empty envelope
  // (not a 404) keeps those screens from erroring.
  if (/^\/v1\/code\/(triggers|webhook-triggers)(\/.*)?$/.test(path) && method === "GET") {
    sendJson(response, 200, { data: [], next_cursor: null });
    return true;
  }
  if (/^\/v1\/code\/runners\/self-hosted\/pools/.test(path) && method === "GET") {
    sendJson(response, 200, { data: [], next_cursor: null });
    return true;
  }
  if (path === "/v1/code/repos/resync" && method === "POST") {
    sendJson(response, 200, {});
    return true;
  }
  // The app reaches these with GET and POST alike (`get-batch-branch-status` is
  // a POST — it takes a list of refs in the body). Both answer the same empty
  // envelope: an absent PR/branch list is a real state, a 404 is an error.
  //
  // `has_more` is not decoration. `GithubBranchListResponse` is `data` plus
  // `hasMore`, both required (`lastId` and `defaultBranch` are optional), and
  // the page this handler used to send carried `next_cursor` instead — which
  // that type does not read. So every one of these routes failed to decode, and
  // a decode failure here is not an empty list: it is a thrown
  // `ModelDecodingError` naming the route, which is how session creation in the
  // --- repositories: the "Add repository" menu --------------------------------
  // The app will not start a session without a repository, and there is no
  // GitHub here, so each folder under the repos root is advertised as one.
  // `RepoListResponse` is `repos, sourceWarnings, ssoRequiredOrgIds, sources,
  // nextCursor, isComplete` and each `GitHubRepo` is `name, owner{login},
  // defaultBranch, sourceURL?, gheConfigurationId?` (snake_case on the wire).
  // A folder named like a repo is enough for the picker; the session ignores the
  // source and runs in the environment's cwd.
  const reposAllMatch = path.match(/^\/api\/organizations\/[0-9a-f-]{36}\/code\/repos\/all$/i);
  if (reposAllMatch && method === "GET") {
    // The workspace lives across the bridge, not in this container, so list it
    // there: `/api/remote/folders` with no path returns the workspace root as
    // `{ root, path, parent, folders: [{ name, path }], truncated }`.
    const listing = await codeEngine.workspaceFolders();
    const folders = Array.isArray(listing?.folders)
      ? listing.folders.filter((entry) => entry && typeof entry.name === "string")
      : [];
    // `repos` is `[RepoWithStatus]` — each element `{ repo, status }` — not a bare
    // `[GitHubRepo]`. The bare form fails the whole RepoListResponse, and the app
    // reports that only to Sentry while rendering "No repositories", so the
    // element type is not something to infer from the type's name. `sources` is
    // a different element type and the picker's rows come from `repos`, so it
    // stays empty; `status.appInstalled` is what makes a row offerable.
    //
    // `GitHubRepo.sourceURL` is the one field whose casing the decoder's
    // `.convertFromSnakeCase` does NOT round-trip: it turns `source_url` into
    // `sourceUrl`, which never matches the all-caps `sourceURL` CodingKey, so
    // the URL silently stayed nil and a picked repo had nothing to attach as its
    // session source. Send the camelCase key the property actually decodes from.
    // The URL itself is the github.com/<owner>/<name> the app rebuilds for a
    // session source, so the selection matches the catalog row.
    const repos = folders.map(({ name }) => {
      const sourceURL = `https://github.com/local/${name}`;
      return {
        repo: {
          name,
          owner: { login: "local" },
          default_branch: "main",
          sourceURL,
          ghe_configuration_id: null,
        },
        // `RepoWithStatus.sourceUrl` (lowercase, which round-trips fine) carries
        // the same URL so the row and the inner repo agree whichever field the
        // app reads when it builds the session's source.
        status: { workflow_enabled: true, app_installed: true },
        sourceUrl: sourceURL,
      };
    });
    console.log(`[mobile-code]   repos/all -> ${repos.length} repo(s): ${folders.map((entry) => entry.name).join(", ")}`);
    sendJson(response, 200, {
      repos,
      source_warnings: [],
      sso_required_org_ids: [],
      sources: [],
      next_cursor: null,
      is_complete: true,
    });
    return true;
  }

  // mobile Code tab was dying (`path` = `/v1/code/github/{id}`). Logged now,
  // because a github leg the phone reaches and this handler answers wrongly is
  // exactly what the silence here used to hide.
  if (path.startsWith("/v1/code/github/")) {
    if (method === "POST") await readJson(request).catch(() => ({}));
    console.log(`[mobile-code]   github ${method} ${path}`);
    sendJson(response, 200, githubEmptyBody(path));
    return true;
  }

  // One body that satisfies every response type behind the github family, so
  // that the route's own type does not have to be known to answer it. The
  // types are, from the image:
  //
  //   GithubBranchListResponse  data, hasMore                 (lastId, defaultBranch optional)
  //   GitHubRepo               name, owner{login}, defaultBranch
  //   GitHubPullRequestDetail  checks, reviewRequests
  //   GitHubServiceCompareResponse  baseBranch, headBranch, aheadBy, behindBy,
  //                                 totalCommits, files
  //   GitHubServiceFileResponse     content, encoding, size, sha
  //
  // Codable ignores keys it does not want, so one body decodes as all of them.
  // That matters because which one a given leg carries is inferred from field
  // names in the binary, not proven: a body shaped for the branch list alone is
  // a decode failure if the leg is in fact a repo read, and a `ModelDecodingError`
  // on this family is what the app reports when session creation dies — the
  // probe read that error's `path` as `/v1/code/github/{id}` from the app's own
  // throw site. Empty lists are real states here; the facade has no upstream
  // repo to describe.
  function githubEmptyBody(requestPath) {
    // The id the app asked about, so a repo read has a name to show rather than
    // an empty cell.
    const id = requestPath.split("/").filter(Boolean).pop() || "";
    return {
      data: [],
      has_more: false,
      next_cursor: null,
      name: id,
      owner: { login: "" },
      default_branch: "main",
      base_branch: "main",
      head_branch: "main",
      ahead_by: 0,
      behind_by: 0,
      total_commits: 0,
      files: [],
      content: "",
      encoding: "utf-8",
      size: 0,
      sha: "",
      checks: [],
      review_requests: [],
    };
  }
  if (path === "/v1/code/shared-sessions" && method === "GET") {
    sendJson(response, 200, { data: [], next_cursor: null });
    return true;
  }
  if (/^\/api\/claude_code\/organizations\/[0-9a-f-]{36}\//i.test(path) && method === "GET") {
    sendJson(response, 200, { data: [], next_cursor: null });
    return true;
  }
  return false;
}

// The bridge's own health decides whether the paired Desktop is offered as an
// online runner. A failure here is reported, not thrown: the list must still
// render.
async function desktopReady() {
  try {
    return await desktop.health();
  } catch {
    return false;
  }
}

function desktopVersion() {
  return process.env.CLAUDE_DESKTOP_VERSION || null;
}

// GET /v1/code/sessions[/{id}]/watch — SSE, one SessionWatchFrame per change.
// `sessionId` null watches every Code session (the list screen's subscription).
async function streamCodeWatch(request, response, url, sessionId) {
  const desktopId = sessionId ? codeSessionDesktopId(sessionId) : null;
  if (sessionId && !desktopId) {
    sendErrorEnvelope(response, 404, "not_found", "session not found");
    return;
  }
  response.writeHead(200, SSE_HEADERS);
  // Tell the client where to resume if it reconnects.
  const fromSequence = sessionId ? codeEngine.resumeFrom(desktopId) : 0;
  sendSseRecord(response, "hello", { from_sequence_num: fromSequence, session_id: sessionId });

  // A single-session watch filters to that session; the list screen's watch
  // (no id) takes every Code session's frames. The SSE `event:` names the case
  // and `data` carries that case's payload, NOT a `SessionWatchFrame` (which is
  // an internal, non-Decodable model). The two payloads are:
  //   upserted -> a whole `SessionResource`                       (bare object)
  //   deleted  -> `SessionWatchWire.Removed` = {"id":"<session>"} (object!)
  // The old code sent the bare session id STRING for `deleted`; decoded as
  // `Removed`, that is `typeMismatch(Dictionary<String, Any>, found string)` —
  // or `valueNotFound` when the id was null — which the classifier reports as
  // `ModelDecodingError(kind: unexpected_schema)`. A frame with no id cannot be
  // encoded at all, so it is dropped.
  const emit = (id, record) => {
    for (const frame of codeEngine.watchFramesFor(id, record)) {
      const payload = frame.event === "deleted"
        ? (frame.data == null ? null : { id: frame.data })
        : frame.data;
      if (payload == null) continue;
      sendSseRecord(response, frame.event, payload);
      console.log(`[mobile-code]   watch ${frame.event} ${id}`);
    }
  };
  const unsubscribe = desktopId
    ? codeEngine.listen(desktopId, (record) => emit(desktopId, record))
    : codeEngine.listenAll((record, id) => emit(id, record));

  const keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(": keepalive\n\n");
  }, 15000);
  const done = () => {
    clearInterval(keepalive);
    unsubscribe?.();
  };
  request.on("close", done);
  response.on("close", done);
}

// Both history and event: client_event carry SessionEventEnvelope. Sequence
// numbers are positive decimal strings; from_sequence_num is the last seen
// sequence (exclusive), with 0 meaning the beginning.
async function streamCodeEvents(request, response, url, sessionId) {
  const desktopId = codeSessionDesktopId(sessionId);
  if (!desktopId) {
    sendErrorEnvelope(response, 404, "not_found", "session not found");
    return;
  }
  const floor = Number(url.searchParams.get("from_sequence_num"));
  const from = Number.isSafeInteger(floor) && floor >= 0 ? floor : 0;
  let pending = [];
  const emit = (record) => {
    for (const frame of codeEngine.framesFor(desktopId, record)) {
      if (Number(frame.data.sequence_num) <= from) continue;
      sendSseRecord(response, frame.event, frame.data);
      console.log(`[mobile-code] live ${describeSdkMessage(frame.data)}`);
    }
  };
  // Subscribe before the asynchronous snapshot, buffering until history has
  // seeded the translator. Otherwise an event between read and listen is lost.
  const unsubscribe = codeEngine.listen(desktopId, (record) => {
    if (pending) pending.push(record);
    else emit(record);
  });
  let keepalive;
  let closed = false;
  const done = () => {
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
  };
  response.on("close", done);
  let envelopes;
  let connectionStatus;
  try {
    const { resource, loaded } = await codeEngine.getSession(sessionId);
    envelopes = loaded.envelopes;
    // StreamSessionUpdate uses the two-case ConnectionStatus, not the
    // four-case SessionConnectionStatus used by the session resource.
    connectionStatus = resource.connection_status === "connected" ? "connected" : "disconnected";
  } catch (error) {
    done();
    if (!response.destroyed) sendErrorEnvelope(response, error?.status || 502, error?.type || "api_error",
      error?.message || "could not read the transcript");
    return;
  }
  if (closed) return;
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders();
  // Always start the response body, even when from_sequence_num is already
  // at the history tail. This is a supported SessionStreamWire control frame;
  // it has no event ID/sequence and must not advance the transcript cursor.
  sendSseRecord(response, "session_update", { connection_status: connectionStatus });
  for (const envelope of envelopes) {
    if (Number(envelope.sequence_num) > from) sendSseRecord(response, "client_event", envelope);
  }
  // Buffered records may already be in the snapshot; do not replay them twice.
  const snapshot = new Map(envelopes.map((event) => [event.event_id, JSON.stringify(event)]));
  const buffered = pending;
  pending = null;
  for (const record of buffered) {
    for (const frame of codeEngine.framesFor(desktopId, record)) {
      if (Number(frame.data.sequence_num) <= from) continue;
      if (snapshot.get(frame.data.event_id) !== JSON.stringify(frame.data)) {
        sendSseRecord(response, frame.event, frame.data);
      }
    }
  }
  console.log(`[mobile-code] events/stream ${sessionId}: ${envelopes.length} events, after ${from}, initial session_update=${connectionStatus}`);
  keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(": keepalive\n\n");
  }, 15000);
}

// POST /v1/code/sessions/{id}/messages/stream — send a turn. This leg is also
// `SessionStreamWire`, so its body carries the same `client_event` frames as
// `events/stream`: the frames for the optimistic user message and then the
// assistant's reply, so a client that only listens here still draws the turn.
// It closes once the session goes idle, completing the composer's request.
async function streamCodeMessage(request, response, url, sessionId) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    sendErrorEnvelope(response, 400, "invalid_request", "expected a JSON body");
    return;
  }
  console.log(`[mobile-code]   send body=${JSON.stringify(body).slice(0, 1500)}`);
  const desktopId = codeSessionDesktopId(sessionId);
  if (!desktopId) {
    sendErrorEnvelope(response, 404, "not_found", "session not found");
    return;
  }
  const text = body?.body ?? body?.text ?? body?.message ?? "";
  if (!String(text).trim()) {
    sendErrorEnvelope(response, 400, "invalid_request", "message body is required");
    return;
  }
  response.writeHead(200, SSE_HEADERS);

  // Follow this session's live records for the duration of the turn, the same
  // frames `events/stream` would push — the send leg is just a second view of
  // the same stream.
  const emit = (record) => {
    for (const frame of codeEngine.framesFor(desktopId, record)) {
      sendSseRecord(response, frame.event, frame.data);
    }
  };
  const unsubscribe = codeEngine.listen(desktopId, emit);

  try {
    await codeEngine.sendMessage(sessionId, {
      text: String(text),
      clientMessageId: body?.client_message_id ?? null,
      interrupt: Boolean(body?.interrupt),
    });
  } catch (error) {
    unsubscribe?.();
    sendSseRecord(response, "error", { type: "error", error: { type: error.type || "api_error", message: error.message } });
    response.end();
    return;
  }

  // The reply arrives on the listener; close this leg once the session goes
  // idle so the composer's request completes.
  const keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(": keepalive\n\n");
  }, 15000);
  const finished = () => {
    clearInterval(keepalive);
    unsubscribe?.();
    if (!response.writableEnded) response.end();
  };
  request.on("close", () => { clearInterval(keepalive); unsubscribe?.(); });
  const abort = new AbortController();
  request.on("close", () => abort.abort());
  await codeEngine.awaitTurn(desktopId, { signal: abort.signal }).catch(() => null);
  finished();
}

// The channel id is the session id (code_<desktopId>); a bare Desktop id is
// tolerated too, so the leg answers whichever form the client built.
function codeChannelSessionId(id) {
  if (codeSessionDesktopId(id)) return id;
  return typeof id === "string" && id ? `code_${id}` : null;
}

// The timeline read: the same transcript the session leg serves, as
// ChannelTimelineResponse. An empty list is a valid page.
async function channelTimelinePage(channelId) {
  const sessionId = codeChannelSessionId(channelId);
  const desktopId = sessionId ? codeSessionDesktopId(sessionId) : null;
  if (!desktopId) return { data: [], next_cursor: null };
  try {
    const { loaded } = await codeEngine.getSession(sessionId);
    const data = loaded.envelopes
      .map((envelope) => channelMessageForEnvelope(envelope, { channelId: sessionId }))
      .filter(Boolean);
    return { data, next_cursor: null };
  } catch {
    return { data: [], next_cursor: null };
  }
}

// GET /v1/code/channels/{id}/messages/stream?scope=timeline|thread — the channel
// transcript as SSE. The client ignores channel event names it does not know, so
// every frame here is a message it does recognize (`channel_message_updated`).
async function streamChannelTimeline(request, response, url, channelId) {
  const sessionId = codeChannelSessionId(channelId);
  const desktopId = sessionId ? codeSessionDesktopId(sessionId) : null;
  if (!desktopId) {
    sendErrorEnvelope(response, 404, "not_found", "channel not found");
    return;
  }
  let envelopes = [];
  try {
    envelopes = (await codeEngine.getSession(sessionId)).loaded.envelopes;
  } catch (error) {
    sendErrorEnvelope(response, error?.status || 502, error?.type || "api_error",
      error?.message || "could not read the transcript");
    return;
  }
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders();
  for (const envelope of envelopes) {
    const message = channelMessageForEnvelope(envelope, { channelId: sessionId });
    if (message) sendSseRecord(response, CHANNEL_MESSAGE_EVENT, message);
  }
  const emit = (record) => {
    for (const frame of codeEngine.framesFor(desktopId, record)) {
      const message = channelMessageForEnvelope(frame.data, { channelId: sessionId });
      if (message) sendSseRecord(response, CHANNEL_MESSAGE_EVENT, message);
    }
  };
  const unsubscribe = codeEngine.listen(desktopId, emit);
  const keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(": keepalive\n\n");
  }, 15000);
  const done = () => {
    clearInterval(keepalive);
    unsubscribe?.();
  };
  request.on("close", done);
  response.on("close", done);
  console.log(`[mobile-code] channel timeline ${sessionId}: ${envelopes.length} events`);
}

// POST /v1/code/channels/{id}/messages/stream — send a turn. Despite the path,
// this leg is NOT a stream: the app decodes the response body as
// `SendChannelMessageResponse` ({messageId?, threadRootId?, createdAt?} — all
// optional; the binary's `MockSessionsApi.sendChannelMessageHandler` returns
// exactly that). Answering with `text/event-stream` made the app try to
// JSON-decode SSE text and surface `ClaudeApiServices.ModelDecodingError` on
// every send. The turn's messages are delivered on the GET timeline
// subscription (`channel_message_updated`), which the composer already holds
// open, so this response only acknowledges the send.
async function sendChannelMessage(request, response, url, channelId) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    sendErrorEnvelope(response, 400, "invalid_request", "expected a JSON body");
    return;
  }
  console.log(`[mobile-code]   channel send body=${JSON.stringify(body).slice(0, 1500)}`);
  const sessionId = codeChannelSessionId(channelId);
  const desktopId = sessionId ? codeSessionDesktopId(sessionId) : null;
  if (!desktopId) {
    sendErrorEnvelope(response, 404, "not_found", "channel not found");
    return;
  }
  const text = body?.body ?? body?.text ?? body?.message ?? "";
  if (!String(text).trim()) {
    sendErrorEnvelope(response, 400, "invalid_request", "message body is required");
    return;
  }
  // Resolves once the Desktop has taken the turn; the reply then flows over the
  // timeline stream. Only the send itself can fail here.
  try {
    await codeEngine.sendMessage(sessionId, {
      text: String(text),
      clientMessageId: body?.client_message_id ?? null,
      interrupt: Boolean(body?.interrupt),
    });
  } catch (error) {
    sendErrorEnvelope(response, 502, error.type || "api_error", error.message);
    return;
  }
  sendJson(response, 200, {
    message_id: null,
    thread_root_id: null,
    created_at: new Date().toISOString(),
  });
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

  const selector = rest.match(/^model_selector_state\/([A-Za-z0-9_-]+)$/);
  if (selector) {
    const surface = selector[1].toLowerCase();
    const fallbackModel = await engine.defaultModel().catch(() => "");
    if (request.method === "GET") {
      sendJson(response, 200, await surfaceSelectorState(surface, fallbackModel));
      return true;
    }
    if (["PUT", "POST", "PATCH"].includes(request.method)) {
      const body = await readJson(request).catch(() => ({}));
      await saveSurfaceSelection(surface, body);
      sendJson(response, 200, await surfaceSelectorState(surface, fallbackModel));
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
  let body = await readJson(request, 72 * 1024 * 1024);
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
  if (!body.effort && !body.thinking_mode) {
    const saved = await store.readJsonFile("model-selection.json", null);
    const pick = cleanThinking(saved?.thinking_by_model?.[body.model || conversation.model]);
    if (pick) body = { ...body, effort: pick.effort, thinking_mode: pick.mode };
  }
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
    await logUnmatched(request, url, "connect");
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
  if (await handleCodeRoutes(request, response, url)) return;
  if (await handleOptionalEmptyRoutes(request, response, url)) return;
  if (await handleFileDownload(request, response, url)) return;
  if (await handleConversationRoutes(request, response, url)) return;

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = session;
    await store.destroySession(token);
    sendJson(response, 200, {}, { "Set-Cookie": auth.clearSessionCookie() });
    return;
  }

  await logUnmatched(request, url, "rest");
  await captureUnhandled(request, url, "rest");
  sendErrorEnvelope(response, 404, "not_found", `unknown API route ${url.pathname}`);
}

// Every route this service does not implement is logged with its body, always,
// not only under CLAUDE_MOBILE_CAPTURE: the phone shows one opaque "Something
// went wrong" for any 404, so this line is the only evidence of which leg the
// app hit. Only the head of the body is kept — enough to name the request.
async function logUnmatched(request, url, surface) {
  let body = "";
  // When capture is on it reads the body itself (and redacts it), so this must
  // not read it first — a request stream can only be drained once, and a second
  // reader would simply never see `end`. A request whose body some earlier
  // layer already consumed is left with no body here rather than waiting on a
  // stream that will not fire again.
  const readable = !request.readableEnded && !request.destroyed
    && request.method !== "GET" && request.method !== "HEAD";
  if (!capture.enabled && readable) {
    body = await Promise.race([
      readJson(request).then(
        (value) => ` body=${JSON.stringify(value).slice(0, 1000)}`,
        () => " body=<unreadable>",
      ),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(""), 2000); timer.unref?.(); }),
    ]).catch(() => "");
  }
  const line = `unmatched(${surface}) ${request.method} ${url.pathname}${url.search || ""}${body}`;
  console.log(`[mobile-api] ${line}`);
  // A filtered `[mobile-code]` log is how the failing leg is usually read, and
  // an unmatched leg never carries that tag — so a code-surface request the
  // facade does not serve would be invisible in exactly the view that exists to
  // show it. Mirror those here, once, under the tag people are already grepping.
  if (url.pathname.startsWith("/v1/code/") || url.pathname.includes("/environments")) {
    console.log(`[mobile-code] ${line}`);
  }
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

// The on-device Frida probe (tools/frida/) reports here. It runs inside the
// phone's process with no signed-in session to present, so it authenticates with
// the shared secret in CLAUDE_MOBILE_FRIDA_TOKEN instead of the normal cookie —
// and the route does not exist at all unless that variable is set, so an
// internet-facing deployment exposes nothing by default. Findings are logged
// verbatim under [mobile-frida]; they are diagnostics, not API responses.
async function handleFridaDiag(request, response) {
  const expected = process.env.CLAUDE_MOBILE_FRIDA_TOKEN;
  const provided = String(request.headers["x-claudesk-diag"] || "");
  const ok = expected
    ? provided.length === expected.length
      && timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    : false;
  if (!ok) {
    sendErrorEnvelope(response, 404, "not_found", "unknown route");
    return;
  }
  const body = await readJson(request).catch(() => ({}));
  const { kind, seq, payload } = body || {};
  console.log(`[mobile-frida] #${seq ?? "?"} ${kind ?? "?"} ${JSON.stringify(payload).slice(0, 20000)}`);
  sendJson(response, 200, {});
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
  // Every request, unconditionally. The failing leg is often one the facade
  // answers without its own [mobile-code] line, so this makes the sequence
  // around a tap complete instead of a filtered view that may drop it.
  console.log(`[mobile-req] ${request.method} ${url.pathname}${url.search || ""}`);
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
    // The instrumented-build probe cannot hold a session cookie; it presents a
    // shared token and lands here, ahead of the /v1 session gate.
    if (url.pathname === "/__diag") {
      await handleFridaDiag(request, response);
      return;
    }
    // The Code tab's session and environment legs live under /v1/, not /api/.
    // Those still need a signed-in session, so authenticate before dispatch.
    if (url.pathname.startsWith("/v1/")) {
      if (!(await currentSession(request))) {
        sendErrorEnvelope(response, 401, "authentication_error", "sign in required");
        return;
      }
      if (await handleCodeRoutes(request, response, url)) return;
      await logUnmatched(request, url, "rest");
      await captureUnhandled(request, url, "rest");
      sendErrorEnvelope(response, 404, "not_found", `unknown API route ${url.pathname}`);
      return;
    }
    await logUnmatched(request, url, "rest");
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
