import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Desktop renders its account settings panel against the outer bridge
// (bridge/server.mjs) and the wrapper revalidates the same request
// (bridge-wrapper/main.cjs). Both must accept the Code tab's "Default
// transcript view" write and reject everything else, so exercise both copies.

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
  const start = source.indexOf("const allowedAccountSettings");
  const stop = source.indexOf(end, start);
  assert.notEqual(start, -1, `${name}: missing allowedAccountSettings`);
  assert.notEqual(stop, -1, `${name}: missing section end`);
  const block = source.slice(start, stop);

  const sandbox = {
    ApiError: class ApiError extends Error {
      constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
      }
    },
  };
  vm.runInNewContext(`${block}\nresult = validateAccountSettingsUpdate;`, sandbox);
  const validate = sandbox.result;

  const body = (value) => Buffer.from(JSON.stringify(value), "utf8");
  for (const value of ["normal", "thinking", "verbose"]) {
    validate("PATCH", "/api/account/settings", body({ code_default_transcript_view: value }));
  }

  // Unrelated methods and paths are other validators' business.
  validate("GET", "/api/account/settings", Buffer.alloc(0));
  validate("PATCH", "/api/account_profile", body({ work_function: "eng" }));

  for (const [method, pathname, payload] of [
    ["PATCH", "/api/account/settings", body({ code_default_transcript_view: "loud" })],
    ["PATCH", "/api/account/settings", body({ unrelated_setting: true })],
    ["PATCH", "/api/account/settings", body({ code_default_transcript_view: "thinking", extra: 1 })],
    ["PATCH", "/api/account/settings", body({})],
    ["PATCH", "/api/account/settings", Buffer.from("not json", "utf8")],
    ["PATCH", "/api/account/settings", body(["normal"])],
  ]) {
    assert.throws(
      () => validate(method, pathname, payload),
      `${name}: expected rejection for ${payload.toString("utf8")}`,
    );
  }
}

process.stdout.write("account-settings-smoke: transcript view writes are bounded\n");
