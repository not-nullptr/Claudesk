import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeClientEventsResponse } from "./lib/code-wire-contract.mjs";

// The guest-side runner (guest/runner.py), driven against a booted bridge: the
// same loop the VM will run, minus the VM. The agent is a stub script standing
// in for the Claude Code binary the guest carries, so this proves the runner's
// protocol, its prompt handling and its transcript write-back without a guest.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}bridge/server.mjs`;
const releaseFile = `${root}bridge/release.json`;
const port = 8159;

const createdRelease = !existsSync(releaseFile);
if (createdRelease) writeFileSync(releaseFile, readFileSync(`${root}config/release.json`));
const work = mkdtempSync(join(tmpdir(), "guest-runner-"));
const stateDir = join(work, "state");
writeFileSync(stateDir, "", { flag: "w+" });
rmSync(stateDir);
// The agent lives where the guest keeps its own: a `claude-bin` directory with
// the runnable inside it — the runner is pointed at the directory and must
// resolve the binary (the product's path is exactly this shape). The stub
// answers the way the agent does: the prompt is read from the stream-json
// message on stdin, and the turn comes back as stream-json lines on stdout.
const stub_dir = join(work, "claude-bin");
mkdirSync(stub_dir, { recursive: true });
const stub = join(stub_dir, "claude");
writeFileSync(stub, `#!/bin/sh
prompt=$(sed -n 's/.*"text": *"\\([^"]*\\)".*/\\1/p' | head -1)
printf '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111"}\\n'
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"agent saw: %s | prompt: %s"}]},"session_id":"11111111-1111-4111-8111-111111111111"}\\n' "$*" "$prompt"
printf '{"type":"result","subtype":"success","session_id":"11111111-1111-4111-8111-111111111111","is_error":false,"result":"done"}\\n'
`);
chmodSync(stub, 0o755);
let child;

const request = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
};

