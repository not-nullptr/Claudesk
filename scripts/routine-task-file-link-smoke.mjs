import assert from "node:assert/strict";
import { linkSync, readFileSync, symlinkSync } from "node:fs";
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

// The Desktop refuses to publish a routine's own file when it is hard-linked to
// another name — a sandboxed agent can create that link through a shared folder,
// and the write would then land on the link's other name. The refusal is right,
// but on its own it strands the routine: every later edit, from every client,
// answers "Not written: this task's file is hard-linked to another file. Replace
// it with a plain copy." and only somebody with shell access on that machine can
// clear it.
//
// The wrapper now does what the refusal asks, at the main process boundary: a
// write channel repairs first (move the linked file aside, so the store's own
// write creates a plain one), and a refusal that still arrives repairs and
// retries once. These checks pin the repair's reach — both routine roots, the
// root the Desktop persisted rather than the home default — and its limits:
// plain files are left alone, a symlink is neither followed nor moved, and it
// never writes through the link it moves.

const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
const start = wrapper.indexOf("// A routine's files belong to the Desktop");
const end = wrapper.indexOf("const ionMimeTypes = {");
assert.notEqual(start, -1, "the wrapper still carries the routine file-link repair");
assert.ok(end > start, "the routine file-link repair still precedes the static tables");
const repairSource = wrapper.slice(start, end);

const home = await mkdtemp(join(tmpdir(), "routine-link-"));
const userData = join(home, "userData");
const coworkRoot = join(home, "Claude");
// The Desktop persists the Cowork user-files root it resolved, so the repair has
// to read that setting instead of assuming the home default.
await mkdir(userData, { recursive: true });
await writeFile(
  join(userData, "claude_desktop_config.json"),
  JSON.stringify({ preferences: { coworkUserFilesPath: coworkRoot } }),
);

const warnings = [];
const registered = new Map();
const ipcMain = {
  handle(channel, listener) {
    registered.set(channel, listener);
    return undefined;
  },
};
const sandbox = {
  app: {
    getPath: (name) => ({ home, userData })[name],
  },
  ipcMain,
  join,
  lstat,
  readdir,
  rename,
  readFileSync,
  process: { env: {} },
  console: {
    warn: (...args) => warnings.push(args.map(String).join(" ")),
    info: () => {},
    error: () => {},
    log: () => {},
  },
  coworkHostBashEnabled: false,
  coworkVmMemoryGB: 2,
  noteCoworkVmActivity: () => {},
};
vm.createContext(sandbox);
vm.runInContext(repairSource, sandbox);

const channelPrefix = "$eipc$_claude.web_$_CoworkScheduledTasks_$_";
// The two trees the Desktop's own stores keep routine files in. The fake store
// below reads the same two, so what the repair leaves is what the store sees.
const codeRoot = join(home, ".claude", "scheduled-tasks");
const coworkScheduledRoot = join(coworkRoot, "Scheduled");
const taskDir = (id) => (id.startsWith("cowork-") ? join(coworkScheduledRoot, id) : join(codeRoot, id));

// The store's side of a write: it looks at its own task directory first (the
// Desktop's writer checks the path it is about to publish), then writes.
const storeCalls = [];
ipcMain.handle(channelPrefix + "updateScheduledTask", async (_event, task) => {
  const id = task?.scheduledTaskId;
  // A store resolves the task's own directory from its id, and reads it back
  // before publishing. An id it cannot use reaches no directory at all.
  const names = typeof id === "string" ? await readdir(taskDir(id)).catch(() => null) : null;
  storeCalls.push({ id, names });
  return "updated";
});

// --- the Code store: a linked SKILL.md is repaired before the write ---------
// A Code routine's files live in the Claude config directory's `scheduled-tasks`
// tree. The linked file is the reported failure: the Desktop's writer cannot
// touch it, so the update never reaches the store.
const codeId = "schedule-test";
const codeDir = join(codeRoot, codeId);
const codeFile = join(codeDir, "SKILL.md");
const watcherFile = join(codeDir, "watching.js");
const twin = join(home, "authorized_keys");
await mkdir(codeDir, { recursive: true });
await writeFile(codeFile, "ssh-rsa AAAA the other name's bytes\n");
await writeFile(watcherFile, "// plain, and must stay put\n");
linkSync(codeFile, twin);
assert.equal((await lstat(codeFile)).nlink, 2, "the fixture starts hard-linked");

