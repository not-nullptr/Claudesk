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
// Claudesk extension: images attached to a fire. Upstream's body is `text`
// only; this deployment accepts an `images` array as well, with Anthropic's
// own image constraints (types and 5 MiB per image). The images ride the
// session's opening user turn, which both executors already carry.
const maxImages = 20;
const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

// The Code routine form does not send a flat `prompt`: it posts the cloud
// runner job (`job_config.ccr`), whose instructions are the first querying
// user event's message. The Desktop's own form parser reads exactly that
// event, so mirror it here — an edit re-sends the whole job config, and the
// task's saved instructions must follow the text field, not stay behind.
export function instructionsFromJobConfig(jobConfig) {
  const events = jobConfig?.ccr?.events;
  if (!Array.isArray(events)) return "";
  for (const entry of events) {
    const data = isRecord(entry?.data) ? entry.data
      : isRecord(entry?.payload) ? entry.payload : null;
    if (!data || data.shouldQuery === false || !isRecord(data.message)) continue;
    const content = data.message.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => isRecord(block) && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
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

// A task's saved runner job, when the store kept the form's own document. The
// Code form edits through `job_config.ccr.session_context`; a UI-created task
// carries the effort there (the Desktop's task record has no effort field), so
// both the detail view and a fire read this beside the top-level fields.
function taskSessionContext(task) {
  const job = isRecord(task?.jobConfig) ? task.jobConfig
    : isRecord(task?.job_config) ? task.job_config : null;
  const context = job?.ccr?.session_context;
  return isRecord(context) ? context : {};
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
  // A store that answered for the task knows its executor even when the path
  // is unreadable: the Code form creates in the Code store, the Cowork form in
  // the Cowork store.
  if (task?._routineSurface === "CCDScheduledTasks") return "code";
  if (task?._routineSurface === "CoworkScheduledTasks") return "cowork";
  return task?.sessionType === "code" || task?.kind === "code" ? "code" : "cowork";
}

export function createRoutineService({
  stateDir,
  desktop,
  codeRunners = null,
  configuredModels = [],
  defaultModel = "",
  // A deployment whose models come from the gateway's discovery (an empty
  // `CLAUDE_INFERENCE_MODELS_JSON`) has no static list here. This reads the
  // list the instance actually offers, when it has one — see the routine's
  // model choice below.
  resolveModels = null,
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
        // Per-routine settings the scheduled-task store has no field for. Today
        // that is the effort level: a Code session carries `effort_level`, but
        // the Desktop's task record only keeps model/permission/cwd. The bridge
        // stores it here and puts it on the fire body it starts.
        configs: isRecord(parsed.configs) ? parsed.configs : {},
      } : { version: 1, tokens: {}, fires: {}, api_fires: [], configs: {} };
    } catch {
      cache = { version: 1, tokens: {}, fires: {}, api_fires: [], configs: {} };
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

  // A routine is a **Code** scheduled task: the Code form, the cloud routines
  // API and the Code surface's own task list are views of the same objects
  // (`CCDScheduledTasks`, `~/.claude/scheduled-tasks`). Cowork's scheduled
  // tasks are a separate product surface (`CoworkScheduledTasks`, the
  // user-files `Scheduled` folder) and are not routines. A build that predates
  // the Code surface has only the Cowork store, and therein it is the routine
  // store.
  async function routineStore() {
    try {
      const surfaces = await desktop.inspect();
      if (Array.isArray(surfaces?.CCDScheduledTasks)
        && surfaces.CCDScheduledTasks.includes("getAllScheduledTasks")) {
        return "CCDScheduledTasks";
      }
    } catch { /* an older wrapper answers no surfaces */ }
    return "CoworkScheduledTasks";
  }

  async function tasks() {
    const surface = await routineStore();
    try {
      const value = await desktop.invoke(surface, "getAllScheduledTasks", []);
      return (Array.isArray(value) ? value : [])
        .filter(isRecord)
        .map((task) => ({ ...task, _routineSurface: surface }));
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
        task?._routineSurface ?? "CoworkScheduledTasks",
        "getScheduledTaskFileContent", [taskId]);
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

  async function modelFor(task) {
    let discovered = null;
    if (typeof resolveModels === "function") {
      try {
        const value = await resolveModels();
        if (Array.isArray(value) && value.length) discovered = value;
      } catch { /* fall back to the operator's static list */ }
    }
    const available = discovered ?? configuredModels;
    const configured = new Set(available);
    const chosen = textOf(task?.model);
    if (chosen && (configured.size === 0 || configured.has(chosen))) return chosen;
    return textOf(defaultModel) || available[0] || "";
  }

  function tokenFor(state, routineId) {
    const entry = state.tokens[routineId];
    return isRecord(entry) && typeof entry.token_sha256 === "string" ? entry : null;
  }

  function triggerDocument(state, task, taskId, prompt) {
    const routineId = routineIdForTaskId(taskId);
    const token = tokenFor(state, routineId);
    const config = isRecord(state.configs?.[routineId]) ? state.configs[routineId] : {};
    const taskContext = taskSessionContext(task);
    const effort = textOf(config.effort) || textOf(taskContext.effort_level)
      || textOf(taskContext.effort);
    const taskCwd = textOf(task.cwd) || textOf(taskContext.cwd);
    const taskPermission = textOf(task.permissionMode) || textOf(taskContext.permission_mode);
    return {
      id: routineId,
      name: task.displayName || task.name || taskId,
      ...(prompt !== undefined ? { prompt } : {}),
      // The routine page renders its instruction block from `job_config`, not
      // from the flat prompt: the Desktop's own form parser reads the runner
      // job's opening user event. Build the same shape the create form posts,
      // so the detail and edit views see the instructions the task runs.
      ...(prompt !== undefined ? {
        job_config: {
          ccr: {
            session_context: {
              sources: [],
              outcomes: [],
              model: textOf(task.model) || null,
              // The Code form edits through the job config; carrying the
              // start options here (as well as the top-level fields above)
              // is what lets the edit form show the routine's own values.
              ...(taskCwd ? { cwd: taskCwd } : {}),
              ...(taskPermission ? { permission_mode: taskPermission } : {}),
              ...(effort ? { effort_level: effort } : {}),
            },
            events: prompt
              ? [{
                data: {
                  type: "user",
                  message: { role: "user", content: prompt },
                },
              }]
              : [],
          },
        },
      } : {}),
      description: textOf(task.description),
      enabled: taskEnabled(task),
      ...(textOf(task.cronExpression) ? { cron_expression: task.cronExpression } : {}),
      ...(isoTime(task.fireAt) ? { run_once_at: isoTime(task.fireAt) } : {}),
      ...(isoTime(task.nextRunAt) ? { next_run_at: isoTime(task.nextRunAt) } : {}),
      ...(isoTime(task.lastRunAt) ? { last_fired_at: isoTime(task.lastRunAt) } : {}),
      ...(textOf(task.model) ? { model: task.model } : {}),
      ...(taskPermission ? { permission_mode: taskPermission } : {}),
      ...(effort ? { effort_level: effort, effort } : {}),
      persist_session: false,
      source: "local",
      kind: taskKind(task),
      ...(taskCwd ? { cwd: taskCwd } : {}),
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

  /**
   * The fire body's images, normalized to the Desktop's own shape
   * (`{name, mimeType, base64}`). A Claude API-style `{media_type, data}` pair
   * is accepted too, so a caller can paste a content block's source directly.
   */
  function normalizeImages(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw badRequest("images must be an array");
    if (raw.length > maxImages) {
      throw badRequest(`at most ${maxImages} images are allowed`);
    }
    return raw.map((entry, index) => {
      const record = isRecord(entry) ? entry : {};
      const mimeType = textOf(record.media_type ?? record.mimeType ?? record.mime_type)
        .toLowerCase();
      const rawData = textOf(record.data ?? record.base64 ?? record.data_base64)
        .replace(/\s+/g, "");
      const name = textOf(record.name) || `image-${index + 1}`;
      if (!imageTypes.has(mimeType)) {
        throw badRequest(`image ${index + 1} must be png, jpeg, gif or webp`);
      }
      if (!rawData || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawData)) {
        throw badRequest(`image ${index + 1} has no valid base64 data`);
      }
      const bytes = Buffer.from(rawData, "base64");
      if (!bytes.length) throw badRequest(`image ${index + 1} has no data`);
      if (bytes.length > maxImageBytes) {
        throw badRequest(`image ${index + 1} is larger than 5 MiB`);
      }
      return { name, mimeType, base64: bytes.toString("base64") };
    });
  }

  function userEvent(message, images = []) {
    const content = [{ type: "text", text: message }];
    for (const image of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.base64 },
      });
    }
    return {
      payload: {
        type: "user",
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: "user", content },
      },
    };
  }

  async function startCodeSession(task, message, model, images = [], routineId = "", effort = "") {
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
        // Attribution the Code routine page reads its run history from. It
        // asks the session list for `trigger_id=<this routine>`; a session
        // without the id is not a run of that routine.
        ...(routineId ? { trigger_id: routineId, origin: "fire_routine" } : {}),
        config: {
          sources: [],
          ...(textOf(task.cwd) ? { cwd: task.cwd } : {}),
          model,
          ...(effort ? { effort_level: effort } : {}),
          ...(textOf(task.permissionMode) ? { permission_mode: task.permissionMode } : {}),
        },
        events: [userEvent(message, images)],
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

  async function startCoworkSession(task, taskId, message, model, images = []) {
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
      images,
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

  async function fire({ routineId, text, images, via = "api" }) {
    if (text !== undefined && typeof text !== "string") {
      throw badRequest("text must be a string");
    }
    if (typeof text === "string" && text.length > maxTextChars) {
      throw badRequest(`text must be at most ${maxTextChars} characters`);
    }
    const attached = normalizeImages(images);
    const { task, taskId } = await taskRecord(routineId);
    // A caller may address the task by its raw id; everything the record keys
    // on — the fire budget, the run attribution — uses the routine id the
    // page reads.
    const canonicalId = routineIdForTaskId(taskId);
    if (!taskEnabled(task)) throw badRequest("this routine is paused");
    const prompt = await promptFor(task, taskId);
    if (!prompt) throw badRequest("this routine has no instructions");
    const model = await modelFor(task);
    if (!model) throw unavailable("this instance has no inference model configured");

    const state = await load();
    const retryAfter = fireBudget(state, canonicalId, Date.now());
    if (retryAfter > 0) {
      throw new RoutineError(429, "rate_limit_error",
        "the routine fire limit has been reached", { retryAfter });
    }

    const message = mergeText(prompt, text);
    const kind = taskKind(task);
    const taskContext = taskSessionContext(task);
    const effort = textOf(state.configs?.[canonicalId]?.effort)
      || textOf(taskContext.effort_level) || textOf(taskContext.effort);
    const sessionId = kind === "code"
      ? await startCodeSession(task, message, model, attached, canonicalId, effort)
      : await startCoworkSession(task, taskId, message, model, attached);

    // The run is already live; a read-only state directory must not turn it
    // into an error the caller would retry (and so start a second session).
    await mutate((current) => recordFire(current, canonicalId, via)).catch((error) => {
      log.warn(`[routines] could not record the fire of ${canonicalId}: ${error?.message || error}`);
    });
    log.log(`[routines] fired ${canonicalId} (${kind}) as ${sessionId}`);
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
      const prompt = textOf(body.prompt).trim()
        || instructionsFromJobConfig(body.job_config);
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
      // The Code form carries its model, start folder, permission mode and
      // effort in the runner job, not at the top level; the Cowork form sends
      // flat fields. Both spellings are accepted.
      const context = isRecord(body?.job_config?.ccr?.session_context)
        ? body.job_config.ccr.session_context : {};
      const chosenModel = textOf(body.model) || textOf(context.model);
      if (chosenModel) args.model = chosenModel;
      const chosenPermission = textOf(body.permission_mode) || textOf(context.permission_mode);
      if (chosenPermission) args.permissionMode = chosenPermission;
      const chosenCwd = textOf(body.cwd) || textOf(context.cwd);
      if (chosenCwd) args.cwd = chosenCwd;
      const chosenEffort = textOf(body.effort_level ?? body.effort)
        || textOf(context.effort_level ?? context.effort);
      // A routine is a Code scheduled task. On a build with the Code store
      // that is where every create lands, whichever form shape it came in.
      const surface = await routineStore();
      const existing = await tasks();
      let created;
      try {
        created = await desktop.invoke(surface, "createScheduledTask",
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
      const routineId = routineIdForTaskId(taskId);
      if (chosenEffort) {
        await mutate((state) => {
          state.configs[routineId] = { ...(state.configs[routineId] || {}), effort: chosenEffort };
        });
      }
      return { ...(await getTriggerDocument(routineId)), deduplicated: false };
    },

    /** POST/PATCH /v1/code/triggers/:id */
    async updateTrigger(routineId, body = {}) {
      const { task, taskId } = await taskRecord(routineId);
      const patch = {};
      if (body.name !== undefined) patch.displayName = textOf(body.name).trim().slice(0, 200);
      if (body.prompt !== undefined) {
        patch.prompt = textOf(body.prompt);
      } else if (body.job_config !== undefined) {
        // The Code form edits through the same job-config shape it creates
        // with; keep the task's instructions in step with its text field.
        const prompt = instructionsFromJobConfig(body.job_config);
        if (prompt) patch.prompt = prompt;
      }
      if (body.description !== undefined) patch.description = textOf(body.description);
      if (body.cron_expression !== undefined) patch.cronExpression = textOf(body.cron_expression) || undefined;
      if (body.run_once_at !== undefined) patch.fireAt = textOf(body.run_once_at) || undefined;
      const context = isRecord(body?.job_config?.ccr?.session_context)
        ? body.job_config.ccr.session_context : null;
      if (body.model !== undefined) {
        patch.model = textOf(body.model) || undefined;
      } else if (context) {
        patch.model = textOf(context.model) || undefined;
      }
      if (body.permission_mode !== undefined) {
        patch.permissionMode = textOf(body.permission_mode) || undefined;
      } else if (context && context.permission_mode !== undefined) {
        patch.permissionMode = textOf(context.permission_mode) || undefined;
      }
      if (body.cwd !== undefined) {
        patch.cwd = textOf(body.cwd) || undefined;
      } else if (context && context.cwd !== undefined) {
        patch.cwd = textOf(context.cwd) || undefined;
      }
      const effortGiven = body.effort_level !== undefined || body.effort !== undefined
        || (context && (context.effort_level !== undefined || context.effort !== undefined));
      const chosenEffort = textOf(body.effort_level ?? body.effort)
        || textOf(context?.effort_level ?? context?.effort);
      const surface = task._routineSurface ?? "CoworkScheduledTasks";
      if (Object.keys(patch).length) {
        try {
          await desktop.invoke(surface, "updateScheduledTask",
            [{ scheduledTaskId: taskId, ...patch }]);
        } catch (error) {
          throw new RoutineError(502, "api_error",
            `the scheduled task store refused the update: ${error?.message || error}`);
        }
      }
      if (body.enabled !== undefined) {
        await desktop.invoke(surface, "updateScheduledTaskStatus",
          [taskId, body.enabled === false ? "disabled" : "enabled", undefined,
            task.source ?? "local"]);
      }
      if (effortGiven) {
        await mutate((state) => {
          const current = state.configs[routineId] || {};
          if (chosenEffort) state.configs[routineId] = { ...current, effort: chosenEffort };
          else delete state.configs[routineId];
        });
      }
      return getTriggerDocument(routineId);
    },

    /** DELETE /v1/code/triggers/:id */
    async deleteTrigger(routineId) {
      const { task, taskId } = await taskRecord(routineId);
      const source = task.source ?? "local";
      const state = await load();
      if (state.tokens[routineId] || state.configs[routineId]) {
        // A routine with no future cannot keep a live fire credential, and its
        // per-routine settings die with it.
        delete state.tokens[routineId];
        delete state.configs[routineId];
        await save(state);
      }
      try {
        const surface = task._routineSurface ?? "CoworkScheduledTasks";
        const surfaces = await desktop.inspect();
        // The Code store has no delete method; a deleted status with the file
        // removed is its own delete.
        if (Array.isArray(surfaces?.[surface])
          && surfaces[surface].includes("deleteScheduledTask")) {
          await desktop.invoke(surface, "deleteScheduledTask", [taskId, source]);
        } else {
          await desktop.invoke(surface, "updateScheduledTaskStatus",
            [taskId, "deleted", false, source]);
        }
      } catch (error) {
        throw new RoutineError(502, "api_error",
          `the scheduled task store refused the delete: ${error?.message || error}`);
      }
      return {};
    },

    /** POST /v1/code/triggers/:id/run — Run now, over the same path as a fire. */
    async runTrigger(routineId, text, images) {
      const { task, taskId } = await taskRecord(routineId);
      const fired = await fire({ routineId, text, images, via: "run" });
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
    async fireRoutine(routineId, { text, images } = {}) {
      return fire({ routineId, text, images, via: "api" });
    },

    /** Whether a routine id names a task this instance can fire. */
    async describe(routineId) {
      const { task, taskId } = await taskRecord(routineId);
      return { task, taskId, kind: taskKind(task), enabled: taskEnabled(task) };
    },
  };
}
