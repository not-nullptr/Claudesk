// Self-hosted Code runners for a tenant instance.
//
// A tenant's Code must not execute in its own container — that container is
// privileged enough that an agent shell there is close to host root
// (docs/code-in-cowork-vm.md). The product's own answer is a *self-hosted
// environment*: a `byoc` environment backed by a **runner pool**, where the
// Code surface sends the session and a runner we host runs the agent.
//
// The runner is Claude Code itself (`claude self-hosted-runner`), and it is a
// **polling** client pointed at a base URL we choose
// (`CLAUDE_RUNNER_API_BASE_URL`) with a pool secret. So the whole feature can be
// served from this bridge, which is the origin for the renderer's `/v1/*` calls
// (they are fetched with relative URLs) — exactly as bridge/projects.mjs and
// bridge/connectors.mjs answer claude.ai families they have no upstream for.
//
// The wire shapes below are read off the runner client embedded in the Claude
// Code native binary (2.1.295). `docs/self-hosted-runners-guide.md` is
// referenced by that binary but is not shipped with it, so these are the
// binary's contract rather than a published spec and can move between releases:
//
//   POST /v1/code/runners/self-hosted/runners/register
//     -> {runner_version, use_anthropic_git_proxy, server_auto_mode_lists,
//         client_label?, lock_to_account_id?}
//     <- {runner_id}
//   POST /v1/code/runners/self-hosted/spawn-hints/poll
//     <- {hints:[{session_uuid, attempt, work_order_jwt, sources}], warm_hints,
//         pending_count, backing_off_count, circuit_broken_count,
//         pool_pending_session_count, pool_active_session_count, slots?}
//   POST /v1/code/runners/self-hosted/spawn-hints/nack
//     -> {...hint, error}   <- {}
//   POST /v1/code/runners/self-hosted/deregister
//   POST /v1/code/runners/self-hosted/sessions/{id}/token
//     <- {session_token}            (the token the session itself is then run with)
//   POST /v1/code/runners/self-hosted/sessions/{id}/report-failure
//     -> {reason, setup_failure_kind?, failure_kind?}  <- {excluded_count, stuck}
//   POST /v1/code/runners/self-hosted/sessions/{id}/release
//   POST /v1/code/runners/self-hosted/sessions/{id}/retry-spawn   (Activity → Retry)
//   GET  /v1/code/runners/self-hosted/pools[/{id}[/secrets|/sessions]]
//
// Auth is the pool secret on those calls (the runner sends it as
// `Authorization: Bearer …`); `pool` and `secrets` also carry a `pool_secret`
// field for the admin UI.
//
// One instance is one account, so the few records live in a single file under
// the instance's own state directory, like project-stars.json.

import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const stateFileName = "code-runners.json";
// How long a deleted session's id stays in the store's cancellation list: a
// runner that is mid-turn polls again quickly, and the tombstone is what tells
// it to stop. Ten minutes is many poll cycles, and the entries are tiny.
const cancelTombstoneMs = 10 * 60 * 1000;

// A session handed to a poll is not handed to a live turn yet. The offer lease
// re-offers one whose claim never landed (the HTTP answer was lost, the runner
// died between the claim and the token); without it the session stays
// `offered` forever and no later poll can take it.
const offerLeaseMs = 60 * 1000;
// How long an `active` session is believed while no runner is online at all.
// The VM powering down or the guest restarting kills every turn with no
// release; this is the grace before the bridge declares the turn lost.
const offlineReapGraceMs = 30 * 1000;
// How long an `active` session may be absent from every live runner's claim
// set before it is treated as lost. Longer than a poll cycle plus the thread
// start, so a healthy turn is never reaped.
const claimReapGraceMs = 90 * 1000;
const reapIntervalMs = (() => {
  const raw = Number(process.env.CLAUDESK_SESSION_REAP_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15000;
})();
// A turn whose runner was lost is retried this many times; a fresh user message
// starts the count over, so a genuinely broken session goes idle instead of
// requeueing forever.
const reapAttemptLimit = 3;

// The terminal a reaped turn leaves in the transcript. The session view closes
// a turn on `result`; a turn whose runner vanished would otherwise spin
// forever and read as "running" on every later load.
function lostTurnResult(reason) {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    interrupted: true,
    result: reason,
    session_id: "",
    duration_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
  };
}

// A pool id is opaque; the built bundle writes `ccpool_`-prefixed ids, so the
// same spelling keeps anything that pattern-matches a pool id happy.
function newPoolId() {
  return `ccpool_${randomBytes(16).toString("hex")}`;
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The secret arrives as `Authorization: Bearer <secret>` from the runner; the
// admin UI has no secret yet, so a missing header is simply "no pool".
function bearerToken(headers = {}) {
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== "string") return "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

// The environment document a `byoc` pool is advertised as. A bridge environment
// is one directory on one machine; a self-hosted environment is a pool, whose
// runner picks its own checkout, so it carries no `directory`. The app groups
// environments by `kind`, and `EnvironmentKind.byoc` is the self-hosted case
// ("Self-hosted environments" in the UI).
export function poolEnvironment(pool, { online = true } = {}) {
  return {
    kind: "byoc",
    environment_id: pool.pool_id,
    name: pool.name,
    created_at: pool.created_at,
    state: online && pool.status === "active" ? "active" : "unknown",
    config: {
      environment_type: "byoc",
      init_script: "",
      environment: {},
      languages: [],
      network_config: { allowed_hosts: [], allow_default_hosts: true },
    },
  };
}

// The `config` keys a create body carries and the session echoes back — the
// renderer's own create serializer builds exactly this set from the session
// context, so the document the session page renders its sources, model and
// permission mode from is the same one the create body held.
const sessionConfigKeys = ["sources", "outcomes", "model", "cwd", "source_branch",
  "use_worktree", "effort_level",
  "permission_mode", "custom_system_prompt", "append_system_prompt",
  "allowed_tools", "disallowed_tools", "reuse_outcome_branches", "mcp_servers"];

/**
 * One session, in the app's own vocabulary.
 *
 * The renderer normalizes every session document it reads through its own
 * parser, which folds the wire `status`/`worker_status`/`connection_status`
 * triple into the state the UI paints: `active` with no worker status reads as
 * **pending**, `active` + `running` + `connected` as running, `active` +
 * `idle` as idle, and `archived` passes through. There is no displayed
 * "failed" — a failed run is an idle session whose transcript says why — so
 * the wire status is archived or active and nothing else. The store's states
 * are the runner's vocabulary (pending → offered → active → released/failed);
 * the app's spelling is derived here rather than stored twice.
 */
function sessionDocument(session) {
  const archived = session.archived === true;
  const state = session.state;
  const config = sessionConfigOf(session);
  // The Code sidebar groups its rows by `repoInfo` (the renderer builds that
  // from `session_context.sources`/`outcomes`, both empty for a folder-placed
  // self-hosted session), so a folder session read as "Other" however the
  // sidebar was grouped. The folder name is the group the person picked; the
  // renderer patch (`web-code-selfhosted-repo-info`) takes this field before
  // trying to derive a repository from git metadata.
  const folderName = typeof config.cwd === "string" && config.cwd
    ? config.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || null : null;
  // What the runner last reported of the child's own lifecycle wins over the
  // state derived from the store's vocabulary.
  const reportedWorker = typeof session.reported_worker_status === "string"
    ? session.reported_worker_status : null;
  const reportedConnection = typeof session.reported_connection_status === "string"
    ? session.reported_connection_status : null;
  return {
    id: session.session_uuid,
    title: typeof session.title === "string" ? session.title : "",
    status: archived ? "archived" : "active",
    ...(!archived && reportedWorker
      ? {
        worker_status: reportedWorker,
        ...(reportedConnection ? { connection_status: reportedConnection } : {}),
      }
      : !archived && state === "active"
        ? { worker_status: "running", connection_status: reportedConnection ?? "connected" } : {}),
    ...(!archived && !reportedWorker && (state === "released" || state === "failed")
      ? { worker_status: "idle" } : {}),
    environment_id: session.pool_id,
    self_hosted_runner_pool_id: session.pool_id,
    // The pool-session state the app reads beside the id: the pool's name, and
    // — once a runner has taken the session — the label that ends the page's
    // "Waiting for a runner…" card (the reader clears it only on a label plus
    // transcript rows; a bare "pending" with no label is exactly what that card
    // means). An absent field means *unknown* to this reader, so nothing is
    // claimed before a runner actually has it.
    self_hosted_runner_state: {
      ...(typeof session.pool_name === "string" && session.pool_name
        ? { pool_name: session.pool_name } : {}),
      ...(typeof session.runner_label === "string" && session.runner_label
        ? { assigned_runner_label: session.runner_label } : {}),
    },
    created_at: session.created_at,
    last_event_at: session.last_event_at ?? session.created_at,
    ...(typeof session.trigger_id === "string" && session.trigger_id
      ? { trigger_id: session.trigger_id } : {}),
    ...(typeof session.origin === "string" && session.origin
      ? { origin: session.origin } : {}),
    // The renderer normalizes a session through its own parser (`IP` in the
    // bundle): the model and effort come from the top-level `session_context`,
    // and the permission mode is a top-level field of its own. Publishing the
    // create config only under `config` — the shape the guest runner reads —
    // left both invisible to the composer, so opening a session showed the
    // built-in model and "Accept edits" however it had been started.
    session_context: {
      ...config,
      sources: Array.isArray(config.sources) ? config.sources : [],
      outcomes: Array.isArray(config.outcomes) ? config.outcomes : [],
    },
    ...(typeof config.permission_mode === "string" && config.permission_mode
      ? { permission_mode: config.permission_mode } : {}),
    ...(folderName
      ? {
        repo_info: {
          owner: "",
          name: folderName,
          ...(typeof config.source_branch === "string" && config.source_branch
            ? { branch: config.source_branch } : {}),
        },
      }
      : {}),
    // The runner reads this spelling (`session.config`) for the turn's argv;
    // keep it beside the renderer-facing shape.
    config,
    tags: Array.isArray(session.tags) ? session.tags : [],
    ...(session.client_metadata ? { client_metadata: session.client_metadata } : {}),
    ...(session.unread ? { unread: true } : {}),
  };
}

/**
 * Stop a session's running turn. The Code surface's Stop is not a REST verb on
 * this deployment: the renderer appends an SDK control request
 * (`{type:"control_request", request_id, request:{subtype:"interrupt"}}`) to
 * the session's event log. Recording it on the session is what lets *both*
 * runner kinds stop:
 *
 *   * the shipped runner's poll reader treats a held session's disappearance
 *     from `assignment_ids` as the server taking it away and aborts the child,
 *     so the assignment is cleared;
 *   * the guest runner is handed the id in its poll's `cancellations` (see
 *     `cancellationsFor`), because it has no assignment-list reader of its own.
 *
 * A session no runner has picked up yet is released instead: there is no child
 * to kill, and the next user message requeues it.
 */
function markInterrupted(session, { requestId } = {}) {
  const at = new Date().toISOString();
  session.interrupt_requested_at = at;
  if (typeof requestId === "string" && requestId) {
    session.interrupt_request_id = requestId;
  } else {
    delete session.interrupt_request_id;
  }
  session.assigned_runner_id = undefined;
  if (session.state === "pending" || session.state === "offered") {
    session.state = "released";
  }
  return at;
}

/** Start a turn clean: an old Stop must not cancel the next message. */
function clearInterrupted(session) {
  delete session.interrupt_requested_at;
  delete session.interrupt_request_id;
}

/** The `config` of a session document — see `sessionConfigKeys`. Sessions the
 * store already held before this shape keep their sources at the top level,
 * so both spellings are read. */
function sessionConfigOf(session) {
  const stored = isRecord(session.session_config) ? session.session_config : {};
  const config = {
    sources: Array.isArray(stored.sources) ? stored.sources
      : Array.isArray(session.sources) ? session.sources : [],
  };
  const outcomes = Array.isArray(stored.outcomes) && stored.outcomes.length
    ? stored.outcomes : session.outcomes;
  if (Array.isArray(outcomes) && outcomes.length) config.outcomes = outcomes;
  const model = typeof stored.model === "string" && stored.model
    ? stored.model : session.model;
  if (typeof model === "string" && model) config.model = model;
  for (const key of sessionConfigKeys) {
    if (key === "sources" || key === "outcomes" || key === "model") continue;
    if (stored[key] !== undefined) config[key] = stored[key];
  }
  return config;
}

// The product's session ids encode their UUID in a trailing `_01<base58>`
// segment: the runner decodes it (`ZI` in its own code — last `_`, a `01`
// marker, then exactly 22 characters of the Bitcoin base58 alphabet whose
// number is the UUID's hex) and hands the child that UUID as its remote session
// id. An id it cannot decode yields undefined, and the setup that builds URLs
// and state paths out of it dies — so the bridge mints ids in the same
// encoding rather than inventing its own.
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58OfHex(hex) {
  let value = BigInt(`0x${hex}`);
  let out = "";
  while (value > 0n) {
    out = base58Alphabet[Number(value % 58n)] + out;
    value /= 58n;
  }
  return (out || "1").padStart(22, "1");
}

function hexOfBase58(text) {
  let value = 0n;
  for (const character of text) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  return hex.length <= 32 ? hex.padStart(32, "0") : null;
}

/**
 * The canonical bare form of a session id: the UUID the id carries, as 32 hex
 * characters and nothing else. Both spellings of an id canonicalize to it — an
 * encoded `cse_…_01<base58>` decodes, a plain uuid or `session_…` strips — so
 * a session answers under old links and new alike.
 */
function bareSessionId(id) {
  const raw = String(id ?? "");
  const encoded = /_01([1-9A-HJ-NP-Za-km-z]{22})$/.exec(raw);
  if (encoded) {
    const hex = hexOfBase58(encoded[1]);
    if (hex !== null) return hex;
  }
  return raw.replace(/^(?:cse_|session_)/, "").replaceAll("-", "").toLowerCase();
}

/**
 * The id a new session gets on the wire: the wire generation's `cse_` prefix
 * (the app classifies an id by it — anything else, a bare uuid very much
 * included, reads as a *local* session), an alphabet the app's id shape accepts
 * (`[A-Za-z0-9_]`, no dashes), and the UUID the runner decodes back out.
 */
function newSessionId() {
  const hex = randomUUID().replaceAll("-", "");
  return `cse_${hex.slice(0, 12)}_01${base58OfHex(hex)}`;
}

/**
 * Find a session by id under whatever spelling of it arrived. The renderer
 * carries two generations of the id around its own display form (`cse_…` on
 * the wire of its newer legs, `session_…` in its reader), and sessions this
 * store held before the prefix moved onto its ids answer to their old bare
 * uuid too — so the lookup compares canonical forms when the exact string
 * does not match.
 */
function sessionById(state, sessionId) {
  const raw = typeof sessionId === "string" ? sessionId : "";
  const exact = state.sessions.find((entry) => entry.session_uuid === raw);
  if (exact) return exact;
  const bare = bareSessionId(raw);
  if (!bare) return undefined;
  return state.sessions.find((entry) => bareSessionId(entry.session_uuid) === bare);
}

/**
 * Append entries to a session's log, assigning `event_id` and `sequence_num`
 * here: the wire contract requires a non-empty `event_id` and a `sequence_num`
 * that is a **positive digit string** — the renderer's own reader rejects zero
 * and a non-string — so a caller-supplied one is ignored rather than trusted.
 * Returns the appended envelopes.
 */
// The provider echoes the model id the CLI finally sent. For a `[1m]` spelling
// the CLI splits the suffix off as a context flag, so the assistant stream
// carries the base id while the session was placed with the 1M id. The
// composer syncs its model switcher from those events, which made a 1M session
// visibly fall back to the standard entry after its first turn. Rewrite the
// echoed id back to the session's own when the two are the same model (only the
// trailing `[...]` differs); a genuine fallback to another model is untouched.
function normalizeEventModel(payload, session) {
  const requested = sessionConfigOf(session).model;
  if (typeof requested !== "string" || !requested) return payload;
  const strip = (value) => typeof value === "string"
    ? value.replace(/\[[^\]]+\]$/, "") : value;
  const same = (value) => typeof value === "string"
    && strip(value) === strip(requested);
  if (payload.type === "assistant" && isRecord(payload.message) && same(payload.message.model)) {
    payload.message = { ...payload.message, model: requested };
  } else if (payload.type === "stream_event" && isRecord(payload.event?.message)
    && same(payload.event.message.model)) {
    payload.event = { ...payload.event,
      message: { ...payload.event.message, model: requested } };
  }
  return payload;
}

