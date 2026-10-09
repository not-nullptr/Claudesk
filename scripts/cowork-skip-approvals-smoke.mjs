import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Cowork's "Skip all approvals" row is hidden by two independent gates the
// renderer reads: the org's `cowork_settings.skip_approvals_enabled` (default
// false, admin-only) and the `cowork_bypass_permissions_mode` growthbook flag.
// The bridge answers both as enabled for a self-hosted deployment so the row
// appears and sessions can run prompt-free. These checks pin the rewrite shape,
// its idempotence, and the env switch that turns the whole thing back off.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const flagSection = section(serverSource, "const webShellEnabled =", "const remoteUserName =");
const settingsPathLine = section(serverSource, "const coworkSettingsPath =", "\n\n");
const grantSection = section(
  serverSource,
  "function growthbookKey",
  "function containsSensitiveCredential",
);

// The bridge sections run in another realm, so their objects are round-tripped
// through this realm's JSON before strict deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Evaluate the real flag expression with a chosen web-shell bit and env so the
// switch's truth table is exercised, not a stand-in.
function load({ webShell = false, env = {} } = {}) {
  const sandbox = { process: { env: { ...env } } };
  const flagSource = flagSection.replace(
    /const webShellEnabled = .*;/,
    `const webShellEnabled = ${webShell};`,
  );
  vm.runInNewContext(
    `${flagSource}${settingsPathLine}${grantSection}
     result = {
       skipApprovals: grantCoworkSkipApprovals,
       bypassGate: grantCoworkBypassGate,
       hashed: growthbookKey,
       path: coworkSettingsPath,
       enabled: coworkSkipApprovals,
     };`,
    sandbox,
  );
  return sandbox.result;
}

const { skipApprovals, bypassGate, hashed, path } = load();

// The settings document is rewritten to enable the row, once.
const settings = { auto_mode_enabled: true, skip_approvals_enabled: false, other: 1 };
assert.equal(skipApprovals(settings), true, "a false admin setting is raised to true");
assert.equal(settings.skip_approvals_enabled, true, "the flag is set on the document");
assert.equal(settings.auto_mode_enabled, true, "sibling settings are left alone");
assert.equal(skipApprovals(settings), false, "an already-true value is a no-op");
assert.equal(skipApprovals(null), false, "a null body is ignored");
assert.equal(skipApprovals([1, 2]), false, "an array body is ignored");

// The rollout gate is added when absent, replaced when false, and left when on.
const absent = { growthbook: { features: {} } };
assert.equal(bypassGate(absent), true, "an absent gate is added");
assert.deepEqual(plain(absent.growthbook.features[hashed("cowork_bypass_permissions_mode")]),
  { defaultValue: true }, "the gate is added on => true");

const off = { growthbook: { features: { [hashed("cowork_bypass_permissions_mode")]: { value: false } } } };
assert.equal(bypassGate(off), true, "a gate evaluated false is replaced");
assert.deepEqual(plain(off.growthbook.features[hashed("cowork_bypass_permissions_mode")]),
  { defaultValue: true }, "the replacement reads true");

const on = { growthbook: { features: { [hashed("cowork_bypass_permissions_mode")]: { defaultValue: true } } } };
assert.equal(bypassGate(on), false, "an already-on gate is a no-op");
assert.deepEqual(plain(on.growthbook.features[hashed("cowork_bypass_permissions_mode")]),
  { defaultValue: true }, "the on gate is preserved");

assert.equal(bypassGate({}), false, "a bootstrap without growthbook is ignored");

// Only the org settings path is rewritten, never a sibling org document.
assert.ok(path.test("/api/organizations/123e4567-e89b-12d3-a456-426614174000/cowork_settings"),
  "the org cowork_settings path matches");
assert.ok(!path.test("/api/organizations/123e4567-e89b-12d3-a456-426614174000/feature_settings"),
  "a sibling org document does not match");
assert.ok(!path.test("/api/claude_code/organizations/123e4567-e89b-12d3-a456-426614174000/cowork_settings"),
  "the code org namespace does not match");

// The switch: on with the web shell, off without it, explicit override either way.
assert.equal(load({ webShell: true }).enabled, true, "on by default with the web shell");
assert.equal(load({ webShell: false }).enabled, false, "off without the web shell");
assert.equal(load({ webShell: true, env: { CLAUDE_REMOTE_COWORK_SKIP_APPROVALS: "0" } }).enabled, false,
  "web shell with the kill switch is off");
assert.equal(load({ webShell: false, env: { CLAUDE_REMOTE_COWORK_SKIP_APPROVALS: "1" } }).enabled, true,
  "explicit opt-in without the web shell");

console.log("cowork-skip-approvals-smoke: ok");
