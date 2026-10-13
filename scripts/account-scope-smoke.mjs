import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A provisioned account runs the deployment's own compose.yaml with the
// deployment's .env, so it inherits every value the deployment set unless it is
// pinned. This pins the rule for what must NOT be inherited: a non-Admin account
// gets none of the operator surfaces and reads only its own workspace, whatever
// the deployment has turned on for itself — in particular the writable
// Gateway/inference configuration library, which an end user must neither see nor
// be able to edit through the bridge API. An Admin keeps the deployment's own
// setting. The decision lives in scripts/lib/account-scope.sh so it can be driven
// here directly, rather than inferred from provision-user.sh.

const scope = fileURLToPath(new URL("./lib/account-scope.sh", import.meta.url));

// Source the lib, apply a role, and print the four values as `g d i r`.
function scopeFor(role, env) {
  const script = '. "$1"; account_scope "$2";'
    + ' printf "%s|%s|%s|%s\\n" "$ACCOUNT_GATEWAY_SETTINGS"'
    + ' "$ACCOUNT_DEVELOPER_ACTIONS" "$ACCOUNT_INFRASTRUCTURE_ACTIONS"'
    + ' "$ACCOUNT_READ_ROOTS"';
  const result = spawnSync("/bin/sh", ["-c", script, "sh", scope, role], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// The deployment turns every operator surface on and hands its own instance extra
// read roots, for its own admin use.
const deployment = {
  CLAUDE_REMOTE_GATEWAY_SETTINGS: "1",
  CLAUDE_REMOTE_DEVELOPER_ACTIONS: "1",
  CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS: "1",
  COWORK_REMOTE_READ_ROOTS: "/workspace:/config",
};

// --- a non-Admin account inherits none of it --------------------------------
for (const role of ["User", "user", "", "Admin ", "operator"]) {
  assert.equal(scopeFor(role, deployment), "0|0|0|",
    `role ${JSON.stringify(role)} must not inherit the deployment's operator scope`);
}

// --- an Admin keeps the deployment's own setting ----------------------------
assert.equal(scopeFor("Admin", deployment), "1|1|1|/workspace:/config",
  "an Admin keeps the deployment's setting");
assert.equal(scopeFor("Admin", {}), "0|0|0|",
  "an Admin of a deployment with the surfaces off gets none");

// --- the explicit override wins for every account ---------------------------
assert.equal(
  scopeFor("User", { ...deployment, CLAUDESK_ACCOUNT_GATEWAY_SETTINGS: "1" }),
  "1|0|0|",
  "CLAUDESK_ACCOUNT_GATEWAY_SETTINGS forces the surface on for a non-Admin too",
);
assert.equal(
  scopeFor("User", { ...deployment, CLAUDESK_ACCOUNT_READ_ROOTS: "/config" }),
  "0|0|0|/config",
  "CLAUDESK_ACCOUNT_READ_ROOTS overrides the workspace-only default",
);
assert.equal(
  scopeFor("Admin", { CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS: "0" }),
  "0|0|0|",
  "an override of 0 wins over the deployment's 1",
);
// An empty value counts as unset (a blank line in .env changes nothing).
assert.equal(
  scopeFor("Admin", { ...deployment, CLAUDESK_ACCOUNT_GATEWAY_SETTINGS: "" }),
  "1|1|1|/workspace:/config",
  "an empty override falls through to the deployment's value",
);

console.log("account-scope-smoke: a non-Admin account inherits no operator scope");
