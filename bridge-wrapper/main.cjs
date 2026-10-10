"use strict";

const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");
const { createReadStream, readFileSync, writeSync } = require("node:fs");
const { createConnection } = require("node:net");
const { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } = require("node:fs/promises");
const { basename, dirname, extname, join, normalize, resolve } = require("node:path");
const { app, BrowserWindow, ipcMain, Menu, webContents } = require("electron");

// The official Desktop computes each notification's final title and body inside
// its own (minified) notification service, so the relay below cannot re-derive
// them from the service call arguments. Observe the native notification
// instead: `show()` runs synchronously inside the official show methods and the
// instance carries the exact strings that were about to be displayed. The
// observation must not change display behavior, so every failure path here is
// swallowed. See "Desktop notifications → browser relay" below.
if (typeof require("electron").Notification?.prototype?.show === "function") {
  const originalNotificationShow = require("electron").Notification.prototype.show;
  require("electron").Notification.prototype.show = function relayObservedNotificationShow(...args) {
    try {
      recordNativeNotificationDisplay(this);
    } catch {}
    return originalNotificationShow.apply(this, args);
  };
}

const HOST = "127.0.0.1";
const PORT = Number(process.env.COWORK_BRIDGE_INTERNAL_PORT || 9222);
const ION_ROOT = resolve("/usr/lib/claude-desktop/resources/ion-dist");
const RENDERER_STATE_ROOT = resolve("/var/lib/claude-cowork-bridge/renderer");
const rendererManifest = JSON.parse(
  readFileSync(resolve(RENDERER_STATE_ROOT, "current.json"), "utf8"),
);
if (
  rendererManifest.desktopVersion !== process.env.CLAUDE_DESKTOP_VERSION
  || !/^\/renderer\/\d+\.\d+\.\d+\/\d{8}-\d+$/.test(rendererManifest.basePath)
) {
  throw new Error("prepared renderer manifest does not match the fixed Desktop version");
}
const DESKTOP_ICON = "/usr/lib/claude-desktop/resources/icon.png";
const gatewaySettingsEnabled = process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1";
const developerActionsEnabled = process.env.CLAUDE_REMOTE_DEVELOPER_ACTIONS === "1";
const infrastructureActionsEnabled =
  process.env.CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS === "1";
const codeActionsEnabled = process.env.CLAUDE_REMOTE_CODE_ACTIONS === "1";
const coworkHostBashEnabled = process.env.CLAUDE_COWORK_HOST_BASH === "1";
const rendererReadyTimeoutMs = 15 * 1000;
const rendererReadyPollMs = 250;

// The official app uses app.relaunch() for login/account transitions. In the
// container the app process is already supervised, so Electron's detached
// replacement races the supervisor restart and leaves two Desktop instances
// sharing one persistent profile. Let the supervisor perform the restart after
// the official app exits instead.
app.relaunch = () => {
  console.info("[cowork-wrapper] delegated app relaunch to container supervisor");
};

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const coworkVmMemoryGB = boundedInteger(
  process.env.CLAUDE_COWORK_VM_MEMORY_GB,
  2,
  1,
  16,
);
const coworkVmIdleMinutes = boundedInteger(
  process.env.CLAUDE_COWORK_VM_IDLE_MINUTES,
  30,
  1,
  24 * 60,
);
const coworkVmScheduleGuardMinutes = boundedInteger(
  process.env.CLAUDE_COWORK_VM_SCHEDULE_GUARD_MINUTES,
  10,
  1,
  24 * 60,
);
const coworkVmIdlePollMs = 60 * 1000;
let coworkVmLastActivityAt = Date.now();

function noteCoworkVmActivity() {
  coworkVmLastActivityAt = Date.now();
}

// The official Web renderer supplies its feature-flag default (currently
// memoryGB=4) to startVM, and that explicit argument takes precedence over the
// persisted Desktop preference. Clamp both configuration IPCs at the main
// process boundary so every caller, including WebUI auto-start, gets the
// operator-selected limit.
const originalIpcMainHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (typeof channel !== "string" || typeof listener !== "function") {
    return originalIpcMainHandle(channel, listener);
  }
  if (channel.endsWith("_$_ClaudeVM_$_startVM")) {
    if (coworkHostBashEnabled) {
      return originalIpcMainHandle(channel, async () => undefined);
    }
    return originalIpcMainHandle(channel, (event, config) => {
      noteCoworkVmActivity();
      const safeConfig = config && typeof config === "object" && !Array.isArray(config)
        ? config
        : {};
      return listener(event, { ...safeConfig, memoryGB: coworkVmMemoryGB });
    });
  }
  if (coworkHostBashEnabled && channel.endsWith("_$_ClaudeVM_$_getRunningStatus")) {
    return originalIpcMainHandle(channel, async () => "ready");
  }
  if (channel.endsWith("_$_ClaudeVM_$_setYukonSilverConfig")) {
    return originalIpcMainHandle(channel, (event, config) => {
      const safeConfig = config && typeof config === "object" && !Array.isArray(config)
        ? config
        : {};
      return listener(event, { ...safeConfig, memoryGB: coworkVmMemoryGB });
    });
  }
  if (/\_\$_LocalAgentModeSessions_\$_(?:start|sendMessage)$/.test(channel)) {
    return originalIpcMainHandle(channel, (...args) => {
      noteCoworkVmActivity();
      return listener(...args);
    });
  }
  return originalIpcMainHandle(channel, listener);
};

const ionMimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

const allowedMethods = new Map([
  ["Account", new Set(["setAccountDetails"])],
  ["WebBuild", new Set(["reportCommitHash"])],
  ["ClaudeVM", new Set([
    "checkVirtualMachinePlatform",
    "download",
    "getDownloadStatus",
    "getRunningStatus",
    "isHostLoopDevOverrideActive",
    "isHostLoopModeEnabled",
    "startVM",
  ])],
  ["LocalAgentModeSessions", new Set([
    "archive",
    "delete",
    "getAll",
    "getDefaultWorkspaceFolders",
    "getSession",
    "getSupportedCommands",
    "getTranscript",
    "searchSessions",
    "respondToToolPermission",
    "rewind",
    "sendMessage",
    "setFocusedSession",
    "setEffort",
    "setExtendedThinking",
    "setModel",
    "setPermissionMode",
    "start",
    "stop",
    "updateSession",
  ])],
  ["CoworkArtifacts", new Set([
    "getAllArtifacts",
    "getArtifactIndexHtmlPath",
    "getArtifactMetadata",
    "getArtifactThumbnail",
    "hideArtifact",
    "importArtifact",
    "isAutoPublishEnabled",
    "isSharingEnabled",
    "parkAndCaptureArtifact",
    "printArtifactToPdf",
    "refreshImportedArtifact",
    "reloadArtifactView",
    "setArtifactAutoPublish",
    "setArtifactLastModifiedSession",
    "setArtifactMcpTools",
    "setArtifactStarred",
    "shareArtifact",
    "showArtifact",
    "unshareArtifact",
  ])],
  ["CoworkFilePreview", new Set([
    "isEnabled",
    "isEpitaxyPreviewEnabled",
    "isOpenInDefaultAppEnabled",
    "isVmReady",
    "hide",
    "parkAndCapture",
    "show",
  ])],
  ["CoworkMemory", new Set([
    "listAccountMemories",
    "readAccountMemory",
    "readGlobalMemory",
  ])],
  ["CoworkScheduledTasks", new Set([
    "getAllScheduledTasks",
    "getScheduledTaskFileContent",
    "getWatcherHistory",
  ])],
  ["CoworkSpaces", new Set([
    "classifySessions",
    "getAllSpaces",
    "getAutoMemoryDir",
    "getRemoteSessionSpaces",
    "getSpace",
    "listFolderContents",
    "openFile",
    "readFileContents",
    "readSpaceMemoryIndex",
    "summarizeSpace",
  ])],
  ["CoworkUserFiles", new Set(["getInfo"])],
  ["DocumentFunnel", new Set([
    "ensureScratchRoot",
    "injectDocumentContext",
    "ingestSessionDocument",
    "listScratchWorkingFiles",
    "openDownloadExport",
    "revealDownloadExport",
    "runClarkdownConvert",
    "runClarkdownDownloadExport",
    "writeScratchFile",
  ])],
  ["FileSystem", new Set([
    "appInfoForExtension",
    "browseFiles",
    "browseFolder",
    "browseFolders",
    "getLocalFileThumbnail",
    "getSystemPath",
    "listDirectory",
    "listFilesInFolder",
    "openLocalFile",
    "readLocalFile",
    "showInFolder",
    "whichApplication",
    "writeFileDownload",
    "writeFileDownloadAndOpen",
  ])],
  ["OpenDocuments", new Set(["getOpenDocuments", "readOpenDocumentAsBase64"])],
]);

if (infrastructureActionsEnabled) {
  allowedMethods.get("CoworkArtifacts").add("deleteArtifact");
  for (const method of ["deleteAccountMemory", "writeAccountMemory", "writeGlobalMemory"]) {
    allowedMethods.get("CoworkMemory").add(method);
  }
  for (const method of [
    "createScheduledTask",
    "markListenerReady",
    "updateScheduledTask",
    "updateScheduledTaskFileContent",
    "updateScheduledTaskStatus",
  ]) allowedMethods.get("CoworkScheduledTasks").add(method);
  for (const method of [
    "addFolderToSpace",
    "addLinkToSpace",
    "addProjectToSpace",
    "appendRemoteSessionSpaceFolders",
    "copyFilesToSpaceFolder",
    "createSpace",
    "createSpaceFolder",
    "deleteSpace",
    "removeFolderFromSpace",
    "removeLinkFromSpace",
    "removeProjectFromSpace",
    "removeRemoteSessionSpace",
    "setAutoDescription",
    "setRemoteSessionSpace",
    "updateSpace",
  ]) allowedMethods.get("CoworkSpaces").add(method);
  for (const method of ["migrate", "pickTarget", "reveal"]) {
    allowedMethods.get("CoworkUserFiles").add(method);
  }
  for (const method of [
    "exportLocalFileToGoogleDrive",
    "promoteScratchpadFile",
    "savePastedFile",
    "writeLocalFile",
  ]) allowedMethods.get("FileSystem").add(method);
}

