import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { gunzip, gzip } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The Desktop refuses to publish a routine's own file when it is hard-linked to
// another name — a sandboxed agent can create that link through a shared folder,
// and the write would then land on the link's other name. The refusal is right,
// but on its own it strands the routine: every later edit, from every client,
// answers "Not written: this task's file is hard-linked to another file. Replace
// it with a plain copy." and only somebody with shell access on that machine can
// clear it. The store checks on every write, so it stays stuck.
//
// Two layers do what the refusal asks, and these checks drive each through a
// store that refuses exactly like the Desktop's does:
//
//   * the wrapper, at the main process boundary where the writing IPCs already
//     cross, repairing by task id under the roots the Desktop resolves and
//     sweeping them when the id names no directory;
//   * the bridge, where the browser's calls already pass, repairing the path
//     Desktop itself answers for the task — the store's own word for where its
//     files are — and reporting what it saw when a refusal survives it.
//
// Each is also held to its limits: a plain file and a symlink are left alone, a
// read or a status change repairs nothing, and no routine the write never named
// is touched.

const root = fileURLToPath(new URL("..", import.meta.url));
// Values built inside a vm context carry that realm's prototypes, which
// assert/strict's deepEqual rejects; compare a plain copy instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

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
  Buffer,
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
  readFile,
  rename,
  readFileSync,
  writeFile,
  gunzip,
  gzip,
  promisify: (fn) => (...args) => new Promise((resolveImpl, reject) =>
    fn(...args, (error, value) => (error ? reject(error) : resolveImpl(value)))),
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

// --- the wrapper: the store's own repair is switched back on ----------------
// Current Desktop builds refuse a hard-linked routine file only while a rollout
// gate reads on, and repair the link themselves while it is off — upstream's own
// answer, for every writer. The gate arrives in a feature payload fetched through
// Electron's net, so the wrapper rewrites that one response on its way in.
{
  const gateSource = wrapper.slice(
    wrapper.indexOf("const routineFileLinkGate = "),
    wrapper.indexOf("const HOST = \"127.0.0.1\";"),
  );
  assert.ok(gateSource.length > 0, "the wrapper still carries the feature-payload rewrite");

  let mode = "features";
  const payload = {
    features: {
      "346871663": { defaultValue: true },
      "1087396298": { defaultValue: { earlyMaxMinutes: 5 } },
    },
    user: { id: "acct" },
  };
  const lines = [];
  const context = {
    Buffer,
    join,
    app: { getPath: () => userData },
    readFile,
    writeFile,
    promisify: (fn) => (...args) => new Promise((resolveImpl, reject) =>
    fn(...args, (error, value) => (error ? reject(error) : resolveImpl(value)))),
    gunzip,
    gzip,
    net: {
      async fetch() {
        if (mode === "broken") return new Response("not json", { status: 200 });
        if (mode === "other") {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        });
      },
    },
    Response,
    Headers,
    URL,
    console: {
      info: (...args) => lines.push(args.map(String).join(" ")),
      warn: (...args) => lines.push(args.map(String).join(" ")),
    },
  };
  vm.createContext(context);
  vm.runInContext(gateSource, context);

  const rewritten = await context.net.fetch("https://claude.ai/api/desktop/features", {});
  const seen = await rewritten.json();
  assert.equal("346871663" in seen.features, false, "the refusal's gate is dropped");
  assert.deepEqual(plain(seen.features["1087396298"]), { defaultValue: { earlyMaxMinutes: 5 } },
    "every other feature is left exactly as it arrived");
  assert.deepEqual(plain(seen.user), { id: "acct" }, "and the rest of the payload with them");
  assert.equal(rewritten.headers.get("content-encoding"), null,
    "a re-serialized body declares no encoding it no longer has");
  assert.equal(rewritten.headers.get("content-type"), "application/json",
    "while the type it did have is kept");
  assert.ok(lines.some((line) => line.includes("dropped feature 346871663")),
    "the rewrite is reported");

  mode = "other";
  const unrelated = await context.net.fetch("https://claude.ai/api/bootstrap", {});
  assert.equal((await unrelated.json()).features["346871663"].defaultValue, true,
    "a response that is not this endpoint is passed through untouched");

  mode = "broken";
  const unreadable = await context.net.fetch("https://claude.ai/api/desktop/features", {});
  assert.equal(await unreadable.text(), "not json",
    "a payload that cannot be rewritten is handed on exactly as it arrived");

  // The network is not the only source: Desktop caches the last good payload on
  // disk and reads its gate from there when the fetch does not answer. Same
  // rewrite, on that file, at startup.
  const cacheSource = wrapper.slice(
    wrapper.indexOf("const featureCacheMagic = "),
    wrapper.indexOf("function routineFileLinkRepairState()"),
  );
  assert.ok(cacheSource.length > 0, "the wrapper still carries the feature-cache rewrite");
  vm.runInContext(cacheSource, context);

  const cacheFile = join(userData, "fcache");
  const cached = {
    timestamp: Date.now(),
    mode: "3p",
    orgUuid: "org",
    features: { "346871663": { defaultValue: true }, keep: { defaultValue: false } },
  };
  const gzipAsync = (buffer) => new Promise((resolve, reject) =>
    gzip(buffer, (error, value) => (error ? reject(error) : resolve(value))));
  await writeFile(cacheFile, Buffer.concat([
    Buffer.from([67, 76, 70, 2, 0, 154, 183, 226]),
    await gzipAsync(Buffer.from(JSON.stringify(cached))),
  ]));
  assert.equal(await context.dropRoutineFileLinkGateFromCache(), "dropped");
  const cacheBytes = await readFile(cacheFile);
  assert.deepEqual([...cacheBytes.subarray(0, 8)], [67, 76, 70, 2, 0, 154, 183, 226],
    "the cache keeps the header Desktop checks before reading it");
  const cachePayload = JSON.parse(
    (await new Promise((resolve, reject) =>
      gunzip(cacheBytes.subarray(8), (error, value) => (error ? reject(error) : resolve(value)))))
      .toString("utf-8"),
  );
  assert.equal("346871663" in cachePayload.features, false, "the gate is dropped from the cache too");
  assert.deepEqual(cachePayload.features.keep, { defaultValue: false }, "every other feature stays");
  assert.equal(cachePayload.mode, "3p", "and the cache's own fields with them");
  assert.equal(await context.dropRoutineFileLinkGateFromCache(), "no gate",
    "a cache already without the gate is left alone");

  await writeFile(cacheFile, "not a cache");
  assert.equal(await context.dropRoutineFileLinkGateFromCache(), "absent",
    "a file that is not Desktop's cache is left alone");
  await rm(cacheFile, { force: true });
  assert.equal(await context.dropRoutineFileLinkGateFromCache(), "absent",
    "and a missing cache is not an error");
}

