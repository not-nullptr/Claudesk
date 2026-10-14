import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");
const wrapperSource = await readFile(
  new URL("../bridge-wrapper/main.cjs", import.meta.url),
  "utf8",
);
const preloadSource = await readFile(
  new URL("../bridge/public/remote-preload.js", import.meta.url),
  "utf8",
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function evaluate(code, resultExpression, context = {}) {
  // The sections under test are Node code (bridge/server.mjs reads
  // `process.env` for its trace switch); the sandbox has to look like Node for
  // them to evaluate at all.
  const sandbox = { process: { env: {} }, ...context };
  vm.runInNewContext(`${code}\nresult = ${resultExpression};`, sandbox);
  return JSON.parse(JSON.stringify(sandbox.result));
}

function normalizedMap(name) {
  return `Object.fromEntries([...${name}]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].sort()]))`;
}

const serverMethods = section(
  serverSource,
  "const allowedMethods = new Map([",
  "const allowedSettingsMethods",
);
const wrapperMethods = section(
  wrapperSource,
  "const allowedMethods = new Map([",
  "const allowedSettingsMethods",
);

for (let mask = 0; mask < 16; mask += 1) {
  const flags = {
    infrastructureActionsEnabled: Boolean(mask & 1),
    developerActionsEnabled: Boolean(mask & 2),
    codeActionsEnabled: Boolean(mask & 4),
    connectorsEnabled: Boolean(mask & 8),
  };
  const prelude = Object.entries(flags)
    .map(([name, value]) => `const ${name} = ${value};`)
    .join("\n");
  assert.deepEqual(
    evaluate(`${prelude}\n${serverMethods}`, normalizedMap("allowedMethods")),
    evaluate(`${prelude}\n${wrapperMethods}`, normalizedMap("allowedMethods")),
    `IPC method allowlists differ for capability mask ${mask}`,
  );
}

// A Cowork scheduled task's run history is read off
// `claude.web.LocalAgentModeSessions.getSessionsForScheduledTask` — the session
// manager answers it by filtering the sessions that carry the task's
// `scheduledTaskId` — and the preload publishes exactly the methods its surface
// carries. So allowing it on `LocalSessions` alone leaves the browser's facade
// without it: the task page's loader has nothing to call, bails silently, and
// its History column renders empty for a task that has run. Both surfaces and
// both policies must carry it.
const allCapabilities = `const infrastructureActionsEnabled = true;
  const developerActionsEnabled = true;
  const codeActionsEnabled = true;
  const connectorsEnabled = true;`;
for (const [policy, source] of [["bridge", serverMethods], ["wrapper", wrapperMethods]]) {
  const methods = evaluate(`${allCapabilities}\n${source}`, normalizedMap("allowedMethods"));
  assert.ok(methods.LocalAgentModeSessions.includes("getSessionsForScheduledTask"),
    `the ${policy} allowlist must serve the scheduled-task runs lookup on LocalAgentModeSessions`);
  assert.ok(methods.LocalSessions.includes("getSessionsForScheduledTask"),
    `the ${policy} allowlist must keep the Code surface's own copy of the runs lookup`);
  // The dispatch handshake, without which main process keeps re-emitting a
  // dispatch this client can never acknowledge: the renderer starts a session
  // for every `session_started` it receives and its only guard against starting
  // the same run twice is the acknowledgement (a dispatch main no longer holds
  // pending answers false, and the renderer skips it). With `ackEvent` absent
  // the renderer's `?? true` fallback silently returns "acked", so every
  // re-delivery appends the run's prompt to the session again.
  for (const method of ["ackEvent", "releaseDispatchClaim", "setEventAckSupported",
    "setHostRunsSupported"]) {
    assert.ok(methods.CoworkScheduledTasks.includes(method),
      `the ${policy} allowlist must let the Cowork scheduled-task client ${method}`);
  }
}

const serverSettings = section(
  serverSource,
  "const allowedSettingsMethods",
  "const remoteListenerMethods",
);
const wrapperSettings = section(
  wrapperSource,
  "const allowedSettingsMethods",
  "const allowedSurfaces",
);
for (const enabled of [false, true]) {
  const prelude = `const gatewaySettingsEnabled = ${enabled};`;
  assert.deepEqual(
    evaluate(`${prelude}\n${serverSettings}`, normalizedMap("allowedSettingsMethods")),
    evaluate(`${prelude}\n${wrapperSettings}`, normalizedMap("allowedSettingsMethods")),
    `Gateway settings allowlists differ when enabled=${enabled}`,
  );
}

const serverStores = section(serverSource, "const allowedStores", "const protocolRules");
const wrapperStores = section(wrapperSource, "const allowedStores", "const relayedListeners");
assert.deepEqual(
  evaluate(serverStores, normalizedMap("allowedStores")),
  evaluate(wrapperStores, normalizedMap("allowedStores")),
  "Desktop store allowlists differ",
);

const serverListeners = section(
  serverSource,
  "const remoteListenerMethods",
  "const allowedStores",
);
const wrapperListeners = section(
  wrapperSource,
  "const relayedListeners",
  "const relayedBootFeatures",
);
for (let mask = 0; mask < 8; mask += 1) {
  const developerActionsEnabled = Boolean(mask & 1);
  const codeActionsEnabled = Boolean(mask & 2);
  const connectorsEnabled = Boolean(mask & 4);
  const prelude = `
    const developerActionsEnabled = ${developerActionsEnabled};
    const codeActionsEnabled = ${codeActionsEnabled};
    const connectorsEnabled = ${connectorsEnabled};
  `;
  assert.deepEqual(
    evaluate(`${prelude}\n${serverListeners}`, normalizedMap("remoteListenerMethods")),
    evaluate(
      `${prelude}\n${wrapperListeners}`,
      normalizedMap("relayedListeners"),
      { randomBytes: () => ({ toString: () => "parity" }) },
    ),
    `Listener allowlists differ for capability mask ${mask}`,
  );
}

function normalizedProtocolRules(name) {
  return `${name}.map((rule) => ({
    methods: [...rule.methods].sort(),
    source: rule.path.source,
    flags: rule.path.flags,
  }))`;
}
const serverProtocols = section(serverSource, "const protocolRules", "const officialAssetPrefixes");
const wrapperProtocols = section(wrapperSource, "const protocolRules", "function sendJson");
assert.deepEqual(
  evaluate(serverProtocols, normalizedProtocolRules("protocolRules")),
  evaluate(wrapperProtocols, normalizedProtocolRules("protocolRules")),
  "Desktop protocol rules differ",
);

for (const removed of [
  "/api/cowork/invoke",
  "/api/cowork/surfaces",
]) assert.equal(serverSource.includes(removed), false, `${removed} remains in the outer bridge`);
assert.equal(wrapperSource.includes('url.pathname === "/describe"'), false, "/describe remains");
assert.equal(
  preloadSource.includes("async function bridgeRequest(path, body, { retryable = false } = {})"),
  true,
  "bridge requests must default to no retry",
);
for (const functionName of ["invoke", "invokeSettings", "uploadBrowserFiles", "relaunchDesktop"]) {
  const body = section(
    preloadSource,
    `function ${functionName}`,
    functionName === "invoke" ? "function invokeSettings" : "\n  function ",
  );
  assert.equal(body.includes("retryable: true"), false, `${functionName} must not retry`);
}

process.stdout.write("bridge-parity-smoke: outer and inner policies match\n");
