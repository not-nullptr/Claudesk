#!/usr/bin/env node
// Offline contract smoke for the Claude mobile API facade. Spins a stub
// inference gateway, runs the facade in-process, and drives the
// device-confirmed sequence plus a Connect probe. See docs/mobile-spec.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base32Decode, hotp, totpCounter } from "../mobile/totp.mjs";
import { startFakeClaudesk } from "./lib/fake-claudesk.mjs";

process.env.CLAUDE_MOBILE_API_EMAIL = "smoke@example.com";
process.env.CLAUDE_MOBILE_API_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// A stale static code or password in the environment must have no effect.
process.env.CLAUDE_MOBILE_API_PASSWORD = "smoke-pass";
process.env.CLAUDE_MOBILE_API_CODE = "123456";
process.env.CLAUDE_MOBILE_TRUST_PROXY = "1";
process.env.CLAUDE_MOBILE_CAPTURE = "1";
process.env.CLAUDE_MOBILE_API_MAX_FAILURES = "5";
process.env.CLAUDE_MOBILE_API_BASE_BAN_SECONDS = "60";

// The mobile facade talks to Claude Desktop only through the Claudesk bridge;
// this fake keeps Desktop-shaped Chat sessions in memory.
const claudesk = await startFakeClaudesk();
process.env.CLAUDE_MOBILE_DESKTOP_URL = claudesk.url;
// A Cowork session the phone must never see or write to.
const coworkUuid = "55555555-5555-4555-8555-555555555555";
claudesk.addSession({ sessionId: `local_${coworkUuid}`, sessionType: "cowork", title: "Cowork task" });

const dataDir = await mkdtemp(join(tmpdir(), "claudesk-mobile-smoke-"));
// Conversations from before the Claudesk backend are moved aside, not served.
await mkdir(join(dataDir, "conversations"), { recursive: true });
await writeFile(join(dataDir, "conversations", "old.json"), JSON.stringify({ uuid: "66666666-6666-4666-8666-666666666666", messages: [] }));
process.env.CLAUDE_MOBILE_DATA_DIR = dataDir;
process.env.CLAUDE_MOBILE_PORT = "18471";
process.env.CLAUDE_MOBILE_HOST = "127.0.0.1";
process.env.CLAUDE_MOBILE_PROTO_SCHEMA = new URL(
  "../docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json",
  import.meta.url,
).pathname;

const facade = await import("../mobile/server.mjs");