function runRunner({ secret, once = true, env = {} }) {
  return spawnSync("python3", ["-I", `${root}guest/runner.py`, ...(once ? ["--once"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: secret,
      CLAUDESK_RUNNER_CLAUDE_BIN: stub_dir,
      CLAUDESK_RUNNER_CHECKOUT: work,
      CLAUDESK_RUNNER_HOME: join(work, "home"),
      ...env,
    },
  });
}

try {
  child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: "127.0.0.1",
      COWORK_BRIDGE_STATE_DIR: stateDir,
      AUTH_IDENTITY_URL: "http://127.0.0.1:9",
      COWORK_INTERNAL_URL: "http://127.0.0.1:9",
      CLAUDESK_TENANT: "1",
      CLAUDESK_CODE_RUNNERS: "1",
      CLAUDESK_CODE_RUNNER_POOL: "guest-smoke",
      // A cold read answers 503 as soon as the bounded wake elapses; the smoke
      // pins that fast refusal rather than the 5 s default.
      CLAUDESK_RUNNER_WAKE_WAIT_MS: "200",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the bridge did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`the bridge exited with ${code}`)));
  });

  const poolId = JSON.parse((await request("/v1/code/runners/self-hosted/pools")).body)
    .pools[0].pool_id;
  const secret = JSON.parse(readFileSync(join(stateDir, "code-runners.json"), "utf8"))
    .pools[0].secret;

  // A Code folder listing is guest-only: with no runner online the route
  // refuses (503) instead of reading the tenant container's own mount. The
  // picker retries on that answer while the VM boots.
  const coldListing = await request("/api/remote/code-folders?path=%2Fworkspace");
  assert.equal(coldListing.status, 503, coldListing.body);
  const coldBody = JSON.parse(coldListing.body);
  assert.equal(coldBody.ok, false);
  assert.match(coldBody.error, /no guest runner is online/);
  assert.equal(Object.hasOwn(coldBody, "value"), false,
    "the bridge never answers a Code listing from its own filesystem");

  // The runner registers on start-up and answers the pool's poll.
  const idle = runRunner({ secret });
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /registered as ccrunner_/, idle.stdout);
  assert.match(idle.stdout, /no work/, idle.stdout);

  const places = JSON.parse((await request("/v1/environment_providers/private/organizations/"
    + "00000000-0000-4000-8000-000000000000/environments")).body).environments;
  assert.equal(places.length, 1, "the instance's pool is offered as its place");

  // A session with a prompt, placed the way the Code surface places one.
  const placed = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "guest smoke",
      environment_id: poolId,
      config: {
        model: "claude-opus-5-5",
        permission_mode: "bypassPermissions",
        effort_level: "high",
      },
    }),
  });
  const sessionId = JSON.parse(placed.body).session.id;
  await request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "summarise the repo" } } }] }),
  });

  // The runner takes it, runs the agent in the "guest", and writes it back.
  const ran = runRunner({ secret });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`session ${sessionId}`), ran.stdout);
  assert.match(ran.stdout, /agent exited 0/, ran.stdout);

  const history = JSON.parse((await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded = decodeClientEventsResponse(history);
  assert.deepEqual(decoded.map((entry) => entry.message.type), ["user", "assistant", "result"],
    "the turn's own result message is part of the transcript — the turn terminal the reader closes on");
  assert.equal(decoded[1].message.message.content[0].text,
    "agent saw: --print --input-format stream-json --output-format stream-json"
    + " --verbose --include-partial-messages --model claude-opus-5-5"
    + " --permission-mode bypassPermissions --effort high"
    + " | prompt: summarise the repo",
    "the agent ran with the product runner's own flags and the session's effort on the prompt");
  const releasedDoc = JSON.parse((await request(`/v1/code/sessions/${sessionId}`)).body).session;
  assert.equal(releasedDoc.status, "active", "a session the app reads stays active");
  assert.equal(releasedDoc.worker_status, "idle", "a clean run leaves it idle");

  // The next message re-queues the session and the runner continues the
  // conversation: the agent's own session id (stamped on its events) comes
  // back on `--resume`, so the turn after a release keeps the memory.
  await request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "and tighten the summary" } } }] }),
  });
  const ran2 = runRunner({ secret });
  assert.equal(ran2.status, 0, ran2.stderr);
  const history2 = JSON.parse((await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded2 = decodeClientEventsResponse(history2);
  assert.deepEqual(decoded2.map((entry) => entry.message.type),
    ["user", "assistant", "result", "user", "assistant", "result"],
    "the second turn lands after the first one released");
  assert.equal(decoded2[4].message.message.content[0].text,
    "agent saw: --print --input-format stream-json --output-format stream-json"
    + " --verbose --include-partial-messages --model claude-opus-5-5"
    + " --permission-mode bypassPermissions --effort high"
    + " --resume 11111111-1111-4111-8111-111111111111"
    + " | prompt: and tighten the summary",
    "the runner resumed the conversation the agent's own events named");

  // The opening turn can carry image blocks (a routine fire with images); the
  // runner reads the whole content list, not just its text, and forwards it to
  // the agent unchanged.
  const contentProbe = spawnSync("python3", ["-I", "-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("guest_runner", ${JSON.stringify(join(root, "guest/runner.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
events = [{"payload": {"type": "user", "message": {"role": "user", "content": [
    {"type": "text", "text": "look"},
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}}
]}}}]
print(json.dumps(module.content_of(events)))
`], { encoding: "utf8" });
  assert.equal(contentProbe.status, 0, contentProbe.stderr);
  assert.deepEqual(JSON.parse(contentProbe.stdout), [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
  ], "the guest runner forwards image blocks beside the text");

  // ---- Self-hosted start options and VM-side lookups ----------------------
  // The guest shares the host root at SHARED_ROOT, so a host path
  // `/workspace/<name>/repo` is `<shared>/workspace/<name>/repo` in the VM. The
  // bridge validates host paths under its own workspace mount, so a matching
  // directory is created there too; the runner answers from its shared copy.
  const smokeName = `.guest-runner-smoke-${process.pid}`;
  const hostRoot = join("/workspace", smokeName);
  const sharedRoot = join(work, "share");
  const sharedRepo = join(sharedRoot, "workspace", smokeName, "repo");
  mkdirSync(join(sharedRepo, "sub"), { recursive: true });
  mkdirSync(join(hostRoot, "repo"), { recursive: true });
  const runGit = (...args) => {
    const result = spawnSync("git", ["-C", sharedRepo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  writeFileSync(join(sharedRepo, "README.md"), "smoke\n");
  runGit("init", "-q", "-b", "main");
  runGit("config", "user.email", "smoke@example.invalid");
  runGit("config", "user.name", "Smoke");
  runGit("add", ".");
  runGit("commit", "-q", "-m", "init");
  runGit("branch", "feature");
  const hostRepo = `/workspace/${smokeName}/repo`;

  // The agent reports where it actually ran, so the test reads the working
  // directory and branch off the transcript.
  const pwdStub = join(work, "pwd-stub");
  writeFileSync(pwdStub, `#!/bin/sh
prompt=$(sed -n 's/.*"text": *"\\([^"]*\\)".*/\\1/p' | head -1)
branch=$(git branch --show-current 2>/dev/null)
printf '{"type":"system","subtype":"init","session_id":"22222222-2222-4222-8222-222222222222"}\\n'
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"cwd: %s | branch: %s | prompt: %s"}]},"session_id":"22222222-2222-4222-8222-222222222222"}\\n' "$PWD" "$branch" "$prompt"
printf '{"type":"result","subtype":"success","session_id":"22222222-2222-4222-8222-222222222222","is_error":false,"result":"done"}\\n'
`);
  chmodSync(pwdStub, 0o755);
  const startEnv = {
    CLAUDESK_RUNNER_CLAUDE_BIN: pwdStub,
    CLAUDESK_RUNNER_SHARED_ROOT: sharedRoot,
  };

  // The Code composer's folder listing is queued on the bridge and answered by
  // the guest runner's poll — no host filesystem read.
  const listingPromise = request(
    `/api/remote/code-folders?path=${encodeURIComponent(hostRepo)}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const listingRun = runRunner({ secret, env: startEnv });
  assert.equal(listingRun.status, 0, listingRun.stderr);
  const listing = JSON.parse((await listingPromise).body);
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.equal(listing.value.path, hostRepo);
  assert.ok(listing.value.folders.some((folder) => folder.name === "sub"),
    "the folder listing must come from the guest's shared copy");

  // Git metadata rides the same request channel.
  const gitPromise = request("/api/remote/ipc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: "LocalSessions", method: "getGitInfo",
      args: [hostRepo], argsEncoding: "json-undefined-v1" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const gitRun = runRunner({ secret, env: startEnv });
  assert.equal(gitRun.status, 0, gitRun.stderr);
  const gitInfo = JSON.parse((await gitPromise).body);
  assert.equal(gitInfo.ok, true, JSON.stringify(gitInfo));
  assert.equal(gitInfo.value.branch, "main");
  assert.equal(gitInfo.value.defaultBranch, "main",
    "the guest reports the repo's default branch for the picker");

  // The branch-switch check answers "conflict?" as its caller reads it: a real
  // branch is not a conflict, a missing one is.
  const conflictFor = async (branch) => {
    const pending = request("/api/remote/ipc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "LocalSessions", method: "checkBranchSwitchConflict",
        args: [hostRepo, branch], argsEncoding: "json-undefined-v1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const run = runRunner({ secret, env: startEnv });
    assert.equal(run.status, 0, run.stderr);
    const answer = JSON.parse((await pending).body);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return answer.value;
  };
  assert.equal(await conflictFor("feature"), false, "an existing, unheld branch is safe");
  assert.equal(await conflictFor("no-such-branch"), true,
    "a missing branch is reported as a conflict");

  // A session placed with a folder and branch runs there, on that branch.
  const placedBranch = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "branch smoke", environment_id: poolId,
      config: { cwd: hostRepo, source_branch: "feature" } }),
  });
  const branchSession = JSON.parse(placedBranch.body).session;
  assert.equal(branchSession.config.cwd, hostRepo,
    "the create document echoes the chosen folder");
  assert.equal(branchSession.config.source_branch, "feature");
  await request(`/v1/code/sessions/${branchSession.id}/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "where am I" } } }] }),
  });
  const branchRun = runRunner({ secret, env: startEnv });
  assert.equal(branchRun.status, 0, branchRun.stderr);
  const branchHistory = JSON.parse((await request(
    `/v1/code/sessions/${branchSession.id}/events`)).body);
  const branchText = decodeClientEventsResponse(branchHistory)
    .find((entry) => entry.message.type === "assistant")
    .message.message.content[0].text;
  assert.equal(branchText,
    `cwd: ${sharedRepo} | branch: feature | prompt: where am I`,
    "the agent must run in the chosen folder on the chosen branch, in the VM");

  // A worktree session runs in an isolated copy on its own branch.
  const placedWorktree = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "worktree smoke", environment_id: poolId,
      config: { cwd: hostRepo, source_branch: "feature", use_worktree: true } }),
  });
  const worktreeSession = JSON.parse(placedWorktree.body).session;
  await request(`/v1/code/sessions/${worktreeSession.id}/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "isolated" } } }] }),
  });
  const worktreeRun = runRunner({ secret, env: startEnv });
  assert.equal(worktreeRun.status, 0, worktreeRun.stderr);
  const worktreeHistory = JSON.parse((await request(
    `/v1/code/sessions/${worktreeSession.id}/events`)).body);
  const worktreeText = decodeClientEventsResponse(worktreeHistory)
    .find((entry) => entry.message.type === "assistant")
    .message.message.content[0].text;
  const suffix = worktreeSession.id.replace(/[^A-Za-z0-9_-]/g, "").slice(-12);
  assert.equal(worktreeText,
    `cwd: ${join(sharedRepo, ".claude", "worktrees", suffix)}`
    + ` | branch: claude/${suffix} | prompt: isolated`,
    "a worktree session runs in its own copy on its own branch, in the VM");
  rmSync(hostRoot, { recursive: true, force: true });

  // A runner with no secret must refuse to poll rather than guess.
  const refused = spawnSync("python3", ["-I", `${root}guest/runner.py`, "--once"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: "" },
  });
  assert.equal(refused.status, 2, "a runner without a secret refuses to start");
  assert.match(refused.stdout, /refusing to poll/);
} finally {
  if (child) child.kill("SIGTERM");
  if (createdRelease) rmSync(releaseFile, { force: true });
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write("guest-runner-smoke: the guest runner registers, runs an agent and reports\n");
