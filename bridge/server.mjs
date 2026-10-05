import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  createDownloadHandler,
  readContainedFile,
  resolveContainedPath,
  sessionFileReadLimit,
} from "./downloads.mjs";
import { createUploadHandler, parseUploadLimit } from "./uploads.mjs";
import { createRealtimeController } from "./realtime.mjs";
import { listWorkspaceFolders } from "./workspace-folders.mjs";

const host = process.env.BRIDGE_HOST || "0.0.0.0";
const port = Number(process.env.BRIDGE_PORT || 8080);
const coworkInternalUrl = (
  process.env.COWORK_INTERNAL_URL || "http://127.0.0.1:9222"
).replace(/\/$/, "");
const gatewaySettingsEnabled = process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1";
const developerActionsEnabled = process.env.CLAUDE_REMOTE_DEVELOPER_ACTIONS === "1";
const infrastructureActionsEnabled =
  process.env.CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS === "1";
const codeActionsEnabled = process.env.CLAUDE_REMOTE_CODE_ACTIONS === "1";
const workspaceRoot = resolve(process.env.COWORK_REMOTE_WORKSPACE_ROOT || "/workspace");
// Roots the remote download route may serve from. The workspace is always
// allowed, because the web UI's own file browser reads from it; extra roots
// come from COWORK_REMOTE_READ_ROOTS so an operator can opt into reading other
// paths. These are paths as THIS container sees them, so a host directory needs
// a bind mount to be reachable. Default: workspace only.
const extraDownloadRoots = String(process.env.COWORK_REMOTE_READ_ROOTS || "")
  .split(/[:,]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));
const downloadRoots = [...new Set([workspaceRoot, ...extraDownloadRoots])];
// Largest file the bridge will hand the session reader when Desktop itself
// refuses. Desktop caps its own reader at 10 MiB (SESSION_FILE_MAX_BYTES) and
// returns null above it; matching that by default avoids shipping huge bodies
// through the IPC route. Raise it to open larger text files in the file pane.
// Accepts a plain byte count or a K/M/G suffix, like COWORK_UPLOAD_MAX_BYTES;
// a bare suffix-less parseInt would silently read "100M" as 100 bytes.
const sessionFileCapBytes = parseUploadLimit(
  process.env.COWORK_REMOTE_SESSION_FILE_MAX_BYTES,
  10 * 1024 * 1024,
);
// Handing a file to the session reader means holding it several times over at
// once, so the container's own limit is what actually bounds the size that can
// be served: an 80 MB file under a 256 MB limit killed the process mid response
// and "restart: unless-stopped" looped it. sessionFileReadLimit() also clamps
// COWORK_REMOTE_SESSION_FILE_MAX_BYTES to an eighth of that limit, so raising
// the configured cap asks for a bigger preview but cannot take the bridge down.
function cgroupMemoryLimitBytes() {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw && raw !== "max") {
        const limit = Number(raw);
        if (Number.isFinite(limit) && limit > 0) return limit;
      }
    } catch {
      // Not in a cgroup-scoped container, or unreadable: fall through.
    }
  }
  return null;
}
const sessionFileMemoryLimitBytes = cgroupMemoryLimitBytes();
const sessionFileMaxBytes = sessionFileReadLimit({
  requestedBytes: sessionFileCapBytes,
  memoryLimitBytes: sessionFileMemoryLimitBytes,
});
const artifactsRoot = resolve(
  process.env.COWORK_REMOTE_ARTIFACTS_ROOT || "/config/Claude/Artifacts",
);
const internalFailureExitThreshold = Number(
  process.env.COWORK_INTERNAL_FAILURE_EXIT_THRESHOLD || 3,
);
const publicDir = new URL("./public/", import.meta.url).pathname;
const undefinedSentinelKey = "__claudeRemoteUndefinedV1";
const release = JSON.parse(readFileSync(new URL("./release.json", import.meta.url), "utf8"));

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

const configuredModels = (() => {
  try {
    const value = JSON.parse(process.env.CLAUDE_INFERENCE_MODELS_JSON || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .map((model) => typeof model?.name === "string" ? model.name : "")
      .filter(Boolean);
  } catch {
    return [];
  }
})();
const allowedModels = new Set(configuredModels);
const allowedDeveloperActions = new Set([
  "record-memory-trace",
  "reload-mcp-configuration",
  "show-all-dev-tools",
  "show-dev-tools",
  "toggle-main-process-debugger",
  "toggle-performance-trace",
  "write-main-process-heap-snapshot",
]);
const allowedDeveloperFileKinds = new Set([
  "app-config",
  "developer-config",
  "mcp-log",
]);

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
    "hide",
    "isEnabled",
    "isEpitaxyPreviewEnabled",
    "isOpenInDefaultAppEnabled",
    "isVmReady",
    "parkAndCapture",
    "show",
  ])],
  ["CoworkMemory", new Set(["listAccountMemories", "readAccountMemory", "readGlobalMemory"])],
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
  for (const method of [
    "deleteArtifact",
  ]) allowedMethods.get("CoworkArtifacts").add(method);
  for (const method of [
    "deleteAccountMemory",
    "writeAccountMemory",
    "writeGlobalMemory",
  ]) allowedMethods.get("CoworkMemory").add(method);
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

const remoteListenerMethods = new Map([
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
]);

if (codeActionsEnabled) {
  remoteListenerMethods.set("LocalSessions", new Set([
    "onOnEvent",
    "onOnToolPermissionRequest",
  ]));
}

if (developerActionsEnabled) {
  remoteListenerMethods.get("LocalAgentModeSessions").add(
    "onOnDirectMcpServerStatusesChanged",
  );
  remoteListenerMethods.set("CustomPlugins", new Set(["onInstallProgress"]));
  remoteListenerMethods.set("LocalPlugins", new Set(["onOnCliOpAlwaysAllowed"]));
  remoteListenerMethods.set("PluginBridgeMcp", new Set(["onChanged"]));
}

const allowedStores = new Map([
  ["LocalAgentModeSessions", new Set([
    "interactiveAuthStore",
    "sessionsBridgeStatusStore",
  ])],
  ["ManagedConfig", new Set(["managedRendererConfigStore"])],
  ["ClaudeVM", new Set(["apiReachabilityStore"])],
]);

