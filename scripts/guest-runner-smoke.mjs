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
# The runner holds stdin open for steering, so read the one message this
# process answers instead of waiting for EOF.
IFS= read -r line
prompt=$(printf '%s' "$line" | sed -n 's/.*"text": *"\\([^"]*\\)".*/\\1/p' | head -1)
# The argv is echoed inside a JSON string, so escape it — a --mcp-config value
# carries JSON of its own.
args=$(printf '%s' "$*" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
printf '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111"}\\n'
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"agent saw: %s | prompt: %s"}]},"session_id":"11111111-1111-4111-8111-111111111111"}\\n' "$args" "$prompt"
printf '{"type":"result","subtype":"success","session_id":"11111111-1111-4111-8111-111111111111","is_error":false,"result":"done"}\\n'
`);
chmodSync(stub, 0o755);
// An agent that writes a partial answer and then dies without a result. The
// runner must still close the turn — a failure with no terminal is exactly the
// "spinner forever" the session view shows.
const failing_dir = join(work, "claude-bin-failing");
mkdirSync(failing_dir, { recursive: true });
const failingStub = join(failing_dir, "claude");
writeFileSync(failingStub, `#!/bin/sh
IFS= read -r line
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial answer"}]},"session_id":"55555555-5555-4555-8555-555555555555"}\\n'
exit 3
`);
chmodSync(failingStub, 0o755);
let child;

const request = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
};

function runRunner({ secret, once = true, binDir = stub_dir, env = {} }) {
  return spawnSync("python3", ["-I", `${root}guest/runner.py`, ...(once ? ["--once"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: secret,
      CLAUDESK_RUNNER_CLAUDE_BIN: binDir,
      CLAUDESK_RUNNER_CHECKOUT: work,
      CLAUDESK_RUNNER_HOME: join(work, "home"),
      ...env,
    },
  });
}

// A long-lived runner, for the one behaviour that needs the poll loop and a
// turn to be live at the same time: a Stop is delivered on that loop.
function startRunner({ secret, binDir = stub_dir, env = {} }) {
  const child = spawn("python3", ["-I", `${root}guest/runner.py`], {
    env: {
      ...process.env,
      CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: secret,
      CLAUDESK_RUNNER_CLAUDE_BIN: binDir,
      CLAUDESK_RUNNER_CHECKOUT: work,
      CLAUDESK_RUNNER_HOME: join(work, "home-live"),
      // Ask for the held poll, the protocol's event-driven pickup.
      CLAUDESK_RUNNER_POLL_WAIT: "20",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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
      // The monitor exists to reattach a production bridge to the Desktop's
      // namespace. This smoke's internal URL is deliberately dead, and the
      // suite is longer than the default 3 misses; exiting mid-run strands the
      // runner's held poll instead of testing anything.
      COWORK_INTERNAL_FAILURE_EXIT_THRESHOLD: "1000",
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

  // An agent that dies without a result still closes its turn: the runner
  // writes a synthetic terminal, so the reader is not left spinning on a
  // transcript whose last row is a partial answer.
  const failingPlaced = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "guest smoke failing", environment_id: poolId }),
  });
  const failingId = JSON.parse(failingPlaced.body).session.id;
  await request(`/v1/code/sessions/${failingId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "fail this turn" } } }] }),
  });
  const failedRun = runRunner({ secret, binDir: failing_dir });
  assert.equal(failedRun.status, 0, failedRun.stderr);
  const failedHistory = decodeClientEventsResponse(
    JSON.parse((await request(`/v1/code/sessions/${failingId}/events`)).body));
  assert.deepEqual(failedHistory.map((entry) => entry.message.type),
    ["user", "assistant", "result"],
    "a turn whose agent died without a result still ends with one");
  const failureTerminal = failedHistory.at(-1).message;
  assert.equal(failureTerminal.is_error, true);
  assert.match(String(failureTerminal.result), /agent exited 3/,
    "the synthetic result carries the reason");
  const failedDoc = JSON.parse((await request(`/v1/code/sessions/${failingId}`)).body).session;
  assert.equal(failedDoc.worker_status, "idle", "a failed turn reads idle to the session view");

  // A running session changes its model or permission mode by appending a
  // control request, not by rewriting the create config. The runner applies
  // the latest of each to the next turn's argv.
  await request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [
      { payload: { type: "control_request", request_id: "set-model-smoke",
        request: { subtype: "set_model", model: "deepseek-picked" } } },
      { payload: { type: "control_request", request_id: "set-perm-mode-smoke",
        request: { subtype: "set_permission_mode", mode: "plan" } } },
      { payload: { type: "control_request", request_id: "set-effort-smoke",
        request: { subtype: "apply_flag_settings", settings: { effortLevel: "max" } } } },
      { payload: { type: "user",
        message: { role: "user", content: "switch settings" } } },
    ] }),
  });
  const ran3 = runRunner({ secret });
  assert.equal(ran3.status, 0, ran3.stderr);
  const history3 = JSON.parse((await request(`/v1/code/sessions/${sessionId}/events`)).body);
  const decoded3 = decodeClientEventsResponse(history3);
  const lastAssistant = decoded3.filter((entry) => entry.message.type === "assistant").at(-1);
  assert.equal(lastAssistant.message.message.content[0].text,
    "agent saw: --print --input-format stream-json --output-format stream-json"
    + " --verbose --include-partial-messages --model deepseek-picked"
    + " --permission-mode plan --effort max"
    + " --resume 11111111-1111-4111-8111-111111111111"
    + " | prompt: switch settings",
    "a mid-session model/permission/effort control request reaches the next turn");

  // A session's MCP servers reach the agent as `--mcp-config`: this is where a
  // routine fire's per-invocation connectors become the URL the agent dials,
  // and where the session MCP editor's save lands.
  const mcpPlaced = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "mcp smoke",
      environment_id: poolId,
      config: {
        model: "claude-opus-5-5",
        mcp_servers: [
          {
            name: "tickets",
            type: "http",
            url: "https://mcp.example.com/run/abc123/mcp",
            headers: { authorization: "Bearer t" },
          },
          { name: "events", type: "sse", url: "https://mcp.example.com/run/def456/sse" },
        ],
      },
    }),
  });
  const mcpSessionId = JSON.parse(mcpPlaced.body).session.id;
  await request(`/v1/code/sessions/${mcpSessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "use the tickets server" } } }] }),
  });
  const ranMcp = runRunner({ secret });
  assert.equal(ranMcp.status, 0, ranMcp.stderr);
  const mcpHistory = JSON.parse(
    (await request(`/v1/code/sessions/${mcpSessionId}/events`)).body);
  const mcpAssistant = decodeClientEventsResponse(mcpHistory)
    .filter((entry) => entry.message.type === "assistant").at(-1);
  assert.equal(mcpAssistant.message.message.content[0].text,
    "agent saw: --print --input-format stream-json --output-format stream-json"
    + " --verbose --include-partial-messages --model claude-opus-5-5"
    + ' --mcp-config {"mcpServers":{"tickets":{"type":"http",'
    + '"url":"https://mcp.example.com/run/abc123/mcp",'
    + '"headers":{"authorization":"Bearer t"}},'
    + '"events":{"type":"sse","url":"https://mcp.example.com/run/def456/sse"}}}'
    + " | prompt: use the tickets server",
    "a session's MCP servers reach the agent as --mcp-config");

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
  assert.deepEqual(JSON.parse(contentProbe.stdout), [{
    uuid: "",
    content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
    ],
  }], "the guest runner forwards image blocks beside the text, one message per uuid");

  // A message typed while a turn ran sits before that turn's `result` in the
  // log. Reading the tail "after the last result" dropped it; the bridge's
  // delivery floor is what selects it (the caller fetches the events above the
  // floor, see fetch_events_after).
  const floorProbe = spawnSync("python3", ["-I", "-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("guest_runner", ${JSON.stringify(join(root, "guest/runner.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def user(seq, text, uid, source="client"):
    return {"sequence_num": str(seq), "source": source, "payload": {
        "uuid": uid, "type": "user", "message": {"role": "user", "content": text}}}
events = [
    user(1, "the opening message", "11111111-1111-4111-8111-111111111111"),
    user(9, "typed while the turn ran", "99999999-9999-4999-8999-999999999999"),
    {"sequence_num": "10", "source": "worker", "payload": {"type": "result", "result": "done"}},
]
print(json.dumps({
    "legacy": module.content_of(events),
    "floor": module.content_of(events, 1),
}))
`], { encoding: "utf8" });
  assert.equal(floorProbe.status, 0, floorProbe.stderr);
  const floorResult = JSON.parse(floorProbe.stdout);
  assert.deepEqual(floorResult.legacy, [],
    "the old tail read stops at the last result");
  assert.deepEqual(floorResult.floor, [{
    uuid: "99999999-9999-4999-8999-999999999999",
    content: [{ type: "text", text: "typed while the turn ran" }],
  }], "a mid-turn message above the delivery floor is answered by the next turn");

  // A turn has no wall-clock cap by default: killing an agent at half an hour
  // threw away work that was still going. CLAUDESK_RUNNER_TIMEOUT_SECONDS can
  // still impose one; zero, empty or a non-number all leave it uncapped.
  for (const [value, expected] of [[undefined, 0], ["", 0], ["0", 0], ["1800", 1800],
    ["not-a-number", 0]]) {
    const env = { ...process.env };
    if (value === undefined) delete env.CLAUDESK_RUNNER_TIMEOUT_SECONDS;
    else env.CLAUDESK_RUNNER_TIMEOUT_SECONDS = value;
    const timeoutProbe = spawnSync("python3", ["-I", "-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("guest_runner", ${JSON.stringify(join(root, "guest/runner.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.TURN_TIMEOUT)
`], { encoding: "utf8", env });
    assert.equal(timeoutProbe.status, 0, timeoutProbe.stderr);
    assert.equal(Number(timeoutProbe.stdout.trim()), expected,
      `TURN_TIMEOUT for ${JSON.stringify(value)} must be ${expected}`);
  }

  // The shared workspace is bound at /workspace in the guest (or symlinked in
  // this probe): a folderless session starts there, and a host `/workspace/…`
  // path keeps that spelling, matching the container and the folder picker.
  const workspaceProbe = spawnSync("python3", ["-I", "-c", `
import importlib.util, json, os, tempfile
root = tempfile.mkdtemp()
shared = os.path.join(root, "shared")
os.makedirs(os.path.join(shared, "workspace", "proj"))
alias = os.path.join(root, "alias")
os.symlink(os.path.join(shared, "workspace"), alias)
os.environ["CLAUDESK_RUNNER_SHARED_ROOT"] = shared
os.environ["CLAUDESK_RUNNER_WORKSPACE_ALIAS"] = alias
os.environ["CLAUDESK_RUNNER_CHECKOUT"] = os.path.join(root, "checkout")
spec = importlib.util.spec_from_file_location("guest_runner", ${JSON.stringify(join(root, "guest/runner.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({
  "workdir": module.session_workdir("s", {})[0],
  "folder": module.guest_folder("/workspace/proj"),
  "alias": alias,
}))
`], { encoding: "utf8" });
  assert.equal(workspaceProbe.status, 0, workspaceProbe.stderr);
  const workspace = JSON.parse(workspaceProbe.stdout);
  assert.equal(workspace.workdir, workspace.alias,
    "a folderless session starts in the shared workspace, under /workspace");
  assert.equal(workspace.folder, join(workspace.alias, "proj"),
    "a host /workspace path maps through the /workspace alias");

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
IFS= read -r line
prompt=$(printf '%s' "$line" | sed -n 's/.*"text": *"\\([^"]*\\)".*/\\1/p' | head -1)
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

  // The service keeps polling while a turn runs. A UI lookup rides the poll,
  // so an agent mid-turn must not starve the folder picker: run a slow agent
  // and ask for a listing before its turn can finish.
  const slowDir = join(work, "slow-bin");
  mkdirSync(slowDir, { recursive: true });
  const slowStub = join(slowDir, "claude");
  writeFileSync(slowStub, `#!/bin/sh
IFS= read -r line
sleep 6
printf '{"type":"system","subtype":"init","session_id":"33333333-3333-4333-8333-333333333333"}\\n'
printf '{"type":"result","subtype":"success","session_id":"33333333-3333-4333-8333-333333333333","is_error":false,"result":"done"}\\n'
`);
  chmodSync(slowStub, 0o755);
  const busyRunner = spawn("python3", ["-I", `${root}guest/runner.py`], {
    env: {
      ...process.env,
      CLAUDESK_RUNNER_BASE: `http://127.0.0.1:${port}`,
      CLAUDESK_RUNNER_SECRET: secret,
      CLAUDESK_RUNNER_CLAUDE_BIN: slowDir,
      CLAUDESK_RUNNER_CHECKOUT: work,
      CLAUDESK_RUNNER_HOME: join(work, "busy-home"),
      CLAUDESK_RUNNER_SHARED_ROOT: sharedRoot,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let busyLog = "";
  busyRunner.stdout.on("data", (chunk) => { busyLog += String(chunk); });
  const waitForLog = (needle, what) => new Promise((resolve, reject) => {
    if (busyLog.includes(needle)) { resolve(); return; }
    const timer = setTimeout(
      () => reject(new Error(`${what}: ${busyLog.slice(-600)}`)), 10000);
    busyRunner.stdout.on("data", () => {
      if (busyLog.includes(needle)) { clearTimeout(timer); resolve(); }
    });
  });
  await waitForLog("registered as", "the busy runner did not register");
  const busyPlaced = await request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "busy smoke", environment_id: poolId,
      config: { model: "claude-opus-5-5" } }),
  });
  const busySession = JSON.parse(busyPlaced.body).session;
  await request(`/v1/code/sessions/${busySession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ payload: { type: "user",
      message: { role: "user", content: "take your time" } } }] }),
  });
  await waitForLog("turn with", "the busy turn did not start");
  const duringTurn = Date.now();
  const busyListing = await request(
    `/api/remote/code-folders?path=${encodeURIComponent(hostRepo)}`);
  assert.equal(busyListing.status, 200, busyListing.body);
  assert.equal(JSON.parse(busyListing.body).ok, true, busyListing.body);
  assert.ok(Date.now() - duringTurn < 4000,
    "a folder lookup is answered while the agent's turn is still running");
  // Back-to-back lookups must not wait out POLL_SECONDS: a poll that carried a
  // request returns immediately, and the loop used to sleep after it.
  const secondStarted = Date.now();
  const secondListing = await request(
    `/api/remote/code-folders?path=${encodeURIComponent(hostRepo)}`);
  assert.equal(secondListing.status, 200, secondListing.body);
  assert.ok(Date.now() - secondStarted < 2000,
    "a second lookup follows the first without waiting a poll interval");
  busyRunner.kill("SIGTERM");
  await new Promise((resolve) => busyRunner.once("exit", resolve));
  rmSync(hostRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

  // Stop. The Code surface's Stop is an `interrupt` control request appended
  // to the event log — the renderer has no REST verb for it. The guest cannot
  // be dialled, so the bridge hands the id to the runner on the poll it is
  // already holding; the runner signals the child the way Ctrl-C would, writes
  // the terminal the reader closes the turn on, and releases the session. The
  // stub below never reaches its "late" result.
  const interruptDir = join(work, "interrupt-bin");
  mkdirSync(interruptDir, { recursive: true });
  const interruptStub = join(interruptDir, "claude");
  writeFileSync(interruptStub, `#!/bin/sh
IFS= read -r line
prompt=$(printf '%s' "$line" | sed -n 's/.*"text": *"\\([^"]*\\)".*/\\1/p' | head -1)
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working: %s"}]},"session_id":"44444444-4444-4444-8444-444444444444"}\\n' "$prompt"
trap 'exit 130' INT TERM
sleep 60 >/dev/null 2>&1 &
wait
printf '{"type":"result","subtype":"success","session_id":"44444444-4444-4444-8444-444444444444","is_error":false,"result":"late"}\\n'
`);
  chmodSync(interruptStub, 0o755);
  const interruptRunner = startRunner({ secret, binDir: interruptDir });
  try {
    assert.equal(await waitFor(
      () => interruptRunner.output().includes("registered as"), 10000),
    true, `the interrupt runner did not register: ${interruptRunner.output()}`);
    const slowPlaced = await request("/v1/code/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "interrupt smoke", environment_id: poolId }),
    });
    const slowSession = JSON.parse(slowPlaced.body).session;
    await request(`/v1/code/sessions/${slowSession.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ payload: { type: "user",
        message: { role: "user", content: "work forever" } } }] }),
    });
    assert.equal(await waitFor(async () => {
      const history = JSON.parse((await request(
        `/v1/code/sessions/${slowSession.id}/events`)).body);
      return decodeClientEventsResponse(history)
        .some((entry) => entry.message.type === "assistant");
    }, 10000), true, `the slow agent must start: ${interruptRunner.output()}`);

    // Exactly what the Code surface posts for Stop.
    const interrupted = await request(`/v1/code/sessions/${slowSession.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ payload: { type: "control_request",
        request_id: "interrupt-smoke", request: { subtype: "interrupt" } } }] }),
    });
    assert.equal(interrupted.status, 200, interrupted.body);

    assert.equal(await waitFor(async () => {
      const history = JSON.parse((await request(
        `/v1/code/sessions/${slowSession.id}/events`)).body);
      return decodeClientEventsResponse(history)
        .some((entry) => entry.message.type === "result");
    }, 10000), true, `the interrupted turn must close: ${interruptRunner.output()}`);
    const stopped = decodeClientEventsResponse(JSON.parse((await request(
      `/v1/code/sessions/${slowSession.id}/events`)).body));
    const terminal = stopped.filter((entry) => entry.message.type === "result").at(-1).message;
    assert.equal(terminal.is_error, true, "an interrupt is an error result, not a success");
    assert.equal(terminal.subtype, "error_during_execution");
    assert.equal(terminal.interrupted, true);
    assert.equal(terminal.result, "Request interrupted by user",
      "the agent was stopped before its own result could land");
    assert.equal(stopped.some(
      (entry) => entry.message.type === "result" && entry.message.result === "late"),
    false, "the killed agent's own terminal never arrives");
    const receipt = stopped.find((entry) => entry.message.type === "control_response");
    assert.equal(receipt?.message.response.request_id, "interrupt-smoke",
      "the Stop's control_response reaches the reader that is waiting on it");
    assert.equal(receipt.message.response.subtype, "success");

    let lastDocument = null;
    assert.equal(await waitFor(async () => {
      lastDocument = JSON.parse((await request(
        `/v1/code/sessions/${slowSession.id}`)).body).session;
      return lastDocument.worker_status === "idle";
    }, 5000), true,
    `an interrupted turn leaves the session idle, not running: `
    + `${JSON.stringify(lastDocument)} ${interruptRunner.output()}`);
    assert.equal(await waitFor(
      () => interruptRunner.output().includes("(interrupted)"), 3000), true,
    "the runner reports the turn as interrupted");
  } finally {
    interruptRunner.child.kill("SIGTERM");
    await new Promise((resolve) => interruptRunner.child.once("exit", resolve));
  }

  // Steering and rewind, on a live poll. A message typed while a turn runs is
  // appended after that turn's transcript read (so before its `result`); the
  // bridge's delivery floor is what makes the next turn answer it instead of
  // stranding it. A rewind is answered by the bridge for the page, then handed
  // to the agent at the next turn over the same stdin channel the SDK uses —
  // the stub answers it the way the agent does, and echoes the message uuid it
  // was given, which is what a rewind target names.
  const interactiveDir = join(work, "interactive-bin");
  mkdirSync(interactiveDir, { recursive: true });
  const interactiveStub = join(interactiveDir, "claude");
  // The stub answers the way the real CLI does: a long turn runs on a worker
  // while the main loop keeps reading stdin, so a message sent mid-turn is
  // already queued when the runner's `interrupt` with `send_now` arrives. That
  // interrupt aborts the running turn (a terminal result) and the queued
  // message runs as the next query — stock steering, not a next-turn requeue.
  writeFileSync(interactiveStub, `#!/usr/bin/env python3
import json, sys, time, threading, queue
SESSION = "66666666-6666-4666-8666-666666666666"
def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()
def assistant(text):
    emit({"type": "assistant", "session_id": SESSION,
          "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
def result(subtype, text, error=False, interrupted=False):
    emit({"type": "result", "subtype": subtype, "is_error": error,
          "interrupted": interrupted, "session_id": SESSION, "result": text})
queue_ = queue.Queue()
cancel = threading.Event()
def worker():
    while True:
        item = queue_.get()
        if item is None:
            return
        text, uid, delay = item
        cancel.clear()
        assistant("working: %s | uuid: %s" % (text, uid))
        deadline = time.time() + delay
        stopped = False
        while time.time() < deadline:
            if cancel.wait(0.05):
                stopped = True
                break
        if stopped:
            result("error_during_execution", "Request interrupted by user",
                   error=True, interrupted=True)
        else:
            assistant("done: %s | uuid: %s" % (text, uid))
            result("success", "done")
threading.Thread(target=worker, daemon=True).start()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("type") == "control_request":
        request = event.get("request") or {}
        subtype = request.get("subtype")
        if subtype == "rewind_conversation":
            emit({"type": "control_response", "response": {
                "subtype": "success", "request_id": event.get("request_id"),
                "response": {"rewound": True,
                             "targetMessageUuid": request.get("target_message_uuid"),
                             "precedingAssistantUuid": None,
                             "prefillText": "taken back"}}})
        elif subtype == "interrupt" and request.get("send_now") is True:
            cancel.set()
            emit({"type": "control_response", "response": {
                "subtype": "success", "request_id": event.get("request_id"),
                "response": {"still_queued": [],
                             "send_now": "stopped"}}})
        elif subtype == "get_context_usage":
            # The turn-end context question the runner asks before it closes
            # stdin; answering it keeps the turn's release on its normal clock.
            emit({"type": "control_response", "response": {
                "subtype": "success", "request_id": event.get("request_id"),
                "response": {"categories": [], "totalTokens": 0,
                             "maxTokens": 200000, "rawMaxTokens": 200000,
                             "percentage": 0}}})
        continue
    if event.get("type") != "user":
        continue
    text = "".join(part.get("text", "") for part in
                   (event.get("message") or {}).get("content") or []
                   if isinstance(part, dict) and part.get("type") == "text")
    queue_.put((text, event.get("uuid", ""),
                30 if "steer me" in text else 0))
`);
  chmodSync(interactiveStub, 0o755);
  const interactiveRunner = startRunner({ secret, binDir: interactiveDir });
  const post = (sessionId, events) => request(`/v1/code/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  const messagesOf = async (sessionId) => decodeClientEventsResponse(JSON.parse(
    (await request(`/v1/code/sessions/${sessionId}/events`)).body))
    .map((entry) => entry.message);
  try {
    assert.equal(await waitFor(
      () => interactiveRunner.output().includes("registered as"), 10000), true,
    `the interactive runner did not register: ${interactiveRunner.output()}`);
    const placed = await request("/v1/code/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "steer smoke", environment_id: poolId }),
    });
    const steerSession = JSON.parse(placed.body).session;
    const firstUuid = "77777777-7777-4777-8777-777777777777";
    await post(steerSession.id, [{ payload: { type: "user", uuid: firstUuid,
      message: { role: "user", content: "steer me" } } }]);
    assert.equal(await waitFor(
      () => interactiveRunner.output().includes("turn with"), 10000), true,
    `the first turn did not start: ${interactiveRunner.output()}`);
    // The turn is sleeping in the agent; this lands after its transcript read.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const secondUuid = "88888888-8888-4888-8888-888888888888";
    const steerStarted = Date.now();
    await post(steerSession.id, [{ payload: { type: "user", uuid: secondUuid,
      message: { role: "user", content: "sent while it worked" } } }]);
    // The stub's first turn sleeps 30 s. Native steering stops it and runs the
    // new message now, so the answer must land long before that.
    assert.equal(await waitFor(async () => (await messagesOf(steerSession.id))
      .filter((message) => message.type === "assistant")
      .some((message) => message.message.content[0].text.includes("sent while it worked")),
    8000), true,
    `the mid-turn message must steer the running turn: `
    + `${JSON.stringify(await messagesOf(steerSession.id))} ${interactiveRunner.output()}`);
    assert.ok(Date.now() - steerStarted < 8000,
      "the running turn was stopped for the message, not left to finish");
    assert.equal(await waitFor(
      () => interactiveRunner.output().includes("steered the running turn"), 3000), true,
    "the runner hands the message to the live child with send_now");
    const steered = (await messagesOf(steerSession.id))
      .filter((message) => message.type === "assistant");
    assert.ok(steered[1].message.content[0].text.includes(`uuid: ${secondUuid}`),
      "the agent is given the message's own uuid, so a rewind can name it");
    const interruptedTerminal = (await messagesOf(steerSession.id))
      .filter((message) => message.type === "result" && message.interrupted === true);
    assert.equal(interruptedTerminal.length, 1,
      "the stopped turn's own terminal is in the transcript");
    assert.match(String(interruptedTerminal[0].result), /Request interrupted by user/);

    // Rewind to the mid-turn message, exactly as the surface posts it. The
    // bridge answers for the page; the next turn hands the request to the
    // agent before its prompt.
    const rewound = await post(steerSession.id, [{ payload: {
      type: "control_request", request_id: "rewind-smoke",
      request: { subtype: "rewind_conversation",
        target_message_uuid: secondUuid, interrupt_if_running: false } } }]);
    assert.equal(rewound.status, 200, rewound.body);
    assert.equal(await waitFor(async () => (await messagesOf(steerSession.id))
      .some((message) => message.type === "control_response"
        && message.response?.response?.rewound === true), 5000), true,
    `the rewind is answered with the marker the page truncates on: `
    + `${JSON.stringify(await messagesOf(steerSession.id))}`);
    const marker = (await messagesOf(steerSession.id))
      .filter((message) => message.type === "control_response")
      .find((message) => message.response?.response?.rewound === true);
    assert.equal(marker.response.response.prefillText, "sent while it worked",
      "the marker carries the text the composer gets back");
    assert.equal(marker.response.response.targetMessageUuid, secondUuid);

    const thirdUuid = "99999999-9999-4999-8999-999999999999";
    await post(steerSession.id, [{ payload: { type: "user", uuid: thirdUuid,
      message: { role: "user", content: "after the rewind" } } }]);
    assert.equal(await waitFor(async () => (await messagesOf(steerSession.id))
      .filter((message) => message.type === "assistant")
      .some((message) => message.message.content[0].text.includes("after the rewind")),
    10000), true,
    `the turn after a rewind runs: ${interactiveRunner.output()}`);
    assert.equal(await waitFor(
      () => interactiveRunner.output().includes("rewind"), 5000), true,
    "the runner hands the rewind to the agent");
    assert.match(interactiveRunner.output(), /rewind .*: applied/,
      "the agent answered the rewind");

    // A later turn must not carry the same rewind again.
    await post(steerSession.id, [{ payload: { type: "user",
      message: { role: "user", content: "one more" } } }]);
    assert.equal(await waitFor(async () => (await messagesOf(steerSession.id))
      .filter((message) => message.type === "assistant")
      .some((message) => message.message.content[0].text.includes("one more")),
    10000), true, `the later turn runs: ${interactiveRunner.output()}`);
    assert.equal(
      (interactiveRunner.output().match(/rewind .*: (applied|declined)/g) || []).length,
      1, "an applied rewind is cleared and not replayed on the next turn");
  } finally {
    interactiveRunner.child.kill("SIGTERM");
    await new Promise((resolve) => interactiveRunner.child.once("exit", resolve));
  }

  // Context usage. The runner asks the agent for `get_context_usage` when the
  // turn's result lands (only that process holds the conversation), keeps the
  // answer, and serves the Code surface's later control request from that
  // cache over the UI request lane. The stub answers the way the agent does,
  // so this pins the turn-end question, the cache and the control_response
  // the renderer's transport is waiting on.
  const contextDir = join(work, "context-bin");
  mkdirSync(contextDir, { recursive: true });
  const contextStub = join(contextDir, "claude");
  writeFileSync(contextStub, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *get_context_usage*)
      rid=$(printf '%s' "$line" | sed -n 's/.*"request_id": *"\\([^"]*\\)".*/\\1/p')
      detail=$(printf '%s' "$line" | sed -n 's/.*"detail": *"\\([^"]*\\)".*/\\1/p')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"categories":[{"name":"System prompt","tokens":2063,"kind":"used"},{"name":"Messages","tokens":900,"kind":"used"}],"totalTokens":2963,"maxTokens":200000,"rawMaxTokens":200000,"percentage":1,"probeDetail":"%s"}}}\\n' "$rid" "$detail"
      ;;
    *)
      printf '{"type":"system","subtype":"init","session_id":"66666666-6666-4666-8666-666666666666"}\\n'
      printf '{"type":"result","subtype":"success","session_id":"66666666-6666-4666-8666-666666666666","is_error":false,"result":"done"}\\n'
      ;;
  esac
