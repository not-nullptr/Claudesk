# Security Policy

Claudesk bridges browser requests into a locally running Claude Desktop process. Treat every remotely exposed method as privileged and keep the deployment behind HTTPS and strong authentication.

## Supported versions

Security fixes are applied to the current `main` branch. Older commits and locally modified IPC allowlists are not supported.

## Reporting a vulnerability

Use the repository's **Security** tab to open a private GitHub Security Advisory. Do not publish an Issue containing:

- Gateway API keys or request headers;
- `.env`, managed settings, developer settings, MCP configuration, or logs;
- session transcripts, uploaded files, trace files, or heap snapshots;
- public hostnames, private IP addresses, authentication cookies, or Authelia tokens.

Include the affected commit, enabled feature flags, the smallest reproducible request, expected behavior, and observed behavior. Redact all credentials and personal data.

## Deployment boundary

- Ports `15820` and `15821` publish the bridge; the bridge now enforces its own
  API gate there and on the container network, so the reverse proxy is no longer
  the only boundary. Without `AUTH_IDENTITY_URL` (and `CLAUDESK_BRIDGE_AUTH`) a
  direct port is still unauthenticated.
- Direct ports must remain on a trusted LAN/Tailnet or be bound to loopback.
- Internet access must pass through TLS and an authentication layer such as Authelia.
- `CLAUDE_REMOTE_GATEWAY_SETTINGS`, `CLAUDE_REMOTE_DEVELOPER_ACTIONS` and `CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS` expand the remote attack surface and are disabled by default. `CLAUDE_REMOTE_CODE_ACTIONS` defaults to `1` on a deployment's own instance, whose Code runs in its own container with the operator's privileges.
- **A tenant instance never offers the container-local Code surface, whatever `CLAUDE_REMOTE_CODE_ACTIONS` says.** An account's container is privileged (`CAP_SYS_ADMIN`, `userns_mode: host`, `apparmor=unconfined`) and its `app` user has passwordless `sudo`, so a Code agent shell there would sit a short step from host root. `CLAUDESK_TENANT=1` withholds it in the bridge and in the container init; the account's Code belongs on a self-hosted runner inside its Cowork guest. See [docs/code-in-cowork-vm.md](docs/code-in-cowork-vm.md).
- **Accounts are network-isolated.** A tenant stack's Desktop, bridge, office preview and mobile facade join only that stack's own Docker network. The only per-account containers on a shared network are fixed-purpose relays: `gateway-egress` on `gateway_net` (one port to the box gateway) and `authd-egress` / `internal-ingress` on `claudesk-control` (one port to authd; `/internal/*` only, back to the account's bridge). Docker's inter-network isolation keeps one account's data containers off every other account's network and off `gateway_net`, so a peer cannot reach another account's API even without application auth.
- **The bridge authenticates its own API as well.** Tenant mode always verifies the authd session the reverse proxy uses and scopes it to `CLAUDE_REMOTE_ACCOUNT_EMAIL`; the mobile facade carries a per-account `CLAUDESK_BRIDGE_TOKEN`; runner legs keep their pool/session secret. This is the second line for the host-published port and for a misconfigured network. The deployment's own instance opts in with `CLAUDESK_BRIDGE_AUTH=1`.
- The Gateway API Key should remain in the Desktop container and must never be embedded in browser code, screenshots, logs, or repository files.

## Out of scope

Vulnerabilities in Claude Desktop, Electron, QEMU, Docker, the configured inference Gateway, reverse proxy, or authentication provider should also be reported to their respective maintainers. A Claudesk report is still appropriate when its bridge weakens or bypasses one of those products' boundaries.