/**
 * A token-level `stream_event` is live transport, not history. The CLI emits
 * one per delta, and persisting every one made the durable log (and the
 * bridge's heap) grow by orders of magnitude more than the conversation it
 * describes. These are broadcast to open streams and never written to the
 * session's log; the `assistant` event that follows carries the completed
 * message, which is what a reload replays.
 */
function isVolatilePayload(payload) {
  return isRecord(payload) && payload.type === "stream_event";
}

function appendToSession(session, incoming, source) {
  session.events = Array.isArray(session.events) ? session.events : [];
  // The running counter is the O(1) path; the scan only initialises it for a
  // store that predates the counter (or a session loaded without events).
  let sequence = Number.isFinite(session.last_sequence)
    ? Number(session.last_sequence)
    : session.events.reduce(
      (high, event) => Math.max(high, Number(event.sequence_num) || 0), 0);
  const appended = [];
  for (const entry of incoming) {
    const payload = isRecord(entry?.payload) ? entry.payload : entry;
    if (!isRecord(payload) || isVolatilePayload(payload)) continue;
    normalizeEventModel(payload, session);
    sequence += 1;
    const envelope = {
      event_id: randomUUID(),
      sequence_num: String(sequence),
      // Who wrote it: the renderer's own messages are `client`, the runner's
      // are `worker`. The readers route on this — a user-shaped frame is
      // dropped unless its source is `worker` (so tool results are not read as
      // human messages), and a `client` echo is held from the transcript until
      // the server says it was processed (see deliveryUpdates and
      // issueSessionToken).
      ...(source ? { source } : {}),
      payload,
      ...(typeof entry?.event_type === "string" && entry.event_type
        ? { event_type: entry.event_type } : {}),
      created_at: new Date().toISOString(),
    };
    session.events.push(envelope);
    appended.push(envelope);
  }
  session.last_sequence = sequence;
  if (appended.length) session.last_event_at = appended[appended.length - 1].created_at;
  return appended;
}

/** A live-only envelope: sequenced for the stream's reader, never persisted. */
function volatileEnvelope(session, entry, source) {
  const payload = isRecord(entry?.payload) ? entry.payload : entry;
  if (!isRecord(payload)) return null;
  normalizeEventModel(payload, session);
  session.last_sequence = (Number(session.last_sequence) || 0) + 1;
  return {
    event_id: randomUUID(),
    sequence_num: String(session.last_sequence),
    ...(source ? { source } : {}),
    payload,
    ...(typeof entry?.event_type === "string" && entry.event_type
      ? { event_type: entry.event_type } : {}),
    created_at: new Date().toISOString(),
    // Readers that persist frames must be able to tell this one is ephemeral.
    volatile: true,
  };
}

/** Split one append into durable events and live-only ones, then append the
 * durable half. Callers write the file and fan out both. */
function appendIncoming(session, incoming, source) {
  const durableEntries = [];
  const volatile = [];
  for (const entry of incoming) {
    const payload = isRecord(entry?.payload) ? entry.payload : entry;
    if (!isRecord(payload)) continue;
    if (isVolatilePayload(payload)) {
      const envelope = volatileEnvelope(session, entry, source);
      if (envelope) volatile.push(envelope);
    } else {
      durableEntries.push(entry);
    }
  }
  return { durable: appendToSession(session, durableEntries, source), volatile };
}

/**
 * Is this entry a message the human typed? (A client user event, as the
 * renderer posts it — string content or text blocks; a tool result is also a
 * `user` payload on the wire and is deliberately not one of these.)
 */
function isUserMessage(entry) {
  const payload = isRecord(entry?.payload) ? entry.payload : entry;
  if (!isRecord(payload) || payload.type !== "user") return false;
  const content = (payload.message ?? {}).content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    return content.some((part) => isRecord(part) && part.type === "text"
      && typeof part.text === "string" && part.text.trim() !== "");
  }
  return false;
}

/** Is this a user payload with anything the agent can answer? Text or an
 *  image counts; a tool result does not (the runner's own `user` frames are
 *  tool results, and are written with `source: "worker"`). */
function hasAnswerableContent(entry) {
  if (entry?.source === "worker") return false;
  const payload = isRecord(entry?.payload) ? entry.payload : entry;
  if (!isRecord(payload) || payload.type !== "user") return false;
  const content = (payload.message ?? {}).content;
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!isRecord(part)) return false;
    if (part.type === "text") {
      return typeof part.text === "string" && part.text.trim() !== "";
    }
    if (part.type !== "image") return false;
    const source = part.source;
    return isRecord(source) && source.type === "base64"
      && typeof source.data === "string" && source.data !== "";
  });
}

/**
 * Has this session a prompt to run? A session is placed before the composer
 * posts its first message, and the placement wakes the pool immediately — so
 * without this test a runner claims the empty session, finds no user message
 * and reports a turn failure ("the session's transcript carries no user
 * message to answer") before the message that was about to arrive. Only a
 * session with something to answer is offered; the append of the user message
 * wakes the pool (see appendEvents), so pickup is still immediate.
 */
function sessionHasPrompt(session) {
  return (Array.isArray(session?.events) ? session.events : []).some(hasAnswerableContent);
}

