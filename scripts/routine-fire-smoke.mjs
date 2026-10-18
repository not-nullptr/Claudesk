// Routine triggers: the bridge-side service and the HTTP entry point.
//
// The service half drives the real module with a fake Desktop IPC and a fake
// runner pool, so the session-start arguments, the prompt merge, the token
// store and the fire limits are checked without Electron. The HTTP half boots
// the bridge against a stub internal bridge and calls the same routes an
// external caller (and the routines pages) use.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createRoutineService,
  instructionsFromJobConfig,
  promptBody,
  routineIdForTaskId,
  taskIdForRoutineId,
} from "../bridge/routines.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "routine-fire-"));
// A 1×1 PNG; the bytes are never decoded here, only carried.
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// --- the service, with a fake Desktop and runner ---------------------------

const coworkTask = {
  id: "cowork-1",
  displayName: "Morning brief",
  filePath: "/home/app/Claude/Scheduled/cowork-1/SKILL.md",
  cronExpression: "0 9 * * *",
  enabled: true,
  model: "model-a",
  permissionMode: "auto",
  userSelectedFiles: [],
  userSelectedFolders: ["/workspace"],
  spaceId: "space-1",
};
const codeTask = {
  id: "code-1",
  displayName: "Fix the build",
  filePath: "/config/.claude/scheduled-tasks/code-1/SKILL.md",
  enabled: true,
  model: "model-a",
  cwd: "/workspace/repo",
};
const files = {
  "cowork-1": "---\nname: Morning brief\ndescription: say hi\n---\nSummarize yesterday.\n",
  "code-1": "---\nname: Fix the build\n---\nFix the failing test.\n",
};

function fakeDesktop(tasks, content) {
  const calls = [];
  return {
    calls,
    async invoke(surface, method, args) {
      calls.push({ surface, method, args });
      if (surface === "CoworkScheduledTasks" && method === "getAllScheduledTasks") {
        return tasks();
      }
      if (surface === "CoworkScheduledTasks" && method === "getScheduledTaskFileContent") {
        return content()[args[0]] ?? null;
      }
      if (surface === "LocalAgentModeSessions" && method === "start") {
        return { sessionId: args[0].sessionId };
      }
      if (surface === "CoworkScheduledTasks" && method === "updateScheduledTaskStatus") {
        return true;
      }
      return null;
    },
    async inspect() {
      return {
        CoworkScheduledTasks: [
          "getAllScheduledTasks", "getScheduledTaskFileContent",
          "updateScheduledTaskStatus",
        ],
      };
    },
  };
}

const created = [];
let woke = 0;
const codeRunners = {
  async primaryPool() {
    return { pool_id: "ccpool_test", name: "test" };
  },
  async createSession({ body, source }) {
    created.push({ body, source });
    return { session: { id: "cse_created" } };
  },
};

let currentTasks = [coworkTask, codeTask];
const desktop = fakeDesktop(() => currentTasks, () => files);
const service = createRoutineService({
  stateDir: join(home, "state"),
  desktop,
  codeRunners,
  configuredModels: ["model-a"],
  defaultModel: "model-a",
  wakeRunner: () => { woke += 1; },
  log: { log() {}, warn() {} },
});

assert.equal(promptBody(files["cowork-1"]), "Summarize yesterday.",
  "the SKILL.md frontmatter is metadata, not instructions");
assert.equal(taskIdForRoutineId(routineIdForTaskId("a/b c")), "a/b c",
  "a routine id round-trips its task id");

const listed = await service.listTriggers();
assert.equal(listed.data.length, 2);
assert.ok(listed.data.every((trigger) => trigger.prompt === undefined),
  "the list does not read every task file");
const coworkId = routineIdForTaskId("cowork-1");
const codeId = routineIdForTaskId("code-1");
const coworkTrigger = (await service.getTrigger(coworkId)).trigger;
assert.equal(coworkTrigger.prompt, "Summarize yesterday.");
assert.equal(instructionsFromJobConfig(coworkTrigger.job_config), "Summarize yesterday.",
  "the detail carries the instructions in the runner-job shape its page reads");

