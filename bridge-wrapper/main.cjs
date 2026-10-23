"use strict";

const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");
const { createReadStream, readFileSync, writeSync } = require("node:fs");
const { createConnection } = require("node:net");
const { lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } = require("node:fs/promises");
const { basename, dirname, extname, join, normalize, resolve } = require("node:path");
const { promisify } = require("node:util");
const { gunzip, gzip } = require("node:zlib");
const { app, BrowserWindow, dialog, ipcMain, Menu, net, webContents } = require("electron");

const extensions = require("./extensions.cjs");
const sessionAttachments = require("./session-attachments.cjs");

// See extensions.cjs. The policy is created before the official app loads so
// windows can be wrapped as they appear, and `ensure()` retries until the
// official deployment mode is initialized.
const extensionPolicy = extensions.createExtensionPolicy();
let relayedExtensionDialogs = 0;
// One entry per browser-relayed extension call that may raise native dialogs.
// The official install path reports failures through an error dialog and then
// returns null/undefined, which the page's fire-and-forget call would otherwise
// never see; the captured detail is turned into a rejected relay so the
// preload can show it as a toast.
const relayedExtensionDialogStack = [];

// The install confirmation and the error dialogs are native message boxes. A
// browser cannot see them; `invokeSettings` brackets the relayed
// install/preview calls below and this wrapper answers them at once, with the
// first button (Install / OK). Native calls from the Desktop window itself are
// outside that bracket and keep their dialog.
if (typeof dialog?.showMessageBox === "function") {
  const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = (...args) => {
    if (relayedExtensionDialogs <= 0) return originalShowMessageBox(...args);
    const options = args.find((argument) => argument && typeof argument === "object"
      && ("message" in argument || "title" in argument));
    if (options) {
      const capture = relayedExtensionDialogStack.at(-1);
      capture?.push({
        title: String(options.title || ""),
        message: String(options.message || ""),
        detail: String(options.detail || ""),
        type: String(options.type || ""),
        buttons: Array.isArray(options.buttons) ? options.buttons.length : 0,
      });
    }
    const answer = { response: 0, checkboxChecked: false };
    // Electron accepts a trailing callback instead of a promise. The install
    // path awaits the promise form; keep the callback form working anyway.
    const callback = args.find((argument) => typeof argument === "function");
    if (callback) {
      queueMicrotask(() => callback(answer));
      return undefined;
    }
    return Promise.resolve(answer);
  };
}

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

// Desktop's task store refuses to publish a routine's own file when that file
// carries a second hard link — writing "through" the link would land on the
// link's other name, which is how a sandboxed agent could redirect a privileged
// write — and it says so: "Not written: this task's file is hard-linked to
// another file. Replace it with a plain copy." Current builds put that refusal
// behind a rollout gate and, while the gate is off, do the refusing *and the
// fixing* the other way round: they publish a fresh file into the task's
// directory themselves, which is exactly what the refusal asks a person with
// shell access to do by hand.
//
// The gate reads on for this deployment's accounts, which strands every routine
// whose file an agent ever hard-linked: the store checks on every write, so each
// later edit, from every client, fails the same way, and nobody can reach that
// machine to replace the file. Rewrite the feature payload that carries the gate
// on its way in, and the store repairs the link itself — upstream's own path,
// for every writer, including the Desktop window's routines list and the agent's
// `update_scheduled_task` tool. Only that one key is dropped: the rest of the
// payload, and any response that is not this endpoint, pass through untouched,
// and a response this cannot rewrite is handed on exactly as it arrived.
//
// The wrapper and the bridge also repair the file by hand (see "routine file
// repair" below): older Desktop builds refuse unconditionally, with no gate to
// drop, and a feature payload that arrives from the disk cache instead of the
// network never passes through here.
const routineFileLinkGate = "346871663";
const desktopFeaturesPath = "/api/desktop/features";

function dropRoutineFileLinkGate(payload) {
  const features = payload?.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  if (!Object.hasOwn(features, routineFileLinkGate)) return false;
  delete features[routineFileLinkGate];
  return true;
}

async function withoutRoutineFileLinkGate(response, url) {
  // The store's refusal is only one key of the payload, and a response that
  // cannot be read back is worse than the refusal: clone first, and hand the
  // original on for anything short of a clean rewrite.
  const fallback = response.clone();
  try {
    const payload = await response.json();
    if (!dropRoutineFileLinkGate(payload)) return fallback;
    const headers = new Headers(response.headers);
    // The body is re-serialized, so any encoding the original declared is gone.
    headers.delete("content-encoding");
    headers.delete("content-length");
    console.info(
      `[cowork-wrapper] ${url}: dropped feature ${routineFileLinkGate}`
      + " so the store repairs a hard-linked routine file itself",
    );
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.warn(`[cowork-wrapper] could not rewrite ${url}: ${error?.message || error}`);
    return fallback;
  }
}

