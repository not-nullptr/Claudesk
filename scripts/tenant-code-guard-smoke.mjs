import assert from "node:assert/strict";
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

function evaluate(env, code) {
  const sandbox = { process: { env }, console: { warn() {} } };
  vm.runInNewContext(
    `const infrastructureActionsEnabled = true;
     const developerActionsEnabled = true;
     const connectorsEnabled = true;
     ${code}
     result = {
       codeActionsEnabled,
       requests: [...allowedMethods.keys()],
       listeners: [...remoteListenerMethods.keys()],
     };`,
    sandbox,
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}

const cases = [
  { tenant: "0", code: "1", allowed: true, why: "the deployment's own instance keeps Code" },
  { tenant: "", code: "1", allowed: true, why: "an unset tenant flag is the deployment's own" },
  { tenant: "0", code: "0", allowed: false, why: "the flag alone can still withhold Code" },
  { tenant: "1", code: "0", allowed: false, why: "a tenant has no local Code by default" },
  { tenant: "1", code: "1", allowed: false, why: "a tenant cannot turn the local executor on" },
];

for (const testCase of cases) {
  const result = evaluate(
    { CLAUDESK_TENANT: testCase.tenant, CLAUDE_REMOTE_CODE_ACTIONS: testCase.code },
    `${guard}\n${requestMethods}\n${listenerMethods}`,
  );
  assert.equal(result.codeActionsEnabled, testCase.allowed,
    `codeActionsEnabled for tenant=${JSON.stringify(testCase.tenant)} `
    + `code=${testCase.code}: ${testCase.why}`);
  assert.equal(result.requests.includes("LocalSessions"), testCase.allowed,
    `the LocalSessions IPC surface for tenant=${JSON.stringify(testCase.tenant)} `
    + `code=${testCase.code}: ${testCase.why}`);
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

process.stdout.write("tenant-code-guard-smoke: a tenant never offers the local Code executor\n");
