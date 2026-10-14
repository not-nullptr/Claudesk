import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRealtimeController } from "../bridge/realtime.mjs";

// Folder access for Cowork is wired across four realms: the Desktop main
// process opens a native folder dialog for the "Choose folder" grant, which is
// invisible on this container's headless display, so the wrapper routes that
// dialog to the browser's in-page picker; the bridge relays the request over the
// realtime stream and forwards the answer back; the preload opens the picker and
// posts the selection; and the picker's "New folder" creates a directory through
// a confinement-checked bridge route. These checks pin each one.

const root = fileURLToPath(new URL("..", import.meta.url));
const settle = () => new Promise(resolve => setImmediate(resolve));
// Values built inside a vm context carry that realm's prototypes, which
// assert/strict's deepEqual rejects; compare a plain copy instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- wrapper: the directory dialog is routed, answered, and bounded ---------
{
  const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
  const relaySource = wrapper.slice(
    wrapper.indexOf("const folderPickRelay = {"),
    wrapper.indexOf("const server = http.createServer("),
  );
  assert.ok(relaySource.length > 0, "the wrapper still carries the folder pick relay");
  const enqueued = [];
  const fakeDialog = {
    calls: 0,
    async showOpenDialog() { fakeDialog.calls += 1; return { canceled: true, filePaths: [] }; },
  };
  const sandbox = {
    require: (name) => { assert.equal(name, "electron"); return { dialog: fakeDialog }; },
    randomBytes: () => ({ toString: () => "0011223344556677" }),
    enqueueRelayedEvent: (value) => enqueued.push(value),
    remoteFolderPickTimeoutMs: 60,
    remoteFolderPickerEnabled: true,
    Date, clearTimeout, console,
    // The wrapper unrefs its timers (Electron keeps the loop alive); the test
    // must not, or the timeout case would settle the process instead.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref = () => timer;
      return timer;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(relaySource, sandbox);

  const pending = fakeDialog.showOpenDialog({
    title: "Select Directory to Share",
    message: "Select a directory to share with the agent",
    defaultPath: "/root",
    properties: ["openDirectory", "createDirectory"],
  });
  assert.equal(fakeDialog.calls, 0, "a directory dialog must not reach the native picker");
  assert.equal(enqueued.length, 1);
  const [event] = enqueued;
  assert.equal(event.surface, "RemoteFolderPicker");
  assert.equal(event.method, "onRequest");
  assert.equal(event.payload.title, "Select Directory to Share");
  assert.equal(event.payload.defaultPath, "/root");
  assert.equal(event.payload.allowCreate, true);
  assert.equal(event.payload.multiple, false);
  assert.equal(typeof event.payload.id, "string");

  assert.deepEqual(plain(sandbox.resolveRemoteFolderPick({ id: event.payload.id, paths: ["/workspace/shared"] })), { handled: true });
  assert.deepEqual(plain(await pending), { canceled: false, filePaths: ["/workspace/shared"] });
  assert.deepEqual(plain(sandbox.resolveRemoteFolderPick({ id: event.payload.id, paths: ["/workspace/shared"] })),
    { handled: false, stale: true }, "a second answer to the same dialog is ignored");

  const windowForm = fakeDialog.showOpenDialog({ isDestroyed: () => false }, {
    properties: ["openDirectory", "multiSelections"],
  });
  const request = enqueued.at(-1);
  assert.equal(request.payload.multiple, true);
  sandbox.resolveRemoteFolderPick({ id: request.payload.id, canceled: true });
  assert.deepEqual(plain(await windowForm), { canceled: true, filePaths: [] });

  assert.deepEqual(
    plain(await fakeDialog.showOpenDialog({ properties: ["openFile"] })),
    { canceled: true, filePaths: [] },
  );
  assert.equal(fakeDialog.calls, 1, "a file dialog falls through to the native picker");

  assert.deepEqual(plain(await fakeDialog.showOpenDialog({ properties: ["openDirectory"] })),
    { canceled: true, filePaths: [] }, "an unanswered dialog answers as a cancel");
}

// --- realtime: the request reaches the browser as a relayed event -----------
{
  let queue = [];
  const desktop = {
    async invoke() { return []; },
    async pollEvents() { const events = queue; queue = []; return events; },
  };
  const chunks = [];
  const controller = createRealtimeController({ desktop, isChatSession: () => true, ApiError: Error });
  controller.open({ on() {} }, { writeHead() {}, on() {}, write(c) { chunks.push(c); } }, new URL("http://local/api/events"));
  await settle();
  queue.push({ surface: "RemoteFolderPicker", method: "onRequest", payload: { id: "req-1", title: "Share" } });
  await controller.pollDesktopEvents();
  const relayed = chunks.join("").split("\n\n").filter(block => block.includes("event: desktop-ipc"));
  assert.equal(relayed.length, 1, "the folder pick request must be broadcast to the browser");
  assert.match(relayed[0], /RemoteFolderPicker/);
  assert.match(relayed[0], /req-1/);
}

// --- preload: the picker answers the request and posts the selection ---------
{
  const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
  const start = preload.indexOf("  async function answerRemoteFolderPick(");
  const end = preload.indexOf("  function closeRemoteNotification(", start);
  assert.ok(start > 0 && end > start, "the preload still carries the folder pick answer");
  let picked = null, posted = null;
  const context = {
    bridgeRequest: async (path, body) => { posted = { path, body }; return { handled: true }; },
    globalThis: { __CLAUDE_PICK_SERVER_FOLDERS__: async (options) => { picked = options; return ["/workspace/shared"]; } },
  };
  vm.runInNewContext(`${preload.slice(start, end)}\nthis.answer = answerRemoteFolderPick;`, context);
  assert.equal(await context.answer({ id: "req-1", title: "Select Directory to Share", defaultPath: "/root", allowCreate: true }), true);
  assert.deepEqual(plain(picked), {
    title: "Select Directory to Share", multiple: false, initialPath: "/root", allowCreate: true,
  });
  assert.equal(posted.path, "/api/remote/folder-pick");
  assert.deepEqual(plain(posted.body), { id: "req-1", canceled: false, paths: ["/workspace/shared"] });

  context.globalThis.__CLAUDE_PICK_SERVER_FOLDERS__ = async () => null;
  await context.answer({ id: "req-2" });
  assert.deepEqual(plain(posted.body), { id: "req-2", canceled: true, paths: [] }, "a dismissed picker reports a cancel");
  delete context.globalThis.__CLAUDE_PICK_SERVER_FOLDERS__;
  await context.answer({ id: "req-3" });
  assert.deepEqual(plain(posted.body), { id: "req-3", canceled: true, paths: [] }, "a missing picker reports a cancel");
}

// --- bridge: the routes create a folder and forward the answer --------------
const releaseFile = `${root}bridge/release.json`;
const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
const workspace = await mkdtemp(join(tmpdir(), "claudesk-folderpick-"));
await mkdir(join(workspace, "existing"));
const wrapperPort = 8171, bridgePort = 8172;
const forwarded = [];
const wrapperServer = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const send = (body) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method === "POST" && url.pathname === "/folder-pick") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    forwarded.push(JSON.parse(raw));
    send({ ok: true, value: { handled: true } });
    return;
  }
  if (url.pathname === "/health") { send({ ok: true, surfaces: {} }); return; }
  if (url.pathname === "/events" || url.pathname === "/notifications") { send({ ok: true, value: [] }); return; }
  send({ ok: true, value: null });
});
await new Promise((resolve) => wrapperServer.listen(wrapperPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, [`${root}bridge/server.mjs`], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_HOST: "127.0.0.1",
    COWORK_INTERNAL_URL: `http://127.0.0.1:${wrapperPort}`,
    COWORK_REMOTE_WORKSPACE_ROOT: workspace,
    AUTH_IDENTITY_URL: "",
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

  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const made = await post("/api/remote/folders", { path: workspace, name: "shared" });
  assert.equal(made.status, 200);
  assert.equal(made.body.value.path, join(workspace, "shared"));
  assert.deepEqual(
    (await (await fetch(`${base}/api/remote/folders`)).json()).value.folders.map(folder => folder.name),
    ["existing", "shared"],
  );
  assert.equal((await post("/api/remote/folders", { path: workspace, name: "shared" })).status, 409);
  assert.equal((await post("/api/remote/folders", { path: workspace, name: "../escape" })).status, 400);
  assert.equal((await post("/api/remote/folder-pick", { id: "", paths: [] })).status, 400);

  const answered = await post("/api/remote/folder-pick", { id: "req-9", paths: [join(workspace, "shared")] });
  assert.equal(answered.status, 200);
  assert.deepEqual(forwarded, [{ id: "req-9", canceled: false, paths: [join(workspace, "shared")] }]);
  console.log("folder-pick-smoke: dialog routing, realtime relay, picker answer, folder creation and forwarding passed");
} finally {
  child.kill("SIGKILL");
  wrapperServer.close();
  await rm(workspace, { recursive: true, force: true });
  if (createdRelease) rmSync(releaseFile, { force: true });
}