if (developerActionsEnabled) {
  for (const method of [
    "authorizeDirectMcpServer",
    "deleteLocalSkill",
    "directMcpCallTool",
    "directMcpListResources",
    "directMcpReadResource",
    "disconnectDirectMcpServer",
    "getDirectMcpServerStatuses",
    "getLocalMcpServers",
    "getLocalSkillFiles",
    "listLocalSkills",
    "mcpAuthenticate",
    "mcpReconnect",
    "mcpSubmitOAuthCallbackUrl",
    "replaceEnabledMcpTools",
    "replaceRemoteMcpServers",
    "saveLocalSkill",
    "setLocalSkillEnabled",
    "setMcpServers",
    "syncSkills",
  ]) {
    allowedMethods.get("LocalAgentModeSessions").add(method);
  }
  allowedMethods.set("CustomPlugins", new Set([
    "addMarketplace",
    "checkPluginHasLocalChanges",
    "getAndClearMigrationIssues",
    "getCachedCommands",
    "getInstallCounts",
    "installLocalOrgPlugin",
    "installPlugin",
    "listAvailablePlugins",
    "listInstalledPlugins",
    "listLocalOrgPlugins",
    "listMarketplaces",
    "listRemotePluginsPage",
    "refreshMarketplace",
    "removeMarketplace",
    "syncLocalOrgPlugins",
    "uninstallPlugin",
    "updatePlugin",
  ]));
  allowedMethods.set("LocalPlugins", new Set([
    "deletePlugin",
    "getDownloadedRemotePlugins",
    "getPluginCliBatch",
    "getPluginCliStatus",
    "getPluginShimOps",
    "getPlugins",
    "listSkillFiles",
    "revokePluginOAuth",
    "setPluginEnabled",
    "setPluginEnvVars",
    "setPluginOAuthClient",
    "setPluginShimPermission",
    "startPluginOAuthFlow",
    "syncRemotePlugins",
    "uploadPlugin",
  ]));
  allowedMethods.set("PluginBridgeMcp", new Set(["listServers"]));
}

if (codeActionsEnabled) {
  allowedMethods.set("LocalSessions", new Set([
    "addDirectories",
    "applyFlagSettings",
    "archive",
    "cancelQueuedMessage",
    "changeCwd",
    "checkStoredTrust",
    "checkTrust",
    "cleanupAutoModeProposalFile",
    "clearSession",
    "createAgent",
    "delete",
    "discardPendingTurn",
    "findLocalSessionIdForBridgeId",
    "forkSession",
    "getAgents",
    "getAll",
    "getBusyShellPtyKeys",
    "getCodeStats",
    "getCommitDiff",
    "getContextUsage",
    "getDefaultEffort",
    "getDefaultPermissionMode",
    "getDetectedProjects",
    "getDiffFileContent",
    "getEffort",
    "getGitCommits",
    "getGitDiff",
    "getGitDiffFilePatch",
    "getGitDiffStats",
    "getGitInfo",
    "getInstalledEditors",
    "getLocalBranches",
    "getLocalMcpServers",
    "getPermissionMode",
    "getPlanForSession",
    "getSession",
    "getSessionMediaStreamUrl",
    "getSessionPanelMediaStreamUrl",
    "getSessionsForScheduledTask",
    "getShellPtyBuffer",
    "getSupportedCommands",
    "getTranscript",
    "getTranscriptTail",
    "getUncommittedChanges",
    "interrupt",
    "isVSCodeInstalled",
    "listSessionDirectory",
    "logCliEvent",
    "mcpAuthenticate",
    "mcpCallTool",
    "mcpListResources",
    "mcpReadResource",
    "mcpReconnect",
    "mcpSubmitOAuthCallbackUrl",
    "openInEditor",
    "openInVSCode",
    "openSessionFileInDefaultApp",
    "pickFileAtCwd",
    "pickSessionFile",
    "prewarmAuth",
    "promoteQueuedMessage",
    "readFileAtCwd",
    "readSessionFile",
    "readSessionFileWithStatus",
    "readSessionImageAsDataUrl",
    "readSessionMediaAsDataUrl",
    "readSessionPanelMediaAsDataUrl",
    "reorderQueuedMessage",
    "replaceEnabledMcpTools",
    "replaceRemoteMcpServers",
    "reportComposerInp",
    "reportStreamRender",
    "reportSwitchTiming",
    "resolveSessionFile",
    "respondToRefusalFallbackPrompt",
    "respondToToolPermission",
    "resizePty",
    "resizeShellPty",
    "resumePreClearSession",
    "rewind",
    "rewindV2",
    "runBashCommand",
    "saveTrust",
    "searchSessions",
    "sendMessage",
    "sendSideChatMessage",
    "setAccountBranchPrefix",
    "setAvailableCodeModels",
    "setEffort",
    "setFastMode",
    "setFocusedSession",
    "setMcpServers",
    "setModel",
    "setPermissionMode",
    "showSessionFileInFolder",
    "showSessionFilePreview",
    "start",
    "startPty",
    "startShellPty",
    "startSideChat",
    "stop",
    "stopPty",
    "stopSessionSummary",
    "stopShellPty",
    "stopSideChat",
    "stopTask",
    "submitFeedback",
    "summarizeSession",
    "summarizeTranscript",
    "unarchive",
    "updateSession",
    "warmSession",
    "writeAutoModeProposalFile",
    "writePty",
    "writeSessionFile",
    "writeShellPty",
  ]));
  allowedMethods.set("LocalSessionEnvironment", new Set(["get", "save"]));
}

const allowedSettingsMethods = gatewaySettingsEnabled
  ? new Map([
      ["AppPreferences", new Set(["getPreferences", "setPreference"])],
      ["Custom3pSetup", new Set([
        "createConfig",
        "deleteConfig",
        "duplicateConfig",
        "exportConfig",
        "getConfigHealth",
        "getLoginDesktop3pStatus",
        "authorizeAndProbeMcpServer",
        "forgetMcpOAuth",
        "listConfigs",
        "probeEgressHosts",
        "probeMcpServer",
        "readConfig",
        "recheckConfigHealth",
        "relaunchApp",
        "renameConfig",
        "revealConfig",
        "scanOrgPlugins",
        "setAppliedConfig",
        "triggerBootstrapAuth",
        "writeConfig",
      ])],
      ["Custom3pHelperRun", new Set([
        "discoverModels",
        "probeInference",
        "runCredentialHelper",
      ])],
    ])
  : new Map();

const allowedSurfaces = new Set(allowedMethods.keys());

const allowedStores = new Map([
  ["LocalAgentModeSessions", new Set([
    "interactiveAuthStore",
    "sessionsBridgeStatusStore",
  ])],
  ["ManagedConfig", new Set(["managedRendererConfigStore"])],
  ["ClaudeVM", new Set(["apiReachabilityStore"])],
]);

const relayedListeners = new Map([
  ["ClaudeVM", new Set([
    "onDownloadProgress",
    "onDownloadStatusChanged",
    "onRunningStatusChanged",
    "onStartupError",
  ])],
  ["LocalAgentModeSessions", new Set([
    "onOnBridgePermissionPreflight",
    "onOnCoworkFromMain",
    "onOnEvent",
    "onOnManagedAskToolNamesChanged",
    "onOnToolPermissionRequest",
  ])],
  ["CoworkArtifacts", new Set(["onOnArtifactsChanged"])],
  ["CoworkScheduledTasks", new Set(["onOnScheduledTaskEvent"])],
  ["CoworkSpaces", new Set(["onOnSpaceEvent"])],
  ["DocumentFunnel", new Set(["onWorkingDocumentsChanged"])],
  // Not a `claude.web` surface: the wrapper itself publishes the notifications
  // the official Desktop decides to show, for the remote preload to render in
  // the browser (see the notification relay section below).
  ["DesktopNotifications", new Set(["onNotification", "onNotificationClosed"])],
]);

// Renderer events must be pushed into the main process as they happen. Pulling
// this queue with executeJavaScript() made event delivery contend with normal
// Desktop IPC and could delay completed assistant messages for tens of seconds.
const relayConsoleToken = randomBytes(24).toString("base64url");
const relayConsolePrefix = `__CLAUDE_REMOTE_EVENT_V2__:${relayConsoleToken}:`;
const relayedEventQueue = [];
const relayConsoleContents = new Set();
const registeredRelayContentsIds = new Set();
const relayedEventCopies = new Map();
let relayedEventCopiesBytes = 0;

function relayEventKey(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}

function writeRelayTrace(line) {
  // The official application can replace console methods with its file logger.
  // Write directly to stderr so diagnostics reach the container supervisor.
  try { writeSync(2, "[claudesk-relay] " + line + "\n"); } catch {}
}

if (process.env.CLAUDE_RELAY_TRACE === "1") {
  writeRelayTrace(JSON.stringify({ type: "trace_enabled", version: 2 }));
}

function traceRelayedEvent(value, sourceId, decision, key) {
  if (process.env.CLAUDE_RELAY_TRACE !== "1") return;
  const payload = value.payload || {};
  const message = payload.message || {};
  const frame = message.event || {};
  writeRelayTrace(JSON.stringify({
    sourceId, decision, surface: value.surface, method: value.method,
    sessionId: payload.sessionId, type: payload.type, messageType: message.type,
    messageId: message.message?.id || frame.message?.id,
    messageUuid: message.uuid, eventType: frame.type, index: frame.index,
    blockType: frame.content_block?.type, toolId: frame.content_block?.id,
    toolName: frame.content_block?.name, deltaType: frame.delta?.type,
    tools: Array.isArray(message.message?.content)
      ? message.message.content.filter(block => block.type === "tool_use")
        .map(block => ({ id: block.id, name: block.name })) : undefined,
    fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16),
  }));
}

function enqueueRelayedEvent(value, sourceId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (!relayedListeners.get(value.surface)?.has(value.method)) return;
  const key = relayEventKey(value);
  // Some IPC events are broadcast, others reach only one app view. Listen in
  // all views, but forward each cross-view copy only once. Per-view occurrence
  // counts preserve legitimate identical deltas (including repeated words).
  if (sourceId !== undefined) {
    if (key.length <= 32768) {
      const now = Date.now();
      let copies = relayedEventCopies.get(key);
      if (!copies || now - copies.seenAt > 2500) {
        if (!copies) relayedEventCopiesBytes += key.length * 2;
        copies = { seenAt: now, counts: new Map(), emitted: 0 };
        relayedEventCopies.set(key, copies);
      }
      const count = (copies.counts.get(sourceId) || 0) + 1;
      copies.counts.set(sourceId, count);
      if (count <= copies.emitted) {
        traceRelayedEvent(value, sourceId, "duplicate", key);
        return;
      }
      copies.emitted = count;
      while (relayedEventCopies.size > 2000 || relayedEventCopiesBytes > 8 * 1024 * 1024) {
        const oldest = relayedEventCopies.keys().next().value;
        relayedEventCopiesBytes -= oldest.length * 2;
        relayedEventCopies.delete(oldest);
      }
    }
  }
  traceRelayedEvent(value, sourceId, "forwarded", key);
  relayedEventQueue.push(value);
  if (relayedEventQueue.length > 2000) {
    relayedEventQueue.splice(0, relayedEventQueue.length - 2000);
  }
}

