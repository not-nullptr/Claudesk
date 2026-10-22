"use strict";

// Composer attachments for a Code session that runs on the account's guest
// runner. Desktop's own handler,
// `LocalAgentModeSessions.stageRemoteSessionAttachmentsViaFilesApi`, uploads
// the files to wherever it believes the session host is: the cloud Files API,
// or as HTTP `POST /v1/code/sessions/{id}/files` to a configured
// `selfHostedUrl`. In this deployment neither exists — the app runs in its
// three-party (gateway) mode, and a session host URL is deliberately not
// configured because it would displace the inference provider — so the handler
// takes its `remoteSessionFileHost() === null` branch and answers every path
// with reason `disabled`. The renderer maps that to its catch-all copy,
// "Couldn't attach {name} to this session on your organization's session host.
// Try again.", before any request is made.
//
// But the file needs no transport here. The wrapper already writes attachments
// into the account's workspace (`FileSystem.savePastedFile` puts them in
// userData/pending-uploads), and the guest runner sees that same workspace at
// `/workspace` through its virtiofs mount. So "staging" is a copy into a
// session-named directory there, and the path handed back is what the composer
// mentions to the agent.
//
// The fallback only runs when Desktop's own handler staged nothing and failed
// every otherwise-eligible path as `disabled`; a deployment with a working
// session host keeps upstream behavior. This module is plain Node (no Electron)
// so scripts/session-attachment-staging-smoke.mjs can exercise it directly.

const { constants } = require("node:fs");
const { copyFile, lstat, mkdir } = require("node:fs/promises");
const { basename, join, resolve, sep } = require("node:path");

// Where staged files appear in the guest. The runner bind-mounts the shared
// workspace over this path at startup (guest/runner.py, ensure_workspace_alias).
const workspaceRoot = "/workspace";
const stagingFolder = ".claudesk-attachments";

// The bounds the composer itself applies before it calls the staging method
// (20 files, 50 MB each, 500 MB in total — see the renderer's cg()). They are
// re-checked here because this handler is reachable from the browser side.
const maxFiles = 20;
const maxFileBytes = 50 * 1024 * 1024;
const maxTotalBytes = 500 * 1024 * 1024;

