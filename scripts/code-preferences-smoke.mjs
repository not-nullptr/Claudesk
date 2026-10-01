import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("  function createCodePreferences()"), source.indexOf("  function currentRemoteRoute()"));
let stored = { bypassPermissionsOptInByAccount: {}, bypassPermissionsGateByAccount: {} };
let writes = 0, interval, cleared = false;
const api = vm.runInNewContext(`${factory}\ncreateCodePreferences()`, {
  invokeSettings: async (surface, method, args) => {
    assert.equal(surface, "AppPreferences");
    if (method === "setPreference") { writes++; stored = { ...stored, [args[0]]: args[1] }; }
    return structuredClone(stored);
  },
  setInterval(fn) { interval = fn; return 1; }, clearInterval() { cleared = true; },
});
await api.getPreferences();
assert.equal(writes, 0, "reading settings must not opt into bypass mode");
let observed;
const unsubscribe = api.onPreferencesChanged(value => { observed = value; });
const account = "00000000-0000-0000-0000-000000000001";
await api.setPreference("bypassPermissionsOptInByAccount", { [account]: true });
assert.equal(observed.bypassPermissionsOptInByAccount[account], true);
stored = { bypassPermissionsOptInByAccount: { [account]: false } };
await interval();
await new Promise(resolve => setImmediate(resolve));
assert.equal(observed.bypassPermissionsOptInByAccount[account], false);
unsubscribe(); assert.equal(cleared, true);
for (const path of ["../bridge/server.mjs", "../bridge-wrapper/main.cjs"]) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  const start = text.indexOf("function validateCodePreference(");
  const end = text.indexOf("\nfunction ", start + 1);
  const validate = vm.runInNewContext(`${text.slice(start, end)}\nvalidateCodePreference`, { ApiError: Error });
  validate("getPreferences", []);
  validate("setPreference", ["bypassPermissionsModeEnabled", false]);
  validate("setPreference", ["bypassPermissionsOptInByAccount", { [account]: true }]);
  for (const args of [["unrelatedPreference", true], ["bypassPermissionsModeEnabled", "true"],
    ["bypassPermissionsOptInByAccount", { all: true }], ["bypassPermissionsGateByAccount", { [account]: 1 }]]) {
    assert.throws(() => validate("setPreference", args));
  }
  assert.throws(() => validate("getPreferences", ["extra"]));
  const settingsStart = text.indexOf("function validateSettingsInvocation(");
  const settingsEnd = text.indexOf("\n}", settingsStart) + 2;
  const sandbox = { ApiError: Error, codeActionsEnabled: true, gatewaySettingsEnabled: true,
    allowedSettingsMethods: new Map([["AppPreferences", new Set(["getPreferences", "setPreference"])]]) };
  const settings = vm.runInNewContext(`${text.slice(start, end)}\n${text.slice(settingsStart, settingsEnd)}\nvalidateSettingsInvocation`, sandbox);
  settings("AppPreferences", "getPreferences", []);
  assert.throws(() => settings("AppPreferences", "setPreference", ["unrelatedPreference", true]));
  sandbox.codeActionsEnabled = false;
  assert.throws(() => settings("AppPreferences", "getPreferences", []));
}
const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
const invocation = wrapper.slice(wrapper.indexOf("async function invokeSettings("), wrapper.indexOf("async function readStore("));
let nativePreferences = { bypassPermissionsOptInByAccount: {}, unrelatedPrivatePreference: "private" };
const invoke = vm.runInNewContext(`${invocation}\ninvokeSettings`, {
  Buffer, undefinedSentinelKey: "__claudeRemoteUndefinedV1",
  decodeIpcValue: value => value, validateSettingsInvocation() {},
  gatewaySettingsRenderer: async () => ({ executeJavaScript: async () => JSON.stringify({ ok: true, value: nativePreferences }) }),
});
let exposed = await invoke("AppPreferences", "getPreferences", []);
assert.deepEqual(Object.keys(exposed), ["bypassPermissionsOptInByAccount"]);
nativePreferences = {};
exposed = await invoke("AppPreferences", "getPreferences", []);
assert.equal(Object.keys(exposed).length, 0, "unsupported preferences must not be fabricated");
console.log("code-preferences-smoke: opt-in persistence, notifications and bounded preference writes passed");
