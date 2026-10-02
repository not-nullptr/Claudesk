// Identity and wire enums for the Code (Claude Code) surface of the mobile
// facade. A Code session is a Desktop LocalSessions session; the mobile facade
// addresses it as "code_" + Desktop's own session id so a Code session can
// never be mistaken for a Chat conversation ("local_" + uuid) or vice versa.
// The prefix also keeps the id inside the bridge's sessionId charset
// (/^[A-Za-z0-9_-]+$/, bridge/realtime.mjs).
//
// Everything here is a *literal* the app decodes. The app's shared JSONDecoder
// runs `.convertFromSnakeCase`, but that rewrites dictionary KEYS only, never
// string-raw enum VALUES — so the values below are exactly what goes on the
// wire (docs/mobile-code-re-findings.md, "Wire casing").

export const CODE_ID_PREFIX = "code_";

export const codeIdFor = (desktopSessionId) => `${CODE_ID_PREFIX}${desktopSessionId}`;

export function isCodeId(id) {
  return typeof id === "string" && id.startsWith(CODE_ID_PREFIX) && id.length > CODE_ID_PREFIX.length;
}

// The Desktop-side id, or null when `id` is not a Code id (callers 404 on null).
export function desktopSessionIdFor(id) {
  const value = typeof id === "string" ? id : "";
  return value.startsWith(CODE_ID_PREFIX) ? value.slice(CODE_ID_PREFIX.length) : null;
}

// SessionStatus — the app's session lifecycle.
export const SESSION_STATUS = Object.freeze({
  requiresAction: "requires_action",
  running: "running",
  idle: "idle",
  archived: "archived",
  pending: "pending",
  unknown: "unknown",
});

// SessionStatusBucket — the coarse bucket the list groups by.
export const STATUS_BUCKET = Object.freeze({
  blocked: "blocked",
  unknown: "unknown",
  reviewReady: "review_ready",
  working: "working",
  completed: "completed",
  failed: "failed",
});

export const CONNECTION_STATUS = Object.freeze({
  connected: "connected",
  disconnected: "disconnected",
  unspecified: "unspecified",
  unknown: "unknown",
});

export const WORKER_STATUS = Object.freeze({
  running: "running",
  idle: "idle",
  requiresAction: "requires_action",
  unspecified: "unspecified",
  unknown: "unknown",
});

export const ENVIRONMENT_KIND = Object.freeze({
  anthropicCloud: "anthropic_cloud",
  byoc: "byoc",
  bridge: "bridge",
  unknown: "unknown",
});

export const BRIDGE_SPAWN_MODE = Object.freeze({
  singleSession: "single-session",
  worktree: "worktree",
  sameDir: "same-dir",
});

// Desktop's own session record is flat and says `isRunning` / `isArchived`,
// while the app wants the `sessionStatus` axis. Approval prompts Desktop is
// waiting on surface as `requires_action`.
export function sessionStatusOf(record, { pendingApproval = false } = {}) {
  if (pendingApproval) return SESSION_STATUS.requiresAction;
  if (record?.isArchived) return SESSION_STATUS.archived;
  // Desktop's session object has both `isRunning` (the process is live) and
  // `turnRunning` (a turn is actually in flight). The app's "running" means the
  // latter: a warm-but-idle session should read as idle, not spinning. Fall
  // back to `isRunning` when `turnRunning` is absent.
  const busy = record?.turnRunning === undefined ? record?.isRunning : record?.turnRunning;
  if (busy) return SESSION_STATUS.running;
  const raw = typeof record?.status === "string" ? record.status : "";
  if (Object.values(SESSION_STATUS).includes(raw)) return raw;
  return SESSION_STATUS.idle;
}

export function statusBucketOf(status) {
  switch (status) {
    case SESSION_STATUS.requiresAction:
      return STATUS_BUCKET.blocked;
    case SESSION_STATUS.running:
    case SESSION_STATUS.pending:
      return STATUS_BUCKET.working;
    case SESSION_STATUS.archived:
    case SESSION_STATUS.idle:
      return STATUS_BUCKET.completed;
    default:
      return STATUS_BUCKET.unknown;
  }
}

// A self-hosted Desktop reached through the bridge is always a live connection
// while the facade can talk to it; `disconnected` is reserved for a session
// whose worker is gone.
export function connectionStatusOf(record) {
  if (record?.connectionStatus && Object.values(CONNECTION_STATUS).includes(record.connectionStatus)) {
    return record.connectionStatus;
  }
  return CONNECTION_STATUS.connected;
}

export function workerStatusOf(record, { pendingApproval = false } = {}) {
  if (pendingApproval) return WORKER_STATUS.requiresAction;
  if (record?.workerStatus && Object.values(WORKER_STATUS).includes(record.workerStatus)) {
    return record.workerStatus;
  }
  return record?.isRunning ? WORKER_STATUS.running : WORKER_STATUS.idle;
}