done
`);
  chmodSync(contextStub, 0o755);
  const contextRunner = startRunner({ secret, binDir: contextDir,
    env: { CLAUDESK_RUNNER_CONTEXT_USAGE_WAIT: "2" } });
  try {
    assert.equal(await waitFor(
      () => contextRunner.output().includes("registered as"), 10000),
    true, `the context runner did not register: ${contextRunner.output()}`);
    const contextPlaced = await request("/v1/code/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "context smoke", environment_id: poolId,
        config: { model: "claude-opus-5-5" } }),
    });
    const contextSession = JSON.parse(contextPlaced.body).session;
    await request(`/v1/code/sessions/${contextSession.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ payload: { type: "user",
        message: { role: "user", content: "ask the context meter" } } }] }),
    });
    assert.equal(await waitFor(
      () => contextRunner.output().includes("turn done"), 10000),
    true, `the context turn must finish: ${contextRunner.output()}`);

    // Exactly what the Code surface posts when the meter loads.
    const asked = await request(`/v1/code/sessions/${contextSession.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ payload: { type: "control_request",
        request_id: "context-smoke",
        request: { subtype: "get_context_usage", detail: "full" } } }] }),
    });
    assert.equal(asked.status, 200, asked.body);

    assert.equal(await waitFor(async () => {
      const history = decodeClientEventsResponse(JSON.parse((await request(
        `/v1/code/sessions/${contextSession.id}/events`)).body));
      return history.some((entry) => entry.message.type === "control_response"
        && entry.message.response?.request_id === "context-smoke");
    }, 10000), true,
    `the context answer must reach the session: ${contextRunner.output()}`);
    const answered = decodeClientEventsResponse(JSON.parse((await request(
      `/v1/code/sessions/${contextSession.id}/events`)).body));
    const answer = answered.find((entry) => entry.message.type === "control_response"
      && entry.message.response?.request_id === "context-smoke").message;
    assert.equal(answer.response.subtype, "success");
    assert.equal(answer.response.response.rawMaxTokens, 200000);
    assert.equal(answer.response.response.probeDetail, "full",
      "the turn-end question asks for the full breakdown");
    assert.equal(answer.response.response.categories.find(
      (category) => category.name === "Messages")?.tokens, 900,
      "the agent's own breakdown is relayed unchanged");
    // The answer came from the cache: the turn's process has already been
    // ended (its result closed stdin and the runner reaps it), so nothing
    // could have answered a live control request here.
    assert.equal(await waitFor(
      () => contextRunner.output().includes("agent exited"), 8000),
    true, `the turn's agent must end after its result: ${contextRunner.output()}`);
  } finally {
    contextRunner.child.kill("SIGTERM");
    await new Promise((resolve) => contextRunner.child.once("exit", resolve));
  }

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
  // The guest runner can still be flushing its state when SIGTERM lands;
  // recursive rmSync already retries EBUSY/ENOTEMPTY, but the default window is
  // short enough to lose that race on a loaded CI box.
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