const totpKey = base32Decode(process.env.CLAUDE_MOBILE_API_TOTP_SECRET);
const codeAt = (offset) => hotp(totpKey, totpCounter() + offset);
const wrongCode = () => {
  const valid = new Set([-1, 0, 1].map(codeAt));
  return ["000000", "111111", "222222"].find((code) => !valid.has(code));
};
const verifyBody = (code, email = "smoke@example.com", method = "code") => ({
  credentials: method === "code"
    ? { method, email_address: email, code }
    : { method, email_address: email, password: code },
});

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

  // Wrong codes, the old static code and the old password are all rejected.
  const wrong = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(wrongCode()) });
  assert.equal(wrong.status, 401);
  const staticCode = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody("123456") });
  assert.equal(staticCode.status, 401, "the static code must not log in");
  const password = await call("/api/auth/verify_magic_link", {
    method: "POST",
    body: verifyBody("smoke-pass", "smoke@example.com", "password"),
  });
  assert.equal(password.status, 401, "the password must not log in");

  // A valid code for the wrong email fails and does not use up the code.
  const current = codeAt(0);
  const wrongEmail = await call("/api/auth/verify_magic_link", {
    method: "POST",
    body: verifyBody(current, "someone-else@example.com"),
  });
  assert.equal(wrongEmail.status, 401);

  const verify = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(current) });
  assert.equal(verify.status, 200);
  assert.ok(cookie.startsWith("sessionKey="));

  // The same code cannot be used twice, nor can an older step; the next step is accepted.
  cookie = "";
  const replay = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(current) });
  assert.equal(replay.status, 401, "a used code must not be accepted again");
  assert.equal(cookie, "");
  const next = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(codeAt(1)) });
  assert.equal(next.status, 200, "the next time step is accepted");
  assert.ok(cookie.startsWith("sessionKey="));
  const older = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(codeAt(-1)) });
  assert.equal(older.status, 401, "a step before the last used one must not be accepted");

  const account = await (await call("/api/account")).json();
  assert.equal(account.email_address, "smoke@example.com");
  const org = account.memberships[0].organization;
  assert.ok(org.capabilities.includes("claude_code"));
  assert.ok(org.capabilities.includes("claude_max"));
  assert.equal(org.rate_limit_tier, "default_claude_max_20x");
  assert.equal(org.billing_type, "stripe_subscription");

  const orgs = await (await call("/api/organizations")).json();
  assert.equal(orgs[0].uuid, org.uuid);

  assert.deepEqual(await readdir(join(dataDir, "conversations")), [], "legacy conversations are moved out");
  assert.deepEqual(await readdir(join(dataDir, "legacy-conversations")), ["old.json"]);

  const bootstrap = await (await call(
    `/api/bootstrap/${org.uuid}/app_start?growthbook_format=sdk&include_system_prompts=false`,
  )).json();
  assert.ok(bootstrap.model_selector_state[0].model.length >= 1);
  assert.ok(bootstrap.model_selector_config[0].models.some((m) => m.id === "stub-sonnet"), "models come from Claudesk");

  const selected = await (await call(`/api/organizations/${org.uuid}/model_selector_state/chat`, {
    method: "PUT",
    body: { model: "stub-haiku" },
  })).json();
  assert.deepEqual(selected, { id: "chat", model: "stub-haiku" });

  const waitFor = async (check, label, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const chatPath = (uuid, action = "") => `/api/organizations/${org.uuid}/chat_conversations/${uuid}${action}`;
  const readConversation = async (uuid) => (await call(chatPath(uuid))).json();
  const texts = (conversation) => conversation.chat_messages.map((message) => message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(""));
  const send = async (uuid, body, action = "/completion") => {
    const response = await call(chatPath(uuid, action), { method: "POST", body });
    assert.equal(response.status, 200, await response.clone().text());
    const records = parseSse(await response.text());
    return {
      records,
      kinds: records.map((record) => record.event),
      text: records.filter((record) => record.event === "content_block_delta").map((record) => record.data.delta.text).join(""),
    };
  };
  const turn = (human, assistant) => ({ human_message_uuid: human, assistant_message_uuid: assistant });
  const sessionOf = (uuid) => claudesk.sessions.get(`local_${uuid}`);

  // ---- a new chat: the first completion creates the Desktop session ----
  const convUuid = "33333333-3333-4333-8333-333333333333";
  const human1 = "11111111-1111-4111-8111-111111111111";
  const assistant1 = "22222222-2222-4222-8222-222222222222";
  const first = await send(convUuid, {
    prompt: "Hello",
    create_conversation_params: { name: "", model: "stub-haiku" },
    turn_message_uuids: turn(human1, assistant1),
  });
  assert.equal(first.records[0].event, "message_start");
  assert.equal(first.records[0].data.message.uuid, assistant1, "the app's assistant uuid is honoured");
  assert.equal(first.records[0].data.message.parent_uuid, human1);
  assert.equal(first.kinds.at(-1), "message_stop");
  assert.equal(first.text, "Echo: Hello");
  const started = claudesk.ipcCalls("start");
  assert.equal(started.length, 1);
  assert.equal(started[0].args[0].sessionId, `local_${convUuid}`, "session id is derived from the conversation uuid");
  assert.equal(started[0].args[0].messageUuid, human1, "the app's human uuid is passed to Desktop");
  assert.equal(started[0].args[0].sessionType, "chat");
  assert.equal(started[0].args[0].model, "stub-haiku");

  let conversation = await readConversation(convUuid);
  assert.deepEqual(conversation.chat_messages.map((message) => message.uuid), [human1, assistant1]);
  assert.deepEqual(texts(conversation), ["Hello", "Echo: Hello"]);
  assert.equal(conversation.chat_messages[1].parent_message_uuid, human1);
  assert.equal(conversation.current_leaf_message_uuid, assistant1);
  assert.equal(conversation.model, "stub-haiku");

  // ---- follow-up on the same session ----
  const human2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const assistant2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const second = await send(convUuid, { prompt: "Second", parent_message_uuid: assistant1, turn_message_uuids: turn(human2, assistant2) });
  assert.equal(second.text, "Echo: Second");
  assert.equal(claudesk.ipcCalls("start").length, 1, "later messages reuse the session");
  assert.equal(claudesk.ipcCalls("rewind").length, 0, "a plain follow-up does not rewind");
  assert.equal(claudesk.ipcCalls("sendMessage").at(-1).args[0], `local_${convUuid}`);
  conversation = await readConversation(convUuid);
  assert.deepEqual(texts(conversation), ["Hello", "Echo: Hello", "Second", "Echo: Second"]);
  assert.equal(conversation.chat_messages[3].uuid, assistant2);
  assert.equal(conversation.chat_messages[2].parent_message_uuid, assistant1);

  // ---- a turn with reasoning and a tool call: both are shown ----
  const human3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const assistant3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const tool = await send(convUuid, { prompt: "[tool] third", parent_message_uuid: assistant2, turn_message_uuids: turn(human3, assistant3) });
  assert.equal(tool.text, "Echo: third");
  assert.equal(tool.kinds.filter((kind) => kind === "message_start").length, 1, "one assistant message for the whole turn");
  const toolStarts = tool.records.filter((record) => record.event === "content_block_start");
  assert.deepEqual(toolStarts.map((record) => record.data.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(
    toolStarts.map((record) => record.data.content_block.type),
    ["thinking", "tool_use", "tool_result", "thinking", "text"],
    "reasoning, the tool call, its result, more reasoning, then the answer",
  );
  assert.equal(
    tool.records
      .filter((record) => record.event === "content_block_delta" && record.data.delta.type === "thinking_delta" && record.data.index === 0)
      .map((record) => record.data.delta.thinking)
      .join(""),
    "I should look.",
    "reasoning streams as thinking deltas",
  );
  assert.ok(!JSON.stringify(tool.records).includes("signature"), "the opaque signature is never sent");
  assert.equal(toolStarts[1].data.content_block.name, "view", "Read is presented as claude.ai's file view tool");
  assert.equal(
    tool.records
      .filter((record) => record.event === "content_block_delta" && record.data.delta.type === "input_json_delta")
      .map((record) => record.data.delta.partial_json)
      .join(""),
    '{"file_path":"/x"}',
  );
  assert.equal(toolStarts[2].data.content_block.tool_use_id, toolStarts[1].data.content_block.id);
  assert.equal(toolStarts[2].data.content_block.content[0].text, "file body");
  assert.equal(tool.records.filter((record) => record.event === "content_block_stop").length, 5, "every block is closed");
  conversation = await readConversation(convUuid);
  assert.equal(conversation.chat_messages.length, 6, "tool results and thinking are not separate messages");
  assert.equal(texts(conversation)[5], "Echo: third");
  const stored = conversation.chat_messages[5].content;
  assert.deepEqual(stored.map((block) => block.type), ["thinking", "tool_use", "tool_result", "thinking", "text"], "history keeps the reasoning and the tool call");
  assert.deepEqual(stored[1].input, { file_path: "/x" });
  assert.deepEqual([stored[0].thinking, stored[3].thinking], ["I should look.", "hmm"]);
  assert.ok(!JSON.stringify(conversation).includes("signature"), "the opaque signature is not stored in history");
  assert.deepEqual(
    conversation.chat_messages[1].content.map((block) => block.type),
    ["thinking", "text"],
    "even a plain turn shows its reasoning",
  );

  // The Connect snapshot shows the same turn as a timeline group with a tool row.
  const snapshot = await (await call("/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadConversation", {
    method: "POST",
    body: { conversationId: convUuid },
  })).json();
  assert.equal(snapshot.outcome, 1);
  const turnGroups = snapshot.update.displayGroups.filter((group) => group.messageId === assistant3);
  assert.deepEqual(turnGroups.map((group) => group.style), [2, 1]);
  assert.equal(turnGroups[0].summary, "Read file");
  const timeline = snapshot.update.contentBlocks.filter((block) => block.displayGroupId === turnGroups[0].id);
  assert.deepEqual(timeline.map((block) => block.title), ["Thought", "Read file", "Thought"], "reasoning and the call share the timeline");
  assert.equal(timeline[0].text, "I should look.");
  assert.deepEqual(timeline[0].summaries, [{ summary: "I should look." }]);
  assert.ok(timeline[0].thinkingDisplay.startedAt && timeline[0].thinkingDisplay.completedAt);
  const toolRow = timeline.find((block) => block.rowKind);
  assert.deepEqual(
    [toolRow.title, toolRow.state, toolRow.rowKind, toolRow.inputSummary, toolRow.text],
    ["Read file", 2, 3, "/x", "file body"],
  );
  assert.equal(snapshot.update.contentBlocks.find((block) => block.displayGroupId === turnGroups[1].id).text, "Echo: third");

  // ---- edit a message: Desktop rewinds to it and the new text is a fresh turn ----
  const human2b = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const assistant2b = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  claudesk.resetCalls();
  const edited = await send(convUuid, { prompt: "Second edited", parent_message_uuid: assistant1, turn_message_uuids: turn(human2b, assistant2b) });
  assert.equal(edited.text, "Echo: Second edited");
  assert.deepEqual(claudesk.ipcCalls("rewind").map((call) => call.args), [[`local_${convUuid}`, human2]], "the edited message is the rewind target");
  conversation = await readConversation(convUuid);
  assert.deepEqual(texts(conversation), ["Hello", "Echo: Hello", "Second edited", "Echo: Second edited"], "later turns are discarded, as in the web UI");
  assert.deepEqual(conversation.chat_messages.map((message) => message.uuid), [human1, assistant1, human2b, assistant2b]);

  // ---- retry regenerates the answer to the same human message ----
  claudesk.resetCalls();
  const retried = await send(convUuid, { turn_message_uuids: { assistant_message_uuid: assistant2b } }, "/retry_completion");
  assert.equal(retried.text, "Echo: Second edited");
  assert.deepEqual(claudesk.ipcCalls("rewind").map((call) => call.args), [[`local_${convUuid}`, human2b]]);
  assert.equal(claudesk.ipcCalls("sendMessage").at(-1).args[1], "Second edited", "the removed prompt is resent");
  assert.equal(claudesk.ipcCalls("sendMessage").at(-1).args[4], human2b, "retry keeps the human message uuid");
  conversation = await readConversation(convUuid);
  assert.deepEqual(conversation.chat_messages.map((message) => message.uuid), [human1, assistant1, human2b, assistant2b]);

  // ---- a redelivered request does not send the message twice ----
  claudesk.resetCalls();
  const redelivered = await send(convUuid, { prompt: "Second edited", parent_message_uuid: assistant1, turn_message_uuids: turn(human2b, assistant2b) });
  assert.equal(redelivered.text, "Echo: Second edited");
  assert.equal(claudesk.ipcCalls("sendMessage").length + claudesk.ipcCalls("rewind").length, 0);
  assert.equal((await readConversation(convUuid)).chat_messages.length, 4);

  // ---- attachments: text files are uploaded and mentioned, images go inline ----
  const upload = async (name, bytes, type) => {
    const prepared = await (await call(`/api/organizations/${org.uuid}/files/prepare-upload`, { method: "POST", body: { files: [{ name }] } })).json();
    const form = new FormData();
    form.append("path", prepared.uploads[0].path);
    form.append("file", new Blob([bytes], { type }), name);
    const response = await fetch(`${base}/api/organizations/${org.uuid}/files`, { method: "POST", headers: { cookie }, body: form });
    assert.equal(response.status, 200);
    return response.json();
  };
  const notes = await upload("notes.txt", Buffer.from("The secret word is walrus.\n"), "text/plain");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  const picture = await upload("pic.png", png, "image/png");
  claudesk.resetCalls();
  const human4 = "12121212-1212-4212-8212-121212121212";
  const assistant4 = "34343434-3434-4434-8434-343434343434";
  const attached = await send(convUuid, {
    prompt: "What are these?",
    parent_message_uuid: assistant2b,
    turn_message_uuids: turn(human4, assistant4),
    attachments: [{ file_name: "notes.txt", file_size: notes.file_size, file_type: "text/plain" }],
    files: [notes.file_uuid, picture.file_uuid],
  });
  assert.equal(attached.text, "Echo: What are these?");
  assert.deepEqual(claudesk.calls.filter((call) => call.route === "upload").map((call) => call.names), [["notes.txt"]], "the text file is uploaded once");
  assert.equal(claudesk.uploads.at(-1).bytes.toString(), "The secret word is walrus.\n");
  const attachedCall = claudesk.ipcCalls("sendMessage").at(-1).args;
  assert.match(attachedCall[1], /^@"\/workspace\/RemoteUploads\/[0-9a-f-]+\/notes\.txt"\nWhat are these\?$/);
  assert.equal(attachedCall[2].length, 1);
  assert.deepEqual(Object.keys(attachedCall[2][0]).sort(), ["base64", "mimeType", "name"]);
  assert.equal(attachedCall[2][0].mimeType, "image/png");
  assert.equal(Buffer.from(attachedCall[2][0].base64, "base64").length, png.length);
  conversation = await readConversation(convUuid);
  const attachedMessage = conversation.chat_messages.at(-2);
  assert.equal(attachedMessage.content[0].text, "What are these?", "the mention is not shown as message text");
  assert.equal(attachedMessage.attachments[0].file_name, "notes.txt");

  // ---- stopping from the phone stops the Desktop session ----
  const stopUuid = "56565656-5656-4656-8656-565656565656";
  claudesk.resetCalls();
  const controller = new AbortController();
  const slow = await fetch(`${base}${chatPath(convUuid, "/completion")}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "[slow] stop me", parent_message_uuid: assistant4, turn_message_uuids: turn(stopUuid, "78787878-7878-4878-8878-787878787878") }),
    signal: controller.signal,
  });
  const reader = slow.body.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => {});
  await waitFor(() => claudesk.ipcCalls("stop").length >= 1, "the stop request");
  assert.deepEqual(claudesk.ipcCalls("stop")[0].args, [`local_${convUuid}`]);
  await waitFor(() => !sessionOf(convUuid).isRunning, "the stopped turn to wind down");

  // ---- rename, star and model changes ----
  const patched = await (await call(chatPath(convUuid), {
    method: "PATCH",
    body: { name: "Renamed", is_starred: true, model: "stub-sonnet" },
  })).json();
  assert.equal(patched.name, "Renamed");
  assert.equal(sessionOf(convUuid).title, "Renamed", "the title is Desktop's");
  assert.equal(sessionOf(convUuid).model, "stub-sonnet");
  assert.equal(patched.model, "stub-sonnet");
  assert.equal(patched.is_starred, true);

  // ---- listing shows Chat sessions only, including ones started in Claudesk ----
  const webUuid = "99999999-9999-4999-8999-999999999999";
  claudesk.addSession({ sessionId: `local_${webUuid}`, title: "From the web UI", initialMessage: "hi from web" });
  const listed = await (await call(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=50&offset=0`)).json();
  const listedIds = listed.data.map((entry) => entry.uuid);
  assert.ok(listedIds.includes(convUuid) && listedIds.includes(webUuid), "chats from both surfaces are listed");
  assert.ok(!listedIds.includes(coworkUuid), "Cowork sessions are not exposed");
  assert.equal((await call(chatPath(coworkUuid))).status, 404);
  assert.equal((await call(chatPath(coworkUuid), { method: "PATCH", body: { name: "x" } })).status, 404);
  assert.equal((await call(chatPath(coworkUuid), { method: "DELETE" })).status, 404);
  claudesk.resetCalls();
  const hijack = await call(chatPath(coworkUuid, "/completion"), {
    method: "POST",
    body: { prompt: "hello", create_conversation_params: { name: "", model: "stub-haiku" } },
  });
  assert.ok(hijack.status >= 400 && hijack.status < 500, "a completion cannot adopt a Cowork session id");
  assert.equal(claudesk.ipcCalls("start").length + claudesk.ipcCalls("sendMessage").length, 0);
  assert.equal(claudesk.sessions.get(`local_${coworkUuid}`).transcript.length, 0);

  const recents = await (await call(`/api/organizations/${org.uuid}/chat_conversations?starred=true`)).json();
  assert.equal(recents.length, 1);
  const connectList = await (await call("/claudeai-rpc/anthropic.claudeai_chats.api.v1alpha.RecentsService/ListRecents", {
    method: "POST",
    body: {},
  })).json();
  assert.ok(connectList.data.some((item) => item.chat.uuid === convUuid));

  // ---- the Connect surface sends too, with edit support via the parent id ----
  const connectUuid = "abababab-abab-4bab-8bab-abababababab";
  const draft = await (await call(`/api/organizations/${org.uuid}/chat_conversations`, {
    method: "POST",
    body: { name: "Drafted", model: "stub-haiku" },
  })).json();
  assert.equal(draft.name, "Drafted");
  assert.equal((await readConversation(draft.uuid)).chat_messages.length, 0, "a draft has no messages");
  assert.ok(!claudesk.sessions.has(`local_${draft.uuid}`), "a draft is not a Desktop session yet");
  assert.equal((await call(chatPath(draft.uuid), { method: "DELETE" })).status, 200);
  assert.equal((await call(chatPath(draft.uuid))).status, 404);

  const connectConversation = connectUuid;
  await call(chatPath(connectConversation), { method: "GET" });
  const performAction = (action) => call("/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction", {
    method: "POST",
    body: { header: { conversationId: connectConversation, mutationId: { sessionId: "smoke", version: 1 } }, ...action },
  });
  await call(`/api/organizations/${org.uuid}/chat_conversations`, { method: "POST", body: { uuid: connectConversation, name: "", model: "stub-haiku" } });
  const connectHuman = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
  const connectAssistant = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  const sentOverConnect = await performAction({ sendMessage: { messageId: connectHuman, assistantMessageId: connectAssistant, text: "Via connect" } });
  assert.equal(sentOverConnect.status, 200);
  await waitFor(async () => {
    const connectRead = await readConversation(connectConversation).catch(() => null);
    return connectRead?.chat_messages?.length === 2 && texts(connectRead)[1] === "Echo: Via connect";
  }, "the Connect message to complete");
  assert.equal((await readConversation(connectConversation)).chat_messages[1].uuid, connectAssistant);

  // ---- reasoning effort and thinking mode, as the app's picker sends them ----
  const modelEntry = (id) => bootstrap.model_selector_config[0].models.find((m) => m.id === id);
  assert.deepEqual(
    modelEntry("stub-sonnet").thinking.effort_options.map((option) => option.id),
    ["low", "medium", "high", "xhigh", "max"],
    "the model list keeps Claudesk's effort options so the app can show its picker",
  );
  assert.equal(modelEntry("stub-haiku").thinking, undefined, "a model without reasoning options has no picker");

  claudesk.resetCalls();
  const reasonUuid = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
  await send(reasonUuid, {
    prompt: "Think hard",
    effort: "high",
    thinking_mode: "off",
    create_conversation_params: { name: "", model: "stub-sonnet" },
    turn_message_uuids: turn("e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2", "e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3"),
  });
  const reasonStart = claudesk.ipcCalls("start")[0].args[0];
  assert.equal(reasonStart.extendedThinkingEnabled, false, "thinking mode off reaches start");
  assert.deepEqual(claudesk.ipcCalls("setEffort").map((call) => call.args), [[`local_${reasonUuid}`, "high"]]);
  assert.equal(sessionOf(reasonUuid).effort, "high");
  assert.equal((await readConversation(reasonUuid)).settings.effort_level_token, "high", "the pick is reported back");

  claudesk.resetCalls();
  await send(reasonUuid, {
    prompt: "Again",
    effort: "low",
    thinking_mode: "auto",
    parent_message_uuid: "e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3",
    turn_message_uuids: turn("e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4", "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5"),
  });
  const order = claudesk.calls.filter((call) => call.route === "ipc").map((call) => call.method);
  assert.ok(order.indexOf("setEffort") >= 0 && order.indexOf("setEffort") < order.indexOf("sendMessage"), "effort is set before the message goes out");
  assert.equal(sessionOf(reasonUuid).effort, "low");
  assert.equal(claudesk.ipcCalls("sendMessage").at(-1).args[11], true, "thinking mode reaches sendMessage as its twelfth argument");

  claudesk.resetCalls();
  await send(reasonUuid, {
    prompt: "Unknown level",
    effort: "turbo",
    thinking_mode: "bogus",
    parent_message_uuid: "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5",
    turn_message_uuids: turn("e6e6e6e6-e6e6-46e6-86e6-e6e6e6e6e6e6", "e7e7e7e7-e7e7-47e7-87e7-e7e7e7e7e7e7"),
  });
  assert.equal(claudesk.ipcCalls("setEffort").length, 0, "levels the model does not offer are not forwarded");
  assert.equal(claudesk.ipcCalls("sendMessage").at(-1).args.length, 5, "no thinking argument without a valid pick");

  claudesk.resetCalls();
  await send(convUuid, {
    prompt: "No reasoning options",
    model: "stub-haiku",
    effort: "high",
    parent_message_uuid: (await readConversation(convUuid)).current_leaf_message_uuid,
    turn_message_uuids: turn("e8e8e8e8-e8e8-48e8-88e8-e8e8e8e8e8e8", "e9e9e9e9-e9e9-49e9-89e9-e9e9e9e9e9e9"),
  });
  assert.equal(claudesk.ipcCalls("setEffort").length, 0, "a model without effort options ignores the pick");

  // The picker's selection is stored on the selector state, per model, and used
  // when a send does not carry its own.
  const statePath = `/api/organizations/${org.uuid}/model_selector_state/chat`;
  const savedState = await (await call(statePath, {
    method: "PUT",
    body: { model: "stub-sonnet", thinking: { effort: "xhigh", mode: "auto" } },
  })).json();
  assert.deepEqual(savedState.thinking, { effort: "xhigh", mode: "auto" });
  assert.deepEqual(savedState.thinking_by_model, { "stub-sonnet": { effort: "xhigh", mode: "auto" } });
  const bootState = (await (await call(
    `/api/bootstrap/${org.uuid}/app_start?growthbook_format=sdk&include_system_prompts=false`,
  )).json()).model_selector_state[0];
  assert.equal(bootState.model, "stub-sonnet");
  assert.deepEqual(bootState.thinking, { effort: "xhigh", mode: "auto" }, "bootstrap reports the selected effort");
  assert.deepEqual((await (await call(statePath)).json()).thinking_by_model["stub-sonnet"], { effort: "xhigh", mode: "auto" });
  await call(statePath, { method: "PUT", body: { model: "stub-haiku" } });
  assert.equal((await (await call(statePath)).json()).thinking, undefined, "another model has no selection yet");
  await call(statePath, { method: "PUT", body: { model: "stub-sonnet" } });

  claudesk.resetCalls();
  const savedPickUuid = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
  await send(savedPickUuid, {
    prompt: "No explicit effort",
    create_conversation_params: { name: "", model: "stub-sonnet" },
    turn_message_uuids: turn("d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2", "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3"),
  });
  assert.equal(sessionOf(savedPickUuid).effort, "xhigh", "the saved selection applies when the send carries none");

  // Connect carries the same picks as conversation-settings tokens.
  claudesk.resetCalls();
  const reasonConnect = "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1";
  await call(`/api/organizations/${org.uuid}/chat_conversations`, { method: "POST", body: { uuid: reasonConnect, name: "", model: "stub-sonnet" } });
  const actOn = (conversationId, action) => call("/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction", {
    method: "POST",
    body: { header: { conversationId, mutationId: { sessionId: "smoke", version: 1 } }, ...action },
  });
  await actOn(reasonConnect, { updateConversationSettings: { settings: { effortLevelToken: "medium" } } });
  assert.equal(claudesk.ipcCalls("setEffort").length, 0, "a draft has no Desktop session to update yet");
  assert.equal((await readConversation(reasonConnect)).settings.effort_level_token, "medium", "a draft remembers the pick");
  await actOn(reasonConnect, { sendMessage: {
    messageId: "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2",
    assistantMessageId: "f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3",
    text: "Connect think",
    settingsUpdate: { settings: { effortLevelToken: "xhigh", thinkingModeToken: "off" } },
  } });
  await waitFor(() => claudesk.ipcCalls("start").length === 1, "the Connect send to start a session");
  assert.equal(claudesk.ipcCalls("start")[0].args[0].extendedThinkingEnabled, false);
  assert.equal(sessionOf(reasonConnect).effort, "xhigh");
  await waitFor(async () => texts(await readConversation(reasonConnect))[1] === "Echo: Connect think", "the Connect reply");
  await actOn(reasonConnect, { updateConversationSettings: { settings: { effortLevelToken: "max" } } });
  assert.equal(sessionOf(reasonConnect).effort, "max", "a settings change reaches the live session");
  const bardRead = await (await call("/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadConversation", {
    method: "POST",
    body: { conversationId: reasonConnect },
  })).json();
  assert.equal(JSON.stringify(bardRead).includes('"max"'), true, "Connect reports the effort token back");

  // ---- chat titles: Desktop writes one for a new chat, and an empty rename never erases it ----
  const titleOf = (uuid) => sessionOf(uuid)?.title;
  claudesk.resetCalls();
  const titledUuid = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
  await send(titledUuid, {
    prompt: "Plan a trip to Lisbon",
    create_conversation_params: { name: "", model: "stub-sonnet" },
    turn_message_uuids: turn("a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2", "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3"),
  });
  assert.equal(claudesk.ipcCalls("start")[0].args[0].title, "Plan a trip to Lisbon", "the first message is the provisional title");
  await waitFor(() => titleOf(titledUuid) === "Title for Plan a trip to Lisbon", "Desktop's generated title");
  const titleCalls = claudesk.calls.filter((call) => call.route === "title");
  assert.deepEqual(titleCalls.map((call) => [call.message, call.model]), [["Plan a trip to Lisbon", "stub-sonnet"]], "one title request, for the first message");
  assert.equal((await readConversation(titledUuid)).name, "Title for Plan a trip to Lisbon");

  const emptyRename = await call(chatPath(titledUuid), { method: "PUT", body: { name: "" } });
  assert.equal(emptyRename.status, 200);
  await actOn(titledUuid, { renameConversation: { title: "" } });
  assert.equal(titleOf(titledUuid), "Title for Plan a trip to Lisbon", "an empty rename leaves the title alone");
  await actOn(titledUuid, { renameConversation: { title: "Lisbon" } });
  assert.equal(titleOf(titledUuid), "Lisbon", "a real rename still applies");
  const followUp = await send(titledUuid, {
    prompt: "More", parent_message_uuid: "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3",
    turn_message_uuids: turn("a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4", "a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5"),
  });
  assert.equal(followUp.text, "Echo: More");
  assert.equal(claudesk.calls.filter((call) => call.route === "title").length, 1, "later messages do not ask for another title");
  assert.equal(titleOf(titledUuid), "Lisbon");

  // A rename made while the title is still being written wins.
  claudesk.state.titleDelayMs = 300;
  const racedUuid = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
  await send(racedUuid, {
    prompt: "Raced chat",
    create_conversation_params: { name: "", model: "stub-sonnet" },
    turn_message_uuids: turn("b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2", "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3"),
  });
  await actOn(racedUuid, { renameConversation: { title: "Mine" } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(titleOf(racedUuid), "Mine", "a title written late does not overwrite the user's");

  // When Desktop cannot write a title the provisional one stays.
  claudesk.state.titleDelayMs = 0;
  claudesk.state.titleResult = "";
  const untitledUuid = "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1";
  await send(untitledUuid, {
    prompt: "Quiet chat",
    create_conversation_params: { name: "", model: "stub-sonnet" },
    turn_message_uuids: turn("c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2", "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3"),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(titleOf(untitledUuid), "Quiet chat");
  claudesk.state.titleResult = undefined;

  // ---- deleting removes the Desktop session ----
  claudesk.resetCalls();
  assert.equal((await call(chatPath(convUuid), { method: "DELETE" })).status, 200);
  assert.deepEqual(claudesk.ipcCalls("delete").map((call) => call.args), [[`local_${convUuid}`]]);
  assert.ok(!claudesk.sessions.has(`local_${convUuid}`));
  assert.equal((await call(chatPath(convUuid))).status, 404);

  // ---- capture mode records what the app asks for that is not implemented ----
  const unknown = await call(`/api/organizations/${org.uuid}/code/sessions?limit=5`, {
    method: "POST",
    body: { environment: "local", title: "x", token: "do-not-log", nested: { password: "nope", keep: "yes" } },
  });
  assert.equal(unknown.status, 404);
  await waitFor(async () => (await readFile(join(dataDir, "capture.jsonl"), "utf8").catch(() => "")).includes("code/sessions"), "the capture log");
  const captured = (await readFile(join(dataDir, "capture.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const unhandled = captured.find((entry) => entry.kind === "unhandled" && entry.path.endsWith("/code/sessions"));
  assert.ok(unhandled, "the unimplemented route is captured");
  assert.deepEqual(unhandled.query, ["limit"]);
  assert.equal(unhandled.body.json.keep, undefined);
  assert.equal(unhandled.body.json.nested.keep, "yes");
  assert.equal(unhandled.body.json.token, "<redacted>");
  assert.equal(unhandled.body.json.nested.password, "<redacted>");
  assert.ok(captured.some((entry) => entry.kind === "request" && entry.status === 200 && entry.path === "/api/account"), "handled requests are logged with their status");
  assert.ok(!JSON.stringify(captured).includes("do-not-log"), "secrets never reach the capture file");

  // ---- a Claudesk outage surfaces as an error, not a crash ----
  claudesk.state.down = true;
  const outage = await call(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=50&offset=0`);
  assert.ok(outage.status >= 500, `expected a server error during an outage, got ${outage.status}`);
  const outageSend = await call(chatPath("77777777-7777-4777-8777-777777777777", "/completion"), {
    method: "POST",
    body: { prompt: "hi", create_conversation_params: { name: "", model: "stub-haiku" } },
  });
  assert.ok(outageSend.status >= 500, `expected a server error sending during an outage, got ${outageSend.status}`);
  claudesk.state.down = false;
  assert.equal((await call(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=50&offset=0`)).status, 200, "recovers when Claudesk is back");

  const anonymous = await fetch(`${base}/api/account`);
  assert.equal(anonymous.status, 401);
  const anonymousRpc = await fetch(`${base}/claudeai-rpc/anthropic.claudeai_chats.api.v1alpha.RecentsService/ListRecents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymousRpc.status, 401);

  // fail2ban lockout: maxFailures=5, so a run of wrong codes ends in 429.
  let lastStatus = 0;
  for (let index = 0; index < 6; index += 1) {
    const attempt = await call("/api/auth/verify_magic_link", { method: "POST", body: verifyBody(wrongCode()) });
    lastStatus = attempt.status;
  }
  assert.equal(lastStatus, 429);

  // The lockout is per client address as seen by the trusted proxy (the last
  // X-Forwarded-For entry), so forging the left-hand entries cannot evade it,
  // and another client of the same account is unaffected.
  const via = (client, spoof) => ({ "x-forwarded-for": `${spoof}, ${client}` });
  lastStatus = 0;
  for (let index = 0; index < 6; index += 1) {
    const attempt = await call("/api/auth/verify_magic_link", {
      method: "POST",
      body: verifyBody(wrongCode()),
      headers: via("198.51.100.7", `forged-${index}`),
    });
    lastStatus = attempt.status;
  }
  assert.equal(lastStatus, 429, "forged X-Forwarded-For entries must not evade the lockout");
  // Rotating the host part of an IPv6 address does not escape the lockout.
  lastStatus = 0;
  for (let index = 0; index < 6; index += 1) {
    const attempt = await call("/api/auth/verify_magic_link", {
      method: "POST",
      body: verifyBody(wrongCode()),
      headers: via(`2001:db8:5:6:${index}::${index + 1}`, "forged"),
    });
    lastStatus = attempt.status;
  }
  assert.equal(lastStatus, 429, "addresses in one IPv6 /64 must share a lockout");
  const otherClient = await call("/api/auth/verify_magic_link", {
    method: "POST",
    body: verifyBody(wrongCode()),
    headers: via("198.51.100.8", "forged-x"),
  });
  assert.equal(otherClient.status, 401, "another client must not be locked out");

  console.log("mobile-api-smoke: PASS");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await claudesk.close();
}
process.exit(0);