assert.equal(
  await registered.get(channelPrefix + "updateScheduledTask")({}, { scheduledTaskId: codeId }),
  "updated",
);
assert.equal(storeCalls.length, 1, "the store's own write runs once, and only after the repair");
const [codeCall] = storeCalls;
assert.equal(codeCall.id, codeId);
assert.equal(codeCall.names.length, 2, "the linked file is moved aside before the write");
assert.ok(!codeCall.names.includes("SKILL.md"), "the path the store writes is free");
assert.ok(codeCall.names.some((name) => name.startsWith("SKILL.md.hardlinked-")), "the linked file is kept, aside");
assert.deepEqual(codeCall.names.filter((name) => !name.startsWith("SKILL.md")), ["watching.js"],
  "a plain neighbour is untouched");

// The store's write then lands on a plain file — the point of the repair.
const aside = (await readdir(codeDir)).find((name) => name.startsWith("SKILL.md.hardlinked-"));
assert.equal(await readFile(join(codeDir, aside), "utf8"), "ssh-rsa AAAA the other name's bytes\n",
  "the aside copy is the linked file itself, so nothing was written through the link");
assert.equal((await lstat(twin)).nlink, 2, "the other name keeps its own link and its bytes");
assert.equal(await readFile(twin, "utf8"), "ssh-rsa AAAA the other name's bytes\n");
await writeFile(codeFile, "new prompt\n");
assert.equal((await lstat(codeFile)).nlink, 1, "the rewritten task file is plain");
assert.ok(warnings.some((line) => line.includes(codeId) && line.includes("nlink 2")),
  "the repair is reported with the link count it saw");

// --- the Cowork store: the persisted root, not the home default -------------
// A Cowork routine's files live in `<coworkUserFilesRoot>/Scheduled`, which the
// Desktop resolves and persists — the repair has to find that tree too.
const coworkId = "cowork-heartbeat";
const coworkDir = join(coworkScheduledRoot, coworkId);
await mkdir(coworkDir, { recursive: true });
await writeFile(join(coworkDir, "SKILL.md"), "cowork task\n");
linkSync(join(coworkDir, "SKILL.md"), join(home, "cowork-twin"));
await registered.get(channelPrefix + "updateScheduledTask")({}, { scheduledTaskId: coworkId });
const [coworkCall] = storeCalls.slice(-1);
assert.ok(!coworkCall.names.includes("SKILL.md"), "the Cowork store's linked file is repaired too");
assert.ok(coworkCall.names.some((name) => name.startsWith("SKILL.md.hardlinked-")));
assert.equal((await lstat(join(home, "cowork-twin"))).nlink, 2,
  "and the twin it shared an inode with is still there");

// --- a refusal that arrives anyway repairs and retries once -----------------
// A link the repair did not see — created between the repair and the write, or
// under a root it does not know — surfaces as the call's own error, and that is
// the retry's cue. The second attempt must find a plain path.
const raceId = "schedule-race";
const raceDir = join(codeRoot, raceId);
await mkdir(raceDir, { recursive: true });
let raceAttempts = 0;
ipcMain.handle(channelPrefix + "updateScheduledTaskFileContent", async (_event, task) => {
  raceAttempts += 1;
  if (raceAttempts === 1) {
    await writeFile(join(raceDir, "SKILL.md"), "linked after the repair\n");
    linkSync(join(raceDir, "SKILL.md"), join(home, "race-twin"));
    throw new Error(
      "Error invoking remote method 'x': Error: Not written: this task's file is"
      + " hard-linked to another file. Replace it with a plain copy.",
    );
  }
  const names = await readdir(raceDir);
  assert.ok(!names.includes("SKILL.md"), "the retry follows a repair");
  assert.ok(names.some((name) => name.startsWith("SKILL.md.hardlinked-")),
    "the file that appeared mid-flight is the one moved aside");
  return "updated";
});
assert.equal(
  await registered.get(channelPrefix + "updateScheduledTaskFileContent")(
    {}, { scheduledTaskId: raceId }),
  "updated",
);
assert.equal(raceAttempts, 2, "the refusal is retried exactly once");