if (typeof net?.fetch === "function") {
  const originalNetFetch = net.fetch.bind(net);
  net.fetch = async (input, init) => {
    const response = await originalNetFetch(input, init);
    try {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      let pathname = null;
      try {
        pathname = new URL(url).pathname;
      } catch {}
      if (pathname === desktopFeaturesPath) return await withoutRoutineFileLinkGate(response, url);
    } catch (error) {
      console.warn(`[cowork-wrapper] feature payload pass-through failed: ${error?.message || error}`);
    }
    return response;
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
// A tenant's Code runs on its self-hosted runner, so the local executor stays
// off — but the Code surface's own preferences (draft permission mode, model
// and effort picks) are real and must be readable/writable.
const codeSurfaceEnabled = process.env.CLAUDESK_CODE_RUNNERS === "1";
// Connectors (remote MCP servers) need the Desktop MCP IPC even for an ordinary
// account, so they ride their own flag rather than the Developer-menu gate. Kept
// in lockstep with bridge/server.mjs — same expression, since
// scripts/bridge-parity-smoke.mjs compares the two allowlists.
const connectorsEnabled = process.env.CLAUDE_REMOTE_MCP_CONNECTORS === "1"
  || (process.env.CLAUDE_REMOTE_WEB_SHELL === "1" && process.env.CLAUDE_REMOTE_MCP_CONNECTORS !== "0");
const coworkHostBashEnabled = process.env.CLAUDE_COWORK_HOST_BASH === "1";
// The Desktop main process collects Cowork's folder grant — the
// `mcp__cowork__request_cowork_directory` tool and the other folder flows
// behind the "Choose folder" cards — with an OS folder dialog. In this
// container that dialog renders on the headless display nobody is looking at,
// so the button appears to do nothing. When this is on, directory dialogs are
// routed to the browser's in-page picker instead (see "Remote folder picker"
// below). Default follows the web shell: on with it, off otherwise.
const remoteFolderPickerEnabled = process.env.CLAUDE_REMOTE_FOLDER_PICKER === "1"
  || (process.env.CLAUDE_REMOTE_WEB_SHELL === "1" && process.env.CLAUDE_REMOTE_FOLDER_PICKER !== "0");
// Before the Desktop main process lets a renderer read a file that is not in one
// of the session's own folders, it asks the person at the keyboard — a native
// "File Access Request" card. Previewing an agent memory file lands there (the
// memory lives under the Desktop's own userData, not in a folder the session was
// granted), and so does the memory editor opening CLAUDE.md. On this container's
// headless display nobody can answer that card, so the read never settles and
// the browser's IPC call for it hangs forever, with no error and no timeout.
// When this is on the wrapper answers the card itself, with Allow — the person
// at the far end of the bridge asked for that file by opening it, and Deny would
// only trade the hang for a failed preview. See "File access consent" below,
// which recognizes that one card and leaves every other dialog alone.
// `CLAUDE_REMOTE_FILE_CONSENT=0` restores the native card.
const fileAccessConsentEnabled = process.env.CLAUDE_REMOTE_FILE_CONSENT !== "0";
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
// Reported for the admin panel; the guest itself gets the count from the app
// preferences the container init writes.
const coworkVmCpuCount = boundedInteger(
  process.env.CLAUDE_COWORK_VM_CPU_COUNT,
  1,
  1,
  8,
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
// How long a routed folder dialog waits for the browser before it answers as a
// cancel, so an agent turn cannot hang forever when nobody is at a tab.
const remoteFolderPickTimeoutMs = boundedInteger(
  process.env.CLAUDE_REMOTE_FOLDER_PICK_TIMEOUT_MS,
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);
let coworkVmLastActivityAt = Date.now();

function noteCoworkVmActivity() {
  coworkVmLastActivityAt = Date.now();
}

// A routine's files belong to the Desktop, and it refuses to publish one that is
// hard-linked to another name: writing "through" the link would land on the
// link's other name rather than on the task, which is exactly how a sandboxed
// agent could redirect a privileged write. So the store stops with "Not written:
// this task's file is hard-linked to another file. Replace it with a plain
// copy." The refusal is right, but it strands the routine — every later edit
// fails, from every client, until somebody with shell access on that machine
// replaces the file by hand.
//
// Do what the refusal asks, from here, at the main process boundary: replace the
// linked file with a plain copy of the same bytes, at the same path. Nothing is
// ever written through the link, so the other name keeps its bytes, and the copy
// is the whole repair — the store's write then lands on it. It has to stay at
// that path rather than move aside: the store reads the file back to merge a
// prompt-only or description-only update. The channels below write task files,
// so a routine heals on the first edit any client attempts, and stays healed:
// the agent's own `update_scheduled_task` tool path (which never crosses an IPC)
// finds a plain file afterwards.
//
// The repair is deliberately forgiving about where the file is and which
// argument carries the task id, and it says what it did when the write still
// fails: a routine whose file lives under a root or a name this deployment does
// not expect has to be diagnosable from the failure the client sees, because the
// machine it is stuck on is one nobody logs into.
const routineTaskFileWriteChannel =
  /\_\$_(?:Cowork|CCD)ScheduledTasks_\$_(?:updateScheduledTask|updateScheduledTaskFileContent)$/;
const routineFileLinkSuffix = ".hardlinked";
const routineFileLinkRepairLimit = 64;
const routineTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The Cowork store keeps its routines in the "Scheduled" directory of the Cowork
// user-files root; the Code store keeps them in the Claude config directory. The
// Cowork root is the Desktop's own resolved setting (`coworkUserFilesPath`),
// persisted once it decides — but a config that has not been written yet, or a
// root the app fell back from, must not make the repair miss the file, so every
// root the Desktop's own resolver can answer with is tried.
function coworkUserFilesRoots() {
  const roots = [];
  try {
    const config = JSON.parse(
      readFileSync(join(app.getPath("userData"), "claude_desktop_config.json"), "utf8"),
    );
    const configured = config?.preferences?.coworkUserFilesPath;
    if (typeof configured === "string" && configured.startsWith("/")) roots.push(configured);
  } catch {}
  // The resolver's own answers, in its order: the home folder, the legacy
  // documents folder, and the userData fallback it uses when neither verifies.
  roots.push(join(app.getPath("home"), "Claude"));
  try {
    roots.push(join(app.getPath("documents"), "Claude"));
  } catch {}
  try {
    roots.push(join(app.getPath("userData"), "cowork-user-files"));
  } catch {}
  return roots;
}

function routineTaskRoots() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const roots = [join(configDir || join(app.getPath("home"), ".claude"), "scheduled-tasks")];
  for (const root of coworkUserFilesRoots()) roots.push(join(root, "Scheduled"));
  return [...new Set(roots)];
}

// Which task a write is about comes from the call's own arguments, whose shape
// is the official API's, not ours: the id is a field of the task object on the
// write channels, and every string argument is taken as a candidate too, so a
// caller that passes the id on its own is not silently given no repair.
function routineTaskIdsFromArgs(args) {
  const ids = [];
  for (const value of args) {
    if (value && typeof value === "object" && typeof value.scheduledTaskId === "string") {
      ids.push(value.scheduledTaskId);
    }
  }
  for (const value of args) {
    if (typeof value === "string") ids.push(value);
  }
  return [...new Set(ids)].filter((id) => routineTaskIdPattern.test(id));
}

// Replaces one linked file with a plain copy: the same bytes, in a fresh inode,
// published by `rename` so the task's path is never missing. Nothing is written
// through the link, so whatever other name the inode has keeps its own bytes.
//
// The copy has to stay *at* the path — not moved aside — because the store reads
// the file back to merge a prompt-only or description-only update, and a file
// that is not there fails that read (ENOENT) before any write happens. This is
// what the refusal's own sentence asks for: "Replace it with a plain copy."
async function plainCopyRoutineFile(path, info) {
  const content = await readFile(path);
  const temporary = `${path}${routineFileLinkSuffix}${Date.now()}`;
  await writeFile(temporary, content, { mode: info.mode & 0o777 });
  await rename(temporary, path);
  return content.length;
}

// Repairs every hard-linked file in one routine's directory, and answers with
// what it replaced. A link that is not there is not an error, and is not logged.
async function repairRoutineDirectory(taskDir) {
  const moved = [];
  let entries;
  try {
    entries = await readdir(taskDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
      console.warn(
        `[cowork-wrapper] could not inspect routine directory ${taskDir}: ${error?.message || error}`,
      );
    }
    return moved;
  }
  for (const entry of entries) {
    if (moved.length >= routineFileLinkRepairLimit) return moved;
    // `isFile()` is an lstat answer, so a symlink is neither followed nor moved:
    // the store's own symlink refusal is a different failure, and one this
    // repair must not paper over.
    if (!entry.isFile()) continue;
    // A temporary the repair was interrupted between writing and renaming.
    // It is a copy, not a routine file, and is not the store's to write.
    if (entry.name.includes(routineFileLinkSuffix)) continue;
    const path = join(taskDir, entry.name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.nlink <= 1) continue;
    let copied;
    try {
      copied = await plainCopyRoutineFile(path, info);
    } catch (error) {
      console.warn(
        `[cowork-wrapper] ${path} is hard-linked (nlink ${info.nlink}) and could not be replaced with a copy: ${error?.message || error}`,
      );
      continue;
    }
    moved.push(path);
    console.warn(
      `[cowork-wrapper] ${path} was hard-linked to another name`
      + ` (nlink ${info.nlink}, inode ${info.ino}); replaced it with a plain copy`
      + ` of the same ${copied} bytes so the Desktop can write it`,
    );
  }
  return moved;
}

async function repairLinkedRoutineFiles({ ids = [], sweep = false } = {}) {
  const moved = [];
  const roots = routineTaskRoots();
  for (const id of ids) {
    for (const root of roots) moved.push(...await repairRoutineDirectory(join(root, id)));
  }
  // The id can be missing from the arguments, or name the task differently from
  // the directory holding its file — the store's own refusal is then the only
  // thing that says a linked file exists. Sweeping is for that case, so it runs
  // on the retry alone, and only walks the routine directories themselves.
  if (!sweep) return moved;
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (moved.length >= routineFileLinkRepairLimit) return moved;
      if (!entry.isDirectory() || !routineTaskIdPattern.test(entry.name)) continue;
      moved.push(...await repairRoutineDirectory(join(root, entry.name)));
    }
  }
  return moved;
}

