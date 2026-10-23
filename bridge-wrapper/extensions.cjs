"use strict";

// Desktop extensions (MCPB bundles) in a three-party deployment.
//
// The official Linux build can install and run desktop extensions, but it
// keeps two gates shut here. `isExtensionsEnabled()` reads the app config's
// `extensions.enabled`, which three-party mode leaves unset (the generated
// config now writes it), and `isLocalExtensionInstallAllowed()` is
// `deploymentMode.hasOrgPolicyBackend() && enabled`. The 3P deployment mode
// answers `hasOrgPolicyBackend()` false because the organization policy service
// is claude.ai, which this deployment does not have — so the Settings
// Extensions page, the install button, and every install handler refuse.
//
// patch-main-process.mjs also rewrites the main process's extensions policy so
// the Desktop window's renderer sees the install flag as the enablement answer.
// This module stays as the narrower guard for the IPC calls themselves (and as
// defense in depth if a future bundle moves that policy): the operator of this
// container is the person installing the bundle, so an Extensions IPC call runs
// with that predicate forced true. The override is scoped to the call:
// unrelated organization-policy reads (usage, account capabilities, blocklists)
// that also consult `hasOrgPolicyBackend()` keep the 3P answer outside it.
//
// The active deployment-mode object is found through the official accessor
// rather than a minified export name: the accessor is the one function whose
// body carries the initialization error below. That also survives the object
// being rebuilt (the patched instance is re-checked on every call).
//
// Plain Node on purpose — scripts/desktop-extensions-smoke.mjs exercises this
// without Electron.

const deploymentModeInitMessage =
  "getDeploymentMode() called before initDeploymentMode";
const extensionChannelMarker = "_$_Extensions_$_";

// Only the calls that need the install authorization run inside the override.
// `isDirectoryEnabled()` also consults `hasOrgPolicyBackend()`; forcing it for
// every read would advertise claude.ai's extension directory, which this
// deployment does not serve. Reads, settings and deletes need no override.
// `isLocalExtensionInstallAllowed` is what makes the page draw the install
// button; the rest are the install/preview paths themselves.
const extensionPolicyMethods = new Set([
  "handleDxtFile",
  "installDxt",
  "installDxtFromDirectory",
  "installDxtUnpacked",
  "installExtensionFromPreview",
  "isLocalExtensionInstallAllowed",
  "showInstallDxtDialog",
]);

// The Extensions surface's install/preview calls can open the official native
// confirmation or error dialog. A browser-relayed call cannot see or answer
// that dialog, so the wrapper auto-answers it there (the preview modal in the
// page already asked). The Desktop window's own calls still show it.
const extensionDialogMethods = new Set([
  "handleDxtFile",
  "installDxt",
  "installDxtFromDirectory",
  "installDxtUnpacked",
  "installExtensionFromPreview",
]);

function defaultModules() {
  const exportsValues = [];
  for (const loaded of Object.values(require.cache)) {
    const exports = loaded?.exports;
    if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
    exportsValues.push(exports);
  }
  return exportsValues;
}

/**
 * Find the official `getDeploymentMode` accessor among loaded module exports.
 * Its body's initialization error is the stable pin; the minified local name
 * is not.
 */
function findDeploymentModeGetter(modules) {
  for (const exports of modules) {
    let names;
    try {
      names = Object.getOwnPropertyNames(exports);
    } catch {
      continue;
    }
    for (const name of names) {
      let value;
      try {
        value = exports[name];
      } catch {
        continue;
      }
      if (typeof value !== "function") continue;
      let source;
      try {
        source = Function.prototype.toString.call(value);
      } catch {
        continue;
      }
      if (!source.includes(deploymentModeInitMessage)) continue;
      return value;
    }
  }
  return null;
}

function looksLikeDeploymentMode(value) {
  return value !== null && typeof value === "object"
    && typeof value.hasOrgPolicyBackend === "function";
}

/**
 * @param {object} [options]
 * @param {() => object[]} [options.modules] module-export objects to search.
 *   Defaults to the live `require.cache`; tests pass their own.
 */