// --- limits: a plain file, a symlink, an unusable id ------------------------
// The repair only moves files that are linked. A plain task reaches the store
// exactly as its own writer left it, and a symlink is a different refusal (the
// store refuses those itself) that must not be turned into a silent repair.
const plainId = "schedule-plain";
const plainDir = join(codeRoot, plainId);
await mkdir(plainDir, { recursive: true });
await writeFile(join(plainDir, "SKILL.md"), "plain task\n");

const linkId = "schedule-symlink";
const linkDir = join(codeRoot, linkId);
const outside = join(home, "outside.md");
await mkdir(linkDir, { recursive: true });
await writeFile(outside, "outside\n");
symlinkSync(outside, join(linkDir, "SKILL.md"));

const idleId = "schedule-idle";
const idleDir = join(codeRoot, idleId);
await mkdir(idleDir, { recursive: true });
await writeFile(join(idleDir, "SKILL.md"), "idle\n");
linkSync(join(idleDir, "SKILL.md"), join(home, "idle-twin"));

await registered.get(channelPrefix + "updateScheduledTask")({}, { scheduledTaskId: plainId });
assert.deepEqual(storeCalls.slice(-1)[0].names, ["SKILL.md"], "a plain task reaches the store untouched");
assert.equal(await readFile(join(plainDir, "SKILL.md"), "utf8"), "plain task\n");
assert.deepEqual(await readdir(plainDir), ["SKILL.md"], "and nothing is left beside it");

await registered.get(channelPrefix + "updateScheduledTask")({}, { scheduledTaskId: linkId });
assert.deepEqual(storeCalls.slice(-1)[0].names, ["SKILL.md"], "a symlinked path still reaches the store");
assert.ok((await lstat(join(linkDir, "SKILL.md"))).isSymbolicLink(),
  "a symlinked task file is left for the store's own refusal");

// An id the repair cannot use (absent, or not a task id) is a no-op rather than
// a path beside the roots: the store still gets the call.
await registered.get(channelPrefix + "updateScheduledTask")({}, {});
assert.deepEqual(storeCalls.slice(-1)[0], { id: undefined, names: null },
  "an id-less write is passed through");
await registered.get(channelPrefix + "updateScheduledTask")({}, { scheduledTaskId: "../escape" });
assert.deepEqual(storeCalls.slice(-1)[0], { id: "../escape", names: null },
  "a path-shaped id repairs nothing and is passed through");

// The repair runs on a task's own writes, not as a background sweep.
assert.equal((await lstat(join(idleDir, "SKILL.md"))).nlink, 2,
  "an untouched routine is not repaired");
assert.ok(!(await readdir(idleDir)).some((name) => name.startsWith("SKILL.md.hardlinked-")));

// --- the hook is scoped to the channels that write task files ---------------
// A read must not pay for the repair, and neither must the surfaces around it.
await rm(join(plainDir, "SKILL.md"));
linkSync(join(idleDir, "SKILL.md"), join(plainDir, "SKILL.md"));
const linkedLinks = (await lstat(join(plainDir, "SKILL.md"))).nlink;
assert.ok(linkedLinks > 1, "the fixture for this check is hard-linked");
ipcMain.handle(channelPrefix + "getAllScheduledTasks", async () => "tasks");
assert.equal(await registered.get(channelPrefix + "getAllScheduledTasks")({}), "tasks");
assert.equal((await lstat(join(plainDir, "SKILL.md"))).nlink, linkedLinks, "a listing does not repair");
ipcMain.handle(channelPrefix + "updateScheduledTaskStatus", async () => "status");
assert.equal(
  await registered.get(channelPrefix + "updateScheduledTaskStatus")({}, { scheduledTaskId: plainId }),
  "status",
);
assert.equal((await lstat(join(plainDir, "SKILL.md"))).nlink, linkedLinks,
  "a status change does not repair — it writes no task file");

await rm(home, { recursive: true, force: true });
console.log("routine-task-file-link-smoke: ok");
