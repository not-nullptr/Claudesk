import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Putting an instance up is where an account's privileges are decided. This pins
// the one rule that matters: a non-Admin account gets none of the operator
// surfaces, whatever the deployment has turned on for itself — in particular the
// writable Gateway/inference configuration library, which an end user must
// neither see nor be able to edit through the bridge API. An Admin keeps the
// deployment's own setting. The decision lives in scripts/lib/surfaces.sh so it
// can be driven here directly, rather than inferred from provision-user.sh.

const surfaces = fileURLToPath(new URL("./lib/surfaces.sh", import.meta.url));

// Source the lib, apply a role, and print the three values as `g d i`.
function surfacesFor(role, env) {
  const script = '. "$1"; account_operator_surfaces "$2";'
    + ' printf "%s %s %s\\n" "$ACCOUNT_GATEWAY_SETTINGS"'
    + ' "$ACCOUNT_DEVELOPER_ACTIONS" "$ACCOUNT_INFRASTRUCTURE_ACTIONS"';
  const result = spawnSync("/bin/sh", ["-c", script, "sh", surfaces, role], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// The deployment turns every operator surface on for its own admin use.
const deploymentOn = {
  CLAUDE_REMOTE_GATEWAY_SETTINGS: "1",
  CLAUDE_REMOTE_DEVELOPER_ACTIONS: "1",
  CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS: "1",
};

// --- a non-Admin account gets none of them ----------------------------------
for (const role of ["User", "user", "", "Admin ", "operator"]) {
  assert.equal(surfacesFor(role, deploymentOn), "0 0 0",
    `role ${JSON.stringify(role)} must not inherit the deployment's operator surfaces`);
}

// --- an Admin keeps the deployment's own setting ----------------------------
assert.equal(surfacesFor("Admin", deploymentOn), "1 1 1",
  "an Admin keeps the deployment's setting");
assert.equal(surfacesFor("Admin", {}), "0 0 0",
  "an Admin of a deployment with the surfaces off gets none");

// --- the explicit override wins for every account ---------------------------
assert.equal(
  surfacesFor("User", { ...deploymentOn, CLAUDESK_ACCOUNT_GATEWAY_SETTINGS: "1" }),
  "1 0 0",
  "CLAUDESK_ACCOUNT_GATEWAY_SETTINGS forces the surface on for a non-Admin too",
);
assert.equal(
  surfacesFor("Admin", { CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS: "0" }),
  "0 0 0",
  "an override of 0 wins over the deployment's 1",
);
// An empty value counts as unset (a blank line in .env changes nothing).
assert.equal(
  surfacesFor("Admin", { ...deploymentOn, CLAUDESK_ACCOUNT_GATEWAY_SETTINGS: "" }),
  "1 1 1",
  "an empty override falls through to the deployment's value",
);

console.log("account-surfaces-smoke: a non-Admin account gets no operator surfaces");