// The Code form does not send a flat `prompt`: it creates and edits through
// the cloud runner job (`job_config.ccr.events`). Its instructions are the
// opening querying user event, which the Desktop's own parser reads too.
const cloudCreate = {
  name: "test routine",
  persist_session: false,
  job_config: {
    ccr: {
      self_hosted_runner_pool_id: "ccpool_99819d0b57b2c6145219b01e969fe974",
      session_context: {
        allowed_tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        sources: [],
        outcomes: [],
        model: null,
      },
      events: [{
        data: {
          uuid: "991f4379-4ed1-4915-abc2-fb8244ee80fb",
          session_id: "",
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: "Do not output anything else other than what is specified:\n"
              + "- Current working directory\n- Current user",
          },
        },
      }],
    },
  },
  mcp_connections: [],
  clear_mcp_connections: true,
};
assert.equal(instructionsFromJobConfig(cloudCreate.job_config),
  "Do not output anything else other than what is specified:\n"
    + "- Current working directory\n- Current user");
assert.equal(instructionsFromJobConfig({ ccr: { events: [
  { data: { shouldQuery: false, message: { role: "user", content: "skip me" } } },
  { data: { message: { role: "user", content: [
    { type: "text", text: "first line" },
    { type: "image", source: {} },
    { type: "text", text: "second line" },
  ] } } },
] } }), "first line\nsecond line",
"content blocks join the way the Desktop's own form parser joins them");

const routineFiles = {};
const routineTasks = [];
let lastUpdate;
const createDesktop = {
  async invoke(surface, method, args) {
    if (method === "getAllScheduledTasks") {
      return surface === "CCDScheduledTasks"
        ? [codeTask, ...routineTasks] : [coworkTask];
    }
    // The Code form's job_config creates in the Code store; its task file is
    // under the Claude config's `scheduled-tasks` tree, which is what makes a
    // fire a Code session.
    if (surface === "CCDScheduledTasks" && method === "createScheduledTask") {
      const [params] = args;
      const task = {
        id: "cloud-1",
        displayName: params.displayName,
        filePath: "/config/.claude/scheduled-tasks/cloud-1/SKILL.md",
        enabled: true,
      };
      routineTasks.push(task);
      routineFiles[task.id] = `---\nname: ${params.name}\n---\n${params.prompt}\n`;
      return task;
    }
    if (method === "getScheduledTaskFileContent") return routineFiles[args[0]] ?? null;
    if (surface === "CCDScheduledTasks" && method === "updateScheduledTask") {
      lastUpdate = args[0];
      if (lastUpdate.prompt !== undefined) {
        routineFiles["cloud-1"] = `---\nname: test-routine\n---\n${lastUpdate.prompt}\n`;
      }
      return routineTasks[0];
    }
    return null;
  },
  async inspect() {
    return {
      CCDScheduledTasks: [
        "createScheduledTask", "getAllScheduledTasks", "getScheduledTaskFileContent",
        "updateScheduledTask",
      ],
    };
  },
};
const createRuns = [];
const createCodeRunners = {
  async primaryPool() {
    return { pool_id: "ccpool_created", name: "created" };
  },
  async createSession({ body, source }) {
    createRuns.push({ body, source });
    return { session: { id: "cse_cloud" } };
  },
};
const creator = createRoutineService({
  stateDir: join(home, "create"),
  desktop: createDesktop,
  codeRunners: createCodeRunners,
  configuredModels: ["model-a"],
  defaultModel: "model-a",
  log: { log() {}, warn() {} },
});
const createdTrigger = await creator.createTrigger(cloudCreate);
assert.equal(createdTrigger.trigger.prompt,
  "Do not output anything else other than what is specified:\n"
    + "- Current working directory\n- Current user",
  "the Code form's instructions reach the scheduled task");
assert.equal(createdTrigger.trigger.name, "test routine");
assert.equal(createdTrigger.trigger.kind, "code",
  "the Code form creates a Code routine, not a Cowork one");
assert.equal(instructionsFromJobConfig(createdTrigger.trigger.job_config),
  "Do not output anything else other than what is specified:\n"
    + "- Current working directory\n- Current user",
  "the created routine's detail shows the instructions it runs");
const creatorList = await creator.listTriggers();
assert.equal(creatorList.data.some((routine) => routine.name === "Morning brief"), false,
  "Cowork scheduled tasks are not routines");