// savePastedFile names its copy `<uuid>-<original name>`; the prefix is an
// implementation detail, not part of the file the person attached.
const pastedPrefix =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
// A `@"/path"` mention is delimited by quotes, and a control character would
// break the line the composer builds around it.
const mentionUnsafe = /["\u0000-\u001f\u007f]/g;
// Code session ids as the bridge mints and accepts them (`cse_…`, and the older
// `session_…` spelling the renderer still carries). The id names a directory,
// so anything else is refused rather than sanitized.
const sessionIdPattern = /^(?:cse_|session_)[A-Za-z0-9_]{1,120}$/;

function stageName(sourcePath) {
  const leaf = basename(sourcePath).replace(pastedPrefix, "").trim();
  if (!leaf || leaf === "." || leaf === "..") return "";
  const cleaned = leaf.replace(mentionUnsafe, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "";
}

function within(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Pick a destination that does not overwrite an earlier attachment. Two files
 * with the same name (or the same file attached again in a later turn) get
 * `name (2).ext`, `name (3).ext`, … rather than one silently replacing the
 * other. Returns null when no free name is found within a bounded search.
 */
async function freeDestination(directory, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem} (${attempt})${extension}`;
    const path = join(directory, candidate);
    try {
      await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return path;
      throw error;
    }
  }
  return null;
}

/**
 * Copy the given paths into `<workspace>/.claudesk-attachments/<sessionId>/`.
 *
 * Returns `{ staged: [{index, mountPath}], failed: [{index, reason}] }` with
 * indexes relative to `paths`, or null when the arguments or the workspace
 * itself are unusable (the caller then leaves Desktop's own answer in place).
 * Reasons are the strings the renderer's staging-result reader knows:
 * `read`, `invalid`, `too_large`, `too_many` (see the main process's enum).
 */
async function stageSessionAttachments({
  sessionId,
  paths,
  pendingUploadsRoot,
  workspaceDirectory = workspaceRoot,
  limits = {},
}) {
  const fileLimit = positiveInteger(limits.maxFiles, maxFiles);
  const perFileLimit = positiveInteger(limits.maxFileBytes, maxFileBytes);
  const totalLimit = positiveInteger(limits.maxTotalBytes, maxTotalBytes);
  if (!sessionIdPattern.test(String(sessionId ?? ""))) return null;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > fileLimit) {
    return null;
  }
  if (!pendingUploadsRoot) return null;
  const pendingRoot = resolve(String(pendingUploadsRoot));
  const destinationDirectory = join(workspaceDirectory, stagingFolder, sessionId);
  try {
    await mkdir(destinationDirectory, { recursive: true });
  } catch {
    return null;
  }

  const staged = [];
  const failed = [];
  let totalBytes = 0;

  for (let index = 0; index < paths.length; index += 1) {
    const raw = paths[index];
    if (typeof raw !== "string" || !raw) {
      failed.push({ index, reason: "invalid" });
      continue;
    }
    const source = resolve(raw);
    if (!within(pendingRoot, source)) {
      // Only the composer's own materialized copies are staging inputs. A path
      // elsewhere in the container is not something this handler may copy into
      // a workspace the agent reads.
      failed.push({ index, reason: "invalid" });
      continue;
    }
    let info;
    try {
      info = await lstat(source);
    } catch {
      failed.push({ index, reason: "read" });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      failed.push({ index, reason: "read" });
      continue;
    }
    if (info.size > perFileLimit) {
      failed.push({ index, reason: "too_large" });
      continue;
    }
    if (totalBytes + info.size > totalLimit) {
      failed.push({ index, reason: "too_many" });
      continue;
    }
    const name = stageName(source);
    if (!name) {
      failed.push({ index, reason: "invalid" });
      continue;
    }
    // Another staging call can claim a name between the probe and the copy
    // (COPYFILE_EXCL then reports EEXIST); retry with the next free suffix.
    let destination = null;
    for (let attempt = 0; attempt < 3 && destination === null; attempt += 1) {
      try {
        const candidate = await freeDestination(destinationDirectory, name);
        if (candidate === null) break;
        await copyFile(source, candidate, constants.COPYFILE_EXCL);
        destination = candidate;
      } catch (error) {
        if (error?.code !== "EEXIST") break;
      }
    }
    if (destination === null) {
      failed.push({ index, reason: "attach_other" });
      continue;
    }
    totalBytes += info.size;
    staged.push({ index, mountPath: destination });
  }

  return { staged, failed };
}

/**
 * Merge a local staging result into Desktop's answer for the paths it could not
 * stage. Only paths Desktop labelled `disabled` are candidates: any other
 * reason (`too_large`, `read`, `invalid`, …) is a real refusal and is kept.
 *
 * Returns the replacement answer, or null when there is nothing to rescue.
 */
async function rescueDisabledStaging({
  official,
  sessionId,
  paths,
  pendingUploadsRoot,
  workspaceDirectory = workspaceRoot,
  limits = {},
}) {
  if (!official || typeof official !== "object") return null;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const staged = Array.isArray(official.staged) ? official.staged : [];
  const failed = Array.isArray(official.failed) ? official.failed : [];
  const disabled = new Map();
  for (const entry of failed) {
    if (entry && entry.reason === "disabled"
        && Number.isInteger(entry.index)
        && entry.index >= 0 && entry.index < paths.length
        && !disabled.has(entry.index)) {
      disabled.set(entry.index, entry);
    }
  }
  if (disabled.size === 0) return null;

  const rescued = [...disabled.keys()].sort((left, right) => left - right);
  const stagedPaths = rescued.map((index) => paths[index]);
  if (stagedPaths.some((path) => typeof path !== "string" || !path)) return null;

  const local = await stageSessionAttachments({
    sessionId,
    paths: stagedPaths,
    pendingUploadsRoot,
    workspaceDirectory,
    limits,
  });
  if (local === null) return null;

  const mergedFailed = failed.filter((entry) => !disabled.has(entry?.index));
  for (const entry of local.failed) {
    mergedFailed.push({ index: rescued[entry.index], reason: entry.reason });
  }
  const mergedStaged = [
    ...staged,
    ...local.staged.map((entry) => ({
      index: rescued[entry.index],
      mountPath: entry.mountPath,
    })),
  ];
  // A result that rescued nothing is indistinguishable from Desktop's refusal;
  // hand back null so the caller keeps the original object untouched.
  if (mergedStaged.length === staged.length) return null;
  return { staged: mergedStaged, failed: mergedFailed };
}

// The channel suffix Desktop registers on each window's own IPC endpoint
// (`webContents.ipc.handle`, not the global `ipcMain`).
const stagingChannelSuffix =
  "LocalAgentModeSessions_$_stageRemoteSessionAttachmentsViaFilesApi";
const wrappedIpc = new WeakSet();

/**
 * Wrap one window's IPC endpoint so the staging channel answers with the local
 * copy when Desktop staged nothing (`disabled`). Returns whether this endpoint
 * was wrapped (false when disabled, already wrapped, or not an IPC host).
 */
function wrapStagingIpc(ipc, { enabled, pendingUploadsRoot, workspaceDirectory = workspaceRoot }) {
  if (!enabled || !ipc || typeof ipc.handle !== "function" || wrappedIpc.has(ipc)) {
    return false;
  }
  const originalHandle = ipc.handle.bind(ipc);
  ipc.handle = (channel, listener) => {
    if (typeof channel !== "string"
      || !channel.endsWith(stagingChannelSuffix)
      || typeof listener !== "function") {
      return originalHandle(channel, listener);
    }
    return originalHandle(channel, async (event, ...args) => {
      // A malformed call is Desktop's to refuse (it throws); let that through.
      const official = await listener(event, ...args);
      try {
        const rescued = await rescueDisabledStaging({
          official,
          sessionId: args[0],
          paths: args[1],
          pendingUploadsRoot,
          workspaceDirectory,
        });
        return rescued ?? official;
      } catch (error) {
        console.warn(
          "[cowork-wrapper] staging a runner attachment locally failed:",
          error?.message || error,
        );
        return official;
      }
    });
  };
  wrappedIpc.add(ipc);
  return true;
}

module.exports = {
  maxFileBytes,
  maxFiles,
  maxTotalBytes,
  rescueDisabledStaging,
  stageName,
  stageSessionAttachments,
  stagingChannelSuffix,
  stagingFolder,
  workspaceRoot,
  wrapStagingIpc,
};
