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
  const boundStart = text.indexOf("function isBoundedJsonValue(");
  const boundEnd = text.indexOf("\nfunction ", boundStart + 1);
  const validate = vm.runInNewContext(
    `${text.slice(boundStart, boundEnd)}\n${text.slice(start, end)}\nvalidateCodePreference`,
    { ApiError: Error },
  );
  validate("getPreferences", []);
  validate("setPreference", ["bypassPermissionsModeEnabled", false]);
  validate("setPreference", ["bypassPermissionsOptInByAccount", { [account]: true }]);
  // The permission-mode pick is stored inside the desktop's `epitaxyPrefs`
  // bucket, so that key has to pass or the picker resets on every reload.
  validate("setPreference", ["epitaxyPrefs", { [`cc-landing-draft-permission-mode.${account}`]: "auto" }]);
  validate("setPreference", ["epitaxyPrefs", { "epitaxy-perm-mode-acks": [`${account}:bypass`] }]);
  // The renderer deletes a retired pref by rewriting the whole bucket with that
  // key set to `undefined` (its `deleteStrict`), sent as a JSON-undefined
  // sentinel. That must validate: if it throws, the key stays stuck in the
  // bucket and every later pref write — the permission-mode pick included —
  // is rejected, so the pick silently reverts on the next read or on send.
  validate("setPreference", ["epitaxyPrefs", { "epitaxy-tasks-store": undefined }]);
  validate("setPreference", ["epitaxyPrefs", {
    ["epitaxy-folder-permission-mode." + account]: { "/workspace/project": "bypassPermissions" },
    "dframe-unpinned-home-project": undefined,
    "mixed-array": ["kept", undefined],
  }]);
  for (const args of [["unrelatedPreference", true], ["bypassPermissionsModeEnabled", "true"],
    ["bypassPermissionsOptInByAccount", { all: true }], ["bypassPermissionsGateByAccount", { [account]: 1 }],
    ["epitaxyPrefs", ["not", "an", "object"]], ["epitaxyPrefs", "auto"],
    ["epitaxyPrefs", { ["k".repeat(129)]: true }]]) {
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
let nativePreferences = {
  bypassPermissionsOptInByAccount: {},
  unrelatedPrivatePreference: "private",
  epitaxyPrefs: {
    [`cc-landing-draft-permission-mode.${account}`]: "auto",
    "epitaxy-perm-mode-acks": [`${account}:bypass`],
    ["k".repeat(129)]: "dropped",
    "builtinBrowserAllowedDomains": ["example.com"],
  },
};
const invoke = vm.runInNewContext(`${invocation}\ninvokeSettings`, {
  Buffer, undefinedSentinelKey: "__claudeRemoteUndefinedV1",
  decodeIpcValue: value => value, validateSettingsInvocation() {},
  gatewaySettingsRenderer: async () => ({ executeJavaScript: async () => JSON.stringify({ ok: true, value: nativePreferences }) }),
});
let exposed = await invoke("AppPreferences", "getPreferences", []);
assert.deepEqual(Object.keys(exposed).sort(), ["bypassPermissionsOptInByAccount", "epitaxyPrefs"]);
assert.equal(exposed.epitaxyPrefs[`cc-landing-draft-permission-mode.${account}`], "auto");
assert.equal(
  JSON.stringify(exposed.epitaxyPrefs["epitaxy-perm-mode-acks"]),
  JSON.stringify([`${account}:bypass`]),
);
assert.equal(exposed.epitaxyPrefs["k".repeat(129)], undefined, "oversized preference keys are dropped");
assert.equal(exposed.unrelatedPrivatePreference, undefined);
nativePreferences = {};
exposed = await invoke("AppPreferences", "getPreferences", []);
assert.equal(Object.keys(exposed).length, 0, "unsupported preferences must not be fabricated");
console.log("code-preferences-smoke: opt-in persistence, notifications and bounded preference writes passed");