const edited = await creator.updateTrigger(createdTrigger.trigger.id, {
  name: "test routine",
  job_config: { ccr: { events: [{
    data: { message: { role: "user", content: "List the modified files." } },
  }] } },
});
assert.equal(lastUpdate.prompt, "List the modified files.",
  "editing the Code form updates the task's instructions");
assert.equal(edited.trigger.prompt, "List the modified files.");
assert.equal(instructionsFromJobConfig(edited.trigger.job_config), "List the modified files.",
  "the detail re-sent after an edit shows the new instructions");

// Firing a Code-form routine starts a Code session, not a Cowork one, and
// attributes it to the routine the run-history page asks for.
const codeFire = await creator.fireRoutine(createdTrigger.trigger.id, {});
assert.equal(codeFire.kind, "code");
assert.equal(codeFire.sessionId, "cse_cloud");
assert.equal(createRuns.at(-1).body.trigger_id, createdTrigger.trigger.id);
assert.equal(createRuns.at(-1).body.origin, "fire_routine");
assert.deepEqual(createRuns.at(-1).body.config.sources, []);

// Membership: a token names one routine, and rotation replaces the old hash.
const minted = await service.mintToken(coworkId, {});
assert.match(minted.token, /^sk-ant-oat01-/);
assert.deepEqual(await service.verifyToken(minted.token), { routineId: coworkId });
assert.equal(await service.verifyToken(`${minted.token}x`), null);
assert.ok((await service.getTrigger(coworkId)).trigger.api_token_hint,
  "the detail reports that a token exists");
assert.equal((await service.getTrigger(codeId)).trigger.api_token_hint, undefined);
await service.mintToken(coworkId, {});
assert.equal(await service.verifyToken(minted.token), null,
  "a rotated token no longer verifies");
assert.deepEqual(await service.revokeToken(coworkId, {}), {});
assert.equal(await service.verifyToken(minted.token), null);

// Firing a Cowork task starts it exactly as Run now does: the saved prompt,
// attributed to the task, with the caller's text appended and nothing else
// overriding the task's own settings.
const coworkFired = await service.fireRoutine(coworkId, { text: "Sentry SEN-1" });
assert.equal(coworkFired.kind, "cowork");
const coworkStart = desktop.calls.filter((call) =>
  call.surface === "LocalAgentModeSessions" && call.method === "start").at(-1).args[0];
assert.equal(coworkStart.message,
  "Summarize yesterday.\n\n---\nAdditional context for this run:\nSentry SEN-1");
assert.equal(coworkStart.sessionType, "cowork");
assert.equal(coworkStart.scheduledTaskId, "cowork-1");
assert.equal(coworkStart.scheduledTaskManualStart, true);
assert.equal(coworkStart.model, "model-a");
assert.equal(coworkStart.spaceId, "space-1");
assert.deepEqual(coworkStart.userSelectedFolders, ["/workspace"]);

// Images (a Claudesk extension) ride the same start call in the Desktop's own
// shape, so the Cowork session opens with them attached.
await service.fireRoutine(coworkId, {
  text: "see screenshot",
  images: [{ media_type: "image/png", data: tinyPng }],
});
const imageStart = desktop.calls.filter((call) =>
  call.surface === "LocalAgentModeSessions" && call.method === "start").at(-1).args[0];
assert.deepEqual(imageStart.images,
  [{ name: "image-1", mimeType: "image/png", base64: tinyPng }],
  "a fire's images reach Cowork's start call in the Desktop's shape");
await assert.rejects(
  () => service.fireRoutine(coworkId, {
    images: [{ media_type: "text/plain", data: "aGk=" }],
  }),
  (error) => error.statusCode === 400 && /png, jpeg, gif or webp/.test(error.message),
  "an unsupported image type is refused");

// Firing a Code task places a session on the runner with the prompt as the
// client's first user event — the shape the runner reads and the transcript
// releases when the runner stamps it.
const codeFired = await service.fireRoutine(codeId, { text: "CI failed" });
assert.equal(codeFired.kind, "code");
assert.equal(codeFired.sessionId, "cse_created");
assert.equal(woke, 1, "placing a Code session wakes the Cowork VM");
assert.equal(created.length, 1);
assert.equal(created[0].source, "client");
assert.equal(created[0].body.environment_id, "ccpool_test");
assert.equal(created[0].body.trigger_id, codeId,
  "a Code run names the routine it belongs to");
