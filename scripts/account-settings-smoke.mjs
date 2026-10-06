import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Desktop renders its account settings panel against the outer bridge
// (bridge/server.mjs) and the wrapper revalidates the same request
// (bridge-wrapper/main.cjs). Both must forward the bounded settings object the
// controls write — the Chat toggles, the Code settings, onboarding and banners
// all use different keys — and reject anything unbounded or malformed, so
// exercise both copies. The profile route is checked alongside it: the profile
// editor saves global instructions with a hash and a Cowork flag, and an
// allowlist that forgot those rejected the save.

const cases = [
  {
    name: "outer",
    file: new URL("../bridge/server.mjs", import.meta.url),
    end: "function sanitizeStoreValue",
  },
  {
    name: "wrapper",
    file: new URL("../bridge-wrapper/main.cjs", import.meta.url),
    end: "function rendererCandidates",
  },
];

for (const { name, file, end } of cases) {
  const source = await readFile(file, "utf8");

  const profileStart = source.indexOf("function validateAccountProfileUpdate(");
  const start = source.indexOf("const accountSettingKeyPattern");
  const stop = source.indexOf(end, start);
  assert.notEqual(profileStart, -1, `${name}: missing validateAccountProfileUpdate`);
  assert.notEqual(start, -1, `${name}: missing accountSettingKeyPattern`);
  assert.notEqual(stop, -1, `${name}: missing section end`);

  const sandbox = {
    ApiError: class ApiError extends Error {
      constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
      }
    },
  };
  vm.runInNewContext(
    `${source.slice(profileStart, start)}
     ${source.slice(start, stop)}
     result = { validateAccountSettingsUpdate, validateAccountProfileUpdate };`,
    sandbox,
  );
  const { validateAccountSettingsUpdate: validate, validateAccountProfileUpdate: profile } = sandbox.result;

  const body = (value) => Buffer.from(JSON.stringify(value), "utf8");

  // Every account control writes through this one route, so a spread of the
  // shapes actually seen must pass: the Code transcript view, chat toggles,
  // banner dismissals, Code branch prefix, voice and the MCP tool map.
  for (const payload of [
    { code_default_transcript_view: "verbose" },
    { enabled_mcp_tools: { servers: [{ id: "s", tools: ["a"] }] } },
    { dismissed_claudeai_banners: [{ banner_id: "b", dismissed_at: "2026-01-01T00:00:00Z" }] },
    { ccr_branch_prefix: "claude/" },
    { enabled_geolocation: false, tool_search_mode: "auto", ccr_switch_models_on_flag: true },
    { preview_feature_uses_artifacts: true, enabled_web_search: null },
  ]) {
    validate("PATCH", "/api/account/settings", body(payload));
  }

  // The profile editor's own save, in both its plain and union forms.
  profile("PUT", "/api/account_profile", body({ conversation_preferences: "be terse" }));
  profile("PUT", "/api/account_profile", body({
    conversation_preferences: "be terse",
    cowork_instructions_union: true,
    cowork_global_instructions_sha256: "a".repeat(64),
  }));
  profile("PUT", "/api/account_profile", body({ avatar: 3, work_function: "eng" }));

  // Unrelated methods and paths are other validators' business.
  validate("GET", "/api/account/settings", Buffer.alloc(0));
  validate("PATCH", "/api/account_profile", body({ work_function: "eng" }));

  for (const [method, pathname, payload] of [
    ["PATCH", "/api/account/settings", body({})],
    ["PATCH", "/api/account/settings", Buffer.from("not json", "utf8")],
    ["PATCH", "/api/account/settings", body(["normal"])],
    // Keys must look like settings keys, and internal_* is never a setting.
    ["PATCH", "/api/account/settings", body({ "bad key!": true })],
    ["PATCH", "/api/account/settings", body({ ["k".repeat(129)]: true })],
    ["PATCH", "/api/account/settings", body({ internal_secret: true })],
    // Values stay bounded: no endless string, array or nesting.
    ["PATCH", "/api/account/settings", body({ code_default_transcript_view: "x".repeat(8193) })],
    ["PATCH", "/api/account/settings", body({ enabled_mcp_tools: new Array(513).fill(0) })],
    ["PATCH", "/api/account/settings", body({
      enabled_mcp_tools: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
    })],
    ["PATCH", "/api/account/settings", body(Object.fromEntries(
      Array.from({ length: 65 }, (unused, index) => [`setting_${index}`, true]),
    ))],
    ["PUT", "/api/account_profile", body({ unexpected: "x" })],
    ["PUT", "/api/account_profile", body({ cowork_global_instructions_sha256: "nope" })],
    ["PUT", "/api/account_profile", body({ cowork_instructions_union: "yes" })],
    ["PUT", "/api/account_profile", body({ conversation_preferences: "x".repeat(10001) })],
  ]) {
    const check = pathname === "/api/account_profile" ? profile : validate;
    assert.throws(
      () => check(method, pathname, payload),
      `${name}: expected rejection for ${payload.toString("utf8").slice(0, 60)}`,
    );
  }
}

process.stdout.write("account-settings-smoke: account settings and profile writes are bounded and forwarded\n");