// --- the bridge: the repair uses Desktop's own answer for the file ----------
// A browser's routine write goes through the bridge's IPC route, so the repair
// belongs there too — and there it can ask Desktop where the task keeps its
// files instead of guessing a directory. This fixture keeps the task files
// somewhere no wrapper root covers, on purpose: the repair has to be reading
// Desktop's answer, not looking under the usual trees.
const bridgeHome = await mkdtemp(join(tmpdir(), "routine-link-bridge-"));
const storeRoot = join(bridgeHome, "store-elsewhere");
const desktopRefusal =
  "Error invoking remote method '$eipc_message$probe_$_claude.web_$_CoworkScheduledTasks_$_updateScheduledTask':"
  + " Error: Not written: this task's file is hard-linked to another file. Replace it with a plain copy.";

const bridgeTask = "schedule-test";
const bridgeFile = join(storeRoot, "imported-9f3c", "SKILL.md");
const bridgeTwin = join(bridgeHome, "authorized_keys");
const stubbornTask = "schedule-stubborn";
const stubbornFile = join(storeRoot, "stubborn", "SKILL.md");
const stubbornTwin = join(bridgeHome, "stubborn-twin");
await mkdir(join(storeRoot, "imported-9f3c"), { recursive: true });
await mkdir(join(storeRoot, "stubborn"), { recursive: true });
await writeFile(bridgeFile, "ssh-rsa AAAA the other name's bytes\n");
await writeFile(stubbornFile, "stubborn\n");
linkSync(bridgeFile, bridgeTwin);
linkSync(stubbornFile, stubbornTwin);

// Desktop, as far as this route is concerned: it answers its task list with the
// path each task's files live at, and its store refuses a linked path before it
// writes — the two facts the repair runs on.
const desktop = {
  listed: [
    { id: bridgeTask, filePath: bridgeFile, enabled: false, createdAt: 0 },
    { id: stubbornTask, filePath: stubbornFile, enabled: false, createdAt: 0 },
  ],
  calls: [],
  writes: [],
  send(response, payload) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  },
};
const stub = http.createServer((request, response) => {
  handleStubRequest(request, response).catch((error) => {
    // A fixture that throws must not take the process (and the bridge's
    // transport, which is this very server) down with it: answer, and let the
    // check that made the request see the failure.
    console.error(`[stub] ${request.method} ${request.url} failed:`, error);
    desktop.send(response, { ok: false, error: String(error?.message ?? error) });
  });
});
async function handleStubRequest(request, response) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/health") {
    desktop.send(response, {
      ok: true,
      surfaces: {},
      routineFileLinkRepair: { gate: "346871663", repair: true, sweep: "clean" },
    });
    return;
  }
  if (pathname === "/events" || pathname === "/notifications") {
    desktop.send(response, { ok: true, value: [] });
    return;
  }
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    desktop.send(response, { ok: true, value: null });
    return;
  }
  desktop.calls.push({ surface: body.surface, method: body.method, args: body.args });
  if (body.method === "getAllScheduledTasks") {
    desktop.send(response, { ok: true, value: desktop.listed });
    return;
  }
  if (body.method !== "updateScheduledTask") {
    desktop.send(response, { ok: true, value: null });
    return;
  }
  const scheduledTaskId = body.args?.[0]?.scheduledTaskId;
  const file = desktop.listed.find((task) => task.id === scheduledTaskId)?.filePath;
  desktop.writes.push({ scheduledTaskId, path: file ?? null });
  if (!file) { desktop.send(response, { ok: false, error: desktopRefusal }); return; }
  if (scheduledTaskId === stubbornTask) {
    // A link that comes back after every repair: the refusal cannot be cleared,
    // and what the repair saw is the only thing left to report.
    await rm(stubbornTwin, { force: true });
    await writeFile(file, "stubborn\n");
    linkSync(file, stubbornTwin);
    desktop.send(response, { ok: false, error: desktopRefusal });
    return;
  }
  // The store's own writer: a path that carries a second link is refused, and
  // anything else is written — created, when the repair left nothing there.
  const info = await lstat(file).catch(() => null);
  if (info?.isFile() && info.nlink > 1) {
    desktop.send(response, { ok: false, error: desktopRefusal });
    return;
  }
  await writeFile(file, "written by the store\n");
  desktop.send(response, { ok: true, value: { scheduledTaskId } });
}

