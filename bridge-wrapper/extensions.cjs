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

module.exports = {
  createExtensionPolicy,
  deploymentModeInitMessage,
  extensionChannelMarker,
  extensionDialogMethods,
  extensionPolicyMethods,
  findDeploymentModeGetter,
};
