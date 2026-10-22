import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A tenant's data containers must never join a shared Docker network again.
// The layout this pins: the stack's own network for Desktop/bridge/office/
// mobile, one fixed relay to the gateway, one fixed relay plus an
// /internal/-only ingress to authd, and the auth service on the control network
// with the relays. Everything below is the reason one account cannot reach
// another's API without even trying.
const root = fileURLToPath(new URL("..", import.meta.url));
const compose = readFileSync(`${root}compose.yaml`, "utf8");
const gateway = readFileSync(`${root}compose.gateway.yaml`, "utf8");
const provision = readFileSync(`${root}scripts/provision-user.sh`, "utf8");
const deploy = readFileSync(`${root}deploy.sh`, "utf8");
const ingress = readFileSync(`${root}bridge/ingress/nginx.conf`, "utf8");

function block(name) {
  const match = new RegExp(
    `\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|\\nnetworks:\\n)`,
  ).exec(compose);
  assert.ok(match, `${name} is defined in compose.yaml`);
  return match[1];
}

const desktop = block("claude-desktop");
assert.match(desktop, /networks:\n      default:/,
  "the Desktop is on the stack's own network");
assert.doesNotMatch(desktop, /^\s+gateway_net:/m,
  "the Desktop must not join the shared gateway network");

const mobile = block("claude-mobile");
assert.match(mobile, /networks:\n      default:/,
  "the mobile facade is on the stack's own network");
assert.doesNotMatch(mobile, /^\s+gateway_net:/m,
  "the mobile facade must not join the shared gateway network");

const authd = block("authd");
assert.match(authd, /gateway_net: \{\}/, "authd stays on gateway_net for the box proxy");
assert.match(authd, /control_net:\n        aliases:\n          - authd-upstream/,
  "authd is on the control network under a name its relays can resolve");

const gatewayEgress = block("gateway-egress");
assert.match(gatewayEgress, /default:\n        aliases:\n          - gateway/,
  "the stack resolves `gateway` to its egress relay");
assert.match(gatewayEgress, /gateway_net:/, "the egress relay is the only gateway_net data path");
assert.match(gatewayEgress, /TCP:gateway-upstream:4000/,
  "the relay forwards to the shared gateway's distinct upstream name");

const authdEgress = block("authd-egress");
assert.match(authdEgress, /default:\n        aliases:\n          - authd/,
  "the stack resolves `authd` to its egress relay");
assert.match(authdEgress, /control_net:/, "the auth relay lives on the control network");
assert.match(authdEgress, /TCP:authd-upstream:8080/,
  "the relay forwards to authd's distinct upstream name, not back to itself");

const ingressBlock = block("internal-ingress");
assert.match(ingressBlock, /default: \{\}/, "the ingress reaches the bridge on the stack network");
assert.match(ingressBlock, /control_net:/, "the ingress is where authd reaches it");
assert.match(ingressBlock, /- "\$\{CLAUDESK_NAME_PREFIX:-claudesk-\}desktop"/,
  "authd's recorded upstream still resolves to the ingress");
assert.match(ingressBlock, /bridge\/ingress\/nginx\.conf/,
  "the ingress uses the path-filtering config");

assert.match(ingress, /location \/internal\//, "the ingress forwards the internal lane");
assert.match(ingress, /proxy_pass http:\/\/\$claudesk_bridge/,
  "and re-resolves the bridge per request");
assert.match(ingress, /location \/ \{\n        return 404;/,
  "everything outside /internal/ is refused at the ingress");

assert.match(gateway, /gateway-upstream/,
  "the shared gateway carries the distinct upstream alias");
assert.match(compose, /control_net:\n    external: true/,
  "the control network is external like gateway_net");

assert.match(provision, /control_net="\$\{CLAUDESK_CONTROL_NETWORK:-claudesk-control\}"/,
  "provision-user knows the control network");
assert.match(provision, /docker network create "\$control_net"/,
  "provision-user creates it when missing");
assert.match(provision,
  /recreate_services="\$\{CLAUDESK_RECREATE_SERVICES:-[^"]*gateway-egress authd-egress internal-ingress[^"]*\}"/,
  "an account recreate includes the relays");

assert.match(deploy, /docker network create "\$control_net"/,
  "deploy.sh creates the control network when missing");
assert.match(deploy,
  /gateway-egress authd-egress internal-ingress/,
  "deploy.sh starts the relays");

process.stdout.write("network-isolation-smoke: tenants are off every shared network\n");
