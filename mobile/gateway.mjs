import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// The inference settings come from the applied Claude Desktop 3P configuration
// or the managed settings file, never from bridge environment variables. Both
// files are mounted read only, so edits made through the official Gateway
// editor are picked up within the cache window without a restart.
// CLAUDE_MOBILE_GATEWAY_BASE_URL and friends exist only for offline smoke
// tests where the managed configuration does not exist.

const configLibraryDir = "/config/.config/Claude-3p/configLibrary";
const managedSettingsFile = "/etc/claude-desktop/managed-settings.json";
const configTtlMs = Number(process.env.CLAUDE_MOBILE_CONFIG_TTL_MS || 20000);
const modelsTtlMs = Number(process.env.CLAUDE_MOBILE_MODELS_TTL_MS || 300000);
const maxModelEntries = 200;

let cachedConfig = null;
let cachedConfigAt = 0;
let cachedModels = null;
let cachedModelsAt = 0;

function overrideConfig() {
  const baseUrl = process.env.CLAUDE_MOBILE_GATEWAY_BASE_URL || "";
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey: process.env.CLAUDE_MOBILE_GATEWAY_API_KEY || "",
    authScheme: process.env.CLAUDE_MOBILE_GATEWAY_AUTH_SCHEME === "bearer"
      ? "bearer"
      : "x-api-key",
    configuredModels: [],
    source: "smoke-override",
  };
}

async function readJsonIfPresent(filePath) {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    console.error(`[mobile-gateway] cannot read config ${filePath}: ${error.message}`);
    return null;
  }
}

// Display labels: the 3P config's labelOverride wins over the gateway's own
// display_name; callers fall back to the model id.
const modelLabels = new Map();
// Only the 3P config's labelOverride, which Desktop also puts in the model
// identity text of its system prompt; gateway display names are not included.
const configLabels = new Map();

export function modelLabel(id) {
  return modelLabels.get(id) || "";
}

export function configModelLabel(id) {
  return configLabels.get(id) || "";
}

function rememberConfigLabels(models) {
  if (!Array.isArray(models)) return;
  for (const model of models) {
    if (model && typeof model === "object" && typeof model.name === "string"
      && typeof model.labelOverride === "string" && model.labelOverride) {
      modelLabels.set(model.name, model.labelOverride);
      configLabels.set(model.name, model.labelOverride);
    }
  }
}

function configListToNames(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => typeof model === "string"
      ? model
      : typeof model?.name === "string" ? model.name : "")
    .filter(Boolean);
}

export async function getGatewayConfig() {
  const override = overrideConfig();
  if (override) return override;

  const now = Date.now();
  if (cachedConfig && now - cachedConfigAt < configTtlMs) return cachedConfig;

  let config = null;
  const meta = await readJsonIfPresent(join(configLibraryDir, "_meta.json"));
  const appliedId = typeof meta?.appliedId === "string" ? meta.appliedId : "";
  if (/^[0-9a-f-]{36}$/i.test(appliedId)) {
    config = await readJsonIfPresent(join(configLibraryDir, `${appliedId}.json`));
  }
  if (!config) {
    config = await readJsonIfPresent(managedSettingsFile);
  }
  const baseUrl = config?.inferenceProvider === "gateway"
    ? config?.inferenceGatewayBaseUrl
    : undefined;
  const apiKey = config?.inferenceGatewayApiKey;
  if (typeof baseUrl !== "string" || !baseUrl
    || typeof apiKey !== "string" || !apiKey) {
    throw new ApiConfigError(
      "the applied Desktop 3P configuration does not define an inference gateway",
    );
  }
  rememberConfigLabels(config?.inferenceModels);
  cachedConfig = {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    authScheme: config?.inferenceGatewayAuthScheme === "bearer" ? "bearer" : "x-api-key",
    configuredModels: configListToNames(config?.inferenceModels),
    source: "applied-3p-config",
  };
  cachedConfigAt = now;
  return cachedConfig;
}

export class ApiConfigError extends Error {}

function authHeaders(config) {
  const headers = {};
  if (config.authScheme === "bearer") {
    headers.authorization = `Bearer ${config.apiKey}`;
  } else {
    headers["x-api-key"] = config.apiKey;
  }
  return headers;
}

export async function listGatewayModels() {
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < modelsTtlMs) return cachedModels;
  const config = await getGatewayConfig();
  try {
    const response = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { ...authHeaders(config), accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) {
      const body = await response.json();
      for (const model of Array.isArray(body?.data) ? body.data : []) {
        if (typeof model?.id === "string" && typeof model?.display_name === "string"
          && model.display_name && !modelLabels.has(model.id)) {
          modelLabels.set(model.id, model.display_name);
        }
      }
      const ids = (Array.isArray(body?.data) ? body.data : [])
        .map((model) => typeof model?.id === "string" ? model.id : "")
        .filter(Boolean);
      if (!ids.length) throw new Error("model list is empty");
      cachedModels = ids;
      cachedModelsAt = now;
      return ids;
    }
    console.error(`[mobile-gateway] /v1/models returned ${response.status}; using configured models`);
  } catch (error) {
    console.error(`[mobile-gateway] /v1/models unavailable: ${error.message}; using configured models`);
  }
  if (Array.isArray(cachedModels) && cachedModels.length) return cachedModels;
  if (config.configuredModels.length) {
    return Math.min(config.configuredModels.length, 120)
      ? config.configuredModels.slice(0, 120)
      : config.configuredModels;
  }
  throw new ApiConfigError("no inference models are available from the gateway or the 3P config");
}

function describeGatewayFailure(status) {
  if (status === 429) return "rate_limit_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function upstreamMessages(messages) {
  // The upstream gateway speaks the Anthropic Messages API: one body per
  // content part, plain strings for the common text case.
  return messages.map(({ role, content }) => {
    if (typeof content === "string") return { role, content };
    if (Array.isArray(content) && content.every((part) => part?.type === "text")) {
      return { role, content: content.map((part) => part.text).join("\n") };
    }
    return { role, content };
  });
}

// Starts POST /v1/messages against the applied gateway and returns the
// upstream Response. The body is an Anthropic SSE stream; callers translate
// it event by event. Non-2xx responses are shaped into an upstream error so
// REST and streaming callers can surface a matching status to the client.
export async function startUpstreamCompletion({ model, messages, system, maxTokens, signal }) {
  const config = await getGatewayConfig();
  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "accept": "text/event-stream",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      ...(typeof system === "string" && system ? { system } : {}),
      messages: upstreamMessages(messages),
    }),
    signal: signal ?? AbortSignal.timeout(600000),
  });
  if (!response.ok) {
    let detail = `gateway returned ${response.status}`;
    try {
      const body = await response.json();
      detail = body?.error?.message || detail;
    } catch {
      // Keep the synthetic description for non-JSON error bodies.
    }
    const error = new Error(detail);
    error.upstreamStatus = response.status;
    error.upstreamType = describeGatewayFailure(response.status);
    throw error;
  }
  return response;
}

// Parses an Anthropic SSE stream into structured events. Reconnect or
// multi-message streams are out of scope: one request yields exactly one
// assistant turn.
export async function* readUpstreamEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = rawEvent.split("\n");
      let eventName = "";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        else if (line.trim().length) throw new Error(`unsupported SSE line: ${line.slice(0, 40)}`);
      }
      if (!eventName || !dataLines.length) continue;
      try {
        yield { event: eventName, data: JSON.parse(dataLines.join("\n")) };
      } catch {
        console.error("[mobile-gateway] dropping malformed upstream SSE event");
      }
    }
  }
}
