#!/usr/bin/env node
// Offline contract smoke for the Claude mobile API facade. Spins a stub
// inference gateway, runs the facade in-process, and drives the
// device-confirmed sequence plus a Connect probe. See docs/mobile-spec.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_MOBILE_API_EMAIL = "smoke@example.com";
process.env.CLAUDE_MOBILE_API_PASSWORD = "smoke-pass";
process.env.CLAUDE_MOBILE_API_CODE = "123456";
process.env.CLAUDE_MOBILE_API_MAX_FAILURES = "3";
process.env.CLAUDE_MOBILE_API_BASE_BAN_SECONDS = "60";
process.env.CLAUDE_MOBILE_API_MAX_TOKENS = "256";

// Stub Desktop bridge serving the system prompt template the way the real
// /api/bootstrap/:org/system_prompts route does.
const desktopTemplate = [
  "<application_details>\nVM and Claude Code details.\n</application_details>",
  "<claude_behavior>",
  "<product_information>\nFile automation.\n</product_information>",
  "<tone_and_formatting>\nSMOKE-TONE-SECTION\n</tone_and_formatting>",
  "<computer_use>\nSMOKE-COMPUTER-USE\n</computer_use>",
  "</claude_behavior>",
  "<env>\nModel: {{modelName}}\n</env>\n{{modelIdentity}}",
].join("\n").padEnd(600, " ");
let desktopUp = true;
const desktop = http.createServer((request, response) => {
  if (desktopUp && /^\/api\/bootstrap\/[^/]+\/system_prompts$/.test(request.url)) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ cowork_system_prompt: { value: { prompt: desktopTemplate } } }));
    return;
  }
  response.writeHead(desktopUp ? 404 : 503);
  response.end("{}");
});
await new Promise((resolve) => desktop.listen(0, "127.0.0.1", resolve));
process.env.CLAUDE_MOBILE_DESKTOP_URL = `http://127.0.0.1:${desktop.address().port}`;
process.env.CLAUDE_MOBILE_SYSTEM_PROMPT_TTL_MS = "1";

let lastSystem;
const stub = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "stub/chat" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/messages") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(typeof parsed.model, "string");
    lastSystem = parsed.system;
    assert.ok(Array.isArray(parsed.messages) && parsed.messages.length >= 1);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "resp_stub", model: parsed.model, role: "assistant", content: [] } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from " } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "your backend" } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
    send("message_stop", { type: "message_stop" });
    response.end();
    return;
  }
  response.writeHead(404);
  response.end("{}");
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;
process.env.CLAUDE_MOBILE_GATEWAY_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.CLAUDE_MOBILE_GATEWAY_API_KEY = "stub-key";
process.env.CLAUDE_MOBILE_GATEWAY_AUTH_SCHEME = "x-api-key";

const dataDir = await mkdtemp(join(tmpdir(), "claudesk-mobile-smoke-"));
process.env.CLAUDE_MOBILE_DATA_DIR = dataDir;
process.env.CLAUDE_MOBILE_PORT = "18471";
process.env.CLAUDE_MOBILE_HOST = "127.0.0.1";
process.env.CLAUDE_MOBILE_PROTO_SCHEMA = new URL(
  "../docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json",
  import.meta.url,
).pathname;

const facade = await import("../mobile/server.mjs");

const base = "http://127.0.0.1:18471";
let cookie = "";
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    const match = /sessionKey=([^;]+)/.exec(setCookie);
    if (match?.[1]) cookie = `sessionKey=${match[1]}`;
  }
  return response;
}

const parseSse = (text) => text.split("\n\n").filter(Boolean).map((record) => {
  const event = /event: ([^\n]+)/.exec(record)?.[1];
  const data = JSON.parse(/data: ([^\n]+)/.exec(record)?.[1] ?? "null");
  return { event, data };
});