export function createRunnerBackend({
  stateDir, log = console, poolName = null, wakeRunner = null,
  // The smoke drives wake attempts one after another; production leaves the
  // default so a burst becomes one startVM call.
  wakeCooldownMs = 15000,
} = {}) {
  const statePath = join(stateDir, stateFileName);
  // A smoke (or an operator's tool) may pass only `log.log`; warnings must not
  // turn into a TypeError inside the watchdog.
  const warn = typeof log.warn === "function" ? log.warn.bind(log) : log.log.bind(log);
  let cache = null;
  // UI reads (the folder browser, git info and branch lists behind the Code
  // composer's start options) reach the runner inside the account's Cowork VM,
  // and that VM idle-stops. A read after the VM has gone quiet used to answer
  // "no guest runner is online" — so the folder picker was dead and the
  // composer's git queries kept retrying until the user placed a session, the
  // only other thing that wakes the VM. Wake it on demand and let it register
  // its first poll before the read is refused. One wake is shared by every
  // read in flight.
  let wakeInFlight = null;
  const runnerWakeTimeoutMs = (() => {
    const raw = Number(process.env.CLAUDESK_RUNNER_WAKE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 20000;
  })();
  // How long a UI read waits for the VM wake before answering unavailable. The
  // wake itself keeps running — `startVM` can take a minute on a cold VM — but
  // the folder picker must not sit on "Loading server folders…" for that long;
  // the route falls back to the workspace mount and the next open finds the
  // runner online.
  const runnerWakeWaitMs = (() => {
    const raw = Number(process.env.CLAUDESK_RUNNER_WAKE_WAIT_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
  })();
  // A poll authenticated by a runner_token is attributable to that runner; the
  // shared pool secret (an older runner) can only say "someone on the pool
  // polled". Prefer attributed records when there are any, so a dead
  // registration refreshed by another runner's broad poll cannot look online
  // — and its version cannot make the request lane look available.
  const lastSeen = (runner) => runner.last_runner_poll_at ?? runner.last_poll_at;
  function onlineRunners(state, pool) {
    const now = Date.now();
    const fresh = (runner) => {
      const stamp = lastSeen(runner);
      return typeof stamp === "string" && now - Date.parse(stamp) < runnerOnlineWindowMs;
    };
    const all = state.runners.filter(
      (runner) => runner.pool_id === pool.pool_id && fresh(runner));
    const attributed = all.filter(
      (runner) => typeof runner.last_runner_poll_at === "string");
    return attributed.length ? attributed : all;
  }
  const runnerOnline = (state, pool) => onlineRunners(state, pool).length > 0;
  function liveRunner(state, pool) {
    return [...onlineRunners(state, pool)].sort((a, b) =>
      Date.parse(lastSeen(b) || 0) - Date.parse(lastSeen(a) || 0)
      || Date.parse(b.registered_at || 0) - Date.parse(a.registered_at || 0))[0] ?? null;
  }
  // The UI request lane (`requests` beside `hints` on the poll) is guest runner
  // 2.0.2+. An older runner accepts the poll and silently ignores the key, so
  // every folder/branch lookup burns the full timeout and reads as a hang. Say
  // so at once instead: 501 is "this runner cannot do that", not "try later".
  const requestLaneVersion = [2, 0, 2];
  // Methods newer than the lane itself. Context usage needs the runner that
  // asks the agent for the breakdown at turn end; an older runner answers
  // "unknown request method", which would surface as an error instead of a
  // breakdown.
  const runnerMethodMinimums = new Map([
    ["get_context_usage", [2, 5, 0]],
  ]);
  function versionParts(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
    return text.split(".").map((part) => Number(part));
  }
  function versionAtLeast(value, minimum) {
    const parts = versionParts(value);
    if (!parts) return false;
    for (let index = 0; index < minimum.length; index += 1) {
      const mine = parts[index] ?? 0;
      if (mine !== minimum[index]) return mine > minimum[index];
    }
    return true;
  }
  // Long polls. A runner that says how long it is willing to wait
  // (`x-claudesk-poll-wait: <seconds>`) has an empty poll held open until a
  // placement, a requeue or a retry wakes its pool — the runner then draws the
  // work on the same request instead of on its next timed tick. Opt-in by
  // header, so the product's own runner (and every caller that expects an
  // immediate answer) keeps the prompt-response contract.
  const pollWaiters = new Map();
  const pollHoldCapMs = (() => {
    const raw = Number(process.env.COWORK_BRIDGE_POLL_HOLD_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 20000;
  })();

  function pollWait(headers) {
    const asked = Number(headers?.["x-claudesk-poll-wait"]);
    if (!Number.isFinite(asked) || asked <= 0) return 0;
    return Math.min(asked * 1000, pollHoldCapMs);
  }

  function waitForPool(poolId, holdMs, socket = null) {
    return new Promise((resolve) => {
      let set = pollWaiters.get(poolId);
      if (!set) {
        set = new Set();
        pollWaiters.set(poolId, set);
      }
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        if (!set.size) pollWaiters.delete(poolId);
        if (socket) socket.off?.("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, holdMs);
      set.add(finish);
      // A guest that suspended, restarted or lost the network leaves this
      // request open on our side. Its waiter must go with the connection: a
      // wake that completes it would otherwise let a dead client claim the
      // session that was just placed (`offered`, delivered nowhere, no runner
      // holding it). The socket's own close is the signal — `IncomingMessage`
      // emits `close` on completion too, so it cannot be used for this.
      if (socket) socket.once?.("close", finish);
    });
  }

  // Whether the request that asked for work is still able to receive the
  // answer. A held poll that lost its client must not take a session out of
  // the queue on the way out.
  function requestAlive(request) {
    if (!request) return true;
    if (request.aborted === true) return false;
    return request.socket?.destroyed !== true;
  }

  function wakePool(poolId) {
    for (const finish of [...(pollWaiters.get(poolId) ?? [])]) finish();
  }

  // Start the VM a queued or requeued session needs. `wakeRunner` is the
  // Desktop's startVM; it is best-effort (a Desktop that refuses leaves the
  // session waiting, exactly as before) and must not delay the state
  // transition. One wake is not a guarantee: the VM may be mid-shutdown, the
  // Desktop may refuse, or the guest may power down between the wake and its
  // runner's first poll — which is why the reaper keeps asking while a session
  // is still pending (see reapSessions).
  let lastWakeAt = 0;
  function wakeTurnRunner() {
    if (typeof wakeRunner !== "function") return;
    // A burst of messages (or a reaper pass) must not turn into a burst of
    // startVM calls. The VM only needs one wake; a failed one is retried by
    // the next requeue or the pending watchdog after the cooldown.
    const now = Date.now();
    if (now - lastWakeAt < wakeCooldownMs) return;
    lastWakeAt = now;
    try {
      Promise.resolve(wakeRunner()).catch((error) => {
        warn(`[code-runners] could not start the VM for a pending session: ${error?.message || error}`);
      });
    } catch (error) {
      warn(`[code-runners] could not start the VM for a pending session: ${error?.message || error}`);
    }
  }

  function runnerClaims(runner) {
    const ids = new Set();
    for (const key of ["running_sessions", "claimed_sessions"]) {
      if (!Array.isArray(runner?.[key])) continue;
      for (const id of runner[key]) if (typeof id === "string") ids.add(id);
    }
    return ids;
  }

  // Does a live runner that reports claims still hold this session? Used by the
  // offer lease: a guest can hold a hint while it waits for a turn slot, and
  // re-offering that hint would start the same session twice.
  function sessionClaimedByReportingRunner(state, session) {
    const pool = poolById(state, session.pool_id);
    if (!pool) return false;
    return onlineRunners(state, pool)
      .filter((runner) => runner.claims_reported === true)
      .some((runner) => runnerClaims(runner).has(session.session_uuid));
  }

  // Does a live runner still hold this session (for reaping an active turn)? A
  // runner from before the claim report existed cannot say, so it is believed
  // rather than reaped on a guess.
  function sessionHeldByRunner(state, session) {
    const pool = poolById(state, session.pool_id);
    if (!pool) return false;
    const reporters = onlineRunners(state, pool)
      .filter((runner) => runner.claims_reported === true);
    if (!reporters.length) return true;
    return reporters.some((runner) => runnerClaims(runner).has(session.session_uuid));
  }

  // Was the last thing the transcript says a user message with no terminal?
  // That is the one case where losing the runner should retry the turn.
  function unansweredUserMessage(session) {
    const events = Array.isArray(session.events) ? session.events : [];
    let lastUser = -1;
    let lastResult = -1;
    events.forEach((event, index) => {
      const payload = event?.payload ?? {};
      if (payload.type === "result") lastResult = index;
      else if (event?.source !== "worker" && isUserMessage(event)) lastUser = index;
    });
    return lastUser > lastResult;
  }

  function turnHasTerminal(session) {
    const events = Array.isArray(session.events) ? session.events : [];
    let lastUser = -1;
    events.forEach((event, index) => {
      if (event?.source !== "worker" && isUserMessage(event)) lastUser = index;
    });
    for (let index = Math.max(0, lastUser); index < events.length; index += 1) {
      if ((events[index]?.payload ?? {}).type === "result") return true;
    }
    return false;
  }

  // End a turn whose runner disappeared. The transcript gets the terminal its
  // reader closes the turn on; the session either goes back on the pool once
  // more (an unanswered message is retried, up to `reapAttemptLimit`) or idle.
  async function reapLostTurn(session, reason) {
    await ensureEvents(session);
    // Read the intent *before* the terminal lands: after the synthetic result,
    // the transcript reads as answered and the retry decision would flip.
    const unanswered = unansweredUserMessage(session);
    if (!turnHasTerminal(session)) {
      const appended = appendToSession(session,
        [{ payload: lostTurnResult(reason) }], "worker");
      await appendEventsFile(session, appended);
      emitLive(session, appended);
    }
    const attempts = Number(session.reap_attempts) || 0;
    const retry = unanswered && attempts < reapAttemptLimit;
    session.state = retry ? "pending" : "released";
    delete session.offered_at;
    session.assigned_runner_id = undefined;
    clearInterrupted(session);
    session.failure = { reason, failure_kind: "runner_lost" };
    if (retry) {
      session.reap_attempts = attempts + 1;
      session.attempt = (Number(session.attempt) || 0) + 1;
      wakePool(session.pool_id);
      wakeTurnRunner();
    }
    warn(`[code-runners] session ${session.session_uuid}: `
      + `${retry ? "requeued" : "released"} after its runner was lost (${reason})`);
  }

  let reaping = false;
  // `nowOverride` exists for deterministic tests: a smoke advances the clock
  // instead of sleeping out a lease.
  async function reapSessions(nowOverride = null) {
    if (reaping) return;
    reaping = true;
    try {
      const state = await load();
      const now = Number.isFinite(nowOverride) ? nowOverride : Date.now();
      let changed = false;
      for (const session of [...state.sessions]) {
        const pool = poolById(state, session.pool_id);
        if (!pool) continue;
        if (session.state === "offered") {
          const since = Date.parse(session.offered_at || "") || 0;
          if (!since || now - since < offerLeaseMs) continue;
          // The guest can hold a hint while it waits for a turn slot (the
          // concurrency cap). Re-offering it would start the same session on a
          // second thread, so a live claim extends the lease.
          if (sessionClaimedByReportingRunner(state, session)) {
            session.offered_at = new Date(now).toISOString();
            changed = true;
            continue;
          }
          session.state = "pending";
          session.attempt = (Number(session.attempt) || 0) + 1;
          session.assigned_runner_id = undefined;
          delete session.offered_at;
          changed = true;
          wakePool(session.pool_id);
          warn(`[code-runners] session ${session.session_uuid}: `
            + "offer expired with no claim; re-offered");
          continue;
        }
        if (session.state !== "active") continue;
        const started = Date.parse(session.started_at || session.offered_at || "") || 0;
        if (!started) continue;
        const online = onlineRunners(state, pool);
        if (online.length === 0) {
          if (now - started < offlineReapGraceMs) continue;
          await reapLostTurn(session,
            "the runner went offline; this turn was interrupted");
          changed = true;
          continue;
        }
        const reporters = online.filter((runner) => runner.claims_reported === true);
        // An older runner cannot report claims; believe it rather than reap a
        // healthy turn. The next deploy replaces it with one that can.
        if (!reporters.length) continue;
        if (sessionHeldByRunner(state, session)) continue;
        if (now - started < claimReapGraceMs) continue;
        await reapLostTurn(session,
          "the runner stopped responding; this turn was interrupted");
        changed = true;
      }
      // A session waiting for a runner is a standing reason for its pool's VM
      // to be up. Placement asks the Desktop to start it, but that wake is
      // one-shot and easy to lose: a VM caught mid-shutdown, a Desktop that
      // refused while the renderer was busy, or a power-down between the wake
      // and the guest's first poll used to leave the session on "Waiting for a
      // runner…" forever, because nothing re-asked. Keep asking while one is
      // queued and its pool has no live runner; wakeTurnRunner's cooldown paces
      // it, and a runner that registers ends it.
      const waiting = state.sessions.some((session) => {
        if (session.state !== "pending" && session.state !== "offered") return false;
        const pool = poolById(state, session.pool_id);
        return Boolean(pool) && !runnerOnline(state, pool);
      });
      if (waiting) wakeTurnRunner();
      if (changed) await save();
    } catch (error) {
      warn(`[code-runners] session reaper failed: ${error?.message || error}`);
    } finally {
      reaping = false;
    }
  }

  // Cancellation notices a poll carries. The guest runner cannot be dialled,
  // so its held poll is also how a Stop reaches it: the bridge wakes the pool
  // and lists the ids whose turn must end. Interrupts stay listed while the
  // session is active (idempotent — the runner sets an event), and a deleted
  // session's id stays a short while so a poll racing the delete still sees it.
  function pruneCancellations(state, now = Date.now()) {
    if (!Array.isArray(state.cancellations)) {
      state.cancellations = [];
      return;
    }
    state.cancellations = state.cancellations.filter((entry) =>
      Number.isFinite(entry?.at_ms) && now - entry.at_ms < cancelTombstoneMs);
  }

  function addCancellationTombstone(state, session) {
    pruneCancellations(state);
    if (!session?.session_uuid) return;
    state.cancellations.push({
      session_uuid: session.session_uuid,
      pool_id: session.pool_id,
      at_ms: Date.now(),
    });
  }

  function emptyPoll(state, poolId) {
    return {
      hints: [],
      requests: [],
      cancellations: cancellationsFor(state, poolId),
      warm_hints: [],
      pending_count: 0,
      backing_off_count: 0,
      circuit_broken_count: 0,
      pool_pending_session_count: 0,
      pool_active_session_count: state.sessions.filter(
        (session) => session.pool_id === poolId && session.state === "active",
      ).length,
    };
  }

  function cancellationsFor(state, poolId, now = Date.now()) {
    pruneCancellations(state, now);
    const notices = [];
    for (const session of state.sessions) {
      if (session.pool_id !== poolId) continue;
      if (session.state !== "active" || !session.interrupt_requested_at) continue;
      notices.push({
        session_uuid: session.session_uuid,
        reason: "interrupt",
        ...(session.interrupt_request_id
          ? { request_id: session.interrupt_request_id } : {}),
      });
    }
    for (const entry of state.cancellations) {
      if (entry.pool_id !== poolId) continue;
      notices.push({ session_uuid: entry.session_uuid, reason: "deleted" });
    }
    return notices;
  }

  // Stamp the client messages a turn has taken, and queue the
  // `delivery_update` frames the page clears "Sending…" on. `through` bounds
  // it to the transcript the runner actually read (see recordClaim); the token
  // leg stamps everything present at claim time.
  function markProcessed(session, through = Infinity) {
    const processedAt = new Date().toISOString();
    session.delivery_updates = Array.isArray(session.delivery_updates)
      ? session.delivery_updates : [];
    for (const envelope of session.events ?? []) {
      if (envelope.source !== "client") continue;
      if ((envelope.payload ?? {}).type !== "user") continue;
      if (envelope.processing_at !== undefined) continue;
      if (Number(envelope.sequence_num) > through) continue;
      envelope.processing_at = processedAt;
      session.delivery_updates.push({
        event_id: envelope.event_id,
        status: "PROCESSING",
        timestamp: processedAt,
      });
    }
  }

  // Requests the guest runner answers for the web UI. A tenant's Code UI needs
  // a folder listing and git metadata *before* a session exists, and those must
  // come from inside the Cowork VM — the agent's sandbox — rather than from
  // this container, which is privileged (docs/code-in-cowork-vm.md). The
  // request rides the runner's own held poll (see pollSpawnHints) and resolves
  // when the runner posts its result back (respondRunnerRequest). Nothing is
  // persisted: a runner still polling is the only thing that can answer, and a
  // request that dies with the process is simply re-asked by the UI.
  const runnerRequests = new Map();
  const runnerRequestTimeoutMs = (() => {
    const raw = Number(process.env.CLAUDESK_RUNNER_REQUEST_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15000;
  })();
  const runnerRequestsPerPool = 32;
  // A registered runner that has not polled within this window is treated as
  // offline: queueing for it would only burn the request's timeout.
  const runnerOnlineWindowMs = 120000;

  // A request stays in the map until the runner answers (or it times out): the
  // entry holds the promise's resolver. `handed` only keeps the same request
  // from being offered to a second poll while the first runner works on it.
  function pendingRequestsFor(poolId) {
    return [...runnerRequests.entries()]
      .filter(([, request]) => request.pool_id === poolId && !request.handed);
  }

  function takeRunnerRequests(poolId) {
    const taken = [];
    for (const [requestId, request] of pendingRequestsFor(poolId)) {
      request.handed = true;
      taken.push({ request_id: requestId, method: request.method, params: request.params });
    }
    if (taken.length) {
      log.log(`[code-runners] handed ${taken.length} UI request(s) to a runner on pool ${poolId}`);
    }
    return taken;
  }

  function runnerUnavailable(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
  }

  // Start the VM the runner lives in, then wait for that runner's first poll.
  // Shared so a burst of reads (the composer asks for git info, branches and
  // the folder list together) wakes it once. A wake the Desktop refused is
  // final: polling after it would only hold the request until the timeout.
  function wakeRunnerForReads(pool) {
    if (!wakeRunner) return Promise.resolve();
    if (wakeInFlight) return wakeInFlight;
    wakeInFlight = (async () => {
      let started = true;
      try {
        started = await wakeRunner() !== false;
      } catch (error) {
        log.warn(`[code-runners] could not start the Cowork VM: ${error.message}`);
        started = false;
      }
      if (!started) return;
      const deadline = Date.now() + runnerWakeTimeoutMs;
      while (Date.now() < deadline) {
        const current = await load();
        if (runnerOnline(current, pool)) {
          log.log(`[code-runners] guest runner came online after waking the Cowork VM`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })().finally(() => { wakeInFlight = null; });
    return wakeInFlight;
  }

  async function askRunner(method, params) {
    let state = await load();
    const pool = state.pools[0];
    if (!pool) {
      throw runnerUnavailable("no self-hosted runner pool is configured", 503);
    }
    if (!runnerOnline(state, pool)) {
      await Promise.race([
        wakeRunnerForReads(pool),
        new Promise((resolve) => setTimeout(resolve, runnerWakeWaitMs)),
      ]);
      state = await load();
    }
    if (!runnerOnline(state, pool)) {
      throw runnerUnavailable("no guest runner is online", 503);
    }
    const live = liveRunner(state, pool);
    const minimumVersion = runnerMethodMinimums.get(method) ?? requestLaneVersion;
    if (live && !versionAtLeast(live.runner_version, minimumVersion)) {
      const capability = method === "get_context_usage"
        ? "context usage" : "folder and branch lookups";
      throw runnerUnavailable(
        `the guest runner is version ${live.runner_version || "unknown"}; `
        + `${capability} need${method === "get_context_usage" ? "s" : ""} the runner `
        + `from this deployment (${minimumVersion.join(".")} or newer). `
        + "Refresh it with scripts/install-guest-runner.sh or deploy.sh.", 501);
    }
    const outstanding = [...runnerRequests.values()]
      .filter((request) => request.pool_id === pool.pool_id).length;
    if (outstanding >= runnerRequestsPerPool) {
      throw runnerUnavailable("too many runner requests are pending", 429);
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = runnerRequests.get(requestId);
        runnerRequests.delete(requestId);
        log.warn(`[code-runners] UI request ${entry?.method ?? requestId} timed out `
          + `(${entry?.handed ? "handed to a runner" : "no runner took it"})`);
        reject(runnerUnavailable(entry?.handed
          ? "the guest runner took the request but did not answer"
          : "no guest runner polled to take the request", 504));
      }, runnerRequestTimeoutMs);
      runnerRequests.set(requestId, {
        pool_id: pool.pool_id,
        method,
        params,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      log.log(`[code-runners] UI request ${method} queued on pool ${pool.pool_id}`);
      wakePool(pool.pool_id);
    });
  }

  // Answer a renderer's `get_context_usage` control request with the agent's
  // own answer. The request is already in the transcript (the renderer
  // appended it); the request lane carries it to the guest, and the reply is
  // appended as the `control_response` the renderer's control transport is
  // waiting on. Fire-and-forget: the POST that carried the request has already
  // been answered, and the renderer waits on the session stream, not that POST.
  async function answerContextUsage(sessionId, { requestId, detail }) {
    let usage = null;
    let failure = null;
    const before = await load().catch(() => null);
    const beforeSession = before ? sessionById(before, sessionId) : null;
    if (!beforeSession) return;
    // The answer the runner kept was computed with the settings that shaped
    // its last turn. Naming them lets it refuse a stale answer after a model
    // or mode change (the next turn refreshes it).
    const config = sessionConfigOf(beforeSession);
    try {
      usage = await askRunner("get_context_usage", {
        session_uuid: sessionId,
        ...(detail === "summary" || detail === "full" ? { detail } : {}),
        ...(typeof config.model === "string" && config.model
          ? { model: config.model } : {}),
        ...(typeof config.permission_mode === "string" && config.permission_mode
          ? { permission_mode: config.permission_mode } : {}),
        ...(typeof config.effort_level === "string" && config.effort_level
          ? { effort_level: config.effort_level } : {}),
      });
      if (!isRecord(usage) || !("rawMaxTokens" in usage)) {
        failure = "the guest runner returned no context usage";
        usage = null;
      }
    } catch (error) {
      failure = error?.message || String(error);
    }
    const state = await load().catch(() => null);
    const session = state ? sessionById(state, sessionId) : null;
    if (!session) return;
    await ensureEvents(session);
    const response = usage
      ? { subtype: "success", request_id: requestId, response: usage }
      : {
        subtype: "error",
        request_id: requestId,
        error: failure || "context usage is unavailable",
      };
    const appended = appendToSession(session, [{
      payload: { type: "control_response", response },
    }], "worker");
    if (!appended.length) return;
    await appendEventsFile(session, appended);
    emitLive(session, appended);
    await save();
    if (usage) {
      log.log(`[code-runners] session ${sessionId}: context usage answered `
        + `(${usage.totalTokens ?? "?"} / ${usage.rawMaxTokens ?? "?"} tokens)`);
    } else {
      log.warn(`[code-runners] session ${sessionId}: context usage unavailable: ${failure}`);
    }
  }

  // Transcripts live one file per session, append-only. The metadata store
  // (`code-runners.json`) is rewritten by every mutation and used to carry the
  // whole transcript inline — so appending one stream event rewrote every
  // session's history. An event append is now O(that event): one line in one
  // session's file, while the metadata document stays small.
  const eventsDir = join(stateDir, "events");
  function eventsPathFor(session) {
    const name = String(session?.session_uuid ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
    return join(eventsDir, `${name}.jsonl`);
  }

  // Per-session serialization for file work: a compaction must not race an
  // append (or another compaction) on the same file.
  const eventChains = new Map();
  function eventChain(session, task) {
    const key = String(session?.session_uuid ?? "");
    const previous = eventChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    eventChains.set(key, next);
    next.catch(() => undefined).then(() => {
      if (eventChains.get(key) === next) eventChains.delete(key);
    });
    return next;
  }

  // Live subscribers: the session page's SSE response. Appended events are
  // pushed straight to them, so the page's text advances with the agent instead
  // of on the old 500 ms rescan.
  const liveSubscribers = new Map();
  function emitLive(session, events) {
    if (!events?.length) return;
    const listeners = liveSubscribers.get(session.session_uuid);
    if (!listeners?.size) return;
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // That response is gone; its own close handler unsubscribes.
        }
      }
    }
  }

  function subscribeEvents(sessionId, listener) {
    const session = cache ? sessionById(cache, sessionId) : undefined;
    const key = session?.session_uuid ?? String(sessionId ?? "");
    let listeners = liveSubscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      liveSubscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) liveSubscribers.delete(key);
    };
  }

  // Keep only a bounded number of transcripts resident. A session with an open
  // stream or a running turn stays; the rest are re-read from their file on the
  // next request.
  const loadedSessions = new Map();
  const maxLoadedSessions = Math.max(
    2,
    Number(process.env.CLAUDESK_RUNNER_LOADED_SESSIONS) || 16,
  );
  function touchLoaded(session) {
    loadedSessions.delete(session.session_uuid);
    loadedSessions.set(session.session_uuid, Date.now());
    for (const id of [...loadedSessions.keys()]) {
      if (loadedSessions.size <= maxLoadedSessions) break;
      const candidate = cache ? sessionById(cache, id) : undefined;
      if (!candidate) {
        loadedSessions.delete(id);
        continue;
      }
      if (liveSubscribers.get(id)?.size) continue;
      if (candidate.state === "active" || candidate.state === "offered") continue;
      candidate.events = [];
      candidate.eventsLoaded = false;
      loadedSessions.delete(id);
    }
  }

  /**
   * Load one session's durable transcript, lazily.
   *
   * The old `load()` read every session's whole file at bridge start, which
   * made boot time and resident memory a function of the account's entire Code
   * history. This reads one file when a turn or a page actually needs it, and
   * the same pass drops the live-only `stream_event` lines an older store
   * persisted (atomic temp+rename), shrinking the file once.
   */
  async function ensureEvents(session) {
    if (session.eventsLoaded === true) return session.events;
    return eventChain(session, async () => {
      if (session.eventsLoaded === true) return session.events;
      const path = eventsPathFor(session);
      const durable = [];
      let highest = Number(session.last_sequence) || 0;
      let dropped = 0;
      let temporary = null;
      try {
        const input = createReadStream(path, { encoding: "utf8" });
        const lines = createInterface({ input, crlfDelay: Infinity });
        temporary = `${path}.${randomUUID()}.tmp`;
        const output = createWriteStream(temporary, { mode: 0o600 });
        try {
          for await (const line of lines) {
            if (!line || !line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (isVolatileEvent(event)) {
              dropped += 1;
              continue;
            }
            durable.push(event);
            highest = Math.max(highest, Number(event.sequence_num) || 0);
            if (!output.write(`${line}\n`)) {
              await new Promise((resolve) => output.once("drain", resolve));
            }
          }
        } finally {
          await new Promise((resolve) => output.end(resolve));
        }
        if (dropped) {
          await rename(temporary, path);
          temporary = null;
          log.log(`[code-runners] session ${session.session_uuid}: `
            + `removed ${dropped} live-only event(s) from history`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          log.warn(`[code-runners] could not read the transcript of `
            + `${session.session_uuid}: ${error?.message || error}`);
        }
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      }
      session.events = durable;
      session.last_sequence = Math.max(highest, Number(session.last_sequence) || 0);
      session.eventsLoaded = true;
      touchLoaded(session);
      return session.events;
    });
  }

  function isVolatileEvent(event) {
    return isVolatilePayload(event?.payload ?? {});
  }

  /** `sessionHasPrompt` for a session whose transcript may still be on disk —
   *  `load()` keeps most sessions lazy (see ensureEvents), so reading the
   *  in-memory array alone would miss a pending session after a restart. */
  async function sessionHasPromptOnDisk(session) {
    await ensureEvents(session);
    return sessionHasPrompt(session);
  }

  function appendEventsFile(session, appended) {
    if (!appended.length) return Promise.resolve();
    return eventChain(session, async () => {
      await mkdir(eventsDir, { recursive: true });
      await appendFile(eventsPathFor(session),
        appended.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
    });
  }

  function metadataOnly(state) {
    return {
      ...state,
      sessions: state.sessions.map((session) => {
        const { events, eventsLoaded, ...rest } = session;
        return rest;
      }),
    };
  }

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      cache = {
        pools: Array.isArray(parsed?.pools) ? parsed.pools : [],
        runners: Array.isArray(parsed?.runners) ? parsed.runners : [],
        sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
        // Ids of sessions that were deleted (or otherwise removed) while a
        // runner might still be running them. A runner learns to stop from its
        // poll; the record itself is already gone, so the tombstone is the
        // only place to carry the id. Pruned by age (see pruneCancellations).
        cancellations: Array.isArray(parsed?.cancellations) ? parsed.cancellations : [],
      };
    } catch {
      cache = { pools: [], runners: [], sessions: [], cancellations: [] };
    }
    // Sessions the store held before ids spoke the wire's encoding get re-minted
    // here, once, from the uuid they already carry: a bare uuid is classified
    // "local" by every reader in the app (its meta fetch answers null before it
    // ever asks the bridge, and the page says "This session couldn't be
    // found"), and an id the runner cannot decode breaks the child's setup.
    // Lookups keep answering every old spelling (see sessionById), so a page
    // already open on one heals on its next request.
    let migrated = false;
    for (const session of cache.sessions) {
      if (typeof session.session_uuid !== "string") continue;
      const bare = bareSessionId(session.session_uuid);
      const canonical = /^[0-9a-f]{32}$/.test(bare)
        ? `cse_${bare.slice(0, 12)}_01${base58OfHex(bare)}`
        : session.session_uuid;
      if (session.session_uuid !== canonical) {
        session.session_uuid = canonical;
        migrated = true;
      }
      // The pool's name travels on the session document (`pool_name` inside
      // `self_hosted_runner_state`); sessions created before that field existed
      // get it backfilled from their pool.
      if (typeof session.pool_name !== "string") {
        const pool = poolById(cache, session.pool_id);
        if (pool) {
          session.pool_name = pool.name;
          migrated = true;
        }
      }
    }
    // Split an older store's inline transcripts into their per-session files
    // once; the metadata document that remains no longer carries them. The
    // files themselves are read lazily (see ensureEvents), not here: boot time
    // must not scale with every transcript the account ever produced.
    let eventsMigrated = false;
    for (const session of cache.sessions) {
      if (typeof session.session_uuid !== "string") continue;
      if (Array.isArray(session.events)) {
        const path = eventsPathFor(session);
        const exists = await readFile(path, "utf8").then(() => true, () => false);
        if (!exists && session.events.length) {
          await mkdir(eventsDir, { recursive: true });
          await writeFile(path,
            session.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
            { mode: 0o600 });
        }
        const highest = session.events.reduce(
          (high, event) => Math.max(high, Number(event.sequence_num) || 0), 0);
        session.last_sequence = Math.max(Number(session.last_sequence) || 0, highest);
        delete session.events;
        eventsMigrated = true;
      }
      session.eventsLoaded = false;
      if (session.last_sequence !== undefined) {
        session.last_sequence = Number(session.last_sequence) || 0;
      }
    }
    if (eventsMigrated) migrated = true;
    // The deployment names this instance's pool, and a pool the operator named
    // is created on first use so a runner can be pointed at it without anyone
    // clicking through the admin UI.
    if (poolName && !cache.pools.some((pool) => pool.name === poolName)) {
      cache.pools.push({
        pool_id: newPoolId(),
        name: poolName,
        secret: newSecret(),
        status: "active",
        created_at: new Date().toISOString(),
      });
      await save();
      migrated = false;
    }
    if (migrated) await save();
    return cache;
  }

  // The store is one JSON document, and a runner appends a *batch* of stream
  // events several times a second while a turn is answering. Rewriting the
  // whole document on each append (and making the runner wait for it) bounded
  // a fast model at the store's write rate. Event appends therefore update the
  // in-memory state and schedule a write; the debounce coalesces the burst.
  // Every other mutation keeps the synchronous `save`, so a session creation
  // or a runner registration is still durable before its response.
  const saveDebounceMs = Math.max(0,
    Number(process.env.CLAUDESK_RUNNER_STATE_DEBOUNCE_MS ?? 100) || 0);
  let saveTimer = null;
  let savePending = false;
  let saveChain = Promise.resolve();

  async function persist(state) {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${statePath}.${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(metadataOnly(state))}\n`);
    await rename(tmp, statePath);
  }

  function persistCurrent() {
    saveChain = saveChain.then(() => persist(cache)).catch((error) => {
      log.warn(`[code-runners] could not persist state: ${error?.message || error}`);
    });
    return saveChain;
  }

  async function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    savePending = false;
    await persistCurrent();
  }

  function saveSoon() {
    savePending = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!savePending) return;
      savePending = false;
      void persistCurrent();
    }, saveDebounceMs);
    saveTimer.unref?.();
  }

  // Flush a debounced write before the process leaves (deploy, restart).
  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (savePending) {
      savePending = false;
      await persistCurrent();
    } else {
      await saveChain;
    }
  }

  function poolById(state, poolId) {
    return state.pools.find((pool) => pool.pool_id === poolId) ?? null;
  }

  // Advertised places are this instance's active pools. A pool exists from the
  // moment the bridge starts, whether or not its runner has polled yet, and it
  // is always the one place a session can go: placing one wakes the VM (the
  // create route calls `wakeRunnerVm`). Filtering to pools with a registered
  // runner made the place vanish for a fresh account — the Code composer and the
  // routine form's environment picker were empty ("Select a cloud environment")
  // until the user had started a session somewhere else first. The pool is what
  // the deployment offers, so it is what the list carries; `poolEnvironment`
  // still marks a disabled pool as unknown.
  async function environments() {
    const state = await load();
    return state.pools
      .map((pool) => poolEnvironment(pool, { online: true }))
      .filter((environment) => environment.state === "active");
  }

  // Which pool a runner call belongs to, from its credential: the pool secret
  // itself, or a `runner_token` the register leg handed out — the product's own
  // runner switches to that token right after registering. A wrong credential
  // and an unknown pool are the same answer: no pool.
  function poolForSecret(state, headers) {
    const token = bearerToken(headers);
    if (!token) return null;
    const bySecret = state.pools.find((pool) => pool.secret === token);
    if (bySecret) return bySecret;
    const byToken = state.runners.find((runner) => runner.runner_token === token);
    if (byToken) {
      return state.pools.find((pool) => pool.pool_id === byToken.pool_id) ?? null;
    }
    return null;
  }

  // The runner a credential names, when it is a per-runner token rather than
  // the pool's shared secret. Null means "the pool secret", which a legacy
  // runner still polls with.
  function runnerByToken(state, headers) {
    const token = bearerToken(headers);
    if (!token) return null;
    return state.runners.find((runner) => runner.runner_token === token) ?? null;
  }

  // Session-scoped calls carry the session token the runner was issued, or a
  // pool credential (the pool secret, or a runner_token of a runner serving
  // that pool). Anything else is refused — the runner's own retry loop backs
  // off on that, which is the correct outcome for a credential that names
  // nothing here.
  function sessionFor(state, headers, sessionId) {
    const session = sessionById(state, sessionId);
    if (!session) return null;
    const token = bearerToken(headers);
    if (!token) return { unauthorized: true };
    if (session.session_token === token) return session;
    const pool = poolForSecret(state, headers);
    if (pool && pool.pool_id === session.pool_id) return session;
    return { unauthorized: true };
  }

  // A pending session, in the shape the runner's poll reader expects. The
  // `work_order_jwt` is the runner's opaque order token; nothing here verifies
  // it, but the field is non-optional so it must be a string.
  function hintFor(session) {
    return {
      session_uuid: session.session_uuid,
      attempt: session.attempt,
      work_order_jwt: session.work_order_jwt,
      // Sources live in the session's `config` now (the create body's shape);
      // sessions the store held before that keep them top-level, and both are
      // read (see sessionConfigOf).
      sources: sessionConfigOf(session).sources,
    };
  }

  // The watchdog for a turn whose runner vanished. Every transition it makes
  // is one a live runner would otherwise have made with its release/failure
  // report; without it a lost runner (VM idle-stop, guest OOM, restart) leaves
  // the session `active` forever and every later message hangs on "Sending…".
  if (reapIntervalMs > 0) {
    setInterval(() => { void reapSessions(); }, reapIntervalMs).unref?.();
  }

  return {
    // Flush a debounced event write before the process leaves (see saveSoon).
    flush,
    // Run the lost-runner watchdog now. The interval arm is what does this in
    // production; the smokes (and an operator debugging a wedged session) call
    // it directly instead of waiting out the tick.
    reapNow: reapSessions,
    // Push appended events to a live reader (the session page's SSE response).
    // Returns the unsubscribe function.
    subscribeEvents,

    /**
     * Does this Authorization header name one of this instance's pool
     * secrets? The runner's model calls come through the bridge carrying the
     * same secret it polls with, so this is the pass for them.
     */
    async verifyPoolSecret({ headers } = {}) {
      const token = bearerToken(headers);
      if (!token) return false;
      const state = await load();
      return state.pools.some((pool) => pool.secret === token);
    },

    /** GET /v1/code/runners/self-hosted/pools */
    async listPools() {
      const state = await load();
      return { pools: state.pools.map(publicPool) };
    },

    /** POST /v1/code/runners/self-hosted/pools */
    async createPool({ body } = {}) {
      const state = await load();
      const name = typeof body?.name === "string" && body.name.trim()
        ? body.name.trim() : "Self-hosted pool";
      const pool = {
        pool_id: newPoolId(),
        name,
        secret: newSecret(),
        status: "active",
        created_at: new Date().toISOString(),
      };
      state.pools.push(pool);
      await save();
      log.log(`[code-runners] created pool ${pool.pool_id} (${pool.name})`);
      return { pool: publicPool(pool) };
    },

    /** GET|PATCH|DELETE /v1/code/runners/self-hosted/pools/{id} */
    async getPool({ poolId }) {
      const state = await load();
      const pool = poolById(state, poolId);
      return pool ? { pool: publicPool(pool) } : null;
    },

    async updatePool({ poolId, body } = {}) {
      const state = await load();
      const pool = poolById(state, poolId);
      if (!pool) return null;
      if (typeof body?.name === "string" && body.name.trim()) pool.name = body.name.trim();
      if (body?.status === "active" || body?.status === "disabled") pool.status = body.status;
      await save();
      return { pool: publicPool(pool) };
    },

    async removePool({ poolId }) {
      const state = await load();
      const index = state.pools.findIndex((pool) => pool.pool_id === poolId);
      if (index === -1) return null;
      state.pools.splice(index, 1);
      state.runners = state.runners.filter((runner) => runner.pool_id !== poolId);
      await save();
      return {};
    },

    /** GET /v1/code/runners/self-hosted/pools/{id}/secrets */
    async poolSecrets({ poolId }) {
      const state = await load();
      const pool = poolById(state, poolId);
      if (!pool) return null;
      return { pool_secret: pool.secret, secrets: [{ value: pool.secret }] };
    },

    /** GET /v1/code/runners/self-hosted/pools/{id}/sessions */
    async poolSessions({ poolId, searchParams } = {}) {
      const state = await load();
      const sessions = state.sessions
        .filter((session) => session.pool_id === poolId)
        .map((session) => ({
          session_uuid: session.session_uuid,
          state: session.state,
          attempt: session.attempt,
          created_at: session.created_at,
        }));
      const limit = Number(searchParams?.get?.("limit") ?? 0) || sessions.length;
      return { data: sessions.slice(0, limit), next_cursor: null };
    },

    /** POST /v1/code/runners/self-hosted/runners/register */
    async registerRunner({ headers, body } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const runner = {
        runner_id: `ccrunner_${randomBytes(12).toString("hex")}`,
        // The product's own runner switches to this token for every later call
        // (the 4-token chain's second hop); the register answer carries it.
        runner_token: `ccrun_${randomBytes(24).toString("base64url")}`,
        pool_id: pool.pool_id,
        runner_version: body?.runner_version ?? "",
        client_label: body?.client_label ?? "",
        registered_at: new Date().toISOString(),
        last_poll_at: null,
        last_runner_poll_at: null,
      };
      // A restart re-registers with the same client label; the previous record
      // is the same worker, not a second one. Keeping it left a growing list
      // of versions (and made a dead 2.0.2 registration able to vouch for the
      // request lane while the live runner was older).
      if (runner.client_label) {
        state.runners = state.runners.filter(
          (existing) => !(existing.pool_id === pool.pool_id
            && existing.client_label === runner.client_label),
        );
      }
      state.runners.push(runner);
      await save();
      log.log(`[code-runners] runner ${runner.runner_id} registered on pool ${pool.pool_id}`
        + ` (version ${runner.runner_version || "unknown"})`);
      return { runner_id: runner.runner_id, runner_token: runner.runner_token };
    },

    /** POST /v1/code/runners/self-hosted/deregister */
    async deregisterRunner({ headers, body } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const runnerId = body?.runner_id;
      state.runners = state.runners.filter(
        (runner) => !(runner.pool_id === pool.pool_id && (!runnerId || runner.runner_id === runnerId)),
      );
      await save();
      return {};
    },

    /** POST /v1/code/runners/self-hosted/spawn-hints/poll */
    async pollSpawnHints({ headers, request = null, body = null } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const now = new Date().toISOString();
      const poller = runnerByToken(state, headers);
      for (const runner of state.runners) {
        if (runner.pool_id !== pool.pool_id) continue;
        // A token poll names its runner; the pool secret cannot, so an older
        // runner still refreshes the whole pool's records (as it always did).
        if (poller && runner.runner_id !== poller.runner_id) continue;
        runner.last_poll_at = now;
        if (poller) runner.last_runner_poll_at = now;
      }
      // The sessions this runner still holds. The reaper reconciles an
      // `active` session against this set: absent from every live runner's
      // claims means the turn died with the process (VM stop, OOM, restart),
      // and nothing else will ever release it.
      if (poller) {
        const ids = (value) => (Array.isArray(value) ? value : [])
          .filter((id) => typeof id === "string" && id).slice(0, 500);
        if (Array.isArray(body?.running) || Array.isArray(body?.claimed)) {
          poller.running_sessions = ids(body?.running);
          poller.claimed_sessions = ids(body?.claimed);
          poller.claims_reported = true;
          poller.claims_at = now;
        }
      }
      await save();
      // Nothing may be handed to a poll that can no longer receive an answer
      // (a guest that suspended or restarted leaves its held request open on
      // our side). Claiming a session or a UI request for it would strand
      // them: the session would read `offered` with no runner holding it.
      if (!requestAlive(request)) return emptyPoll(state, pool.pool_id);
      // A placement precedes the composer's first message; do not hand the
      // empty session to a runner (see sessionHasPrompt). The transcript may
      // be lazy after a restart, so this is asynchronous.
      const mine = [];
      for (const session of state.sessions) {
        if (session.pool_id !== pool.pool_id || session.state !== "pending") continue;
        if (await sessionHasPromptOnDisk(session)) mine.push(session);
      }
      // A session is handed out once; the runner's nack puts it back. The
      // offer timestamp is the lease the reaper uses when the answer never
      // lands (or the runner dies before claiming it).
      for (const session of mine) {
        session.state = "offered";
        session.offered_at = now;
        // A new turn re-reads the transcript; until it reports how far it got
        // (recordClaim), no message can be called mid-turn.
        delete session.claimed_through;
      }
      if (mine.length) await save();
      // UI requests queued for the guest (folder and git lookups) ride this
      // same poll: the runner answers them from inside the VM and posts the
      // result back. They wake a held poll just like a placement does.
      let requests = takeRunnerRequests(pool.pool_id);
      // Nothing to hand out: a runner that said how long it can wait gets its
      // poll held until a placement, a requeue or a UI request wakes the pool
      // (see wakePool) — the difference between "picked up on the next tick"
      // and "picked up now".
      const holdMs = mine.length || requests.length ? 0 : pollWait(headers);
      if (holdMs > 0) {
        await waitForPool(pool.pool_id, holdMs, request?.socket ?? null);
        const refreshed = await load();
        if (!requestAlive(request)) return emptyPoll(refreshed, pool.pool_id);
        const later = [];
        for (const session of refreshed.sessions) {
          if (session.pool_id !== pool.pool_id || session.state !== "pending") continue;
          if (await sessionHasPromptOnDisk(session)) later.push(session);
        }
        const offeredAt = new Date().toISOString();
        for (const session of later) {
          session.state = "offered";
          session.offered_at = offeredAt;
          delete session.claimed_through;
        }
        if (later.length) await save();
        requests = takeRunnerRequests(pool.pool_id);
        return {
          hints: later.map(hintFor),
          requests,
          // A Stop that landed while the poll was held (see appendEvents).
          cancellations: cancellationsFor(refreshed, pool.pool_id),
          warm_hints: [],
          pending_count: later.length,
          backing_off_count: 0,
          circuit_broken_count: 0,
          pool_pending_session_count: later.length,
          pool_active_session_count: refreshed.sessions.filter(
            (session) => session.pool_id === pool.pool_id && session.state === "active",
          ).length,
        };
      }
      return {
        hints: mine.map(hintFor),
        requests,
        cancellations: cancellationsFor(state, pool.pool_id),
        warm_hints: [],
        pending_count: mine.length,
        backing_off_count: 0,
        circuit_broken_count: 0,
        pool_pending_session_count: mine.length,
        pool_active_session_count: state.sessions.filter(
          (session) => session.pool_id === pool.pool_id && session.state === "active",
        ).length,
      };
    },

    /**
     * POST /v1/code/runners/self-hosted/runners/{id}/poll — `PollWork`, the
     * poll the shipped runner actually uses (the spawn-hints leg above is the
     * older protocol, kept for the runners that still speak it). The answer's
     * reader validates strictly: a JSON object, optionally `assignment_ids`
     * (an array of well-formed session ids — these are what the runner then
     * takes through /remote, token, worker registration and the child), plus
     * `session_assignments` (array) and `suggested_poll_interval` (a duration
     * string like "5s").
     */
    async pollWork({ headers, body } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const token = bearerToken(headers);
      const runner = state.runners.find(
        (entry) => entry.runner_token === token && entry.pool_id === pool.pool_id,
      ) ?? null;
      const now = new Date().toISOString();
      if (runner) runner.last_poll_at = now;
      // A session's assignment persists for the runner that holds it until it
      // is released, failed or requeued: the reader treats a held session's
      // disappearance from `assignment_ids` as a server-side deassignment and
      // aborts the child on the spot. Fresh pending sessions are claimed for
      // whichever runner is asking.
      const assignmentsFor = async (current) => {
        const mine = current.sessions.filter(
          (session) => session.pool_id === pool.pool_id
            && session.state !== "released" && session.state !== "failed",
        );
        const held = [];
        for (const session of mine) {
          if (runner && session.assigned_runner_id === runner.runner_id) {
            if (session.state === "pending") {
              // A placement with no prompt yet is not work; forget the claim
              // rather than hold an empty session (see sessionHasPrompt).
              if (!(await sessionHasPromptOnDisk(session))) {
                session.assigned_runner_id = undefined;
                continue;
              }
              session.state = "offered";
            }
            held.push(session.session_uuid);
            continue;
          }
          if (session.assigned_runner_id === undefined && session.state === "pending"
            && await sessionHasPromptOnDisk(session)) {
            session.state = "offered";
            if (runner) session.assigned_runner_id = runner.runner_id;
            held.push(session.session_uuid);
          }
        }
        return held;
      };
      let held = await assignmentsFor(state);
      await save();
      // Nothing to hand out: hold the poll until a placement or requeue wakes
      // the pool (see wakePool), for runners that asked (see pollWait).
      const holdMs = held.length ? 0 : pollWait(headers);
      if (holdMs > 0) {
        await waitForPool(pool.pool_id, holdMs);
        held = await assignmentsFor(await load());
        await save();
      }
      return {
        assignment_ids: held,
        session_assignments: [],
        // The shipped runner aborts on the assignment disappearing, but the
        // same notice costs nothing and keeps both runner families honest.
        cancellations: cancellationsFor(await load(), pool.pool_id),
        suggested_poll_interval: "5s",
        lease_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    },

    /** POST /v1/code/runners/self-hosted/spawn-hints/nack */
    async nackSpawnHint({ headers, body } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const session = state.sessions.find(
        (entry) => entry.pool_id === pool.pool_id
          && entry.session_uuid === body?.session_uuid,
      );
      if (session && session.state === "offered") {
        session.state = "pending";
        session.attempt += 1;
        await save();
      }
      return {};
    },

    /**
     * POST /v1/code/runners/self-hosted/sessions/{id}/token — the runner
     * exchanges its assignment for the token it then uses for the session
     * itself. The token is minted once and reused, so a runner that reconnects
     * mid-session keeps the same one.
     */
    async issueSessionToken({ headers, sessionId }) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      if (!session.session_token) {
        session.session_token = `ccsess_${randomBytes(24).toString("base64url")}`;
      }
      if (session.state === "pending" || session.state === "offered") session.state = "active";
      // Every turn gets its own start: the reaper's grace measures the turn
      // that is running, not the first one this session ever ran.
      session.started_at = new Date().toISOString();
      delete session.offered_at;
      // A Stop marker is deliberately *not* cleared here. If it landed between
      // the poll handing out the hint and this claim, the runner answers the
      // token leg but reads the interrupt out of the event log before spawning
      // (guest/runner.py's `interrupt_requested`) — clearing it here would let
      // that turn run anyway. A stop for the next turn is cleared when the
      // user's message requeues the session, and by release.
      // The runner taking the session is what "processed" means on the wire:
      // every client message present at the claim is stamped and a
      // `delivery_update` frame goes down the session stream — the frame the
      // page clears its "Sending…" state on, and the one that releases the
      // held echo of the user's own message into the transcript.
      await ensureEvents(session);
      markProcessed(session);
      // Which runner got it, for the label the app shows once the wait is over
      // (`self_hosted_runner_state.assigned_runner_label` — the page's pool
      // wait card clears on it). Polls authenticate by the pool secret, so the
      // pool's most recently seen runner is the best name available here; the
      // runner id is what the pool API itself mints for it.
      const runner = state.runners
        .filter((entry) => entry.pool_id === session.pool_id)
        .sort((a, b) => String(b.last_poll_at ?? "").localeCompare(String(a.last_poll_at ?? "")))[0];
      if (runner?.runner_id && !session.runner_label) session.runner_label = runner.runner_id;
      await save();
      log.log(`[code-runners] session ${session.session_uuid} started on pool ${session.pool_id}`);
      return { session_token: session.session_token };
    },

    /**
     * POST /v1/code/runners/self-hosted/sessions/{id}/claim — how far the
     * turn's transcript read went. The guest reads the history, then reports
     * the highest sequence it saw; anything appended after that point is a
     * message for the next turn, and anything at or before it has been
     * consumed. This is also what acknowledges a message that landed between
     * the token and the read (stamping it and queueing its delivery update).
     */
    async recordClaim({ headers, sessionId, body } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      const through = Number(body?.through_sequence_num);
      if (!Number.isSafeInteger(through) || through < 0) return {};
      await ensureEvents(session);
      session.claimed_through = through;
      markProcessed(session, through);
      // A message the turn's read did not include is answered by the next one.
      // Only a live turn can release into that retry; a session stopped in the
      // meantime (or released) takes the next client message through the
      // ordinary requeue path.
      if (session.state === "active" || session.state === "offered") {
        for (const envelope of session.events ?? []) {
          if (envelope.source === "worker") continue;
          if (!isUserMessage(envelope)) continue;
          if (Number(envelope.sequence_num) > through) {
            session.requeue_after_release = true;
            break;
          }
        }
      }
      await save();
      return {};
    },

    /**
     * GET /v1/code/sessions/{id}/remote — the session's start configuration,
     * read by the product's own runner before it spawns the session's claude:
     * the sources to check out, the arguments that carry the session's own
     * settings (the model among them — this is where the composer's choice
     * reaches the agent), and the inference token the child authenticates its
     * model calls with. The bridge mints that token here and accepts it on its
     * own model passthrough, so the child's calls come home.
     */
    async sessionRemote({ headers, sessionId, baseUrl } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      if (!session.inference_token) {
        session.inference_token = `ccinfer_${randomBytes(24).toString("base64url")}`;
        await save();
      }
      const config = sessionConfigOf(session);
      const claudeCodeArgs = {};
      if (typeof config.model === "string" && config.model) claudeCodeArgs.model = config.model;
      if (typeof config.permission_mode === "string" && config.permission_mode) {
        claudeCodeArgs.permission_mode = config.permission_mode;
      }
      return {
        // The runner derives the child's API origin from this (`new URL(...)`
        // on it in its setup — absent, the whole session fails with "Invalid
        // URL"). It is our own address as the runner reached it.
        ...(typeof baseUrl === "string" && baseUrl ? { api_base_url: baseUrl } : {}),
        sources: config.sources,
        push_targets: [],
        claude_code_args: claudeCodeArgs,
        environment_variables: {},
        agent_files: [],
        inference_auth: {
          access_token: session.inference_token,
          expires_in_seconds: 3600,
        },
      };
    },

    /**
     * POST /v1/code/sessions/{id}/worker/register — the runner announces
     * itself as this session's worker; the epoch that comes back is the
     * handle that distinguishes a takeover from the previous worker.
     */
    async registerWorker({ headers, sessionId } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.worker_epoch = (Number(session.worker_epoch) || 0) + 1;
      await save();
      return { worker_epoch: session.worker_epoch };
    },

    /**
     * POST /v1/code/sessions/{id}/worker/events — the runner relaying the
     * child's events into the session's log. Same store as every other events
     * leg; the runner credential is the pass.
     */
    async appendWorkerEvents({ headers, sessionId, body } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      const incoming = Array.isArray(body?.events) ? body.events
        : body && typeof body === "object" ? [body] : [];
      await ensureEvents(session);
      const { durable, volatile } = appendIncoming(session, incoming, "worker");
      if (durable.length) {
        await appendEventsFile(session, durable);
        emitLive(session, durable);
      }
      emitLive(session, volatile);
      if (durable.length || volatile.length) await save();
      return { data: [...durable, ...volatile] };
    },

    /**
     * The session's delivery acknowledgements, paged by position. The session
     * stream carries each as an `event: delivery_update` frame — the wire's
     * "this client event was processed" signal (see issueSessionToken). The
     * frame has no sequence of its own: it names an event by `event_id`.
     */
    async deliveryUpdates({ sessionId, after } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      const updates = Array.isArray(session.delivery_updates) ? session.delivery_updates : [];
      return updates.slice(Number(after) || 0);
    },

    /**
     * PUT /v1/code/sessions/{id}/worker — the runner reporting the child's
     * lifecycle (`worker_status`, or `{connection_status}`). This is the
     * truest state the session has — the runner learns it from the child
     * itself — so the session document prefers it over the derived default.
     */
    async updateSessionWorker({ headers, sessionId, body } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      if (typeof body?.worker_status === "string") {
        session.reported_worker_status = body.worker_status;
      }
      if (typeof body?.connection_status === "string") {
        session.reported_connection_status = body.connection_status;
      }
      session.worker_updated_at = new Date().toISOString();
      await save();
      return {};
    },

    /** POST /v1/code/sessions/{id}/worker/heartbeat — liveness while the child runs. */
    async workerHeartbeat({ headers, sessionId } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.worker_heartbeat_at = new Date().toISOString();
      await save();
      return {};
    },

    /**
     * POST /v1/code/sessions/{id}/worker/diagnostics — the runner forwarding
     * lines of the child's diagnostics; the bridge keeps them where a log
     * reader can see them rather than in the transcript.
     */
    async forwardWorkerDiagnostics({ headers, sessionId, body } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      for (const line of lines.slice(0, 200)) {
        log.log(`[code-runners] ${session.session_uuid} diagnostics: ${String(line).slice(0, 500)}`);
      }
      return {};
    },

    /**
     * POST /v1/code/auth/refresh — the runner's token rotation. The bridge's
     * tokens do not expire, so the same one is handed back; a credential that
     * names nothing here is refused like every other leg.
     */
    async refreshRunnerToken({ headers } = {}) {
      const token = bearerToken(headers);
      if (!token) return { unauthorized: true };
      const state = await load();
      const runner = state.runners.find((entry) => entry.runner_token === token);
      if (runner) return { token: runner.runner_token };
      const pool = state.pools.find((entry) => entry.secret === token);
      if (pool) return { token: pool.secret };
      return { unauthorized: true };
    },

    /**
     * Is this a credential the bridge accepts for model calls? The pool
     * secret, a runner_token, or the inference token minted for a session —
     * the last is what the spawned claude actually carries.
     */
    async verifyInferenceAuth({ headers } = {}) {
      const token = bearerToken(headers);
      if (!token) return false;
      const state = await load();
      if (state.pools.some((pool) => pool.secret === token)) return true;
      if (state.runners.some((runner) => runner.runner_token === token)) return true;
      return state.sessions.some(
        (session) => Boolean(session.inference_token) && session.inference_token === token,
      );
    },

    /**
     * POST /v1/code/runners/self-hosted/sessions/{id}/report-failure. The runner
     * says why it could not run the session; `excluded_count`/`stuck` are the
     * pool-health numbers it reads back, and this deployment has no exclusion
     * list to report, so both are zero/false.
     */
    async reportSessionFailure({ headers, sessionId, body } = {}) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.state = "failed";
      delete session.requeue_after_release;
      session.failure = {
        reason: typeof body?.reason === "string" ? body.reason : "",
        ...(body?.setup_failure_kind ? { setup_failure_kind: body.setup_failure_kind } : {}),
        ...(body?.failure_kind ? { failure_kind: body.failure_kind } : {}),
      };
      await save();
      (log.warn ?? log.log)
        .call(log, `[code-runners] session ${session.session_uuid} failed: ${session.failure.reason}`);
      return { excluded_count: 0, stuck: false };
    },

    /**
     * The session's connection state in the stream's own vocabulary.
     *
     * `StreamSessionUpdate` uses the two-case `ConnectionStatus` — a bare
     * `connected` / `disconnected`, not the four-case prefixed enum — and the
     * page reads it off `session_update` frames; it is what clears
     * "Connecting…" (the same frame the phone's own facade sends first). A
     * message can be posted to a session whether or not a runner holds it yet
     * — it re-queues on the pool — so everything but a failed placement is
     * `connected`; only a failure reads `disconnected`.
     */
    async connectionState({ sessionId } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      return session.state === "failed" ? "disconnected" : "connected";
    },

    /**
     * POST /v1/code/sessions/{id}/interrupt (and `/stop`) — stop the session's
     * running turn. The Code surface itself posts a control request through
     * `appendEvents`; this leg serves the callers that use the REST spelling
     * (the mobile facade's shape) and the routine run-cancel button. The
     * session must exist, but the stop is best-effort: a turn that already
     * ended is not an error.
     */
    async interruptSession({ sessionId, requestId } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      markInterrupted(session, { requestId });
      await save();
      wakePool(session.pool_id);
      log.log(`[code-runners] session ${session.session_uuid} interrupted`
        + ` (state ${session.state})`);
      return { session: sessionDocument(session) };
    },

    /** POST /v1/code/runners/self-hosted/sessions/{id}/release */
    async releaseSession({ headers, sessionId }) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      // A message that arrived with the Stop starts the next turn straight
      // away; otherwise the session just goes idle.
      const requeue = session.requeue_after_release === true;
      delete session.requeue_after_release;
      delete session.offered_at;
      session.state = requeue ? "pending" : "released";
      if (requeue) {
        session.attempt += 1;
        session.assigned_runner_id = undefined;
      }
      // The turn is over; the notice has done its job. A later user message
      // requeues the session, and that turn starts un-cancelled.
      clearInterrupted(session);
      await save();
      if (requeue) {
        wakePool(session.pool_id);
        wakeTurnRunner();
      }
      return { released: true };
    },

    /** POST …/sessions/{id}/retry-spawn — the operator's Activity → Retry. */
    async retrySpawn({ headers, sessionId }) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.state = "pending";
      session.attempt += 1;
      session.reap_attempts = 0;
      session.session_token = undefined;
      session.assigned_runner_id = undefined;
      delete session.offered_at;
      await save();
      wakePool(session.pool_id);
      wakeTurnRunner();
      return {};
    },

    /**
     * POST /v1/code/sessions — place a session on one of this instance's pools.
     *
     * The body is the renderer's own create serializer (read from its bundle,
     * not guessed): `{title?, environment_id? | self_hosted_runner_pool_id?,
     * config:{sources, outcomes?, model?, …}, events?: [{payload}], tags?}`. A
     * pool worker names its place with `self_hosted_runner_pool_id` and an
     * environment worker with `environment_id`; both must name one of this
     * instance's pools — there is no local executor here, so anything else is
     * refused rather than quietly run somewhere else. The answer is
     * `{session: …}` in the app's session shape (see `sessionDocument`).
     */
    async createSession({ body, source } = {}) {
      const state = await load();
      const environmentId = typeof body?.environment_id === "string" ? body.environment_id : "";
      const requestedPoolId = typeof body?.self_hosted_runner_pool_id === "string"
        ? body.self_hosted_runner_pool_id : "";
      const pool = poolById(state, environmentId || requestedPoolId);
      if (!pool) return { unsupported: true };
      const config = isRecord(body?.config) ? body.config : {};
      const sessionConfig = { sources: [] };
      for (const key of sessionConfigKeys) {
        if (config[key] !== undefined) sessionConfig[key] = config[key];
      }
      if (!Array.isArray(sessionConfig.sources)) sessionConfig.sources = [];
      const session = {
        session_uuid: newSessionId(),
        pool_id: pool.pool_id,
        pool_name: pool.name,
        attempt: 1,
        state: "pending",
        work_order_jwt: `${randomUUID()}.${randomBytes(16).toString("base64url")}`,
        title: typeof body?.title === "string" ? body.title : "",
        session_config: sessionConfig,
        // A routine fire names the routine it ran and the origin that started
        // it. The routine page lists its runs by `trigger_id`; without these
        // the session is an ordinary one and never appears under the routine.
        ...(typeof body?.trigger_id === "string" && body.trigger_id
          ? { trigger_id: body.trigger_id } : {}),
        ...(typeof body?.origin === "string" && body.origin
          ? { origin: body.origin } : {}),
        ...(Array.isArray(body?.tags) && body.tags.length
          ? { tags: body.tags.filter((tag) => typeof tag === "string") } : {}),
        created_at: new Date().toISOString(),
        // A session born in this process has no history to read.
        events: [],
        eventsLoaded: true,
        last_sequence: 0,
      };
      state.sessions.push(session);
      // The create body may carry the session's first events (a schema init
      // control request, or an eager first message); they land in the same log
      // the runner reads and the stream replays.
      if (Array.isArray(body?.events)) {
        const { durable, volatile } = appendIncoming(session, body.events, source);
        await appendEventsFile(session, durable);
        emitLive(session, durable);
        emitLive(session, volatile);
      }
      await save();
      // Wake the pool only for a session that already carries its prompt (a
      // routine fire does). A composer places the session first and posts the
      // first message next; that append is what wakes the pool then, so the
      // runner cannot claim the empty session in between.
      if (await sessionHasPromptOnDisk(session)) wakePool(pool.pool_id);
      // And a pool with no runner needs its VM: every placement is a reason for
      // the guest to be up, not just the composer's own create route. Waking
      // here keeps a headless placement (a routine fire, an API create) from
      // depending on its caller to remember.
      wakeTurnRunner();
      log.log(`[code-runners] session ${session.session_uuid} placed on pool ${pool.pool_id}`);
      return { session: sessionDocument(session) };
    },

    /**
     * Append a session's events — the transcript a runner produces and the
     * client events the renderer posts.
     *
     * `body` is either `{events: [...]}` (how the renderer posts: each entry
     * carries a `payload`) or a single envelope (`{payload, event_type?}`, how a
     * runner writes one message). `event_id` and `sequence_num` are the store's
     * to assign: the wire contract requires a non-empty `event_id` and a
     * `sequence_num` that is a **positive digit string** — the renderer's own
     * reader rejects zero and a non-string — so a caller-supplied one is
     * ignored rather than trusted.
     */
    async appendEvents({ sessionId, body, headers } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      const incoming = Array.isArray(body?.events) ? body.events
        : body && typeof body === "object" ? [body] : [];
      // The runner writes through this same path with its session token; the
      // renderer writes without one (its auth is the deployment's proxy).
      const fromWorker = Boolean(bearerToken(headers));
      // A browser send carries its *spawn* mode as a control request beside the
      // user message. Until the folder's stored permission picks have settled
      // that value is the composer's failsafe `"default"`, so a session started
      // in bypass was demoted to Manual by the very message that began it (the
      // pill flipped after sending, and the next turn ran Manual). A
      // deliberate in-session switch is its own append without a user message,
      // so only a `"default"` riding a user message onto a session whose own
      // config says otherwise is the failsafe; drop it rather than let it
      // rewrite the session and the transcript.
      const carriesUserMessage = incoming.some(isUserMessage);
      const accepted = fromWorker || !carriesUserMessage ? incoming
        : incoming.filter((item) => {
          const payload = item?.payload ?? item;
          if (payload?.type !== "control_request") return true;
          const request = payload.request;
          if (request?.subtype !== "set_permission_mode" || request.mode !== "default") {
            return true;
          }
          const current = session.session_config?.permission_mode;
          return !current || current === "default";
        });
      // Partials from this leg (a runner using the plain append) are live-only
      // too: the durable half goes to the log, both go to the open streams.
      await ensureEvents(session);
      const { durable: appended, volatile } = appendIncoming(session, accepted,
        fromWorker ? "worker" : "client");
      // A user message on a session no runner holds starts its next turn: the
      // session goes back on its pool, the way it was placed the first time,
      // and the runner that claims it replays the conversation (the agent's
      // own `--resume`). Only the client leg requeues — the runner's writes
      // come through the worker leg, where a `user` payload is a tool result,
      // not a new turn.
      // A client control request changes the session's own settings; the
      // renderer never rewrites the create config, so without this the session
      // document kept reporting the start values after a mid-session
      // set_model / set_permission_mode and a reopen showed them again.
      let configChanged = false;
      // Stop requests in this batch, by the request id the renderer will wait
      // on. The Code surface does not call an interrupt endpoint: its Stop
      // appends a control request here, and before this was acted on the turn
      // simply kept running.
      const interruptRequests = new Set();
      // The Code surface's context breakdown is a control request it expects
      // the agent to answer. The bridge cannot ask the agent itself (the guest
      // is not dialable); the request lane asks the runner for the answer it
      // kept from the turn's own agent (see answerContextUsage).
      const contextRequests = [];
      for (const item of accepted) {
        const payload = item?.payload ?? item;
        if (!payload || typeof payload !== "object" || payload.type !== "control_request") continue;
        const request = payload.request;
        if (!request || typeof request !== "object") continue;
        // Only the renderer's Stop stops a turn; a worker never writes one.
        if (!fromWorker && request.subtype === "interrupt") {
          const requestId = payload.request_id ?? request.request_id;
          markInterrupted(session, { requestId });
          if (typeof requestId === "string" && requestId) interruptRequests.add(requestId);
          continue;
        }
        if (!fromWorker && request.subtype === "get_context_usage") {
          const requestId = payload.request_id ?? request.request_id;
          if (typeof requestId === "string" && requestId) {
            contextRequests.push({ requestId, detail: request.detail });
          }
          continue;
        }
        const next = { ...(session.session_config || {}) };
        if (request.subtype === "set_model"
          && typeof request.model === "string" && request.model
          && next.model !== request.model) {
          next.model = request.model;
        } else if (request.subtype === "set_permission_mode"
          && typeof request.mode === "string" && request.mode
          && next.permission_mode !== request.mode) {
          next.permission_mode = request.mode;
        } else if (request.subtype === "apply_flag_settings"
          && typeof request.settings?.effortLevel === "string"
          && request.settings.effortLevel
          && next.effort_level !== request.settings.effortLevel) {
          // The renderer changes a running session's effort by posting this
          // control request (the SDK's `applyFlagSettings`); without it the
          // pick was acknowledged and then silently dropped, and a reopen
          // showed the old level again.
          next.effort_level = request.settings.effortLevel;
        } else {
          continue;
        }
        session.session_config = next;
        configChanged = true;
      }
      // The user message that completes a freshly placed session is the other
      // half of the placement: the create did not wake the pool because there
      // was nothing to answer, and this append is what makes the session work.
      const promptAppended = appended.some(hasAnswerableContent);
      // The agent answers a control request with a `control_response`; this
      // deployment closes the child's stdin after the prompt, so it never sees
      // a mid-turn request. Synthesize the receipt the Stop button waits on —
      // its resolvers key on `response.subtype === "success"` and the request
      // id, so without this the button stays "interrupting" even after the
      // turn has ended.
      for (const requestId of interruptRequests) {
        appended.push(...appendToSession(session, [{
          payload: {
            type: "control_response",
            response: { subtype: "success", request_id: requestId, response: {} },
          },
        }], "worker"));
      }
      // One append to one session's log — never a rewrite of the store.
      await appendEventsFile(session, appended);
      emitLive(session, appended);
      emitLive(session, volatile);
      let requeued = false;
      if (appended.length && (session.state === "released" || session.state === "failed")
          && promptAppended) {
        session.state = "pending";
        session.attempt += 1;
        session.reap_attempts = 0;
        session.assigned_runner_id = undefined;
        session.failure = undefined;
        clearInterrupted(session);
        requeued = true;
        log.log(`[code-runners] session ${session.session_uuid} requeued on pool ${session.pool_id}`);
      }
      // A message typed while a turn is running. The guest's agent process
      // reads its prompt from stdin, which closes after the prompt, so it
      // cannot take a mid-turn message — the message is answered by the next
      // turn instead. The release that ends the current turn puts the session
      // back on the pool; without this the message was simply stranded and the
      // page kept showing "Sending…" forever. This is also the send-and-
      // interrupt case: the cancelled turn does not answer the new message.
      // A message is "mid-turn" only if this turn's transcript read cannot
      // have included it. The guest reports its read-through point (recordClaim)
      // right after reading; a message at or below it was answered by this turn
      // however close to the claim it landed, and one above it belongs to the
      // next turn. Without this, the opening message — routinely appended
      // between the claim and the runner's read — started a duplicate turn.
      const claimedThrough = Number.isFinite(session.claimed_through)
        ? session.claimed_through : null;
      // The composer's send-and-interrupt is always next-turn work: the turn
      // being cancelled will not answer the message, claim or no claim.
      const midTurn = (claimedThrough !== null && appended.some((envelope) =>
        envelope.source !== "worker"
        && isUserMessage(envelope)
        && Number(envelope.sequence_num) > claimedThrough))
        || (interruptRequests.size > 0 && carriesUserMessage);
      let requeueOnRelease = false;
      if (midTurn && (session.state === "active" || session.state === "offered")) {
        session.requeue_after_release = true;
        session.reap_attempts = 0;
        requeueOnRelease = true;
        warn(`[code-runners] ${session.session_uuid}: message during `
          + `${session.state}; will requeue on release`);
      }
      if (appended.length || volatile.length || configChanged) saveSoon();
      // The runner holding the pool hears about it on its held poll, not on a
      // later tick — the same wake a placement gets. A stop must not wait out
      // the poll's 20 s hold (see cancellationsFor). The message that completes
      // a fresh placement wakes it too, since the create intentionally did not.
      if (requeued || interruptRequests.size || requeueOnRelease
        || (promptAppended && session.state === "pending")) {
        wakePool(session.pool_id);
      }
      if (requeued) wakeTurnRunner();
      // The renderer waits on the session stream for these answers, so they
      // must not hold this POST open; the runner may need to wake the VM.
      for (const request of contextRequests) {
        void answerContextUsage(session.session_uuid, request).catch((error) => {
          warn(`[code-runners] context usage for ${session.session_uuid} failed: `
            + `${error?.message || error}`);
        });
      }
      return { data: [...appended, ...volatile] };
    },

    /**
     * POST /v1/code/sessions/{id}/events/stream — the whole turn's events over
     * one chunked request.
     *
     * The guest holds this connection open for the turn and writes one NDJSON
     * line per event as the agent emits it. A token therefore costs no round
     * trip of its own, and the bridge appends a line (or the handful that
     * arrived in one socket read) to the session's own log. Keepalive lines
     * (`{"keepalive":true}`) only keep a long thinking pause from tripping the
     * server's request timeout; they are not events and are dropped here.
     */
    async appendEventStream({ sessionId, headers, request } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      const allowed = sessionFor(state, headers, sessionId);
      if (!allowed || allowed.unauthorized) return { unauthorized: true };
      // The sequence counter must be seeded from the durable history before the
      // first append; a session created in this process already carries it.
      await ensureEvents(session);
      let buffer = "";
      let appendedCount = 0;
      const take = async (lines) => {
        const incoming = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(entry) || !isRecord(entry.payload)) continue;
          incoming.push(entry);
        }
        if (!incoming.length) return;
        const { durable, volatile } = appendIncoming(session, incoming, "worker");
        if (durable.length) {
          await appendEventsFile(session, durable);
          emitLive(session, durable);
        }
        // Token deltas go straight to the open page and nowhere else.
        emitLive(session, volatile);
        appendedCount += durable.length + volatile.length;
      };
      for await (const chunk of request) {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        await take(lines);
      }
      await take([buffer]);
      if (appendedCount) saveSoon();
      return { ok: true, appended: appendedCount };
    },

    /**
     * GET /v1/code/sessions/{id}/events — the history, paged. `after_sequence_num`
     * resumes (that is the parameter the stream and the app's pager both use),
     * `limit` caps one page.
     *
     * `cursor` is the page edge the pager hands back as `next_cursor`, and its
     * direction follows the sort: an ascending walk continues strictly above
     * it (that is how the renderer's full-transcript walk advances), while a
     * newest-first read continues strictly below it (the next older page).
     * Ignoring it made every follow-up request answer the same page, so a
     * transcript longer than one page either stopped at 500 events or re-read
     * the newest window forever.
     */
    async listEvents({ sessionId, searchParams } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      await ensureEvents(session);
      const after = Number(searchParams?.get?.("after_sequence_num") ?? 0) || 0;
      const limit = Number(searchParams?.get?.("limit") ?? 0) || 0;
      const descending = searchParams?.get?.("sort_order") === "desc";
      const cursorRaw = searchParams?.get?.("cursor") ?? "";
      let cursor = 0;
      if (cursorRaw) {
        cursor = Number(cursorRaw);
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          throw Object.assign(new Error("invalid cursor"), { statusCode: 400 });
        }
      }
      let events = (session.events ?? [])
        .filter((event) => Number(event.sequence_num) > after);
      if (descending) {
        // Newest first, so a `limit` takes the newest that many, and a cursor
        // takes the window just below its sequence.
        events = events.filter((event) => !cursorRaw || Number(event.sequence_num) < cursor)
          .reverse();
      } else if (cursorRaw) {
        events = events.filter((event) => Number(event.sequence_num) > cursor);
      }
      const page = limit > 0 ? events.slice(0, limit) : events;
      return {
        data: page,
        next_cursor: limit > 0 && page.length < events.length
          ? String(page[page.length - 1]?.sequence_num ?? after) : null,
      };
    },

    /** The events after a sequence, for the SSE replay and its tail. */
    async eventsAfter(sessionId, sequence) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      await ensureEvents(session);
      return (session.events ?? []).filter((event) => Number(event.sequence_num) > sequence);
    },

    /**
     * GET /v1/code/sessions — the list. The pager reads `has_more` / `last_id`,
     * and a row is filtered on `tags`, so both are stated rather than implied;
     * `next_cursor` is the same page's other name for it. The sidebar's own
     * call carries the `statuses` it wants (`active` and `paused`), which is
     * how an archived session leaves the list the moment it is archived. The
     * whole store is the page — it is one JSON file per deployment — so `limit`
     * is accepted and not enforced.
     *
     * `tags` is not decoration: the renderer's chat recents ask for
     * `tags=cowork-remote` on this same path (the app's remote-cowork list),
     * then merge whatever comes back into the Chat task list. Serving them the
     * whole Code store put every Code session in Chat while leaving the Code
     * surface still showing it; a session has to carry every requested tag to
     * be a row of that list.
     */
    async listSessions({ searchParams } = {}) {
      const state = await load();
      const statuses = (searchParams?.getAll?.("statuses") ?? []).filter(Boolean);
      const tags = (searchParams?.getAll?.("tags") ?? []).filter(Boolean);
      const triggerId = (searchParams?.get?.("trigger_id") ?? "").trim();
      const includeTriggerSessions = searchParams?.get?.("include_trigger_sessions") === "true";
      const onlyTriggerSessions = searchParams?.get?.("only_trigger_sessions") === "true";
      const hasTrigger = (row) => typeof row.trigger_id === "string" && row.trigger_id !== "";
      let rows = state.sessions
        .slice()
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
        .map((session) => sessionDocument(session));
      if (statuses.length) {
        rows = rows.filter((row) => statuses.includes(row.status));
      }
      if (tags.length) {
        rows = rows.filter((row) => tags.every((tag) => row.tags.includes(tag)));
      }
      // The Code routine page reads its run history as
      // `/v1/code/sessions?trigger_id=<routine>`, and the routines list's
      // rollup asks for `only_trigger_sessions`. Without these filters every
      // session was history of every routine. Ordinary Code lists leave
      // trigger runs out unless they ask for them, exactly as upstream.
      if (triggerId) {
        rows = rows.filter((row) => row.trigger_id === triggerId);
      } else if (onlyTriggerSessions) {
        rows = rows.filter(hasTrigger);
      } else if (!includeTriggerSessions) {
        rows = rows.filter((row) => !hasTrigger(row));
      }
      return {
        data: rows,
        has_more: false,
        last_id: rows.length ? rows[rows.length - 1].id : null,
        next_cursor: null,
      };
    },

    /** GET /v1/code/sessions/{id} */
    async session(sessionUuid) {
      const state = await load();
      const session = sessionById(state, sessionUuid);
      if (!session) return null;
      return { session: sessionDocument(session) };
    },

    /**
     * PUT /v1/code/sessions/{id} — the one endpoint the app edits a session
     * with: `{title?}` (a rename — an automatic title also arrives this way),
     * `{add_tags?}` / `{remove_tags?}`, and `{client_metadata?}` (the reader
     * carries it under `metadata`). Every caller parses the answer as the
     * updated `{session…}`.
     */
    async updateSession({ sessionId, body } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      if (typeof body?.title === "string") session.title = body.title;
      if (Array.isArray(body?.add_tags) || Array.isArray(body?.remove_tags)) {
        const tags = new Set(Array.isArray(session.tags) ? session.tags : []);
        for (const tag of Array.isArray(body?.remove_tags) ? body.remove_tags : []) {
          if (typeof tag === "string") tags.delete(tag);
        }
        for (const tag of Array.isArray(body?.add_tags) ? body.add_tags : []) {
          if (typeof tag === "string") tags.add(tag);
        }
        session.tags = [...tags];
      }
      if (isRecord(body?.client_metadata)) {
        session.client_metadata = {
          ...(isRecord(session.client_metadata) ? session.client_metadata : {}),
          ...body.client_metadata,
        };
      }
      await save();
      return { session: sessionDocument(session) };
    },

    /**
     * POST /v1/code/sessions/{id}/archive — archiving is its own axis, not a
     * runner state: the session keeps its log and its place, and stops being in
     * the list the sidebar reads. Archiving twice is fine (the client treats a
     * 404 as "already archived" too).
     */
    async archiveSession({ sessionId } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      session.archived = true;
      await save();
      return { session: sessionDocument(session) };
    },

    /** POST /v1/code/sessions/{id}/mark_read — the reader names the event it read to. */
    async markSessionRead({ sessionId } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      session.unread = false;
      await save();
      return { session: sessionDocument(session) };
    },

    /** PUT /v1/code/sessions/{id}/mcp-servers — the session's MCP editor saves here. */
    async setSessionMcpServers({ sessionId, body } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      const servers = Array.isArray(body?.mcp_servers) ? body.mcp_servers : [];
      session.session_config = {
        ...(isRecord(session.session_config) ? session.session_config : {}),
        mcp_servers: servers,
      };
      await save();
      return { session: sessionDocument(session) };
    },

    /** DELETE /v1/code/sessions/{id} — the caller ignores the answer's body. */
    async deleteSession({ sessionId } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      // A deleted session must not keep running in the guest. Only a session a
      // runner has actually taken (or been offered) can have a live turn; a
      // merely pending one has no child to stop. The record is about to
      // disappear, so leave a tombstone the runner's next poll names (see
      // cancellationsFor), and wake a held poll to deliver it now.
      if (session.state === "active" || session.state === "offered") {
        addCancellationTombstone(state, session);
        wakePool(session.pool_id);
      }
      state.sessions.splice(state.sessions.indexOf(session), 1);
      loadedSessions.delete(session.session_uuid);
      // Serialize with any append still in flight for this session.
      await eventChain(session, () => rm(eventsPathFor(session), { force: true }))
        .catch(() => undefined);
      await save();
      return {};
    },

    /**
     * Hand a session to a pool's runners. The Code session path calls this once
     * a session is placed on a self-hosted environment; until then it is the
     * seam a smoke drives and the next increment fills.
     */
    async queueSession({ poolId, sessionUuid, sources = [], prompt = "" } = {}) {
      const state = await load();
      const pool = poolById(state, poolId);
      if (!pool) return null;
      const session = {
        session_uuid: sessionUuid,
        pool_id: poolId,
        attempt: 1,
        state: "pending",
        work_order_jwt: `${randomUUID()}.${randomBytes(16).toString("base64url")}`,
        sources,
        created_at: new Date().toISOString(),
        events: [],
        eventsLoaded: true,
        last_sequence: 0,
      };
      // A queued session is work only once it has a prompt (see
      // sessionHasPrompt); the seam states one so the protocol tests can drive
      // the poll without a separate create-then-send dance.
      if (typeof prompt === "string" && prompt.trim()) {
        await appendEventsFile(session, appendToSession(session, [{
          payload: { type: "user", message: { role: "user", content: prompt } },
        }], "client"));
      }
      state.sessions.push(session);
      await save();
      return hintFor(session);
    },

    /** The `byoc` environments this instance's pools are advertised as. */
    async poolEnvironments() {
      return environments();
    },

    /**
     * The environment list the Code surface reads. A tenant's list carries its
     * self-hosted pools and **nothing else**: the local (this-computer) place is
     * never advertised, so the UI cannot offer one to place a session on. That
     * is the guarantee at the environment level — the same thing Phase 1 does at
     * the IPC level, stated where the renderer makes its choice.
     */
    async environmentList() {
      const list = await environments();
      return {
        environments: list,
        has_more: false,
        first_id: list[0]?.environment_id ?? null,
        last_id: list[list.length - 1]?.environment_id ?? null,
      };
    },

    /** GET /v1/environment_providers/…/environments/{id} */
    async environment(id) {
      const state = await load();
      const pool = poolById(state, id);
      if (!pool) return null;
      // Same rule as the list: the instance's own pool is the place sessions
      // run, and placing one wakes its VM.
      return poolEnvironment(pool, { online: true });
    },

    /** The pool a runner is pointed at, for provisioning and diagnostics. */
    async primaryPool() {
      const state = await load();
      const pool = state.pools[0];
      return pool ? { pool_id: pool.pool_id, name: pool.name, secret: pool.secret } : null;
    },

    /**
     * The start settings of the most recently placed session. The web shell's
     * Code composer resolves its `model_selector_state` surface (and its draft
     * permission mode) from state that a self-hosted page can read before any
     * session exists; on a tenant those two surfaces disagree in this build
     * (the landing writes `cowork`, the session page reads `code`). This is
     * the tiebreaker: the session that was actually created is what the picks
     * resolved to, so the bridge can settle both surfaces on it.
     */
    async recentSessionConfig() {
      const state = await load();
      const text = (value) => typeof value === "string" && value ? value : null;
      const latest = (key) => {
        for (let index = state.sessions.length - 1; index >= 0; index -= 1) {
          const value = text(sessionConfigOf(state.sessions[index])[key]);
          if (value) return value;
        }
        return null;
      };
      // The permission mode is the last *explicit* one: a create body or an
      // explicit in-session switch. "default" is both the composer's failsafe
      // for an unsettled draft and the Manual mode, so a session that ran it is
      // not evidence that the person chose it — a bypass pick followed by one
      // raced session used to make every later draft Manual. Plan is a
      // per-session posture, not a default.
      let permissionMode = null;
      for (let index = state.sessions.length - 1; index >= 0; index -= 1) {
        const mode = text(sessionConfigOf(state.sessions[index]).permission_mode);
        if (mode && mode !== "default" && mode !== "plan") {
          permissionMode = mode;
          break;
        }
      }
      // Each field is read from the most recent *placement that had it*: a
      // routine fire or a folder-less chat session carries no effort, and it
      // must not erase the effort the person last picked for their Code work.
      return {
        model: latest("model"),
        effort_level: latest("effort_level"),
        permission_mode: permissionMode,
      };
    },

    /**
     * The runner's live state, for `/api/health`. `request_lane` says whether
     * an online runner is new enough to answer UI lookups (2.0.2+): with an
     * older one, folder and branch reads are refused with the version, which
     * is the difference between a stale guest image and a broken bridge.
     */
    async runnerStatus() {
      const state = await load();
      const pool = state.pools[0];
      if (!pool) return null;
      const online = onlineRunners(state, pool);
      const live = liveRunner(state, pool);
      return {
        pool_id: pool.pool_id,
        online: online.length > 0,
        runner_versions: [...new Set(online.map((runner) => runner.runner_version || "unknown"))],
        live_version: live?.runner_version || null,
        last_poll_at: live ? lastSeen(live) : null,
        // Whether polls are attributable to a specific runner (2.0.5+). Before
        // that the pool secret refreshed every registration, so the list can
        // still carry stale versions.
        attributed: online.some((runner) => typeof runner.last_runner_poll_at === "string"),
        request_lane: Boolean(live && versionAtLeast(live.runner_version, requestLaneVersion)),
        // What the VM's idle monitor cannot see for itself: a Code turn runs on
        // the guest runner, not in `LocalAgentModeSessions`. A pending session
        // is a message waiting for the VM to come up.
        active_sessions: state.sessions.filter(
          (session) => session.pool_id === pool.pool_id && session.state === "active").length,
        offered_sessions: state.sessions.filter(
          (session) => session.pool_id === pool.pool_id && session.state === "offered").length,
        pending_sessions: state.sessions.filter(
          (session) => session.pool_id === pool.pool_id && session.state === "pending").length,
        // The last few placements in the shape the renderer sent them. This is
        // what answers "did my model/effort/permission pick reach the session?"
        // from /api/health: the values here are the create body's own, before
        // any runner normalization.
        recent_sessions: state.sessions.slice(-5).map((session) => {
          const config = sessionConfigOf(session);
          const text = (value) => typeof value === "string" && value ? value : null;
          return {
            id: session.session_uuid,
            created_at: session.created_at ?? null,
            state: session.state ?? null,
            model: text(config.model),
            effort: text(config.effort_level),
            permission_mode: text(config.permission_mode),
            cwd: text(config.cwd),
          };
        }),
      };
    },

    /**
     * POST /v1/code/runners/self-hosted/requests/result — the guest runner's
     * answer to a UI request it was handed on its poll (see askRunner). The
     * pool secret is the pass, like every other runner leg.
     */
    async respondRunnerRequest({ headers, body } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const entry = runnerRequests.get(body?.request_id);
      if (!entry || entry.pool_id !== pool.pool_id) return {};
      runnerRequests.delete(body.request_id);
      if (typeof body?.error === "string" && body.error) {
        log.warn(`[code-runners] UI request ${body.request_id} failed in the guest: `
          + `${String(body.error).slice(0, 300)}`);
        entry.reject(runnerUnavailable(body.error, 502));
      } else {
        log.log(`[code-runners] UI request ${body.request_id} answered by the guest`);
        entry.resolve(body?.result ?? null);
      }
      return {};
    },

    // UI lookups answered from inside the guest (see askRunner). Read-only
    // except `createRunnerFolder`, which the runner confines to the shared
    // workspace and validates as a single path segment.
    listRunnerFolders: ({ root, path }) => askRunner("list_folders", { root, path }),
    createRunnerFolder: ({ root, path, name }) => askRunner("create_folder", {
      root, path, name,
    }),
    runnerGitInfo: ({ root, path }) => askRunner("git_info", { root, path }),
    runnerBranches: ({ root, path }) => askRunner("list_branches", { root, path }),
    runnerWorktreeState: ({ root, path }) => askRunner("worktree_state", { root, path }),
    runnerBranchConflict: ({ root, path, branch }) => askRunner("branch_switch_conflict", {
      root, path, branch,
    }),
  };
}

// What the admin UI reads back. The secret is deliberately not in the list
// shape — it is a blind read via `/secrets`, keyed by pool id.
function publicPool(pool) {
  return {
    pool_id: pool.pool_id,
    name: pool.name,
    status: pool.status,
    created_at: pool.created_at,
  };
}
