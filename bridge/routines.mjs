// Routine triggers for one account's instance.
//
// A routine is the Desktop's own scheduled task (`~/.claude/scheduled-tasks`
// for the Code kind, `<cowork user files>/Scheduled` for the Cowork kind). This
// module gives it the HTTP entry point Anthropic's cloud routine API has — a
// `POST …/v1/claude_code/routines/{id}/fire` with a per-routine bearer token —
// without any claude.ai backend: the task store, the session starter and the
// token verifier all live here, in the instance.
//
// What a fire can carry is deliberately only `text` (initial context appended
// to the routine's saved prompt). Model, sources, permission mode and worktree
// are the task's own settings, exactly as they are upstream. The upstream ids
// are opaque `trig_…` strings; ours are the same prefix with the scheduled
// task's id encoded into them, so an id round-trips without a second store.
//
// Tokens are stored as `sha256(token)` only — the raw value is returned once,
// like claude.ai's UI does. In a multi-tenant deployment the edge has to know
// which instance a token belongs to, so a mint also registers the hash with
// authd (`/internal/routine-tokens`); the instance remains the authority at
// fire time and validates the token again.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateFileName = "routine-triggers.json";
const tokenPrefix = "sk-ant-oat01-";
const fireWindowMs = 60 * 60 * 1000;
const firesPerRoutine = 30;
const apiFiresPerInstance = 100;
const maxTextChars = 65_536;
const triggerPrefix = "trig_";

