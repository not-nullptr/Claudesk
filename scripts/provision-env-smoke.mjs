import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// `provision-user.sh` hands compose the account's whole identity as an inline
// environment prefix: CLAUDESK_TENANT, the name prefix, port, data root,
// AUTH_IDENTITY_URL and the gateway settings. That prefix is a chain of
// backslash-continued assignments ending at the `compose_shared` call. An
// assignment slipped in after the last backslash turns the whole block into
// plain shell variables for the provisioner itself — compose then runs on the
// deployment's `.env`, and the account comes up as a non-tenant with no
// identity injection (the account menu shows the synthetic gateway identity and
// the Code switcher disappears). This runs the real block with stubs and pins
// the environment compose actually receives.
const source = readFileSync(
  new URL("../scripts/provision-user.sh", import.meta.url), "utf8");
const lines = source.split("\n");
const start = lines.findIndex((line) => line.startsWith("recreate_services="));
const end = lines.findIndex((line, index) => index > start && line.startsWith("compose_shared "));
assert.notEqual(start, -1, "the recreate service list is set before the compose call");
assert.notEqual(end, -1, "the compose call follows the env prefix");

const block = lines.slice(start, end + 1).join("\n");
const prelude = `
set -eu
user_root=/data/users/ada
slug=ada
port=15901
first_name=Ada
user_email=ada@example.com
account_gateway_url=http://gateway:4000
account_gateway_key=sk-x
account_gateway_scheme=x-api-key
ACCOUNT_GATEWAY_SETTINGS=0
ACCOUNT_DEVELOPER_ACTIONS=0
ACCOUNT_INFRASTRUCTURE_ACTIONS=0
ACCOUNT_READ_ROOTS=/workspace
vm_memory_gb=4
vm_cpu_count=2
desktop_limit_gb=5
vm_vsock_port=
CLAUDESK_ACCOUNT_CODE_ACTIONS=0
CLAUDESK_ACCOUNT_CODE_RUNNERS=1
CLAUDESK_RECREATE_SERVICES="claude-desktop cowork-bridge claude-gateway-loopback"
# The real script mints this beside the account directories; the block under
# test only forwards it.
bridge_token=smoke-token
compose_shared() {
  printf 'TENANT=%s\\n' "\${CLAUDESK_TENANT-}"
  printf 'BRIDGEAUTH=%s\\n' "\${CLAUDESK_BRIDGE_AUTH-}"
  printf 'TOKEN=%s\\n' "\${CLAUDESK_BRIDGE_TOKEN-}"
  printf 'RUNNERS=%s\\n' "\${CLAUDESK_CODE_RUNNERS-}"
  printf 'PREFIX=%s\\n' "\${CLAUDESK_NAME_PREFIX-}"
  printf 'PORT=%s\\n' "\${COWORK_WEB_PORT-}"
  printf 'IDENTITY=%s\\n' "\${AUTH_IDENTITY_URL-}"
  printf 'ACCOUNT=%s\\n' "\${CLAUDE_REMOTE_ACCOUNT_EMAIL-}"
  printf 'MEMORY=%s\\n' "\${CLAUDE_COWORK_VM_MEMORY_GB-}"
  printf 'CPU=%s\\n' "\${CLAUDE_COWORK_VM_CPU_COUNT-}"
  printf 'LIMIT=%s\\n' "\${CLAUDE_DESKTOP_MEMORY_LIMIT-}"
  printf 'DATA=%s\\n' "\${CLAUDESK_DATA_ROOT-}"
  printf 'HOSTBASH=%s\\n' "\${CLAUDE_COWORK_HOST_BASH-}"
  printf 'ARGS=%s\\n' "$*"
}
`;

const result = spawnSync("sh", ["-c", `${prelude}\n${block}`], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const printed = new Set(result.stdout.trim().split("\n"));
for (const expected of [
  "TENANT=1",
  "BRIDGEAUTH=1",
  "TOKEN=smoke-token",
  "RUNNERS=1",
  "PREFIX=ada-",
  "PORT=15901",
  "IDENTITY=http://authd:8080",
  "ACCOUNT=ada@example.com",
  "MEMORY=4",
  "CPU=2",
  "LIMIT=5g",
  "DATA=/data/users/ada",
  "HOSTBASH=0",
  "ARGS=--project-name claudesk-ada up -d --force-recreate claude-desktop cowork-bridge claude-gateway-loopback",
]) {
  assert.ok(printed.has(expected),
    `compose did not receive ${expected}; got:\n${result.stdout}`);
}

process.stdout.write("provision-env-smoke: the account env reaches compose\n");
