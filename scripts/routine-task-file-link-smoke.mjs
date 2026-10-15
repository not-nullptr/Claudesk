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
// The wrapper does what the refusal asks, at the main process boundary where the
// writing IPCs already cross: move the linked file aside, so the store's own
// write creates a plain one. These checks drive it through a store that refuses
// exactly like the Desktop's does, and hold the repair to its reach — both
// routine trees, every root the Desktop's own resolver can answer with, the two
// argument shapes a task id arrives in, and the sweep when the id names no
// directory — and to its limits: a plain file and a symlink are left alone, a
// read or a status change repairs nothing, and a refusal the repair cannot clear
// comes back to the client with what the repair saw.

const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
const start = wrapper.indexOf("// A routine's files belong to the Desktop");
const end = wrapper.indexOf("const ionMimeTypes = {");
assert.notEqual(start, -1, "the wrapper still carries the routine file-link repair");
assert.ok(end > start, "the routine file-link repair still precedes the static tables");
const repairSource = wrapper.slice(start, end);

const home = await mkdtemp(join(tmpdir(), "routine-link-"));
const userData = join(home, "userData");
// The Desktop persists the Cowork root it resolved — here to a directory no task
// lives in, so the checks below also prove the resolver's other answers are tried
// rather than only the configured one.
await mkdir(userData, { recursive: true });
await writeFile(
  join(userData, "claude_desktop_config.json"),
  JSON.stringify({ preferences: { coworkUserFilesPath: join(home, "custom-cowork") } }),
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
    getPath: (name) => ({
      home,
      userData,
      documents: join(home, "Documents"),
    }[name]),
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
const codeRoot = join(home, ".claude", "scheduled-tasks");
const coworkScheduledRoot = join(home, "Claude", "Scheduled");

// The store, as the Desktop's is: it knows where each task's file is (which is
// not necessarily where the wrapper looks), and its writer refuses a path that
// carries a second hard link before it writes anything.
const storeDirs = new Map();
const storeCalls = [];
const refusal =
  "Not written: this task's file is hard-linked to another file. Replace it with a plain copy.";
async function storeWrite(args) {
  const task = args.find((value) => value && typeof value === "object") ?? {};
  const id = task.scheduledTaskId ?? args.find((value) => typeof value === "string");
  const dir = storeDirs.get(id);
  storeCalls.push({ id, dir, names: dir ? await readdir(dir).catch(() => null) : null });
  if (!dir) return "no-such-task";
  const file = join(dir, "SKILL.md");
  const info = await lstat(file).catch(() => null);
  if (info?.isFile() && info.nlink > 1) throw new Error(refusal);
  if (info?.isSymbolicLink()) throw new Error("symlink detected before open; refusing to open");
  await writeFile(file, "written by the store\n");
  return "updated";
}
ipcMain.handle(channelPrefix + "updateScheduledTask", async (_event, ...args) => storeWrite(args));

const update = (args) => registered.get(channelPrefix + "updateScheduledTask")({}, ...args);

// --- the Code store: a linked SKILL.md is repaired before the write ---------
// A Code routine's files live in the Claude config directory's `scheduled-tasks`
// tree. The linked file is the reported failure: the store's writer cannot touch
// it, so the update never lands.
const codeId = "schedule-test";
const codeDir = join(codeRoot, codeId);
const codeFile = join(codeDir, "SKILL.md");
const watcherFile = join(codeDir, "watching.js");
const twin = join(home, "authorized_keys");
await mkdir(codeDir, { recursive: true });
await writeFile(codeFile, "ssh-rsa AAAA the other name's bytes\n");
await writeFile(watcherFile, "// plain, and must stay put\n");
linkSync(codeFile, twin);
storeDirs.set(codeId, codeDir);
assert.equal((await lstat(codeFile)).nlink, 2, "the fixture starts hard-linked");

assert.equal(await update([{ scheduledTaskId: codeId, prompt: "new" }]), "updated");
assert.equal(storeCalls.length, 1, "the store's write runs once — the repair did not need a retry");
assert.ok(!storeCalls[0].names.includes("SKILL.md"), "the linked file is moved aside before the write");
assert.deepEqual(storeCalls[0].names.filter((name) => !name.startsWith("SKILL.md")), ["watching.js"],
  "a plain neighbour is untouched");

// The aside copy is the linked file itself, so nothing was written through the
// link, and the other name still has its bytes.
const aside = (await readdir(codeDir)).find((name) => name.startsWith("SKILL.md.hardlinked-"));
assert.equal(await readFile(join(codeDir, aside), "utf8"), "ssh-rsa AAAA the other name's bytes\n");
assert.equal((await lstat(twin)).nlink, 2, "the other name keeps its own link and its bytes");
assert.equal(await readFile(twin, "utf8"), "ssh-rsa AAAA the other name's bytes\n");
assert.equal((await lstat(codeFile)).nlink, 1, "the store's write landed on a plain file");
assert.equal(await readFile(codeFile, "utf8"), "written by the store\n");
assert.ok(warnings.some((line) => line.includes(codeId) && line.includes("nlink 2")),
  "the repair is reported with the link count it saw");

// --- the Cowork store, under a root the Desktop did not persist -------------
// A Cowork routine's files live in `<coworkUserFilesRoot>/Scheduled`, and the
// Desktop resolves that root itself: a config it has not written yet, or one it
// fell back from, must not make the repair miss the file.
const coworkId = "cowork-heartbeat";
const coworkDir = join(coworkScheduledRoot, coworkId);
await mkdir(coworkDir, { recursive: true });
await writeFile(join(coworkDir, "SKILL.md"), "cowork task\n");
linkSync(join(coworkDir, "SKILL.md"), join(home, "cowork-twin"));
storeDirs.set(coworkId, coworkDir);
assert.equal(await update([{ scheduledTaskId: coworkId }]), "updated");
assert.equal(await readFile(join(coworkDir, "SKILL.md"), "utf8"), "written by the store\n",
  "the Cowork store's linked file was repaired under the home root");
assert.equal((await lstat(join(home, "cowork-twin"))).nlink, 2, "and the twin it shared an inode with is there");

// --- the id can arrive on its own -------------------------------------------
// The write channels are the official API's shape, not ours: a caller that sends
// the id as its own argument still has to be repaired, not passed through.
const bareId = "schedule-bare";
const bareDir = join(codeRoot, bareId);
await mkdir(bareDir, { recursive: true });
await writeFile(join(bareDir, "SKILL.md"), "bare\n");
linkSync(join(bareDir, "SKILL.md"), join(home, "bare-twin"));
storeDirs.set(bareId, bareDir);
assert.equal(await update([bareId]), "updated");
assert.equal(await readFile(join(bareDir, "SKILL.md"), "utf8"), "written by the store\n");

// --- a refusal the id cannot explain is swept -------------------------------
// The directory holding a routine's file need not be named for the task id the
// call carries, and then the id-derived repair finds nothing while the store
// still refuses: the retry sweeps the routine directories under every root, and
// moves the linked file it finds by looking at them.
const sweptId = "schedule-swept";
const sweptDirName = "imported-9f3c";
const sweptDir = join(codeRoot, sweptDirName);
await mkdir(sweptDir, { recursive: true });
await writeFile(join(sweptDir, "SKILL.md"), "swept\n");
linkSync(join(sweptDir, "SKILL.md"), join(home, "swept-twin"));
storeDirs.set(sweptId, sweptDir);
const sweptCallsBefore = storeCalls.length;
assert.equal(await update([{ scheduledTaskId: sweptId }]), "updated",
  "the sweep's repair lets the retry through");
assert.equal(storeCalls.length - sweptCallsBefore, 2, "one refusal, one retry");
assert.equal(await readFile(join(sweptDir, "SKILL.md"), "utf8"), "written by the store\n");
assert.ok((await readdir(sweptDir)).some((name) => name.startsWith("SKILL.md.hardlinked-")),
  "the file the id did not point at is the one moved aside");

// --- a refusal the repair cannot clear says what it saw ---------------------
// The machine this happens on is one nobody logs into, so the message the client
// shows has to carry the diagnosis: the id, what was moved or found, and the
// directories that were searched.
const hiddenId = "schedule-hidden";
const hiddenDir = join(home, "store-elsewhere", hiddenId);
await mkdir(hiddenDir, { recursive: true });
await writeFile(join(hiddenDir, "SKILL.md"), "hidden\n");
linkSync(join(hiddenDir, "SKILL.md"), join(home, "hidden-twin"));
storeDirs.set(hiddenId, hiddenDir);
const hiddenBefore = storeCalls.length;
const hiddenError = await update([{ scheduledTaskId: hiddenId }]).then(
  () => null,
  (error) => error,
);
assert.ok(hiddenError, "a refusal the repair cannot reach is still a failure");
assert.ok(String(hiddenError.message).includes(refusal), "the store's own refusal is preserved");
assert.equal(storeCalls.length - hiddenBefore, 2, "and it was retried once");
assert.match(String(hiddenError.message),
  /\[cowork-wrapper: task id "schedule-hidden"; found no hard-linked routine file; searched /,
  "the failure carries what the repair saw");
for (const root of [codeRoot, coworkScheduledRoot]) {
  assert.ok(String(hiddenError.message).includes(root), `the searched roots are named (${root})`);
}

// --- limits -----------------------------------------------------------------
// A plain file is left exactly as the store wrote it, a symlink is the store's
// own (different) refusal and is not retried into a silent repair, and a write
// that succeeds sweeps nothing: a linked routine nobody wrote to stays linked.
const plainId = "schedule-plain";
const plainDir = join(codeRoot, plainId);
await mkdir(plainDir, { recursive: true });
await writeFile(join(plainDir, "SKILL.md"), "plain task\n");
storeDirs.set(plainId, plainDir);
const plainCallsBefore = storeCalls.length;
assert.equal(await update([{ scheduledTaskId: plainId }]), "updated");
assert.equal(storeCalls.length - plainCallsBefore, 1, "a plain task is written once");
assert.deepEqual(await readdir(plainDir), ["SKILL.md"], "and nothing is left beside it");

const linkId = "schedule-symlink";
const linkDir = join(codeRoot, linkId);
await mkdir(linkDir, { recursive: true });
await writeFile(join(home, "outside.md"), "outside\n");
symlinkSync(join(home, "outside.md"), join(linkDir, "SKILL.md"));
storeDirs.set(linkId, linkDir);
const linkCallsBefore = storeCalls.length;
const linkError = await update([{ scheduledTaskId: linkId }]).then(() => null, (error) => error);
assert.ok(String(linkError?.message).includes("symlink detected"), "the store's symlink refusal stands");
assert.equal(storeCalls.length - linkCallsBefore, 1, "and is not retried");
assert.ok((await lstat(join(linkDir, "SKILL.md"))).isSymbolicLink(), "the symlink is not moved");

const idleId = "schedule-idle";
const idleDir = join(codeRoot, idleId);
await mkdir(idleDir, { recursive: true });
await writeFile(join(idleDir, "SKILL.md"), "idle\n");
linkSync(join(idleDir, "SKILL.md"), join(home, "idle-twin"));
assert.equal(await update([{ scheduledTaskId: plainId }]), "updated");
assert.equal((await lstat(join(idleDir, "SKILL.md"))).nlink, 2,
  "a successful write sweeps nothing: an untouched routine stays as it is");
assert.ok(!(await readdir(idleDir)).some((name) => name.startsWith("SKILL.md.hardlinked-")));

// --- the hook is scoped to the channels that write task files ---------------
// A read must not pay for the repair, and neither must the surfaces around it.
ipcMain.handle(channelPrefix + "getAllScheduledTasks", async () => "tasks");
assert.equal(await registered.get(channelPrefix + "getAllScheduledTasks")({}), "tasks");
assert.equal((await lstat(join(idleDir, "SKILL.md"))).nlink, 2, "a listing does not repair");
ipcMain.handle(channelPrefix + "updateScheduledTaskStatus", async () => "status");
assert.equal(
  await registered.get(channelPrefix + "updateScheduledTaskStatus")({}, { scheduledTaskId: idleId }),
  "status",
);
assert.equal((await lstat(join(idleDir, "SKILL.md"))).nlink, 2,
  "a status change does not repair — it writes no task file");
assert.ok(!(await readdir(idleDir)).some((name) => name.startsWith("SKILL.md.hardlinked-")));

await rm(home, { recursive: true, force: true });
console.log("routine-task-file-link-smoke: ok");