// The UI's git reads must run with the runner's HOME: that is where
// `prepare_home` declares the host-owned workspace safe. Without it every repo
// reads as "dubious ownership" and the composer sees a plain folder (no branch
// picker, no worktree toggle). Pin the environment with a stand-in git.
{
  const gitProbe = mkdtempSync(join(tmpdir(), "guest-runner-git-"));
  try {
    const home = join(gitProbe, "home");
    const bin = join(gitProbe, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"),
      "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$HOME\" \"$GIT_CONFIG_GLOBAL\" \"$GIT_TERMINAL_PROMPT\"\n",
      { mode: 0o755 });
    const probe = spawnSync("python3", ["-I", "-c", [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('runner', sys.argv[1])",
      "runner = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(runner)",
      "ok, out = runner.run_git(sys.argv[2])",
      "print('OK' if ok else 'FAIL')",
      "print(out)",
    ].join("\n"), `${root}guest/runner.py`, gitProbe], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDESK_RUNNER_HOME: home,
      },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /^OK$/m, "the probe must run git successfully");
    assert.ok(probe.stdout.includes(`${home}|${join(home, ".gitconfig")}|0`),
      `run_git must use the runner's HOME and global config, got: ${probe.stdout}`);
  } finally {
    rmSync(gitProbe, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

// Session turns must actually run concurrently: the runner is handed one hint
// per session and each gets its own thread. A single worker made two sessions
// queue behind each other, which defeats the worktree option (two isolated
// sessions are supposed to run at once). The probe replaces the turn with a
// two-party barrier, so it can only complete if both turns are in flight.
{
  const probe = spawnSync("python3", ["-I", "-c", [
    "import importlib.util, queue, sys, threading, time",
    "spec = importlib.util.spec_from_file_location('runner', sys.argv[1])",
    "runner = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(runner)",
    "done = []",
    "entered = threading.Barrier(2)",
    "def fake(hint, interrupt=None):",
    "    entered.wait(timeout=5)",
    "    done.append(hint.get('i'))",
    "runner.run_session = fake",
    "q = queue.Queue()",
    "threading.Thread(target=runner.run_sessions_forever, args=(q,), daemon=True).start()",
    "q.put({'i': 1})",
    "q.put({'i': 2})",
    "time.sleep(1.0)",
    "print('OK' if sorted(done) == [1, 2] else 'FAIL')",
    "print(done)",
  ].join("\n"), `${root}guest/runner.py`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^OK$/m,
    `two session turns must be in flight at once, got: ${probe.stdout}`);
}

// A Stop that lands between the poll handing out the hint and the runner's
// claim must prevent the turn from starting. That decision is read from the
// event log: an `interrupt` after the last client user message. The cases pin
// the boundaries — an earlier stop is not this turn's, a worker's tool result
// is not a user message, and a newer message supersedes an older stop.
{
  const probe = spawnSync("python3", ["-I", "-c", [
    "import importlib.util, sys",
    "spec = importlib.util.spec_from_file_location('runner', sys.argv[1])",
    "runner = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(runner)",
    "u = {'source': 'client', 'payload': {'type': 'user', 'message': {'role': 'user', 'content': 'hi'}}}",
    "a = {'source': 'worker', 'payload': {'type': 'assistant', 'message': {'role': 'assistant', 'content': []}}}",
    "stop = {'source': 'client', 'payload': {'type': 'control_request', 'request_id': 'r', 'request': {'subtype': 'interrupt'}}}",
    "other = {'source': 'client', 'payload': {'type': 'control_request', 'request': {'subtype': 'set_model', 'model': 'm'}}}",
    "tool = {'source': 'worker', 'payload': {'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'content': 'x'}]}}}",
    "cases = [([u, a], False), ([u, stop], True), ([stop, u], False),",
    "          ([u, other, stop], True), ([u, a, tool], False), ([u, stop, u], False)]",
    "bad = [i for i, (events, want) in enumerate(cases)",
    "       if runner.interrupt_requested(events) != want]",
    "print('OK' if not bad else 'FAIL %s' % bad)",
  ].join("\n"), `${root}guest/runner.py`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^OK$/m, `interrupt detection: ${probe.stdout}`);
}

process.stdout.write("guest-runner-smoke: the guest runner registers, runs an agent and reports\n");