function createExtensionPolicy({ modules = defaultModules } = {}) {
  let getter = null;
  let activeMode = null;
  let depth = 0;
  const patchedModes = new WeakSet();
  const wrappedIpcEndpoints = new WeakSet();

  /**
   * Make sure the active deployment mode's policy predicate honors `run()`.
   * Returns false while the official mode has not been initialized yet; the
   * next call retries.
   */
  function ensure() {
    getter ??= findDeploymentModeGetter(modules());
    if (!getter) return false;
    let mode;
    try {
      mode = getter();
    } catch {
      // "called before initDeploymentMode()" — startup has not reached it.
      return false;
    }
    if (!looksLikeDeploymentMode(mode)) return false;
    if (!patchedModes.has(mode)) {
      const original = mode.hasOrgPolicyBackend;
      const replacement = function hasOrgPolicyBackend(...args) {
        if (depth > 0) return true;
        return original.apply(this, args);
      };
      try {
        mode.hasOrgPolicyBackend = replacement;
      } catch {
        return false;
      }
      patchedModes.add(mode);
    }
    activeMode = mode;
    return true;
  }

  /** Run `fn` with the install predicate forced true for this deployment. */
  async function run(fn) {
    ensure();
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  }

  /**
   * Wrap one window's IPC endpoint so every Extensions handler runs inside
   * `run()`. Desktop registers these on `webContents.ipc`, not `ipcMain`.
   */
  function wrapIpc(ipc) {
    if (!ipc || typeof ipc.handle !== "function" || wrappedIpcEndpoints.has(ipc)) {
      return false;
    }
    const originalHandle = ipc.handle.bind(ipc);
    ipc.handle = (channel, listener) => {
      if (typeof channel !== "string" || typeof listener !== "function") {
        return originalHandle(channel, listener);
      }
      const marker = channel.indexOf(extensionChannelMarker);
      if (marker < 0) return originalHandle(channel, listener);
      const method = channel.slice(marker + extensionChannelMarker.length);
      if (!extensionPolicyMethods.has(method)) return originalHandle(channel, listener);
      return originalHandle(channel, (event, ...args) =>
        run(() => listener(event, ...args)));
    };
    wrappedIpcEndpoints.add(ipc);
    return true;
  }

  return {
    ensure,
    run,
    wrapIpc,
    get activeMode() {
      return activeMode;
    },
    get isOverridden() {
      return depth > 0;
    },
  };
}

// The renderer-side half of the browser MCP proxy. It runs in the official
// desktop renderer (main world). Exported as source so
// scripts/desktop-extensions-smoke.mjs can exercise it without Electron.
//
// The Electron preload hands local MCP servers a MessagePort through
// `claudeAppBindings.connectToMcpServer`. That port also carries the app's own
// MCP client, so this proxy never touches `port.onmessage`: it listens with
// `addEventListener`, gives each browser connection a disjoint id range, and
// answers the browser's `initialize` locally (a second initialize must not
// reach the server). Responses in a browser range go back to that connection;
// notifications go to all of them; the app's traffic passes through untouched.
const mcpBridgeGlobal = "__CLAUDE_REMOTE_MCP_BRIDGE_V1__";

