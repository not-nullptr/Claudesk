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
  return {
    id: session.session_uuid,
    title: typeof session.title === "string" ? session.title : "",
    status: archived ? "archived" : "active",
    ...(!archived && state === "active"
      ? { worker_status: "running", connection_status: "connected" } : {}),
    ...(!archived && (state === "released" || state === "failed")
      ? { worker_status: "idle" } : {}),
    environment_id: session.pool_id,
    self_hosted_runner_pool_id: session.pool_id,
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

/**
 * Append entries to a session's log, assigning `event_id` and `sequence_num`
 * here: the wire contract requires a non-empty `event_id` and a `sequence_num`
 * that is a **positive digit string** — the renderer's own reader rejects zero
 * and a non-string — so a caller-supplied one is ignored rather than trusted.
 * Returns the appended envelopes.
 */
function appendToSession(session, incoming) {
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

export function createRunnerBackend({ stateDir, log = console, poolName = null } = {}) {
  const statePath = join(stateDir, stateFileName);
  let cache = null;

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
    }
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

  // Which pool a runner call belongs to, from its secret. A wrong secret and an
  // unknown pool are the same answer: no pool.
  function poolForSecret(state, headers) {
    const token = bearerToken(headers);
    if (!token) return null;
    return state.pools.find((pool) => pool.secret === token) ?? null;
  }

  // Session-scoped calls carry the session token the runner was issued (or the
  // pool secret, for a runner acting on behalf of a pool it owns). Anything
  // else is refused — the runner's own retry loop backs off on that, which is
  // the correct outcome for a secret that names nothing here.
  function sessionFor(state, headers, sessionId) {
    const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
    if (!session) return null;
    const token = bearerToken(headers);
    if (!token) return { unauthorized: true };
    if (session.session_token === token) return session;
    const pool = state.pools.find((entry) => entry.secret === token);
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
      sources: session.sources,
    };
  }

  return {
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
        pool_id: pool.pool_id,
        runner_version: body?.runner_version ?? "",
        client_label: body?.client_label ?? "",
        registered_at: new Date().toISOString(),
        last_poll_at: null,
      };
      state.runners.push(runner);
      await save();
      log.log(`[code-runners] runner ${runner.runner_id} registered on pool ${pool.pool_id}`);
      return { runner_id: runner.runner_id };
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
      await save();
      log.log(`[code-runners] session ${session.session_uuid} started on pool ${session.pool_id}`);
      return { session_token: session.session_token };
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

    /** POST /v1/code/runners/self-hosted/sessions/{id}/release */
    async releaseSession({ headers, sessionId }) {
      const state = await load();
      const session = sessionFor(state, headers, sessionId);
      if (session === null) return null;
      if (session.unauthorized) return session;
      session.state = "released";
      await save();
      return {};
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
      await save();
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
    async createSession({ body } = {}) {
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
        session_uuid: randomUUID(),
        pool_id: pool.pool_id,
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
      if (Array.isArray(body?.events)) appendToSession(session, body.events);
      await save();
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
    async appendEvents({ sessionId, body } = {}) {
      const state = await load();
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
      if (!session) return null;
      const incoming = Array.isArray(body?.events) ? body.events
        : body && typeof body === "object" ? [body] : [];
      const appended = appendToSession(session, incoming);
      if (appended.length) await save();
      return { data: appended };
    },

    /**
     * GET /v1/code/sessions/{id}/events — the history, paged. `after_sequence_num`
     * resumes (that is the parameter the stream and the app's pager both use),
     * `limit` caps one page.
     */
    async listEvents({ sessionId, searchParams } = {}) {
      const state = await load();
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
      if (!session) return null;
      const after = Number(searchParams?.get?.("after_sequence_num") ?? 0) || 0;
      const limit = Number(searchParams?.get?.("limit") ?? 0) || 0;
      const events = (session.events ?? [])
        .filter((event) => Number(event.sequence_num) > after);
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
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
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
     */
    async listSessions({ searchParams } = {}) {
      const state = await load();
      const statuses = (searchParams?.getAll?.("statuses") ?? []).filter(Boolean);
      let rows = state.sessions
        .slice()
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
        .map((session) => sessionDocument(session));
      if (statuses.length) {
        rows = rows.filter((row) => statuses.includes(row.status));
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
      const session = state.sessions.find((entry) => entry.session_uuid === sessionUuid);
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
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
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
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
      if (!session) return null;
      session.archived = true;
      await save();
      return { session: sessionDocument(session) };
    },

    /** POST /v1/code/sessions/{id}/mark_read — the reader names the event it read to. */
    async markSessionRead({ sessionId } = {}) {
      const state = await load();
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
      if (!session) return null;
      session.unread = false;
      await save();
      return { session: sessionDocument(session) };
    },

    /** PUT /v1/code/sessions/{id}/mcp-servers — the session's MCP editor saves here. */
    async setSessionMcpServers({ sessionId, body } = {}) {
      const state = await load();
      const session = state.sessions.find((entry) => entry.session_uuid === sessionId);
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
      const index = state.sessions.findIndex((entry) => entry.session_uuid === sessionId);
      if (index === -1) return null;
      state.sessions.splice(index, 1);
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
