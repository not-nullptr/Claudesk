// Server-to-server client for the Claudesk bridge (bridge/server.mjs). The
// bridge is the only supported way to reach Claude Desktop's session manager:
// it validates every IPC call against an allowlist, so this client never talks
// to Desktop directly. The same Desktop sessions back the Claudesk web UI, so
// anything created here shows up there and vice versa.

const undefinedSentinelKey = "__claudeRemoteUndefinedV1";
// Desktop validates IPC arguments positionally; the bridge decodes this
// sentinel back to `undefined` (see encodeIpcValue in bridge/server.mjs).
export function encodeIpcValue(value) {
  if (value === undefined) return { [undefinedSentinelKey]: true };
  if (Array.isArray(value)) return value.map(encodeIpcValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]),
    );
  }
  return value;
}

export class DesktopError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// The bootstrap route only needs a syntactically valid organization id.
const bootstrapOrg = "00000000-0000-4000-8000-000000000000";

function parseSseRecord(record) {
  let event = "message";
  let id = null;
  const data = [];
  for (const line of record.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    parsed = data.join("\n");
  }
  return { event, id, data: parsed };
}

export function createDesktopClient({
  baseUrl = process.env.CLAUDE_MOBILE_DESKTOP_URL || "http://claude-desktop:8080",
  fetchImpl = globalThis.fetch,
  log = console,
} = {}) {
  const root = baseUrl.replace(/\/$/, "");

  async function request(path, { method = "GET", body, timeoutMs = 60000, signal } = {}) {
    // AbortSignal.any needs Node 20; combine the caller's signal and a timeout by hand.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    let response;
    let payload;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      throw new DesktopError(`Claudesk bridge unreachable: ${error.message}`, 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
    if (!response.ok || payload?.ok === false) {
      throw new DesktopError(
        payload?.error || `Claudesk bridge returned HTTP ${response.status}`,
        response.status >= 400 ? response.status : 502,
      );
    }
    return payload;
  }

  // Calls a Desktop IPC method through the bridge allowlist.
  async function ipc(surface, method, args = [], options) {
    const payload = await request("/api/remote/ipc", {
      method: "POST",
      body: {
        surface,
        method,
        args: encodeIpcValue(args),
        argsEncoding: "json-undefined-v1",
      },
      ...options,
    });
    return payload.value;
  }

  // Uploads bytes under /workspace/RemoteUploads and returns the server paths
  // (same order as the input).
  async function upload(files) {
    const payload = await request("/api/remote/files/upload", {
      method: "POST",
      body: {
        files: files.map((file) => ({
          relativePath: file.name,
          dataBase64: Buffer.from(file.data).toString("base64"),
        })),
      },
      timeoutMs: 120000,
    });
    return payload.value;
  }

  // Chat models exactly as the web UI offers them (Desktop's own model
  // selector), plus the surface default.
  async function chatModels() {
    const response = await fetchImpl(`${root}/edge-api/bootstrap/${bootstrapOrg}/app_start`, {
      signal: AbortSignal.timeout(30000),
    }).catch((error) => {
      throw new DesktopError(`Claudesk bridge unreachable: ${error.message}`, 503);
    });
    if (!response.ok) throw new DesktopError(`bootstrap returned HTTP ${response.status}`, 502);
    const bootstrap = await response.json();
    const surfaces = Array.isArray(bootstrap?.model_selector_config) ? bootstrap.model_selector_config : [];
    const surface = surfaces.find((item) => item?.id === "chat") || surfaces[0];
    const models = (surface?.models || [])
      .filter((model) => model && typeof model.id === "string")
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        description: model.description || "",
        // Effort levels and thinking modes the model offers (the web UI builds its
        // effort picker from this); absent for models that cannot reason.
        thinking: model.thinking && typeof model.thinking === "object" ? model.thinking : undefined,
        supports1mContext: model.supports_1m_context === true,
      }));
    const state = (bootstrap?.model_selector_state || []).find((item) => item?.id === "chat");
    const defaultModel = models.find((model) => model.id === state?.model)?.id || models[0]?.id || null;
    return { models, defaultModel };
  }

  // Follows GET /api/events (Server-Sent Events) and reconnects with backoff.
  // `onEvent({event, id, data})` receives every record; `onReconnect` fires
  // after a gap so the consumer can reconcile from the transcript.
  function subscribe({ mode = "chat", sessionId, onEvent, onReconnect = () => {} }) {
    const controller = new AbortController();
    let closed = false;

    async function run() {
      let delay = 500;
      let first = true;
      while (!closed) {
        try {
          const query = new URLSearchParams({ mode });
          if (sessionId) query.set("sessionId", sessionId);
          const response = await fetchImpl(`${root}/api/events?${query}`, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          if (!first) onReconnect();
          first = false;
          delay = 500;
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const record = parseSseRecord(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              if (record) onEvent(record);
            }
          }
        } catch (error) {
          if (closed) return;
          log.error(`[mobile-desktop] event stream interrupted: ${error.message}`);
        }
        if (closed) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5000);
        first = false;
      }
    }

    void run();
    return {
      close() {
        closed = true;
        controller.abort();
      },
    };
  }

  return { ipc, upload, chatModels, subscribe, baseUrl: root };
}
