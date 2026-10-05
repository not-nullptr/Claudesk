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

// WorkerStatus — the two-case axis `SessionResource.workerStatus` decodes
// (`processing | idle`). The list row's `workerStatus` is the richer
// SessionWorkerStatus below; the two types share only `idle`.
export const WORKER_STATUS = Object.freeze({
  processing: "processing",
  idle: "idle",
});

// SessionWorkerStatus — the list row's `workerStatus`.
export const SESSION_WORKER_STATUS = Object.freeze({
  running: "running",
  idle: "idle",
  requiresAction: "requires_action",
  unspecified: "unspecified",
  unknown: "unknown",
});

// SessionLifecycleStatus — the list row's `status` axis (a deployment
// lifecycle), which is a DIFFERENT axis from the `sessionStatus` the detail
// record and the status bucket report. Only the two states a self-hosted
// Desktop can be in are needed; both are non-optional strings, because
// `SessionResponse.status` is not optional.
export const SESSION_LIFECYCLE_STATUS = Object.freeze({
  active: "active",
  archived: "archived",
});

// `EnvironmentKind` is `LossyRawRepresentable`, so an unknown value falls back
// to `.unknown` and never throws — the spelling here cannot fail the decode.
export const ENVIRONMENT_KIND = Object.freeze({
  anthropicCloud: "anthropicCloud",
  byoc: "byoc",
  bridge: "bridge",
  unknown: "unknown",
});

// `BridgeSpawnMode` — unlike `EnvironmentKind`/`EnvironmentState`/`ConfigType` —
// is NOT lossy, so an unknown raw value throws `dataCorrupted` and fails the
// whole `EnvironmentResource` (opaque `ModelDecodingError(kind:
// unexpected_schema)`). Its cases are `singleSession | worktree | sameDir`, but
// the raw values are the HYPHENATED spellings: `single-session | worktree |
// same-dir`. The binary carries both (`single-session`/`same-dir` in __cstring,
// referenced by the raw-value table; `singleSession`/`sameDir` in
// __swift5_reflstr as the case names), and `worktree` — where the two coincide —
// appears twice. This is the one enum on the environment record that can reject
// a value, so sending `sameDir` here is what failed every environment decode.
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

// The list row's `status` is SessionLifecycleStatus (active | archived |
// paused | failed | unspecified | unknown), NOT the `sessionStatus` above: the
// row reports the deployment lifecycle, and the rich per-turn axis reached the
// app only through the detail record. A session on this Desktop is `active`
// until it is archived; nothing here is paused or failed.
export function sessionLifecycleStatusOf(record) {
  return record?.isArchived ? SESSION_LIFECYCLE_STATUS.archived : SESSION_LIFECYCLE_STATUS.active;
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

// The list row's `workerStatus` (SessionWorkerStatus: running | idle |
// requires_action | …). A pending approval is Desktop waiting on the user.
export function workerStatusOf(record, { pendingApproval = false } = {}) {
  if (pendingApproval) return SESSION_WORKER_STATUS.requiresAction;
  if (record?.workerStatus && Object.values(SESSION_WORKER_STATUS).includes(record.workerStatus)) {
    return record.workerStatus;
  }
  return record?.isRunning ? SESSION_WORKER_STATUS.running : SESSION_WORKER_STATUS.idle;
}

// The detail record's `workerStatus` (WorkerStatus: processing | idle) — the
// same question asked in a two-case vocabulary. `processing` is the only value
// for a turn that is in flight or waiting on an approval; a still-unknown
// status is idle, not a third state the enum does not have.
export function resourceWorkerStatusOf(record, { pendingApproval = false } = {}) {
  const status = workerStatusOf(record, { pendingApproval });
  return status === SESSION_WORKER_STATUS.idle
    || status === SESSION_WORKER_STATUS.unspecified
    || status === SESSION_WORKER_STATUS.unknown
    ? WORKER_STATUS.idle
    : WORKER_STATUS.processing;
}

// `SessionResource.connectionStatus` (ConnectionStatus: connected |
// disconnected) has no `unspecified`/`unknown` case, so the list row's wider
// vocabulary is narrowed here rather than passed through.
export function resourceConnectionStatusOf(record) {
  return connectionStatusOf(record) === CONNECTION_STATUS.disconnected
    ? CONNECTION_STATUS.disconnected
    : CONNECTION_STATUS.connected;
}