const protocolRules = [
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap$/ },
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap\/[0-9a-f-]+\/app_start$/i },
  { methods: new Set(["GET"]), path: /^\/api\/bootstrap(?:\/[^/?#]+\/(?:current_user_access|system_prompts|cowork_sysprompt_map))?$/ },
  { methods: new Set(["GET", "PUT"]), path: /^\/api\/account_profile$/ },
  { methods: new Set(["PATCH"]), path: /^\/api\/account\/settings$/ },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+$/i },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+\/(?:feature_settings|cowork_settings|office_settings)$/i },
  { methods: new Set(["POST"]), path: /^\/api\/organizations\/[0-9a-f-]+\/dust\/generate_session_title$/i },
  { methods: new Set(["PATCH"]), path: /^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/[A-Za-z0-9_-]+$/i },
];

const officialAssetPrefixes = [
  "/_frame-rt/",
  "/assets/",
  "/audio/",
  "/i18n/",
  "/images/",
];

const officialAssetFiles = new Set([
  "/desktop-icon.png",
  "/favicon.ico",
  "/frame-shell.html",
  "/robots.txt",
  "/scc.json",
]);

const allowedSurfaces = new Set(allowedMethods.keys());

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

class DesktopInternalClient {
  async request(pathname, options = {}) {
    const response = await fetch(`${coworkInternalUrl}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || `internal Cowork bridge returned ${response.status}`);
    }
    return body;
  }

  async invoke(surface, method, args, argsEncoding) {
    const serializedArgs = argsEncoding === "json-undefined-v1"
      ? encodeIpcValue(args)
      : args;
    const body = await this.request("/invoke", {
      method: "POST",
      body: JSON.stringify({ surface, method, args: serializedArgs, argsEncoding }),
    });
    return body.value;
  }

  async invokeSettings(surface, method, args, argsEncoding) {
    const body = await this.request("/settings-invoke", {
      method: "POST",
      body: JSON.stringify({ surface, method, args, argsEncoding }),
    });
    return body.value;
  }

  async inspect() {
    const body = await this.request("/health");
    return body.surfaces;
  }

  async fetchRaw(pathname, options = {}) {
    return fetch(`${coworkInternalUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(120000),
    });
  }

  async readStore(surface, store) {
    const body = await this.request("/store", {
      method: "POST",
      body: JSON.stringify({ surface, store }),
    });
    return body.value;
  }

  async bootFeatures() {
    const body = await this.request("/boot-features");
    return body.value;
  }

  async runtime() {
    const body = await this.request("/runtime");
    return body.value;
  }

  async mainMenu() {
    const body = await this.request("/main-menu");
    return Array.isArray(body.value) ? body.value : [];
  }

