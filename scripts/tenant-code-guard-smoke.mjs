import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// A tenant instance (one account's own, scripts/provision-user.sh) must never
// offer the container-local Code executor: its container is privileged enough
// that an agent shell there is close to host root, so its Code belongs on a
// self-hosted runner inside its Cowork guest (docs/code-in-cowork-vm.md). The
// guarantee is the bridge withholding the surface, whatever the flag says — this
// pins that, since the bridge-parity smoke bypasses the env by defining
// `codeActionsEnabled` directly and so cannot see it.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

// The env-driven part: `tenantInstance` and the `codeActionsEnabled` it folds.
const guard = section(
  serverSource,
  "const tenantInstance",
  "// Which instance this bridge belongs to",
);
// The two surfaces the local executor is reachable through.
const requestMethods = section(
  serverSource,
  "const allowedMethods = new Map([",
  "const allowedSettingsMethods",
);
const listenerMethods = section(
  serverSource,
  "const remoteListenerMethods",
  "const allowedStores",
);

// The five read-only git method names a tenant's web composer calls; the
// bridge answers them from the guest runner inside the VM.
const tenantGitReads = ["checkBranchSwitchConflict", "getGitInfo", "getLocalBranches",
  "getWorkingTreeDirtyState", "isWorkingTreeDirty"];