function mcpBridgeInstallExpression({ consolePrefix, maxBytes = 6 * 1024 * 1024 } = {}) {
  if (typeof consolePrefix !== "string" || !consolePrefix) {
    throw new Error("MCP bridge requires the relay console prefix");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("MCP bridge requires a positive message bound");
  }
  return `(() => {
  const key = ${JSON.stringify(mcpBridgeGlobal)};
  if (globalThis[key]) return "__COWORK_BRIDGE_MCP_READY__";
  const bindings = globalThis.claudeAppBindings;
  if (typeof bindings?.listMcpServers !== "function"
      || typeof bindings?.connectToMcpServer !== "function") {
    return "__COWORK_BRIDGE_NOT_AVAILABLE__";
  }
  const consolePrefix = ${JSON.stringify(consolePrefix)};
  const ports = new Map();
  const connections = new Map();
  const waiters = new Map();
  let nextBase = 1000000;
  const initializeResults = new Map();
  const protocolVersions = new Map();

  const emit = (connectionId, message) => {
    let serialized;
    try {
      serialized = JSON.stringify({ surface: "McpBridge", method: "mcpMessage",
        payload: { connectionId, message } });
    } catch { return; }
    if (serialized.length > ${maxBytes}) return;
    console.debug(consolePrefix + serialized);
  };

  const attach = (serverName, port, uuid) => {
    ports.set(serverName, { port, uuid });
    try { port.start?.(); } catch {}
    try {
      port.addEventListener("close", () => {
        if (ports.get(serverName)?.port === port) ports.delete(serverName);
      });
    } catch {}
    port.addEventListener("message", (event) => {
      const message = event?.data;
      if (!message || typeof message !== "object") return;
      if (!initializeResults.has(serverName) && message.result
          && (message.result.protocolVersion || message.result.serverInfo)) {
        initializeResults.set(serverName, message.result);
        protocolVersions.set(serverName, message.result.protocolVersion || null);
      }
      if (typeof message.id === "number") {
        for (const [connectionId, connection] of connections) {
          if (connection.serverName !== serverName) continue;
          if (message.id >= connection.base
              && message.id < connection.base + 1000000) {
            emit(connectionId, { ...message, id: message.id - connection.base });
            return;
          }
        }
        return;
      }
      for (const [connectionId, connection] of connections) {
        if (connection.serverName === serverName) emit(connectionId, message);
      }
    });
  };

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis || !event.data) return;
    if (event.data.type !== "mcp-server-connected") return;
    const name = event.data.serverName;
    const port = event.ports && event.ports[0];
    if (typeof name !== "string" || !port) return;
    const list = waiters.get(name);
    if (list && list.length) {
      waiters.delete(name);
      attach(name, port, event.data.uuid || name);
      for (const resolve of list) resolve();
      return;
    }
    // The app reconnected on its own: keep the newest port for later clients.
    if (ports.has(name)) attach(name, port, event.data.uuid || name);
  });

  const syntheticInitialize = (serverName, params) => ({
    protocolVersion: (params && params.protocolVersion)
      || protocolVersions.get(serverName) || "2024-11-05",
    capabilities: {
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: false },
    },
    serverInfo: { name: serverName, version: "0.0.0" },
  });

  globalThis[key] = {
    async list() {
      return await bindings.listMcpServers();
    },
    async connect(connectionId, serverName) {
      if (typeof connectionId !== "string" || typeof serverName !== "string") {
        throw new Error("Invalid MCP connection");
      }
      const names = await bindings.listMcpServers();
      if (!Array.isArray(names) || !names.includes(serverName)) {
        throw new Error("Unknown MCP server");
      }
      if (!ports.has(serverName)) {
        // A preload-time listener captures every port the app receives, so a
        // server the Desktop window already connected is reused instead of
        // restarted (a restart races uv's environment lock, for example).
        const early = globalThis.__CLAUDE_REMOTE_MCP_EARLY_PORTS__;
        const captured = early instanceof Map ? early.get(serverName) : undefined;
        if (captured) {
          early.delete(serverName);
          attach(serverName, captured.port, captured.uuid || serverName);
        }
      }
      if (!ports.has(serverName)) {
        const waiting = new Promise((resolve) => {
          const list = waiters.get(serverName) || [];
          list.push(resolve);
          waiters.set(serverName, list);
        });
        await bindings.connectToMcpServer(serverName);
        await Promise.race([
          waiting,
          new Promise((resolve) => setTimeout(resolve, 30000)),
        ]);
        if (!ports.has(serverName)) {
          // The attach failed without a port. Ask the main process's own
          // status for the reason (the handler swallows some launch errors).
          let detail = "";
          try {
            const statuses = await globalThis["claude.settings"]?.MCP
              ?.getMcpServersConfigWithStatus?.();
            const status = statuses?.[serverName];
            if (status) {
              detail = " status=" + (status.status || "unknown");
              if (status.error) detail += " error=" + status.error;
            }
          } catch {}
          throw new Error(
            "The MCP server did not connect (" + location.href + detail + ")");
        }
      }
      const base = nextBase;
      nextBase += 1000000;
      connections.set(connectionId, { serverName, base });
      return { uuid: ports.get(serverName).uuid };
    },
    async send(connectionId, message) {
      const connection = connections.get(connectionId);
      if (!connection || !message || typeof message !== "object") {
        throw new Error("MCP connection is not open");
      }
      const port = ports.get(connection.serverName)?.port;
      if (!port) throw new Error("MCP server is not connected");
      if (message.method === "initialize") {
        emit(connectionId, {
          jsonrpc: "2.0",
          id: message.id,
          result: initializeResults.get(connection.serverName)
            || syntheticInitialize(connection.serverName, message.params),
        });
        return true;
      }
      if (message.method === "notifications/initialized") return true;
      const forwarded = { ...message };
      if (typeof forwarded.id === "number") forwarded.id += connection.base;
      port.postMessage(forwarded);
      return true;
    },
    async close(connectionId) {
      connections.delete(connectionId);
      return true;
    },
  };
  return "__COWORK_BRIDGE_MCP_READY__";
})()`;
}

module.exports = {
  createExtensionPolicy,
  deploymentModeInitMessage,
  extensionChannelMarker,
  extensionDialogMethods,
  extensionPolicyMethods,
  findDeploymentModeGetter,
  mcpBridgeGlobal,
  mcpBridgeInstallExpression,
};
