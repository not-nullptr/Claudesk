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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateFileName = "code-runners.json";

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
const sessionConfigKeys = ["sources", "outcomes", "model", "cwd", "effort_level",
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
    config: sessionConfigOf(session),
    tags: Array.isArray(session.tags) ? session.tags : [],
    ...(session.client_metadata ? { client_metadata: session.client_metadata } : {}),
    ...(session.unread ? { unread: true } : {}),
  };
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
function appendToSession(session, incoming, source) {
  session.events = Array.isArray(session.events) ? session.events : [];
  let sequence = session.events.reduce(
    (high, event) => Math.max(high, Number(event.sequence_num) || 0), 0);
  const appended = [];
  for (const entry of incoming) {
    const payload = isRecord(entry?.payload) ? entry.payload : entry;
    if (!isRecord(payload)) continue;
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
  if (appended.length) session.last_event_at = appended[appended.length - 1].created_at;
  return appended;
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

export function createRunnerBackend({ stateDir, log = console, poolName = null } = {}) {
  const statePath = join(stateDir, stateFileName);
  let cache = null;

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

  function waitForPool(poolId, holdMs) {
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
        resolve();
      };
      const timer = setTimeout(finish, holdMs);
      set.add(finish);
    });
  }

  function wakePool(poolId) {
    for (const finish of [...(pollWaiters.get(poolId) ?? [])]) finish();
  }

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      cache = {
        pools: Array.isArray(parsed?.pools) ? parsed.pools : [],
        runners: Array.isArray(parsed?.runners) ? parsed.runners : [],
        sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
      };
    } catch {
      cache = { pools: [], runners: [], sessions: [] };
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

  async function save() {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${statePath}.${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    await rename(tmp, statePath);
  }

  function poolById(state, poolId) {
    return state.pools.find((pool) => pool.pool_id === poolId) ?? null;
  }

  // Advertised places are pools a runner has actually registered with. A pool is
  // created the moment the bridge starts, before anything can run on it, and
  // offering it then would let a session be placed somewhere nothing is polling
  // — it would sit pending forever, which reads as a broken product rather than
  // an unconfigured one. So the surface starts empty and gains the place when a
  // runner arrives, and `poolEnvironment` marks a pool without one offline.
  async function environments() {
    const state = await load();
    return state.pools
      .map((pool) => poolEnvironment(pool, {
        online: state.runners.some((runner) => runner.pool_id === pool.pool_id),
      }))
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

  return {
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
      };
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
    async pollSpawnHints({ headers } = {}) {
      const state = await load();
      const pool = poolForSecret(state, headers);
      if (!pool) return { unauthorized: true };
      const now = new Date().toISOString();
      for (const runner of state.runners) {
        if (runner.pool_id === pool.pool_id) runner.last_poll_at = now;
      }
      await save();
      const mine = state.sessions.filter(
        (session) => session.pool_id === pool.pool_id && session.state === "pending",
      );
      // A session is handed out once; the runner's nack puts it back.
      for (const session of mine) session.state = "offered";
      if (mine.length) await save();
      // Nothing to hand out: a runner that said how long it can wait gets its
      // poll held until a placement or a requeue wakes the pool (see
      // wakePool) — the difference between "picked up on the next tick" and
      // "picked up now".
      const holdMs = mine.length ? 0 : pollWait(headers);
      if (holdMs > 0) {
        await waitForPool(pool.pool_id, holdMs);
        const refreshed = await load();
        const later = refreshed.sessions.filter(
          (session) => session.pool_id === pool.pool_id && session.state === "pending",
        );
        for (const session of later) session.state = "offered";
        if (later.length) await save();
        return {
          hints: later.map(hintFor),
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
      const assignmentsFor = (current) => {
        const mine = current.sessions.filter(
          (session) => session.pool_id === pool.pool_id
            && session.state !== "released" && session.state !== "failed",
        );
        const held = [];
        for (const session of mine) {
          if (runner && session.assigned_runner_id === runner.runner_id) {
            if (session.state === "pending") session.state = "offered";
            held.push(session.session_uuid);
            continue;
          }
          if (session.assigned_runner_id === undefined && session.state === "pending") {
            session.state = "offered";
            if (runner) session.assigned_runner_id = runner.runner_id;
            held.push(session.session_uuid);
          }
        }
        return held;
      };
      let held = assignmentsFor(state);
      await save();
      // Nothing to hand out: hold the poll until a placement or requeue wakes
      // the pool (see wakePool), for runners that asked (see pollWait).
      const holdMs = held.length ? 0 : pollWait(headers);
      if (holdMs > 0) {
        await waitForPool(pool.pool_id, holdMs);
        held = assignmentsFor(await load());
        await save();
      }
      return {
        assignment_ids: held,
        session_assignments: [],
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
      session.started_at = session.started_at ?? new Date().toISOString();
      // The runner taking the session is what "processed" means on the wire:
      // every client message the turn is about to answer is stamped and a
      // `delivery_update` frame goes down the session stream — the frame the
      // page clears its "Sending…" state on, and the one that releases the
      // held echo of the user's own message into the transcript.
      const processedAt = new Date().toISOString();
      session.delivery_updates = Array.isArray(session.delivery_updates)
        ? session.delivery_updates : [];
      for (const envelope of session.events ?? []) {
        if (envelope.source !== "client") continue;
        if ((envelope.payload ?? {}).type !== "user") continue;
        if (envelope.processing_at !== undefined) continue;
        envelope.processing_at = processedAt;
        session.delivery_updates.push({
          event_id: envelope.event_id,
          status: "PROCESSING",
          timestamp: processedAt,
        });
      }
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
      const appended = appendToSession(session, incoming, "worker");
      if (appended.length) await save();
      return { data: appended };
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

    /** POST /v1/code/runners/self-hosted/sessions/{id}/release */
    async releaseSession({ headers, sessionId }) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.state = "released";
      await save();
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
      session.session_token = undefined;
      session.assigned_runner_id = undefined;
      await save();
      wakePool(session.pool_id);
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
        ...(Array.isArray(body?.tags) && body.tags.length
          ? { tags: body.tags.filter((tag) => typeof tag === "string") } : {}),
        created_at: new Date().toISOString(),
      };
      state.sessions.push(session);
      // The create body may carry the session's first events (a schema init
      // control request, or an eager first message); they land in the same log
      // the runner reads and the stream replays.
      if (Array.isArray(body?.events)) appendToSession(session, body.events, source);
      await save();
      // A runner already holding this pool's poll takes it on that same
      // request, not on its next tick.
      wakePool(pool.pool_id);
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
      const appended = appendToSession(session, incoming,
        bearerToken(headers) ? "worker" : "client");
      // A user message on a session no runner holds starts its next turn: the
      // session goes back on its pool, the way it was placed the first time,
      // and the runner that claims it replays the conversation (the agent's
      // own `--resume`). Only the client leg requeues — the runner's writes
      // come through the worker leg, where a `user` payload is a tool result,
      // not a new turn.
      let requeued = false;
      if (appended.length && (session.state === "released" || session.state === "failed")
          && incoming.some(isUserMessage)) {
        session.state = "pending";
        session.attempt += 1;
        session.assigned_runner_id = undefined;
        session.failure = undefined;
        requeued = true;
        log.log(`[code-runners] session ${session.session_uuid} requeued on pool ${session.pool_id}`);
      }
      if (appended.length) await save();
      // The runner holding the pool hears about it on its held poll, not on a
      // later tick.
      if (requeued) wakePool(session.pool_id);
      return { data: appended };
    },

    /**
     * GET /v1/code/sessions/{id}/events — the history, paged. `after_sequence_num`
     * resumes (that is the parameter the stream and the app's pager both use),
     * `limit` caps one page.
     */
    async listEvents({ sessionId, searchParams } = {}) {
      const state = await load();
      const session = sessionById(state, sessionId);
      if (!session) return null;
      const after = Number(searchParams?.get?.("after_sequence_num") ?? 0) || 0;
      const limit = Number(searchParams?.get?.("limit") ?? 0) || 0;
      const events = (session.events ?? [])
        .filter((event) => Number(event.sequence_num) > after);
      // `sort_order=desc` is the scrollback read (the app's transcript pages
      // ask for it): newest first, so a `limit` takes the newest that many.
      if (searchParams?.get?.("sort_order") === "desc") events.reverse();
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
      state.sessions.splice(state.sessions.indexOf(session), 1);
      await save();
      return {};
    },

    /**
     * Hand a session to a pool's runners. The Code session path calls this once
     * a session is placed on a self-hosted environment; until then it is the
     * seam a smoke drives and the next increment fills.
     */
    async queueSession({ poolId, sessionUuid, sources = [] } = {}) {
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
      };
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
      // Same rule as the list: a pool with no registered runner is not a place
      // anything can run, so it reads as offline rather than as a live choice.
      return poolEnvironment(pool, {
        online: state.runners.some((runner) => runner.pool_id === pool.pool_id),
      });
    },

    /** The pool a runner is pointed at, for provisioning and diagnostics. */
    async primaryPool() {
      const state = await load();
      const pool = state.pools[0];
      return pool ? { pool_id: pool.pool_id, name: pool.name, secret: pool.secret } : null;
    },
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
