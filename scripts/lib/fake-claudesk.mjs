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
  const state = { down: false, chunkDelayMs: 5, titleDelayMs: 0, titleResult: undefined };

  const models = [
    {
      id: "stub-sonnet",
      name: "Stub Sonnet",
      description: "stub",
      // Same shape Desktop's model selector returns for a reasoning model.
      thinking: {
        type: "effort_and_mode",
        effort_options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, name: id })),
        mode_options: [{ id: "auto", name: "Thinking" }, { id: "off", name: "Off" }],
      },
    },
    { id: "stub-haiku", name: "Stub Haiku", description: "stub" },
  ];

  function summary(session) {
    const { transcript, stopRequested, ...rest } = session;
    return rest;
  }

  // The real bridge relays every Desktop record on every SSE connection
  // regardless of the subscriber's mode, so the surface is what a consumer
  // filters on — broadcast must be able to say which one it is.
  function broadcast(payload, { surface = "LocalAgentModeSessions", method = "onOnEvent" } = {}) {
    const data = JSON.stringify({ surface, method, payload });
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
      broadcast({
        ...base,
        message: {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] },
        },
      });
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

  // ---------- Claude Code (LocalSessions) ----------
  //
  // A Code session's first message creates it (Desktop's `start`), and every
  // transcript entry is broadcast as an `onOnEvent` record — the same
  // events-are-the-transcript model the real surface has. Text steers it:
  // "[tool]" runs a Bash tool round, "[permission]" asks for approval first.
  const codeSessions = new Map();

  function addCodeSession({ sessionId = randomUUID(), title = "Untitled", model = "stub-sonnet" } = {}) {
    const now = Date.now();
    const session = { sessionId, sessionType: "code", title, model, isArchived: false, isRunning: false, createdAt: now, lastActivityAt: now, transcript: [] };
    codeSessions.set(sessionId, session);
    return session;
  }

  function pushCodeEntry(session, entry) {
    const parentUuid = session.transcript.at(-1)?.uuid ?? null;
    const full = { parentUuid, isSidechain: false, timestamp: new Date().toISOString(), uuid: randomUUID(), sessionId: session.sessionId, ...entry };
    session.transcript.push(full);
    session.lastActivityAt = Date.now();
    broadcast(full, { surface: "LocalSessions" });
    return full;
  }

  async function runCodeTurn(session, { text, messageUuid, permission = false }) {
    session.isRunning = true;
    pushCodeEntry(session, {
      uuid: messageUuid,
      type: "user",
      message: { role: "user", content: text },
      origin: { kind: "human" },
      turnOrigin: "human",
    });
    const answer = text.replace(/\n?"[^"\n]+"/g, "").replace(/\[(tool|permission|slow)\]/g, "").trim();
    await sleep(state.chunkDelayMs);
    if (permission) {
      // Desktop asks, and the turn does not continue until it is answered.
      const requestId = `req_${randomUUID()}`;
      codeRequests.set(requestId, { sessionId: session.sessionId, toolName: "Bash", input: { command: "ls" } });
      session.isRunning = false;
      broadcast(
        { sessionId: session.sessionId, requestId, toolName: "Bash", input: { command: "ls" } },
        { surface: "LocalSessions", method: "onOnToolPermissionRequest" },
      );
      return;
    }
    if (/\[tool\]/.test(text)) {
      pushCodeEntry(session, { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "I should look.", signature: "s" }], stop_reason: "tool_use" } });
      pushCodeEntry(session, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_code_1", name: "mcp__workspace__bash", input: { command: "ls" } }], stop_reason: "tool_use" } });
      pushCodeEntry(session, { type: "user", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_code_1", content: "a.txt\nb.txt" }] } });
    }
    pushCodeEntry(session, { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }], stop_reason: "end_turn" } });
    pushCodeEntry(session, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Echo: ${answer}` }], stop_reason: "end_turn" } });
    session.isRunning = false;
  }

  const codeRequests = new Map();

  const codeHandlers = {
    getAll: () => [...codeSessions.values()].map(summary),
    getSession: ([id]) => (codeSessions.has(id) ? summary(codeSessions.get(id)) : undefined),
    getTranscript: ([id]) => codeSessions.get(id)?.transcript ?? [],
    start: ([info]) => {
      const session = addCodeSession({ sessionId: info.sessionId, title: info.title, model: info.model });
      void runCodeTurn(session, { text: info.message, messageUuid: info.messageUuid, permission: /\[permission\]/.test(info.message) });
      return { sessionId: info.sessionId };
    },
    sendMessage: ([id, message, , , messageUuid]) => {
      const session = codeSessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      void runCodeTurn(session, { text: message, messageUuid, permission: /\[permission\]/.test(message) });
      return { dispatched: true };
    },
    interrupt: ([id]) => {
      const session = codeSessions.get(id);
      if (session) session.isRunning = false;
    },
    stop: ([id]) => {
      const session = codeSessions.get(id);
      if (session) session.isRunning = false;
    },
    respondToToolPermission: ([id, requestId, behavior]) => {
      const request = codeRequests.get(requestId);
      if (!request) throw new Error(`Permission "${requestId}" not found`);
      codeRequests.delete(requestId);
      const session = codeSessions.get(id);
      if (session) void runCodeTurn(session, { text: `(approved:${behavior})`, messageUuid: randomUUID() });
    },
    delete: ([id]) => { codeSessions.delete(id); },
    updateSession: ([id, options]) => {
      const session = codeSessions.get(id);
      if (session && options?.title) session.title = options.title;
    },
    setModel: ([id, model]) => {
      const session = codeSessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.model = model;
    },
    setEffort: ([id, effort]) => {
      const session = codeSessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.effort = effort;
    },
    setPermissionMode: ([id, mode]) => {
      const session = codeSessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.permissionMode = mode;
    },
    archive: ([id]) => {
      const session = codeSessions.get(id);
      if (session) session.isArchived = true;
    },
  };

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
    setEffort: ([id, effort]) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.effort = effort;
    },
    setExtendedThinking: ([id, enabled]) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Session "${id}" not found`);
      session.extendedThinking = enabled;
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
    // Uploads are raw bodies, like the real bridge's streaming route.
    if (request.method === "POST" && url.pathname === "/api/remote/files/upload") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const relativePath = url.searchParams.get("path");
      const batch = url.searchParams.get("batch");
      calls.push({ route: "upload", names: [relativePath], contentType: request.headers["content-type"] });
      const root = `/workspace/RemoteUploads/${batch}`;
      uploads.push({ path: `${root}/${relativePath}`, bytes: Buffer.concat(chunks) });
      return json(200, { ok: true, value: { path: `${root}/${relativePath}`, root, bytes: uploads.at(-1).bytes.length } });
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (request.method === "POST" && /\/dust\/generate_session_title$/.test(url.pathname)) {
      calls.push({ route: "title", message: parsed.first_session_message, model: parsed.model });
      if (state.titleDelayMs) await new Promise((resolve) => setTimeout(resolve, state.titleDelayMs));
      return json(200, { title: state.titleResult ?? `Title for ${String(parsed.first_session_message).slice(0, 24)}` });
    }
    if (request.method === "POST" && url.pathname === "/api/remote/ipc") {
      const args = decode(parsed.args) ?? [];
      calls.push({ route: "ipc", surface: parsed.surface, method: parsed.method, args });
      const handler = parsed.surface === "LocalAgentModeSessions"
        ? handlers[parsed.method]
        : parsed.surface === "LocalSessions"
          ? codeHandlers[parsed.method]
          : undefined;
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
    codeSessions,
    addCodeSession,
    ipcCalls: (method) => calls.filter((call) => call.route === "ipc" && call.method === method),
    codeIpcCalls: (method) => calls.filter((call) => call.route === "ipc" && call.surface === "LocalSessions" && call.method === method),
    resetCalls: () => { calls.length = 0; },
    async close() {
      state.down = true; // refuse the facade's reconnects while shutting down
      for (const response of clients) response.end();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