try {
  const health = await (await call("/api/health")).json();
  assert.equal(health.ok, true);

  const legal = await (await call("/api/legal")).json();
  assert.deepEqual(legal, {});

  const magic = await (await call("/api/auth/send_magic_link", {
    method: "POST",
    body: { email_address: "smoke@example.com" },
  })).json();
  assert.equal(magic.sent, true);
  assert.equal(magic.fallback_code_configuration.length, 6);

  const wrong = await call("/api/auth/verify_magic_link", {
    method: "POST",
    body: { credentials: { method: "code", email_address: "smoke@example.com", code: "000000" } },
  });
  assert.equal(wrong.status, 401);

  const verify = await call("/api/auth/verify_magic_link", {
    method: "POST",
    body: { credentials: { method: "code", email_address: "smoke@example.com", code: "123456" } },
  });
  assert.equal(verify.status, 200);
  assert.ok(cookie.startsWith("sessionKey="));

  const account = await (await call("/api/account")).json();
  assert.equal(account.email_address, "smoke@example.com");
  const org = account.memberships[0].organization;
  assert.ok(org.capabilities.includes("claude_code"));

  const orgs = await (await call("/api/organizations")).json();
  assert.equal(orgs[0].uuid, org.uuid);

  const bootstrap = await (await call(
    `/api/bootstrap/${org.uuid}/app_start?growthbook_format=sdk&include_system_prompts=false`,
  )).json();
  assert.ok(bootstrap.model_selector_state[0].model.length >= 1);
  assert.ok(bootstrap.model_selector_config[0].models.some((m) => m.id === "stub/chat"));

  const selected = await (await call(`/api/organizations/${org.uuid}/model_selector_state/chat`, {
    method: "PUT",
    body: { model: "stub/chat" },
  })).json();
  assert.deepEqual(selected, { id: "chat", model: "stub/chat" });

  // New chats: the first completion carries a client UUID and
  // create_conversation_params instead of a prior create call.
  const freshUuid = "33333333-3333-4333-8333-333333333333";
  const fresh = await call(
    `/api/organizations/${org.uuid}/chat_conversations/${freshUuid}/completion`,
    { method: "POST", body: { prompt: "Hi", create_conversation_params: { name: "", model: "stub/chat" } } },
  );
  assert.equal(fresh.status, 200);
  assert.equal(parseSse(await fresh.text()).at(-1).event, "message_stop");
  const freshReopened = await (await call(`/api/organizations/${org.uuid}/chat_conversations/${freshUuid}`)).json();
  assert.equal(freshReopened.chat_messages.length, 2);

  const created = await (await call(`/api/organizations/${org.uuid}/chat_conversations`, {
    method: "POST",
    body: { name: "New conversation", model: "stub/chat" },
  })).json();
  const convUuid = created.uuid;

  const humanUuid = "11111111-1111-4111-8111-111111111111";
  const assistantUuid = "22222222-2222-4222-8222-222222222222";
  const completion = await call(
    `/api/organizations/${org.uuid}/chat_conversations/${convUuid}/completion`,
    { method: "POST", body: { prompt: "Hello", turn_message_uuids: { human_message_uuid: humanUuid, assistant_message_uuid: assistantUuid } } },
  );
  assert.equal(completion.status, 200);
  const records = parseSse(await completion.text());
  assert.equal(records[0].event, "message_start");
  assert.equal(records[0].data.message.uuid, assistantUuid);
  assert.equal(records.at(-1).event, "message_stop");
  const text = records.filter((r) => r.event === "content_block_delta")
    .map((r) => r.data.delta.text).join("");
  assert.equal(text, "Hello from your backend");

  // The Desktop Claude prompt reaches the gateway: behavior sections and the
  // model identity are present, the VM/file/computer-use text is not.
  assert.equal(typeof lastSystem, "string");
  assert.match(lastSystem, /SMOKE-TONE-SECTION/);
  assert.match(lastSystem, /Model: stub\/chat/);
  assert.match(lastSystem, /You are powered by the model stub\/chat\./);
  assert.doesNotMatch(lastSystem, /SMOKE-COMPUTER-USE|VM and Claude Code|File automation/);
  assert.doesNotMatch(lastSystem, /\{\{/);

  // A Desktop outage keeps serving the last good prompt (TTL is 1 ms here).
  desktopUp = false;
  const cached = await call(
    `/api/organizations/${org.uuid}/chat_conversations/44444444-4444-4444-8444-444444444444/completion`,
    { method: "POST", body: { prompt: "Again", create_conversation_params: { name: "", model: "stub/chat" } } },
  );
  assert.equal(cached.status, 200);
  await cached.text();
  assert.match(lastSystem, /SMOKE-TONE-SECTION/);
  desktopUp = true;

  const reopened = await (await call(`/api/organizations/${org.uuid}/chat_conversations/${convUuid}`)).json();
  assert.equal(reopened.chat_messages.length, 2);
  assert.equal(reopened.chat_messages[0].uuid, humanUuid);
  assert.equal(reopened.chat_messages[1].content[0].text, text);
  assert.equal(reopened.current_leaf_message_uuid, assistantUuid);

  const listed = await (await call(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=50&offset=0`)).json();
  assert.ok(listed.data.some((entry) => entry.uuid === convUuid));

  const patched = await (await call(`/api/organizations/${org.uuid}/chat_conversations/${convUuid}`, {
    method: "PATCH",
    body: { name: "Renamed", is_starred: true },
  })).json();
  assert.equal(patched.name, "Renamed");

  const recents = await (await call(`/api/organizations/${org.uuid}/chat_conversations?starred=true`)).json();
  assert.equal(recents.length, 1);

  const connectList = await (await call("/claudeai-rpc/anthropic.claudeai_chats.api.v1alpha.RecentsService/ListRecents", {
    method: "POST",
    body: {},
  })).json();
  assert.ok(connectList.data.some((item) => item.chat.uuid === convUuid));

  const anonymous = await fetch(`${base}/api/account`);
  assert.equal(anonymous.status, 401);
  const anonymousRpc = await fetch(`${base}/claudeai-rpc/anthropic.claudeai_chats.api.v1alpha.RecentsService/ListRecents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymousRpc.status, 401);

  // fail2ban lockout: maxFailures=3, so the 4th attempt in a row must 429.
  let lastStatus = 0;
  for (let index = 0; index < 4; index += 1) {
    const attempt = await call("/api/auth/verify_magic_link", {
      method: "POST",
      body: { credentials: { method: "code", email_address: "smoke@example.com", code: "000000" } },
    });
    lastStatus = attempt.status;
  }
  assert.equal(lastStatus, 429);
  console.log("mobile-api-smoke: PASS");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  stub.close();
  desktop.close();
}
process.exit(0);
