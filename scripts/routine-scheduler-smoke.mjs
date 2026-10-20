import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRoutineService,
  nextCronSlotFor,
  parseCronExpression,
  routineIdForTaskId,
} from "../bridge/routines.mjs";

// The bridge's own routine clock: Code routines used to need an open web page
// (the Desktop only checks due tasks once a renderer declares itself ready),
// so the bridge now keeps the clock itself, using the same fire path Run now
// and the API trigger use. This pins the cron maths and the slot bookkeeping
// with a fake Desktop and a clock the smoke advances by hand.
const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "routine-scheduler-"));

const created = [];
const files = {};
let currentTasks = [];

function fakeDesktop() {
  return {
    async invoke(surface, method, args) {
      if (surface !== "CCDScheduledTasks") return null;
      if (method === "getAllScheduledTasks") return currentTasks;
      if (method === "getScheduledTaskFileContent") return files[args[0]] ?? null;
      if (method === "updateScheduledTask") return true;
      if (method === "setHostRunsSupported") return true;
      return null;
    },
    async inspect() {
      return {
        CCDScheduledTasks: [
          "getAllScheduledTasks", "getScheduledTaskFileContent",
          "updateScheduledTask", "setHostRunsSupported",
        ],
      };
    },
  };
}

const codeRunners = {
  async primaryPool() {
    return { pool_id: "ccpool_sched", name: "sched" };
  },
  async createSession({ body, source }) {
    created.push({ body, source });
    return { session: { id: `cse_sched_${created.length}` } };
  },
};

const service = createRoutineService({
  stateDir: join(home, "state"),
  desktop: fakeDesktop(),
  codeRunners,
  configuredModels: ["model-a"],
  defaultModel: "model-a",
  wakeRunner: () => {},
  log: { log() {}, warn() {} },
  // The smoke drives the clock; the interval arm is not started.
  startScheduler: false,
});

function task(overrides = {}) {
  return {
    id: "task-1",
    displayName: "hourly",
    filePath: "/config/.claude/scheduled-tasks/task-1/SKILL.md",
    cronExpression: "0 * * * *",
    enabled: true,
    model: "model-a",
    ...overrides,
  };
}

function triggerFor(taskId) {
  return service.listTriggers().then(({ data }) =>
    data.find((trigger) => trigger.id === routineIdForTaskId(taskId)));
}

try {
  // --- the cron maths (local time, like the bridge's TZ) -------------------
  assert.equal(parseCronExpression("not a cron"), null);
  assert.equal(parseCronExpression("0 9 * *"), null, "a missing field is refused");
  assert.ok(parseCronExpression("0 9 * * *"), "a five-field expression parses");
  assert.deepEqual(
    [...parseCronExpression("1,2,3 */6 * * *").minute].sort((a, b) => a - b),
    [1, 2, 3],
    "lists are supported",
  );
  assert.deepEqual(
    [...parseCronExpression("1,2,3 */6 * * *").hour].sort((a, b) => a - b),
    [0, 6, 12, 18],
    "steps are supported",
  );
  assert.ok(parseCronExpression("0 0 * jan-mar mon-fri"), "names and ranges are supported");

  const at8 = new Date(2026, 9, 20, 8, 59, 0).getTime();
  assert.equal(
    nextCronSlotFor("0 9 * * *", at8),
    new Date(2026, 9, 20, 9, 0, 0).getTime(),
    "the next daily slot is the coming 09:00",
  );
  assert.equal(
    nextCronSlotFor("*/15 * * * *", new Date(2026, 9, 20, 9, 1, 0).getTime()),
    new Date(2026, 9, 20, 9, 15, 0).getTime(),
    "a step slot advances to the next step",
  );
  const monday = nextCronSlotFor(
    "0 0 * * mon", new Date(2026, 9, 20, 12, 0, 0).getTime());
  assert.ok(monday !== null, "a weekday expression finds a slot");
  assert.equal(new Date(monday).getDay(), 1, "the slot is a Monday");
  assert.ok(monday > new Date(2026, 9, 20, 12, 0, 0).getTime());

  // --- the slot bookkeeping ------------------------------------------------
  files["task-1"] = "Do the hourly thing.\n";
  currentTasks = [task()];

  await service.scheduleNow();
  assert.equal(created.length, 0, "a freshly seen routine waits for its slot");
  const first = await triggerFor("task-1");
  assert.ok(first?.next_run_at, "the trigger document exposes the bridge's next slot");
  const firstAt = Date.parse(first.next_run_at);
  assert.ok(firstAt > Date.now(), "the next slot is in the future");

  // At the slot: one session, attributed to the routine.
  await service.scheduleNow(firstAt + 1000);
  assert.equal(created.length, 1, "the due slot starts one session");
  assert.equal(created[0].body.trigger_id, routineIdForTaskId("task-1"),
    "the run is attributed to the routine");
  assert.equal(created[0].body.origin, "fire_routine");
  const advanced = await triggerFor("task-1");
  assert.ok(Date.parse(advanced.next_run_at) > firstAt, "the slot advances");

  // Asking again at the same instant must not fire it twice.
  await service.scheduleNow(firstAt + 2000);
  assert.equal(created.length, 1, "one slot fires once");

  // The Desktop's own record can prove a slot already ran (a page-open
  // scheduler). The bridge then skips it rather than duplicating the run.
  const already = Date.now() + 60 * 60 * 1000;
  currentTasks = [task({
    lastRunAt: new Date(already).toISOString(),
    cronExpression: "0 * * * *",
  })];
  await service.scheduleNow();
  const beforeSkip = created.length;
  await service.scheduleNow(already + 1000);
  assert.equal(created.length, beforeSkip, "a slot the Desktop already ran is skipped");

  // A disabled routine never fires.
  currentTasks = [task({
    id: "task-2",
    displayName: "paused",
    enabled: false,
    filePath: "/config/.claude/scheduled-tasks/task-2/SKILL.md",
  })];
  files["task-2"] = "Nope.\n";
  await service.scheduleNow();
  const disabledCount = created.length;
  await service.scheduleNow(Date.now() + 2 * 60 * 60 * 1000);
  assert.equal(created.length, disabledCount, "a disabled routine does not fire");

  // A one-shot (`fireAt`) fires once and is then done.
  const once = Date.now() + 60 * 1000;
  currentTasks = [task({
    id: "task-3",
    displayName: "once",
    cronExpression: undefined,
    fireAt: new Date(once).toISOString(),
    filePath: "/config/.claude/scheduled-tasks/task-3/SKILL.md",
  })];
  files["task-3"] = "Once.\n";
  await service.scheduleNow();
  const beforeOnce = created.length;
  await service.scheduleNow(once + 1000);
  assert.equal(created.length, beforeOnce + 1, "a one-shot fires at its time");
  await service.scheduleNow(once + 120_000);
  assert.equal(created.length, beforeOnce + 1, "a one-shot does not fire again");
} finally {
  await rm(home, { recursive: true, force: true });
}

process.stdout.write("routine-scheduler-smoke: cron slots, due fires and one-shots hold\n");