assert.equal(created[0].body.origin, "fire_routine");
assert.equal(created[0].body.config.model, "model-a");
assert.equal(created[0].body.config.cwd, "/workspace/repo");
assert.equal(created[0].body.events[0].payload.type, "user");
assert.equal(created[0].body.events[0].payload.message.content[0].text,
  "Fix the failing test.\n\n---\nAdditional context for this run:\nCI failed");

// A Code fire's images become image blocks in the opening user event — the
// content list the guest runner forwards to the agent unchanged.
await service.fireRoutine(codeId, {
  text: "see screenshot",
  images: [{ mimeType: "image/png", base64: tinyPng }],
});
assert.equal(created.length, 2);
assert.deepEqual(created[1].body.events[0].payload.message.content[1], {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: tinyPng },
});

// A deployment whose models come from gateway discovery leaves the env list
// empty; the fire asks the instance for the models it offers rather than
// refusing every run.
const discovered = createRoutineService({
  stateDir: join(home, "discovered"),
  desktop,
  codeRunners,
  configuredModels: [],
  defaultModel: "",
  resolveModels: async () => ["model-b"],
  log: { log() {}, warn() {} },
});
await discovered.fireRoutine(codeId, {});
assert.equal(created.at(-1).body.config.model, "model-b",
  "a discovered model is used when no env list names one");

// Paused routines do not start a session, and a fire carries no per-run config.
currentTasks = [{ ...coworkTask, enabled: false }, codeTask];
await assert.rejects(
  () => service.fireRoutine(coworkId, {}),
  (error) => error.statusCode === 400 && /paused/.test(error.message),
  "a paused routine is refused");
await assert.rejects(
  () => service.fireRoutine(coworkId, { text: "x".repeat(65_537) }),
  (error) => error.statusCode === 400 && /65,?536/.test(error.message),
  "an oversized text is refused");
currentTasks = [coworkTask, codeTask];

// The limits: 30 fires per routine in an hour, then a 429 with Retry-After.
const limited = createRoutineService({
  stateDir: join(home, "limited"),
  desktop,
  configuredModels: ["model-a"],
  defaultModel: "model-a",
  log: { log() {}, warn() {} },
});
for (let index = 0; index < 30; index += 1) await limited.fireRoutine(coworkId, {});
await assert.rejects(
  () => limited.fireRoutine(coworkId, {}),
  (error) => error.statusCode === 429 && error.retryAfter > 0,
  "the 31st fire in the hour is rate limited");

// The multi-tenant mint mirrors the hash into authd with the caller's own
// session cookie, so the edge can choose an instance for a cookie-less fire.
const authCalls = [];
const authStub = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  authCalls.push({
    url: request.url,
    cookie: request.headers.cookie,
    body: raw ? JSON.parse(raw) : {},
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
});
await new Promise((resolve) => authStub.listen(8195, "127.0.0.1", resolve));
try {
  const authed = createRoutineService({
    stateDir: join(home, "authed"),
    desktop,
    configuredModels: ["model-a"],
    defaultModel: "model-a",
    authIdentityUrl: "http://127.0.0.1:8195",
    log: { log() {}, warn() {} },
  });
  const authedToken = await authed.mintToken(coworkId, { cookie: "sessionKey=abc" });
  assert.match(authedToken.token, /^sk-ant-oat01-/);
  assert.equal(authCalls.at(-1).url, "/internal/routine-tokens");
  assert.equal(authCalls.at(-1).cookie, "sessionKey=abc");
  assert.equal(authCalls.at(-1).body.routine_id, coworkId);
  assert.match(authCalls.at(-1).body.token_sha256, /^[0-9a-f]{64}$/,
    "only the hash crosses to authd");
  await authed.revokeToken(coworkId, { cookie: "sessionKey=abc" });
  assert.equal(authCalls.at(-1).url, "/internal/routine-tokens/revoke");
  assert.equal(authCalls.at(-1).body.routine_id, coworkId);
  await assert.rejects(
    () => authed.mintToken(codeId, {}),
    (error) => error.statusCode === 401,
    "an authd-backed instance requires the admin's session cookie");
} finally {
  authStub.close();
}

// --- the HTTP routes --------------------------------------------------------

