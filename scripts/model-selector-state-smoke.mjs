import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Desktop renders its per-surface model selector against the outer bridge
// (bridge/server.mjs) and the wrapper revalidates the same request
// (bridge-wrapper/main.cjs). Both must forward the selector's PATCH and reject
// everything else, so exercise both copies.

const org = "11111111-2222-3333-4444-555555555555";
const selectorPath = `/api/organizations/${org}/model_selector_state/chat`;

const cases = [
  {
    name: "outer",
    file: new URL("../bridge/server.mjs", import.meta.url),
    ruleEnd: "const officialAssetPrefixes",
    validatorEnd: "function sanitizeStoreValue",
  },
  {
    name: "wrapper",
    file: new URL("../bridge-wrapper/main.cjs", import.meta.url),
    ruleEnd: "function sendJson",
    validatorEnd: "function rendererCandidates",
  },
];

for (const { name, file, ruleEnd, validatorEnd } of cases) {
  const source = await readFile(file, "utf8");

  const ruleStart = source.indexOf("const protocolRules");
  const rules = vm.runInNewContext(
    `${source.slice(ruleStart, source.indexOf(ruleEnd, ruleStart))}\nprotocolRules;`,
    {},
  );
  const matches = (method, pathname) =>
    rules.some((rule) =>
      rule.methods.has(method) && rule.path.test(pathname));
  assert.equal(matches("PATCH", selectorPath), true, `${name}: selector PATCH must be allowed`);
  for (const pathname of [
    `/api/organizations/${org}/model_selector_state/chat/extra`,
    `/api/organizations/${org}/model_selector_state/`,
    `/api/organizations/not-a-uuid/model_selector_state/chat`,
  ]) {
    assert.equal(matches("PATCH", pathname), false, `${name}: ${pathname} must stay blocked`);
  }

  const start = source.indexOf("const modelSelectorFields");
  const stop = source.indexOf(validatorEnd, start);
  assert.notEqual(start, -1, `${name}: missing modelSelectorFields`);
  assert.notEqual(stop, -1, `${name}: missing section end`);
  const sandbox = { ApiError: Error };
  vm.runInNewContext(`${source.slice(start, stop)}\nresult = validateModelSelectorUpdate;`, sandbox);
  const validate = sandbox.result;

  const body = (value) => Buffer.from(JSON.stringify(value), "utf8");
  for (const payload of [
    { model: { set: "claude-sonnet-5" } },
    { thinking: { set: { effort: "high", mode: "on" } } },
    { thinking_by_model: { set: [{ id: "claude-sonnet-5", thinking: { effort: "low", mode: "on" } }] } },
    { preset: { set: null } },
    { model: { unchanged: true } },
    { model: { set: "claude-sonnet-5" }, selection_source: "user_setting" },
  ]) {
    validate("PATCH", selectorPath, body(payload));
  }

  // Other methods and paths are other validators' business.
  validate("GET", selectorPath, Buffer.alloc(0));
  validate("PATCH", "/api/account/settings", body({ code_default_transcript_view: "normal" }));

  for (const payload of [
    Buffer.from("not json", "utf8"),
    body(["claude-sonnet-5"]),
    body({}),
    body({ unrelated_field: true }),
    body({ model: "x".repeat(8193) }),
    body({ thinking_by_model: { set: new Array(513).fill(null) } }),
    body({ model: { set: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } } }),
    body({ model: { set: "claude-sonnet-5" }, ["k".repeat(129)]: true }),
  ]) {
    assert.throws(
      () => validate("PATCH", selectorPath, payload),
      `${name}: expected rejection for ${payload.toString("utf8").slice(0, 60)}`,
    );
  }
}

process.stdout.write("model-selector-state-smoke: selector writes are bounded and forwarded\n");
