(() => {
  "use strict";

  // Chromium exposes getRandomValues on an HTTP LAN origin, but reserves
  // randomUUID for secure contexts. The official ion-dist assumes the latter
  // exists during module initialization, so provide the same RFC 4122 v4
  // result without weakening randomness or modifying the official bundle.
  if (
    globalThis.crypto
    && typeof globalThis.crypto.getRandomValues === "function"
    && typeof globalThis.crypto.randomUUID !== "function"
  ) {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value() {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
        return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
      },
      writable: true,
    });
  }

  // Temporary diagnosis channel for the sidebar prefill work; the bridge
  // bounds and serves these at /api/remote/renderer-trace.
  globalThis.__claudeskTrace = (name, data) => {
    try {
      fetch("/api/remote/renderer-trace", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, data }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  };

  // SubtleCrypto is also restricted to secure contexts. The official UI only
  // needs digest during its common HTTP bootstrap path; keep the compatibility
  // surface deliberately narrow and execute the allowlisted hash on the server.
  if (globalThis.crypto && !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: Object.freeze({
        async digest(algorithm, data) {
          const name = typeof algorithm === "string" ? algorithm : algorithm?.name;
          let bytes;
          if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
          } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          } else {
            throw new TypeError("digest data must be a BufferSource");
          }
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32768) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          }
          const result = await bridgeRequest(
            "/api/remote/crypto/digest",
            {
              algorithm: name,
              dataBase64: btoa(binary),
            },
            { retryable: true },
          );
          return Uint8Array.from(
            atob(result.dataBase64),
            (character) => character.charCodeAt(0),
          ).buffer;
        },
      }),
    });
  }

  const config = globalThis.__CLAUDE_REMOTE_BOOTSTRAP__;
  if (!config || config.transport !== "official-ion-dist-remote-ipc") return;
  // The chunk loader prefixes every lazy dependency with this base (see the
  // web-shell-asset-base renderer patch), so the whole module graph stays in
  // the release-versioned namespace the entry document uses.
  if (typeof config.assetBase === "string" && config.assetBase) {
    globalThis.__CLAUDESK_ASSET_BASE__ = config.assetBase;
  }

  const mobileClient = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || globalThis.navigator.userAgentData?.mobile === true
    || (
      /Macintosh/i.test(navigator.userAgent)
      && globalThis.navigator.maxTouchPoints > 1
    );
  if (mobileClient) document.documentElement.classList.add("claude-remote-mobile");
  // Either the local executor (the operator's own instance) or a self-hosted
  // runner pool (a tenant's) makes the Code surface real, and both want the
  // switcher painted. See docs/code-in-cowork-vm.md.
  if (config.codeActionsEnabled || config.codeSurfaceEnabled) {
    document.documentElement.classList.add("claude-remote-code-enabled");
  }

  // Claude Code persists its new-session target independently from the
  // Desktop IPC stores. A fresh browser otherwise starts with no folder and
  // the official picker treats the phone as the local machine, recursively
  // uploading the selected directory. Seed only an absent (or legacy browser
  // upload) selection with the server workspace. Preserve any other server path the
  // user has deliberately selected.
  try {
    const storageKey = "ccd-session-store";
    const rawValue = globalThis.localStorage.getItem(storageKey);
    const parsedValue = rawValue ? JSON.parse(rawValue) : { state: {}, version: 2 };
    const persisted = parsedValue && typeof parsedValue === "object"
      ? parsedValue
      : { state: {}, version: 2 };
    const state = persisted.state && typeof persisted.state === "object"
      ? { ...persisted.state }
      : {};
    const selectedFolder = typeof state.selectedFolder === "string"
      ? state.selectedFolder
      : "";
    const browserUploadSelection = selectedFolder.startsWith("/workspace/RemoteUploads/");
    let changed = false;

    if (!selectedFolder || browserUploadSelection) {
      state.worker = { type: "environment", id: "__local__" };
      state.selectedFolder = "/workspace";
      state.currentHostKey = "local";
      state.selectedRepos = [];
      changed = true;
    }

    const folderByHost = state.folderByHost && typeof state.folderByHost === "object"
      ? { ...state.folderByHost }
      : {};
    if (!folderByHost.local || browserUploadSelection) {
      folderByHost.local = state.selectedFolder || "/workspace";
      state.folderByHost = folderByHost;
      changed = true;
    }

    if (changed) {
      globalThis.localStorage.setItem(storageKey, JSON.stringify({
        ...persisted,
        state,
        version: 2,
      }));
    }
  } catch {
    // A blocked storage area must not prevent the official renderer booting.
    // The route-scoped FileSystem fallback below still resolves to /workspace.
  }

  // ion-dist deliberately identifies the Desktop runtime by requiring both a
  // Claude/<version> user-agent token and claudeAppBindings. A normal browser
  // has neither, so the official Cowork route reports disabled_by_enterprise
  // even when the account and Desktop boot feature both allow Cowork.
  //
  // Publish only the identity and binding lifecycle used by ion-dist. Native
  // capabilities still have to pass the exact server-side IPC allowlist.
  const desktopVersion = String(config.desktopRuntime?.version || "");
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(desktopVersion)) {
    throw new Error("Remote Desktop bridge received an invalid Desktop version");
  }
  const originalUserAgent = globalThis.navigator.userAgent;
  // The web shell (config.webShell) is ion-dist's browser chrome; it is selected
  // by the ABSENCE of the `Claude/<version>` token, so there we keep the browser
  // user agent. Everything else publishes the Desktop identity, which the
  // official route selector requires to expose the Cowork surface.
  const desktopUserAgent = config.webShell
    ? originalUserAgent
    : /claude(?:nest|gov)?\//i.test(originalUserAgent)
      ? originalUserAgent
      : `${originalUserAgent} Claude/${desktopVersion}`;
  Object.defineProperty(globalThis.navigator, "userAgent", {
    configurable: false,
    enumerable: true,
    get: () => desktopUserAgent,
  });

  const desktopBindings = new Map();
  Object.defineProperty(globalThis, "claudeAppBindings", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      registerBinding(name, callback) {
        if (typeof name !== "string" || typeof callback !== "function") {
          throw new TypeError("Desktop binding requires a name and callback");
        }
        desktopBindings.set(name, callback);
      },
      unregisterBinding(name) {
        desktopBindings.delete(name);
      },
      // The official renderer's local-connector attach code
      // (claude.ai chat and the extension settings page) lists and connects
      // the account's local MCP servers through these two bindings. The
      // Desktop preload implements them with MessagePorts a browser cannot
      // receive; the bridge relays the same JSON-RPC stream instead.
      listMcpServers: () => listBridgeMcpServers(),
      connectToMcpServer: (serverName) => connectBridgeMcpServer(serverName),
    }),
    writable: false,
  });

  // The native preload publishes these flags before ion-dist starts. Without
  // them, the official 3P route selector removes Chat and falls through from
  // Cowork to Claude Code. Relay only the Chat/Cowork flags selected by the
  // trusted Desktop wrapper so the browser follows the same official route.
  const desktopBootFeatures = Object.fromEntries(
    Object.entries(config.desktopBootFeatures || {}).map(([name, feature]) => [
      name,
      Object.freeze({ ...feature }),
    ]),
  );
  Object.defineProperty(globalThis, "desktopBootFeatures", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(desktopBootFeatures),
    writable: false,
  });

  // The renderer picks its composer design ("marlin", the deployment's choice)
  // from the device latch — `composer-card-latch` in localStorage (`shared-75`'s
  // `Fd`/`Yh`) — and, on the New page only, from the static stamp the shell
  // rewrites to `data-composer-arm="marlin"` (bridge/official-index.mjs; the
  // renderer's `Nh` refuses the stamp unless `location.pathname === "/new"` and
  // the element is un-hidden, which is true only there). Every other surface —
  // the project pages among them — therefore falls back to a latch nothing ever
  // writes, draws the pre-marlin composer (the model control inside the card,
  // the project and permission controls in a tray below it) and, with the
  // surface switch, the pre-merge Chat/Cowork pair. Seed the latch so every
  // surface resolves the same design the New page does. The app writes this key
  // when a person picks a card, and the bridge's own resets clear it, so an
  // explicit "classic" is left alone; only an absent or unrecognised value is
  // seeded.
  try {
    const composerLatch = globalThis.localStorage?.getItem("composer-card-latch");
    if (composerLatch !== "classic" && composerLatch !== "marlin") {
      globalThis.localStorage?.setItem("composer-card-latch", "marlin");
    }
  } catch {
    // Private-mode storage, or none at all: the composer falls back to the
    // renderer's own default rather than failing the page.
  }

  const listenerCallbacks = new Map();
  const latestTranscriptEvents = new Map();
  const storeCallbacks = new Map();
  const storeState = new Map(Object.entries(config.initialStores || {}));
  let events = null;
  let eventStreamKey = "";
  let eventStreamGeneration = 0;
  let eventReconnectTimer = null;
  let eventReconnectDelayMs = 1000;
  const undefinedSentinelKey = "__claudeRemoteUndefinedV1";

  function encodeIpcValue(value) {
    if (value === undefined) return { [undefinedSentinelKey]: true };
    if (Array.isArray(value)) return value.map(encodeIpcValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]),
      );
    }
    return value;
  }

  async function bridgeRequest(path, body, { retryable = false } = {}) {
    let lastError = null;
    const attempts = retryable ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          const error = new Error(
            payload.error || `Remote Desktop bridge returned HTTP ${response.status}`,
          );
          error.bridgeRetryable = response.status === 408
            || response.status === 429
            || response.status >= 500;
          throw error;
        }
        return payload.value;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts && error?.bridgeRetryable !== false) {
          await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
        } else {
          break;
        }
      }
    }
    throw lastError || new Error("Remote Desktop bridge is unavailable");
  }

  function rememberChatSessions(value) {
    const sessions = Array.isArray(value) ? value : [value];
    const chatSessionIds = new Set(
      Array.isArray(config.chatSessionIds) ? config.chatSessionIds : [],
    );
    for (const session of sessions) {
      if (session?.sessionType === "chat" && typeof session.sessionId === "string") {
        chatSessionIds.add(session.sessionId);
      }
    }
    config.chatSessionIds = [...chatSessionIds];
  }

  // BEGIN browser attachments
  // The official renderer asks Electron (webUtils.getPathForFile) for the
  // local path of an attached file. A browser has none, so the Code composer
  // can send a bare-name mention such as @"report.zip" that nothing on the
  // server can resolve. Remember the Files the user attaches; when a message is
  // sent, upload the ones it mentions through /api/remote/files/upload and
  // replace the name with the uploaded /workspace/RemoteUploads path.
  const attachmentTtlMs = 30 * 60 * 1000;
  const pendingAttachments = new Map();
  const attachmentMention = /@"([^"\n]+)"/g;

  function rememberAttachments(files) {
    const now = Date.now();
    for (const file of Array.from(files || [])) {
      if (!file || typeof file.name !== "string" || !file.name) continue;
      pendingAttachments.delete(file.name);
      pendingAttachments.set(file.name, { file, at: now });
    }
    while (pendingAttachments.size > 64) {
      pendingAttachments.delete(pendingAttachments.keys().next().value);
    }
  }

  function bareAttachmentName(mention) {
    const name = mention.startsWith("./") ? mention.slice(2) : mention;
    return name && !/[\\/]/.test(name) && !name.startsWith("~") ? name : "";
  }

  function mapStrings(value, transform, depth = 0) {
    if (typeof value === "string") return transform(value);
    if (depth > 8 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => mapStrings(item, transform, depth + 1));
    }
    if (Object.prototype.toString.call(value) !== "[object Object]") return value;
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, mapStrings(item, transform, depth + 1)],
    ));
  }

  async function resolveAttachmentMentions(args) {
    const now = Date.now();
    for (const [name, entry] of pendingAttachments) {
      if (now - entry.at > attachmentTtlMs) pendingAttachments.delete(name);
    }
    if (!pendingAttachments.size) return args;

    const wanted = new Map();
    mapStrings(args, (text) => {
      for (const match of text.matchAll(attachmentMention)) {
        const name = bareAttachmentName(match[1]);
        const entry = name ? pendingAttachments.get(name) : undefined;
        if (entry) wanted.set(name, entry.file);
      }
      return text;
    });
    if (!wanted.size) return args;

    const names = [...wanted.keys()];
    let uploaded;
    try {
      uploaded = await uploadBrowserFiles(names.map((name) => wanted.get(name)));
    } catch (error) {
      throw new Error(`Could not upload the attached files to the server: ${error.message}`);
    }
    if (!Array.isArray(uploaded?.paths) || uploaded.paths.length !== names.length) {
      throw new Error("Could not upload the attached files to the server");
    }
    const resolved = new Map(names.map((name, index) => [name, uploaded.paths[index]]));
    for (const name of names) pendingAttachments.delete(name);
    return mapStrings(args, (text) => text.replace(attachmentMention, (whole, mention) => {
      const path = resolved.get(bareAttachmentName(mention));
      return path ? `@"${path}"` : whole;
    }));
  }
  // END browser attachments

  document.addEventListener("drop", (event) => rememberAttachments(event.dataTransfer?.files), true);
  document.addEventListener("paste", (event) => rememberAttachments(event.clipboardData?.files), true);
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target?.tagName === "INPUT" && target.type === "file") rememberAttachments(target.files);
  }, true);

  async function invoke(surface, method, args) {
    if (surface === "LocalSessions" || surface === "LocalAgentModeSessions") {
      args = await resolveAttachmentMentions(args);
    }
    const value = await bridgeRequest("/api/remote/ipc", {
      surface,
      method,
      args: encodeIpcValue(args),
      argsEncoding: "json-undefined-v1",
    });
    if (
      surface === "LocalAgentModeSessions"
      && (method === "getSession" || method === "getAll")
    ) {
      rememberChatSessions(value);
    }
    return value;
  }

  function invokeSettings(surface, method, args) {
    return bridgeRequest("/api/remote/settings", {
      surface,
      method,
      args: encodeIpcValue(args),
      argsEncoding: "json-undefined-v1",
    });
  }

  function beginRelaunchRecovery() {
    let sawDisconnect = false;
    const startedAt = Date.now();
    const poll = async () => {
      if (Date.now() - startedAt > 120000) return;
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          sawDisconnect = true;
        } else if (sawDisconnect) {
          globalThis.location.assign("/");
          return;
        }
      } catch {
        sawDisconnect = true;
      }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 750);
  }

  function relaunchDesktop(args) {
    beginRelaunchRecovery();
    // A successful relaunch tears down the Electron process before its HTTP
    // response is guaranteed to complete. Fire exactly once and treat that
    // transport interruption as expected; retrying could restart it twice.
    void bridgeRequest(
      "/api/remote/settings",
      {
        surface: "Custom3pSetup",
        method: "relaunchApp",
        args: encodeIpcValue(args),
        argsEncoding: "json-undefined-v1",
      },
    ).catch(() => {});
    return Promise.resolve({ restarting: true });
  }

  function listenerKey(surface, method) {
    return `${surface}.${method}`;
  }

  function subscribe(surface, method, callback) {
    if (typeof callback !== "function") return () => {};
    const key = listenerKey(surface, method);
    const callbacks = listenerCallbacks.get(key) || new Set();
    callbacks.add(callback);
    listenerCallbacks.set(key, callbacks);
    if (surface === "LocalAgentModeSessions" && method === "onOnEvent") {
      const descriptor = eventStreamDescriptor();
      const sessionId = new URL(descriptor.url, globalThis.location.href)
        .searchParams.get("sessionId");
      const transcript = sessionId ? latestTranscriptEvents.get(sessionId) : null;
      if (transcript && transcript.isRunning === false) {
        queueMicrotask(() => {
          if (!callbacks.has(callback)) return;
          try {
            callback({
              type: "transcript_loaded",
              sessionId: transcript.sessionId,
              messages: Array.isArray(transcript.value) ? transcript.value : [],
            });
          } catch {}
        });
      }
    }
    return () => callbacks.delete(callback);
  }

  function dispatch(surface, method, payload, args) {
    // Some Desktop events are single-payload, others carry several positional
    // arguments (the extension preview is manifest/path/id/signature). The
    // wrapper relays the whole argument list in `args` when there is more than
    // one; single-payload events keep their original one-argument shape.
    const callArgs = Array.isArray(args) ? args : [payload];
    for (const callback of listenerCallbacks.get(listenerKey(surface, method)) || []) {
      try {
        callback(...callArgs);
      } catch {}
    }
  }

  async function refreshStore(surface, store) {
    const key = `${surface}.${store}`;
    const value = await bridgeRequest(
      "/api/remote/store",
      { surface, store },
      { retryable: true },
    );
    const previous = storeState.get(key);
    storeState.set(key, value);
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      for (const callback of storeCallbacks.get(key) || []) {
        try {
          callback(value);
        } catch {}
      }
    }
    return value;
  }

  function makeStore(surface, store) {
    const key = `${surface}.${store}`;
    return {
      getState: () => refreshStore(surface, store),
      getStateSync: () => storeState.get(key) || {},
      onStateChange(callback) {
        if (typeof callback !== "function") return () => {};
        const callbacks = storeCallbacks.get(key) || new Set();
        callbacks.add(callback);
        storeCallbacks.set(key, callbacks);
        return () => callbacks.delete(callback);
      },
    };
  }

  function chooseBrowserFiles({ directory = false, multiple = true, accept = "" } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = multiple;
      if (accept) input.accept = accept;
      if (directory) {
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
      }
      input.hidden = true;
      const finish = (files) => {
        globalThis.removeEventListener("focus", handleWindowFocus);
        input.remove();
        resolve(Array.from(files || []));
      };
      const handleWindowFocus = () => {
        setTimeout(() => {
          if (!input.isConnected || input.files?.length) return;
          finish([]);
        }, 500);
      };
      input.addEventListener("change", () => finish(input.files), { once: true });
      input.addEventListener("cancel", () => finish([]), { once: true });
      globalThis.addEventListener("focus", handleWindowFocus, { once: true });
      document.body.append(input);
      input.click();
    });
  }

  let uploadLimitBytes = 0;

  async function uploadLimit() {
    if (uploadLimitBytes) return uploadLimitBytes;
    try {
      const response = await fetch("/api/remote/files/limits");
      const payload = await response.json();
      uploadLimitBytes = Number(payload?.value?.maxBytes) || 0;
    } catch {
      // The server enforces the limit regardless; this only gives an early, clear error.
    }
    return uploadLimitBytes;
  }

  function formatUploadSize(bytes) {
    if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(2)} GiB`;
    if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(2)} MiB`;
    return `${Math.ceil(bytes / 1024)} KiB`;
  }

  function newUploadBatchId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Each file is sent as its own request with the raw file as the body, which
  // the browser streams from disk; the server writes it to disk as it arrives.
  // Files of one call share a batch id and so one server directory.
  async function uploadBrowserFiles(files) {
    if (!files.length) return null;
    const limit = await uploadLimit();
    const totalSize = Array.from(files).reduce((sum, file) => sum + file.size, 0);
    if (limit && totalSize > limit) {
      throw new Error(`The selected files exceed the ${formatUploadSize(limit)} upload limit`);
    }
    const batch = newUploadBatchId();
    const paths = [];
    let batchRoot = "";
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      const response = await fetch(
        `/api/remote/files/upload?batch=${batch}&path=${encodeURIComponent(relativePath)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Upload of ${relativePath} failed (HTTP ${response.status})`);
      }
      paths.push(payload.value.path);
      batchRoot = payload.value.root;
    }
    const firstParts = (files[0].webkitRelativePath || files[0].name).replaceAll("\\", "/").split("/");
    return { paths, root: firstParts.length > 1 ? `${batchRoot}/${firstParts[0]}` : batchRoot };
  }

  async function browseBrowserFiles(directory) {
    const files = await chooseBrowserFiles({ directory, multiple: true });
    return uploadBrowserFiles(files);
  }

  // BEGIN desktop extensions (MCPB)
  const extensionBundlePattern = /\.(?:dxt|mcpb)$/i;

  // The Extensions overview installs a dropped bundle through the official
  // preload's Electron path helper:
  //
  //   window.claudeAppSettings.filePickers.getPathForFile(file)
  //     -> claude.settings.Extensions.handleDxtFile(path)
  //
  // A browser has no filesystem path for a File, and the helper is synchronous.
  // Mint a one-shot token instead, remembering the File; the handleDxtFile
  // wrapper below resolves the token, uploads the File and calls the Desktop
  // with the uploaded `/workspace` path. Only extension bundles on the
  // Extensions settings route are tokenised, so the composer's attachment code
  // (which consults the same helper for every file) keeps its browser behavior.
  const extensionBundleTokenPrefix = "claudesk-extension-file:";
  const pendingExtensionBundles = new Map();
  let extensionBundleSequence = 0;

  function onExtensionSettingsRoute() {
    const location = globalThis.location;
    if (!location) return false;
    // The app routes in the hash without a slash after it (#settings/...), and
    // a direct load uses the pathname (/settings/...); match the route alone.
    return `${location.pathname}${location.hash}`.includes("settings/desktop/extensions");
  }

  function rememberExtensionBundle(file) {
    const token = `${extensionBundleTokenPrefix}${Date.now().toString(36)}-${++extensionBundleSequence}`;
    pendingExtensionBundles.set(token, { file, at: Date.now() });
    while (pendingExtensionBundles.size > 16) {
      pendingExtensionBundles.delete(pendingExtensionBundles.keys().next().value);
    }
    return token;
  }

  function browserExtensionPath(file) {
    if (!file || typeof file.name !== "string" || !extensionBundlePattern.test(file.name)) {
      return null;
    }
    if (!onExtensionSettingsRoute()) return null;
    return rememberExtensionBundle(file);
  }

  function takeExtensionBundle(value) {
    if (typeof value !== "string" || !value.startsWith(extensionBundleTokenPrefix)) return null;
    const entry = pendingExtensionBundles.get(value);
    if (!entry) return null;
    pendingExtensionBundles.delete(value);
    if (Date.now() - entry.at > 30 * 60 * 1000) return null;
    return entry.file;
  }

  function reportExtensionProblem(message) {
    console.error("[claudesk]", message);
    const toast = globalThis.__CLAUDESK_TOAST__;
    if (toast && typeof toast.add === "function") {
      toast.add({ title: "Extension install", description: message, timeout: 0 });
      return;
    }
    try {
      globalThis.alert(message);
    } catch {}
  }

  // The Extensions page's install button. The official implementation opens a
  // native file picker and returns a path inside the container, which a
  // browser cannot do. The bundle is uploaded through the same streaming route
  // as every other browser file (it lands in the shared workspace), then
  // Desktop previews it exactly as if it had been opened from disk; the
  // official preview modal takes over from there.
  async function installExtensionFromBrowser() {
    try {
      const files = await chooseBrowserFiles({
        directory: false,
        multiple: false,
        accept: ".mcpb,.dxt,application/zip",
      });
      if (!files.length) return;
      const file = files[0];
      if (!extensionBundlePattern.test(file.name)) {
        throw new Error("Choose a .mcpb or .dxt extension bundle.");
      }
      const uploaded = await uploadBrowserFiles([file]);
      const path = uploaded?.paths?.[0];
      if (!path) throw new Error("The extension upload did not return a path.");
      await invokeSettings("Extensions", "handleDxtFile", [path]);
    } catch (error) {
      reportExtensionProblem(
        `Couldn't open the extension: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // END desktop extensions

  // BEGIN browser MCP bindings
  // Electron hands a local MCP server's MessagePort to the official renderer;
  // a browser cannot receive one. The bridge's wrapper keeps the real port in
  // the Desktop renderer and multiplexes JSON-RPC over desktop-ipc events and
  // `/api/remote/mcp/*`, so this side only has to look like a MessagePort to
  // the official `claudeAppBindings` consumers.
  const bridgeMcpPorts = new Map();

  // A real MessagePort, not a look-alike: the official attach code puts the
  // port into a MessageEvent, whose `ports` sequence only accepts
  // MessagePorts. The page owns one end (the SDK attaches to it); this preload
  // keeps the other and relays its traffic over the bridge.
  function createBridgeMcpPort(connectionId) {
    const channel = new MessageChannel();
    const pagePort = channel.port1;
    const localPort = channel.port2;
    let closed = false;
    localPort.onmessage = (event) => {
      const message = event.data;
      void bridgeRequest("/api/remote/mcp/send", { connectionId, message })
        .catch((error) => {
          try {
            // postMessage on the preload's end reaches the page's port.
            localPort.postMessage({
              jsonrpc: "2.0",
              id: message && typeof message === "object" ? message.id : null,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          } catch {}
        });
    };
    const deliver = (message) => {
      if (closed) return;
      try {
        localPort.postMessage(message);
      } catch {}
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      bridgeMcpPorts.delete(connectionId);
      try {
        localPort.close();
      } catch {}
      void bridgeRequest("/api/remote/mcp/close", { connectionId }).catch(() => {});
    };
    localPort.onclose = finish;
    bridgeMcpPorts.set(connectionId, { deliver, close: finish });
    return pagePort;
  }

  function deliverBridgeMcpMessage(payload) {
    const connectionId = payload?.connectionId;
    if (typeof connectionId !== "string") return;
    const entry = bridgeMcpPorts.get(connectionId);
    if (!entry) return;
    entry.deliver(payload.message);
  }

  async function listBridgeMcpServers() {
    const value = await bridgeRequest("/api/remote/mcp/servers", {});
    return Array.isArray(value) ? value : [];
  }

  async function connectBridgeMcpServer(serverName) {
    if (typeof serverName !== "string" || !serverName || serverName.length > 512) {
      throw new Error("Invalid MCP server name");
    }
    let value;
    try {
      value = await bridgeRequest("/api/remote/mcp/connect", { serverName });
    } catch (error) {
      console.error(`[claudesk] Could not connect to MCP server ${serverName}`, error);
      throw error;
    }
    const connectionId = value?.connectionId;
    if (typeof connectionId !== "string") {
      throw new Error("The bridge did not return an MCP connection");
    }
    const port = createBridgeMcpPort(connectionId);
    // Deliver the port the way Electron's webContents.postMessage does: the
    // official attach hook listens for this on window and reads event.ports.
    globalThis.dispatchEvent(new MessageEvent("message", {
      data: { type: "mcp-server-connected", serverName, uuid: value.uuid ?? serverName },
      ports: [port],
      source: globalThis,
    }));
  }
  // END browser MCP bindings

  function openBrowserUrl(url, { downloadName } = {}) {
    const anchor = document.createElement("a");
    anchor.href = url;
    if (downloadName) anchor.download = downloadName;
    else anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function workspaceFileUrl(path, inline = false) {
    return `/api/remote/files/download?path=${encodeURIComponent(String(path || ""))}${inline ? "&inline=1" : ""}`;
  }

  // Desktop's session file APIs carry the path URI-encoded (its own reader
  // decodes it). Undo exactly that one layer before the download route
  // re-encodes it, or a space becomes `%2520` and the route misses the file.
  // A value that is not valid percent-encoding is left as-is rather than
  // throwing on a path that merely contains a `%`.
  function decodeRemoteFilePath(path) {
    const value = String(path || "");
    if (!value.includes("%")) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  let lastArtifactDownload = { artifactId: "", startedAt: 0 };

  function downloadRemoteArtifact(artifactId) {
    const id = String(artifactId || "");
    const now = Date.now();
    if (!id || (
      lastArtifactDownload.artifactId === id
      && now - lastArtifactDownload.startedAt < 2000
    )) return Promise.resolve(true);
    lastArtifactDownload = { artifactId: id, startedAt: now };
    openBrowserUrl(
      `/api/remote/artifacts/download?id=${encodeURIComponent(id)}`,
      { downloadName: `${id}.html` },
    );
    setTimeout(() => {
      const url = new URL(globalThis.location.href);
      if (url.searchParams.get("coworkArtifact") !== id) return;
      url.searchParams.delete("coworkArtifact");
      globalThis.history.replaceState(globalThis.history.state, "", url);
      globalThis.dispatchEvent(new PopStateEvent("popstate", {
        state: globalThis.history.state,
      }));
    }, 100);
    return Promise.resolve(true);
  }

  function browserMethod(surface, method) {
    if (surface === "FileSystem") {
      if (method === "browseFiles") {
        return async () => (await browseBrowserFiles(false))?.paths ?? null;
      }
      if (method === "browseFolder" || method === "browseCodeFolder") {
        // A tenant's Code folder picker asks the guest runner (source "code");
        // every other folder flow keeps browsing the workspace the bridge
        // mounts. See bridge/server.mjs, /api/remote/code-folders.
        return async (title, allowCreate, _trust, initialPath) => {
          const paths = await globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({
            title, initialPath, allowCreate: allowCreate !== false,
            ...(method === "browseCodeFolder" ? { source: "code" } : {}),
          });
          return paths?.[0] ?? null;
        };
      }
      if (method === "browseFolders") {
        return async (title, allowCreate, _trust, initialPath) =>
          globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({
            title, multiple: true, initialPath, allowCreate: allowCreate !== false,
          });
      }
      if (method === "getSystemPath") return async () => "/workspace";
      if (method === "writeFileDownload" || method === "writeFileDownloadAndOpen") {
        return async (name, url) => {
          openBrowserUrl(new URL(url, globalThis.location.href).href, { downloadName: String(name || "download") });
          return String(name || "download");
        };
      }
      // Desktop addresses a session-scoped file by session, not by path:
      // `openLocalFile(sessionId, encodeURIComponent(path), reveal?)`. Read the
      // file path from the second argument (undoing Desktop's encoding) — the
      // first is the session id, and using it as a path produced
      // `?path=local_<uuid>`, which the download route cannot resolve. The
      // third argument is Desktop's "reveal in folder" variant, which the
      // remote equivalent serves as a download (as `showInFolder` does) rather
      // than an inline preview. A plain host path is used verbatim.
      if (method === "openLocalFile") {
        return async (_sessionId, path, reveal) => {
          openBrowserUrl(workspaceFileUrl(decodeRemoteFilePath(path), !reveal));
          return true;
        };
      }
      if (method === "showInFolder") {
        return async (path) => {
          openBrowserUrl(workspaceFileUrl(path, false));
          return true;
        };
      }
    }
    if (surface === "CoworkUserFiles") {
      if (method === "pickTarget") return async () =>
        (await globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({}))?.[0] ?? null;
      if (method === "reveal") {
        return async () => false;
      }
    }
    if (surface === "CoworkSpaces" && method === "openFile") {
      return async (_spaceId, path) => {
        openBrowserUrl(workspaceFileUrl(path, true));
        return true;
      };
    }
    if (surface === "CoworkArtifacts" && method === "printArtifactToPdf") {
      return async () => {
        globalThis.print();
        return true;
      };
    }
    if (surface === "CoworkArtifacts" && method === "showArtifact") {
      return downloadRemoteArtifact;
    }
    if (
      surface === "CoworkArtifacts"
      && ["hideArtifact", "parkAndCaptureArtifact", "reloadArtifactView"].includes(method)
    ) {
      return async () => null;
    }
    // Desktop renders a file preview into a native Electron view over its own
    // window, which the browser never composites, and converts Office files with
    // a Cowork-VM LibreOffice run. The renderer patch replaces the pane's preview
    // with an <iframe> at the bridge's own preview route, so this surface must
    // stop forwarding: report the feature as available and answer show as a no-op
    // rather than let Desktop build a native view and convert a file the browser
    // renders itself.
    if (surface === "CoworkFilePreview") {
      if (method === "isEnabled" || method === "isEpitaxyPreviewEnabled"
        || method === "isOpenInDefaultAppEnabled") return async () => true;
      if (method === "isVmReady") return async () => true;
      if (method === "show") return async () => ({ ok: true });
      if (method === "hide") return async () => true;
      if (method === "parkAndCapture") return async () => null;
      if (method === "whenContentReady") {
        return async () => ({ ready: false, reason: "unobserved" });
      }
    }
    if (surface === "LocalSessions") {
      if (method === "getDetectedProjects") {
        return async (...args) => {
          const detected = await invoke(surface, method, args);
          const projects = Array.isArray(detected) ? detected : [];
          const withoutWorkspace = projects.filter((project) => project?.path !== "/workspace");
          return [{ path: "/workspace", lastActivity: Date.now() }, ...withoutWorkspace];
        };
      }
      if (method === "pickSessionFile" || method === "pickFileAtCwd") {
        return async () => (await browseBrowserFiles(false))?.paths?.[0] ?? null;
      }
    }
    return (...args) => invoke(surface, method, args);
  }


  const root = Object.create(null);
  const surfaceNames = new Set([
    ...Object.keys(config.methods || {}),
    ...Object.keys(config.listeners || {}),
    ...Object.keys(config.stores || {}),
  ]);
  for (const surface of surfaceNames) {
    const api = Object.create(null);
    for (const method of config.methods?.[surface] || []) {
      api[method] = browserMethod(surface, method);
    }
    for (const method of config.listeners?.[surface] || []) {
      api[method] = (callback) => subscribe(surface, method, callback);
    }
    for (const store of config.stores?.[surface] || []) {
      api[store] = makeStore(surface, store);
    }
    // The relayed-notification surface also carries the method set the
    // official renderer calls directly.
    if (surface === "DesktopNotifications") {
      Object.assign(api, createDesktopNotificationsBridge());
    }
    root[surface] = Object.freeze(api);
  }
  if (!root.DesktopNotifications) {
    root.DesktopNotifications = Object.freeze(createDesktopNotificationsBridge());
  }

  // BEGIN browser notifications
  // The official Desktop decides when to notify (a finished turn, a tool
  // permission, an AskUserQuestion card, ...) and renders that decision as a
  // native notification inside the container — where nobody can see it. The
  // wrapper relays every notification the official code actually shows; this
  // preload turns those into real browser notifications, mirroring the official
  // behavior: nothing is shown while the user is looking at that very session,
  // a click focuses the tab and opens the session (running the same official
  // click handler through the bridge), and a close event closes the matching
  // browser notification. The same surface is published as
  // `claude.web.DesktopNotifications`, so the official renderer paths that call
  // it directly also work in a browser. With notifications granted, the page
  // also registers a push subscription (see /sw.js) so the bridge can deliver
  // notifications while no tab is open.

  const remoteNotificationTags = new Map();
  const notificationClientStorageKey = "ccd-notification-client";
  let pushSyncAt = 0;
  let pushSyncPromise = null;

  function browserNotificationStatus() {
    if (!("Notification" in globalThis)) return "denied";
    switch (Notification.permission) {
      case "granted": return "authorized";
      case "denied": return "denied";
      default: return "notDetermined";
    }
  }

  function remoteNotificationClientId() {
    try {
      let id = globalThis.localStorage.getItem(notificationClientStorageKey);
      if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) {
        id = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `client-${Math.floor(Math.random() * 1e9)}`;
        globalThis.localStorage.setItem(notificationClientStorageKey, id);
      }
      return id;
    } catch {
      return "";
    }
  }

  function notificationKeyBytes(encoded) {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function navigateToRemoteRoute(route) {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) return false;
    let target;
    try {
      target = new URL(route, globalThis.location.href);
    } catch {
      return false;
    }
    if (target.origin !== globalThis.location.origin) return false;
    if (
      target.pathname === globalThis.location.pathname
      && target.search === globalThis.location.search
    ) return true;
    // Push the same route the app's own navigation would and let its router
    // react to the popstate, the way the artifact download route already does.
    globalThis.history.pushState(
      globalThis.history.state,
      "",
      `${target.pathname}${target.search}`,
    );
    globalThis.dispatchEvent(new PopStateEvent("popstate", { state: globalThis.history.state }));
    return true;
  }

  // Run the official click handler through the bridge: it navigates the
  // Desktop renderer (inert here) and clears its pending-prompt bookkeeping,
  // and its answer tells us where the notification pointed.
  async function relayNotificationClick(tag, action) {
    if (typeof tag !== "string" || !tag) return null;
    try {
      const response = await fetch("/api/remote/notifications/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, action }),
        signal: AbortSignal.timeout(2500),
      });
      const payload = await response.json().catch(() => ({}));
      const route = payload?.value?.route;
      return typeof route === "string" && route.startsWith("/") ? route : null;
    } catch {
      return null;
    }
  }

  // Answer a folder dialog the main process opened (relayed by the wrapper) with
  // the in-page picker, then report the selection back. A cancelled pick — or a
  // picker that is not available — reports a cancel so the pending dialog
  // settles instead of hanging.
  async function answerRemoteFolderPick(request) {
    const id = typeof request?.id === "string" ? request.id : "";
    if (!id) return false;
    let paths = null;
    if (typeof globalThis.__CLAUDE_PICK_SERVER_FOLDERS__ === "function") {
      try {
        paths = await globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({
          title: typeof request.title === "string" && request.title ? request.title : undefined,
          multiple: request.multiple === true,
          initialPath: typeof request.defaultPath === "string" ? request.defaultPath : undefined,
          allowCreate: request.allowCreate !== false,
        });
      } catch {}
    }
    const selected = Array.isArray(paths)
      ? paths.filter((path) => typeof path === "string" && path).slice(0, 64)
      : [];
    try {
      await bridgeRequest("/api/remote/folder-pick", {
        id,
        canceled: selected.length === 0,
        paths: selected,
      }, { retryable: true });
    } catch {}
    return true;
  }

  function closeRemoteNotification(tag) {
    const handle = remoteNotificationTags.get(tag);
    if (!handle) return;
    remoteNotificationTags.delete(tag);
    try {
      handle.close();
    } catch {}
  }

  // The page's own notifications are not persistent, so they cannot carry
  // action buttons. A permission card therefore goes through the service
  // worker's registration (`registration.showNotification`) — that path
  // supports actions, and its clicks arrive at the worker's notificationclick
  // handler, which already answers the card and opens the session exactly like
  // a pushed notification's. A registration is made on demand here rather than
  // reusing the push sync's: it must not depend on push support (Helium ships
  // no Web Push service and hangs on subscribe), and it must exist even in a
  // browser where the sync's PushManager gate stopped it. Without a
  // registration (plain-HTTP origin, registration failure) a card still shows,
  // as a plain clickable notification — and says so on the console, because
  // that difference is otherwise invisible.
  let notificationRegistrationPromise = null;
  function notificationServiceWorkerRegistration() {
    if (!("serviceWorker" in navigator)
      || typeof navigator.serviceWorker.getRegistration !== "function") {
      return Promise.resolve(null);
    }
    notificationRegistrationPromise ??= (async () => {
      try {
        const existing = await navigator.serviceWorker.getRegistration("/");
        const registration = existing
          ?? await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (!registration.active) {
          // showNotification needs an active worker; a freshly installed one
          // activates on its own, but a card must not wait forever for it.
          await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        }
        return registration;
      } catch (error) {
        console.warn("[claudesk] the notification service worker is unavailable; notifications will not carry buttons:", error);
        return null;
      }
    })();
    return notificationRegistrationPromise;
  }

  function rememberRemoteNotification(tag, handle) {
    const previous = remoteNotificationTags.get(tag);
    if (previous && previous !== handle) {
      try {
        previous.close();
      } catch {}
    }
    remoteNotificationTags.set(tag, handle);
    // The worker path has no onclose callback, so entries for dismissed cards
    // are only reclaimed here; the map exists to close a still-visible
    // notification, so dropping the oldest is harmless.
    while (remoteNotificationTags.size > 32) {
      remoteNotificationTags.delete(remoteNotificationTags.keys().next().value);
    }
  }

  async function showRemoteNotification(record) {
    if (!("Notification" in globalThis) || Notification.permission !== "granted") return false;
    // Relayed events can outlive their moment when no page was connected (the
    // relay queue is drained on reconnect); a stale notification must not pop
    // up after the fact.
    const at = Number(record?.at);
    if (Number.isFinite(at) && at > 0 && Date.now() - at > 60000) return false;
    const sessionId = typeof record?.sessionId === "string" ? record.sessionId : "";
    const navigateTo = typeof record?.navigateTo === "string"
      ? record.navigateTo
      : typeof record?.route === "string" ? record.route : "";
    if (document.hasFocus()) {
      const path = globalThis.location.pathname;
      // The official Desktop suppresses a notification while the user is
      // viewing that session; here the browser's focused route is the
      // equivalent. Sessionless nudges (rate limits, ...) only surface while
      // the page is in the background, as the web app does.
      if (sessionId && path.includes(sessionId)) return false;
      if (navigateTo && path === navigateTo.split("?")[0]) return false;
      if (!sessionId && !navigateTo) return false;
    }
    const title = String(record?.title || "Claude").slice(0, 200);
    const tag = typeof record?.tag === "string" && record.tag
      ? record.tag
      : `remote-${Date.now()}`;
    const options = {
      body: String(record?.body || "").slice(0, 400),
      // The official Desktop app icon, served same-origin (and already the
      // PWA icon). Chrome uses it on Windows and Linux; macOS shows the
      // browser/app icon instead and ignores this.
      icon: "/desktop-icon.png",
      tag,
      // A replacement for the same tag re-alerts (the platform's default
      // sound) instead of quietly swapping the text.
      renotify: true,
      // Permission and question cards must not slide away unread; a finished
      // turn may dismiss itself like the desktop notification would.
      ...(record?.kind === "permission" || record?.kind === "ask"
        ? { requireInteraction: true }
        : {}),
    };
    // The `in` check keeps the no-worker case on the synchronous path below,
    // so a plain origin never pays a microtask before its notification shows.
    if (record?.kind === "permission" && "serviceWorker" in navigator) {
      const registration = await notificationServiceWorkerRegistration();
      if (registration?.active) {
        try {
          await registration.showNotification(title, {
            ...options,
            // The worker's click handler needs the same payload a pushed
            // notification carries.
            data: {
              tag,
              route: navigateTo || null,
              kind: "permission",
              allowOnce: record?.allowOnce === true,
            },
            // Deny is always possible; "Allow once" only when the official
            // notification offered it too (the official web push had the same
            // deny-only variant).
            actions: record?.allowOnce === true
              ? [{ action: "allow_once", title: "Allow once" }, { action: "deny", title: "Deny" }]
              : [{ action: "deny", title: "Deny" }],
          });
          rememberRemoteNotification(tag, {
            close: () => {
              void registration.getNotifications({ tag })
                .then((notifications) => notifications.forEach((item) => item.close()))
                .catch(() => {});
            },
          });
          return true;
        } catch (error) {
          console.warn("[claudesk] the notification service worker could not show this card; using a plain notification without buttons:", error);
        }
      } else if (registration) {
        console.warn("[claudesk] the notification service worker is not active yet; showing this card without buttons");
      }
    }
    let notification;
    try {
      notification = new Notification(title, options);
    } catch {
      return false;
    }
    rememberRemoteNotification(tag, notification);
    notification.onclick = () => {
      globalThis.focus();
      closeRemoteNotification(tag);
      void (async () => {
        const route = await relayNotificationClick(tag, "default");
        if (route) navigateToRemoteRoute(route);
        else if (navigateTo) navigateToRemoteRoute(navigateTo);
      })();
    };
    notification.onclose = () => {
      if (remoteNotificationTags.get(tag) === notification) remoteNotificationTags.delete(tag);
    };
    return true;
  }

  let pushConfigPromise = null;
  function fetchPushConfig() {
    pushConfigPromise ??= fetch("/api/remote/notifications/config", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => (
        typeof payload?.value?.vapidPublicKey === "string" ? payload.value.vapidPublicKey : ""
      ))
      .catch(() => "");
    return pushConfigPromise;
  }

  // Some browsers never settle a Push API call — Helium ships no Web Push
  // service at all and its subscribe() neither resolves nor rejects — so every
  // push-manager call is raced against a deadline; a wedged promise must not
  // live for the page's lifetime.
  function settleWithin(promise, milliseconds, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)),
    ]);
  }

  // Keep the push subscription in step with the browser permission: a granted
  // page subscribes (so notifications arrive with every tab closed), a page
  // whose permission was revoked drops it again. Registration and subscription
  // are idempotent; the throttle keeps focus events from re-posting constantly.
  function syncPushSubscription({ force = false } = {}) {
    if (pushSyncPromise) return pushSyncPromise;
    if (!force && Date.now() - pushSyncAt < 5 * 60 * 1000) return Promise.resolve();
    pushSyncAt = Date.now();
    pushSyncPromise = (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in globalThis)) return;
        const granted = "Notification" in globalThis && Notification.permission === "granted";
        if (!granted) {
          // Nothing to install before the user ever granted notifications; a
          // subscription from an earlier grant is dropped, so the bridge stops
          // pushing to a browser that no longer wants (or shows) them.
          const existingRegistration = await navigator.serviceWorker.getRegistration("/").catch(() => null);
          const subscription = existingRegistration
            ? await settleWithin(existingRegistration.pushManager.getSubscription(), 10000, "the browser did not answer getSubscription").catch(() => null)
            : null;
          if (subscription) {
            await subscription.unsubscribe().catch(() => {});
            await fetch("/api/remote/notifications/unsubscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: subscription.endpoint }),
            }).catch(() => {});
          }
          return;
        }
        const registration = await notificationServiceWorkerRegistration();
        if (!registration) return;
        const existing = await settleWithin(
          registration.pushManager.getSubscription(),
          10000,
          "the browser did not answer getSubscription",
        ).catch(() => null);
        const vapidPublicKey = await fetchPushConfig();
        if (!vapidPublicKey) return;
        const expectedKey = notificationKeyBytes(vapidPublicKey);
        let subscription = existing;
        if (subscription) {
          // A subscription is bound to the key that created it; after the
          // bridge state is reset the old one can never be delivered to, so it
          // is replaced rather than kept.
          const appliedKey = subscription.options?.applicationServerKey
            ? new Uint8Array(subscription.options.applicationServerKey)
            : null;
          const sameKey = appliedKey
            && appliedKey.length === expectedKey.length
            && expectedKey.every((byte, index) => byte === appliedKey[index]);
          if (!sameKey) {
            await subscription.unsubscribe().catch(() => {});
            subscription = null;
          }
        }
        if (!subscription) {
          subscription = await settleWithin(
            registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: expectedKey,
            }),
            15000,
            "the browser's push service did not answer (this browser may have no Web Push service)",
          );
        }
        await fetch("/api/remote/notifications/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            clientId: remoteNotificationClientId(),
          }),
        }).catch(() => {});
      } catch (error) {
        // Push is best-effort and in-page notifications keep working without
        // it, but say why once per attempt: a browser with no push service (or
        // a wedged one) is otherwise indistinguishable from a broken bridge.
        console.info("[claudesk] no push subscription; notifications will only appear while a Claudesk tab is open:",
          error instanceof Error ? error.message : error);
      }
    })().finally(() => {
      pushSyncPromise = null;
    });
    return pushSyncPromise;
  }

  function createDesktopNotificationsBridge() {
    return {
      getAuthorizationStatus: async () => browserNotificationStatus(),
      requestAuthorization: async () => {
        if (!("Notification" in globalThis)) return "denied";
        let result;
        try {
          result = await Notification.requestPermission();
        } catch {
          return "error";
        }
        if (result === "granted") void syncPushSubscription({ force: true });
        return result === "granted" ? "granted" : result === "denied" ? "denied" : "error";
      },
      // The official handler opens the OS notification settings, which a
      // browser page cannot do; permission changes are picked up by the sync
      // above on the next focus instead.
      openNotificationSettings: () => undefined,
      showNotification: async (title, body, tag, navigateTo, _notificationType, attribution) => {
        try {
          await showRemoteNotification({
            title,
            body,
            tag,
            navigateTo,
            sessionId: attribution?.sessionId,
            kind: "generic",
            at: Date.now(),
          });
        } catch {}
        return true;
      },
    };
  }

  // The wrapper's relayed notifications (the ones the official main process
  // shows) arrive like any other relayed event. These subscriptions exist
  // regardless of what the renderer subscribes to.
  subscribe("DesktopNotifications", "onNotification", (record) => {
    // The promise is returned so the smoke can await a display and a failure
    // can never escape into the event dispatch.
    try {
      return Promise.resolve(showRemoteNotification(record)).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  });
  subscribe("DesktopNotifications", "onNotificationClosed", (record) => {
    if (typeof record?.tag === "string") closeRemoteNotification(record.tag);
  });

  // The Desktop main process opens an OS folder dialog for Cowork's folder
  // grant (`mcp__cowork__request_cowork_directory`) and the other folder flows.
  // In this container that dialog renders on a display nobody is watching, so
  // the wrapper routes it here: answer it with the same in-page picker the
  // folder IPCs use, then post the chosen paths back so the main process can
  // mount the folder and the agent turn can continue.
  subscribe("RemoteFolderPicker", "onRequest", (request) => {
    try {
      return Promise.resolve(answerRemoteFolderPick(request)).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type === "claudesk-notification-navigate" && typeof data.route === "string") {
        navigateToRemoteRoute(data.route);
      }
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void syncPushSubscription();
  });
  globalThis.addEventListener("focus", () => void syncPushSubscription());
  void syncPushSubscription();
  // END browser notifications

  // BrowserNavigation.requestMainMenuPopup normally opens Electron's native
  // Windows application menu. The browser controller renders the live,
  // read-only menu model obtained from the running official Desktop process.
  if (!root.BrowserNavigation) {
    root.BrowserNavigation = Object.freeze({
      requestMainMenuPopup() {
        globalThis.__CLAUDE_REMOTE_MAIN_MENU__?.open?.();
      },
    });
  }
  Object.defineProperty(globalThis, "claude.web", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(root),
    writable: false,
  });

  // Desktop extensions are published on the settings root, not `claude.web`.
  // The official Settings → Extensions page reads them through
  // `claude.settings.Extensions`; build that namespace whenever either the
  // Gateway settings surfaces or the Extensions surface is exposed. An install
  // the browser starts is uploaded into the shared workspace and handed to the
  // Desktop through `handleDxtFile`, the same preview path a `.mcpb` opened in
  // the Desktop window takes.
  const settingsMethods = config.settingsMethods || {};
  const extensionMethods = settingsMethods.Extensions;
  const extensionsAvailable = Array.isArray(extensionMethods) && extensionMethods.length > 0;
  if (config.gatewaySettingsEnabled || extensionsAvailable) {
    const settingsRoot = Object.create(null);
    for (const [surface, methods] of Object.entries(settingsMethods)) {
      const api = Object.create(null);
      for (const method of methods) {
        if (surface === "Custom3pSetup" && method === "openSetupWindow") {
          api[method] = async () => {
            globalThis.location.assign("/setup-desktop-3p");
          };
        } else if (surface === "Custom3pSetup" && method === "setDeploymentMode") {
          api[method] = async (mode) => {
            if (mode !== "3p") throw new Error("Only third-party deployment mode is available");
            globalThis.location.assign("/setup-desktop-3p");
          };
        } else if (surface === "Custom3pSetup" && method === "relaunchApp") {
          api[method] = (...args) => relaunchDesktop(args);
        } else {
          api[method] = (...args) => invokeSettings(surface, method, args);
        }
      }
      if (surface === "Extensions") {
        // The main process requires an organization policy backend to
        // authorize a local install; this deployment has none, so the preload
        // reports that browser installs are supported and publishes its own
        // picker. The server-side allowlist forwards only the methods above,
        // so `showInstallDxtDialog` never reaches the native dialog.
        api.isLocalExtensionInstallAllowed = async () => true;
        api.showInstallDxtDialog = installExtensionFromBrowser;
        // The official preload publishes the Extensions *events* on this same
        // settings namespace (`onPreviewExtensionInstallation` renders the
        // install modal after a bundle is uploaded or dropped). The bridge
        // relays them, but `config.listeners` otherwise only populates
        // `claude.web.<Surface>`; mirror them here where the page reads them.
        for (const method of config.listeners?.Extensions || []) {
          api[method] = (callback) => subscribe("Extensions", method, callback);
        }
        // The overview's drop handler receives a token from
        // `claudeAppSettings.filePickers.getPathForFile` (see above). Resolve
        // it here, upload the bundle through the same streaming route as the
        // picker, and hand the Desktop the uploaded path.
        const forwardHandleDxtFile = api.handleDxtFile;
        if (typeof forwardHandleDxtFile === "function") {
          api.handleDxtFile = async (...args) => {
            const file = args.length === 1 ? takeExtensionBundle(args[0]) : null;
            if (!file) return forwardHandleDxtFile(...args);
            const uploaded = await uploadBrowserFiles([file]);
            const path = uploaded?.paths?.[0];
            if (!path) throw new Error("The extension upload did not return a path.");
            return forwardHandleDxtFile(path);
          };
        }
        // The preview modal fires this without awaiting, and the Desktop
        // reports failures through a native dialog this side cannot see. The
        // wrapper turns that dialog into a rejected relay, so catch it and
        // show the reason as a toast instead of an unhandled rejection.
        const forwardInstall = api.installExtensionFromPreview;
        if (typeof forwardInstall === "function") {
          api.installExtensionFromPreview = async (...args) => {
            try {
              const value = await forwardInstall(...args);
              if (value == null) throw new Error("The extension was not installed.");
              return value;
            } catch (error) {
              reportExtensionProblem(
                `Couldn't install the extension: ${error instanceof Error ? error.message : String(error)}`,
              );
              return null;
            }
          };
        }
      }
      if (surface === "AppPreferences") {
        // A tenant has no local executor but does have a Code surface on its
        // self-hosted runner; its draft permission mode, model and effort
        // picks live behind this shim. Without it the renderer sees no
        // preference API and every pick silently fails to persist.
        if (!config.codeSettingsEnabled && !config.codeActionsEnabled) continue;
        settingsRoot[surface] = createCodePreferences();
      } else settingsRoot[surface] = Object.freeze(api);
    }
    if (extensionsAvailable) {
      // The official FilePickers surface is what the Extensions page uses for
      // its directory/file pickers (advanced settings and user_config fields).
      // It also gates the overview's drop handler, which reads
      // `claude.settings.FilePickers` directly before touching a dropped file.
      // A browser cannot return a container path from a native dialog, so the
      // chosen files are uploaded to the shared workspace instead; the Desktop
      // can read the returned `/workspace` paths like any other uploaded file.
      settingsRoot.FilePickers = Object.freeze({
        async getDirectoryPath() {
          const uploaded = await browseBrowserFiles(true);
          return uploaded ? [uploaded.root] : null;
        },
        async getFilePath() {
          const uploaded = await browseBrowserFiles(false);
          return uploaded ? uploaded.paths : null;
        },
      });
      // The official preload publishes `claudeAppSettings` with Electron's
      // synchronous `webUtils.getPathForFile`; the extension drop handler
      // requires it to exist. Publish only that helper (see above), and only
      // for extension bundles, so other Desktop-only paths keep their browser
      // behavior. The attachments code asks for a path for every dropped file
      // and treats null exactly as it does today.
      if (!globalThis.claudeAppSettings) {
        Object.defineProperty(globalThis, "claudeAppSettings", {
          configurable: true,
          enumerable: false,
          value: Object.freeze({
            filePickers: Object.freeze({ getPathForFile: browserExtensionPath }),
          }),
        });
      }
      // The Extensions page's *initial* policy snapshot is mapped from the
      // Desktop's `desktopManagedConfig` global, which a browser does not have.
      // Without it the first paint says extensions are disabled until the
      // provider's `isExtensionsEnabled()`/`isLocalExtensionInstallAllowed()`
      // calls settle. Those calls are the authority; this only mirrors their
      // deployment answer for the first render. `deploymentMode` is omitted on
      // purpose: its presence tells other code this is the Desktop app.
      if (!globalThis.desktopManagedConfig) {
        Object.defineProperty(globalThis, "desktopManagedConfig", {
          configurable: true,
          enumerable: false,
          value: Object.freeze({
            extensionsEnabled: true,
            localExtensionInstallAllowed: true,
          }),
        });
      }
    }
    Object.defineProperty(globalThis, "claude.settings", {
      configurable: false,
      enumerable: false,
      value: Object.freeze(settingsRoot),
      writable: false,
    });

    // The current official Linux ion bundle renders the 3P "Inference
    // configuration" user-menu item, but its packaged click helper resolves
    // to a no-op instead of Custom3pSetup.openSetupWindow. Keep the repair in
    // the remote preload (rather than rewriting the official bundle) and only
    // intercept that exact official menu item. Normal Claude Settings remains
    // untouched.
    document.addEventListener("click", (event) => {
      const menuItem = event.target instanceof Element
        ? event.target.closest('[role="menuitem"]')
        : null;
      if (!menuItem) return;
      const label = String(menuItem.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
      if (label !== "inference configuration") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      globalThis.location.assign("/setup-desktop-3p");
    }, true);

    if (globalThis.location.pathname === "/setup-desktop-3p") {
      document.documentElement.classList.add("claude-remote-setup-route");
      const enhanceSetupPage = () => {
        const header = document.querySelector("header");
        if (header && !document.getElementById("claude-remote-setup-back")) {
          const back = document.createElement("button");
          back.id = "claude-remote-setup-back";
          back.type = "button";
          back.setAttribute("aria-label", "Back to Claude");
          back.title = "Back to Claude";
          back.textContent = "←";
          back.addEventListener("click", () => globalThis.location.assign("/"));
          header.prepend(back);
        }
        for (const heading of document.querySelectorAll("h1")) {
          const icon = heading.previousElementSibling;
          if (icon?.querySelector?.('svg[width="104"][height="104"]')) {
            icon.classList.add("claude-remote-relaunch-icon");
          }
        }
      };
      enhanceSetupPage();
      const setupObserver = new MutationObserver(enhanceSetupPage);
      setupObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // BEGIN login shell
  // A login-shell instance serves Claude's own sign-in page and refuses the
  // whole API (see the bridge's handleApi gate); the page renders because the
  // bootstrap answers an error, which is how the renderer concludes it is signed
  // out. Its card, however, signs in through claude.ai's provider and magic-link
  // flows, which do not exist here, and it has no password field at all. So the
  // real card is extended rather than replaced: a password field beneath the
  // email, submitted to this deployment's auth service, and the provider buttons
  // dropped, since there is nothing behind them. Everything is read from and
  // written to the DOM — the card belongs to React and this runs outside its
  // tree, so a MutationObserver re-applies whatever a re-render discards.
  // The sign-in shell. The instance says so when the mode is applied — and the
  // route says so too, because this bundle's sign-in page is only ever reached
  // without a session at `/login`: every other path is the workspace, behind the
  // session gate. Acting on the route as well keeps the page right when the
  // instance's mode has not been applied, which is otherwise silent.
  const loginShellPage = config.loginShell === true
    || globalThis.location.pathname.replace(/\/+$/, "") === "/login";
  if (loginShellPage) {
    const passwordId = "claudesk-login-password";
    const errorId = "claudesk-login-error";
    // Marks the document for the shell's own stylesheet (the scroll lock), set
    // here rather than after a mount so it is in place for the first paint.
    document.documentElement.classList.add("claudesk-login-shell");

    function setLoginError(message) {
      let node = document.getElementById(errorId);
      if (!message) {
        node?.remove();
        return;
      }
      if (!node) {
        node = document.createElement("p");
        node.id = errorId;
        node.className = "claudesk-login-error";
        node.setAttribute("role", "alert");
        const submit = document.querySelector('[data-testid="continue"]');
        const block = submit?.closest("div.flex.flex-col") ?? submit;
        (block?.parentElement ?? document.body).insertBefore(node, block ?? null);
      }
      node.textContent = message;
    }

    // Remove something that exists only to hold the node we cannot use: climb
    // while the parent has no other element child, so a wrapper goes with it and
    // anything sharing the row stays.
    function removeWithWrapper(node) {
      let target = node;
      while (target.parentElement && target.parentElement.childElementCount === 1) {
        target = target.parentElement;
      }
      target.remove();
    }

    async function submitLogin() {
      const email = String(document.querySelector('[data-testid="email"]')?.value || "").trim();
      const password = String(document.getElementById(passwordId)?.value || "");
      const submit = document.querySelector('[data-testid="continue"]');
      if (!email || !password) {
        setLoginError("Enter your email and password to continue.");
        return;
      }
      setLoginError("");
      if (submit) submit.disabled = true;
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error || "sign in failed");
        // Same rule the auth service's own page uses, plus a `next` the proxy
        // may have attached when it turned a request away.
        const next = new URLSearchParams(globalThis.location.search).get("next") || "";
        const safe = next.startsWith("/") && !next.startsWith("//");
        globalThis.location.assign(safe ? next : body?.user?.role === "Admin" ? "/admin" : "/");
      } catch (error) {
        setLoginError(error?.message || "sign in failed");
        if (submit) submit.disabled = false;
      }
    }

    // What the shell serves is claude.ai's *marketing* sign-in page, so it
    // arrives with a nav full of links and calls to action, a plans section and
    // footer below the fold, and a desktop-app pitch — all aimed at claude.ai's
    // visitors, none of it true of this deployment. Keep the wordmark, the card
    // and nothing else.
    const LEGAL_TEXT = "Usage is subject to Subrouter limits. Don't be selfish!";

    // The innermost element whose text carries `text`: the nav, the card and the
    // page wrapper all contain it too, and it is the leaf that is worth
    // rewriting.
    function deepestWithText(text, selector) {
      let deepest;
      let depth = -1;
      for (const node of document.querySelectorAll(selector)) {
        if (!String(node.textContent || "").includes(text)) continue;
        let levels = 0;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) levels += 1;
        if (levels > depth) {
          depth = levels;
          deepest = node;
        }
      }
      return deepest;
    }

    function trimLoginChrome() {
      const card = document.querySelector('[data-testid="email"]');
      const block = card?.closest("main") ?? card?.closest("section") ?? null;

      // The nav: walk up from the wordmark, and at every level drop the siblings
      // of the branch that carries it. Tag-agnostic on purpose — the bundle's
      // navbar is not necessarily a <nav> — and bounded two ways so it can only
      // ever strip a navbar: it stops at the block holding the sign-in, and it
      // refuses outright if the wordmark is inside that block.
      const logo = document.querySelector('svg[data-cds="ClaudeLogo"]');
      if (block && logo && !block.contains(logo)) {
        for (let node = logo; node?.parentElement;) {
          const parent = node.parentElement;
          if (parent === document.body || parent.contains(block)) break;
          for (const child of [...parent.children]) {
            if (child !== node) child.remove();
          }
          node = parent;
        }
      }

      // Everything below the sign-in: the plans section, the footer, whatever
      // the bundle puts after the block that holds the card.
      if (block?.parentElement) {
        for (const sibling of [...block.parentElement.children]) {
          // DOCUMENT_POSITION_FOLLOWING — only what comes after the sign-in.
          if (sibling !== block && block.compareDocumentPosition(sibling) & 4) {
            sibling.remove();
          }
        }
      }
      for (const footer of document.querySelectorAll("footer")) footer.remove();

      // The desktop-app pitch, by its own test id, with a text fallback in case
      // the bundle stops carrying one.
      const download = document.querySelector('[data-testid="download-desktop-app"]')
        ?? [...document.querySelectorAll("a, button")]
          .find((node) => String(node.textContent || "").trim() === "Download desktop app");
      if (download) removeWithWrapper(download);

      // The legal line, in the slot the card keeps for it. Rewritten rather
      // than hidden: it is the one place on the page that speaks for this
      // deployment. The sentence and the link are separately wrapped in some
      // builds, so climb from the link to the outermost element that still
      // reads as that one line — short, and holding no second link — and
      // replace the line rather than the fragment.
      const link = deepestWithText("Privacy Policy", "a, span, p, div, small");
      if (link) {
        let line = link;
        for (let level = 0; level < 4; level += 1) {
          const parent = line.parentElement;
          // Whatever holds the line and nothing else: still the sentence, short,
          // no second link, and no control. The card itself would pass the first
          // two tests but never the last, which is what keeps this from eating
          // the form.
          if (!parent || !String(parent.textContent || "").includes("Privacy Policy")
            || String(parent.textContent || "").trim().length > 200
            || parent.querySelectorAll("a").length > 1
            || parent.querySelector("input, textarea, button, form")) break;
          line = parent;
        }
        if (line.textContent !== LEGAL_TEXT) line.textContent = LEGAL_TEXT;
      }
    }

    const enhanceLoginShell = () => {
      // Page-level trims first, and independent of the card: the nav and the
      // footer are up before the card is, and a re-render can put them back.
      trimLoginChrome();
      const email = document.querySelector('[data-testid="email"]');
      const submit = document.querySelector('[data-testid="continue"]');
      if (!email || !submit) return;
      // The submit block's parent is the card's field column, so a field added
      // beside it inherits the same gap and lands directly beneath the email.
      const block = submit.closest("div.flex.flex-col") ?? submit;
      const column = block.parentElement;
      if (!column) return;

      if (!document.getElementById(passwordId)) {
        // A clone of the email field keeps the design system's own classes, so
        // the new field is styled by the bundle rather than by us.
        const password = email.cloneNode(true);
        password.id = passwordId;
        password.type = "password";
        password.value = "";
        password.setAttribute("data-testid", "claudesk-login-password");
        password.setAttribute("aria-label", "Password");
        password.setAttribute("placeholder", "Enter your password");
        password.setAttribute("autocomplete", "current-password");
        password.removeAttribute("readonly");
        password.disabled = false;
        column.insertBefore(password, block);
      }

      for (const id of ["login-with-google", "login-with-apple"]) {
        const provider = document.querySelector(`[data-testid="${id}"]`);
        if (provider) removeWithWrapper(provider);
      }
      // The divider that separates the provider buttons from the email field.
      for (const node of column.children) {
        if (node.id === passwordId) continue;
        const text = String(node.textContent || "").trim();
        if (text.length <= 2 && text.toUpperCase() === "OR") removeWithWrapper(node);
      }

      const form = submit.closest("form");
      const target = form ?? submit;
      if (target.dataset.claudeskLogin === "1") return;
      target.dataset.claudeskLogin = "1";
      // Capture, so the card's own React handler on the root never sees the
      // event and its claude.ai flow cannot start.
      target.addEventListener(form ? "submit" : "click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitLogin();
      }, true);
    };

    enhanceLoginShell();
    const loginObserver = new MutationObserver(enhanceLoginShell);
    loginObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  // END login shell

  // BEGIN sign out
  // The account menu's "Sign out", and the whole-page one, end a claude.ai
  // session — which is not what holds this one. The deployment's auth service
  // holds it, so its cookie is what has to go; the browser then lands on the
  // sign-in page, where the proxy sends anyone without a session. Captured on
  // the document, so the menu's own handler never runs, exactly as the
  // Inference configuration item is handled above.
  //
  // The item is found two ways, because it is a menu row rather than a plain
  // button. The click is walked with `composedPath`, since the renderer uses
  // shadow DOM in places and `closest` cannot see past a retargeted event; and
  // the label is matched as a phrase rather than by equality, since the row may
  // carry a shortcut hint beside its copy ("Sign out ⌘Q"). Both of the bundle's
  // wordings are accepted, and its own test ids and class names are believed
  // over the label when they say "sign out".
  const signOutLabel = /\b(?:sign|log)\s?out\b/;
  const signOutHint = /sign-?out|log-?out/i;
  const identifiesSignOut = (node) => {
    const hint = `${node.getAttribute("data-testid") || ""} ${node.id || ""}`
      + ` ${typeof node.className === "string" ? node.className : ""}`;
    if (signOutHint.test(hint)) return true;
    const label = String(node.textContent || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    // Bounded, so a container that merely wraps the item is not mistaken for it.
    return label.length > 0 && label.length <= 24 && signOutLabel.test(label);
  };

  // The app renders its own Sign out only when its login-status seam reports a
  // login, which a managed 3P account lacks (`signOut` comes from the
  // bootstrap's `login`, written by the writable configuration). The renderer
  // patch (`account-sign-out-row`) forces that flag so the app draws its real
  // item — icon, hover and keyboard handling and all — on every deployment,
  // where before the preload cloned a neighbouring row and lost all three. So
  // there is nothing to add here: the row exists, and the interceptor below is
  // the only thing that answers it (React will not, being keyed to its own tree).
  const installSignOutInterceptor = () => {
    document.addEventListener("click", (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const nodes = (path.length ? path : [event.target])
        .filter((node) => node instanceof Element);
      const item = nodes.find((node) =>
        node.matches?.('[role="menuitem"], button, a, [data-testid]') && identifiesSignOut(node));
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      fetch("/api/auth/logout", { method: "POST", credentials: "include" })
        .catch(() => undefined)
        .then(() => globalThis.location.assign("/login"));
    }, true);
    console.info("[claudesk] Sign out ends the session at the auth service, not at claude.ai");
  };

  // Whether the deployment's auth service is behind this app, judged two ways:
  // the bridge says so when its identity seam is filled, and the session route
  // says so when it is not. The environment variable that fills that seam has
  // gone missing on a live deployment before, and a Sign out that quietly does
  // the app's own thing is the kind of failure nobody notices until the moment
  // they want to leave.
  if (config.authdSessions) {
    installSignOutInterceptor();
  } else {
    globalThis.fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        // authd's own envelope is `{"error": …}`; the bridge's carries `ok`.
        const isAuthd = body && typeof body === "object"
          && typeof body.error === "string" && !("ok" in body);
        if (response.ok || isAuthd) installSignOutInterceptor();
      })
      .catch(() => undefined);
  }
  // END sign out

  function createCodePreferences() {
    const listeners = new Set();
    let timer, previous;
    // The renderer keeps its draft permission pick in a per-opening in-memory
    // store; nothing writes it to AppPreferences. A new draft therefore came
    // back as "Accept edits" however the last session was started. The last
    // session's own start settings are the person's latest real pick, so seed
    // the global preference the draft hook already reads. An account-scoped
    // pick, when the renderer has written one, is an explicit choice and wins.
    let defaultsAt = 0;
    let defaults = null;
    async function codeDefaults() {
      if (!config.tenantCodeReads) return null;
      if (Date.now() - defaultsAt < 5000) return defaults;
      defaultsAt = Date.now();
      try {
        const response = await fetch("/api/remote/code-defaults", {
          cache: "no-store", credentials: "same-origin",
        });
        const payload = await response.json().catch(() => ({}));
        defaults = response.ok && payload.ok ? payload.value : null;
      } catch {
        defaults = null;
      }
      return defaults;
    }
    async function refresh() {
      let value = await invokeSettings("AppPreferences", "getPreferences", []);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const seed = (await codeDefaults())?.permission_mode;
        if (typeof seed === "string" && seed && seed !== "plan") {
          const bucket = value.epitaxyPrefs && typeof value.epitaxyPrefs === "object"
            && !Array.isArray(value.epitaxyPrefs) ? value.epitaxyPrefs : {};
          // An account-scoped pick is the renderer's own explicit choice and
          // wins (`Ib` reads it before the global key). The global key follows
          // the last session, so a pick made in this session is the default of
          // the next one without needing a renderer-side write.
          const accountPicked = Object.keys(bucket).some((key) =>
            key.startsWith("cc-landing-draft-permission-mode."));
          if (!accountPicked) {
            const seeded = { ...bucket, "cc-landing-draft-permission-mode": seed };
            if (JSON.stringify(seeded) !== JSON.stringify(bucket)) {
              value = { ...value, epitaxyPrefs: seeded };
            }
          }
        }
      }
      const next = JSON.stringify(value);
      if (next !== previous) {
        previous = next;
        for (const listener of listeners) listener(value);
      }
      return value;
    }
    return Object.freeze({
      getPreferences: refresh,
      async setPreference(key, value) {
        await invokeSettings("AppPreferences", "setPreference", [key, value]);
        await refresh();
      },
      onPreferencesChanged(listener) {
        listeners.add(listener);
        if (!timer) timer = setInterval(() => refresh().catch(() => {}), 1000);
        return () => {
          listeners.delete(listener);
          if (!listeners.size) { clearInterval(timer); timer = undefined; }
        };
      },
    });
  }

  function currentRemoteRoute() {
    const pathname = globalThis.location.pathname;
    const routeMatch = pathname.match(
      /^\/(task|chat|cowork|code|local_sessions)(?:\/([A-Za-z0-9_-]+))?(?:\/|$)/,
    );
    const route = routeMatch?.[1] || "";
    const mode = route === "code" || route === "local_sessions"
      ? "code"
      : route === "cowork"
        ? "cowork"
        : "chat";
    let sessionId = routeMatch?.[2] || null;
    if (!sessionId) {
      const search = new URLSearchParams(globalThis.location.search);
      sessionId = search.get("sessionId") || search.get("session_id") || null;
    }
    if (sessionId === "new") sessionId = null;
    return { mode, sessionId };
  }

  function eventStreamDescriptor() {
    const { mode, sessionId } = currentRemoteRoute();
    const params = new URLSearchParams({ mode });
    if (sessionId) params.set("sessionId", sessionId);
    // Identifies this browser to the bridge, so a push is only sent to
    // subscriptions whose page is not connected (and not double-shown).
    const clientId = remoteNotificationClientId();
    if (clientId) params.set("clientId", clientId);
    // The renderer release this page booted. The bridge reports it back on
    // /api/health, so "the page does not show the deployed patch" can be told
    // apart from "the server is not serving it" without console access.
    const release = config.release?.patchRelease;
    if (typeof release === "string" && release) params.set("release", release);
    return { key: params.toString(), url: `/api/events?${params.toString()}` };
  }

  function clearEventReconnect() {
    if (eventReconnectTimer !== null) clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }

  function scheduleEventReconnect(generation) {
    if (generation !== eventStreamGeneration || eventReconnectTimer !== null) return;
    const delay = eventReconnectDelayMs;
    eventReconnectDelayMs = Math.min(Math.round(eventReconnectDelayMs * 1.7), 10000);
    eventReconnectTimer = setTimeout(() => {
      eventReconnectTimer = null;
      if (generation === eventStreamGeneration) connectEvents(true);
    }, delay);
  }

  function connectEvents(force = false) {
    if (!("EventSource" in globalThis)) return;
    const descriptor = eventStreamDescriptor();
    if (
      !force
      && events
      && eventStreamKey === descriptor.key
      && events.readyState !== EventSource.CLOSED
    ) return;
    clearEventReconnect();
    eventStreamGeneration += 1;
    const generation = eventStreamGeneration;
    if (events) events.close();
    eventStreamKey = descriptor.key;
    events = new EventSource(descriptor.url);
    const stream = events;
    stream.addEventListener("open", () => {
      if (events !== stream || generation !== eventStreamGeneration) return;
      eventReconnectDelayMs = 1000;
    });
    stream.addEventListener("error", () => {
      if (
        events !== stream
        || generation !== eventStreamGeneration
        || stream.readyState !== EventSource.CLOSED
      ) return;
      scheduleEventReconnect(generation);
    });
    // A deploy replaces the prepared renderer generation behind a new release
    // path, but this page keeps executing the chunks it booted with: an SPA
    // never re-fetches its module graph, so a tab left open across a deploy
    // shows the previous UI indefinitely. The bridge now stamps every stream
    // `hello` with the release it serves; when it differs from the bootstrap's,
    // reload once. The session-storage guard is what keeps a browser that
    // somehow keeps getting the old document (an intermediary cache) from
    // reloading in a loop: one reload per served release, then a warning.
    events.addEventListener("hello", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const loaded = config.release?.patchRelease;
        const served = payload?.release?.patchRelease;
        if (typeof loaded !== "string" || typeof served !== "string" || loaded === served) return;
        const key = "claudesk-reloaded-for-release";
        try {
          if (globalThis.sessionStorage?.getItem(key) === served) return;
          globalThis.sessionStorage?.setItem(key, served);
        } catch {}
        console.info(`[claudesk] renderer release ${loaded} is stale; reloading for ${served}`);
        globalThis.location.reload();
      } catch {}
    });
    events.addEventListener("desktop-ipc", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.surface === "McpBridge" && payload.method === "mcpMessage") {
          deliverBridgeMcpMessage(payload.payload);
          return;
        }
        if (payload.payload?.sessionId) latestTranscriptEvents.delete(payload.payload.sessionId);
        dispatch(payload.surface, payload.method, payload.payload, payload.args);
      } catch {}
    });
    events.addEventListener("sessions", (event) => {
      try {
        JSON.parse(event.data);
        dispatch("LocalAgentModeSessions", "onOnEvent", {
          type: "initialized",
        });
      } catch {}
    });
    events.addEventListener("transcript", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (typeof payload.sessionId !== "string" || !payload.sessionId || payload.isRunning !== false) return;
        latestTranscriptEvents.set(payload.sessionId, payload);
        if (latestTranscriptEvents.size > 16) {
          latestTranscriptEvents.delete(latestTranscriptEvents.keys().next().value);
        }
        dispatch("LocalAgentModeSessions", "onOnEvent", {
          type: "transcript_loaded",
          sessionId: payload.sessionId,
          messages: Array.isArray(payload.value) ? payload.value : [],
        });
      } catch {}
    });
    events.addEventListener("notice", (event) => {
      try {
        showNotice(JSON.parse(event.data));
      } catch {}
    });
  }

  // An operator notice (the bridge's restart warning) rendered through the
  // Claude app's own toast, which the `toast-global` renderer patch publishes on
  // `globalThis.__CLAUDESK_TOAST__`. Sticky on purpose: the toast must outlive
  // the SSE drop that follows it and the reconnect after, so only the reader
  // closes it. A renderer that predates the patch has no such global — say so
  // once and drop the notice rather than throwing on the event stream.
  let noticeRenderWarned = false;
  let noticeShown = "";
  function showNotice(payload) {
    if (!payload || typeof payload !== "object") return;
    const title = typeof payload.title === "string" ? payload.title : "";
    const description = typeof payload.description === "string" ? payload.description : "";
    if (!title && !description) return;
    // The bridge replays a live notice to every page that (re)connects, and a
    // reconnect is exactly what follows the outage this is warning about — so
    // the same notice must not stack a second card each time. A reload starts a
    // new page and shows it again, which is the point.
    const key = `${title}\u0000${description}`;
    if (key === noticeShown) return;
    const toast = globalThis.__CLAUDESK_TOAST__;
    if (!toast || typeof toast.add !== "function") {
      if (!noticeRenderWarned) {
        noticeRenderWarned = true;
        console.warn("[claudesk] server notice received, but this renderer has no toast to show it in");
      }
      return;
    }
    noticeShown = key;
    toast.add({ title, description: description || undefined, timeout: 0 });
  }

  for (const method of ["pushState", "replaceState"]) {
    const original = globalThis.history?.[method]?.bind(globalThis.history);
    if (!original) continue;
    globalThis.history[method] = (...args) => {
      const result = original(...args);
      queueMicrotask(connectEvents);
      return result;
    };
  }
  globalThis.addEventListener("popstate", connectEvents);
  globalThis.addEventListener("hashchange", connectEvents);
  connectEvents();
  setInterval(() => {
    for (const key of storeCallbacks.keys()) {
      const separator = key.indexOf(".");
      const surface = key.slice(0, separator);
      const store = key.slice(separator + 1);
      refreshStore(surface, store).catch(() => {});
    }
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) connectEvents(true);
  });
  globalThis.addEventListener("pageshow", () => connectEvents(true));
  globalThis.addEventListener("online", () => connectEvents(true));

  // The entry document ships every static-composer element's class lists as
  // data attributes — `data-page-classes`, `data-layout-home-classes`,
  // `data-marlin-classes`, `data-classic-classes` — and whoever renders that
  // document is meant to copy the chosen one into `class`. claude.ai's server
  // does it before shipping the page; the Desktop package's copy carries the
  // data attributes and no `class` at all, and nothing in either bundle ever
  // reads them. So the skeleton that paints before hydration has no spacing
  // whatsoever — every wrapper computes padding 0 — and the greeting it keeps is
  // left where it lands, which is why the page does not sit where claude.ai's
  // does. Apply the deployment's own choices here, from the document's own
  // lists: the home layout first, then the marlin card, then the classic set,
  // then the default. Nothing is invented; only which of the shipped lists wins.
  const applyComposerClasses = () => {
    let elements;
    try {
      elements = document.querySelectorAll(
        "[data-page-classes],[data-layout-home-classes],"
        + "[data-marlin-classes],[data-classic-classes]",
      );
    } catch {
      return;
    }
    for (const element of elements) {
      const classes = element.getAttribute("data-layout-home-classes")
        || element.getAttribute("data-marlin-classes")
        || element.getAttribute("data-classic-classes")
        || element.getAttribute("data-page-classes");
      if (classes && element.className !== classes) element.className = classes;
    }
  };
  if (config.webShell) {
    // Before the app mounts if possible, and again the moment the tree exists:
    // this runs in <head> while the skeleton is still being parsed.
    applyComposerClasses();
    document.addEventListener("readystatechange", applyComposerClasses);
    document.addEventListener("DOMContentLoaded", applyComposerClasses, { once: true });
    globalThis.requestAnimationFrame?.(applyComposerClasses);
  }

  // BEGIN code start options (tenant)
  //
  // A tenant's self-hosted Code sessions take a folder, a branch and an
  // isolated worktree. The prepared renderer normally draws that strip itself
  // and sets `__CLAUDESK_STRIP_MOUNTED__` as it does; this block is the
  // fallback for a bundle that does not render it: it injects the same three
  // controls beside the environment pill, gets its answers from the guest
  // runner (the same `LocalSessions` names the bridge answers from the VM), and
  // merges the choices into the create request. It never touches the host.
  if (config.tenantCodeReads) {
    const codeOptionsKey = "claudesk.code-start-options";
    const codeOptions = {
      cwd: null, branch: "", worktree: false, branches: [], isGitRepo: false,
    };
    try {
      const stored = JSON.parse(globalThis.localStorage?.getItem(codeOptionsKey) || "{}");
      if (stored && typeof stored === "object") {
        if (typeof stored.cwd === "string") codeOptions.cwd = stored.cwd;
        if (typeof stored.branch === "string") codeOptions.branch = stored.branch;
        codeOptions.worktree = stored.worktree === true;
      }
    } catch { /* a storage that refuses reads is not fatal */ }
    const persistCodeOptions = () => {
      try {
        globalThis.localStorage?.setItem(codeOptionsKey, JSON.stringify({
          cwd: codeOptions.cwd, branch: codeOptions.branch, worktree: codeOptions.worktree,
        }));
      } catch { /* ignore */ }
    };
    const baseName = (path) => String(path || "").replace(/\/+$/, "").split("/").pop() || path;
    let container = null;
    let reinjectTimer = null;

    function renderCodeOptions() {
      if (!container) return;
      const folder = container.querySelector('[data-role="folder"]');
      const branch = container.querySelector('[data-role="branch"]');
      const worktree = container.querySelector('[data-role="worktree"] input');
      const label = container.querySelector('[data-role="worktree"]');
      if (folder) {
        folder.textContent = codeOptions.cwd
          ? `\u{1F4C1} ${baseName(codeOptions.cwd)}` : "\u{1F4C1} Select folder…";
        folder.title = codeOptions.cwd || "Choose the folder this session starts in";
      }
      if (branch) {
        branch.replaceChildren();
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = codeOptions.cwd
          ? (codeOptions.isGitRepo ? "branch…" : "not a git repo")
          : "branch…";
        branch.append(empty);
        for (const name of codeOptions.branches) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          branch.append(option);
        }
        branch.value = codeOptions.branch || "";
        branch.disabled = !codeOptions.isGitRepo || codeOptions.branches.length === 0;
      }
      if (worktree) {
        worktree.checked = codeOptions.worktree && codeOptions.isGitRepo;
        worktree.disabled = !codeOptions.isGitRepo;
      }
      if (label) {
        label.style.opacity = codeOptions.isGitRepo ? "1" : "0.55";
      }
    }

    async function refreshCodeGit() {
      codeOptions.branches = [];
      codeOptions.isGitRepo = false;
      if (codeOptions.cwd) {
        try {
          const info = await invoke("LocalSessions", "getGitInfo", [codeOptions.cwd]);
          codeOptions.isGitRepo = Boolean(info);
          if (info) {
            const list = await invoke("LocalSessions", "getLocalBranches", [codeOptions.cwd]);
            codeOptions.branches = Array.isArray(list) ? list : [];
            if (!codeOptions.branch || !codeOptions.branches.includes(codeOptions.branch)) {
              codeOptions.branch = info.branch || info.defaultBranch
                || codeOptions.branches[0] || "";
            }
          } else {
            codeOptions.branch = "";
            codeOptions.worktree = false;
          }
        } catch {
          // No guest runner online yet: the controls stay present but disabled.
        }
      } else {
        codeOptions.branch = "";
        codeOptions.worktree = false;
      }
      persistCodeOptions();
      renderCodeOptions();
    }

    function buildCodeOptions(pillClass) {
      container = document.createElement("span");
      container.setAttribute("data-claudesk-code-options", "");
      container.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-width:0;";
      const folder = document.createElement("button");
      folder.type = "button";
      folder.dataset.role = "folder";
      folder.className = pillClass;
      folder.addEventListener("click", async () => {
        const picked = await globalThis.__CLAUDE_PICK_SERVER_FOLDERS__?.({
          title: "Choose a folder", source: "code", allowCreate: true,
        });
        const path = picked?.[0];
        if (!path) return;
        codeOptions.cwd = path;
        codeOptions.branch = "";
        codeOptions.worktree = false;
        persistCodeOptions();
        await refreshCodeGit();
      });
      const branch = document.createElement("select");
      branch.dataset.role = "branch";
      branch.setAttribute("aria-label", "Session branch");
      branch.style.cssText = "height:var(--pill-h,24px);max-width:180px;border-radius:8px;"
        + "background:var(--cds-surface-2,#2b2b2b);color:var(--cds-text-primary,#eee);"
        + "border:1px solid var(--cds-border-300,#444);font:inherit;font-size:12px;padding:0 6px;";
      branch.addEventListener("change", () => {
        codeOptions.branch = branch.value;
        persistCodeOptions();
      });
      const worktree = document.createElement("label");
      worktree.dataset.role = "worktree";
      worktree.className = pillClass;
      worktree.style.cursor = "pointer";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.style.margin = "0";
      toggle.addEventListener("change", () => {
        codeOptions.worktree = toggle.checked;
        persistCodeOptions();
      });
      worktree.append(toggle, document.createTextNode(" worktree"));
      container.append(folder, branch, worktree);
    }

    function ensureCodeOptions() {
      if (globalThis.__CLAUDESK_STRIP_MOUNTED__ === true) {
        container?.remove();
        container = null;
        return;
      }
      const anchor = document.querySelector(
        '[data-testid="epitaxy-env-pill"],[data-testid="environment-bar-trigger"],'
        + '[data-testid="draft-rail-place"]',
      );
      const row = anchor?.parentElement;
      if (!row) return;
      if (!container) buildCodeOptions(anchor.className);
      if (!container.isConnected) row.append(container);
      renderCodeOptions();
    }

    const scheduleCodeOptions = () => {
      clearTimeout(reinjectTimer);
      reinjectTimer = setTimeout(ensureCodeOptions, 60);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ensureCodeOptions, { once: true });
    } else {
      ensureCodeOptions();
    }
    globalThis.requestAnimationFrame?.(ensureCodeOptions);
    setTimeout(ensureCodeOptions, 1200);
    new MutationObserver(scheduleCodeOptions).observe(document.documentElement, {
      childList: true, subtree: true,
    });

    // The choices reach the session through its create request; the draft's
    // own start intent has no folder for a self-hosted place.
    const originalFetch = globalThis.fetch;
    const patchCreateBody = (text) => {
      try {
        const data = JSON.parse(text);
        if (!data || typeof data !== "object") return null;
        if (typeof data.self_hosted_runner_pool_id !== "string"
          && typeof data.environment_id !== "string") return null;
        const target = data.config && typeof data.config === "object" ? data.config : {};
        if (codeOptions.cwd && !target.cwd) target.cwd = codeOptions.cwd;
        if (codeOptions.branch && !target.source_branch) {
          target.source_branch = codeOptions.branch;
        }
        if (codeOptions.worktree === true) target.use_worktree = true;
        data.config = target;
        return JSON.stringify(data);
      } catch {
        return null;
      }
    };
    if (typeof originalFetch === "function" && !globalThis.__CLAUDESK_CODE_CREATE__) {
      globalThis.__CLAUDESK_CODE_CREATE__ = true;
      globalThis.fetch = function (input, init) {
        try {
          const isRequest = typeof Request !== "undefined" && input instanceof Request;
          const url = new URL(isRequest ? input.url : String(input), globalThis.location.href);
          const method = String((isRequest ? input.method : init?.method) || "GET").toUpperCase();
          if (method === "POST" && url.pathname === "/v1/code/sessions"
            && (codeOptions.cwd || codeOptions.branch || codeOptions.worktree)) {
            if (isRequest) {
              return input.clone().text().then((text) => {
                const patched = patchCreateBody(text);
                if (patched === null) return originalFetch.call(this, input, init);
                return originalFetch.call(this, new Request(input, { body: patched }));
              });
            }
            if (typeof init?.body === "string") {
              const patched = patchCreateBody(init.body);
              if (patched !== null) init = { ...init, body: patched };
            }
          }
        } catch { /* not a create; pass it through */ }
        return originalFetch.call(this, input, init);
      };
    }
    refreshCodeGit();
  }
  // END code start options (tenant)
})();
