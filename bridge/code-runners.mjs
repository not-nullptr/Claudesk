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

  async function environments() {
    const state = await load();
    return state.pools.map((pool) => poolEnvironment(pool));
  }

  // Which pool a runner call belongs to, from its secret. A wrong secret and an
  // unknown pool are the same answer: no pool.
  function poolForSecret(state, headers) {
    const token = bearerToken(headers);
    if (!token) return null;
    return state.pools.find((pool) => pool.secret === token) ?? null;
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
      return pool ? poolEnvironment(pool) : null;
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