function attachRelayConsole(contents) {
  if (!contents || contents.isDestroyed() || relayConsoleContents.has(contents.id)) return;
  relayConsoleContents.add(contents.id);
  contents.on("console-message", (_event, ...args) => {
    const details = args.find((item) => item && typeof item === "object" &&
      typeof item.message === "string");
    const message = details?.message || args.find((item) => typeof item === "string");
    if (typeof message !== "string" || !message.startsWith(relayConsolePrefix)) return;
    const serialized = message.slice(relayConsolePrefix.length);
    if (!serialized || serialized.length > 16 * 1024 * 1024) return;
    try {
      enqueueRelayedEvent(JSON.parse(serialized), contents.id);
    } catch {}
  });
  contents.on("did-finish-load", () => {
    registeredRelayContentsIds.delete(contents.id);
  });
  contents.once("destroyed", () => {
    relayConsoleContents.delete(contents.id);
    registeredRelayContentsIds.delete(contents.id);
  });
}

// ---------------------------------------------------------------------------
// Desktop notifications → browser relay
//
// Every notification the official Desktop decides to show — a finished turn,
// "Claude needs your input", a tool permission or AskUserQuestion card, and the
// renderer-driven ones behind `claude.web.DesktopNotifications` — ends in a
// native Electron Notification created by the main process. This container has
// no desktop notification daemon (and nobody at its Xvfb display), so those
// notifications are never displayed anywhere; the browser is the only surface a
// user has. Relay each one the official code actually shows over the existing
// event queue, keeping the official title/body/tag and, on a click, running the
// same official click handler so the session is opened and bookkeeping cleared.
// The remote preload renders the relayed records as real browser notifications
// (and pushes them when no tab is open); see bridge/public/remote-preload.js.
//
// The service is found by shape (like findOfficialBootFeatures) because its
// chunk name and export aliases change with every Desktop build. The final
// display strings are not re-derived: the official code computes them inside
// its own methods, so instead the native Notification.prototype.show is
// observed and the record it carries is matched back to the in-flight call.
// A capture is settled when the official method returns (or its promise
// resolves): no display record by then means the official side suppressed the
// notification (level off, unsupported platform, ...) and nothing is relayed.
// ---------------------------------------------------------------------------

const notificationRelay = {
  service: null,
  registry: null,
  pending: [],
  recent: new Map(),
  pushQueue: [],
  navigationSink: null,
  shown: 0,
  clicks: 0,
  discovery: "pending",
};
const lastNotificationClickAt = new Map();

function boundedNotificationText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function notificationRoute(service, product, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  try {
    const route = service?.getPermissionSessionRoute?.(product, sessionId);
    if (typeof route === "string" && route.startsWith("/")) return route;
  } catch {}
  return product === "ccd"
    ? `/epitaxy/${encodeURIComponent(sessionId)}`
    : `/cowork/${encodeURIComponent(sessionId)}`;
}

function finishNotificationCapture(capture, display) {
  if (capture.finalized) return;
  capture.finalized = true;
  const index = notificationRelay.pending.indexOf(capture);
  if (index >= 0) notificationRelay.pending.splice(index, 1);
  const service = notificationRelay.service;
  const payload = {
    id: capture.tag,
    tag: capture.tag,
    title: display.title || capture.fallbackTitle || "Claude",
    body: display.body || capture.fallbackBody || "",
    kind: capture.kind,
    product: capture.product || null,
    sessionId: capture.sessionId || null,
    requestId: capture.requestId || null,
    allowOnce: capture.allowOnce === true,
    route: notificationRoute(service, capture.product, capture.sessionId),
    at: Date.now(),
  };
  notificationRelay.shown += 1;
  notificationRelay.recent.set(capture.tag, capture);
  while (notificationRelay.recent.size > 64) {
    notificationRelay.recent.delete(notificationRelay.recent.keys().next().value);
  }
  enqueueRelayedEvent({
    surface: "DesktopNotifications",
    method: "onNotification",
    payload,
  });
  notificationRelay.pushQueue.push(payload);
  if (notificationRelay.pushQueue.length > 200) {
    notificationRelay.pushQueue.splice(0, notificationRelay.pushQueue.length - 200);
  }
}

function settleNotificationCapture(capture) {
  // The official call finished. The three synchronous producers show their
  // Notification before returning; the permission path awaits a git lookup
  // first, and its promise is settled here. Either way, a capture that never
  // saw a display record was suppressed and must not be relayed.
  if (!capture.finalized) {
    capture.suppressed = true;
    const index = notificationRelay.pending.indexOf(capture);
    if (index >= 0) notificationRelay.pending.splice(index, 1);
  }
}

function beginNotificationCapture(capture) {
  notificationRelay.pending.push(capture);
  return capture;
}

