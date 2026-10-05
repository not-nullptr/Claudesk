#!/usr/bin/env node
// Offline contract smoke for the Claude mobile API facade. Spins a stub
// inference gateway, runs the facade in-process, and drives the
// device-confirmed sequence plus a Connect probe. See docs/mobile-spec.
import assert from "node:assert/strict";
import { decodeChannelMessage, decodeChannelStreamFrame, decodeClientEvent, decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";
import { createHash } from "node:crypto";
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
// Pin the experiment switches so a value left in the calling shell cannot change
// what this suite asserts. "both" is the shipped default: the cloud record and
// the bridge record, with the bridge still resolvable by id.
process.env.CLAUDE_MOBILE_ENVIRONMENT_MODE = "both";
delete process.env.CLAUDE_MOBILE_EXPERIMENT_HIDE_BRIDGE_BY_ID;
// The on-device Frida probe's report sink (tools/frida). Its token is a shared
// secret, so the suite pins one and proves the route is closed without it.
process.env.CLAUDE_MOBILE_FRIDA_TOKEN = "smoke-diag-token";

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
  const bootstrap0 = await (await call(
    `/api/bootstrap/${(account.memberships[0].organization.uuid)}/app_start?growthbook_format=sdk&include_system_prompts=false`,
  )).json();
  assert.equal(account.email_address, "smoke@example.com");
  const org = account.memberships[0].organization;
  assert.deepEqual(org.capabilities, ["chat", "claude_max"]);
  assert.equal(account.capabilities, undefined, "capabilities live on the organization only");
  assert.deepEqual(bootstrap0.account.memberships[0].organization.capabilities, ["chat", "claude_max"]);
  assert.ok(org.capabilities.includes("claude_max"));
  assert.equal(org.rate_limit_tier, "default_claude_max_20x");
  assert.equal(org.billing_type, "stripe_subscription");

  const orgs = await (await call("/api/organizations")).json();
  assert.equal(orgs[0].uuid, org.uuid);

  assert.deepEqual(await readdir(join(dataDir, "conversations")), [], "legacy conversations are moved out");
  assert.deepEqual(await readdir(join(dataDir, "legacy-conversations")), ["old.json"]);

  const bootstrap = bootstrap0;
  assert.ok(bootstrap.model_selector_state[0].model.length >= 1);
  assert.ok(bootstrap.model_selector_config[0].models.some((m) => m.id === "stub-sonnet"), "models come from Claudesk");
  // The selector is per-surface: the Chat composer reads `chat`, the Code
  // composer `code`, the Cowork session chat `cowork`. A composer on a surface
  // the bootstrap does not answer gets no picker at all and cannot send, so
  // every surface the app can open must be answered with the same model list.
  assert.deepEqual(
    bootstrap.model_selector_config.map((entry) => entry.id),
    ["chat", "cowork", "code"],
  );
  assert.deepEqual(
    bootstrap.model_selector_state.map((entry) => entry.id),
    ["chat", "cowork", "code"],
    "states and configs agree surface for surface",
  );
  for (const entry of bootstrap.model_selector_config) {
    assert.ok(entry.models.some((m) => m.id === "stub-sonnet"), `models for ${entry.id}`);
  }
  // Every Code-relevant growthbook flag must be declared on a paid plan, in the
  // SDK shape the app's GrowthBookFeatureDefinition decodes ({ key, defaultValue,
  // rules }). The app's client hashes the flag name (base64(sha256(exact_key)),
  // "=" padding included) and looks it up in the features map, so the map must
  // be keyed by the hash — sha256("mobile_remote_enabled") is hard-coded here to
  // catch a truncation or padding change. The kill switch must stay off.
  const hashedKey = (name) => createHash("sha256").update(name, "utf8").digest("base64");
  const gb = bootstrap.org_growthbook.features;
  assert.equal(gb["/OPPJjAiEpYsGXP+aHJjqhqjyrSLYaaLpql/T6dzsQA="].key, "mobile_remote_enabled");
  assert.deepEqual(gb["/OPPJjAiEpYsGXP+aHJjqhqjyrSLYaaLpql/T6dzsQA="], { key: "mobile_remote_enabled", defaultValue: true, rules: [] });
  assert.deepEqual(gb[hashedKey("mobile_cowork_tab_enabled")], { key: "mobile_cowork_tab_enabled", defaultValue: true, rules: [] });
  assert.deepEqual(gb[hashedKey("claudeai_hub_code_sessions")], { key: "claudeai_hub_code_sessions", defaultValue: true, rules: [] });
  assert.deepEqual(gb[hashedKey("claudeai_projects_nav_kill_switch")], { key: "claudeai_projects_nav_kill_switch", defaultValue: false, rules: [] });
  assert.ok(Object.keys(gb).every((k) => hashedKey(gb[k].key) === k), "every feature is keyed by base64(sha256(its key))");
  assert.deepEqual(bootstrap.current_user_access.features, [{ feature: "claude_code_web", status: "available" }]);
  // Code access must be declared on all three access surfaces, and the seat
  // must be the claude_code_user role or the app never offers the Code tab.
  assert.deepEqual(bootstrap.current_user_access.account_features, [{ feature: "claude_code_web", status: "available" }]);
  assert.deepEqual(bootstrap.current_user_access.organization_permissions, [{ feature: "claude_code_web", status: "available" }]);
  assert.equal(account.memberships[0].role, "claude_code_user");
  assert.equal(bootstrap.account.memberships[0].role, "claude_code_user");

  // The Code tab loads four legs the moment it opens (CodeTabLoadResult):
  // the session list under /v1/, the environment (remote-device) list, the
  // projects list and the experiences banner feed. Each must answer 200 with
  // the envelope the app's Codable types decode, or the tab sits on its
  // skeleton. Shapes come from the app's Swift metadata; see
  // docs/mobile-code-re-findings.md.
  const sessionsLeg = await call("/v1/code/sessions?limit=30&statuses=active&statuses=paused&statuses=archived");
  assert.equal(sessionsLeg.status, 200, "the code session list leg answers");
  // Snake_case wire keys: the app's JSONDecoder runs .convertFromSnakeCase.
  assert.deepEqual(await sessionsLeg.json(), { data: [], next_cursor: null, resume_token: null });

  const environmentsLeg = await call(
    `/v1/environment_providers/private/organizations/${org.uuid}/environments?limit=50`,
    // The app scopes the read to its organization with `X-Organization-Uuid`
    // (and can narrow it with `included_worker_types`). Both must leave the full
    // set on the wire: the response is what fills the picker, and a filter the
    // facade cannot satisfy would empty it silently.
    { headers: { "x-organization-uuid": org.uuid, "anthropic-version": "ccr-byoc-2025-07-29" } },
  );
  assert.equal(environmentsLeg.status, 200, "the environment list leg answers");
  // Records back the same Desktop: the `anthropic_cloud` row the picker's
  // "Cloud environments" section needs (without it that section shows the
  // "Create a cloud environment to get started" onboarding state and a new
  // session cannot be started), the paired `bridge` device, and one `bridge`
  // environment per workspace folder (the remote folder picker's directories).
  // `anthropic_cloud` and `bridge` are the enums' literal raw values, not
  // snake-cased keys.
  const environmentList = await environmentsLeg.json();
  const environments = environmentList.environments;
  assert.equal(environments.length, 3);
  const cloud = environments.find((e) => e.kind === "anthropicCloud");
  const bridge = environments.find((e) => e.kind === "bridge");
  assert.ok(cloud, "the cloud environment the picker requires is offered");
  assert.equal(cloud.environment_id, "anthropic-cloud-local");
  // `config` decodes FLAT off the `environment_type` discriminator (its declared
  // CodingKeys hold only `environmentType`), so the payload sits beside that key.
  assert.equal(cloud.config.environment_type, "anthropic");
  assert.ok(bridge, "the paired Desktop is offered as a runner");
  assert.equal(bridge.environment_id, "anthropic-bridge-local");
  // `ConfigType` (the inner `environment_type`) has no `paired` member — the
  // case is `paired` but its payload reports the same `bridge` axis its `kind`
  // does; a literal "paired" would fail the whole EnvironmentConfiguration.
  assert.equal(bridge.config.environment_type, "bridge");
  assert.equal(bridge.bridge_info.spawn_mode, "same-dir");
  // A directory with a session must not read as "at capacity": the app gates the
  // new-session button on the directory's session count against this.
  assert.ok(bridge.bridge_info.max_sessions > 1, "directories are not capped at one session");
  // Each workspace folder is advertised as its own bridge environment, so the
  // app's remote folder picker (whose rows are `Folder { id: CodeEnvironmentTag }`)
  // lists the device's directories. They share the device's `machine_name`.
  const folderEnv = environments.find(
    (e) => e.kind === "bridge" && e.environment_id !== "anthropic-bridge-local",
  );
  assert.ok(folderEnv, "a workspace folder is offered as a bridge environment");
  assert.equal(folderEnv.name, "Claudesk");
  assert.equal(folderEnv.bridge_info.directory, "/workspace/Claudesk");
  assert.equal(folderEnv.config.directory, "/workspace/Claudesk");
  assert.equal(folderEnv.bridge_info.machine_name, bridge.bridge_info.machine_name, "folders share the device");
  // `first_id`/`last_id` bracket the returned order.
  assert.equal(environmentList.first_id, environments[0].environment_id);
  assert.equal(environmentList.last_id, environments.at(-1).environment_id);

  // The device the Code tab groups those directories under: a `RemoteDevice`
  // whose name matches the environments' `machine_name`.
  const devicesLeg = await call(`/api/organizations/${org.uuid}/cowork/remote_devices`);
  assert.equal(devicesLeg.status, 200);
  const deviceDirectory = await devicesLeg.json();
  assert.equal(deviceDirectory.devices.length, 1, "the paired Desktop is the device");
  assert.equal(deviceDirectory.devices[0].display_name, bridge.bridge_info.machine_name, "the device name matches machine_name");
  assert.equal(deviceDirectory.default_device.id, deviceDirectory.devices[0].id);


  // The by-id read resolves each advertised record.
  const cloudById = await call(
    `/v1/environment_providers/private/organizations/${org.uuid}/environments/anthropic-cloud-local`,
  );
  assert.equal(cloudById.status, 200);
  assert.equal((await cloudById.json()).kind, "anthropicCloud");

  // The detail screen resolves a folder environment's id back to its record.
  const folderById = await call(
    `/v1/environment_providers/private/organizations/${org.uuid}/environments/${encodeURIComponent(folderEnv.environment_id)}`,
  );
  assert.equal(folderById.status, 200, "the folder environment's by-id read answers");
  assert.equal((await folderById.json()).bridge_info.directory, "/workspace/Claudesk");

  // The app offers its Bypass/Auto permission rows only when the policy allows
  // them: `ModePolicy { allowed, managed }`.
  const permissionPolicy = await (await call(`/api/organizations/${org.uuid}/permission_mode_policy`)).json();
  assert.equal(permissionPolicy.bypass_permissions.allowed, true, "bypass permissions are offered");

  const experiencesLeg = await call(`/api/organizations/${org.uuid}/experiences`);
  assert.equal(experiencesLeg.status, 200, "the experiences banner leg answers");
  assert.deepEqual(await experiencesLeg.json(), { experiences: [], rules: { global: {}, placements: {} } });

  const projectsLeg = await call(`/api/organizations/${org.uuid}/projects`);
  assert.equal(projectsLeg.status, 200, "the projects leg answers");

  // An unauthenticated /v1/ request is rejected, not served as empty data.
  const anonymousSessions = await fetch(`${base}/v1/code/sessions`);
  assert.equal(anonymousSessions.status, 401, "the code legs require a session");

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
  // ModelEntry.thinking is ThinkingOptions, whose effortOptions and modeOptions
  // are BOTH non-optional and whose EffortOption.recommended is a non-optional
  // Bool. Desktop's catalog supplies neither guarantee — this stub carries no
  // `recommended` at all and is the shape that emptied the picker — so the
  // facade must normalise every entry and never pass a `badge` through (its
  // `Variant` enum's wire form is unproven and the field is optional).
  for (const surface of bootstrap.model_selector_config) {
    for (const model of surface.models) {
      if (!model.thinking) continue;
      assert.ok(Array.isArray(model.thinking.effort_options), `effort_options on ${model.id}`);
      assert.ok(Array.isArray(model.thinking.mode_options), `mode_options on ${model.id}`);
      assert.equal("badge" in model.thinking, false, `no thinking badge on ${model.id}`);
      for (const option of model.thinking.effort_options) {
        assert.equal(typeof option.recommended, "boolean", `recommended on ${model.id}/${option.id}`);
        assert.equal("badge" in option, false, `no effort badge on ${model.id}/${option.id}`);
      }
    }
  }
  assert.deepEqual(
    modelEntry("stub-sonnet").thinking.mode_options.map((option) => option.id),
    ["auto", "off"],
    "the mode options survive the normalisation",
  );
  assert.equal(
    modelEntry("stub-sonnet").thinking.effort_options.every((option) => option.recommended === false),
    true,
    "an effort option Desktop does not mark is not recommended, not absent",
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
  // `thinking_by_model` is an IdentifiedArray<ModelThinkingDefault> — an ARRAY
  // of {id, thinking}. It is decoded all-or-nothing alongside the rest of the
  // bootstrap, so the dictionary it used to be would take the whole model
  // selector (and with it the send path) down with it.
  assert.deepEqual(savedState.thinking_by_model, [{ id: "stub-sonnet", thinking: { effort: "xhigh", mode: "auto" } }]);
  const bootState = (await (await call(
    `/api/bootstrap/${org.uuid}/app_start?growthbook_format=sdk&include_system_prompts=false`,
  )).json()).model_selector_state[0];
  assert.equal(bootState.model, "stub-sonnet");
  assert.deepEqual(bootState.thinking, { effort: "xhigh", mode: "auto" }, "bootstrap reports the selected effort");
  assert.deepEqual(
    (await (await call(statePath)).json()).thinking_by_model,
    [{ id: "stub-sonnet", thinking: { effort: "xhigh", mode: "auto" } }],
  );
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

  // ---- the Code tab's session surface, end to end ----
  //
  // A Code session is a Desktop LocalSessions session; the facade addresses it
  // as code_<desktopId>. Everything below drives the fake bridge's real
  // LocalSessions handlers (scripts/lib/fake-claudesk.mjs), so a wrong argument
  // order or a dropped field fails here rather than on the phone.
  const codePath = (id, action = "") => `/v1/code/sessions/${id}${action}`;
  const sseStream = async (path, { method = "GET", body } = {}) => {
    const response = await call(path, { method, body });
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    return parseSse(await response.text());
  };

  // Create: the app posts a draft session and gets a `SessionResponseEnvelope`
  // — the list-row projection wrapped under `session`, NOT a bare SessionResource.
  const created = await call("/v1/code/sessions", { method: "POST", body: { title: "From the phone" } });
  assert.equal(created.status, 201, "create answers 201");
  const createdReply = await created.json();
  assert.ok(createdReply.session, "the create reply is `{session: …}` (SessionResponseEnvelope)");
  const createdResource = createdReply.session;
  assert.match(createdResource.id, /^code_[0-9a-f-]{36}$/, "a Code id is code_<desktopId>");
  assert.equal(typeof createdResource.status, "string");
  // WorkerStatus/SessionWorkerStatus is `idle` for a session whose turn is not
  // in flight yet.
  assert.equal(createdResource.worker_status, "idle");
  assert.equal(createdResource.connection_status, "connected");
  assert.equal(createdResource.environment_id, "anthropic-bridge-local");
  assert.ok(Object.keys(createdResource).every((key) => key === key.toLowerCase()), "no camelCase keys on the wire");
  const codeDesktopId = createdResource.id.slice("code_".length);

  // Send the first message: it creates the Desktop session (start), and the SSE
  // leg streams the turn as `client_event` frames (the same protocol the
  // transcript leg speaks — there is no separate ack record; the app decodes
  // the wire envelope into an internal `SessionSseFrame`).
  const sentUuid = "44444444-4444-4444-8444-444444444444";
  const sendRecords = await sseStream(codePath(createdResource.id, "/messages/stream"), {
    method: "POST",
    body: { body: "Reply with exactly one word: pong", client_message_id: sentUuid },
  });
  const sent = sendRecords.filter((record) => record.event === "client_event").map((record) => decodeClientEvent(record.data));
  assert.ok(sent.length);
  assert.equal(sent.find((row) => row.message.type === "user").message.uuid, sentUuid);
  const startCall = claudesk.codeIpcCalls("start").at(-1);
  assert.equal(startCall.args[0].sessionId, codeDesktopId);
  assert.equal(typeof startCall.args[0].cwd, "string");
  assert.equal(startCall.args[0].sessionType, undefined);
  await waitFor(() => claudesk.codeSessions.get(codeDesktopId)?.isRunning === false, "the code turn to finish");

  // ---- the repository picker decides the session's cwd ----
  //
  // The app attaches the picked repository as `config.sources`
  // ([SessionContextSource], `{ type: "git_repository", url, revision }`). The
  // facade must (a) resolve that to the workspace folder of the same name, (b)
  // run Desktop's `start` in it, and (c) echo the selection and the resolved cwd
  // back on the session DTOs, or the phone renders the repo-less
  // "Running in the shared directory" state.
  const repoSource = {
    type: "git_repository",
    url: "https://github.com/local/Claudesk",
    revision: "main",
  };
  const repoCreate = await call("/v1/code/sessions", {
    method: "POST",
    // `config.cwd` is the environment's default directory the app may echo; the
    // picked repository must win over it.
    body: { title: "Picked a repo", config: { cwd: "/workspace", sources: [repoSource] } },
  });
  assert.equal(repoCreate.status, 201, "a repo-backed create answers 201");
  const repoReply = (await repoCreate.json()).session;
  // The list-row projection echoes the app's own source encoding verbatim.
  assert.deepEqual(repoReply.config.sources, [repoSource], "the create reply reports the picked repository");
  // The session does not exist on Desktop until the first message, so the
  // resolved cwd is checked on the `start` call and on the detail read after it.
  await sseStream(codePath(repoReply.id, "/messages/stream"), {
    method: "POST", body: { body: "where am I" },
  });
  assert.equal(claudesk.codeIpcCalls("start").at(-1).args[0].cwd, "/workspace/Claudesk", "start runs in the picked repository");
  await waitFor(() => claudesk.codeSessions.get(repoReply.id.slice("code_".length))?.isRunning === false, "the repo turn to finish");
  const repoDetail = await (await call(codePath(repoReply.id))).json();
  assert.equal(repoDetail.session_context.cwd, "/workspace/Claudesk", "the repository resolves to its workspace folder");
  assert.deepEqual(repoDetail.session_context.sources, [repoSource], "the detail read reports the picked repository");
  // A session reports the environment of the directory it ran in, so the
  // device's directory list counts it under that folder, not the workspace root.
  assert.equal(repoDetail.environment_id, folderEnv.environment_id, "a folder session reports the folder environment");
  const rootDetail = await (await call(codePath(createdResource.id))).json();
  assert.equal(rootDetail.environment_id, "anthropic-bridge-local", "a workspace-root session reports the base device");

  // A `file://` source resolves to the exact path, not by name.
  const fileId = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { config: { sources: [{ type: "git_repository", url: "file:///srv/code/Demo" }] } },
  })).json()).session.id;
  await sseStream(codePath(fileId, "/messages/stream"), { method: "POST", body: { body: "hi" } });
  const fileDetail = await (await call(codePath(fileId))).json();
  assert.equal(fileDetail.session_context.cwd, "/srv/code/Demo", "a file:// source is an exact path");

  // `config.cwd` (a directory picked directly, with no repository) still wins.
  const cwdId = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { config: { cwd: "/workspace/Chosen" } },
  })).json()).session.id;
  await sseStream(codePath(cwdId, "/messages/stream"), { method: "POST", body: { body: "hi" } });
  const cwdDetail = await (await call(codePath(cwdId))).json();
  assert.equal(cwdDetail.session_context.cwd, "/workspace/Chosen", "config.cwd decides the session directory");

  // A folder picked in the remote folder picker arrives as the environment id;
  // the session runs in that environment's directory and reports the id back.
  const envCreates = await call("/v1/code/sessions", {
    method: "POST",
    body: { title: "Picked a folder", environment_id: folderEnv.environment_id },
  });
  const envReply = (await envCreates.json()).session;
  assert.equal(envReply.environment_id, folderEnv.environment_id, "the reply reports the picked folder environment");
  await sseStream(codePath(envReply.id, "/messages/stream"), { method: "POST", body: { body: "where am I" } });
  assert.equal(
    claudesk.codeIpcCalls("start").at(-1).args[0].cwd,
    "/workspace/Claudesk",
    "start runs in the picked folder environment's directory",
  );

  // The composer's model must reach `start`; stored only under the create draft
  // it was dropped and Desktop fell back to its default model on every send.
  const modelSession = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { config: { model: "stub-haiku" } },
  })).json()).session;
  await sseStream(codePath(modelSession.id, "/messages/stream"), { method: "POST", body: { body: "hi" } });
  assert.equal(claudesk.codeIpcCalls("start").at(-1).args[0].model, "stub-haiku", "the picked model reaches start");

  // The picked permission mode must reach `start` too, or the first turn
  // prompts even though the composer says "Bypass permissions".
  const permSession = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { permission_mode: "bypassPermissions" },
  })).json()).session;
  await sseStream(codePath(permSession.id, "/messages/stream"), { method: "POST", body: { body: "hi" } });
  assert.equal(claudesk.codeIpcCalls("start").at(-1).args[0].permissionMode, "bypassPermissions", "the permission mode reaches start");

  // The app's Code picker has no Bypass row, so its hands-off "Auto" maps to
  // Desktop's bypassPermissions — at `start` and on a mid-session change.
  const autoSession = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { permission_mode: "auto" },
  })).json()).session;
  await sseStream(codePath(autoSession.id, "/messages/stream"), { method: "POST", body: { body: "hi" } });
  assert.equal(claudesk.codeIpcCalls("start").at(-1).args[0].permissionMode, "bypassPermissions", "Auto maps to bypass at start");
  await call(codePath(autoSession.id), { method: "PATCH", body: { permission_mode: "auto" } });
  assert.equal(claudesk.codeIpcCalls("setPermissionMode").at(-1).args[1], "bypassPermissions", "Auto maps to bypass on a mode change");

  // The build under test sends its turns through `POST /events` (a `type:"user"`
  // client event), not `/messages/stream`. The facade must dispatch it to
  // Desktop, or the session never exists and every read 404s.
  const evSession = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { config: { cwd: "/workspace/Claudesk" } },
  })).json()).session;
  const evUuid = "99999999-9999-4999-8999-999999999999";
  const evBody = {
    session_id: evSession.id,
    events: [{ payload: { type: "user", uuid: evUuid, message: { role: "user", content: "hi from events" } } }],
  };
  const evPost = await call(codePath(evSession.id, "/events"), { method: "POST", body: evBody });
  assert.equal(evPost.status, 200, "the /events write leg accepts the turn");
  assert.equal(claudesk.codeIpcCalls("start").at(-1).args[0].cwd, "/workspace/Claudesk", "the /events turn runs in the folder");
  await waitFor(() => claudesk.codeSessions.get(evSession.id.slice("code_".length))?.isRunning === false, "the /events turn to finish");
  const evDetail = await (await call(codePath(evSession.id))).json();
  assert.equal(evDetail.environment_id, folderEnv.environment_id, "the /events turn reports its folder environment");
  // A retried batch re-posts the same client uuid; it must not dispatch twice.
  await call(codePath(evSession.id, "/events"), { method: "POST", body: evBody });
  assert.equal(
    claudesk.codeSessions.get(evSession.id.slice("code_".length)).transcript.filter((entry) => entry.uuid === evUuid).length,
    1,
    "a retried turn is not dispatched twice",
  );

  // These were created only for the cwd assertions; drop them so the list
  // leg below still sees exactly the one session it drives.
  for (const id of [repoReply.id, fileId, cwdId, envReply.id, evSession.id, modelSession.id, permSession.id, autoSession.id]) {
    await waitFor(() => claudesk.codeSessions.get(id.slice("code_".length))?.isRunning === false, "the cwd turn to finish");
    await call(codePath(id), { method: "DELETE" });
  }

  // HTTP data[] and SSE data: are the same SessionEventEnvelope DTO.
  const history = await (await call(codePath(createdResource.id, "/events?sort_order=desc&limit=50"))).json();
  const historyDecoded = decodeClientEventsResponse(history);
  assert.ok(historyDecoded.length >= 3);
  assert.deepEqual([...history.data].reverse().map((event) => event.sequence_num), history.data.map((_, i) => String(i + 1)));
  assert.equal(historyDecoded.at(-1).message.uuid, sentUuid);
  assert.equal(historyDecoded[0].message.message.content[0].text, "Echo: Reply with exactly one word: pong");
  assert.equal(history.rows, undefined, "ClientEventsPage.rows is an internal app model");
  const olderPage = await (await call(codePath(createdResource.id, "/events?sort_order=desc&limit=2"))).json();
  assert.equal(olderPage.data.length, 2);
  assert.ok(olderPage.next_cursor);
  const oldest = await (await call(codePath(createdResource.id, `/events?sort_order=desc&cursor=${encodeURIComponent(olderPage.next_cursor)}`))).json();
  assert.equal(Number(oldest.data[0].sequence_num), Number(olderPage.data.at(-1).sequence_num) - 1);
  assert.equal(oldest.next_cursor, null);

  await sseStream(codePath(createdResource.id, "/messages/stream"), {
    method: "POST", body: { body: "List the files [tool]" },
  });
  await waitFor(() => claudesk.codeSessions.get(codeDesktopId)?.isRunning === false, "the tool turn to finish");
  const withTool = await (await call(codePath(createdResource.id, "/events?sort_order=desc&limit=50"))).json();
  const withToolDecoded = decodeClientEventsResponse(withTool);
  const toolBlocks = withToolDecoded.flatMap(({ message }) => Array.isArray(message.message?.content) ? message.message.content : []);
  const toolUse = toolBlocks.find((block) => block.type === "tool_use");
  const toolResult = toolBlocks.find((block) => block.type === "tool_result");
  assert.equal(toolUse.name, "mcp__workspace__bash");
  assert.equal(toolUse.input.command, "ls");
  assert.equal(toolResult.tool_use_id, toolUse.id);

  async function readStreamRecords(reader, count, event) {
    const decoder = new TextDecoder();
    let buffer = "";
    let records = [];
    const timeout = setTimeout(() => reader.cancel().catch(() => {}), 5000);
    try {
      while (records.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // A network chunk need not end at an SSE record boundary.
        const boundary = buffer.lastIndexOf("\n\n");
        const complete = boundary < 0 ? "" : buffer.slice(0, boundary + 2);
        records = parseSse(complete).filter((record) => !event || record.event === event);
      }
      assert.ok(records.length >= count, "the stream produced the expected events before timeout");
      return records;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function readClientEvents(reader, count) {
    const records = await readStreamRecords(reader, count, "client_event");
    records.forEach((record) => decodeClientEvent(record.data));
    return records;
  }
  const streamResponse = await call(codePath(createdResource.id, "/events/stream?from_sequence_num=0"));
  assert.equal(streamResponse.status, 200);
  const streamReader = streamResponse.body.getReader();
  try {
    const streamed = await readClientEvents(streamReader, withTool.data.length);
    assert.deepEqual(streamed.map((record) => record.data), [...withTool.data].reverse(), "history and SSE agree byte-for-byte");
  } finally { await streamReader.cancel(); }

  const resumedResponse = await call(codePath(createdResource.id, "/events/stream?from_sequence_num=1"));
  const resumedReader = resumedResponse.body.getReader();
  try {
    const resumed = await readClientEvents(resumedReader, withTool.data.length - 1);
    assert.equal(resumed[0].data.sequence_num, "2", "from_sequence_num is exclusive");
    assert.deepEqual(resumed.map((record) => record.data), [...withTool.data].reverse().slice(1));
  } finally { await resumedReader.cancel(); }

  // Opening an existing session and then sending must continue after its
  // history, including when GET and POST streams subscribe simultaneously.
  const lastSequence = Number(withTool.data[0].sequence_num);
  const followResponse = await call(codePath(createdResource.id, `/events/stream?from_sequence_num=${lastSequence}`));
  const followReader = followResponse.body.getReader();
  try {
    // Regression: the phone resumes at the history tail and cannot send until
    // connected. Require a real initial frame BEFORE generating a new turn.
    // A 200 response alone (or the 15-second comment heartbeat) is insufficient.
    const initial = await readStreamRecords(followReader, 1);
    assert.deepEqual(initial, [{ event: "session_update", data: { connection_status: "connected" } }]);
    const following = readClientEvents(followReader, 3);
    const liveSend = await sseStream(codePath(createdResource.id, "/messages/stream"), {
      method: "POST", body: { body: "Live after history" },
    });
    const followed = await following;
    const liveSent = liveSend.filter((record) => record.event === "client_event");
    assert.deepEqual(followed.map((record) => record.data), liveSent.map((record) => record.data));
    assert.deepEqual(followed.map((record) => record.data.sequence_num), [1, 2, 3].map((n) => String(lastSequence + n)));
    const finalHistory = await (await call(codePath(createdResource.id, "/events?limit=3"))).json();
    assert.deepEqual([...finalHistory.data].reverse(), followed.map((record) => record.data));
  } finally { await followReader.cancel(); }

  // The same initial frame is needed when a Desktop session has no history.
  const emptyCode = claudesk.addCodeSession();
  const emptyCodeId = `code_${emptyCode.sessionId}`;
  const emptyResponse = await call(codePath(emptyCodeId, "/events/stream?from_sequence_num=0"));
  assert.equal(emptyResponse.status, 200);
  const emptyReader = emptyResponse.body.getReader();
  try {
    assert.deepEqual(await readStreamRecords(emptyReader, 1), [
      { event: "session_update", data: { connection_status: "connected" } },
    ]);
    const emptyHistory = await (await call(codePath(emptyCodeId, "/events"))).json();
    assert.deepEqual(emptyHistory.data, [], "opening a stream must not invent transcript events");
  } finally {
    await emptyReader.cancel();
    await call(codePath(emptyCodeId), { method: "DELETE" });
  }

  // The build under test sends turns over POST /events while reading this
  // stream: opening the stream and then POSTing the user event must deliver the
  // turn live (user + assistant client_event frames), not only into history.
  const liveEv = (await (await call("/v1/code/sessions", {
    method: "POST",
    body: { config: { cwd: "/workspace/Claudesk" } },
  })).json()).session;
  const liveEvResponse = await call(codePath(liveEv.id, "/events/stream?from_sequence_num=0"));
  assert.equal(liveEvResponse.status, 200, "the events stream opens for a session that does not exist yet");
  const liveEvReader = liveEvResponse.body.getReader();
  try {
    assert.deepEqual(await readStreamRecords(liveEvReader, 1), [
      { event: "session_update", data: { connection_status: "connected" } },
    ]);
    const arriving = readClientEvents(liveEvReader, 3);
    const liveUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await call(codePath(liveEv.id, "/events"), {
      method: "POST",
      body: { session_id: liveEv.id, events: [{ payload: { type: "user", uuid: liveUuid, message: { role: "user", content: "live over events" } } }] },
    });
    const arrived = await arriving;
    assert.ok(arrived.length >= 3, "the POSTed turn is delivered on the open stream");
    assert.equal(arrived[0].data.event_type, "user");
    assert.equal(arrived[0].data.event_id, liveUuid);
    assert.ok(arrived.some((record) => record.data.event_type === "assistant"), "the reply streams live");
    arrived.forEach((record) => decodeClientEvent(record.data));

    // A follow-up goes through `sendMessage`, whose `messageUuid` is the EIGHTH
    // positional argument — a wrong index puts it in the `attachments` slot and
    // Desktop rejects the call (the 502 on every second message).
    const followUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const followUp = await call(codePath(liveEv.id, "/events"), {
      method: "POST",
      body: { session_id: liveEv.id, events: [{ payload: { type: "user", uuid: followUuid, message: { role: "user", content: "and again" } } }] },
    });
    assert.equal(followUp.status, 200, "a follow-up message is accepted");
    await waitFor(() => claudesk.codeSessions.get(liveEv.id.slice("code_".length))?.isRunning === false, "the follow-up turn");
    assert.ok(
      claudesk.codeSessions.get(liveEv.id.slice("code_".length)).transcript.some((entry) => entry.uuid === followUuid),
      "the follow-up reached Desktop",
    );
  } finally {
    await liveEvReader.cancel();
    await waitFor(() => claudesk.codeSessions.get(liveEv.id.slice("code_".length))?.isRunning === false, "the live events turn");
    await call(codePath(liveEv.id), { method: "DELETE" });
  }

  // The list leg now reports the session, with the app's enum values.
  const codeListed = await (await call("/v1/code/sessions")).json();
  assert.equal(codeListed.data.length, 1);
  assert.equal(codeListed.data[0].id, createdResource.id);
  // The row's `status` is SessionLifecycleStatus (active | archived | …), a
  // different axis from the detail record's `session_status` and from the
  // `status_bucket` the list groups by.
  assert.equal(codeListed.data[0].status, "active");
  assert.equal(codeListed.data[0].status_bucket, "completed");

  // The app's list filter vocabulary (`active|paused|archived`) is a different
  // axis from a row's `status`; comparing them directly emptied the list. An
  // `active` filter must keep a non-archived session, and `archived` must drop it.
  const activeFiltered = await (await call("/v1/code/sessions?statuses=active")).json();
  assert.equal(activeFiltered.data.length, 1, "an `active` filter keeps a live session");
  const archivedFiltered = await (await call("/v1/code/sessions?statuses=archived")).json();
  assert.equal(archivedFiltered.data.length, 0, "an `archived` filter drops a live session");
  const bothFiltered = await (await call("/v1/code/sessions?statuses=active&statuses=archived")).json();
  assert.equal(bothFiltered.data.length, 1, "repeated statuses are OR-ed, not AND-ed");

  // The watch leg pushes a frame per change; drive a turn and read one live.
  const watchPromise = call(codePath(createdResource.id, "/watch"));
  const watchRecordsPromise = watchPromise.then(async (response) => {
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const records = parseSse(buffer);
        // The turn's own frames arrive after the hello record.
        const upserted = records.find((record) => record.event === "upserted");
        if (upserted) return upserted;
      }
      return null;
    } finally {
      reader.cancel().catch(() => {});
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await sseStream(codePath(createdResource.id, "/messages/stream"), {
    method: "POST",
    body: { body: "Watch this [tool]" },
  });
  const liveFrame = await watchRecordsPromise;
  assert.ok(liveFrame, "the watch leg streams a frame for the live turn");
  // The SSE `event:` is `upserted` and its `data` is the whole SessionResource
  // (the app keys the payload type off the event name).
  assert.equal(liveFrame.data.id, createdResource.id, "a live frame upserts the session it names");

  // Stop goes to LocalSessions.interrupt with the unprefixed id.
  const stopped = await call(codePath(createdResource.id, "/interrupt"), { method: "POST", body: {} });
  assert.equal(stopped.status, 200);
  assert.equal(claudesk.codeIpcCalls("interrupt").at(-1).args[0], codeDesktopId);

  // A permission prompt: the session goes to requires_action, the prompt is
  // listed, and answering it resumes the turn.
  const manualId = "99999999-9999-4999-8999-999999999999";
  const manual = claudesk.addCodeSession({ sessionId: manualId, title: "Needs approval" });
  manual.transcript.push({
    uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "user",
    message: { role: "user", content: "Run something [permission]" },
    origin: { kind: "human" },
    turnOrigin: "human",
    timestamp: new Date().toISOString(),
    parentUuid: null,
    isSidechain: false,
  });
  const manualCodeId = `code_${manualId}`;
  await sseStream(codePath(manualCodeId, "/messages/stream"), {
    method: "POST",
    body: { body: "Run something [permission]" },
  }).catch(() => []);
  await waitFor(() => claudesk.codeIpcCalls("sendMessage").some((call) => call.args[0] === manualId), "the permission turn to dispatch");
  // The prompt arrives on the events stream, so give the listener a moment.
  await waitFor(async () => (await (await call(codePath(manualCodeId, "/pending_prompts"))).json()).prompts.length > 0,
    "the permission prompt to be recorded");
  const prompts = await (await call(codePath(manualCodeId, "/pending_prompts"))).json();
  assert.equal(prompts.prompts[0].session_id, manualCodeId);
  const blocked = await (await call(codePath(manualCodeId))).json();
  assert.equal(blocked.session_status, "requires_action", "an open prompt blocks the session");
  assert.equal(blocked.status_bucket, "blocked");
  const answered = await call(
    codePath(manualCodeId, `/permissions/${encodeURIComponent(prompts.prompts[0].request_id)}`),
    { method: "POST", body: { behavior: "allow" } },
  );
  assert.equal(answered.status, 200);
  // Desktop's signature is `(requestId, decision)` — requestId FIRST, no
  // sessionId — and the decision is one of once | always | deny.
  const respondCall = claudesk.codeIpcCalls("respondToToolPermission").at(-1);
  assert.equal(respondCall.args[0], prompts.prompts[0].request_id, "requestId is the first argument");
  assert.equal(respondCall.args[1], "once", "the app's 'allow' maps to Desktop's 'once'");
  assert.equal(respondCall.args.length, 2, "…and no sessionId is sent");
  await waitFor(async () => (await (await call(codePath(manualCodeId, "/pending_prompts"))).json()).prompts.length === 0,
    "the prompt to clear once answered");

  // Detail, patch and delete round out the lifecycle.
  const codePatched = await (await call(codePath(createdResource.id), { method: "PATCH", body: { title: "Renamed" } })).json();
  assert.equal(codePatched.title, "Renamed");
  assert.equal(claudesk.codeIpcCalls("updateSession").at(-1).args[1].title, "Renamed");
  const codeDeleted = await call(codePath(manualCodeId), { method: "DELETE" });
  assert.equal(codeDeleted.status, 200);
  assert.ok(!claudesk.codeSessions.has(manualId), "delete removes the Desktop session");

  // The fake bridge now reproduces Desktop's own argument validation, so the
  // shape bugs that only the live bridge used to catch fail here instead. These
  // two guard the contract directly: a start without `cwd` is rejected, and a
  // permission decision outside once|always|deny is rejected.
  const badStart = await fetch(`${claudesk.url}/api/remote/ipc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "LocalSessions", method: "start", args: [{ message: "no cwd" }] }),
  }).then((r) => r.json());
  assert.match(badStart.error, /failed to pass validation/, "a start without cwd fails validation like Desktop");
  const badDecision = await fetch(`${claudesk.url}/api/remote/ipc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "LocalSessions", method: "respondToToolPermission", args: ["req_x", "allow"] }),
  }).then((r) => r.json());
  assert.match(badDecision.error, /invalid permission decision/, "a raw 'allow' decision is refused");

  // The out-of-scope legs answer 200 with empty envelopes, not 404s, so those
  // screens render empty states instead of errors.
  for (const leg of ["channels", "triggers", "webhook-triggers", "runners/self-hosted/pools"]) {
    const response = await call(`/v1/code/${leg}`);
    assert.equal(response.status, 200, `${leg} answers`);
    assert.deepEqual(await response.json(), { data: [], next_cursor: null });
  }
  assert.equal((await call("/v1/code/shared-sessions")).status, 200);

  // The git legs are reached with POST as well as GET (`get-batch-branch-status`
  // takes the refs in its body); both must answer the empty envelope, because a
  // 404 on this leg is what surfaced as "Something went wrong" on the detail
  // screen's PR row.
  //
  // `has_more` is required and `next_cursor` is not read: the type behind these
  // legs is `GithubBranchListResponse` = `data` + `hasMore`, so the envelope
  // without `has_more` that used to be sent here failed to decode and threw
  // `ModelDecodingError`, taking session creation down with it. Asserted as a
  // shape rather than a status, because a 200 that cannot decode is the failure
  // mode this leg actually had.
  for (const method of ["GET", "POST"]) {
    const response = await call("/v1/code/github/get-batch-branch-status", {
      method,
      body: method === "POST" ? { refs: [{ repo: "o/r", ref: "main" }] } : undefined,
    });
    assert.equal(response.status, 200, `github get-batch-branch-status answers to ${method}`);
    const body = await response.json();
    // The branch-list pair the type actually requires...
    assert.deepEqual({ data: body.data, has_more: body.has_more }, { data: [], has_more: false });
    // ...and the fields the *other* types behind this family require, which is
    // the point of one body serving them all: which one a leg carries is
    // inferred from the binary, so a body shaped for one is a decode failure
    // for the next. A 200 that cannot decode is what this leg had, not a 404.
    for (const key of ["owner", "base_branch", "head_branch", "files", "checks", "review_requests"]) {
      assert.ok(key in body, `github body carries ${key} for the other response types`);
    }
  }
  // The by-id form of the same family, which is the leg session creation dies on.
  const branchList = await call("/v1/code/github/some-repo-id");
  const byId = await branchList.json();
  assert.deepEqual({ data: byId.data, has_more: byId.has_more }, { data: [], has_more: false });
  assert.equal(byId.name, "some-repo-id", "a repo read gets the id it asked about");

  // The app pushes its own client events to the collection it reads history
  // from. The facade has no upstream to forward them to, but a 404 here broke
  // the detail screen, so it must be accepted and discarded.
  const pushedEvents = await call(codePath(createdResource.id, "/events"), {
    method: "POST",
    body: { events: [{ kind: "load_events" }] },
  });
  assert.equal(pushedEvents.status, 200, "client events are accepted, not 404");
  assert.deepEqual(await pushedEvents.json(), {});

  // The by-id environment read resolves the same single bridge device the list
  // advertises; an unknown id is a real 404.
  const environmentById = await call(
    `/v1/environment_providers/private/organizations/${org.uuid}/environments/anthropic-bridge-local`,
  );
  assert.equal(environmentById.status, 200, "the by-id environment read answers");
  const environmentResource = await environmentById.json();
  assert.equal(environmentResource.environment_id, "anthropic-bridge-local");
  assert.equal(environmentResource.kind, "bridge");
  assert.equal(
    (await call(`/v1/environment_providers/private/organizations/${org.uuid}/environments/nope`)).status,
    404,
    "an unknown environment id is still a 404",
  );

  // The org usage card. Its windows are the UsageResponse `limits` list; every
  // window reports zero utilization on an unmetered self-hosted deployment.
  const usage = await call(`/api/organizations/${org.uuid}/usage`);
  assert.equal(usage.status, 200, "the org usage leg answers");
  const usageBody = await usage.json();
  assert.ok(Array.isArray(usageBody.limits) && usageBody.limits.length > 0, "usage carries windows");
  for (const limit of usageBody.limits) {
    assert.equal(limit.utilization, 0, "every usage window reports zero utilization");
    assert.equal(limit.surpassed_threshold, false);
    assert.ok(limit.period && limit.limit_scope, "each window names its period and scope");
  }
  assert.ok(usageBody.spend && usageBody.extra_usage, "usage carries the credit blocks");

  // Code sessions must never leak into the Chat surface, and vice versa.
  const chatsAfter = await (await call(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=50&offset=0`)).json();
  assert.ok(chatsAfter.data.every((item) => !String(item.uuid).startsWith("code_")), "Code sessions stay out of the chat list");

  // ---- channels: the same conversation addressed as a claude.ai channel ----
  // A newer client reads a Code conversation as a channel whose id is the
  // session id (ChannelMessagesApi.swift). Every channel read must carry the
  // keys its response type declares non-optional, and the message stream must
  // be SSE — a JSON body there is a shape the thread screen cannot decode.
  const channelSession = (await (await call("/v1/code/sessions", { method: "POST", body: { title: "Channel" } })).json()).session;
  const channelPath = (action = "") => `/v1/code/channels/${channelSession.id}${action}`;

  const channel = await (await call(channelPath())).json();
  assert.ok("storage" in channel && "name" in channel, "Channel carries its non-optional storage and name");
  assert.deepEqual((await (await call(channelPath("/threads"))).json()).sections, []);
  const channelPrs = await (await call(channelPath("/pull_requests"))).json();
  for (const key of ["data", "next_cursor", "total", "truncated", "source"]) {
    assert.ok(key in channelPrs, `ChannelPullRequestsPage carries ${key}`);
  }
  const channelArtifacts = await (await call(channelPath("/artifacts"))).json();
  assert.ok("total" in channelArtifacts && "truncated" in channelArtifacts);
  assert.deepEqual((await (await call(channelPath("/files"))).json()).entries, []);

  // The send leg is NOT a stream despite the path. The app decodes its body as
  // `SendChannelMessageResponse` (`messageId?`, `threadRootId?`, `createdAt?`,
  // all optional), the DTO `MockSessionsApi.sendChannelMessageHandler` returns;
  // answering with `text/event-stream` here is what made the composer throw
  // ModelDecodingError. The turn itself arrives on the GET subscription.
  const channelSend = await call(channelPath("/messages/stream?scope=timeline"), {
    method: "POST",
    body: { body: "Reply with exactly one word: pong", client_message_id: "77777777-7777-4777-8777-777777777777" },
  });
  assert.equal(channelSend.status, 200, "the channel send answers 200");
  assert.match(channelSend.headers.get("content-type") || "", /^application\/json/, "the send body is JSON, not SSE");
  const channelAck = await channelSend.json();
  for (const key of Object.keys(channelAck)) {
    assert.ok(["message_id", "thread_root_id", "created_at"].includes(key),
      `SendChannelMessageResponse has no field ${key}`);
  }

  // The turn arrives as `channel_message_updated` frames on the timeline
  // subscription, each of which decodes as a full `ChannelMessage`.
  const channelStreamResponse = await call(channelPath("/messages/stream?scope=timeline"));
  assert.equal(channelStreamResponse.status, 200);
  const channelFrames = (await readStreamRecords(channelStreamResponse.body.getReader(), 1, "channel_message_updated"))
    .map((record) => decodeChannelStreamFrame(record.event, record.data));
  assert.ok(channelFrames.length, "the channel stream carries the turn");
  assert.ok(channelFrames.some((frame) => frame.body === "Reply with exactly one word: pong"),
    "the user message body is carried on the channel stream");
  const channelDesktopId = channelSession.id.slice("code_".length);
  await waitFor(() => claudesk.codeSessions.get(channelDesktopId)?.isRunning === false, "the channel turn to finish");

  // The timeline read returns the same transcript the session leg serves, as
  // `ChannelTimelineResponse.data` — the same nine-key ChannelMessage.
  const channelTimeline = await (await call(channelPath("/messages?scope=timeline"))).json();
  assert.ok(Array.isArray(channelTimeline.data) && channelTimeline.data.length >= 2,
    "the channel timeline returns the transcript as ChannelMessage[]");
  channelTimeline.data.forEach(decodeChannelMessage);
  assert.ok(channelTimeline.data.some((message) => message.body === "Reply with exactly one word: pong"));

  // The Frida probe's report sink is not part of the app's API: it exists only
  // when a token is configured, and then only for a caller that presents it.
  // Everything else must look like the route is not there.
  const diagBody = { kind: "throw", seq: 7, payload: { frames: ["Claude+0x1"] } };
  assert.equal((await call("/__diag", { method: "POST", body: diagBody })).status, 404,
    "the diag sink is closed without the token");
  assert.equal((await call("/__diag", {
    method: "POST", body: diagBody, headers: { "x-claudesk-diag": "wrong" },
  })).status, 404, "the diag sink rejects a wrong token");
  assert.equal((await call("/__diag", {
    method: "POST", body: diagBody, headers: { "x-claudesk-diag": "smoke-diag-token" },
  })).status, 200, "the diag sink accepts the configured token");

  console.log("mobile-api-smoke: PASS");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await claudesk.close();
}
process.exit(0);