function evaluate(env, code) {
  const sandbox = { process: { env }, console: { warn() {} } };
  vm.runInNewContext(
    `const infrastructureActionsEnabled = true;
     const developerActionsEnabled = true;
     const connectorsEnabled = true;
     const tenantCodeReadsEnabled = process.env.CLAUDESK_TENANT === "1"
       && process.env.CLAUDESK_CODE_RUNNERS === "1";
     const tenantGitReadMethods = new Set(${JSON.stringify(tenantGitReads)});
     ${code}
     result = {
       codeActionsEnabled,
       requests: [...allowedMethods.keys()],
       localSessions: [...(allowedMethods.get("LocalSessions") ?? [])],
       listeners: [...remoteListenerMethods.keys()],
     };`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}

const cases = [
  { tenant: "0", runners: "0", code: "1", allowed: true,
    why: "the deployment's own instance keeps Code" },
  { tenant: "", runners: "0", code: "1", allowed: true,
    why: "an unset tenant flag is the deployment's own" },
  { tenant: "0", runners: "0", code: "0", allowed: false,
    why: "the flag alone can still withhold Code" },
  { tenant: "1", runners: "1", code: "0", allowed: false,
    why: "a tenant has no local Code by default" },
  { tenant: "1", runners: "1", code: "1", allowed: false,
    why: "a tenant cannot turn the local executor on" },
];

for (const testCase of cases) {
  const result = evaluate(
    {
      CLAUDESK_TENANT: testCase.tenant,
      CLAUDESK_CODE_RUNNERS: testCase.runners,
      CLAUDE_REMOTE_CODE_ACTIONS: testCase.code,
    },
    `${guard}\n${requestMethods}\n${listenerMethods}`,
  );
  assert.equal(result.codeActionsEnabled, testCase.allowed,
    `codeActionsEnabled for tenant=${JSON.stringify(testCase.tenant)} `
    + `code=${testCase.code}: ${testCase.why}`);
  if (testCase.tenant === "1") {
    // The renderer calls these names, but the bridge answers them from the
    // guest runner; no executor method may ride along.
    assert.deepEqual([...result.localSessions].sort(), [...tenantGitReads].sort(),
      `a tenant's LocalSessions allowlist must be exactly the VM-answered reads: ${testCase.why}`);
    for (const method of ["start", "sendMessage", "readFileAtCwd", "writeSessionFile"]) {
      assert.ok(!result.localSessions.includes(method),
        `a tenant must not gain ${method} through the read shim`);
    }
  } else {
    assert.equal(result.requests.includes("LocalSessions"), testCase.allowed,
      `the LocalSessions IPC surface for tenant=${JSON.stringify(testCase.tenant)} `
      + `code=${testCase.code}: ${testCase.why}`);
  }
  assert.equal(result.listeners.includes("LocalSessions"), testCase.allowed,
    `the LocalSessions listeners for tenant=${JSON.stringify(testCase.tenant)} `
    + `code=${testCase.code}: ${testCase.why}`);
}

// The services have to receive the flag at all, or the guard is dead code: the
// bridge reads it from its own environment, so compose must pass it into both
// the bridge and the container init.
const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const passthrough = compose.match(/CLAUDESK_TENANT: "\$\{CLAUDESK_TENANT:-0\}"/g) || [];
assert.equal(passthrough.length, 2,
  "both claude-desktop and cowork-bridge must pass CLAUDESK_TENANT through");

const provision = await readFile(
  new URL("./provision-user.sh", import.meta.url), "utf8");
assert.ok(provision.includes("CLAUDESK_TENANT=1"),
  "provision-user.sh must mark an account's instance as a tenant");
// An account is ready for a self-hosted runner by default. That is only safe
// because the bridge offers a pool as a place once a runner has registered with
// it, so an account with no runner yet is offered no environment rather than a
// dead one (scripts/code-runners-smoke.mjs pins that).
assert.ok(provision.includes('CLAUDESK_CODE_RUNNERS="${CLAUDESK_ACCOUNT_CODE_RUNNERS:-1}"'),
  "an account must answer the self-hosted pool API by default");

// The app config carries a *different* flag from the executor: whether the Code
// surface exists. On a tenant that follows the self-hosted runner API, not the
// withheld executor — writing it off is what removed the titlebar's Claude/Code
// switcher (a disabled segment, then the picker patch taking the control away).
// Exercised, by running the init's own logic rather than reading it.
const configInit = await readFile(
  new URL("../rootfs/etc/cont-init.d/30-claude-config.sh", import.meta.url), "utf8");
const surfaceLogic = configInit.slice(
  configInit.indexOf('remote_code_actions="${CLAUDE_REMOTE_CODE_ACTIONS:-0}"'),
  configInit.indexOf("gateway_env_authoritative="),
);
function surfaceFor(env) {
  // The block may log a line of its own; the marked line is what is read.
  const script = `${surfaceLogic}\nprintf 'RESULT:%s|%s\\n' "$remote_code_actions" "$remote_code_surface"`;
  const run = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CLAUDE_REMOTE_CODE_ACTIONS: env.code,
      CLAUDESK_TENANT: env.tenant,
      ...(env.runners === undefined ? {} : { CLAUDESK_CODE_RUNNERS: env.runners }),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const marked = run.stdout.split("\n").find((line) => line.startsWith("RESULT:"));
  assert.ok(marked, `no result line in: ${run.stdout}`);
  const [executor, surface] = marked.slice("RESULT:".length).split("|");
  return { executor, surface };
}
assert.deepEqual(surfaceFor({ tenant: "1", code: "0", runners: "1" }),
  { executor: "0", surface: "1" },
  "a tenant with the runner API has the Code surface even though the executor is off");
assert.deepEqual(surfaceFor({ tenant: "1", code: "1", runners: "1" }),
  { executor: "0", surface: "1" },
  "a tenant never gets the executor, whatever the flag says");
assert.deepEqual(surfaceFor({ tenant: "1", code: "0", runners: "0" }),
  { executor: "0", surface: "0" },
  "a tenant without the runner API has no Code surface either");
assert.deepEqual(surfaceFor({ tenant: "0", code: "1" }),
  { executor: "1", surface: "1" },
  "the operator's own instance follows CLAUDE_REMOTE_CODE_ACTIONS for both");

// The browser learns the same thing before the app mounts.
const preload = await readFile(
  new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
assert.match(preload, /config\.codeActionsEnabled \|\| config\.codeSurfaceEnabled/,
  "the preload must paint the switcher for either kind of Code surface");
assert.match(serverSource, /codeRunnersEnabled;\n/, "the surface flag follows the runner API");
assert.ok(serverSource.includes("\n    codeSurfaceEnabled,"),
  "and it must reach the bootstrap the preload reads");
assert.match(preload, /config\.codeSettingsEnabled/,
  "the AppPreferences shim must exist for a tenant's Code surface too");
assert.ok(serverSource.includes("codeSettingsEnabled: codeActionsEnabled || codeSurfaceEnabled"),
  "the bootstrap marks the settings surface for a tenant as well");

process.stdout.write("tenant-code-guard-smoke: a tenant never offers the local Code executor\n");
