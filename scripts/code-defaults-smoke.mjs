import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Code landing and the Code session page resolve different
// `model_selector_state` rows in this build (the landing writes `cowork`, the
// session page reads `code`). A pick thus looked like it did not save: the
// create body carried it, but the next page read the untouched row. The bridge
// settles the pair on the last created session's start settings and mirrors
// later PATCHes; this pins both behaviors.
const serverSource = await readFile(
  new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const selector = section(
  serverSource,
  "const modelSelectorSurfaces",
  "function sanitizeStoreValue",
);
const sandbox = { console: { log() {} } };
vm.runInNewContext(
  `${selector}\nresult = { modelSelectorSurfaceOf, reconcileModelSelectorState };`,
  sandbox,
);
const { modelSelectorSurfaceOf, reconcileModelSelectorState } = sandbox.result;

assert.equal(modelSelectorSurfaceOf("/api/organizations/00000000-0000-4000-8000-000000000001/model_selector_state/code"), "code");
assert.equal(modelSelectorSurfaceOf("/api/organizations/00000000-0000-4000-8000-000000000001/model_selector_state/cowork"), "cowork");
assert.equal(modelSelectorSurfaceOf("/api/organizations/00000000-0000-4000-8000-000000000001/model_selector_state/chat"), null,
  "only the two Code rows are settled");
assert.equal(modelSelectorSurfaceOf("/api/organizations/00000000-0000-4000-8000-000000000001/model_selector_state/code/extra"), null);

function entry(id, effort, model = "m1") {
  return {
    id,
    model,
    selection_source: "user_setting",
    thinking: effort === null ? undefined : { type: "effort", effort },
    thinking_by_model: [{ id: model, thinking: { type: "effort", effort } }],
  };
}

function documentWith(codeEffort, coworkEffort, model = "m1") {
  return {
    account: { uuid: "a" },
    model_selector_state: [entry("code", codeEffort, model), entry("cowork", coworkEffort, model)],
  };
}

function efforts(document) {
  const map = {};
  for (const item of document.model_selector_state) {
    map[item.id] = item.thinking?.effort ?? null;
  }
  return map;
}

// The reported shape: the landing persisted max on `cowork`, the session page
// read `code` (still high), and the last created session ran at max.
const settled = reconcileModelSelectorState(documentWith("high", "max"), { effort_level: "max" });
assert.deepEqual(efforts(settled), { code: "max", cowork: "max" },
  "the last session's effort settles both Code rows");
assert.notEqual(settled.model_selector_state[0], settled.model_selector_state[1]);
assert.equal(settled.model_selector_state[0].thinking.effort, "max");
assert.deepEqual(settled.model_selector_state[0].thinking_by_model,
  [{ id: "m1", thinking: { type: "effort", effort: "max" } }],
  "the per-model thinking map follows the settled row");

// A pick that reached the session page (code) settles cowork the other way.
assert.deepEqual(
  efforts(reconcileModelSelectorState(documentWith("xhigh", "high"), { effort_level: "xhigh" })),
  { code: "xhigh", cowork: "xhigh" },
  "a code-surface pick settles the cowork row");

// Before the session exists the two rows can disagree with no session to read:
// the non-default row still wins over the recommended "high" default.
assert.deepEqual(
  efforts(reconcileModelSelectorState(documentWith("high", "max"), { effort_level: null })),
  { code: "max", cowork: "max" },
  "a non-default row beats the recommended default without a session");
assert.deepEqual(
  efforts(reconcileModelSelectorState(documentWith("max", "high"), null)),
  { code: "max", cowork: "max" },
  "and the same holds when the pick landed on code");
// A session started from the stale row carries "high"; that is not evidence
// against the earlier non-default pick, so it must not overwrite it.
assert.deepEqual(
  efforts(reconcileModelSelectorState(documentWith("high", "max"), { effort_level: "high" })),
  { code: "max", cowork: "max" },
  "a session that ran the recommended default must not erase a non-default pick");
assert.deepEqual(
  efforts(reconcileModelSelectorState(documentWith("max", "high"), { effort_level: "high" })),
  { code: "max", cowork: "max" },
  "same when the pick landed on code and the session ran high");

// Equal rows are left exactly as they are (identity, not a copy).
const equal = documentWith("max", "max");
assert.equal(reconcileModelSelectorState(equal, { effort_level: "max" }), equal,
  "a settled pair must not be rewritten");

// A model pick rides with the effort, and a document without both rows is
// untouched.
const differentModels = {
  model_selector_state: [
    { ...entry("code", "high", "old"), model: "old" },
    { ...entry("cowork", "max", "new"), model: "new" },
  ],
};
const moved = reconcileModelSelectorState(differentModels, { effort_level: "max" });
assert.equal(moved.model_selector_state[0].model, "new",
  "the settled row must carry the picked model too");
assert.equal(moved.model_selector_state[1].model, "new");
const missing = { model_selector_state: [entry("code", "max")] };
assert.equal(reconcileModelSelectorState(missing, null), missing,
  "a document without the cowork row is left alone");

// The routes and the preload seed that make the preference live.
assert.ok(serverSource.includes('url.pathname === "/api/remote/code-defaults"'),
  "the preload's seed source must be served");
assert.ok(serverSource.includes("async function storedDefaultPermissionMode()"),
  "the create route needs a stored default for the composer's failsafe mode");
assert.ok(serverSource.includes('body.config.permission_mode === "default"'),
  "a create body carrying the failsafe default must be filled from the stored pick");
assert.ok(serverSource.includes("/model_selector_state/${otherSurface}`"),
  "an in-session model-selector PATCH must be mirrored to the other Code row");
assert.ok(serverSource.includes("codeRunners.recentSessionConfig()"),
  "the seed source is the last placed session's config");
const runners = await readFile(
  new URL("../bridge/code-runners.mjs", import.meta.url), "utf8");
assert.ok(runners.includes("async recentSessionConfig()"),
  "the runner store must expose the last session's start settings");
assert.ok(runners.includes('mode !== "default" && mode !== "plan"'),
  "the permission seed must skip the composer's failsafe and plan posture");
assert.match(runners, /permission_mode: permissionMode/,
  "the seed carries the last explicit permission mode");

const preload = await readFile(
  new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
assert.match(preload, /fetch\("\/api\/remote\/code-defaults"/,
  "the AppPreferences shim must read the seed");
assert.ok(preload.includes('"cc-landing-draft-permission-mode": seed'),
  "the seed must be the key the draft permission hook reads");
assert.ok(preload.includes("startsWith(\"cc-landing-draft-permission-mode.\")"),
  "an account-scoped pick must win over the seed");

process.stdout.write("code-defaults-smoke: the Code rows settle and the draft mode follows the last session\n");