function isLinkedRoutineFileRefusal(error) {
  return /hard-linked to another file/.test(String(error?.message ?? error));
}

// The repairs above run at a write, which is enough for a routine the write
// names — but a file that a sandbox hard-linked before this deployment learned
// to repair stays linked forever, because every write is what the store refuses.
// Sweep once when the app comes up, so a stuck routine heals on a restart instead
// of waiting for an edit that cannot land. Same repair, same limits: only files
// carrying a second link, only inside a routine's own directory, and each is
// replaced by a copy at its own path rather than moved out of the way.
let routineFileLinkSweep = "pending";

async function sweepHardLinkedRoutineFiles() {
  try {
    const moved = await repairLinkedRoutineFiles({ sweep: true });
    routineFileLinkSweep = moved.length > 0 ? `repaired ${moved.length}` : "clean";
    if (moved.length > 0) {
      console.warn(
        `[cowork-wrapper] routine file sweep at startup: replaced ${moved.length} hard-linked file(s)`
        + " with plain copies so the store can write them",
      );
    }
  } catch (error) {
    routineFileLinkSweep = `failed: ${error?.message || error}`;
    console.warn(`[cowork-wrapper] routine file sweep failed: ${error?.message || error}`);
  }
  return routineFileLinkSweep;
}

// Desktop keeps the last good feature payload on disk and reads its gate from
// there whenever the network path does not answer (`kLt()` in the main bundle:
// a gzip blob with a magic header, holding `{timestamp, mode, orgUuid, features}`).
// The fetch rewrite above only covers the network; drop the gate here too, so the
// store's own repair is what runs however the map got filled.
const featureCacheMagic = Buffer.from([67, 76, 70, 2, 0, 154, 183, 226]);

async function dropRoutineFileLinkGateFromCache() {
  const path = join(app.getPath("userData"), "fcache");
  try {
    const raw = await readFile(path);
    if (raw.length <= featureCacheMagic.length
        || !raw.subarray(0, featureCacheMagic.length).equals(featureCacheMagic)) {
      return "absent";
    }
    const payload = JSON.parse(
      (await promisify(gunzip)(raw.subarray(featureCacheMagic.length))).toString("utf-8"),
    );
    if (!dropRoutineFileLinkGate(payload)) return "no gate";
    await writeFile(
      path,
      Buffer.concat([featureCacheMagic, await promisify(gzip)(Buffer.from(JSON.stringify(payload)))]),
    );
    console.info(
      `[cowork-wrapper] ${path}: dropped feature ${routineFileLinkGate}`
      + " so the store repairs a hard-linked routine file itself",
    );
    return "dropped";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    console.warn(`[cowork-wrapper] could not rewrite ${path}: ${error?.message || error}`);
    return "unreadable";
  }
}

// What the run in this process can say about the routine file repairs, for the
// bridge's own report (`/health`): the app container owns these writes — the web
// shell's container mounts /config read-only — so a refusal that survives there
// needs to say whether this layer is even present.
function routineFileLinkRepairState() {
  return {
    gate: routineFileLinkGate,
    repair: true,
    sweep: routineFileLinkSweep,
  };
}

