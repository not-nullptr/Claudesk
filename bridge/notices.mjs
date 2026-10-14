// The operator notice (the restart warning) kept across a restart.
//
// The notice is broadcast from the bridge's SIGTERM handler, which is exactly
// the moment the bridge stops being able to tell anyone anything: its event
// stream dies with it, and on a deployment that recreates `claude-desktop` the
// network namespace the bridge serves from goes with that container, so a
// page's connection can be cut before the notice lands. Writing the notice to
// the state directory is what closes that gap — the next bridge reads it back
// at startup and replays it to every page that reconnects inside the window, so
// the people whose connection died mid-restart still learn why.
//
// The record is `{title, description, expiresAt}` in the same shape the
// realtime controller caches. It expires on its own: a notice whose window
// closed while the bridge was down must not greet every tab afterwards.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const noticeFileName = "notice.json";

function noticePath(stateDir) {
  return join(stateDir, noticeFileName);
}

/** The persisted notice, or null when there is none — or none still live. */
export function loadNotice(stateDir, now = Date.now()) {
  let raw;
  try {
    raw = readFileSync(noticePath(stateDir), "utf8");
  } catch {
    return null;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || typeof record.expiresAt !== "number") return null;
  if (record.expiresAt <= now) {
    // Expired while the bridge was down. Drop it now rather than leave a file
    // that a later restart could read back as live.
    clearNotice(stateDir);
    return null;
  }
  if (typeof record.title !== "string" && typeof record.description !== "string") return null;
  return { title: record.title, description: record.description, expiresAt: record.expiresAt };
}

/** Record a notice so a bridge that starts after this one still has it. */
export function saveNotice(stateDir, record) {
  const target = noticePath(stateDir);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, target);
}

export function clearNotice(stateDir) {
  try {
    rmSync(noticePath(stateDir), { force: true });
  } catch {
    // A state directory that cannot be written is already reported by the
    // caller; forgetting the file is the least of it.
  }
}
