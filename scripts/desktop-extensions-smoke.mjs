import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import {
  createExtensionPolicy,
  deploymentModeInitMessage,
  extensionChannelMarker,
  extensionDialogMethods,
  extensionPolicyMethods,
  findDeploymentModeGetter,
  mcpBridgeGlobal,
  mcpBridgeInstallExpression,
} from "../bridge-wrapper/extensions.cjs";

// The official 3P deployment refuses a local extension install because its
// `hasOrgPolicyBackend()` answers false (the policy service is claude.ai).
// `extensions.cjs` finds the active deployment mode structurally and forces
// that one predicate true for the duration of an Extensions IPC call. This
// pins the discovery, the scoping and the IPC wrapper without Electron.

function makeMode() {
  return {
    type: "3p",
    hasOrgPolicyBackend() {
      return false;
    },
    hasClaudeAiProductFeatures() {
      return false;
    },
  };
}

let activeMode = null;
const getDeploymentMode = function getDeploymentMode() {
  if (!activeMode) {
    // The literal is the pin: the finder reads the function's own source.
    throw new Error("getDeploymentMode() called before initDeploymentMode(). Ensure initDeploymentMode() runs during startup.");
  }
  return activeMode;
};

const hostileExports = {};
Object.defineProperty(hostileExports, "boom", {
  enumerable: true,
  get() {
    throw new Error("unreadable export");
  },
});
const exportsWithGetter = { getDeploymentMode, marker: "not a function" };
const modules = () => [hostileExports, exportsWithGetter];

assert.equal(findDeploymentModeGetter(modules()), getDeploymentMode,
  "the accessor is found by its initialization error, past a throwing export");
assert.equal(findDeploymentModeGetter([{ decoy() {
  return "not the accessor";
} }]), null, "an unrelated function is not the deployment accessor");

activeMode = null;
const policy = createExtensionPolicy({ modules });
assert.equal(policy.ensure(), false, "the policy waits until the mode is initialized");
assert.equal(await policy.run(() => 7), 7,
  "a call still runs while the official mode is unavailable");
assert.equal(policy.isOverridden, false);

activeMode = makeMode();
assert.equal(policy.ensure(), true);
assert.equal(activeMode.hasOrgPolicyBackend(), false, "outside a call the 3P answer is untouched");
assert.equal(await policy.run(() => activeMode.hasOrgPolicyBackend()), true,
  "inside a call the install predicate is forced true");
assert.equal(activeMode.hasOrgPolicyBackend(), false, "the override is scoped and unwinds");

// A rebuilt deployment mode (a configuration change re-initializes it) must be
// patched too; the old instance is irrelevant.
const replaced = makeMode();
activeMode = replaced;
assert.equal(await policy.run(() => replaced.hasOrgPolicyBackend()), true,
  "a replacement deployment instance is patched on the next call");

