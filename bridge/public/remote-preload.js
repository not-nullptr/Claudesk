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

  const mobileClient = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || globalThis.navigator.userAgentData?.mobile === true
    || (
      /Macintosh/i.test(navigator.userAgent)
      && globalThis.navigator.maxTouchPoints > 1
    );
  if (mobileClient) document.documentElement.classList.add("claude-remote-mobile");
  if (config.codeActionsEnabled) document.documentElement.classList.add("claude-remote-code-enabled");

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

  function dispatch(surface, method, payload) {
    for (const callback of listenerCallbacks.get(listenerKey(surface, method)) || []) {
      try {
        callback(payload);
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

  function chooseBrowserFiles({ directory = false, multiple = true } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = multiple;
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
      if (method === "browseFolder") {
        return async (title, _allowCreate, _trust, initialPath) => {
          const paths = await globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({ title, initialPath });
          return paths?.[0] ?? null;
        };
      }
      if (method === "browseFolders") {
        return async (title, _allowCreate, _trust, initialPath) =>
          globalThis.__CLAUDE_PICK_SERVER_FOLDERS__({ title, multiple: true, initialPath });
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

  if (config.gatewaySettingsEnabled) {
    const settingsRoot = Object.create(null);
    for (const [surface, methods] of Object.entries(config.settingsMethods || {})) {
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
      if (surface === "AppPreferences") {
        if (!config.codeActionsEnabled) continue;
        settingsRoot[surface] = createCodePreferences();
      } else settingsRoot[surface] = Object.freeze(api);
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

  function createCodePreferences() {
    const listeners = new Set();
    let timer, previous;
    async function refresh() {
      const value = await invokeSettings("AppPreferences", "getPreferences", []);
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
    events.addEventListener("desktop-ipc", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.payload?.sessionId) latestTranscriptEvents.delete(payload.payload.sessionId);
        dispatch(payload.surface, payload.method, payload.payload);
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
})();