  async mainMenuAction(action) {
    const body = await this.request("/main-menu-action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    return body.value;
  }

  async readDeveloperFile(kind) {
    const body = await this.request(`/developer-file?kind=${encodeURIComponent(kind)}`);
    return body.value;
  }

  async writeDeveloperFile(kind, content) {
    const body = await this.request("/developer-file", {
      method: "PUT",
      body: JSON.stringify({ kind, content }),
    });
    return body.value;
  }

  async listDeveloperArtifacts() {
    const body = await this.request("/developer-artifacts");
    return Array.isArray(body.value) ? body.value : [];
  }

  async protocol(value) {
    const body = await this.request("/protocol", {
      method: "POST",
      body: JSON.stringify(value),
    });
    return body.value;
  }

  async pollEvents() {
    const body = await this.request("/events");
    return Array.isArray(body.value) ? body.value : [];
  }

  async generateTitle(message, model) {
    const body = await this.request("/generate-title", {
      method: "POST",
      body: JSON.stringify({ message, model }),
    });
    return body.value;
  }
}

const desktop = new DesktopInternalClient();

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendDesktopReconnectPage(response) {
  const body = Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <title>Claudesk 正在重新连接</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(32rem, calc(100% - 3rem)); text-align: center; }
    h1 { font-size: 1.4rem; font-weight: 600; }
    p { line-height: 1.6; opacity: .72; }
    a { display: inline-block; margin-top: .5rem; padding: .65rem 1rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: .65rem; color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>正在重新连接 Claude Desktop</h1>
    <p>修改 API 配置或重启服务后可能需要一小段时间。页面将在 3 秒后自动重试。</p>
    <a href="/">立即重试</a>
  </main>
</body>
</html>`, "utf8");
  response.writeHead(503, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "text/html; charset=utf-8",
    "Retry-After": "3",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function isDocumentNavigation(request) {
  if (request.method !== "GET") return false;
  if (request.headers["sec-fetch-dest"] === "document") return true;
  return String(request.headers.accept || "").includes("text/html");
}

const realtime = createRealtimeController({ desktop, isChatSession, ApiError });
const uploads = createUploadHandler({
  ApiError,
  workspaceRoot,
  maxBytes: parseUploadLimit(process.env.COWORK_UPLOAD_MAX_BYTES),
});
const handleDownload = createDownloadHandler({
  ApiError,
  artifactsRoot,
  mimeTypes,
  downloadRoots,
});

async function readJson(request, maxSize = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new ApiError(413, "request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRequestBuffer(request, maxSize = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new ApiError(413, "request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateStoreRead(surface, store) {
  if (!allowedStores.get(surface)?.has(store)) {
    throw new ApiError(400, "Desktop store is not allowed");
  }
}

function validateProtocolRequest(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!protocolRules.some((rule) =>
    rule.methods.has(normalizedMethod) && rule.path.test(pathname)
  )) {
    throw new ApiError(404, "Desktop protocol path is not allowed");
  }
  return normalizedMethod;
}

function validateAccountProfileUpdate(method, pathname, body) {
  if (method !== "PUT" || pathname !== "/api/account_profile") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Account profile update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Account profile update must be an object");
  }
  const allowedKeys = new Set([
    "avatar",
    "conversation_preferences",
    "cowork_global_instructions",
    "work_function",
  ]);
  const keys = Object.keys(parsed);
  if (!keys.length || keys.some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "Account profile update contains a forbidden field");
  }
  for (const key of ["conversation_preferences", "cowork_global_instructions"]) {
    if (key in parsed && (typeof parsed[key] !== "string" || parsed[key].length > 10000)) {
      throw new ApiError(400, `${key} must be a string of at most 10000 characters`);
    }
  }
  if ("work_function" in parsed &&
      (typeof parsed.work_function !== "string" || parsed.work_function.length > 128)) {
    throw new ApiError(400, "work_function must be a string of at most 128 characters");
  }
  if ("avatar" in parsed &&
      (!Number.isInteger(parsed.avatar) || parsed.avatar < 0 || parsed.avatar > 72)) {
    throw new ApiError(400, "avatar must be an integer between 0 and 72");
  }
}

// The official renderer persists account-scoped Claude Code settings with a
// PATCH to /api/account/settings. The one such setting in the current bundle is
// the Code tab's "Default transcript view" (`code_default_transcript_view`),
// which the client writes on its own after the segmented control changes. The
// bridge previously dropped that path, so the optimistic write rolled back and
// the control snapped back to Normal.
const allowedAccountSettings = new Map([
  ["code_default_transcript_view", new Set(["normal", "thinking", "verbose"])],
]);

function validateAccountSettingsUpdate(method, pathname, body) {
  if (method !== "PATCH" || pathname !== "/api/account/settings") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Account setting update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Account setting update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new ApiError(400, "Account setting update is empty");
  for (const key of keys) {
    const values = allowedAccountSettings.get(key);
    if (!values || !values.has(parsed[key])) {
      throw new ApiError(400, "Account setting is not allowed");
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
    throw new ApiError(400, "Model selector update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Model selector update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new ApiError(400, "Model selector update is empty");
  for (const key of keys) {
    if (!modelSelectorFields.has(key) || !isBoundedJsonValue(parsed[key])) {
      throw new ApiError(400, "Model selector field is not allowed");
    }
  }
}

function sanitizeStoreValue(surface, store, value) {
  if (surface === "LocalAgentModeSessions" && store === "sessionsBridgeStatusStore") {
    return { remoteToolsDeviceName: value?.remoteToolsDeviceName ?? null };
  }
  if (surface === "LocalAgentModeSessions" && store === "interactiveAuthStore") {
    return { principalDisplayName: value?.principalDisplayName ?? null };
  }
  if (surface === "ClaudeVM" && store === "apiReachabilityStore") {
    return { reachability: value?.reachability ?? "unknown" };
  }
  if (surface === "ManagedConfig" && store === "managedRendererConfigStore") {
    return {};
  }
  return {};
}

function containsSensitiveCredential(value) {
  if (!value || typeof value !== "object") return false;
  const sensitiveName = /^(?:api_?key|gateway_?api_?key|access_?token|refresh_?token|authorization|password|secret)$/i;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveName.test(key)) return true;
    if (containsSensitiveCredential(item)) return true;
  }
  return false;
}

async function forwardOfficialProtocol(request, response, url) {
  const method = validateProtocolRequest(request.method, url.pathname);
  if (url.search.length > 4096) throw new ApiError(400, "query string is too long");
  const body = ["GET", "HEAD"].includes(method)
    ? Buffer.alloc(0)
    : await readRequestBuffer(request);
  validateAccountProfileUpdate(method, url.pathname, body);
  validateAccountSettingsUpdate(method, url.pathname, body);
  validateModelSelectorUpdate(method, url.pathname, body);
  const result = await desktop.protocol({
    method,
    pathname: url.pathname,
    search: url.search,
    headers: {
      accept: request.headers.accept,
      "accept-language": request.headers["accept-language"],
      "anthropic-anonymous-id": request.headers["anthropic-anonymous-id"],
      "anthropic-client-build": request.headers["anthropic-client-build"],
      "anthropic-client-device-id": request.headers["anthropic-client-device-id"],
      "anthropic-client-platform": request.headers["anthropic-client-platform"],
      "anthropic-client-sha": request.headers["anthropic-client-sha"],
      "anthropic-client-version": request.headers["anthropic-client-version"],
      "content-type": request.headers["content-type"],
      "x-activity-session-id": request.headers["x-activity-session-id"],
    },
    bodyBase64: body.toString("base64"),
  });
  const responseBody = Buffer.from(result.bodyBase64 || "", "base64");
  if ((result.contentType || "").includes("application/json")) {
    const parsed = JSON.parse(responseBody.toString("utf8"));
    if (containsSensitiveCredential(parsed)) {
      throw new ApiError(502, "Desktop protocol response contained a forbidden credential field");
    }
  }
  response.writeHead(result.status || 502, {
    "Cache-Control": "no-store",
    "Content-Length": responseBody.length,
    "Content-Type": result.contentType || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(responseBody);
}

function validateInvocation(surface, method, args) {
  if (!allowedSurfaces.has(surface)) throw new ApiError(400, "Desktop surface is not allowed");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new ApiError(400, "invalid method name");
  if (!allowedMethods.get(surface)?.has(method)) {
    throw new ApiError(400, "Desktop IPC method is not allowed");
  }
  if (!Array.isArray(args)) throw new ApiError(400, "args must be an array");
}

// Desktop's session-file reader returns null (never a status) when a path is
// outside the session's granted directories or over 10 MiB, and the official
// file pane then shows a generic "Couldn't read this file". When that happens,
// read the file from the roots this bridge serves and answer the same call, so
// the pane previews it normally. Desktop still owns the happy path: we only
// fill a result it refused, never override one it produced.
async function supplementSessionFileRead(body, value) {
  if (value != null) return value;
  if (body.method === "resolveSessionFile") {
    // Chat renders a path as an openable file only when this resolves. Desktop
    // refuses anything outside the session's folders, which would leave agent
    // paths un-clickable; resolve them against the roots we serve instead.
    const requested = body.args?.[1];
    if (typeof requested !== "string" || !requested) return value;
    const filePath = await resolveContainedPath(downloadRoots, requested, {
      allowRoot: true,
      missingMessage: "session file was not found",
      outsideMessage: "session file path is outside the allowed read roots",
    });
    if (!filePath) return value;
    console.log(`[cowork-bridge] session-file resolve ${requested} -> ${filePath}`);
    return { path: filePath, aliases: [] };
  }
  const requested = body.method === "readFileAtCwd" ? body.args?.[0] : body.args?.[1];
  if (typeof requested !== "string" || !requested) return value;
  const read = await readContainedFile(downloadRoots, requested, {
    maxBytes: sessionFileMaxBytes,
    allowRoot: false,
    missingMessage: "session file was not found",
    outsideMessage: "session file path is outside the allowed read roots",
  });
  if (read.file) {
    console.log(
      `[cowork-bridge] session-file ${body.method} served ${requested} (${read.file.fileSize} bytes)`,
    );
    return read.file;
  }
  // Log the refusal, since the pane shows the same generic message for every
  // cause and a wrong root or an undersized cap is otherwise invisible.
  console.log(
    `[cowork-bridge] session-file ${body.method} declined ${requested}: ${read.failure}`
      + (read.fileSize ? ` (${read.fileSize} bytes, cap ${sessionFileMaxBytes})` : ""),
  );
  return value;
}

// Desktop's status-bearing reader (status: ok | notFound | tooLarge | readError,
// plus a file on ok), answered by the bridge rather than forwarded. The official
// file pane prefers this method whenever the surface advertises it, and it is
// the only way a refusal reaches the pane as a reason: readSessionFile's bare
// null becomes a generic "Couldn't read this file", while tooLarge becomes
// "Preview isn't available for this file" with the size. Desktop still answers
// first for the files it can see; we only fill in what it refuses.
async function bridgeSessionFileWithStatus(args, argsEncoding) {
  let described = null;
  try {
    described = await desktop.invoke(
      "LocalSessions",
      "readSessionFileWithStatus",
      args,
      argsEncoding,
    );
  } catch {
    // The inner surface may not expose it; the roots below are the fallback.
  }
  if (described?.status === "ok" && described.file) return described;
  const requested = args?.[1];
  if (typeof requested !== "string" || !requested) {
    return described ?? { status: "readError" };
  }
  const read = await readContainedFile(downloadRoots, requested, {
    maxBytes: sessionFileMaxBytes,
    allowRoot: false,
    missingMessage: "session file was not found",
    outsideMessage: "session file path is outside the allowed read roots",
  });
  if (read.file) {
    console.log(
      `[cowork-bridge] session-file readSessionFileWithStatus served ${requested} (${read.file.fileSize} bytes)`,
    );
    return { status: "ok", file: read.file };
  }
  if (read.failure === "too_large") {
    console.log(
      `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: too_large`
        + ` (${read.fileSize} bytes, cap ${sessionFileMaxBytes})`,
    );
    return { status: "tooLarge" };
  }
  if (read.failure === "not_found") {
    console.log(
      `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: not_found`,
    );
    // Desktop saw a file too big to read where we find nothing.
    return described?.status === "tooLarge" ? described : { status: "notFound" };
  }
  if (described) return described;
  try {
    const file = await desktop.invoke("LocalSessions", "readSessionFile", args, argsEncoding);
    if (file) return { status: "ok", file };
  } catch {
    // Fall through to readError below.
  }
  console.log(
    `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: ${read.failure}`,
  );
  return { status: "readError" };
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
    throw new ApiError(400, "Code preference is not allowed");
  }
}

function validateSettingsInvocation(surface, method, args) {
  if (!gatewaySettingsEnabled) {
    throw new ApiError(404, "Remote Gateway settings are disabled");
  }
  if (!allowedSettingsMethods.get(surface)?.has(method)) {
    throw new ApiError(400, "Gateway settings method is not allowed");
  }
  if (!Array.isArray(args)) throw new ApiError(400, "args must be an array");
  if (surface === "AppPreferences") {
    if (!codeActionsEnabled) throw new ApiError(404, "Code settings are disabled");
    validateCodePreference(method, args);
  }
  if (method === "getLoginDesktop3pStatus" && args.length !== 0) {
    throw new ApiError(400, "getLoginDesktop3pStatus does not accept arguments");
  }
}

function sanitize3pLoginStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.provider === "string" && value.provider.length <= 80) {
    result.provider = value.provider;
  }
  if (typeof value.bootstrapHost === "string" && value.bootstrapHost.length <= 500) {
    result.bootstrapHost = value.bootstrapHost;
  }
  if (typeof value.needsInteractiveAuth === "boolean") {
    result.needsInteractiveAuth = value.needsInteractiveAuth;
  }
  if (value.source && typeof value.source === "object" && !Array.isArray(value.source)) {
    const source = {};
    if (typeof value.source.type === "string" && value.source.type.length <= 80) {
      source.type = value.source.type;
    }
    if (typeof value.source.managedUnusable === "boolean") {
      source.managedUnusable = value.source.managedUnusable;
    }
    result.source = source;
  }
  return result;
}

function requireNonEmptyString(value, name, maxLength = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ApiError(400, `${name} must be a non-empty string`);
  if (normalized.length > maxLength) {
    throw new ApiError(400, `${name} is too long`);
  }
  return normalized;
}

function requireConfiguredModel(value) {
  const model = requireNonEmptyString(value, "model", 200);
  if (!allowedModels.size) {
    throw new ApiError(503, "no inference models are configured for the bridge");
  }
  if (!allowedModels.has(model)) {
    throw new ApiError(400, `unsupported model: ${model}`);
  }
  return model;
}

function isChatSession(session) {
  return session?.sessionType === "chat";
}

async function getSession(sessionId) {
  const session = await desktop.invoke("LocalAgentModeSessions", "getSession", [sessionId]);
  if (!session) throw new ApiError(404, "session not found");
  return session;
}

async function requireSessionKind(sessionId, kind) {
  const session = await getSession(sessionId);
  const matches = kind === "chat" ? isChatSession(session) : !isChatSession(session);
  if (!matches) throw new ApiError(409, `session is not a ${kind} session`);
  return session;
}

async function sendSessionMessage(sessionId, message) {
  const messageUuid = randomUUID();
  // Claude Desktop validates absent attachment arguments as undefined. Preserve
  // that value across JSON instead of converting it to null or an empty array.
  const value = await desktop.invoke("LocalAgentModeSessions", "sendMessage", [
    sessionId,
    message,
    undefined,
    undefined,
    messageUuid,
    undefined,
  ], "json-undefined-v1");
  return { value, messageUuid };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/remote/folders") {
    const value = await listWorkspaceFolders(workspaceRoot, url.searchParams.get("path") || workspaceRoot);
    sendJson(response, 200, { ok: true, value });
    return;
  }
  if (protocolRules.some((rule) => rule.path.test(url.pathname))) {
    await forwardOfficialProtocol(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/files/limits") {
    sendJson(response, 200, { ok: true, value: uploads.limits() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/files/upload") {
    const value = await uploads.receive(request, response, url);
    sendJson(response, 200, { ok: true, value });
    return;
  }
  if (await handleDownload(request, response, url)) return;

  if (request.method === "POST" && url.pathname === "/api/remote/ipc") {
    // Official Desktop carries image attachments as base64 in send/start IPC,
    // so this route needs a larger bounded allowance than other JSON routes.
    // Files go through the streaming upload route instead.
    const body = await readJson(request, 72 * 1024 * 1024);
    validateInvocation(body.surface, body.method, body.args ?? []);
    const startedAt = Date.now();
    try {
      let value;
      if (
        body.surface === "LocalSessions"
        && body.method === "readSessionFileWithStatus"
      ) {
        // Answered in the bridge: it needs to merge Desktop's view with the
        // roots this container serves, and it must never hand the pane a bare
        // null where a reason is available.
        value = await bridgeSessionFileWithStatus(
          body.args ?? [],
          body.argsEncoding,
        );
      } else {
        value = await desktop.invoke(
          body.surface,
          body.method,
          body.args ?? [],
          body.argsEncoding,
        );
        if (
          body.surface === "LocalSessions"
          && (
            body.method === "readSessionFile"
            || body.method === "readFileAtCwd"
            || body.method === "resolveSessionFile"
          )
        ) {
          value = await supplementSessionFileRead(body, value);
        }
      }
      if (
        body.surface === "LocalAgentModeSessions"
        && body.method === "getSession"
        && value
        && typeof value === "object"
        && typeof value.sessionType !== "string"
      ) {
        const sessionId = body.args?.[0];
        const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
        const listedSession = Array.isArray(sessions)
          ? sessions.find((session) => (session?.sessionId ?? session?.id) === sessionId)
          : undefined;
        if (typeof listedSession?.sessionType === "string") {
          value = { ...value, sessionType: listedSession.sessionType };
        }
      }
      if (body.surface === "FileSystem") {
        console.log(
          `[cowork-bridge] ipc ${body.surface}.${body.method} ok ${Date.now() - startedAt}ms`,
        );
      }
      sendJson(response, 200, { ok: true, value });
    } catch (error) {
      console.error(
        `[cowork-bridge] ipc ${body.surface}.${body.method} failed ${Date.now() - startedAt}ms: ${error.message}`,
      );
      throw error;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/main-menu") {
    const value = await desktop.mainMenu();
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/main-menu-action") {
    const body = await readJson(request);
    if (!allowedDeveloperActions.has(body.action)) {
      throw new ApiError(400, "Remote Developer action is not allowed");
    }
    if (body.action === "reload-mcp-configuration") {
      if (!gatewaySettingsEnabled && !developerActionsEnabled) {
        throw new ApiError(404, "Remote MCP reload is disabled");
      }
    } else if (!developerActionsEnabled) {
      throw new ApiError(404, "Remote Developer actions are disabled");
    }
    const value = await desktop.mainMenuAction(body.action);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/file") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer files are disabled");
    const kind = url.searchParams.get("kind");
    if (!allowedDeveloperFileKinds.has(kind)) {
      throw new ApiError(400, "Remote Developer file kind is not allowed");
    }
    const value = await desktop.readDeveloperFile(kind);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/remote/developer/file") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer files are disabled");
    const body = await readJson(request);
    if (!allowedDeveloperFileKinds.has(body.kind) || body.kind === "mcp-log") {
      throw new ApiError(400, "Remote Developer file is not writable");
    }
    if (typeof body.content !== "string" || body.content.length > 1024 * 1024) {
      throw new ApiError(400, "Remote Developer file content is invalid");
    }
    const value = await desktop.writeDeveloperFile(body.kind, body.content);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/artifacts") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer artifacts are disabled");
    const value = await desktop.listDeveloperArtifacts();
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/artifact") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer artifacts are disabled");
    const name = url.searchParams.get("name") || "";
    if (!/^(?:desktop-trace|memory-trace)-[A-Za-z0-9_.:-]+\.json$|^main-heap-[A-Za-z0-9_.:-]+\.heapsnapshot$/.test(name)) {
      throw new ApiError(400, "Remote Developer artifact name is not allowed");
    }
    const upstream = await desktop.fetchRaw(
      `/developer-artifact?name=${encodeURIComponent(name)}`,
    );
    if (!upstream.ok || !upstream.body) {
      throw new ApiError(upstream.status || 502, "Remote Developer artifact is unavailable");
    }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Disposition": upstream.headers.get("content-disposition") || "attachment",
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;
    response.writeHead(200, headers);
    Readable.fromWeb(upstream.body).pipe(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/settings") {
    const body = await readJson(request);
    validateSettingsInvocation(body.surface, body.method, body.args ?? []);
    let value = await desktop.invokeSettings(
      body.surface,
      body.method,
      body.args ?? [],
      body.argsEncoding,
    );
    if (body.surface === "Custom3pSetup" && body.method === "getLoginDesktop3pStatus") {
      value = sanitize3pLoginStatus(value);
    }
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/crypto/digest") {
    const body = await readJson(request);
    const algorithm = String(body.algorithm || "").toUpperCase();
    const nodeAlgorithm = {
      "SHA-256": "sha256",
      "SHA-384": "sha384",
      "SHA-512": "sha512",
    }[algorithm];
    if (!nodeAlgorithm) throw new ApiError(400, "digest algorithm is not allowed");
    if (
      typeof body.dataBase64 !== "string"
      || body.dataBase64.length > 1024 * 1024
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)
    ) {
      throw new ApiError(400, "invalid digest input");
    }
    const input = Buffer.from(body.dataBase64, "base64");
    const value = createHash(nodeAlgorithm).update(input).digest("base64");
    sendJson(response, 200, { ok: true, value: { dataBase64: value } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/store") {
    const body = await readJson(request);
    validateStoreRead(body.surface, body.store);
    const value = sanitizeStoreValue(
      body.surface,
      body.store,
      await desktop.readStore(body.surface, body.store),
    );
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    realtime.open(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    try {
      const [surfaces, desktopRuntime] = await Promise.all([
        desktop.inspect(),
        desktop.runtime(),
      ]);
      const runtimeControlReady = Boolean(
        surfaces?.ClaudeVM?.includes("isHostLoopModeEnabled")
        && surfaces?.ClaudeVM?.includes("getDownloadStatus")
        && surfaces?.ClaudeVM?.includes("getRunningStatus")
        && surfaces?.ClaudeVM?.includes("startVM")
      );
      sendJson(response, 200, {
        ok: true,
        release,
        renderer: desktopRuntime.renderer,
        transport: "official-renderer-ipc",
        runtimeControlReady,
        coworkReady: Boolean(
          surfaces?.LocalAgentModeSessions?.includes("getAll")
          && runtimeControlReady
        ),
        chatReady: Boolean(
          surfaces?.LocalAgentModeSessions?.includes("start")
          && surfaces?.LocalAgentModeSessions?.includes("sendMessage")
        ),
        // The Claude Code (LocalSessions) surface is only present when the
        // Desktop build exposes it and CLAUDE_REMOTE_CODE_ACTIONS allows it.
        // The mobile facade's Code tab needs all four of these.
        codeReady: Boolean(
          codeActionsEnabled
          && surfaces?.LocalSessions?.includes("getAll")
          && surfaces?.LocalSessions?.includes("getSession")
          && surfaces?.LocalSessions?.includes("sendMessage")
        ),
        configuredModels,
        codeActionsEnabled,
        infrastructureActionsEnabled,
        // The actual methods the renderer exposes on each surface, filtered by
        // what this bridge allows. `codeReady` only checks request/response
        // methods, so the live listener (`LocalSessions.onOnEvent`) can be
        // absent while Code still works — this is where that shows.
        surfaces,
      });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/cowork/sessions") {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    sendJson(response, 200, { ok: true, value: sessions.filter((session) => !isChatSession(session)) });
    return;
  }

  const transcriptMatch = url.pathname.match(/^\/api\/cowork\/sessions\/([^/]+)\/transcript$/);
  if (request.method === "GET" && transcriptMatch) {
    const sessionId = decodeURIComponent(transcriptMatch[1]);
    await requireSessionKind(sessionId, "cowork");
    const transcript = await desktop.invoke("LocalAgentModeSessions", "getTranscript", [sessionId]);
    sendJson(response, 200, { ok: true, value: transcript });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/cowork\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    await requireSessionKind(sessionId, "cowork");
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const { value, messageUuid } = await sendSessionMessage(sessionId, message);
    sendJson(response, 200, { ok: true, value, messageUuid });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/models") {
    sendJson(response, 200, { ok: true, value: configuredModels });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/sessions") {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    sendJson(response, 200, { ok: true, value: sessions.filter(isChatSession) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat/sessions") {
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const model = requireConfiguredModel(body.model);
    let title;
    try {
      title = requireNonEmptyString(
        await desktop.generateTitle(message, model),
        "generated title",
        200,
      );
    } catch {
      // A title is presentation metadata. Do not prevent a short new session
      // from starting when the optional title-generation request is unavailable.
      title = message.replace(/\s+/g, " ").slice(0, 200);
    }
    const sessionId = `local_${randomUUID()}`;
    const messageUuid = randomUUID();
    const value = await desktop.invoke("LocalAgentModeSessions", "start", [{
      sessionId,
      message,
      messageUuid,
      model,
      title,
      sessionType: "chat",
      images: [],
      userSelectedFiles: [],
      userSelectedFolders: [],
      syntheticMessage: false,
      documentFunnelEnabled: false,
    }]);
    sendJson(response, 201, { ok: true, value, sessionId, messageUuid, title });
    return;
  }

  const chatSessionMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (request.method === "GET" && chatSessionMatch) {
    const sessionId = decodeURIComponent(chatSessionMatch[1]);
    const session = await requireSessionKind(sessionId, "chat");
    sendJson(response, 200, { ok: true, value: session });
    return;
  }

  const chatTranscriptMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/transcript$/);
  if (request.method === "GET" && chatTranscriptMatch) {
    const sessionId = decodeURIComponent(chatTranscriptMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const transcript = await desktop.invoke("LocalAgentModeSessions", "getTranscript", [sessionId]);
    sendJson(response, 200, { ok: true, value: transcript });
    return;
  }

  const chatMessageMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && chatMessageMatch) {
    const sessionId = decodeURIComponent(chatMessageMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const { value, messageUuid } = await sendSessionMessage(sessionId, message);
    sendJson(response, 200, { ok: true, value, messageUuid });
    return;
  }

  const chatStopMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/stop$/);
  if (request.method === "POST" && chatStopMatch) {
    const sessionId = decodeURIComponent(chatStopMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const value = await desktop.invoke("LocalAgentModeSessions", "stop", [sessionId]);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  const chatModelMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/model$/);
  if (request.method === "PATCH" && chatModelMatch) {
    const sessionId = decodeURIComponent(chatModelMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const model = requireConfiguredModel(body.model);
    await desktop.invoke("LocalAgentModeSessions", "setModel", [sessionId, model]);
    sendJson(response, 200, { ok: true, value: await getSession(sessionId) });
    return;
  }

  const chatTitleMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/title$/);
  if (request.method === "PATCH" && chatTitleMatch) {
    const sessionId = decodeURIComponent(chatTitleMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const title = requireNonEmptyString(body.title, "title", 200);
    await desktop.invoke("LocalAgentModeSessions", "updateSession", [
      sessionId,
      { title, titleSource: "manual" },
    ]);
    sendJson(response, 200, { ok: true, value: await getSession(sessionId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const publicRoot = resolve(publicDir);
  const filePath = resolve(publicRoot, safePath);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}/`)) {
    throw new Error("not found");
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("not found");
  let body = await readFile(filePath);
  if ([".css", ".html", ".js"].includes(extname(filePath))) {
    const source = body.toString("utf8");
    const marker = "__CLAUDESK_RELEASE__";
    if (pathname === "/service-worker.js" && !source.includes(marker)) {
      throw new ApiError(500, "service worker release marker is missing");
    }
    body = Buffer.from(source.replaceAll(marker, release.patchRelease), "utf8");
  }
  const fileExtension = extname(filePath);
  response.writeHead(200, {
    "Cache-Control": fileExtension === ".otf"
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "Content-Type": mimeTypes[fileExtension] || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  response.end(body);
}

async function servePreparedRendererAsset(response, pathname) {
  const upstream = await desktop.fetchRaw(pathname);
  if (!upstream.ok) throw new ApiError(upstream.status, "prepared renderer asset not found");
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Cache-Control": pathname.endsWith("/index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "Content-Length": body.length,
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function initialRemoteStores() {
  const specs = [
    ["LocalAgentModeSessions", "sessionsBridgeStatusStore"],
    ["LocalAgentModeSessions", "interactiveAuthStore"],
    ["ManagedConfig", "managedRendererConfigStore"],
    ["ClaudeVM", "apiReachabilityStore"],
  ];
  const entries = await Promise.all(specs.map(async ([surface, store]) => {
    try {
      const value = await desktop.readStore(surface, store);
      return [`${surface}.${store}`, sanitizeStoreValue(surface, store, value)];
    } catch {
      return [`${surface}.${store}`, {}];
    }
  }));
  return Object.fromEntries(entries);
}

async function initialChatSessionIds() {
  try {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    return Array.isArray(sessions)
      ? sessions
        .filter(isChatSession)
        .map((session) => session.sessionId)
        .filter((sessionId) => typeof sessionId === "string")
      : [];
  } catch {
    return [];
  }
}

function htmlSafeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

async function serveOfficialIndex(response) {
  const desktopRuntime = await desktop.runtime();
  const rendererBase = desktopRuntime?.renderer?.basePath;
  if (
    desktopRuntime?.renderer?.desktopVersion !== release.desktopVersion
    || desktopRuntime?.renderer?.patchRelease !== release.patchRelease
    || typeof rendererBase !== "string"
  ) {
    throw new ApiError(503, "prepared renderer does not match the active Claudesk release");
  }
  const upstream = await desktop.fetchRaw(`${rendererBase}/index.html`);
  if (!upstream.ok) throw new ApiError(502, "official ion-dist entry is unavailable");
  const config = {
    configuredModels,
    chatSessionIds: await initialChatSessionIds(),
    desktopBootFeatures: await desktop.bootFeatures(),
    desktopRuntime,
    release,
    codeActionsEnabled,
    developerActionsEnabled,
    gatewaySettingsEnabled,
    initialStores: await initialRemoteStores(),
    listeners: Object.fromEntries(
      [...remoteListenerMethods].map(([surface, methods]) => [surface, [...methods]]),
    ),
    methods: Object.fromEntries(
      [...allowedMethods].map(([surface, methods]) => [surface, [...methods]]),
    ),
    settingsMethods: Object.fromEntries(
      [...allowedSettingsMethods].map(([surface, methods]) => [
        surface,
        surface === "Custom3pSetup"
          ? [...methods, "openSetupWindow", "setDeploymentMode"]
          : [...methods],
      ]),
    ),
    stores: Object.fromEntries(
      [...allowedStores].map(([surface, stores]) => [surface, [...stores]]),
    ),
    transport: "official-ion-dist-remote-ipc",
  };
  const bootstrapInjection = [
    `<link rel="manifest" href="/manifest.webmanifest?v=${release.patchRelease}">`,
    `<link rel="preload" href="/fonts/AnthropicSerif-Text-Regular-CJK.otf?v=${release.patchRelease}" as="font" type="font/otf" crossorigin>`,
    '<meta name="theme-color" content="#f7f6f2">',
    `<script>globalThis.__CLAUDE_REMOTE_BOOTSTRAP__=${htmlSafeJson(config)}</script>`,
    `<script src="/remote-main-menu.js?v=${release.patchRelease}"></script>`,
    `<script src="/remote-preload.js?v=${release.patchRelease}"></script>`,
    `<script src="/remote-folder-picker.js?v=${release.patchRelease}"></script>`,
  ].join("");
  // The official entry lists its CSS after the module script. Put our narrow
  // remote overrides at the very end of <head>, otherwise the official button
  // sizing rules win in the mobile composer.
  const overrideStyles = [
    `<link rel="stylesheet" href="/remote-shell.css?v=${release.patchRelease}">`,
    `<link rel="stylesheet" href="/remote-main-menu.css?v=${release.patchRelease}">`,
  ].join("");
  let html = await upstream.text();
  html = html
    .replace('<link rel="manifest" href="/manifest.json">', "")
    .replace('<script type="module"', `${bootstrapInjection}<script type="module"`)
    .replace(
      /\b(href|src)="\/(assets|images|audio|i18n|_frame-rt)\//g,
      `$1="${rendererBase}/$2/`,
    )
    .replace("</head>", `${overrideStyles}</head>`);
  if (!html.includes("__CLAUDE_REMOTE_BOOTSTRAP__")) {
    throw new ApiError(502, "official ion-dist entry format changed; refusing an unshimmed page");
  }
  if (!html.includes(`${rendererBase}/assets/`)) {
    throw new ApiError(
      502,
      "official ion-dist entry changed; refusing a mixed renderer module graph",
    );
  }
  const body = Buffer.from(html, "utf8");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  response.end(body);
}

const localStaticFiles = new Set([
  "/fonts/AnthropicSerif-Text-Regular-CJK.otf",
  "/manifest.webmanifest",
  "/remote-developer.css",
  "/remote-developer.html",
  "/remote-developer.js",
  "/remote-main-menu.css",
  "/remote-main-menu.js",
  "/remote-preload.js",
  "/remote-folder-picker.js",
  "/remote-shell.css",
  "/service-worker.js",
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/edge-api/")) {
      await handleApi(request, response, url);
    }
    else if (url.pathname === "/manifest.json") {
      await serveStatic(response, "/manifest.webmanifest");
    } else if (localStaticFiles.has(url.pathname)) {
      await serveStatic(response, url.pathname);
    } else if (url.pathname.startsWith("/renderer/")) {
      await servePreparedRendererAsset(response, url.pathname);
    } else if (
      officialAssetFiles.has(url.pathname)
      || officialAssetPrefixes.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      const upstream = await desktop.fetchRaw(
        url.pathname === "/desktop-icon.png" ? url.pathname : `/ion${url.pathname}`,
      );
      if (!upstream.ok) throw new ApiError(upstream.status, "official ion-dist asset not found");
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(200, {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": body.length,
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    } else {
      await serveOfficialIndex(response);
    }
  } catch (error) {
    const status = error.statusCode || (error.message === "not found" ? 404 : 500);
    if (isDocumentNavigation(request) && status >= 500) {
      sendDesktopReconnectPage(response);
    } else {
      sendJson(response, status, { ok: false, error: error.message });
    }
  }
});

// Node ends any request that takes longer than five minutes to arrive, which a
// large upload over a slow link can exceed. Headers must still arrive in time.
server.requestTimeout = 0;

server.listen(port, host, () => {
  console.log(`[cowork-bridge] listening on ${host}:${port}; internal=${coworkInternalUrl}`);
  console.log(`[cowork-bridge] download roots: ${downloadRoots.join(", ")}`);
  console.log(
    `[cowork-bridge] session-file fallback on, cap ${sessionFileMaxBytes} bytes`
      + ` (requested ${sessionFileCapBytes}, memory limit ${sessionFileMemoryLimitBytes ?? "unknown"})`,
  );
});

const realtimePoller = setInterval(() => void realtime.pollState(), 1000);
realtimePoller.unref();
const desktopEventPoller = setInterval(() => void realtime.pollDesktopEvents(), 500);
desktopEventPoller.unref();
const realtimeHeartbeat = setInterval(() => realtime.heartbeat(), 15000);
realtimeHeartbeat.unref();

// --- Code session titles -----------------------------------------------------
// Desktop names its own Code sessions through a "stale-name check" that runs
// the CLI's `generate_session_title` control request — and that whole path is
// behind a feature gate which is OFF in self-hosted ("custom3p") mode, where
// Desktop ships empty statsig values and a hardcoded growthbook table without
// the gate. So a session started in the Desktop/browser UI keeps its first
// message as the title forever, silently (the check returns before it can log).
//
// The facade titles sessions the *phone* creates, via Desktop's own
// `/dust/generate_session_title` stub — Anthropic's title prompt and Desktop's
// default session model. This does the same for every other Code session: no
// custom prompt, no pinned model, just Desktop's generator invoked at the point
// Desktop's gate would have. Only sessions started after the bridge came up are
// considered, so a restart does not backfill (and pay for) the entire history.
const codeTitleSessionIds = new Set(); // desktop session ids already handled
const codeTitleStartedAt = Date.now();
let codeTitlePollInFlight = false;
const TITLE_DEVICE_ORG = "00000000-0000-4000-8000-000000000001";

// Every non-empty user-message text in a transcript, in order. Used both to
// find the first message and to prove the session has had exactly ONE user turn
// — the trigger is "the first turn just finished", and a session with a
// history is not that, however its title happens to read.
function userMessageTexts(entries) {
  const texts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || entry.isMeta || entry.isSynthetic) continue;
    if (entry.type !== "user" && entry.message?.role !== "user") continue;
    const content = entry.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text || "").join("")
        : "";
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) texts.push(normalized);
  }
  return texts;
}

