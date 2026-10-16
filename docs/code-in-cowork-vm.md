# Code on a VM-backed runner — Phase 0 recon

Goal: run the Claude Code **agent process** somewhere other than the tenant's
privileged Desktop container, and guarantee a tenant can never start a
container-local Code session. The transport option (the Desktop's SSH session
host) is rejected: it is client-side, so the agent loop stays in the container.

Method: fetched the pinned `.deb` from the signed APT repo and read its bundles.
Nothing was modified.

```bash
curl -O https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.31226.1_amd64.deb
sha256sum claude-desktop_2.31226.1_amd64.deb   # 5a9bebdfcb1df6ce… matches the review doc
dpkg-deb -x claude-desktop_2.31226.1_amd64.deb root
# app.asar: header pickle, data at 8 + headerPickleSize; the JSON does not start
# at offset 12 (a stray byte precedes the BOM), so locate `{"files"` first.
```

## Established

### 1. The SSH session host is present in the pinned build — and is client-side

`sshHostAllowlist` (4 files) and `sshTransport` (14 files) are in this build's
`ion-dist`, so the "needs a newer build" caveat in the plan is wrong. It does not
change the decision: the bundle ships `claude-ssh-askpass` and defaults
`sshTransport` to `builtin` with `openssh-client` as a Recommends, i.e. the app is
an SSH **client**. The agent loop stays local; only tool execution hops out. A
bypass leaves the agent in the container — the thing we must prevent.

### 2. The product already has "run the agent on compute you provide" — BYOC

This is the finding that matters. The Code surface is not limited to the local
machine and claude.ai's cloud; it has a third kind of environment, **self-hosted
(`byoc`)**, with **runner pools**:

- **Endpoints** (`ion-dist`): `GET|POST /v1/code/runners/self-hosted/pools`,
  `/pools/{id}`, `/pools/{id}/secrets`, `/pools/{id}/sessions`, and
  `GET /v1/code/runners/self-hosted/pools/{id}`. The environment list endpoint is
  `/v1/environment_providers/private/organizations/{org}/environments`.
- **Environment kinds** are `anthropic_cloud | byoc | bridge`; the UI groups them
  as *"Self-hosted environments"* (`e.kind!=="byoc"` → hosted,
  `e.kind==="byoc"` → self-hosted) and marks such a session
  `self_hosted_runner`.
- **Admin surface**: `/admin-settings/claude-code` → "Self-hosted infrastructure",
  with "Your runners", **"Install Claude environment runner"**, and the copy
  *"Install the environment runner in your containers with this curl command."*
  The command literal is **`claude self-hosted-runner setup`**.
- **Org policy keys**: *"Allow self-hosted environments"*,
  *"Require self-hosted compute"* ("Members can't start new sessions on them",
  "Turn off “Require self-hosted compute” to change this.").
- **Where it runs**: *"On this install sessions run on your organization's session
  host, not on this computer."* — and a model pick refused because *"the
  self-hosted runner's Claude Code is too old for it"*.
- **Dispatch is user-initiated**: *"nothing runs on the organization's own
  runners without the user's click"* — a session is *proposed* and the user starts
  it from the environment picker ("New session → Cloud"). `start_session` cannot
  start on a pool by itself.
- Wire hints: `anthropic-beta: ccr-byoc-2025-07-29`, `anthropic-client-feature:
  ccr`, `x-ccr-unavailable-reason`, and the check
  `/not a bridge session \(environment_kind=(anthropic_cloud|byoc)\)/`.

### 3. The Code API is same-origin — the bridge can serve it

The renderer fetches these with **relative** URLs (`fetch(\`/v1/code/sessions?…\`)`,
`\`/v1/code/sessions/${id}/terminal\``), so every Code and environment leg is
same-origin: in this deployment that origin is **our bridge**, not claude.ai.
That is the seam the whole plan needs. The endpoints observed:

```
/v1/code/sessions…                     (list/create/detail/terminal/move-to-cloud)
/v1/code/runners/self-hosted/pools[/{id}[/secrets|/sessions]]
/v1/environments
/v1/environment_providers/private/organizations/{org}/environments[/{id}]
/v1/code/environment-repositories
/v1/code/last_used_environment
/v1/code/agent-proxy/environment-credentials/from-request
```

This is also **not new ground for this repo**: `mobile/server.mjs` already
answers `/v1/code/sessions`, `/v1/environment_providers/…/environments`, the
channel/trigger/repo legs and the experiences banner for the phone. The Desktop's
needs are a superset (the pool family), so the translation and routing patterns to
copy already exist in-tree.

### 4. The runner is a self-hosted polling agent, configured by env

The runner is **Claude Code itself**: `claude self-hosted-runner` (`setup`,
`orchestrator`). The CLI native binary carries the whole contract
(`@anthropic-ai/claude-code-linux-x64@2.1.295`, fetched from npm):

```
POST /v1/code/runners/self-hosted/runners/register      register this machine
                                                   /deregister
POST /v1/code/runners/self-hosted/spawn-hints/poll      pull for work (30s timeout)
                                            /nack       decline an attempt
     /v1/code/runners/self-hosted/sessions/…           the session itself
     /v1/code/runners/self-hosted/pools[/{id}[/secrets]]  pools (admin/UI side)
```

- **Pull, not push.** `pollSpawnHints` POSTs to the poll leg; `nackSpawnHint`
  reports a declined attempt with `retryable`/`failure_kind`. Kinds are strings:
  `ccr_v2`, `ccr`, `ccr-byoc-2025-07-29`.
- **Auth is a pool secret** (`poolSecretFile`, sent via the headers helper on
  register and poll) plus a per-session `SESSION_TOKEN`.
- **Everything is env-configured**, so it can be pointed at *our* API base:

  ```
  CLAUDE_RUNNER_API_BASE_URL     the base to register/poll against
  CLAUDE_RUNNER_POOL_ID          which pool this runner serves
  CLAUDE_RUNNER_CLAUDE_BIN       the `claude` to spawn
  CLAUDE_RUNNER_CHECKOUT_PATH    where the session's checkout lives
  CLAUDE_RUNNER_GIT_MOUNT_URL    how the repo is fetched
  SELF_HOSTED_RUNNER_HOOKS_DIR   lifecycle hooks (checkout/command behavior)
  CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
  ```

- **Lifecycle hooks and an "orchestrator" mode** provision runners
  (`SELF_HOSTED_RUNNER_HOOKS_DIR` overrides the built-in checkout/command
  behavior; `docs/self-hosted-runners-guide.md` is referenced from the binary),
  and there is a version gate — a session is refused because "the self-hosted
  runner's Claude Code is too old for it".

That last point is the whole answer: a runner pointed at `CLAUDE_RUNNER_API_BASE_URL`
we control, with a pool secret we mint, needs nothing from Anthropic's cloud — and
the **agent runs on the runner**, not in the Desktop container.

### 5. The guest is a real VM that already carries Claude Code

`resources/smol-bin.x64.img` (28 MiB, FAT32, `!SDK_DAEMON`) is not a stub. Its
strings show a full Linux guest:

- **Claude Code is already there**: `/opt/cowork/claude-bin` and
  `/opt/cowork/cli-wrapper`, with `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_TMPDIR`,
  `COWORKD_DEBUG`, and `AskClaude` — plus `getRunner`/`putRunner`.
- **It runs systemd and installs things**: `install.sh`'s "systemd unit",
  `runner_unavailable: systemd did not answer within …`, `srt-settings` (sandbox
  runtime settings), and the EDR-integration payload path.
- **It has an egress allowlist of its own** (`claude.com`, `frame.claudeusercontent.com`,
  `files.pythonhosted.org`, `8.8.8.8:80`, …) — relevant once a runner polls our
  bridge from inside the guest.

So the guest can plausibly host the runner itself, with the agent and its tool
execution inside the VM — the placement the plan wants, rather than a sidecar.

### Implication for the plan

This is Option 1, and it is a **shipped product mechanism**, not invention. A
runner we host executes the session's Claude Code, so the agent process is on the
runner — which is what "properly inside the VM" needs. The design question is no
longer "which mechanism", but "where does the runner live" and "how much of the
pool/runner contract we implement".

## Open — the rest of the spike

1. **Runner placement (narrowed).** The guest already carries Claude Code and
   runs systemd (§5), so it is the natural host — but confirm on the box that the
   bundled `claude` supports the `self-hosted-runner` subcommand, that the guest
   can reach our bridge (its egress allowlist is its own, and `/workspace` is
   shared in over virtiofs for `CLAUDE_RUNNER_CHECKOUT_PATH`), and how the VM's
   idle-stop interacts with the runner's 30s poll loop. The fallback is a
   dedicated **unprivileged** sidecar — off the privileged container, but not
   literally "in the VM".
2. ~~Who serves the pool API.~~ **Settled (see Established §3):** these legs are
   same-origin, so the bridge serves them. What remains is *how much* of the
   contract to implement — the pool CRUD and secrets reads are UI-shaped and can
   be answered from a local store; the hard part is whatever the runner itself
   talks to.
3. ~~Runner protocol and availability.~~ **Settled for the protocol (see §4).**
   Still open: the CLI is a native binary fetched from npm
   (`@anthropic-ai/claude-code-linux-x64`), and the `.deb` does not obviously ship
   it, so how the image gets a runner-capable `claude` offline needs deciding
   (pin the npm tarball at build time, or use the CLI the Desktop already
   installs at runtime).
4. **Policy synthesis.** The org policy keys ("Allow/Require self-hosted
   environments") must be answered by the bridge's bootstrap for a self-hosted
   org, and the admin surface exists only where those are on.
5. **Session start path.** Sessions on a pool are user-initiated from the
   environment picker; check how that interacts with the mobile facade and with
   the web shell's Code routes.

## Reproduce

```bash
# in the checkout used for the fetch
grep -rhoE '.{120}self-hosted-runner.{120}' root/usr/lib/claude-desktop/resources/ion-dist/assets/v1/*.js
grep -rhoE '.{80}runners/self-hosted.{200}'   root/usr/lib/claude-desktop/resources/ion-dist/assets/v1/*.js | head
grep -rhoE '.{140}(pool|runner).{180}'        root/usr/lib/claude-desktop/resources/ion-dist/assets/v1/*.js | grep -iE 'token|install|setup'
```

## Not proposed here

No fix for items 1–5 yet; they are the remainder of Phase 0. The decision rule
from the plan stands: Option 1 if the pool path can be locked so no session can
run locally; otherwise the bridge-side shim (Option 2).