const httpStarts = [];
const stub = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const send = (body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (pathname === "/health") {
    send({ ok: true, surfaces: {}, routineFileLinkRepair: null });
    return;
  }
  if (pathname === "/events" || pathname === "/notifications") {
    send({ ok: true, value: [] });
    return;
  }
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { send({ ok: true, value: null }); return; }
  if (body.surface === "CoworkScheduledTasks" && body.method === "getAllScheduledTasks") {
    send({ ok: true, value: [coworkTask] });
    return;
  }
  if (body.surface === "CoworkScheduledTasks" && body.method === "getScheduledTaskFileContent") {
    send({ ok: true, value: files["cowork-1"] });
    return;
  }
  if (body.surface === "LocalAgentModeSessions" && body.method === "start") {
    httpStarts.push(body.args[0]);
    send({ ok: true, value: { sessionId: body.args[0].sessionId } });
    return;
  }
  send({ ok: true, value: null });
});

const bridgePort = 8193;
const stubPort = 8194;
// The bridge reads the release manifest the image writes at build time; this
// checkout only carries the source it is built from.
const releaseFile = join(root, "bridge/release.json");
const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(join(root, "config/release.json")));
await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));
const child = spawn(process.execPath, [join(root, "bridge/server.mjs")], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_HOST: "127.0.0.1",
    COWORK_INTERNAL_URL: `http://127.0.0.1:${stubPort}`,
    COWORK_BRIDGE_STATE_DIR: join(home, "http-state"),
    AUTH_IDENTITY_URL: "",
    CLAUDE_INFERENCE_MODELS_JSON: '[{"name":"model-a","isFamilyDefault":true}]',
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = `http://127.0.0.1:${bridgePort}`;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });

  const triggers = await (await fetch(`${base}/v1/code/triggers`)).json();
  assert.equal(triggers.data.length, 1);
  assert.equal(triggers.data[0].id, coworkId);
  assert.equal(triggers.data[0].kind, "cowork");

  // The token console: the UI route for a local task's token. It is a static
  // page on the same origin, so its fetches carry the instance's session.
  const consolePage = await fetch(`${base}/routine-tokens`);
  assert.equal(consolePage.status, 200);
  assert.match(await consolePage.text(), /Routine tokens/,
    "the token console is served by the instance");

  const tokenResponse = await fetch(
    `${base}/v1/code/triggers/${encodeURIComponent(coworkId)}/api-token`, { method: "POST" });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json();
  assert.match(token, /^sk-ant-oat01-/);

  const fire = await fetch(
    `${base}/v1/claude_code/routines/${encodeURIComponent(coworkId)}/fire`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Sentry SEN-2",
        images: [{ media_type: "image/png", data: tinyPng }],
      }),
    });
  assert.equal(fire.status, 200, await fire.clone().text());
  const fired = await fire.json();
  assert.equal(fired.type, "routine_fire");
  assert.match(fired.claude_code_session_id, /^local_/);
  assert.match(fired.claude_code_session_url, /\/cowork\/local_/);
  assert.deepEqual(httpStarts.at(-1).images,
    [{ name: "image-1", mimeType: "image/png", base64: tinyPng }],
    "images in the HTTP body reach the started session");

  const noVersion = await fetch(
    `${base}/v1/claude_code/routines/${encodeURIComponent(coworkId)}/fire`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  assert.equal(noVersion.status, 400);
  assert.equal((await noVersion.json()).error.type, "invalid_request_error");

  const wrongToken = await fetch(
    `${base}/v1/claude_code/routines/${encodeURIComponent(coworkId)}/fire`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-oat01-not-this-one",
        "anthropic-version": "2023-06-01",
      },
    });
  assert.equal(wrongToken.status, 401);
  assert.equal((await wrongToken.json()).error.type, "authentication_error");

  const revoked = await fetch(
    `${base}/v1/code/triggers/${encodeURIComponent(coworkId)}/api-token`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  const afterRevoke = await fetch(
    `${base}/v1/claude_code/routines/${encodeURIComponent(coworkId)}/fire`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
    });
  assert.equal(afterRevoke.status, 401, "a revoked token stops firing");
} finally {
  child.kill("SIGKILL");
  stub.close();
  if (createdRelease) rmSync(releaseFile, { force: true });
  await rm(home, { recursive: true, force: true });
}

console.log("routine-fire-smoke: ok");