function titleLooksLikeFirstMessage(title, firstMessage) {
  const current = String(title || "").replace(/\s+/g, " ").trim();
  if (!current) return true;
  // Desktop sets the code title to the (usually truncated) first message.
  return current === firstMessage || firstMessage.startsWith(current);
}

async function generateCodeTitle(firstMessage) {
  const result = await desktop.protocol({
    method: "POST",
    pathname: `/api/organizations/${TITLE_DEVICE_ORG}/dust/generate_session_title`,
    search: "",
    headers: { "content-type": "application/json", accept: "application/json" },
    bodyBase64: Buffer.from(JSON.stringify({ first_session_message: firstMessage })).toString("base64"),
  });
  const body = JSON.parse(Buffer.from(result?.bodyBase64 || "", "base64").toString("utf8"));
  return typeof body?.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
}

// The session as Desktop reports it RIGHT NOW, not a row from the list read
// that started this poll. The rename is applied only against this fresh read, so
// a stale row (or a transcript that read out of step with its id) can never
// rename a session that no longer looks like an untitled first turn — which is
// how an already-active chat got renamed with another chat's title.
async function freshSession(id) {
  try {
    return await desktop.invoke("LocalSessions", "getSession", [id]);
  } catch {
    return null;
  }
}

async function titleCodeSessions() {
  if (!codeActionsEnabled || codeTitlePollInFlight) return;
  codeTitlePollInFlight = true;
  try {
    const sessions = await desktop.invoke("LocalSessions", "getAll", []);
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const id = session?.sessionId;
      if (!id || session.isArchived || session.isRunning) continue;
      if (codeTitleSessionIds.has(id)) continue;
      // Existing-at-startup sessions are left as they are; only new ones are
      // titled, so a restart does not spawn a model call per historical session.
      const createdAt = Number(session.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < codeTitleStartedAt) {
        codeTitleSessionIds.add(id);
        continue;
      }
      if (session.titleSource === "user" || session.titleSource === "tool") {
        codeTitleSessionIds.add(id);
        continue;
      }
      let entries;
      try {
        entries = await desktop.invoke("LocalSessions", "getTranscript", [id]);
      } catch {
        continue; // not ready yet — look again next tick
      }
      const userTexts = userMessageTexts(entries);
      if (userTexts.length === 0) continue; // no first turn yet — look again
      codeTitleSessionIds.add(id);
      // Exactly one user turn: a fresh session whose first turn just finished.
      // A session with more is not one we should rename.
      if (userTexts.length !== 1) continue;
      const firstMessage = userTexts[0];
      const before = await freshSession(id);
      if (!before || before.isRunning || before.isArchived) continue;
      if (!titleLooksLikeFirstMessage(before.title, firstMessage)) continue;
      try {
        const title = await generateCodeTitle(firstMessage);
        if (!title) continue;
        // Re-read after the model call: if the session moved on (another turn,
        // a rename), leave it alone.
        const after = await freshSession(id);
        if (!after || after.isRunning || after.title === title) continue;
        if (!titleLooksLikeFirstMessage(after.title, firstMessage)) continue;
        await desktop.invoke("LocalSessions", "updateSession", [id, { title }]);
        console.log(`[cowork-bridge] titled code session ${id}: ${JSON.stringify(title)}`);
      } catch (error) {
        console.warn(`[cowork-bridge] could not title code session ${id}: ${error.message}`);
      }
    }
  } catch {
    // Desktop not reachable yet; the next tick retries.
  } finally {
    codeTitlePollInFlight = false;
  }
}
const codeTitlePoller = setInterval(() => void titleCodeSessions(), 5000);
codeTitlePoller.unref();