export class RoutineError extends Error {
  constructor(statusCode, type, message, { retryAfter } = {}) {
    super(message);
    this.name = "RoutineError";
    this.statusCode = statusCode;
    this.type = type;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

const badRequest = (message) =>
  new RoutineError(400, "invalid_request_error", message);
const notFound = (message = "routine not found") =>
  new RoutineError(404, "not_found_error", message);
const unavailable = (message) =>
  new RoutineError(503, "overloaded_error", message);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

export function routineIdForTaskId(taskId) {
  if (typeof taskId !== "string" || !taskId) return "";
  return triggerPrefix + Buffer.from(taskId, "utf8").toString("base64url");
}

/**
 * The scheduled task id a routine id names. A raw task id is accepted too, so
 * an operator can fire a task by the id the Desktop shows without minting an
 * alias first. Anything that does not round-trip is not ours.
 */
export function taskIdForRoutineId(routineId) {
  const raw = textOf(routineId);
  if (!raw) return null;
  if (!raw.startsWith(triggerPrefix)) return raw;
  try {
    const decoded = Buffer.from(raw.slice(triggerPrefix.length), "base64url").toString("utf8");
    if (!decoded) return null;
    return routineIdForTaskId(decoded) === raw ? decoded : null;
  } catch {
    return null;
  }
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken() {
  return tokenPrefix + randomBytes(32).toString("base64url");
}

function tokenHint(token) {
  return `${token.slice(0, 18)}…${token.slice(-4)}`;
}

// The SKILL.md body: YAML frontmatter is metadata, not instructions. The
// Desktop's own reader strips it the same way before starting a run.
export function promptBody(raw) {
  const text = String(raw ?? "").replace(/^﻿/, "");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

function isoTime(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  return undefined;
}

function taskEnabled(task) {
  if (task?.enabled === false) return false;
  const status = String(task?.status ?? "").toLowerCase();
  return !["disabled", "paused", "deleted", "archived"].includes(status);
}

/**
 * Which executor the task belongs to. The two stores are told apart by the
 * directory the Desktop reports for the task: a Code routine lives in the
 * Claude config's `scheduled-tasks` tree, a Cowork routine under the user-files
 * root's `Scheduled` folder. An unreadable path keeps the Cowork default, which
 * is the surface that has always run these tasks.
 */
function taskKind(task) {
  const path = textOf(task?.filePath).replaceAll("\\", "/");
  if (/\/scheduled-tasks\//i.test(path)) return "code";
  if (/\/Scheduled\//i.test(path)) return "cowork";
  return task?.sessionType === "code" || task?.kind === "code" ? "code" : "cowork";
}

export function createRoutineService({
  stateDir,
  desktop,
  codeRunners = null,
  configuredModels = [],
  defaultModel = "",
  authIdentityUrl = "",
  wakeRunner = null,
  log = console,
} = {}) {
  const statePath = join(stateDir, stateFileName);
  let cache = null;
  let writing = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      cache = isRecord(parsed) ? {
        version: 1,
        tokens: isRecord(parsed.tokens) ? parsed.tokens : {},
        fires: isRecord(parsed.fires) ? parsed.fires : {},
        api_fires: Array.isArray(parsed.api_fires) ? parsed.api_fires : [],
      } : { version: 1, tokens: {}, fires: {}, api_fires: [] };
    } catch {
      cache = { version: 1, tokens: {}, fires: {}, api_fires: [] };
    }
    return cache;
  }

  async function save(state) {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${statePath}.${process.pid}.${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
    cache = state;
  }

  function mutate(change) {
    const next = writing.then(async () => {
      const state = await load();
      const result = await change(state);
      await save(state);
      return result;
    });
    writing = next.then(() => undefined, () => undefined);
    return next;
  }

  async function tasks() {
    try {
      const value = await desktop.invoke("CoworkScheduledTasks", "getAllScheduledTasks", []);
      return Array.isArray(value) ? value : [];
    } catch (error) {
      throw new RoutineError(503, "api_error",
        `this instance cannot list its scheduled tasks: ${error?.message || error}`);
    }
  }

  async function taskRecord(routineId) {
    const taskId = taskIdForRoutineId(routineId);
    if (!taskId) throw notFound();
    const listed = await tasks();
    const task = listed.find((entry) =>
      (entry?.id ?? entry?.scheduledTaskId) === taskId);
    if (!task) throw notFound();
    return { task, taskId };
  }

  async function promptFor(task, taskId) {
    try {
      const value = await desktop.invoke(
        "CoworkScheduledTasks", "getScheduledTaskFileContent", [taskId]);
      const body = promptBody(value);
      if (body) return body;
    } catch { /* fall back to the file the list named */ }
    const path = textOf(task?.filePath);
    if (path) {
      try {
        return promptBody(await readFile(path, "utf8"));
      } catch { /* no readable file either */ }
    }
    return "";
  }

  function modelFor(task) {
    const configured = new Set(configuredModels);
    const chosen = textOf(task?.model);
    if (chosen && (configured.size === 0 || configured.has(chosen))) return chosen;
    return textOf(defaultModel) || configuredModels[0] || "";
  }

  function tokenFor(state, routineId) {
    const entry = state.tokens[routineId];
    return isRecord(entry) && typeof entry.token_sha256 === "string" ? entry : null;
  }

  function triggerDocument(state, task, taskId, prompt) {
    const routineId = routineIdForTaskId(taskId);
    const token = tokenFor(state, routineId);
    return {
      id: routineId,
      name: task.displayName || task.name || taskId,
      ...(prompt !== undefined ? { prompt } : {}),
      description: textOf(task.description),
      enabled: taskEnabled(task),
      ...(textOf(task.cronExpression) ? { cron_expression: task.cronExpression } : {}),
      ...(isoTime(task.fireAt) ? { run_once_at: isoTime(task.fireAt) } : {}),
      ...(isoTime(task.nextRunAt) ? { next_run_at: isoTime(task.nextRunAt) } : {}),
      ...(isoTime(task.lastRunAt) ? { last_fired_at: isoTime(task.lastRunAt) } : {}),
      ...(textOf(task.model) ? { model: task.model } : {}),
      ...(textOf(task.permissionMode) ? { permission_mode: task.permissionMode } : {}),
      persist_session: false,
      source: "local",
      kind: taskKind(task),
      ...(textOf(task.cwd) ? { cwd: task.cwd } : {}),
      ...(task.useWorktree === true ? { use_worktree: true } : {}),
      ...(textOf(task.spaceId) ? { space_id: task.spaceId } : {}),
      ...(isoTime(task.createdAt) ? { created_at: isoTime(task.createdAt) } : {}),
      ...(isoTime(task.updatedAt) ? { updated_at: isoTime(task.updatedAt) } : {}),
      ...(token ? { api_token_hint: token.hint } : {}),
    };
  }

  function prune(state, now = Date.now()) {
    const floor = now - fireWindowMs;
    for (const [id, list] of Object.entries(state.fires)) {
      const kept = Array.isArray(list) ? list.filter((at) => at > floor) : [];
      if (kept.length) state.fires[id] = kept;
      else delete state.fires[id];
    }
    state.api_fires = state.api_fires.filter((at) => at > floor);
  }

  function fireBudget(state, routineId, now) {
    prune(state, now);
    const routine = state.fires[routineId] ?? [];
    if (routine.length >= firesPerRoutine) {
      return Math.ceil((routine[0] + fireWindowMs - now) / 1000);
    }
    if (state.api_fires.length >= apiFiresPerInstance) {
      return Math.ceil((state.api_fires[0] + fireWindowMs - now) / 1000);
    }
    return 0;
  }

  function recordFire(state, routineId, via) {
    const now = Date.now();
    state.fires[routineId] = [...(state.fires[routineId] ?? []), now];
    if (via === "api") state.api_fires.push(now);
    prune(state, now);
  }

  function mergeText(prompt, extra) {
    const text = textOf(extra).trim();
    if (!text) return prompt;
    return `${prompt}\n\n---\nAdditional context for this run:\n${text}`;
  }

  function userEvent(message) {
    return {
      payload: {
        type: "user",
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: message }] },
      },
    };
  }

  async function startCodeSession(task, message, model) {
    if (!codeRunners) throw unavailable("this instance has no Code runner");
    const pool = await codeRunners.primaryPool();
    if (!pool) throw unavailable("this instance has no self-hosted runner pool");
    const created = await codeRunners.createSession({
      // The fired turn is a client message: the runner stamps it as processed
      // when it takes the session, which is what releases it into the
      // transcript. Without the source the reader keeps it held forever.
      source: "client",
      body: {
        environment_id: pool.pool_id,
        title: task.displayName || task.name || "Routine",
        config: {
          sources: [],
          ...(textOf(task.cwd) ? { cwd: task.cwd } : {}),
          model,
          ...(textOf(task.permissionMode) ? { permission_mode: task.permissionMode } : {}),
        },
        events: [userEvent(message)],
      },
    });
    if (created?.unsupported) {
      throw unavailable("only a self-hosted environment of this instance can run a session");
    }
    const sessionId = created?.session?.id ?? created?.session_uuid;
    if (!sessionId) throw new RoutineError(502, "api_error", "the Code runner did not create a session");
    if (typeof wakeRunner === "function") wakeRunner();
    return sessionId;
  }

  async function startCoworkSession(task, taskId, message, model) {
    const sessionId = `local_${randomUUID()}`;
    const files = Array.isArray(task.userSelectedFiles) ? [...task.userSelectedFiles] : [];
    if (textOf(task.filePath) && !files.includes(task.filePath)) files.push(task.filePath);
    const result = await desktop.invoke("LocalAgentModeSessions", "start", [{
      sessionId,
      message,
      messageUuid: randomUUID(),
      model,
      title: task.displayName || task.name || "Routine",
      sessionType: "cowork",
      images: [],
      userSelectedFiles: files,
      userSelectedFolders: Array.isArray(task.userSelectedFolders) ? task.userSelectedFolders : [],
      userSelectedProjectUuids: Array.isArray(task.userSelectedProjectUuids)
        ? task.userSelectedProjectUuids : [],
      syntheticMessage: false,
      documentFunnelEnabled: false,
      scheduledTaskId: taskId,
      scheduledTaskManualStart: true,
      ...(textOf(task.spaceId) ? { spaceId: task.spaceId } : {}),
      ...(textOf(task.permissionMode) ? { permissionMode: task.permissionMode } : {}),
    }]);
    return result?.sessionId || result?.session?.sessionId || sessionId;
  }

  async function fire({ routineId, text, via = "api" }) {
    if (text !== undefined && typeof text !== "string") {
      throw badRequest("text must be a string");
    }
    if (typeof text === "string" && text.length > maxTextChars) {
      throw badRequest(`text must be at most ${maxTextChars} characters`);
    }
    const { task, taskId } = await taskRecord(routineId);
    if (!taskEnabled(task)) throw badRequest("this routine is paused");
    const prompt = await promptFor(task, taskId);
    if (!prompt) throw badRequest("this routine has no instructions");
    const model = modelFor(task);
    if (!model) throw unavailable("this instance has no inference model configured");

    const state = await load();
    const retryAfter = fireBudget(state, routineId, Date.now());
    if (retryAfter > 0) {
      throw new RoutineError(429, "rate_limit_error",
        "the routine fire limit has been reached", { retryAfter });
    }

    const message = mergeText(prompt, text);
    const kind = taskKind(task);
    const sessionId = kind === "code"
      ? await startCodeSession(task, message, model)
      : await startCoworkSession(task, taskId, message, model);

    // The run is already live; a read-only state directory must not turn it
    // into an error the caller would retry (and so start a second session).
    await mutate((current) => recordFire(current, routineId, via)).catch((error) => {
      log.warn(`[routines] could not record the fire of ${routineId}: ${error?.message || error}`);
    });
    log.log(`[routines] fired ${routineId} (${kind}) as ${sessionId}`);
    return { sessionId, kind };
  }

  /**
   * The edge's token registration. A multi-tenant deployment's proxy has to
   * choose an instance before the instance can validate anything, so the hash
   * is mirrored into authd's own table. The user's session cookie is forwarded:
   * authd resolves the account from it, so this route grants nothing a caller
   * with that cookie could not already do.
   */
  async function registerWithAuth({ routineId, hash, cookie }) {
    if (!authIdentityUrl) return;
    if (!cookie) {
      throw new RoutineError(401, "authentication_error",
        "no signed-in session to issue a routine token");
    }
    const response = await fetch(`${authIdentityUrl}/internal/routine-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ routine_id: routineId, token_sha256: hash }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response?.ok) {
      throw new RoutineError(502, "api_error",
        "the deployment's auth service could not register the routine token");
    }
  }

  async function revokeWithAuth({ routineId, cookie }) {
    if (!authIdentityUrl) return;
    const response = await fetch(`${authIdentityUrl}/internal/routine-tokens/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ routine_id: routineId }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response?.ok) {
      log.warn(`[routines] authd did not revoke ${routineId} (${response?.status ?? "unreachable"})`);
    }
  }

  async function getTriggerDocument(routineId) {
    const { task, taskId } = await taskRecord(routineId);
    const state = await load();
    return { trigger: triggerDocument(state, task, taskId, await promptFor(task, taskId)) };
  }

  return {
    /** GET /v1/code/triggers */
    async listTriggers() {
      const state = await load();
      const listed = await tasks();
      const data = listed
        .map((task) => {
          const taskId = task?.id ?? task?.scheduledTaskId;
          return typeof taskId === "string" && taskId
            ? triggerDocument(state, task, taskId)
            : null;
        })
        .filter(Boolean);
      return { data, next_cursor: null, has_more: false, review_required_ids: [] };
    },

    /** GET /v1/code/triggers/:id */
    async getTrigger(routineId) {
      return getTriggerDocument(routineId);
    },

    /** POST /v1/code/triggers — the cloud form's create, mapped to a local task. */
    async createTrigger(body = {}) {
      const prompt = textOf(body.prompt).trim();
      if (!prompt) throw badRequest("a routine needs instructions");
      const displayName = textOf(body.name).trim() || "Routine";
      const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "").slice(0, 60) || `routine-${randomUUID().slice(0, 8)}`;
      const args = {
        name: slug,
        displayName: displayName.slice(0, 200),
        prompt,
        description: textOf(body.description).slice(0, 2000),
      };
      if (textOf(body.cron_expression)) args.cronExpression = body.cron_expression;
      if (textOf(body.run_once_at)) args.fireAt = body.run_once_at;
      if (textOf(body.model)) args.model = body.model;
      if (textOf(body.permission_mode)) args.permissionMode = body.permission_mode;
      if (textOf(body.cwd)) args.cwd = body.cwd;
      const existing = await tasks();
      let created;
      try {
        created = await desktop.invoke("CoworkScheduledTasks", "createScheduledTask",
          [args, { existingIds: existing.map((task) => task.id).filter(Boolean) }],
          "json-undefined-v1");
      } catch (error) {
        throw new RoutineError(502, "api_error",
          `the scheduled task store refused the routine: ${error?.message || error}`);
      }
      let taskId = created?.id ?? created?.scheduledTaskId;
      if (!taskId) {
        const after = await tasks();
        taskId = after.find((task) =>
          (task.displayName || task.name) === args.displayName)?.id;
      }
      if (!taskId) throw new RoutineError(502, "api_error", "the routine was not created");
      return { ...(await getTriggerDocument(routineIdForTaskId(taskId))), deduplicated: false };
    },

    /** POST/PATCH /v1/code/triggers/:id */
    async updateTrigger(routineId, body = {}) {
      const { task, taskId } = await taskRecord(routineId);
      const patch = {};
      if (body.name !== undefined) patch.displayName = textOf(body.name).trim().slice(0, 200);
      if (body.prompt !== undefined) patch.prompt = textOf(body.prompt);
      if (body.description !== undefined) patch.description = textOf(body.description);
      if (body.cron_expression !== undefined) patch.cronExpression = textOf(body.cron_expression) || undefined;
      if (body.run_once_at !== undefined) patch.fireAt = textOf(body.run_once_at) || undefined;
      if (body.model !== undefined) patch.model = textOf(body.model) || undefined;
      if (body.permission_mode !== undefined) patch.permissionMode = textOf(body.permission_mode) || undefined;
      if (body.cwd !== undefined) patch.cwd = textOf(body.cwd) || undefined;
      if (Object.keys(patch).length) {
        try {
          await desktop.invoke("CoworkScheduledTasks", "updateScheduledTask",
            [{ scheduledTaskId: taskId, ...patch }]);
        } catch (error) {
          throw new RoutineError(502, "api_error",
            `the scheduled task store refused the update: ${error?.message || error}`);
        }
      }
      if (body.enabled !== undefined) {
        await desktop.invoke("CoworkScheduledTasks", "updateScheduledTaskStatus",
          [taskId, body.enabled === false ? "disabled" : "enabled", undefined,
            task.source ?? "local"]);
      }
      return getTriggerDocument(routineId);
    },

    /** DELETE /v1/code/triggers/:id */
    async deleteTrigger(routineId) {
      const { task, taskId } = await taskRecord(routineId);
      const source = task.source ?? "local";
      const state = await load();
      if (state.tokens[routineId]) {
        // A routine with no future cannot keep a live fire credential.
        delete state.tokens[routineId];
        await save(state);
      }
      try {
        const surfaces = await desktop.inspect();
        if (Array.isArray(surfaces?.CoworkScheduledTasks)
          && surfaces.CoworkScheduledTasks.includes("deleteScheduledTask")) {
          await desktop.invoke("CoworkScheduledTasks", "deleteScheduledTask", [taskId, source]);
        } else {
          await desktop.invoke("CoworkScheduledTasks", "updateScheduledTaskStatus",
            [taskId, "deleted", false, source]);
        }
      } catch (error) {
        throw new RoutineError(502, "api_error",
          `the scheduled task store refused the delete: ${error?.message || error}`);
      }
      return {};
    },

    /** POST /v1/code/triggers/:id/run — Run now, over the same path as a fire. */
    async runTrigger(routineId, text) {
      const { task, taskId } = await taskRecord(routineId);
      const fired = await fire({ routineId, text, via: "run" });
      return {
        trigger: triggerDocument(await load(), task, taskId),
        session_id: fired.sessionId,
        conversation_id: null,
      };
    },

    /** GET /v1/code/triggers/:id/runs — the detail page's Recent fires. */
    async listRuns() {
      return { data: [], next_cursor: null, has_more: false };
    },

    /** POST /v1/code/triggers/:id/api-token */
    async mintToken(routineId, { cookie } = {}) {
      const { taskId } = await taskRecord(routineId);
      const token = newToken();
      const hash = tokenHash(token);
      await registerWithAuth({ routineId, hash, cookie });
      await mutate((state) => {
        state.tokens[routineId] = {
          token_sha256: hash,
          hint: tokenHint(token),
          created_at: new Date().toISOString(),
          task_id: taskId,
        };
      });
      return { token };
    },

    /** DELETE /v1/code/triggers/:id/api-token */
    async revokeToken(routineId, { cookie } = {}) {
      const state = await load();
      if (!state.tokens[routineId]) return {};
      delete state.tokens[routineId];
      await save(state);
      await revokeWithAuth({ routineId, cookie });
      return {};
    },

    /** The token a fire presented, or null. */
    async verifyToken(raw) {
      const token = textOf(raw).trim();
      if (!token.startsWith(tokenPrefix)) return null;
      const state = await load();
      const hash = tokenHash(token);
      for (const [routineId, entry] of Object.entries(state.tokens)) {
        if (entry?.token_sha256 === hash) return { routineId };
      }
      return null;
    },

    /** POST /v1/claude_code/routines/:id/fire */
    async fireRoutine(routineId, { text } = {}) {
      return fire({ routineId, text, via: "api" });
    },

    /** Whether a routine id names a task this instance can fire. */
    async describe(routineId) {
      const { task, taskId } = await taskRecord(routineId);
      return { task, taskId, kind: taskKind(task), enabled: taskEnabled(task) };
    },
  };
}