function recordNativeNotificationDisplay(notification) {
  let title;
  let body;
  try {
    title = boundedNotificationText(notification?.title, 500);
    body = boundedNotificationText(notification?.body, 1000);
  } catch {
    return;
  }
  if (!title && !body) return;
  const display = { title, body };
  const pending = notificationRelay.pending;
  // Prefer the newest capture whose permission-card description appears in the
  // body: the permission path resolves asynchronously, so several notifications
  // can be in flight and the newest capture is not necessarily this one.
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const capture = pending[index];
    if (capture.description && body.includes(capture.description)) {
      finishNotificationCapture(capture, display);
      return;
    }
  }
  // Synchronous producers hit this path while their capture is the newest.
  const newest = pending.at(-1);
  if (newest) {
    finishNotificationCapture(newest, display);
    return;
  }
  // A notification nobody captured (some other main-process call site). Relay
  // it generically rather than dropping it.
  finishNotificationCapture({
    tag: `electron-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    kind: "generic",
    product: null,
    sessionId: null,
    requestId: null,
    allowOnce: false,
  }, display);
}

function relayNotificationClosed(tag) {
  if (typeof tag !== "string" || !tag) return;
  // The capture stays clickable: a browser click can already be in flight when
  // a close (e.g. the session was opened) arrives, and it should still run the
  // official handler exactly once. The map is capacity-bounded.
  enqueueRelayedEvent({
    surface: "DesktopNotifications",
    method: "onNotificationClosed",
    payload: { tag, at: Date.now() },
  });
}

function wrapNotificationService(service, registry) {
  const originalShowNotification = service.showNotification.bind(service);
  const originalShowIdle = service.showIdleNotification.bind(service);
  const originalShowPermission =
    service.showPermissionRequestNotificationAsync?.bind(service);
  const originalShowAsk = service.showAskUserQuestionNotification.bind(service);

  // Nobody is looking at this container's display, so the official
  // "user is viewing this session" suppression must not run here: the browser
  // client applies the same rule against its own focused route instead.
  service.isUserViewingSession = () => false;

  // The navigation registry is wrapped so a relayed click can learn which route
  // the official onClick handler navigated the host renderer to, and send that
  // route back to the browser; the host navigation itself is harmless.
  if (registry && typeof registry.getDispatcher === "function") {
    const originalGetDispatcher = registry.getDispatcher.bind(registry);
    const wrappedDispatchers = new WeakMap();
    registry.getDispatcher = (contents) => {
      const dispatcher = originalGetDispatcher(contents);
      if (!dispatcher || typeof dispatcher.dispatchNavigate !== "function") return dispatcher;
      if (!wrappedDispatchers.has(dispatcher)) {
        const originalNavigate = dispatcher.dispatchNavigate.bind(dispatcher);
        wrappedDispatchers.set(dispatcher, originalNavigate);
        dispatcher.dispatchNavigate = (route, ...rest) => {
          const sink = notificationRelay.navigationSink;
          if (sink && typeof route === "string" && route.startsWith("/")) {
            sink.push(route.slice(0, 500));
          }
          return originalNavigate(route, ...rest);
        };
      }
      return dispatcher;
    };
  }

  service.showNotification = function relayedShowNotification(title, body, tag, onClick, notificationType, attribution) {
    const capture = beginNotificationCapture({
      tag: boundedNotificationText(tag, 200) || `notification-${Date.now()}`,
      kind: "generic",
      notificationType: boundedNotificationText(notificationType, 64) || "generic",
      product: null,
      sessionId: typeof attribution?.sessionId === "string" ? attribution.sessionId : null,
      requestId: null,
      allowOnce: false,
      onClick: typeof onClick === "function" ? onClick : null,
      fallbackTitle: boundedNotificationText(title, 500),
      fallbackBody: boundedNotificationText(body, 1000),
    });
    try {
      return originalShowNotification(title, body, tag, onClick, notificationType, attribution);
    } finally {
      settleNotificationCapture(capture);
    }
  };

  service.showIdleNotification = function relayedShowIdleNotification(options) {
    const input = options && typeof options === "object" ? options : {};
    const product = input.product === "ccd" ? "ccd" : "cowork";
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    const titleFallback = boundedNotificationText(input.sessionTitle, 200)
      || (product === "cowork" ? "Cowork" : "Claude Code");
    const capture = beginNotificationCapture({
      tag: `idle-${sessionId}`,
      kind: "idle",
      product,
      sessionId,
      requestId: null,
      allowOnce: false,
      onClick: typeof input.onClick === "function" ? input.onClick : null,
      fallbackTitle: titleFallback,
      fallbackBody: typeof input.body === "string" && input.body
        ? boundedNotificationText(input.body, 1000)
        : input.kind === "turn_complete"
          ? "Claude finished a task"
          : "Claude is waiting for your input",
    });
    try {
      return originalShowIdle(input);
    } finally {
      settleNotificationCapture(capture);
    }
  };

  if (originalShowPermission) {
    service.showPermissionRequestNotificationAsync = function relayedShowPermissionAsync(options) {
      const input = options && typeof options === "object" ? options : {};
      const product = input.product === "ccd" ? "ccd" : "cowork";
      const requestId = typeof input.requestId === "string" ? input.requestId : "";
      const capture = beginNotificationCapture({
        tag: `permission-${requestId}`,
        kind: "permission",
        product,
        sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
        requestId,
        description: boundedNotificationText(input.description, 500),
        allowOnce: input.allowOnceAction !== false && input.runsOnUserMachine !== true,
        onClick: null,
        fallbackTitle: boundedNotificationText(input.cwd, 200).split("/").filter(Boolean).pop() || "Claude Code",
        fallbackBody: typeof input.body === "string" && input.body
          ? boundedNotificationText(input.body, 1000)
          : input.description
            ? `Allow Claude to ${boundedNotificationText(input.toolName, 64) || "continue"} ${input.description}?`
            : "Claude needs your permission to continue",
      });
      let result;
      try {
        result = originalShowPermission(input);
      } catch (error) {
        settleNotificationCapture(capture);
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.finally(() => settleNotificationCapture(capture));
      }
      settleNotificationCapture(capture);
      return result;
    };
  }

  service.showAskUserQuestionNotification = function relayedShowAsk(options) {
    const input = options && typeof options === "object" ? options : {};
    const product = input.product === "ccd" ? "ccd" : "cowork";
    const capture = beginNotificationCapture({
      tag: `ask-question-${boundedNotificationText(input.requestId, 200)}`,
      kind: "ask",
      product,
      sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
      requestId: typeof input.requestId === "string" ? input.requestId : null,
      allowOnce: false,
      onClick: typeof input.onClick === "function" ? input.onClick : null,
      fallbackTitle: boundedNotificationText(input.sessionTitle, 200)
        || (product === "cowork" ? "Cowork" : "Claude Code"),
      fallbackBody: boundedNotificationText(input.questionText, 1000) || "Claude is asking you a question",
    });
    try {
      return originalShowAsk(input);
    } finally {
      settleNotificationCapture(capture);
    }
  };

  for (const [method, tagOf] of [
    ["closeNotification", (tag) => tag],
    ["closeIdleNotificationForSession", (sessionId) => `idle-${sessionId}`],
    ["closePermissionNotification", (requestId) => `permission-${requestId}`],
    ["closeNotificationIfShownThisRun", (tag) => (
      service.shownNotificationTags?.has?.(tag) ? tag : null
    )],
  ]) {
    const original = service[method];
    if (typeof original !== "function") continue;
    service[method] = function relayedClose(...args) {
      let tag = null;
      try {
        tag = tagOf(...args);
      } catch {}
      const result = original.apply(service, args);
      if (typeof tag === "string" && tag) relayNotificationClosed(tag);
      return result;
    };
  }
  const originalCloseAsk = service.closeAskUserQuestionNotification;
  if (typeof originalCloseAsk === "function") {
    service.closeAskUserQuestionNotification = function relayedCloseAsk(requestId) {
      let tag = null;
      try {
        tag = service.activeAskUserQuestionNotifications?.get?.(requestId) ?? null;
      } catch {}
      const result = originalCloseAsk.call(service, requestId);
      if (typeof tag === "string" && tag) relayNotificationClosed(tag);
      return result;
    };
  }

  notificationRelay.service = service;
  notificationRelay.registry = registry ?? null;
  notificationRelay.discovery = "wrapped";
}

function looksLikeNotificationService(value) {
  // An object, not a class: wrapping a class would set a static and leave the
  // instance every call site uses untouched.
  return value !== null && typeof value === "object"
    && typeof value.showNotification === "function"
    && typeof value.showIdleNotification === "function"
    && typeof value.showAskUserQuestionNotification === "function"
    && typeof value.isLevelOff === "function";
}

function findNotificationServiceAndRegistry() {
  let service = null;
  let registry = null;
  for (const loadedModule of Object.values(require.cache)) {
    const exports = loadedModule?.exports;
    if (!exports || typeof exports !== "object") continue;
    for (const value of Object.values(exports)) {
      if (!service && looksLikeNotificationService(value)) service = value;
      if (!registry && value !== null && typeof value === "object"
        && typeof value.getDispatcher === "function"
        && typeof value.dispatchNavigate !== "function") {
        registry = value;
      }
    }
  }
  return { service, registry };
}

function ensureNotificationRelayReady() {
  if (notificationRelay.service) return true;
  const { service, registry } = findNotificationServiceAndRegistry();
  if (!service) {
    notificationRelay.discovery = "waiting";
    return false;
  }
  try {
    wrapNotificationService(service, registry);
  } catch (error) {
    notificationRelay.discovery = `failed: ${error instanceof Error ? error.message : String(error)}`;
    console.warn("[cowork-wrapper] could not wrap the Desktop notification service:", error);
    return false;
  }
  return true;
}

// A click relayed from a browser notification: run the same official handler
// the native notification would have run (navigate + bookkeeping, or answer a
// permission for "Allow once"), and report the route it navigated to so the
// browser can open the same session.
async function handleNotificationClick(tag, action) {
  const capture = notificationRelay.recent.get(tag);
  if (!capture) return { handled: false, route: null, responded: false };
  ensureNotificationRelayReady();
  const service = notificationRelay.service;
  const routes = [];
  const previousSink = notificationRelay.navigationSink;
  // Only one click is captured at a time; a concurrent click still runs its
  // official handler, it just cannot claim the other's navigation.
  if (!previousSink) notificationRelay.navigationSink = routes;
  let responded = false;
  try {
    // Answering a permission card through the official response path — the
    // same vocabulary the app's own notification actions and permission cards
    // use (once | always | deny). Deny is always offered; "Allow once" only
    // when the official notification offered it too.
    const answersPermission = capture.kind === "permission"
      && typeof service?.handlePermissionResponse === "function"
      && (action === "deny" || (action === "allow_once" && capture.allowOnce));
    if (answersPermission) {
      await service.handlePermissionResponse(
        capture.product,
        capture.requestId,
        action === "deny" ? "deny" : "once",
      );
      if (typeof service.closePermissionNotification === "function") {
        await service.closePermissionNotification(capture.requestId);
      }
      responded = true;
    } else if (capture.kind === "permission" && capture.sessionId) {
      const route = notificationRoute(service, capture.product, capture.sessionId);
      if (route && typeof service?.focusAppAndNavigate === "function") {
        service.focusAppAndNavigate(route);
      }
    } else if (capture.kind === "ask" && typeof service?.closeAskUserQuestionNotification === "function") {
      if (typeof capture.onClick === "function") capture.onClick();
      // Mirror the native click cleanup for the ask card.
      try {
        service.activeAskUserQuestionNotifications?.delete?.(capture.requestId);
        service.askUserQuestionBySession?.get?.(capture.sessionId)?.delete?.(capture.requestId);
      } catch {}
    } else if (typeof capture.onClick === "function") {
      capture.onClick();
    }
  } catch (error) {
    console.warn("[cowork-wrapper] relayed notification click failed:", error);
  } finally {
    if (notificationRelay.navigationSink === routes) {
      notificationRelay.navigationSink = previousSink;
    }
  }
  notificationRelay.clicks += 1;
  return {
    handled: true,
    responded,
    route: routes.at(-1) || capture.route || notificationRoute(service, capture.product, capture.sessionId),
  };
}
// --- end desktop notification relay ---

if (developerActionsEnabled) {
  relayedListeners.get("LocalAgentModeSessions").add(
    "onOnDirectMcpServerStatusesChanged",
  );
  relayedListeners.set("CustomPlugins", new Set(["onInstallProgress"]));
  relayedListeners.set("LocalPlugins", new Set(["onOnCliOpAlwaysAllowed"]));
  relayedListeners.set("PluginBridgeMcp", new Set(["onChanged"]));
}

if (codeActionsEnabled) {
  relayedListeners.set("LocalSessions", new Set([
    "onOnEvent",
    "onOnToolPermissionRequest",
  ]));
}

// Relay only capability flags backed by an explicitly published remote
// surface. Native-only features remain absent from the browser snapshot.
// `desktopHome` is the app's Unified Claude decision for the Chat/Cowork
// surfaces: the renderer paints the unified home when the snapshot says
// "supported". It is relayed whenever the app reports one — with no
// CLAUDE_REMOTE_DESKTOP_HOME configured the status is "unavailable" and the
// split chrome stays, so the browser follows whatever the 3P configuration
// decides.
const relayedBootFeatures = new Set([
  "chatIn3p",
  "chatTab",
  "desktopHome",
  "yukonSilver",
]);
if (codeActionsEnabled) {
  for (const feature of [
    "ccdPlugins",
    "chillingSlothEnterprise",
    "chillingSlothFeat",
    "chillingSlothLocal",
    "launch",
  ]) relayedBootFeatures.add(feature);
}

function findOfficialBootFeatures() {
  for (const loadedModule of Object.values(require.cache)) {
    const getSupportedFeaturesSync =
      loadedModule?.exports?.getSupportedFeaturesSync;
    if (typeof getSupportedFeaturesSync !== "function") continue;
    try {
      const features = getSupportedFeaturesSync();
      if (features && typeof features === "object") return features;
    } catch {
      // The official renderer snapshot below remains a safe fallback while
      // the Desktop main process is still completing startup.
    }
  }
  return null;
}

function sanitizeBootFeatures(source) {
  const result = {};
  if (!source || typeof source !== "object") return result;
  for (const name of relayedBootFeatures) {
    const feature = source[name];
    if (!feature || typeof feature !== "object") continue;
    const value = {};
    if (typeof feature.status === "string") value.status = feature.status;
    if (typeof feature.maturity === "string") value.maturity = feature.maturity;
    if (typeof feature.reason === "string") value.reason = feature.reason;
    if (typeof feature.unsupportedCode === "string") {
      value.unsupportedCode = feature.unsupportedCode;
    }
    if (typeof value.status === "string") result[name] = value;
  }
  return result;
}

function sanitizeMenuText(value, maxLength = 240) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function serializeNativeMenu(menu, depth = 0) {
  if (!menu || !Array.isArray(menu.items) || depth > 5) return [];
  return menu.items
    .filter((item) => item?.visible !== false)
    .slice(0, 80)
    .map((item) => ({
      accelerator: sanitizeMenuText(item.accelerator, 80) || null,
      checked: Boolean(item.checked),
      enabled: item.enabled !== false,
      label: sanitizeMenuText(item.label),
      role: sanitizeMenuText(item.role, 80) || null,
      submenu: item.submenu ? serializeNativeMenu(item.submenu, depth + 1) : [],
      type: sanitizeMenuText(item.type, 40) || "normal",
    }));
}

function readNativeMainMenu() {
  return serializeNativeMenu(Menu.getApplicationMenu());
}

const lastNativeMenuActionAt = new Map();
let performanceTraceActive = false;

const nativeMenuActions = new Map([
  ["reload-mcp-configuration", ["Reload MCP Configuration"]],
  ["show-dev-tools", ["Show Dev Tools"]],
  ["show-all-dev-tools", ["Show All Dev Tools"]],
  ["toggle-main-process-debugger", ["Enable Main Process Debugger"]],
  ["toggle-performance-trace", ["Record Performance Trace", "Stop Performance Trace"]],
  ["write-main-process-heap-snapshot", ["Write Main Process Heap Snapshot"]],
  ["record-memory-trace", ["Record Memory Trace (auto-stop)"]],
]);

const developerFileKinds = new Map([
  ["mcp-log", { fileName: "mcp.log", readOnly: true, root: "logs" }],
  ["app-config", {
    fileName: "claude_desktop_config.json",
    readOnly: false,
    root: "userData",
  }],
  ["developer-config", {
    fileName: "developer_settings.json",
    readOnly: false,
    root: "userData",
  }],
]);

const developerArtifactPattern = /^(?:desktop-trace|memory-trace)-[A-Za-z0-9_.:-]+\.json$|^main-heap-[A-Za-z0-9_.:-]+\.heapsnapshot$/;

function normalizedMenuLabel(value) {
  return sanitizeMenuText(value)
    .replace(/&(?=\S)/g, "")
    .replace(/\.{3}|…/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findNativeMenuItem(labels) {
  let menu = Menu.getApplicationMenu();
  let item = null;
  for (const label of labels) {
    item = menu?.items?.find((candidate) =>
      normalizedMenuLabel(candidate.label) === normalizedMenuLabel(label)
    );
    if (!item) return null;
    menu = item.submenu;
  }
  return item;
}

async function runNativeMenuAction(action) {
  const labels = nativeMenuActions.get(action);
  if (!labels) {
    throw new Error("native menu action is not allowed");
  }
  if (action !== "reload-mcp-configuration" && !developerActionsEnabled) {
    throw new Error("remote Developer actions are disabled");
  }
  if (action === "reload-mcp-configuration" &&
      !developerActionsEnabled && !gatewaySettingsEnabled) {
    throw new Error("remote MCP reload is disabled");
  }
  const now = Date.now();
  if (now - (lastNativeMenuActionAt.get(action) || 0) < 3000) {
    throw new Error("native menu action is temporarily rate limited");
  }
  const item = labels
    .map((label) => findNativeMenuItem(["Developer", label]))
    .find(Boolean);
  if (!item || item.enabled === false || typeof item.click !== "function") {
    throw new Error("official native menu action is unavailable");
  }
  lastNativeMenuActionAt.set(action, now);
  const invokedLabel = sanitizeMenuText(item.label);
  await item.click(item, BrowserWindow.getFocusedWindow() || undefined, {});
  let phase = "triggered";
  if (action === "toggle-performance-trace") {
    performanceTraceActive = !performanceTraceActive;
    phase = performanceTraceActive ? "started" : "stopped";
  } else if (action === "record-memory-trace") {
    phase = "recording-auto-stop";
  }
  return { action, invokedLabel, phase, triggered: true };
}

function requireDeveloperActions() {
  if (!developerActionsEnabled) {
    throw new Error("remote Developer actions are disabled");
  }
}

function developerFilePath(kind) {
  requireDeveloperActions();
  const spec = developerFileKinds.get(kind);
  if (!spec) throw new Error("developer file kind is not allowed");
  const root = spec.root === "logs" ? app.getPath("logs") : app.getPath("userData");
  return { path: join(root, spec.fileName), spec };
}

async function readDeveloperFile(kind) {
  const { path, spec } = developerFilePath(kind);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        content: spec.readOnly ? "" : "{}\n",
        exists: false,
        kind,
        name: spec.fileName,
        readOnly: spec.readOnly,
        truncated: false,
      };
    }
    throw error;
  }
  if (!info.isFile()) throw new Error("developer file is not a regular file");
  const maxBytes = spec.readOnly ? 2 * 1024 * 1024 : 1024 * 1024;
  let content;
  let truncated = false;
  if (info.size > maxBytes && spec.readOnly) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, info.size - maxBytes);
      content = buffer.subarray(0, bytesRead).toString("utf8");
      truncated = true;
    } finally {
      await handle.close();
    }
  } else {
    if (info.size > maxBytes) throw new Error("developer configuration is too large");
    content = await readFile(path, "utf8");
  }
  return {
    content,
    exists: true,
    kind,
    mtimeMs: info.mtimeMs,
    name: spec.fileName,
    readOnly: spec.readOnly,
    truncated,
  };
}

async function writeDeveloperFile(kind, content) {
  const { path, spec } = developerFilePath(kind);
  if (spec.readOnly) throw new Error("developer file is read-only");
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) {
    throw new Error("developer configuration must be text smaller than 1 MiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("developer configuration must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("developer configuration root must be an object");
  }
  if (kind === "developer-config" &&
      "allowDevTools" in parsed && typeof parsed.allowDevTools !== "boolean") {
    throw new Error("allowDevTools must be a boolean");
  }
  const normalized = `${JSON.stringify(parsed, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.remote-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, normalized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return readDeveloperFile(kind);
}

function developerArtifactsDirectory() {
  requireDeveloperActions();
  return join(app.getPath("logs"), "traces");
}

async function listDeveloperArtifacts() {
  const directory = developerArtifactsDirectory();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !developerArtifactPattern.test(entry.name)) continue;
    const info = await stat(join(directory, entry.name));
    files.push({ mtimeMs: info.mtimeMs, name: entry.name, size: info.size });
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 100);
}

async function serveDeveloperArtifact(response, name) {
  const directory = developerArtifactsDirectory();
  const safeName = basename(String(name || ""));
  if (safeName !== name || !developerArtifactPattern.test(safeName)) {
    throw new Error("developer artifact name is not allowed");
  }
  const path = join(directory, safeName);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("developer artifact is not a regular file");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename=${JSON.stringify(safeName)}`,
    "Content-Length": info.size,
    "Content-Type": safeName.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(path).pipe(response);
}

const protocolRules = [
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap$/ },
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap\/[0-9a-f-]+\/app_start$/i },
  // The Desktop frame bootstraps under /edge-api; a plain browser (the web
  // shell) uses the claude.ai default /api prefix, so allow its bootstrap too.
  { methods: new Set(["GET"]), path: /^\/api\/bootstrap\/[0-9a-f-]+\/app_start$/i },
  { methods: new Set(["GET"]), path: /^\/api\/bootstrap(?:\/[^/?#]+\/(?:current_user_access|system_prompts|cowork_sysprompt_map))?$/ },
  { methods: new Set(["GET", "PUT"]), path: /^\/api\/account_profile$/ },
  { methods: new Set(["PATCH"]), path: /^\/api\/account\/settings$/ },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+$/i },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+\/(?:feature_settings|cowork_settings|office_settings)$/i },
  { methods: new Set(["POST"]), path: /^\/api\/organizations\/[0-9a-f-]+\/dust\/generate_session_title$/i },
  { methods: new Set(["PATCH"]), path: /^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/[A-Za-z0-9_-]+$/i },
];

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxSize = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateInvocation(surface, method, args) {
  if (!allowedSurfaces.has(surface)) throw new Error("Cowork surface is not allowed");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new Error("invalid method name");
  if (!allowedMethods.get(surface)?.has(method)) {
    throw new Error("Cowork IPC method is not allowed");
  }
  if (!Array.isArray(args)) throw new Error("args must be an array");
}

function validateSettingsInvocation(surface, method, args) {
  if (!gatewaySettingsEnabled) throw new Error("Remote Gateway settings are disabled");
  if (!allowedSettingsMethods.get(surface)?.has(method)) {
    throw new Error("Gateway settings method is not allowed");
  }
  if (!Array.isArray(args)) throw new Error("args must be an array");
  if (surface === "AppPreferences") {
    if (!codeActionsEnabled) throw new Error("Code settings are disabled");
    validateCodePreference(method, args);
  }
  if (method === "getLoginDesktop3pStatus" && args.length !== 0) {
    throw new Error("getLoginDesktop3pStatus does not accept arguments");
  }
}

function validateCodePreference(method, args) {
  if (method === "getPreferences" && args.length === 0) return;
  const [key, value] = args;
  const accountMap = ["bypassPermissionsOptInByAccount", "bypassPermissionsGateByAccount"].includes(key);
  if (method !== "setPreference" || args.length !== 2
    || !(key === "bypassPermissionsModeEnabled" && typeof value === "boolean"
      // The desktop UI funnels its account-scoped UI picks (permission mode,
      // notification levels, sidebar mode, ...) through one `epitaxyPrefs`
      // bucket, so that key is what a permission-mode change actually writes.
      || key === "epitaxyPrefs" && value && typeof value === "object" && !Array.isArray(value)
        && Object.entries(value).every(([entry, item]) =>
          entry.length <= 128 && isBoundedJsonValue(item, 1))
      || accountMap && value && typeof value === "object" && !Array.isArray(value)
        && Object.entries(value).every(([account, enabled]) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)
          && typeof enabled === "boolean"))) {
    throw new Error("Code preference is not allowed");
  }
}

function validateStoreRead(surface, store) {
  if (!allowedStores.get(surface)?.has(store)) {
    throw new Error("Desktop store is not allowed");
  }
}

const undefinedSentinelKey = "__claudeRemoteUndefinedV1";

function decodeIpcValue(value, argsEncoding) {
  if (argsEncoding !== "json-undefined-v1") return value;
  if (Array.isArray(value)) {
    return value.map((item) => decodeIpcValue(item, argsEncoding));
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === undefinedSentinelKey && value[undefinedSentinelKey] === true) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeIpcValue(item, argsEncoding),
      ]),
    );
  }
  return value;
}

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

function validateProtocolRequest(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!protocolRules.some((rule) =>
    rule.methods.has(normalizedMethod) && rule.path.test(pathname)
  )) {
    throw new Error("Desktop protocol path is not allowed");
  }
  return normalizedMethod;
}

function validateAccountProfileUpdate(method, pathname, body) {
  if (method !== "PUT" || pathname !== "/api/account_profile") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Account profile update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Account profile update must be an object");
  }
  const allowedKeys = new Set([
    "avatar",
    "conversation_preferences",
    "cowork_global_instructions",
    "cowork_global_instructions_sha256",
    "cowork_instructions_union",
    "work_function",
  ]);
  const keys = Object.keys(parsed);
  if (!keys.length || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error("Account profile update contains a forbidden field");
  }
  for (const key of ["conversation_preferences", "cowork_global_instructions"]) {
    if (key in parsed && (typeof parsed[key] !== "string" || parsed[key].length > 10000)) {
      throw new Error(`${key} must be a string of at most 10000 characters`);
    }
  }
  // The profile editor saves the global instructions alongside the hash it has
  // for them and whether they should apply in Cowork; without these two keys an
  // instruction change was rejected as a forbidden field.
  if ("cowork_global_instructions_sha256" in parsed &&
      (typeof parsed.cowork_global_instructions_sha256 !== "string"
        || !/^[0-9a-f]{64}$/i.test(parsed.cowork_global_instructions_sha256))) {
    throw new Error("cowork_global_instructions_sha256 must be a SHA-256 hex digest");
  }
  if ("cowork_instructions_union" in parsed &&
      typeof parsed.cowork_instructions_union !== "boolean") {
    throw new Error("cowork_instructions_union must be a boolean");
  }
  if ("work_function" in parsed &&
      (typeof parsed.work_function !== "string" || parsed.work_function.length > 128)) {
    throw new Error("work_function must be a string of at most 128 characters");
  }
  if ("avatar" in parsed &&
      (!Number.isInteger(parsed.avatar) || parsed.avatar < 0 || parsed.avatar > 72)) {
    throw new Error("avatar must be an integer between 0 and 72");
  }
}

// The official renderer persists the account's own UI settings with a PATCH to
// /api/account/settings. That is not one control: the Chat toggles, the Code
// settings (transcript view, branch prefix, auto-archive, model fallback),
// onboarding, banners, voice and egress all write different keys, and the set
// grows with the bundle (the iOS protobuf alone names a dozen-plus, and Desktop
// adds its own). Enumerating them only ever trailed the bundle — each missed key
// rolled back with "Account setting is not allowed", so a picker's change did not
// stick. Validate the body's shape instead: a bounded object of bounded JSON
// values, with `internal_*` kept out (the renderer strips those itself and they
// are not settings). The upstream API still sees only keys it knows.
const accountSettingKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function validateAccountSettingsUpdate(method, pathname, body) {
  if (method !== "PATCH" || pathname !== "/api/account/settings") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Account setting update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Account setting update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new Error("Account setting update is empty");
  if (keys.length > 64) throw new Error("Account setting update has too many fields");
  for (const key of keys) {
    if (key.startsWith("internal_") || !accountSettingKeyPattern.test(key)
      || !isBoundedJsonValue(parsed[key])) {
      throw new Error("Account setting is not allowed");
    }
  }
}

// The official renderer persists the per-surface model selector (the model, its
// thinking effort/mode, the per-model defaults and the preset) with a PATCH to
// /api/organizations/{org}/model_selector_state/{surface}. The bridge previously
// dropped that path, so the optimistic selection rolled back and every composer
// snapped back to the last saved model on reload.
const modelSelectorFields = new Set([
  "model",
  "thinking",
  "thinking_by_model",
  "preset",
  "selection_source",
]);

// A bound broad enough for every field the selector sends and for the desktop's
// `epitaxyPrefs` bucket (many small UI picks, occasional short lists), strict
// enough that the path cannot carry arbitrary payloads to the upstream API.
// `undefined` is a legitimate value here: the renderer deletes a persisted pref
// by writing the whole bucket back with that key set to `undefined` (its
// `deleteStrict`), and the closed bucket carries it as a JSON-undefined sentinel.
// Rejecting it left the deleted key stuck in the bucket and made *every*
// subsequent pref write fail — including the permission-mode pick, which then
// reverted on the next read (or on send).
function isBoundedJsonValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === undefined) return true;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 8192;
  if (Array.isArray(value)) {
    return value.length <= 512 && value.every((item) => isBoundedJsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= 512
      && entries.every(([key, item]) =>
        key.length <= 128 && isBoundedJsonValue(item, depth + 1));
  }
  return false;
}

function validateModelSelectorUpdate(method, pathname, body) {
  if (
    method !== "PATCH"
    || !/^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/[A-Za-z0-9_-]+$/i.test(pathname)
  ) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Model selector update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model selector update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new Error("Model selector update is empty");
  for (const key of keys) {
    if (!modelSelectorFields.has(key) || !isBoundedJsonValue(parsed[key])) {
      throw new Error("Model selector field is not allowed");
    }
  }
}

function rendererCandidates() {
  return webContents.getAllWebContents().filter((item) => {
    if (item.isDestroyed()) return false;
    // The official main surface can live in a WebContentsView. Restrict by
    // the app origin, rather than excluding every non-window renderer.
    const url = item.getURL();
    return url === "app://localhost" || url.startsWith("app://localhost/");
  });
}

async function evaluateInOfficialRenderer(expression) {
  let lastError = null;
  const deadline = Date.now() + rendererReadyTimeoutMs;
  do {
    for (const contents of rendererCandidates()) {
      try {
        const value = await contents.executeJavaScript(expression, true);
        if (value !== "__COWORK_BRIDGE_NOT_AVAILABLE__") return value;
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() < deadline) await wait(rendererReadyPollMs);
  } while (Date.now() < deadline);
  if (lastError) throw lastError;
  throw new Error("official Cowork renderer is not ready");
}

let coworkVmIdleState = {
  checkedAt: null,
  idleSince: null,
  pid: null,
  reason: "monitor-starting",
};
let coworkVmShutdownInProgress = false;

async function findCoworkVmProcess() {
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const args = (await readFile(`/proc/${entry.name}/cmdline`))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      if (!args.some((arg) => arg.includes("qemu-system-x86_64")) ||
          !args.some((arg) => arg.includes("claude-cowork-vm"))) continue;
      const qmpIndex = args.indexOf("-qmp");
      const qmpArgument = qmpIndex >= 0 ? args[qmpIndex + 1] : "";
      const qmpSocket = /^unix:([^,]+)/.exec(qmpArgument)?.[1] || null;
      return { args, pid: Number(entry.name), qmpSocket };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  return null;
}

function scheduledTaskTimestamp(task) {
  const value = task?.nextRunAt ?? task?.nextRun ?? task?.nextScheduledAt ??
    task?.scheduledFor ?? task?.nextExecutionAt;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

async function readCoworkVmWorkState() {
  const expression = `(async () => {
    const root = globalThis["claude.web"];
    if (!root?.LocalAgentModeSessions || !root?.CoworkScheduledTasks) {
      return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    }
    const [sessions, tasks] = await Promise.all([
      root.LocalAgentModeSessions.getAll(),
      root.CoworkScheduledTasks.getAllScheduledTasks(),
    ]);
    return JSON.stringify({ sessions, tasks });
  })()`;
  return JSON.parse(await evaluateInOfficialRenderer(expression));
}

function classifyCoworkVmWorkState(state, now) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  if (sessions.some((session) => session?.isRunning === true)) {
    return { safeToStop: false, reason: "session-running" };
  }
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const enabledTasks = tasks.filter((task) =>
    task?.enabled !== false && task?.status !== "disabled"
  );
  if (enabledTasks.some((task) =>
    ["running", "executing", "in_progress"].includes(String(task?.status || "").toLowerCase())
  )) {
    return { safeToStop: false, reason: "scheduled-task-running" };
  }
  const nextRuns = enabledTasks.map(scheduledTaskTimestamp);
  if (nextRuns.some((timestamp) => timestamp === null)) {
    return { safeToStop: false, reason: "scheduled-task-time-unknown" };
  }
  const guardMs = coworkVmScheduleGuardMinutes * 60 * 1000;
  if (nextRuns.some((timestamp) => timestamp >= now && timestamp - now <= guardMs)) {
    return { safeToStop: false, reason: "scheduled-task-due-soon" };
  }
  return { safeToStop: true, reason: "idle" };
}

function qmpSystemPowerdown(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!socketPath) {
      rejectPromise(new Error("Cowork VM has no QMP socket"));
      return;
    }
    const socket = createConnection(socketPath);
    let buffer = "";
    let capabilitiesSent = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("QMP powerdown request timed out"));
    }, 5000);
    const finish = (error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    socket.setEncoding("utf8");
    socket.on("error", finish);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.QMP && !capabilitiesSent) {
          capabilitiesSent = true;
          socket.write(`${JSON.stringify({ execute: "qmp_capabilities", id: "capabilities" })}\r\n`);
        } else if (message.id === "capabilities" && message.return) {
          socket.write(`${JSON.stringify({ execute: "system_powerdown", id: "powerdown" })}\r\n`);
        } else if (message.id === "powerdown" && message.return) {
          finish();
        } else if (message.error) {
          finish(new Error(message.error.desc || "QMP command failed"));
        }
      }
    });
  });
}

async function coworkVmIdleCheck() {
  if (coworkVmShutdownInProgress) return;
  const now = Date.now();
  try {
    const vm = await findCoworkVmProcess();
    if (!vm) {
      coworkVmIdleState = {
        checkedAt: now,
        idleSince: null,
        pid: null,
        reason: "vm-not-running",
      };
      return;
    }
    const priorPid = coworkVmIdleState.pid;
    const workState = classifyCoworkVmWorkState(await readCoworkVmWorkState(), now);
    if (!workState.safeToStop) {
      coworkVmIdleState = {
        checkedAt: now,
        idleSince: null,
        pid: vm.pid,
        reason: workState.reason,
      };
      return;
    }
    const idleSince = priorPid === vm.pid && coworkVmIdleState.idleSince
      ? coworkVmIdleState.idleSince
      : Math.max(now, coworkVmLastActivityAt);
    coworkVmIdleState = {
      checkedAt: now,
      idleSince,
      pid: vm.pid,
      reason: "idle",
    };
    if (now - idleSince < coworkVmIdleMinutes * 60 * 1000) return;

    // Re-read official session/task state immediately before requesting an ACPI
    // powerdown. Any renderer/API uncertainty fails closed and leaves the VM on.
    const confirmed = classifyCoworkVmWorkState(await readCoworkVmWorkState(), Date.now());
    if (!confirmed.safeToStop) {
      coworkVmIdleState = {
        checkedAt: Date.now(),
        idleSince: null,
        pid: vm.pid,
        reason: confirmed.reason,
      };
      return;
    }
    coworkVmShutdownInProgress = true;
    coworkVmIdleState = {
      checkedAt: Date.now(),
      idleSince,
      pid: vm.pid,
      reason: "powerdown-requested",
    };
    await qmpSystemPowerdown(vm.qmpSocket);
    console.log(`[cowork-wrapper] requested idle VM ACPI powerdown for pid ${vm.pid}`);
  } catch (error) {
    coworkVmIdleState = {
      ...coworkVmIdleState,
      checkedAt: Date.now(),
      reason: `monitor-error: ${error instanceof Error ? error.message : String(error)}`,
    };
    console.warn("[cowork-wrapper] idle VM monitor left VM running:", error);
  } finally {
    coworkVmShutdownInProgress = false;
  }
}

async function gatewaySettingsRenderer() {
  const findSetupWindow = () => rendererCandidates().find((contents) =>
    contents.getURL().includes("/setup-desktop-3p")
  );
  const existing = findSetupWindow();
  if (existing) return existing;

  const openExpression = `(async () => {
    const openSetupWindow = globalThis["claude.settings"]?.Custom3pSetup?.openSetupWindow;
    if (typeof openSetupWindow !== "function") return false;
    await openSetupWindow();
    return true;
  })()`;
  let opened = false;
  for (const contents of rendererCandidates()) {
    try {
      if (await contents.executeJavaScript(openExpression, true)) {
        opened = true;
        break;
      }
    } catch {}
  }
  if (!opened) throw new Error("official Gateway setup window could not be opened");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const contents = findSetupWindow();
    if (contents) return contents;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("official Gateway setup window did not become ready");
}

async function inspect() {
  const surfaces = [...allowedSurfaces];
  const methods = Object.fromEntries(
    [...allowedMethods].map(([surface, names]) => [surface, [...names]]),
  );
  const expression = `(() => {
    const root = globalThis["claude.web"];
    if (!root?.LocalAgentModeSessions) return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    const allowed = ${JSON.stringify(methods)};
    return JSON.stringify(Object.fromEntries(
      Object.entries(root)
        .filter(([name]) => ${JSON.stringify(surfaces)}.includes(name))
        .map(([name, api]) => [
          name,
          Object.keys(api).filter(
            (key) => allowed[name]?.includes(key) && typeof api[key] === "function",
          ),
        ]),
    ));
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  return JSON.parse(serialized);
}

async function readBootFeatures() {
  // Desktop passes a one-time feature snapshot to the renderer when creating
  // its window. On Linux that can capture the transient virtualization probe
  // state forever. Prefer the official main-process evaluator, which reads
  // the completed probe and managed configuration on every call.
  const officialFeatures = findOfficialBootFeatures();
  if (officialFeatures) return sanitizeBootFeatures(officialFeatures);

  const expression = `(() => {
    const source = globalThis.desktopBootFeatures;
    if (!source || typeof source !== "object") {
      return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    }
    const allowed = ${JSON.stringify([...relayedBootFeatures])};
    const result = {};
    for (const name of allowed) {
      const feature = source[name];
      if (!feature || typeof feature !== "object") continue;
      const value = {};
      if (typeof feature.status === "string") value.status = feature.status;
      if (typeof feature.maturity === "string") value.maturity = feature.maturity;
      if (typeof feature.reason === "string") value.reason = feature.reason;
      if (typeof feature.unsupportedCode === "string") {
        value.unsupportedCode = feature.unsupportedCode;
      }
      if (typeof value.status === "string") result[name] = value;
    }
    return JSON.stringify(result);
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  return sanitizeBootFeatures(JSON.parse(serialized));
}

async function invoke(surface, method, args, argsEncoding) {
  const decodedArgs = decodeIpcValue(args, argsEncoding);
  validateInvocation(surface, method, decodedArgs);
  let effectiveArgs = decodedArgs;
  if (surface === "ClaudeVM" && method === "startVM") {
    noteCoworkVmActivity();
    const requested = decodedArgs[0];
    const safeConfig = requested && typeof requested === "object" && !Array.isArray(requested)
      ? requested
      : {};
    effectiveArgs = [{ ...safeConfig, memoryGB: coworkVmMemoryGB }];
  } else if (surface === "LocalAgentModeSessions" &&
      ["start", "sendMessage"].includes(method)) {
    noteCoworkVmActivity();
  }
  const payload = Buffer.from(JSON.stringify({
    surface,
    method,
    args: encodeIpcValue(effectiveArgs),
    argsEncoding: "json-undefined-v1",
  })).toString("base64");
  const expression = `(async () => {
    const encodedRequest = atob(${JSON.stringify(payload)});
    const requestBytes = Uint8Array.from(
      encodedRequest,
      (character) => character.charCodeAt(0),
    );
    const request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(requestBytes),
    );
    const decode = (value) => {
      if (request.argsEncoding !== "json-undefined-v1") return value;
      if (Array.isArray(value)) return value.map(decode);
      if (value && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === ${JSON.stringify(undefinedSentinelKey)} && value[${JSON.stringify(undefinedSentinelKey)}] === true) {
          return undefined;
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, decode(item)]),
        );
      }
      return value;
    };
    request.args = decode(request.args);
    const root = globalThis["claude.web"];
    if (!root?.LocalAgentModeSessions) return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    try {
      const fn = root[request.surface]?.[request.method];
      if (typeof fn !== "function") throw new Error("Cowork IPC method is unavailable");
      const value = await fn(...request.args);
      return JSON.stringify({ ok: true, value }, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "Cowork IPC call failed");
  return result.value;
}

async function invokeSettings(surface, method, args, argsEncoding) {
  const decodedArgs = decodeIpcValue(args, argsEncoding);
  validateSettingsInvocation(surface, method, decodedArgs);
  const payload = Buffer.from(JSON.stringify({ surface, method, args, argsEncoding })).toString("base64");
  const expression = `(async () => {
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0)),
    ));
    const decode = (value) => {
      if (request.argsEncoding !== "json-undefined-v1") return value;
      if (Array.isArray(value)) return value.map(decode);
      if (value && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === ${JSON.stringify(undefinedSentinelKey)} && value[${JSON.stringify(undefinedSentinelKey)}] === true) {
          return undefined;
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, decode(item)]),
        );
      }
      return value;
    };
    request.args = decode(request.args);
    const root = globalThis["claude.settings"];
    const fn = root?.[request.surface]?.[request.method];
    if (typeof fn !== "function") return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    try {
      const value = await fn(...request.args);
      return JSON.stringify({ ok: true, value }, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })()`;
  const contents = await gatewaySettingsRenderer();
  const serialized = await contents.executeJavaScript(expression, true);
  if (serialized === "__COWORK_BRIDGE_NOT_AVAILABLE__") {
    throw new Error("Gateway settings IPC is unavailable in the official setup window");
  }
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "Gateway settings IPC call failed");
  if (surface === "AppPreferences" && method === "getPreferences") {
    const source = result.value || {};
    const allowed = {};
    for (const key of [
      "bypassPermissionsModeEnabled",
      "bypassPermissionsOptInByAccount",
      "bypassPermissionsGateByAccount",
    ]) {
      if (source[key] !== undefined) allowed[key] = source[key];
    }
    // The desktop UI stores its account-scoped UI picks (permission mode among
    // them) in the `epitaxyPrefs` bucket. Echo it back so the picker restores
    // on reload, bounded to plain JSON so no unexpected field leaks out.
    if (source.epitaxyPrefs && typeof source.epitaxyPrefs === "object"
      && !Array.isArray(source.epitaxyPrefs)) {
      const cleanValue = (value, depth) => {
        if (depth > 8) return undefined;
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        if (typeof value === "string") return value.length <= 8192 ? value : undefined;
        if (Array.isArray(value)) {
          return value.length <= 512
            ? value.map((item) => cleanValue(item, depth + 1)).filter((item) => item !== undefined)
            : undefined;
        }
        if (value && typeof value === "object") {
          const clean = {};
          for (const [key, item] of Object.entries(value)) {
            if (key.length > 128) continue;
            const item2 = cleanValue(item, depth + 1);
            if (item2 !== undefined) clean[key] = item2;
          }
          return clean;
        }
        return undefined;
      };
      const clean = cleanValue(source.epitaxyPrefs, 0);
      if (clean !== undefined) allowed.epitaxyPrefs = clean;
    }
    return allowed;
  }
  return result.value;
}

async function readStore(surface, store) {
  validateStoreRead(surface, store);
  const payload = Buffer.from(JSON.stringify({ surface, store })).toString("base64");
  const expression = `(async () => {
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0)),
    ));
    try {
      const value = await globalThis["claude.web"]?.[request.surface]?.[request.store]?.getState?.();
      return JSON.stringify({ ok: true, value }, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item
      );
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "Desktop store read failed");
  return result.value;
}

async function ensureRelayedEventsRegistered() {
  for (const id of registeredRelayContentsIds) {
    const current = webContents.fromId(id);
    if (!current || current.isDestroyed()) registeredRelayContentsIds.delete(id);
  }
  const listeners = Object.fromEntries(
    [...relayedListeners].map(([surface, methods]) => [surface, [...methods]]),
  );
  const expression = `(() => {
    const root = globalThis["claude.web"];
    if (typeof root?.LocalAgentModeSessions?.onOnEvent !== "function") return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    const relayKey = "__CLAUDE_REMOTE_EVENT_RELAY_V2__";
    if (!globalThis[relayKey]) {
      const relay = { unsubscribers: [] };
      const listeners = ${JSON.stringify(listeners)};
      const consolePrefix = ${JSON.stringify(relayConsolePrefix)};
      for (const [surface, methods] of Object.entries(listeners)) {
        for (const method of methods) {
          const subscribe = root[surface]?.[method];
          if (typeof subscribe !== "function") continue;
          try {
            const unsubscribe = subscribe((payload) => {
              let value = null;
              try {
                value = JSON.parse(JSON.stringify(payload, (_key, item) =>
                  typeof item === "bigint" ? item.toString() : item
                ));
              } catch {
                value = { type: "unserializable-event" };
              }
              console.debug(consolePrefix + JSON.stringify({ surface, method, payload: value }));
            });
            if (typeof unsubscribe === "function") relay.unsubscribers.push(unsubscribe);
          } catch {}
        }
      }
      globalThis[relayKey] = relay;
    }
    return true;
  })()`;
  let lastError = null;
  const deadline = Date.now() + rendererReadyTimeoutMs;
  do {
    for (const contents of rendererCandidates()) {
      if (registeredRelayContentsIds.has(contents.id)) continue;
      attachRelayConsole(contents);
      try {
        const registered = await contents.executeJavaScript(expression, true);
        if (registered === true) {
          registeredRelayContentsIds.add(contents.id);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (registeredRelayContentsIds.size) return;
    if (Date.now() < deadline) await wait(rendererReadyPollMs);
  } while (Date.now() < deadline);
  if (lastError) throw lastError;
  throw new Error("official Cowork renderer is not ready");
}

async function drainRelayedEvents() {
  await ensureRelayedEventsRegistered();
  return relayedEventQueue.splice(0);
}

async function fetchOfficialProtocol({ method, pathname, search, headers, bodyBase64 }) {
  const normalizedMethod = validateProtocolRequest(method, pathname);
  const body = Buffer.from(typeof bodyBase64 === "string" ? bodyBase64 : "", "base64");
  validateAccountProfileUpdate(normalizedMethod, pathname, body);
  validateAccountSettingsUpdate(normalizedMethod, pathname, body);
  validateModelSelectorUpdate(normalizedMethod, pathname, body);
  const safeHeaders = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if ([
      "accept",
      "accept-language",
      "anthropic-anonymous-id",
      "anthropic-client-build",
      "anthropic-client-device-id",
      "anthropic-client-platform",
      "anthropic-client-sha",
      "anthropic-client-version",
      "content-type",
      "x-activity-session-id",
    ].includes(name.toLowerCase())) {
      safeHeaders[name] = String(value).slice(0, 1000);
    }
  }
  const requestPayload = {
    method: normalizedMethod,
    url: `app://localhost${pathname}${search || ""}`,
    headers: safeHeaders,
    bodyBase64: body.toString("base64"),
  };
  const payload = Buffer.from(JSON.stringify(requestPayload)).toString("base64");
  const expression = `(async () => {
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0)),
    ));
    try {
      const body = request.bodyBase64
        ? Uint8Array.from(atob(request.bodyBase64), (character) => character.charCodeAt(0))
        : undefined;
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return JSON.stringify({
        ok: true,
        value: {
          status: response.status,
          contentType: response.headers.get("content-type") || "application/octet-stream",
          bodyBase64: btoa(binary),
        },
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "official Desktop protocol request failed");
  return result.value;
}

async function serveIon(response, pathname) {
  const prepared = pathname.startsWith(`${rendererManifest.basePath}/`);
  const requested = prepared
    ? pathname.slice(rendererManifest.basePath.length + 1) || "index.html"
    : pathname.slice("/ion/".length) || "index.html";
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const overlayPath = resolve(
    RENDERER_STATE_ROOT,
    rendererManifest.desktopVersion,
    rendererManifest.patchRelease,
    safePath,
  );
  // A declared patch must be served or fail visibly. Falling back when the
  // overlay is unreadable silently restores the upstream redirect guard.
  const patched = prepared && rendererManifest.files.some(file => file.path === safePath);
  const filePath = patched
    ? overlayPath
    : resolve(ION_ROOT, safePath);
  if (filePath !== ION_ROOT && !filePath.startsWith(`${ION_ROOT}/`)) {
    if (!prepared || !filePath.startsWith(`${RENDERER_STATE_ROOT}/`)) {
      throw new Error("not found");
    }
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("not found");
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Cache-Control": safePath === "index.html" && !prepared
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "Content-Length": body.length,
    "Content-Type": ionMimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function serveDesktopIcon(response) {
  const body = await readFile(DESKTOP_ICON);
  response.writeHead(200, {
    "Cache-Control": "public, max-age=86400",
    "Content-Length": body.length,
    "Content-Type": "image/png",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function generateTitle(message, model) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("message must be a non-empty string");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("model must be a non-empty string");
  }
  const payload = Buffer.from(JSON.stringify({ message, model })).toString("base64");
  const expression = `(async () => {
    const encodedRequest = atob(${JSON.stringify(payload)});
    const requestBytes = Uint8Array.from(
      encodedRequest,
      (character) => character.charCodeAt(0),
    );
    const request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(requestBytes),
    );
    try {
      const response = await fetch(
        "app://localhost/api/organizations/00000000-0000-4000-8000-000000000001/dust/generate_session_title",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            first_session_message: request.message,
            model: request.model,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message || \`title generation returned HTTP \${response.status}\`);
      }
      if (typeof body?.title !== "string" || !body.title.trim()) {
        throw new Error("official title generation returned an empty title");
      }
      return JSON.stringify({ ok: true, value: body.title.trim() });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })()`;
  const serialized = await evaluateInOfficialRenderer(expression);
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "official title generation failed");
  return result.value;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (
      request.method === "GET"
      && (url.pathname.startsWith("/ion/") || url.pathname.startsWith("/renderer/"))
    ) {
      await serveIon(response, url.pathname);
      return;
    }
    if (request.method === "GET" && url.pathname === "/desktop-icon.png") {
      await serveDesktopIcon(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const surfaces = await inspect();
      sendJson(response, 200, {
        ok: true,
        coworkReady: Boolean(surfaces.LocalAgentModeSessions?.includes("getAll")),
        rendererReady: true,
        renderer: rendererManifest,
        surfaces,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/boot-features") {
      sendJson(response, 200, { ok: true, value: await readBootFeatures() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/runtime") {
      sendJson(response, 200, {
        ok: true,
        value: {
          coworkVmPolicy: {
            executionMode: coworkHostBashEnabled ? "container-host" : "vm",
            idleMinutes: coworkVmIdleMinutes,
            memoryGB: coworkVmMemoryGB,
            monitor: coworkVmIdleState,
            scheduleGuardMinutes: coworkVmScheduleGuardMinutes,
          },
          notifications: {
            clicks: notificationRelay.clicks,
            discovery: notificationRelay.discovery,
            pending: notificationRelay.pending.length,
            shown: notificationRelay.shown,
          },
          platform: process.platform,
          renderer: rendererManifest,
          version: app.getVersion(),
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/main-menu") {
      sendJson(response, 200, { ok: true, value: readNativeMainMenu() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/main-menu-action") {
      const body = await readJson(request);
      sendJson(response, 200, { ok: true, value: await runNativeMenuAction(body.action) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/developer-file") {
      sendJson(response, 200, {
        ok: true,
        value: await readDeveloperFile(url.searchParams.get("kind")),
      });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/developer-file") {
      const body = await readJson(request);
      sendJson(response, 200, {
        ok: true,
        value: await writeDeveloperFile(body.kind, body.content),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/developer-artifacts") {
      sendJson(response, 200, { ok: true, value: await listDeveloperArtifacts() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/developer-artifact") {
      await serveDeveloperArtifact(response, url.searchParams.get("name"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      sendJson(response, 200, { ok: true, value: await drainRelayedEvents() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/notifications") {
      // The always-on consumer for Web Push delivery. The relayed-event queue
      // above is only drained while a browser SSE subscription exists; pushes
      // must also be delivered when no tab is open, so notifications are
      // queued separately and drained here regardless of clients. A stale
      // backlog is bounded at enqueue time and dropped by age on display.
      ensureNotificationRelayReady();
      const value = notificationRelay.pushQueue.splice(0);
      sendJson(response, 200, { ok: true, value });
      return;
    }
    if (request.method === "POST" && url.pathname === "/notification-click") {
      const body = await readJson(request);
      const tag = typeof body.tag === "string" ? body.tag.slice(0, 200) : "";
      // "allow_once" and "deny" answer a permission card; anything else is
      // a plain click.
      const action = body.action === "allow_once" || body.action === "deny"
        ? body.action
        : "default";
      if (!tag) throw new Error("notification tag is required");
      const now = Date.now();
      if (now - (lastNotificationClickAt.get(tag) || 0) < 500) {
        sendJson(response, 200, { ok: true, value: { handled: false, duplicate: true } });
        return;
      }
      lastNotificationClickAt.set(tag, now);
      while (lastNotificationClickAt.size > 200) {
        lastNotificationClickAt.delete(lastNotificationClickAt.keys().next().value);
      }
      sendJson(response, 200, { ok: true, value: await handleNotificationClick(tag, action) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/invoke") {
      // The outer bridge validates the surface/method first. Keep this second
      // independent check because direct port exposure has no app-layer auth.
      // Preserve enough room for Desktop's base64 image attachment contract.
      const body = await readJson(request, 72 * 1024 * 1024);
      const value = await invoke(
        body.surface,
        body.method,
        body.args || [],
        body.argsEncoding,
      );
      sendJson(response, 200, { ok: true, value });
      return;
    }
    if (request.method === "POST" && url.pathname === "/settings-invoke") {
      const body = await readJson(request);
      const value = await invokeSettings(
        body.surface,
        body.method,
        body.args || [],
        body.argsEncoding,
      );
      sendJson(response, 200, { ok: true, value });
      return;
    }
    if (request.method === "POST" && url.pathname === "/store") {
      const body = await readJson(request);
      sendJson(response, 200, {
        ok: true,
        value: await readStore(body.surface, body.store),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/protocol") {
      const body = await readJson(request);
      sendJson(response, 200, {
        ok: true,
        value: await fetchOfficialProtocol(body),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/generate-title") {
      const body = await readJson(request);
      const value = await generateTitle(body.message, body.model);
      sendJson(response, 200, { ok: true, value });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[cowork-wrapper] internal bridge listening on ${HOST}:${PORT}`);
});

app.whenReady().then(() => {
  // The official main bundle has not been evaluated yet when this file loads;
  // find and wrap its notification service as soon as it exists. A bounded
  // poll also covers a slower first window creation on cold starts.
  let notificationDiscoveryAttempts = 0;
  const notificationDiscoveryPoll = setInterval(() => {
    notificationDiscoveryAttempts += 1;
    if (ensureNotificationRelayReady() || notificationDiscoveryAttempts >= 600) {
      clearInterval(notificationDiscoveryPoll);
    }
  }, 500);
  notificationDiscoveryPoll.unref();

  if (coworkHostBashEnabled) {
    console.warn("[cowork-wrapper] container-host Bash enabled; Cowork VM startup bypassed");
    return;
  }
  setTimeout(() => {
    coworkVmIdleCheck();
    setInterval(coworkVmIdleCheck, coworkVmIdlePollMs).unref();
  }, coworkVmIdlePollMs).unref();
});