// `network_mode: service:claude-desktop` pins this container to the Desktop
// container's current network namespace. If Desktop restarts, Docker can leave
// an already-running dependent in the retired namespace. Exiting after
// repeated transport failures lets the existing restart policy reattach this
// process to the new namespace. HTTP errors still prove the namespace is
// reachable, so only connection-level fetch failures count.
let consecutiveInternalTransportFailures = 0;
const internalTransportMonitor = setInterval(async () => {
  try {
    await fetch(`${coworkInternalUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    consecutiveInternalTransportFailures = 0;
  } catch (error) {
    if (
      error?.name === "TimeoutError"
      || error?.name === "AbortError"
      || /aborted due to timeout/i.test(String(error?.message || ""))
    ) {
      // A responsive namespace can still have a temporarily busy Desktop
      // renderer. Restarting the bridge on request timeout tears down every
      // browser SSE subscription and turns a transient stall into a visible
      // realtime outage. Only transport failures such as ECONNREFUSED count
      // toward namespace reattachment.
      consecutiveInternalTransportFailures = 0;
      console.warn(`[cowork-bridge] internal health check timed out; keeping realtime clients connected: ${error.message}`);
      return;
    }
    consecutiveInternalTransportFailures += 1;
    console.error(
      `[cowork-bridge] internal transport unavailable (${consecutiveInternalTransportFailures}/${internalFailureExitThreshold}): ${error.message}`,
    );
    if (consecutiveInternalTransportFailures >= internalFailureExitThreshold) {
      console.error("[cowork-bridge] exiting to reattach to Claude Desktop network namespace");
      process.exit(1);
    }
  }
}, 10000);
internalTransportMonitor.unref();
