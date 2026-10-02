// A small in-memory stand-in for the Claudesk bridge, speaking the subset the
// mobile facade uses: /api/remote/ipc (LocalAgentModeSessions), /api/events
// (Server-Sent Events carrying `desktop-ipc` records), /api/remote/files/upload
// and the bootstrap model list. Transcript entries and stream events follow the
// shapes recorded from a live bridge (scripts/fixtures/desktop-chat-probe.json).
//
// Text in a prompt steers the fake: "[tool]" adds a tool round, "[slow]" streams
// slowly so a stop request can land mid-turn.
import http from "node:http";
import { randomUUID } from "node:crypto";

const sentinel = "__claudeRemoteUndefinedV1";
const decode = (value) => {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value[sentinel]) return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeClaudesk() {
  const sessions = new Map();
  const uploads = [];
  const calls = [];
  const clients = new Set();
  const state = { down: false, chunkDelayMs: 5 };

  const models = [
    { id: "stub-sonnet", name: "Stub Sonnet", description: "stub" },
    { id: "stub-haiku", name: "Stub Haiku", description: "stub" },
  ];

  function summary(session) {
    const { transcript, stopRequested, ...rest } = session;
    return rest;
  }

  function broadcast(payload) {
    const data = JSON.stringify({ surface: "LocalAgentModeSessions", method: "onOnEvent", payload });
    for (const response of clients) response.write(`event: desktop-ipc\ndata: ${data}\n\n`);
  }

  function entryText(entry) {
    const content = entry.message?.content;
    return typeof content === "string"
      ? content
      : (content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }

  function addSession({ sessionId, sessionType = "chat", title, model = "stub-sonnet", initialMessage = "" }) {
    const now = Date.now();
    const session = {
      sessionId,
      sessionType,
      title,
      model,
      isArchived: false,
      isRunning: false,
      createdAt: now,
      lastActivityAt: now,
      initialMessage,
      transcript: [],
      stopRequested: false,
    };
    sessions.set(sessionId, session);
    return session;
  }

  function push(session, entry) {
    const parentUuid = session.transcript.at(-1)?.uuid ?? null;
    const full = { parentUuid, isSidechain: false, timestamp: new Date().toISOString(), uuid: randomUUID(), ...entry };
    session.transcript.push(full);
    session.lastActivityAt = Date.now();
    return full;
  }

  async function runTurn(session, { text, messageUuid, images = [] }) {
    session.isRunning = true;
    session.stopRequested = false;
    const content = images.length
      ? [
        ...images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: image.base64 },
        })),
        { type: "text", text },
      ]
      : text;
    push(session, {
      uuid: messageUuid,
      type: "user",
      message: { role: "user", content },
      origin: { kind: "human" },
      turnOrigin: "human",
    });
    const base = { type: "message", sessionId: session.sessionId, userMessageUuid: messageUuid };
    const stream = (event) => broadcast({ ...base, message: { type: "stream_event", event, uuid: randomUUID() } });
    const answer = text.replace(/@"[^"\n]+"\n?/g, "").replace(/\[(tool|slow)\]/g, "").trim();
    const reply = `Echo: ${answer}`;
    const slow = /\[slow\]/.test(text);
    const chunks = slow
      ? Array.from({ length: 30 }, (_, index) => `part${index} `)
      : [reply.slice(0, Math.ceil(reply.length / 2)), reply.slice(Math.ceil(reply.length / 2))];
    const delay = slow ? 100 : state.chunkDelayMs;

    await sleep(delay);
    if (/\[tool\]/.test(text)) {
      stream({ type: "message_start", message: { id: "msg_tool", role: "assistant", model: session.model, content: [] } });
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should look." } });
      stream({ type: "content_block_stop", index: 0 });
      stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } });
      stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/x"}' } });
      stream({ type: "content_block_stop", index: 1 });
      stream({ type: "message_delta", delta: { stop_reason: "tool_use" } });
      stream({ type: "message_stop" });
      push(session, { type: "assistant", message: { id: "msg_tool", role: "assistant", content: [{ type: "thinking", thinking: "I should look.", signature: "s" }], stop_reason: "tool_use" } });
      push(session, { type: "assistant", message: { id: "msg_tool", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }], stop_reason: "tool_use" } });
      push(session, { type: "user", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] } });
      broadcast({ ...base, message: { type: "user" } });
    }
    stream({ type: "message_start", message: { id: "msg_text", role: "assistant", model: session.model, content: [] } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    let streamed = "";
    for (const chunk of chunks) {
      if (session.stopRequested) break;
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } });
      streamed += chunk;
      await sleep(delay);
    }
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    stream({ type: "message_stop" });
    push(session, { type: "assistant", message: { id: "msg_text", role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }], stop_reason: "end_turn" } });
    push(session, { type: "assistant", message: { id: "msg_text", role: "assistant", content: [{ type: "text", text: streamed }], stop_reason: "end_turn" } });
    session.isRunning = false;
    broadcast({ ...base, message: { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" } });
  }

  const handlers = {
    getAll: () => [...sessions.values()].map(summary),
    getSession: ([id]) => (sessions.has(id) ? summary(sessions.get(id)) : undefined),
    getTranscript: ([id]) => sessions.get(id)?.transcript ?? [],
    start: ([info]) => {
      if (info.sessionType !== "chat") throw new Error("fake bridge only starts chat sessions");
      const session = addSession({
        sessionId: info.sessionId,
        title: info.title,
        model: info.model,
        initialMessage: info.message,
      });
      void runTurn(session, { text: info.message, messageUuid: info.messageUuid, images: info.images || [] });
      return { sessionId: info.sessionId };
    },
    sendMessage: ([id, message, images, , messageUuid]) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      void runTurn(session, { text: message, messageUuid, images: images || [] });
      return { dispatched: true };
    },
    rewind: ([id, targetUuid]) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      const index = session.transcript.findIndex((entry) => entry.uuid === targetUuid);
      if (index < 0) throw new Error("message not found");
      const removed = entryText(session.transcript[index]);
      session.transcript.length = index;
      return removed;
    },
    stop: ([id]) => {
      const session = sessions.get(id);
      if (session) session.stopRequested = true;
    },
    delete: ([id]) => { sessions.delete(id); },
    updateSession: ([id, options]) => {
      const session = sessions.get(id);
      if (session && options?.title) session.title = options.title;
    },
    setModel: ([id, model]) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.model = model;
    },
    archive: ([id]) => {
      const session = sessions.get(id);
      if (session) session.isArchived = true;
    },
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (state.down) return json(503, { ok: false, error: "bridge unavailable" });

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(": connected\n\n");
      response.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return undefined;
    }
    if (request.method === "GET" && /^\/edge-api\/bootstrap\/[^/]+\/app_start$/.test(url.pathname)) {
      return json(200, {
        model_selector_config: [{ id: "chat", models }, { id: "cowork", models }],
        model_selector_state: [{ id: "chat", model: "stub-sonnet" }],
      });
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (request.method === "POST" && url.pathname === "/api/remote/files/upload") {
      calls.push({ route: "upload", names: parsed.files.map((file) => file.relativePath) });
      const root = `/workspace/RemoteUploads/${randomUUID()}`;
      const paths = parsed.files.map((file) => {
        uploads.push({ path: `${root}/${file.relativePath}`, bytes: Buffer.from(file.dataBase64, "base64") });
        return `${root}/${file.relativePath}`;
      });
      return json(200, { ok: true, value: { paths, root } });
    }
    if (request.method === "POST" && url.pathname === "/api/remote/ipc") {
      const args = decode(parsed.args) ?? [];
      calls.push({ route: "ipc", surface: parsed.surface, method: parsed.method, args });
      const handler = parsed.surface === "LocalAgentModeSessions" ? handlers[parsed.method] : undefined;
      if (!handler) return json(400, { ok: false, error: `${parsed.surface}.${parsed.method} is not allowed` });
      try {
        return json(200, { ok: true, value: await handler(args) });
      } catch (error) {
        return json(500, { ok: false, error: error.message });
      }
    }
    return json(404, { ok: false, error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sessions,
    uploads,
    calls,
    state,
    models,
    addSession,
    ipcCalls: (method) => calls.filter((call) => call.route === "ipc" && call.method === method),
    resetCalls: () => { calls.length = 0; },
    async close() {
      state.down = true; // refuse the facade's reconnects while shutting down
      for (const response of clients) response.end();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