// What the repair saw, appended to a refusal it could not clear. The client that
// hits this shows the message, so the machine that is stuck can be diagnosed
// from a browser: the id the call carried, the directories that were searched,
// and whether any linked file was found anywhere under them.
function routineRepairNote(ids, moved) {
  return ` [cowork-wrapper: task id ${ids.length ? ids.map((id) => `"${id}"`).join(", ") : "not in the call"}; `
    + `${moved.length ? `moved ${moved.length} hard-linked file(s): ${moved.join(", ")}` : "found no hard-linked routine file"}; `
    + `searched ${routineTaskRoots().join(", ")}]`;
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
  if (routineTaskFileWriteChannel.test(channel)) {
    return originalIpcMainHandle(channel, async (event, ...args) => {
      const ids = routineTaskIdsFromArgs(args);
      const repaired = await repairLinkedRoutineFiles({ ids });
      try {
        return await listener(event, ...args);
      } catch (error) {
        // The file can also turn up linked between the repair and the write, and
        // a link the repair did not see (a root we did not guess, a file the
        // store creates in place) fails here rather than above. One repair and
        // one retry, then let the refusal stand — with what the repair saw.
        if (!isLinkedRoutineFileRefusal(error)) throw error;
        const swept = await repairLinkedRoutineFiles({ ids, sweep: true });
        try {
          return await listener(event, ...args);
        } catch (retryError) {
          if (!isLinkedRoutineFileRefusal(retryError)) throw retryError;
          const seen = [...repaired, ...swept];
          throw new Error(`${String(retryError?.message ?? retryError)}${routineRepairNote(ids, seen)}`);
        }
      }
    });
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

// Desktop registers its renderer surfaces on each window's own IPC endpoint
// (`webContents.ipc.handle`), not on the global `ipcMain`, so the override above
// never sees them. Watch for new WebContents and wrap the staging channel as it
// is registered.
//
// A Code session that runs on the guest runner has no reachable session host:
// the app is in three-party (gateway) mode and no `selfHostedUrl` is configured
// (configuring one would displace the inference provider), so Desktop's handler
// answers every path with `disabled` and the composer reports "Couldn't attach
// {name} to this session on your organization's session host. Try again."
// The files are already in this container, though, and the guest sees the same
// workspace at /workspace, so stage them there ourselves — see
// session-attachments.cjs. Only Desktop's all-disabled answer is replaced; a
// deployment whose handler stages through a real session host is untouched.
app.on("web-contents-created", (_event, contents) => {
  try {
    sessionAttachments.wrapStagingIpc(contents?.ipc, {
      enabled: codeSurfaceEnabled,
      pendingUploadsRoot: join(app.getPath("userData"), "pending-uploads"),
    });
  } catch (error) {
    console.warn(
      "[cowork-wrapper] could not wrap this window's attachment staging:",
      error?.message || error,
    );
  }
  try {
    // The install-authorization Extensions handlers run with the 3P policy
    // override in place, whether the caller is the Desktop window or the
    // browser relayed through the internal endpoint (see extensions.cjs).
    extensionPolicy.wrapIpc(contents?.ipc);
  } catch (error) {
    console.warn(
      "[cowork-wrapper] could not wrap this window's extension IPC:",
      error?.message || error,
    );
  }
});

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
    "getSessionsForScheduledTask",
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
    // Composer attachments for a session on another host are staged by
    // Desktop; the renderer only asks whether this method exists. See the same
    // entry in bridge/server.mjs.
    "stageRemoteSessionAttachmentsViaFilesApi",
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
  // Cowork scheduled tasks are the account's own and stay unconditional (see the
  // bridge's copy): the renderer gates its "New task" button and its delete on
  // these methods' presence, so withholding them only breaks the UI.
  ["CoworkScheduledTasks", new Set([
    "ackEvent",
    "createScheduledTask",
    "getAllScheduledTasks",
    "getScheduledTaskFileContent",
    "getWatcherHistory",
    "markListenerReady",
    "releaseDispatchClaim",
    "setEventAckSupported",
    "setHostRunsSupported",
    "updateScheduledTask",
    "updateScheduledTaskFileContent",
    "updateScheduledTaskStatus",
  ])],
  // The Code store (`~/.claude/scheduled-tasks`), where routines live. It has
  // no delete method: a deleted status with the file removed is its delete.
  ["CCDScheduledTasks", new Set([
    "ackEvent",
    "createScheduledTask",
    "getAllScheduledTasks",
    "getScheduledTaskFileContent",
    "getWatcherHistory",
    "markListenerReady",
    "releaseDispatchClaim",
    "removeApprovedPermission",
    "setEventAckSupported",
    "setHostRunsSupported",
    "updateScheduledTask",
    "updateScheduledTaskStatus",
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
    "browseCodeFolder",
    "browseFiles",
    "browseFolder",
    "browseFolders",
    "getLocalFileThumbnail",
    "getSystemPath",
    "listDirectory",
    "listFilesInFolder",
    "openLocalFile",
    "readLocalFile",
    // The composer's attachment materialization, needed by every account (the
    // bridge's base FileSystem allowlist documents why); it takes bytes, not a
    // path.
    "savePastedFile",
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
    "writeLocalFile",
  ]) allowedMethods.get("FileSystem").add(method);
}

if (developerActionsEnabled) {
  for (const method of [
    "deleteLocalSkill",
    "getLocalSkillFiles",
    "listLocalSkills",
    "saveLocalSkill",
    "setLocalSkillEnabled",
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

if (connectorsEnabled) {
  for (const method of [
    "authorizeDirectMcpServer",
    "directMcpCallTool",
    "directMcpListResources",
    "directMcpReadResource",
    "disconnectDirectMcpServer",
    "getDirectMcpServerStatuses",
    "getLocalMcpServers",
    "mcpAuthenticate",
    "mcpReconnect",
    "mcpSubmitOAuthCallbackUrl",
    "replaceEnabledMcpTools",
    "replaceRemoteMcpServers",
    "setMcpServers",
  ]) {
    allowedMethods.get("LocalAgentModeSessions").add(method);
  }
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

// Desktop extensions (MCPB bundles) are not a Gateway-settings feature, so the
// surface is exposed even when the writable 3P configuration library is off.
// `showInstallDxtDialog` is deliberately absent: the browser preload publishes
// its own file picker under that name instead of opening the native dialog,
// which nobody can reach here. `isLocalExtensionInstallAllowed` is likewise
// answered by the preload (installs are supported through the browser), and
// the main process would refuse without the policy override in extensions.cjs.
const extensionSettingsMethods = new Set([
  "deleteExtension",
  "getAvailableExtensionRuntimes",
  "getExtensionSettings",
  "getInstalledExtensionsWithState",
  "getIsUpdateAvailable",
  "getManifestCompatibilityResult",
  "handleDxtFile",
  "installExtensionFromPreview",
  "isDesktopExtensionDirectoryEnabled",
  "isDesktopExtensionSignatureRequired",
  "isDirectoryEnabled",
  "isExtensionsEnabled",
  "refreshAllowlistCheck",
  "setExtensionSettings",
]);
allowedSettingsMethods.set("Extensions", extensionSettingsMethods);
// Read-only MCP configuration for the local-connector attach path (see
// "Local MCP servers → browser"). The renderer uses it to skip servers the
// account never configured, such as the internal `mcp-registry`.
allowedSettingsMethods.set("MCP", new Set(["getMcpServersConfig"]));

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
  ["CCDScheduledTasks", new Set(["onOnScheduledTaskEvent"])],
  ["CoworkSpaces", new Set(["onOnSpaceEvent"])],
  ["DocumentFunnel", new Set(["onWorkingDocumentsChanged"])],
  // Desktop extensions live on `claude.settings`, not `claude.web`; the relay
  // resolves each surface's own root (see ensureRelayedEventsRegistered). The
  // browser's Extensions page drives installs through these events.
  ["Extensions", new Set([
    "onExtensionDownloadProgress",
    "onExtensionSettingsChanged",
    "onExtensionsChanged",
    "onPreviewExtensionInstallation",
  ])],
  // The browser's local MCP clients (claude.settings extensions and the
  // claude.ai chat's local connectors) speak JSON-RPC to a server this
  // renderer owns. Responses and notifications are relayed as ordinary
  // desktop-ipc events; the remote preload feeds them to a MessagePort shim.
  ["McpBridge", new Set(["mcpMessage"])],
  // Not a `claude.web` surface: the wrapper itself publishes the notifications
  // the official Desktop decides to show, for the remote preload to render in
  // the browser (see the notification relay section below).
  ["DesktopNotifications", new Set(["onNotification", "onNotificationClosed"])],
  // Also wrapper-published: a directory dialog the official main process opened
  // (Cowork's folder grant), for the remote preload to answer with the in-page
  // picker (see the remote folder picker section below).
  ["RemoteFolderPicker", new Set(["onRequest"])],
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
  relayedListeners.set("CustomPlugins", new Set(["onInstallProgress"]));
  relayedListeners.set("LocalPlugins", new Set(["onOnCliOpAlwaysAllowed"]));
}

if (connectorsEnabled) {
  relayedListeners.get("LocalAgentModeSessions").add(
    "onOnDirectMcpServerStatusesChanged",
  );
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
  // Title generation and the branch preview. The browser's own fetches never
  // reach the app:// protocol handler, so the bridge relays them here; both
  // are read-only model requests that answer a title (and, for the second, the
  // branch name) the app applies to the session it is about to create.
  { methods: new Set(["POST"]), path: /^\/api\/organizations\/[0-9a-f-]+\/dust\/(?:generate_title_and_branch|generate_session_title)$/i },
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

// Inline session-file reads arrive from Desktop with the whole file in the
// value, and the outer bridge then holds the decoded string, its JSON and the
// HTTP response together. Refuse past this bound before serializing, so one
// large file cannot OOM the bridge; its streaming download route serves large
// files without buffering them.
const sessionFileInlineMaxBytes = Number(
  process.env.COWORK_SESSION_FILE_MAX_BYTES || 16 * 1024 * 1024,
);

function sessionFileValueSize(value) {
  const file = value?.file && typeof value.file === "object" ? value.file : value;
  const size = Number(file?.fileSize);
  if (Number.isFinite(size) && size >= 0) return size;
  return typeof file?.contents === "string" ? Buffer.byteLength(file.contents, "utf8") : 0;
}

function capSessionFileValue(surface, method, value) {
  if (surface !== "LocalSessions") return value;
  if (method === "readSessionFile" || method === "readFileAtCwd") {
    return sessionFileValueSize(value) > sessionFileInlineMaxBytes ? null : value;
  }
  if (method === "readSessionFileWithStatus"
    && value?.status === "ok" && value.file
    && sessionFileValueSize(value.file) > sessionFileInlineMaxBytes) {
    return { status: "tooLarge" };
  }
  return value;
}

function validateInvocation(surface, method, args) {
  if (!allowedSurfaces.has(surface)) throw new Error("Cowork surface is not allowed");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new Error("invalid method name");
  if (!allowedMethods.get(surface)?.has(method)) {
    throw new Error("Cowork IPC method is not allowed");
  }
  if (!Array.isArray(args)) throw new Error("args must be an array");
}

// Extension ids are minted by the official installer from the manifest name
// (`local.mcpb.<slug>` / `local.dxt.<slug>`). Bundles relayed from the browser
// are copied into the shared workspace first, so only that tree is accepted as
// an install/preview source; a path elsewhere in the container is not.
// `local.mcpb.<author>.<name>`; long manifest fields can exceed 128 characters.
const extensionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const extensionBundlePathPattern = /\.(?:dxt|mcpb)$/i;

function isExtensionBundlePath(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  if (!extensionBundlePathPattern.test(value) || !value.startsWith("/workspace/")) {
    return false;
  }
  return !value.split("/").includes("..");
}

function validateExtensionInvocation(method, args) {
  const id = index => typeof args[index] === "string"
    && extensionIdPattern.test(args[index]);
  switch (method) {
    case "getInstalledExtensionsWithState":
    case "getAvailableExtensionRuntimes":
    case "isDesktopExtensionDirectoryEnabled":
    case "isDesktopExtensionSignatureRequired":
    case "isDirectoryEnabled":
    case "isExtensionsEnabled":
    case "refreshAllowlistCheck":
      if (args.length !== 0) throw new Error("Extension method does not accept arguments");
      return;
    case "getIsUpdateAvailable":
      if (args.length !== 2
        || !id(0)
        || typeof args[1] !== "string" || args[1].length > 128) {
        throw new Error("Extension update check is not allowed");
      }
      return;
    case "getManifestCompatibilityResult":
      if (args.length !== 1 || !args[0] || typeof args[0] !== "object"
        || Array.isArray(args[0]) || !isBoundedJsonValue(args[0])) {
        throw new Error("Extension manifest check is not allowed");
      }
      return;
    case "getExtensionSettings":
    case "deleteExtension":
      if (args.length !== 1 || !id(0)) throw new Error("Extension id is not allowed");
      return;
    case "setExtensionSettings":
      if (args.length !== 2 || !id(0) || !args[1] || typeof args[1] !== "object"
        || Array.isArray(args[1]) || !isBoundedJsonValue(args[1])) {
        throw new Error("Extension settings update is not allowed");
      }
      return;
    case "handleDxtFile":
      if (args.length !== 1 || !isExtensionBundlePath(args[0])) {
        throw new Error("Extension bundle path is not allowed");
      }
      return;
    case "installExtensionFromPreview":
      if (args.length !== 2 || !id(0) || !isExtensionBundlePath(args[1])) {
        throw new Error("Extension install is not allowed");
      }
      return;
    default:
      throw new Error("Extension method is not allowed");
  }
}

function validateSettingsInvocation(surface, method, args) {
  if (!gatewaySettingsEnabled && surface !== "Extensions" && surface !== "MCP") {
    throw new Error("Remote Gateway settings are disabled");
  }
  if (!allowedSettingsMethods.get(surface)?.has(method)) {
    throw new Error("Gateway settings method is not allowed");
  }
  if (!Array.isArray(args)) throw new Error("args must be an array");
  if (surface === "Extensions") {
    validateExtensionInvocation(method, args);
    return;
  }
  if (surface === "AppPreferences") {
    if (!codeActionsEnabled && !codeSurfaceEnabled) throw new Error("Code settings are disabled");
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

// ---------------------------------------------------------------------------
// Local MCP servers → browser
//
// The official Linux renderer attaches the account's local MCP servers (the
// Desktop extensions, and user-configured local connectors) itself, over a
// MessagePort handed to it by the main process's `connect-to-mcp-server` IPC.
// A browser cannot receive that port, so the claude.ai chat surface's attach
// hook (`claudeAppBindings.listMcpServers` / `connectToMcpServer`) silently
// does nothing there: an installed extension previews and installs but its
// tools never appear, and its settings page reports "Unable to connect to
// extension server".
//
// This bridge installs a small proxy in the official renderer: it calls the
// real bindings, keeps the port, and multiplexes browser JSON-RPC clients onto
// it. Each browser connection gets a disjoint id range (the app's own client
// uses small ids) and a local answer to `initialize`, because only one
// initialize may reach the server. Server responses carrying a browser id are
// routed back to that connection; notifications go to every connection; the
// app's own traffic passes through untouched.
const mcpBridgeGlobal = extensions.mcpBridgeGlobal;
const mcpConnectionIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const mcpMessageMaxBytes = 6 * 1024 * 1024;

function mcpBridgeInstallExpression() {
  return extensions.mcpBridgeInstallExpression({
    consolePrefix: relayConsolePrefix,
    maxBytes: mcpMessageMaxBytes,
  });
}

async function callMcpBridge(method, args) {
  const installed = await evaluateInOfficialRenderer(mcpBridgeInstallExpression());
  if (installed !== "__COWORK_BRIDGE_MCP_READY__") {
    throw new Error("the Desktop renderer does not expose local MCP bindings");
  }
  const request = Buffer.from(JSON.stringify({ method, args })).toString("base64");
  const expression = `(async () => {
    const bridge = globalThis[${JSON.stringify(mcpBridgeGlobal)}];
    if (!bridge) return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(${JSON.stringify(request)}), (character) => character.charCodeAt(0)),
    ));
    return await bridge[request.method](...request.args);
  })()`;
  const value = await evaluateInOfficialRenderer(expression);
  if (value === "__COWORK_BRIDGE_NOT_AVAILABLE__") {
    throw new Error("the Desktop renderer does not expose local MCP bindings");
  }
  return value;
}

function isMcpMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= mcpMessageMaxBytes;
  } catch {
    return false;
  }
}

let coworkVmIdleState = {
  checkedAt: null,
  idleSince: null,
  pid: null,
  reason: "monitor-starting",
};
let coworkVmShutdownInProgress = false;
// An admin's Restart is mid-flight: the idle monitor must not race it.
let coworkVmRestartInProgress = false;

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

// Code sessions run on the guest runner, not in `LocalAgentModeSessions`, so
// the Cowork-session check below cannot see a turn that is answering right
// now. Ask the bridge — it shares this container's network namespace — for its
// runner/session counts. This process has no browser session, and a tenant's
// bridge gate is always on, so the counts are part of its unauthenticated
// liveness answer (see `/api/health` in bridge/server.mjs): they are what keeps
// the guest up under a long turn instead of the ACPI powerdown below cutting it
// off. A bridge that cannot answer leaves the existing renderer-based decision
// in place (fail open) rather than pinning every VM on.
const codeActivityUrl = `http://127.0.0.1:${process.env.COWORK_BRIDGE_PORT || 8080}/api/health`;
async function codeSessionActivity() {
  try {
    const response = await fetch(codeActivityUrl, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json();
    const runner = body?.codeRunner;
    if (!runner || typeof runner !== "object") return null;
    const active = Number(runner.active_sessions) || 0;
    const offered = Number(runner.offered_sessions) || 0;
    // A pending session is a message waiting for the VM to come up — the
    // bridge's own description of the field. Leaving it out let the idle
    // monitor power the guest down underneath a session that had just been
    // placed (a routine fire, an API fire) and was about to be picked up.
    const pending = Number(runner.pending_sessions) || 0;
    return { active, offered, pending };
  } catch {
    return null;
  }
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

// The guest RAM qemu was launched with, for the admin panel's status line.
function qemuMemoryMb(args) {
  const index = Array.isArray(args) ? args.indexOf("-m") : -1;
  const raw = index >= 0 ? String(args[index + 1] || "") : "";
  const match = /^(\d+)([MmGg]?)$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "g" ? value * 1024 : value;
}

async function coworkVmStatus() {
  const vm = await findCoworkVmProcess();
  return {
    running: Boolean(vm),
    pid: vm?.pid ?? null,
    reason: coworkVmIdleState.reason ?? null,
    memory_mb: vm ? qemuMemoryMb(vm.args) : null,
    policy: { memory_gb: coworkVmMemoryGB, cpu_count: coworkVmCpuCount },
    monitor: coworkVmIdleState,
    host_bash: coworkHostBashEnabled,
  };
}

/**
 * Restart the Cowork VM: an ACPI powerdown of the running guest (the same
 * graceful stop the idle monitor uses), a bounded wait for qemu to exit, then
 * the Desktop's own `startVM`. A restart rather than a QMP reset so it also
 * recovers a wedged VM, and so a container recreated with new VM env boots the
 * new sizing. Refusals are thrown, never swallowed.
 */
async function restartCoworkVm() {
  if (coworkHostBashEnabled) throw new Error("host-bash mode has no Cowork VM");
  if (coworkVmRestartInProgress) throw new Error("a VM restart is already in progress");
  coworkVmRestartInProgress = true;
  try {
    const running = await findCoworkVmProcess();
    if (running) {
      if (!running.qmpSocket) throw new Error("the Cowork VM has no QMP socket");
      await qmpSystemPowerdown(running.qmpSocket);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (!(await findCoworkVmProcess())) break;
        await wait(250);
      }
      if (await findCoworkVmProcess()) {
        throw new Error("the Cowork VM did not stop within 30s");
      }
    }
    await invoke("ClaudeVM", "startVM", []);
    return { started: true, was_running: Boolean(running) };
  } finally {
    coworkVmRestartInProgress = false;
  }
}

async function coworkVmIdleCheck() {
  if (coworkVmShutdownInProgress || coworkVmRestartInProgress) return;
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
    let workState = classifyCoworkVmWorkState(await readCoworkVmWorkState(), now);
    if (workState.safeToStop) {
      const code = await codeSessionActivity();
      if (code && (code.active > 0 || code.offered > 0 || code.pending > 0)) {
        workState = { safeToStop: false, reason: "code-session-running" };
      }
    }
    if (!workState.safeToStop) {
      coworkVmIdleState = {
        checkedAt: now,
        idleSince: null,
        pid: vm.pid,
        reason: workState.reason,
      };
      return;
    }
    // Activity after the last idle check (a startVM call, a session start, a
    // routed folder dialog) restarts the count. Keeping the older idleSince
    // ignored `noteCoworkVmActivity` for a VM that was already idle-eligible
    // and powered it down in the same tick as the wake that needed it.
    const idleSince = priorPid === vm.pid && coworkVmIdleState.idleSince
      ? Math.max(coworkVmIdleState.idleSince, coworkVmLastActivityAt)
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
    let confirmed = classifyCoworkVmWorkState(await readCoworkVmWorkState(), Date.now());
    if (confirmed.safeToStop) {
      const code = await codeSessionActivity();
      if (code && (code.active > 0 || code.offered > 0 || code.pending > 0)) {
        confirmed = { safeToStop: false, reason: "code-session-running" };
      }
    }
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
  let serialized;
  const answerDialogs = surface === "Extensions"
    && extensions.extensionDialogMethods.has(method);
  let capturedDialogs = null;
  if (surface === "Extensions" || surface === "MCP") {
    // Extensions and MCP live on the official app's own renderer, not the
    // Gateway setup window (the surfaces exist whether or not the writable 3P
    // configuration library is enabled). The install and preview calls can open
    // a native dialog; a browser cannot answer it, so answer it for the duration
    // of this relayed call.
    if (!answerDialogs) {
      serialized = await evaluateInOfficialRenderer(expression);
    } else {
      capturedDialogs = [];
      relayedExtensionDialogStack.push(capturedDialogs);
      relayedExtensionDialogs += 1;
      try {
        serialized = await evaluateInOfficialRenderer(expression);
      } finally {
        relayedExtensionDialogs -= 1;
        relayedExtensionDialogStack.pop();
      }
    }
  } else {
    const contents = await gatewaySettingsRenderer();
    serialized = await contents.executeJavaScript(expression, true);
    if (serialized === "__COWORK_BRIDGE_NOT_AVAILABLE__") {
      throw new Error("Gateway settings IPC is unavailable in the official setup window");
    }
  }
  const result = JSON.parse(serialized);
  if (!result.ok) throw new Error(result.error || "Gateway settings IPC call failed");
  if (answerDialogs) {
    // A one-button dialog is the install path's error/notice box (the install
    // confirmation has Install and Cancel). The Desktop reports the reason there
    // and then resolves null, so surface that reason to the browser.
    const failure = capturedDialogs.find(dialog => dialog.buttons <= 1);
    if (failure) {
      throw new Error(failure.detail || failure.message || failure.title
        || "The desktop extension operation failed");
    }
    if (method === "installExtensionFromPreview" && result.value == null) {
      throw new Error("The extension was not installed; the Desktop returned no extension id");
    }
  }
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
    const settingsRoot = globalThis["claude.settings"];
    if (typeof root?.LocalAgentModeSessions?.onOnEvent !== "function") return "__COWORK_BRIDGE_NOT_AVAILABLE__";
    const relayKey = "__CLAUDE_REMOTE_EVENT_RELAY_V2__";
    if (!globalThis[relayKey]) {
      const relay = { unsubscribers: [] };
      const listeners = ${JSON.stringify(listeners)};
      const consolePrefix = ${JSON.stringify(relayConsolePrefix)};
      for (const [surface, methods] of Object.entries(listeners)) {
        for (const method of methods) {
          // Extensions (and any other settings surface) are published on
          // claude.settings; everything else is claude.web.
          const subscribe = (root[surface] ?? settingsRoot?.[surface])?.[method];
          if (typeof subscribe !== "function") continue;
          try {
            // Desktop's preload adapters are not uniform: some events carry one
            // payload, others forward several positional arguments (the
            // extension preview is manifest/path/id/signature; settings
            // changes are id/settings). Keep the full argument list so the
            // browser callback receives the same shape.
            const unsubscribe = subscribe((...args) => {
              let values;
              try {
                values = JSON.parse(JSON.stringify(args, (_key, item) =>
                  typeof item === "bigint" ? item.toString() : item
                ));
              } catch {
                values = [{ type: "unserializable-event" }];
              }
              console.debug(consolePrefix + JSON.stringify({
                surface,
                method,
                payload: values[0],
                ...(values.length > 1 ? { args: values } : {}),
              }));
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

// The app's own entry document is the one asset no renderer patch can reach —
// it is static HTML, not a module — and on claude.ai its *server* fills in the
// two attributes the first paint reads: the composer arm on the static skeleton,
// and the page-layout variant on <html>. The Desktop package ships that document
// with neither, so the skeleton that paints before hydration is always the
// classic one — including the greeting the skeleton keeps visible, whose size is
// the `html[data-new-page-layout=home]` CSS variable. In web-shell mode this
// deployment has already chosen both (the bridge grants the composer feature and
// the renderer patches turn the layout on), so the same two attributes are
// filled in here, for the document the app's own window loads. Only index.html,
// only web-shell mode, and only when the markup is there to annotate: a document
// that no longer carries it is served unchanged rather than refused.
function annotateShellDocument(safePath, body) {
  if (safePath !== "index.html" || process.env.CLAUDE_REMOTE_WEB_SHELL !== "1") return body;
  const source = body.toString("utf8");
  if (source.includes("data-new-page-layout=") || !source.includes("<html ")) return body;
  if (!source.includes('<div id="static-composer"')) return body;
  return Buffer.from(source
    .replace("<html ", () => '<html data-new-page-layout="home" ')
    .replace('<div id="static-composer"', () => '<div id="static-composer" data-composer-arm="marlin"'),
  "utf8");
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
  //
  // The browser's graph lives under root-relative `/assets/…` URLs (the Vite
  // preload helper resolves lazy dependencies that way), which the bridge
  // forwards here as `/ion/assets/…`. A path in the prepared generation is
  // served from the overlay for those requests too, so the account's patched
  // chunks and their unpatched neighbours share one URL namespace — and the
  // owner generation the login matcher would have served is never part of it.
  const listed = rendererManifest.files.some(file => file.path === safePath);
  const patched = listed && (prepared || pathname.startsWith("/ion/"));
  const filePath = patched
    ? overlayPath
    : resolve(ION_ROOT, safePath);
  if (filePath !== ION_ROOT && !filePath.startsWith(`${ION_ROOT}/`)) {
    if (!patched || !filePath.startsWith(`${RENDERER_STATE_ROOT}/`)) {
      throw new Error("not found");
    }
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("not found");
  const body = annotateShellDocument(safePath, await readFile(filePath));
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

// ---------------------------------------------------------------------------
// Remote folder picker
//
// The official main process collects the folder for Cowork's "Choose folder"
// cards — `mcp__cowork__request_cowork_directory`, and the folder-grant flows
// behind `pickAndValidateMountFolder` — with
// `electron.dialog.showOpenDialog({ properties: ["openDirectory", ...] })`.
// This container has no display a person is watching, so that native dialog
// never appears and the card's button looks dead. When the picker is enabled a
// directory dialog is handed to the browser's in-page picker instead: the
// request is relayed over the event queue (the preload opens
// `__CLAUDE_PICK_SERVER_FOLDERS__`), and the browser posts its answer back to
// `/folder-pick`, which resolves the pending dialog promise with the native
// result shape (`{ canceled, filePaths }`). The picked path is still passed
// through the official validation — a real, permitted directory — so the
// normal mount runs. A dialog nobody answers answers as a cancel after
// `remoteFolderPickTimeoutMs`, so an agent turn cannot hang forever.
// ---------------------------------------------------------------------------

const folderPickRelay = {
  pending: new Map(),
  sequence: 0,
  served: 0,
  canceled: 0,
  timeouts: 0,
};

function settleRemoteFolderPick(id, value) {
  const pending = folderPickRelay.pending.get(id);
  if (!pending) return;
  folderPickRelay.pending.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(value);
}

function requestRemoteFolderPick(options) {
  const id = `folder-pick-${++folderPickRelay.sequence}-${randomBytes(8).toString("hex")}`;
  const properties = Array.isArray(options.properties) ? options.properties : [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (folderPickRelay.pending.delete(id)) {
        folderPickRelay.timeouts += 1;
        resolve({ canceled: true, filePaths: [] });
      }
    }, remoteFolderPickTimeoutMs);
    timer.unref?.();
    folderPickRelay.pending.set(id, { resolve, timer });
    enqueueRelayedEvent({
      surface: "RemoteFolderPicker",
      method: "onRequest",
      payload: {
        id,
        title: typeof options.title === "string" ? options.title.slice(0, 200) : "",
        message: typeof options.message === "string" ? options.message.slice(0, 500) : "",
        defaultPath: typeof options.defaultPath === "string" && options.defaultPath.length <= 4096
          ? options.defaultPath
          : null,
        multiple: properties.includes("multiSelections"),
        // Electron's `createDirectory` describes the macOS open panel
        // (`canCreateDirectories`) and default-true there; the GTK and Win32
        // choosers this picker replaces always offer making a folder, whatever
        // the caller asked for. So the property is not what decides it on those
        // hosts — a flow that only asks for `openDirectory` still gets the
        // native "create folder" affordance, and the picker has to match it.
        allowCreate: properties.includes("createDirectory") || process.platform !== "darwin",
        at: Date.now(),
      },
    });
  });
}

function resolveRemoteFolderPick(body) {
  const id = typeof body?.id === "string" ? body.id.slice(0, 200) : "";
  if (!id || !folderPickRelay.pending.has(id)) return { handled: false, stale: true };
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((path) => typeof path === "string" && path).slice(0, 64)
    : [];
  if (body?.canceled === true || paths.length === 0) {
    folderPickRelay.canceled += 1;
    settleRemoteFolderPick(id, { canceled: true, filePaths: [] });
  } else {
    folderPickRelay.served += 1;
    settleRemoteFolderPick(id, { canceled: false, filePaths: paths });
  }
  return { handled: true };
}

if (remoteFolderPickerEnabled) {
  const electronDialog = require("electron").dialog;
  if (electronDialog && typeof electronDialog.showOpenDialog === "function") {
    const originalShowOpenDialog = electronDialog.showOpenDialog.bind(electronDialog);
    // The dialog is called both as showOpenDialog(options) and
    // showOpenDialog(window, options); only the options carry `properties`.
    electronDialog.showOpenDialog = function routedShowOpenDialog(...args) {
      try {
        const first = args[0];
        const options = args.length > 1 && first && typeof first === "object"
          && typeof first.isDestroyed === "function"
          ? args[1]
          : first;
        if (options && typeof options === "object"
          && Array.isArray(options.properties)
          && options.properties.includes("openDirectory")) {
          return requestRemoteFolderPick(options);
        }
      } catch {}
      return originalShowOpenDialog(...args);
    };
  }
}

// ---------------------------------------------------------------------------
// File access consent
//
// The official file reader (`checkFileAccessConsent`, in the main process) puts
// a native question in front of every read that the session's own folders do not
// already cover — its outputs directory, the folders it was granted, or a path
// the person approved earlier:
//
//   dialog.showMessageBox(window, { title: "File Access Request",
//     message: "Allow Claude to preview this file?", detail: "<path>\n\n…" })
//
// The file pane previewing an agent memory file always lands there (the memory
// lives under the Desktop's own userData, which no session is granted), as does
// the memory editor opening CLAUDE.md. This container has no display a person is
// watching, so the card is never answered: `showMessageBox` never resolves, the
// reader's promise behind it never settles, and the browser's IPC request hangs
// for good — no error, no timeout, and a pane stuck on its spinner.
//
// The wrapper answers the card itself. Allow is the only answer that gets the
// person the file they asked for; Deny would replace the hang with "Unable to
// read file". The card is recognized by its own two literals *and* by its shape:
// two buttons, with the allow index read back from `cancelId`, because
// `checkFileAccessConsent` builds the list as ["Cancel","Allow"] and hands
// Electron only the cancel index. A message box that is not this card — or one
// whose shape this build does not match — still opens for real rather than being
// answered blind.
// ---------------------------------------------------------------------------

// Upstream's copy for the card. A localized build would change the message, so
// the title alone already identifies the card; the message is read only for the
// action word and the first line of `detail` is the path the log reports.
const fileAccessCardMessage = /^Allow Claude to (preview|open) this file\?$/;

// Reported by /runtime, so a deployment can see the interception is live (and
// that it is on) without grepping the Desktop log for the answer lines.
const fileAccessConsentState = { answered: 0 };

function fileAccessCardAnswer(options) {
  if (!options || typeof options !== "object") return undefined;
  const message = typeof options.message === "string" ? options.message : "";
  const match = fileAccessCardMessage.exec(message);
  if (!match && options.title !== "File Access Request") return undefined;
  const buttons = Array.isArray(options.buttons) ? options.buttons : [];
  if (buttons.length !== 2) return undefined;
  const cancelIndex = Number.isInteger(options.cancelId)
    ? options.cancelId
    : Number.isInteger(options.defaultId) ? options.defaultId : undefined;
  // The caller computes both indices together (`cancelIndex: +!!defaultAllow,
  // allowIndex: +!defaultAllow`), so with two buttons the allow index is the
  // other one.
  if (cancelIndex !== 0 && cancelIndex !== 1) return undefined;
  return {
    action: match ? match[1] : "preview",
    path: typeof options.detail === "string" ? options.detail.split("\n")[0].slice(0, 512) : "",
    response: cancelIndex === 0 ? 1 : 0,
  };
}

if (fileAccessConsentEnabled) {
  const electronDialog = require("electron").dialog;
  if (electronDialog && typeof electronDialog.showMessageBox === "function") {
    const originalShowMessageBox = electronDialog.showMessageBox.bind(electronDialog);
    // Like showOpenDialog above, this is called both as showMessageBox(options)
    // and showMessageBox(window, options); only the options carry the card.
    electronDialog.showMessageBox = function answeredShowMessageBox(...args) {
      try {
        const first = args[0];
        const options = args.length > 1 && first && typeof first === "object"
          && typeof first.isDestroyed === "function"
          ? args[1]
          : first;
        const answer = fileAccessCardAnswer(options);
        if (answer) {
          fileAccessConsentState.answered += 1;
          console.info(
            `[cowork-wrapper] answered File Access Request "${answer.action}" for ${answer.path}`,
          );
          // Electron's own result shape; the caller maps `response` back through
          // its button indices and records the approval for this path.
          return Promise.resolve({ response: answer.response, checkboxChecked: false });
        }
      } catch {}
      return originalShowMessageBox(...args);
    };
  }
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
        routineFileLinkRepair: routineFileLinkRepairState(),
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
          fileAccessConsent: {
            answered: fileAccessConsentState.answered,
            enabled: fileAccessConsentEnabled,
          },
          notifications: {
            clicks: notificationRelay.clicks,
            discovery: notificationRelay.discovery,
            pending: notificationRelay.pending.length,
            shown: notificationRelay.shown,
          },
          folderPicker: {
            canceled: folderPickRelay.canceled,
            enabled: remoteFolderPickerEnabled,
            pending: folderPickRelay.pending.size,
            served: folderPickRelay.served,
            timeouts: folderPickRelay.timeouts,
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
    // Local MCP servers for the browser (see "Local MCP servers → browser").
    if (request.method === "GET" && url.pathname === "/mcp-list") {
      sendJson(response, 200, { ok: true, value: await callMcpBridge("list", []) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp-connect") {
      const body = await readJson(request);
      if (!mcpConnectionIdPattern.test(body.connectionId || "")) {
        throw new Error("invalid MCP connection id");
      }
      if (typeof body.serverName !== "string" || !body.serverName
        || body.serverName.length > 512) {
        throw new Error("invalid MCP server name");
      }
      try {
        sendJson(response, 200, {
          ok: true,
          value: await callMcpBridge("connect", [body.connectionId, body.serverName]),
        });
      } catch (error) {
        console.error(`[mcp] connect ${body.serverName} failed: ${
          error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp-send") {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (!mcpConnectionIdPattern.test(body.connectionId || "") || !isMcpMessage(body.message)) {
        throw new Error("invalid MCP message");
      }
      sendJson(response, 200, {
        ok: true,
        value: await callMcpBridge("send", [body.connectionId, body.message]),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp-close") {
      const body = await readJson(request);
      if (!mcpConnectionIdPattern.test(body.connectionId || "")) {
        throw new Error("invalid MCP connection id");
      }
      sendJson(response, 200, {
        ok: true,
        value: await callMcpBridge("close", [body.connectionId]),
      });
      return;
    }
    // The instance's own VM control, called by the bridge for the admin
    // dashboard (authd → bridge → here). Loopback only, in this container's
    // network namespace, like every other route on this server.
    if (request.method === "GET" && url.pathname === "/vm/status") {
      sendJson(response, 200, { ok: true, value: await coworkVmStatus() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/vm/restart") {
      sendJson(response, 200, { ok: true, value: await restartCoworkVm() });
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
    if (request.method === "POST" && url.pathname === "/folder-pick") {
      const body = await readJson(request);
      sendJson(response, 200, { ok: true, value: resolveRemoteFolderPick(body) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/invoke") {
      // The outer bridge validates the surface/method first. Keep this second
      // independent check because direct port exposure has no app-layer auth.
      // Preserve enough room for Desktop's base64 image attachment contract.
      const body = await readJson(request, 72 * 1024 * 1024);
      const value = capSessionFileValue(
        body.surface,
        body.method,
        await invoke(
          body.surface,
          body.method,
          body.args || [],
          body.argsEncoding,
        ),
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
  // Both of these are about the same refusal and neither needs IPC, the renderer
  // or a session: a routine file an agent hard-linked heals on this start, and
  // the feature map the store reads its gate from loses that gate whether it was
  // filled from the network or from the payload cached on disk.
  void sweepHardLinkedRoutineFiles();
  void dropRoutineFileLinkGateFromCache();

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

  // The official deployment mode is initialized during startup; patch its
  // extension-policy predicate as soon as it exists so the first Extensions
  // call (including one from the native menu's Install Extension…) already
  // runs inside the override. The IPC wrapper calls ensure() lazily too.
  let extensionPolicyAttempts = 0;
  const extensionPolicyPoll = setInterval(() => {
    extensionPolicyAttempts += 1;
    if (extensionPolicy.ensure() || extensionPolicyAttempts >= 600) {
      clearInterval(extensionPolicyPoll);
    }
  }, 500);
  extensionPolicyPoll.unref();

  if (coworkHostBashEnabled) {
    console.warn("[cowork-wrapper] container-host Bash enabled; Cowork VM startup bypassed");
    return;
  }
  setTimeout(() => {
    coworkVmIdleCheck();
    setInterval(coworkVmIdleCheck, coworkVmIdlePollMs).unref();
  }, coworkVmIdlePollMs).unref();
});