const bridgePort = 8191;
const stubPort = 8192;
// The bridge reads the release manifest the image writes at build time; this
// checkout only carries the source it is built from.
const releaseFile = `${root}bridge/release.json`;
const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));
const child = spawn(process.execPath, [`${root}bridge/server.mjs`], {
  env: {
    ...process.env,
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_HOST: "127.0.0.1",
    COWORK_INTERNAL_URL: `http://127.0.0.1:${stubPort}`,
    AUTH_IDENTITY_URL: "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });
  const call = async (scheduledTaskId) => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/api/remote/ipc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "CoworkScheduledTasks",
        method: "updateScheduledTask",
        args: [{ scheduledTaskId, prompt: "new" }],
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  // The repair runs before the write, off Desktop's own path for the task — and
  // the store's write lands on a plain file.
  const updated = await call(bridgeTask);
  assert.equal(updated.status, 200, `the write should succeed, got ${JSON.stringify(updated.body)}`);
  assert.equal(updated.body.ok, true);
  assert.equal(await readFile(bridgeFile, "utf8"), "written by the store\n",
    "the store's write landed after the repair");
  assert.equal((await lstat(bridgeFile)).nlink, 1, "on a plain file");
  const aside = (await readdir(join(storeRoot, "imported-9f3c")))
    .find((name) => name.startsWith("SKILL.md.hardlinked-"));
  assert.ok(aside, "the linked file was moved aside, beside the task");
  assert.equal(await readFile(join(storeRoot, "imported-9f3c", aside), "utf8"),
    "ssh-rsa AAAA the other name's bytes\n", "and it is the linked file itself, not a copy of a write");
  assert.equal(await readFile(bridgeTwin, "utf8"), "ssh-rsa AAAA the other name's bytes\n",
    "the other name keeps its bytes");
  const listIndex = desktop.calls.findIndex((entry) => entry.method === "getAllScheduledTasks");
  const firstWrite = desktop.calls.findIndex((entry) => entry.method === "updateScheduledTask");
  assert.ok(listIndex !== -1 && listIndex < firstWrite,
    "the path came from Desktop's own task list, before the store was asked to write");

  // A refusal that survives the repair and one retry comes back with what the
  // repair saw — the machine it happens on is one nobody logs into.
  const stubborn = await call(stubbornTask);
  assert.equal(stubborn.status, 500);
  assert.match(String(stubborn.body.error), /hard-linked to another file/,
    "the store's own refusal is preserved");
  assert.match(String(stubborn.body.error),
    /\[cowork-bridge: routine file repair saw .*moved aside \(was nlink 2\)/,
    "and it names the repair it performed");
  assert.equal(
    desktop.writes.filter((entry) => entry.scheduledTaskId === stubbornTask).length, 2,
    "one refusal, one retry",
  );

  // A task Desktop does not list is reported as such rather than guessed at:
  // the repair says where it looked for the answer.
  const unknown = await call("schedule-unknown");
  assert.equal(unknown.status, 500);
  assert.match(String(unknown.body.error),
    /\[cowork-bridge: routine file repair saw .*the Desktop's list has no task "schedule-unknown" \(2 listed\).*the app reports \{"gate":"346871663","repair":true,"sweep":"clean"\}\]$/,
    "the note says what Desktop answered, and what the app process reports about its own repairs");
} finally {
  child.kill("SIGKILL");
  stub.close();
  await rm(bridgeHome, { recursive: true, force: true });
  if (createdRelease) rmSync(releaseFile, { force: true });
}

await rm(home, { recursive: true, force: true });
console.log("routine-task-file-link-smoke: ok");
