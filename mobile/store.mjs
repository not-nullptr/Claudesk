import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Auth sessions, ban state, mobile-only chat metadata and uploaded attachments are
// persisted as JSON files with tmp+rename atomic writes, matching the
// zero-dependency style of the rest of this repo. Node 18 is used in the
// container, so there is no node:sqlite.

export function createMobileStore({ dataDir }) {
  const sessionsFile = join(dataDir, "sessions.json");
  const bansFile = join(dataDir, "bans.json");
  const conversationsDir = join(dataDir, "conversations");
  const filesDir = join(dataDir, "files");

  async function ensureDirs() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function readJson(filePath, fallback) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }

  // Canonical-scoped helpers for engine-owned state stored inside dataDir.
  async function readJsonFile(relativePath, fallback) {
    return readJson(join(dataDir, relativePath), fallback);
  }

  async function writeJsonFile(relativePath, value) {
    return writeJson(join(dataDir, relativePath), value);
  }

  async function writeJson(filePath, value) {
    await mkdir(join(filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await rename(tmp, filePath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  let sessionCache = null;
  let sessionCacheLoaded = false;

  async function loadSessions() {
    if (!sessionCacheLoaded) {
      sessionCache = (await readJson(sessionsFile, {})) ?? {};
      sessionCacheLoaded = true;
    }
    return sessionCache;
  }

  async function saveSessions(sessions) {
    sessionCache = sessions;
    await writeJson(sessionsFile, sessions);
  }

  async function pruneSessions(maxIdleMs = 30 * 24 * 3600 * 1000) {
    const sessions = await loadSessions();
    const cutoff = Date.now() - maxIdleMs;
    let changed = false;
    for (const [token, session] of Object.entries(sessions)) {
      const seen = Date.parse(session.lastSeenAt || session.createdAt || "");
      if (!Number.isFinite(seen) || seen < cutoff) {
        delete sessions[token];
        changed = true;
      }
    }
    if (changed) await saveSessions(sessions);
  }

  async function createSession(email) {
    await pruneSessions();
    const sessions = await loadSessions();
    const token =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    sessions[token] = { email, createdAt: nowIso(), lastSeenAt: nowIso() };
    await saveSessions(sessions);
    return token;
  }

  async function touchSession(token) {
    const sessions = await loadSessions();
    const session = sessions[token];
    if (!session) return false;
    // Rewrite the file at most once a minute per session; every request would
    // be pure churn for a single-user deployment.
    if (Date.now() - Date.parse(session.lastSeenAt || "") < 60_000) return true;
    session.lastSeenAt = nowIso();
    await saveSessions(sessions);
    return true;
  }

  async function destroySession(token) {
    const sessions = await loadSessions();
    if (!sessions[token]) return false;
    delete sessions[token];
    await saveSessions(sessions);
    return true;
  }

  let banCache = null;
  let banCacheLoaded = false;

  async function loadBans() {
    if (!banCacheLoaded) {
      banCache = (await readJson(bansFile, { entries: {} })) ?? { entries: {} };
      banCacheLoaded = true;
    }
    return banCache;
  }

  async function saveBans(bans) {
    // Drop expired entries so the file stays small.
    const now = Date.now();
    for (const [key, entry] of Object.entries(bans.entries)) {
      const locked = Date.parse(entry.lockedUntil || "");
      if (entry.failures <= 0 && !(locked > now)) delete bans.entries[key];
    }
    banCache = bans;
    await writeJson(bansFile, bans);
  }

  // Conversations used to be stored here when this service ran inference itself.
  // They now live in Claude Desktop, so any left over are moved aside (kept, not
  // served) instead of being deleted.
  async function archiveLegacyConversations() {
    const names = (await readdir(conversationsDir).catch(() => []))
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp"));
    if (!names.length) return 0;
    const archive = join(dataDir, "legacy-conversations");
    await mkdir(archive, { recursive: true, mode: 0o700 });
    for (const name of names) await rename(join(conversationsDir, name), join(archive, name));
    return names.length;
  }

  async function saveUploadedFile(uuid, meta, bytes) {
    await ensureDirs();
    await writeFile(join(filesDir, `${uuid}.bin`), bytes, { mode: 0o600 });
    await writeJson(join(filesDir, `${uuid}.meta.json`), meta);
  }

  async function readUploadedFile(uuid) {
    try {
      const bytes = await readFile(join(filesDir, `${uuid}.bin`));
      const meta = await readJson(join(filesDir, `${uuid}.meta.json`), {});
      return { bytes, meta };
    } catch {
      return null;
    }
  }

  async function findUpload({ name, size }) {
    const names = await readdir(filesDir).catch(() => []);
    for (const entry of names) {
      if (!entry.endsWith(".meta.json") || entry.includes(".tmp")) continue;
      const meta = await readJson(join(filesDir, entry), null);
      if (meta?.file_name === name && Number(meta.file_size) === Number(size)) {
        const uuid = entry.replace(/\.meta\.json$/, "");
        return await readUploadedFile(uuid);
      }
    }
    return null;
  }

  return {
    ensureDirs,
    createSession,
    touchSession,
    destroySession,
    pruneSessions,
    loadBans,
    saveBans,
    archiveLegacyConversations,
    saveUploadedFile,
    readUploadedFile,
    findUpload,
    readJsonFile,
    writeJsonFile,
    nowIso,
  };
}