// Concurrent calls nest through one counter.
let releaseFirst;
const first = policy.run(() => new Promise((resolve) => {
  releaseFirst = () => resolve(activeMode.hasOrgPolicyBackend());
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(activeMode.hasOrgPolicyBackend(), true,
  "the predicate stays overridden while a relayed install is in flight");
releaseFirst();
assert.equal(await first, true);
assert.equal(activeMode.hasOrgPolicyBackend(), false,
  "the override unwinds once the last call settles");

// The IPC endpoint wrapper: only Extensions channels run inside the override.
const handlers = new Map();
const ipc = {
  handle(channel, listener) {
    handlers.set(channel, listener);
  },
};
assert.equal(policy.wrapIpc(ipc), true);
assert.equal(policy.wrapIpc(ipc), false, "a second wrap of the same endpoint is refused");
const installChannel = `win${extensionChannelMarker}installExtensionFromPreview`;
const allowedChannel = `win${extensionChannelMarker}isLocalExtensionInstallAllowed`;
const readChannel = `win${extensionChannelMarker}isDirectoryEnabled`;
const otherChannel = "win_$_LocalSessions_$_getAll";
for (const channel of [installChannel, allowedChannel, readChannel, otherChannel]) {
  ipc.handle(channel, () => activeMode.hasOrgPolicyBackend());
}
assert.equal(await handlers.get(installChannel)({}), true,
  "an install handler sees the install predicate on");
assert.equal(await handlers.get(allowedChannel)({}), true,
  "the button's authorization read is allowed");
assert.equal(await handlers.get(readChannel)({}), false,
  "the extension-directory read keeps the 3P answer, so no catalog is advertised");
assert.equal(await handlers.get(otherChannel)({}), false,
  "an unrelated Desktop surface keeps the 3P answer");
assert.equal(activeMode.hasOrgPolicyBackend(), false);
assert.ok(extensionPolicyMethods.has("isLocalExtensionInstallAllowed")
  && !extensionPolicyMethods.has("isDirectoryEnabled"),
  "the override is scoped to install authorization, not every Extensions read");

// The methods whose native dialogs the browser relay auto-answers. The dialog
// wrapper itself lives in main.cjs (it needs Electron); this pins the set the
// two sides agree on.
for (const method of ["handleDxtFile", "installExtensionFromPreview", "installDxt"]) {
  assert.ok(extensionDialogMethods.has(method), `${method} opens a native dialog`);
}
assert.ok(!extensionDialogMethods.has("getInstalledExtensionsWithState"),
  "a read-only call is not auto-confirmed");

// The browser side: the settings namespace must be published even when the
// Gateway settings editor is off (extensions are not a Gateway feature), and
// the install button must be the browser upload flow, not the native dialog.
const preload = await readFile(
  new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
assert.match(preload, /config\.gatewaySettingsEnabled \|\| extensionsAvailable/,
  "claude.settings must exist for the Extensions surface alone");
assert.match(preload, /api\.showInstallDxtDialog = installExtensionFromBrowser/,
  "the install button must open the browser's own picker");
assert.match(preload, /invokeSettings\("Extensions", "handleDxtFile", \[path\]\)/,
  "the uploaded bundle must enter the official preview path");
assert.match(preload, /accept: "\.mcpb,\.dxt,application\/zip"/,
  "the picker must be limited to bundle archives");
assert.match(preload, /dispatch\(payload\.surface, payload\.method, payload\.payload, payload\.args\)/,
  "the browser must receive every argument of a multi-argument Desktop event");

// The drag-and-drop path. The overview only installs a dropped file when
// `claude.settings.FilePickers`, the Extensions API and
// `window.claudeAppSettings.filePickers.getPathForFile` all exist; a browser
// has none of them natively. The helper is synchronous, so it hands the
// wrapper a one-shot token and the wrapper uploads the remembered File.
assert.match(preload, /settingsRoot\.FilePickers = Object\.freeze\(\{/,
  "claude.settings.FilePickers must exist for the drop handler's guard");
assert.match(preload, /filePickers: Object\.freeze\(\{ getPathForFile: browserExtensionPath \}\)/,
  "the browser must publish the synchronous path helper");
assert.match(preload, /function browserExtensionPath\(file\)/,
  "the path helper must tokenise a dropped bundle");
assert.match(preload, /includes\("settings\/desktop\/extensions"\)/,
  "the helper must recognise the hash-routed Extensions page");
assert.match(preload, /api\.handleDxtFile = async \(\.\.\.args\)/,
  "handleDxtFile must resolve a browser token before the Desktop call");
assert.match(preload, /uploadBrowserFiles\(\[file\]\)/,
  "a dropped bundle must be uploaded into the shared workspace");
assert.match(preload, /for \(const method of config\.listeners\?\.Extensions \|\| \[\]\)/,
  "the Extensions events must be published on claude.settings, where the page reads them");
assert.match(preload, /globalThis\.desktopManagedConfig/,
  "the page's initial extensions policy snapshot must be browser-answerable");

// The Desktop window reads the install authorization from the main process's
// policy, not from the renderer. In three-party mode that policy ANDs the
// answer with `hasOrgPolicyBackend()`, so the patch must land or the window's
// Extensions page hides every install control.
const mainProcessPatcher = await readFile(
  new URL("../rootfs/opt/claude-cowork-bridge/patch-main-process.mjs", import.meta.url), "utf8");
assert.match(mainProcessPatcher, /extensionInstallPolicyPatchId/,
  "the main-process patcher must apply the extensions install policy");
assert.match(mainProcessPatcher, /extensions install policy expected once/,
  "a missing policy splice must fail the patch");

// Both configuration spellings must be written: the app config file carries the
// nested object, while the environment-seeded managed configuration and the
// applied config-library entry are validated by the flat-key registry and would
// silently drop a nested `extensions` key.
const configInit = await readFile(
  new URL("../rootfs/etc/cont-init.d/30-claude-config.sh", import.meta.url), "utf8");
assert.match(configInit, /isDesktopExtensionEnabled: true/,
  "the managed/config-library seed must use the flat key");
assert.match(configInit, /\.extensions = \(\(\.extensions \/\/ \{\}\) \+ \{enabled: true\}\)/,
  "claude_desktop_config.json must carry the nested object");
assert.match(configInit, /\.isDesktopExtensionEnabled \/\/ empty/,
  "an existing applied config-library entry must be checked for the flat key");

const server = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");
const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
for (const [name, source] of [["bridge", server], ["wrapper", wrapper]]) {
  assert.match(source, /allowedSettingsMethods\.set\("Extensions", extensionSettingsMethods\)/,
    `${name} must expose the Extensions settings surface`);
  assert.match(source, /"onPreviewExtensionInstallation"/,
    `${name} must relay the extension preview event`);
  assert.match(source, /A-Za-z0-9\]\[A-Za-z0-9._-\]\{0,255\}/,
    `${name} must accept the Desktop's full local-bundle id length`);
}
// Local MCP servers: the official renderer attaches them through
// claudeAppBindings + a MessagePort, which a browser cannot receive. The
// preload must publish the two bindings, deliver a fake port, and consume the
// wrapper's multiplexed messages; bridge and wrapper must carry the routes.
assert.match(preload, /listMcpServers: \(\) => listBridgeMcpServers\(\)/,
  "the browser must publish listMcpServers");
assert.match(preload, /connectToMcpServer: \(serverName\) => connectBridgeMcpServer\(serverName\)/,
  "the browser must publish connectToMcpServer");
assert.match(preload, /new MessageEvent\("message", \{/,
  "the browser must deliver the port as a window message");
assert.match(preload, /payload\.surface === "McpBridge" && payload\.method === "mcpMessage"/,
  "the browser must route multiplexed MCP messages to the fake port");
assert.match(server, /\/api\/remote\/mcp\/connect/,
  "the bridge must expose the browser's MCP connect route");
assert.match(wrapper, /"\/mcp-connect"/,
  "the wrapper must expose the renderer's MCP connect route");
assert.match(wrapper, /"\/mcp-send"/, "the wrapper must carry MCP messages to the renderer");
assert.match(wrapper, /\["McpBridge", new Set\(\["mcpMessage"\]\)\]/,
  "the wrapper must let MCP messages through the event relay");
// The attach hook reads the MCP config to skip an internal server the account
// never configured (mcp-registry), and the main renderer answers it.
assert.match(server, /allowedSettingsMethods\.set\("MCP", new Set\(\["getMcpServersConfig"\]\)\)/,
  "the bridge must expose the read-only MCP configuration");
assert.match(wrapper, /allowedSettingsMethods\.set\("MCP", new Set\(\["getMcpServersConfig"\]\)\)/,
  "the wrapper must expose the read-only MCP configuration");
assert.match(wrapper, /surface === "Extensions" \|\| surface === "MCP"/,
  "MCP reads must run in the official app renderer, not the setup window");
for (const [name, source] of [["bridge", server], ["wrapper", wrapper]]) {
  assert.match(source, /surface !== "Extensions" && surface !== "MCP"/,
    `${name} must allow the read-only MCP surface without the Gateway editor`);
}
// The preload-time capture lets the proxy reuse the app's port instead of
// restarting the server (the Canvas/uv failure mode).
assert.match(mainProcessPatcher, /mcpEarlyPortPatchId/,
  "the main-process patcher must install the early port capture");
assert.match(await readFile(new URL("../bridge-wrapper/extensions.cjs", import.meta.url), "utf8"),
  /__CLAUDE_REMOTE_MCP_EARLY_PORTS__/,
  "the proxy must adopt the early-captured port");

// The browser MCP proxy. The official renderer attaches local MCP servers
// through `claudeAppBindings` and a MessagePort; the browser cannot receive a
// port, so this proxy owns the real one and multiplexes browser JSON-RPC
// clients onto it. Exercise the proxy exactly as it is installed.
const mcpPrefix = "__MCP_SMOKE__:";
const mcpEventLog = [];
const mcpWindowListeners = [];
let mcpPort = null;
function makePort() {
  const listeners = new Set();
  return {
    sent: [],
    onmessage: null,
    start() {},
    addEventListener(type, handler) {
      if (type === "message") listeners.add(handler);
    },
    postMessage(message) {
      this.sent.push(message);
    },
    emit(message) {
      for (const handler of listeners) handler({ data: message });
    },
  };
}
const mcpSandbox = {
  console: { debug(message) { mcpEventLog.push(message); } },
  setTimeout(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  queueMicrotask(callback) { callback(); },
  addEventListener(type, handler) {
    if (type === "message") mcpWindowListeners.push(handler);
  },
  claudeAppBindings: {
    async listMcpServers() {
      return ["Fixture Extension", "Other Server"];
    },
    async connectToMcpServer(name) {
      mcpPort = makePort();
      const event = {
        source: mcpSandbox.__self,
        data: { type: "mcp-server-connected", serverName: name, uuid: "uuid-1" },
        ports: [mcpPort],
      };
      for (const handler of mcpWindowListeners) handler(event);
      return true;
    },
  },
  __self: null,
};
vm.createContext(mcpSandbox);
const mcpReady = vm.runInContext(
  mcpBridgeInstallExpression({ consolePrefix: mcpPrefix }), mcpSandbox);
vm.runInContext("globalThis.__self = globalThis", mcpSandbox);
assert.equal(mcpReady, "__COWORK_BRIDGE_MCP_READY__",
  "the MCP proxy must install over the official bindings");
const mcpBridge = mcpSandbox[mcpBridgeGlobal];
const takeMcpEvents = () => mcpEventLog.splice(0)
  .map(message => JSON.parse(message.slice(mcpPrefix.length)));
assert.deepEqual(Array.from(await mcpBridge.list()), ["Fixture Extension", "Other Server"]);
await assert.rejects(mcpBridge.connect("connection-x", "Unknown Server"), /Unknown MCP server/);
assert.equal((await mcpBridge.connect("connection-1", "Fixture Extension")).uuid, "uuid-1");
assert.ok(mcpPort, "the real MessagePort must be captured");
const appHandler = () => {};
mcpPort.onmessage = appHandler;
await mcpBridge.send("connection-1", {
  jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" },
});
assert.equal(mcpPort.sent.length, 0, "initialize must not reach the server");
assert.equal(mcpPort.onmessage, appHandler,
  "the proxy must leave the app's own onmessage handler alone");
let events = takeMcpEvents();
assert.equal(events.length, 1, "the browser must receive its initialize answer");
assert.equal(events[0].surface, "McpBridge");
assert.equal(events[0].payload.connectionId, "connection-1");
assert.equal(events[0].payload.message.id, 0);
assert.equal(events[0].payload.message.result.protocolVersion, "2025-06-18");
assert.equal(events[0].payload.message.result.serverInfo.name, "Fixture Extension");

await mcpBridge.send("connection-1", { jsonrpc: "2.0", id: 1, method: "tools/list" });
assert.equal(mcpPort.sent.length, 1);
assert.equal(mcpPort.sent[0].id, 1000001, "browser ids must be offset from the app's");
mcpPort.emit({ jsonrpc: "2.0", id: 1000001, result: { tools: [{ name: "ping" }] } });
events = takeMcpEvents();
assert.equal(events.length, 1);
assert.equal(events[0].payload.message.id, 1, "the response id must be mapped back");
assert.deepEqual(events[0].payload.message.result.tools, [{ name: "ping" }]);
mcpPort.emit({ jsonrpc: "2.0", id: 5, result: { tools: [] } });
assert.equal(takeMcpEvents().length, 0, "the app's own responses must not leak to the browser");
mcpPort.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
events = takeMcpEvents();
assert.equal(events.length, 1, "notifications go to every browser connection");
assert.equal(events[0].payload.connectionId, "connection-1");
// A real initialize answer from the app's client is reused for later browsers.
mcpPort.emit({
  jsonrpc: "2.0", id: 2,
  result: { protocolVersion: "2025-03-26", capabilities: { tools: {} },
    serverInfo: { name: "Fixture", version: "2" } },
});
assert.equal(takeMcpEvents().length, 0);
assert.equal((await mcpBridge.connect("connection-2", "Fixture Extension")).uuid, "uuid-1");
await mcpBridge.send("connection-2", { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
events = takeMcpEvents();
assert.equal(events[0].payload.message.result.protocolVersion, "2025-03-26",
  "later connections reuse the server's real handshake");
await mcpBridge.send("connection-2", { jsonrpc: "2.0", id: 2, method: "tools/list" });
assert.equal(mcpPort.sent.at(-1).id, 2000002, "each connection has its own id range");
mcpPort.emit({ jsonrpc: "2.0", id: 2000002, result: { tools: [] } });
events = takeMcpEvents();
assert.equal(events[0].payload.connectionId, "connection-2");
await mcpBridge.close("connection-2");
await assert.rejects(mcpBridge.send("connection-2", { jsonrpc: "2.0", id: 3 }), /not open/);

// A server the Desktop window connected before the proxy was installed is
// adopted from the preload-time port map instead of being restarted.
const earlyPort = makePort();
vm.runInContext("globalThis.__CLAUDE_REMOTE_MCP_EARLY_PORTS__ = new Map()", mcpSandbox);
mcpSandbox.__CLAUDE_REMOTE_MCP_EARLY_PORTS__.set("Early Server", {
  port: earlyPort,
  uuid: "uuid-early",
});
mcpSandbox.claudeAppBindings.listMcpServers = async () => ["Early Server"];
let earlyConnects = 0;
mcpSandbox.claudeAppBindings.connectToMcpServer = async () => {
  earlyConnects += 1;
};
const early = await mcpBridge.connect("connection-3", "Early Server");
assert.equal(earlyConnects, 0, "an already-connected server must not be restarted");
assert.equal(early.uuid, "uuid-early");
await mcpBridge.send("connection-3", { jsonrpc: "2.0", id: 7, method: "tools/list" });
assert.equal(earlyPort.sent.at(-1).id, 3000007,
  "the adopted port must carry the third connection's id range");

console.log("desktop-extensions-smoke: policy override, IPC scoping, dialog set, browser wiring and the browser MCP proxy passed");
