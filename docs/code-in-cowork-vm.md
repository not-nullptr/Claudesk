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

- **Claude Code is expected at `/opt/cowork/claude-bin`** (with
  `/opt/cowork/cli-wrapper`), alongside `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_TMPDIR`,
  `COWORKD_DEBUG`, `AskClaude` and `getRunner`/`putRunner`. The image itself
  carries **no** `self-hosted-runner` strings, so that path is *provided from
  outside the image* — i.e. the guest runs a `claude` the host supplies, most
  likely the Desktop's own Claude Code (2.1.295), which does carry the runner.
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

## Built so far

**Phase 1 — the guarantee (landed).** An account's instance is marked
`CLAUDESK_TENANT=1` by `scripts/provision-user.sh`; `bridge/server.mjs` folds
that into `codeActionsEnabled`, which is what installs the `LocalSessions`
method and listener allowlists and the AppPreferences settings surface, so a
tenant cannot reach the container-local executor however
`CLAUDE_REMOTE_CODE_ACTIONS` is set (a misconfiguration is reported, not
served). `/api/health` says `tenant: true` so a peer can tell "Code is off here"
from "this is a tenant". The container init writes the app's Code flag off to
match. `scripts/tenant-code-guard-smoke.mjs` pins all of it.

**Phase 2 — the runner substrate (landed).** `bridge/code-runners.mjs` holds a
per-instance store of pools, runners and sessions and answers both sides of the
self-hosted pool API: the runner's legs (`runners/register`, `deregister`,
`spawn-hints/poll`, `spawn-hints/nack`, secret-authenticated) and the admin UI's
(`pools` CRUD, `secrets` by id, `sessions`). A pool is advertised to the Code
surface as a `byoc` environment (`poolEnvironment`). `POST /v1/code/sessions`
places a session on one of the instance's pools — the create body is the Desktop
main process's own shape, not a guess — and that is what hands it to the runners,
so the chain closes at the bridge: create → the pool's runner is offered it →
`…/sessions/{id}/token` → `report-failure`/`release`. Anything that is not one of
this instance's pools is refused rather than quietly run locally, because there
is no local executor here to run it.

**Two flags, not one.** `CLAUDE_REMOTE_CODE_ACTIONS` is about this container's
*executor*; the app config's `isClaudeCodeForDesktopEnabled` is about whether the
Code *surface* exists at all. On a tenant the first is off and the second is on,
and conflating them is what hid the titlebar's Claude/Code switcher: with no Code
in the app's model the segment is disabled and the `titlebar-mode-picker-without-code`
patch — doing exactly what it was written to do — removes the control. So

- the container init writes the surface from `CLAUDESK_CODE_RUNNERS` on a tenant
  (and from the executor flag elsewhere), and
- the bridge reports `codeSurfaceEnabled` beside `codeActionsEnabled` in the
  bootstrap, so the preload paints the switcher before the app mounts
  (`remote-shell.css` hides it only when neither is set).

`codeReady` stays false on a tenant, because that one is about the executor.

The Code *surface* itself is declared to the renderer: a tenant's access document
carries `claude_code_web` as available — the entry the Code UI reads, and the one
the mobile facade declares for the phone — so the pill exists and the surface
opens, on a tenant only. The operator's own instance keeps whatever upstream said
about it, and an entry that is already there (`blocked_by_*` included) is never
overridden.

A session's events are served too: `GET …/sessions/{id}/events` (paged,
`after_sequence_num` resumes), `POST` to append — `{events:[{payload}]}` from the
renderer, a bare `{payload}` from a runner — and `GET …/events/stream`, which
replays the history as `client_event` frames (each frame's `id:` is its
`sequence_num` — the cursor the reader resumes by, via `Last-Event-ID` or
`from_sequence_num`) and then tails it with `session_update` frames carrying the
connection state. The envelopes are the store's to number (`event_id`, a
positive digit-string `sequence_num`), and they are held to the app's own
contract by `scripts/lib/code-wire-contract.mjs` in the smokes, not to a
hand-written idea of the shape. Whether the page *uses* that stream is itself
gated: the session view reads `ccr_v2_subscribe_sse_web` and falls back to a
WebSocket subscribe this bridge does not speak when it is off — drawing history
from one-shot reads and never streaming — so the bridge grants the gate for a
tenant (`grantCcrSubscribeSse`). A stream whose session does not exist yet opens
empty rather than 404ing (that 404 is the "Connecting" loop), and a `result`
message written back by the runner is the turn terminal the reader closes a
turn on. Envelopes carry `source` — `client` for the renderer's own writes,
`worker` for the runner's (a user-shaped frame is dropped downstream unless it
is `worker`, so tool results never read as human messages) — and a client
message is stamped `processing_at` when a runner takes the session, at which
point the stream carries the `delivery_update {event_id, status, timestamp}`
frame the page clears its "Sending…" state on (the same frame releases the held
echo of the message into the transcript).

`bridge/server.mjs` routes `/v1/code/runners/*`, both environments legs —
`…/environment_providers/private/organizations/{org}/environments[/{id}]` (the
Cloud-environments page) and `/v1/environments[/{id}]`, which is where the *new
session* sheet reads its places from, beside the pools query — and those two
session shapes to
it, but only for a tenant with `CLAUDESK_CODE_RUNNERS=1`, so nothing is routed
until a deployment turns it on. `scripts/code-runners-smoke.mjs` drives the
backend directly, and `scripts/code-runners-http-smoke.mjs` drives the whole
thing over the bridge's real HTTP surface — twice, once as a tenant and once as
the deployment's own instance, which must serve none of it.

The environment list is the guarantee stated where the choice is made: a
tenant's list is its self-hosted pools and **nothing else**, so the Code UI has
no local place to offer. The IPC guard (Phase 1) and the environment list say
the same thing to the two layers that could independently enable a session.

It is also *earned*: a pool is advertised only once a runner has registered with
it. The bridge mints the pool at start-up, before anything can run on it, and
offering it then would let a session be placed where nothing is polling — pending
forever, which reads as broken rather than unconfigured. So the surface starts
empty and gains the place when a runner arrives, and this is what makes turning
`CLAUDESK_CODE_RUNNERS` on ahead of the runner harmless.

**Phase 2 — the tenant renderer generation (landed).** `tenantEnabled` is a third
input to `patchRendererSources` alongside gateway and web shell: when set, the
`desktop-code-route-alias` patch is withheld (and dropped from the required set,
because withholding it is the intent) so `/code` resolves to the self-hosted
surface instead of the local one. It reaches `prepare-renderer.mjs` (the
generation key includes it, so a tenant and the operator's instance never adopt
each other's renderer), the inspection worker, and `scripts/seed-renderer.sh`'s
combinations (the deployment's own instance plus each account role, as a tenant).
`config/release.json`'s `patchRelease` is bumped per the rule that a patcher
change ships with it, so a `claude-desktop` rebuild is needed to roll it out.

## How anything reaches into the guest

Answered from the two binaries, without the box:

- **There is no TCP path in.** The helper launches qemu with
  `virtio-net-pci,netdev=net0` / `user,id=net0` (user-mode networking) and no
  `hostfwd` string anywhere, so nothing in the container can dial the guest.
- **The inbound channel is a virtiofs share**, and there is exactly one:
  `vhost-user-fs-pci,chardev=virtiofs0,tag=claudeshared`, served by a
  `virtiofsd --shared-dir <host path>` (`virtiofsd-%d.sock`). The guest mounts it
  — `[coworkd] mount virtiofs claudeshared at %s` — and runs the Claude Code the
  host puts there (`/opt/cowork/claude-bin`, `/opt/cowork/cli-wrapper`).
- **The guest has a script runner.** Its `coworkd` carries a whole `install.sh`
  path: it makes the script executable, writes a systemd unit for it, starts it
  (`--no-block`, `OOMScoreAdjust=500`, `UMask=0022`, `DEBIAN_FRONTEND=noninteractive`,
  `HOME=/root`), writes `install.log`, and reports back `ActiveState` /
  `ExecMainStatus` — with its own failure vocabulary (`install.sh was not
  started`, `install.sh's systemd unit already exists`, `runner_unavailable:
  systemd did not answer within %s`). The same machinery is what the
  `edrIntegration` payload path drives.

So "run a runner in the guest" does not need SSH, a forwarded port or a nested
Desktop: **the guest already runs things for the host, and the way in is a file +
an install step.** It is why the runner client (`scripts/code-runner-client.mjs
--exec`) is written as a self-contained script a unit in the guest can run.

### The two ways to drive it

- **The product's own knob is `coworkEDRIntegration`** — a managed-settings key
  (`flatKey: "coworkEDRIntegration"`, category `sandbox`, "EDR Integration
  package path", hidden from the UI) naming a *package* the Desktop copies,
  verifies, unpacks and runs in the guest. Its state machine is
  `copying → verifying → unpacking → running → succeeded | refused | failed`,
  and it records `vendor`, `packageSha256`, `vendorVerified`, `signatureExpires`
  and `exitCode`. **It only runs a package signed by a vendor whose certificate
  it already trusts** (`vendor key %q: the same certificate is already listed as
  %q under another fingerprint`), and that check is deliberate — it is code that
  runs in the guest. This deployment should not be in the business of defeating
  it.
- **The route that is ours: the guest image.** The repo already patches
  `rootfs.img` (the vsock port), so a unit that starts the runner at boot —
  reading its pool id, secret and base URL from the `claudeshared` share the host
  already provides — is the same kind of change, with the same cost: the guest
  image is rebuilt every Desktop release, so the patch is re-derived like the
  vsock one.

The second is what the plan should do. What still needs the box is whether the
host side can put the script and its environment into that share (the helper
builds `-shared-dir` from what the Desktop passes) and whether the guest can
reach the bridge on its own egress allowlist.

## Operating it

Point a runner at the tenant's instance:

```bash
# On the tenant's instance (CLAUDESK_TENANT=1, CLAUDESK_CODE_RUNNERS=1), the
# pool exists as soon as the bridge starts; its id and secret are in the state
# file, and the secret is also readable by pool id over the proxy (it is a blind
# write/read: the list never carries it).
cat /data/code-runners.json            # inside the bridge container
GET /v1/code/runners/self-hosted/pools/{pool_id}/secrets
```

The runner is Claude Code, so what it needs is its own environment:

```
CLAUDE_RUNNER_API_BASE_URL   this instance's origin (the bridge answers /v1/…)
CLAUDE_RUNNER_POOL_ID        the pool id above
SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET   the pool secret (or --environment-secret-file)
CLAUDE_RUNNER_CLAUDE_BIN     the claude to spawn
CLAUDE_RUNNER_CHECKOUT_PATH  where the session's checkout lives
```

It registers once (`runners/register`), then polls `spawn-hints/poll` on a 30 s
timeout. `/api/health` reports `tenant: true` and the `codeRunnerPool` it
expects, so a runner pointed at the wrong instance is visible rather than
silently idle.

## What the next increment needs

Extracted while building the substrate, so it does not have to be re-read:

- **A pool id is `ccpool_`-prefixed, and the renderer keys off that.** It decides
  whether a session is self-hosted by
  `id.startsWith("ccpool_") || environments?.find(e => e.environment_id === id)?.kind !== "byoc"`,
  which is why `bridge/code-runners.mjs` mints `ccpool_…` ids.
- **Environments carry `environment_id`, `default_environment_id` and the pool
  relation**; the org's default is set through the environment-provider surface,
  so a tenant's default environment is how the self-hosted place becomes the one
  a new session lands on without the user picking it.
- **The runner's session legs** (all `POST /v1/code/runners/self-hosted/sessions/{id}/…`,
  authenticated by the session token or the pool secret): `token` → `{session_token}`,
  `report-failure` (`{reason, setup_failure_kind?, failure_kind?}` →
  `{excluded_count, stuck}`), `release`, and `retry-spawn` (the operator's
  Activity → Retry). The poll response also carries `available_capacity`,
  `wake_source`, `warmup_complete`, `assignment_ids`, `lease_expires_at`,
  `suggested_poll_interval` and `session_assignments`; the session itself then
  runs against `/v2/ccr-sessions/{id}/…` (e.g. `/mcp`) alongside the
  `/v1/code/sessions/{id}/…` legs above. All are answered by
  `bridge/code-runners.mjs` except the session's own traffic, which is the next
  increment.
- **Session create, settled from the Desktop main process's own bundle**
  (`[TeleportToCloud] createCloudSession`, readable there where the renderer's
  is not):

  ```
  POST /v1/code/sessions          (or /v1/sessions when gate 133902057 is off)
  headers: content-type, anthropic-version 2023-06-01,
           anthropic-beta ccr-byoc-2025-07-29, anthropic-client-feature ccr,
           x-organization-uuid <org>
  body: {
    title?,                         only when the session has one
    environment_id: <uuid>,         the environment to run in
    config: { sources: [...], outcomes?: [...], model?: string }
  }                                 (that build); the older arm sends
                                    `session_context` instead of `config`
  sources/outcomes entries: { type: "git_repository", url, revision }
                            { type: "git_repository", git_info: { type: "github", repo, branches } }
  -> { session: { id, title } }     (that build)  |  { id, title }  (older)
  ```
- **Session-create is the one leg whose shape is *not* guessed**: it comes from
  that bundle. The renderer's own (minified) transform is still unresolved, and
  the helper names collide across chunks, so a renderer-side change there needs
  a runtime trace rather than a grep.
- **Session-scoped legs already seen** (all `POST /v1/code/sessions/{id}/…`):
  `events` (the renderer posting its own client events), `archive`, `share`,
  `support-share`, `debug-export`, `move-to-cloud`, `files` (with a device
  attestation header) and `worker/register` (`Authorization: Bearer
  <session token>` → `{worker_epoch, …}`); `GET …/terminal` (or
  `/v2/ccr-sessions/{id}/terminal` under the `ccr_v2_terminal_ws_web` gate).
- **The event stream's remaining depth.** The bridge now answers the stream in
  the envelope contract the app's own reader is pinned to, but the Desktop *main
  process* runs a richer model on top of it: `index.chunk-DcP6Ha83.js` tracks
  `client_events` and `internal_events` separately, with tool-call rows, lanes,
  hold policies and gates, and its SSE transport also sends a keepalive-interval
  and a worker-attestation-policy parameter. What it does with frames this bridge
  does not model (tool-call row lifecycles, holds) is what a live Desktop would
  show, and it is the first thing to check on the box.

  That is deliberate on the bridge's side: it stores and streams whatever the
  runner writes rather than interpreting it, so the Desktop's own model is the
  only one that has to be right. A frame this bridge does not understand is
  carried, not dropped — which is also why the tail polls the store instead of
  filtering on anything.
- **Still unknown:** the renderer's own create transform (see above), and the
  exact internal-event shapes the main process expects on that stream.

## Where this stands

The bridge side is complete and tested: a tenant's Code can be offered only its
self-hosted places, a session can be placed on one and handed to that pool's
runner, and its events can be written and read (including the stream). Phase 3 is
in — accounts answer the pool API by default and are offered no place until a
runner registers, which is what makes that default safe.

The runner's half of the loop is exercised too, without a Claude Code binary:
`scripts/code-runner-client.mjs` speaks the runner's protocol (register, poll,
session token, transcript, release) and, with `--exec`, *runs an agent* for each
session — it reads the prompt out of the session's own events, spawns
`CLAUDE_RUNNER_CLAUDE_BIN` (`claude --print`) on it, writes the output back as
assistant messages, and then releases the session or reports the failure.
`scripts/code-runner-loop-smoke.mjs` boots the bridge, has a runner claim the
pool, places a session, runs a **stub binary** in the agent's place, and reads
the transcript back under the app's contract — including the failure path, where
an agent that exits non-zero leaves the session `failed` rather than released.

The same client pointed at a live instance (`--base URL --secret …`) is the
diagnostic for whether a tenant's pool answers and what it offers, and with
`--exec` it is a working runner — the only thing the box adds is the real
`claude` and a checkout to run it in.

**The runner in the guest (landed).** `guest/runner.py` is the guest-side
service: stdlib-only (the guest is a stock Ubuntu image and this must not add
dependencies), it registers with the pool, polls, takes each offered session,
reads the prompt out of the session's events, runs Claude Code on it inside the
VM, writes the transcript back and releases it — or reports the failure. The
bridge side of that protocol is pinned by `scripts/guest-runner-smoke.mjs`, which
boots the bridge and drives the runner against it with a stub agent in the
Claude Code binary's place.

`scripts/install-guest-runner.sh EMAIL` puts it into an account's guest, the way
the section above concludes it has to be done — a unit in the guest image. It
attaches `rootfs.img`, mounts the ext4 labelled `cloudimg-rootfs` (the label the
guest's own micro-init boots by, so the injection point is the guest's real
root), and writes `/opt/claudesk/runner.py`, `/etc/claudesk/runner.env` and a
`claudesk-code-runner.service` that starts it. Run it with the VM stopped; the
image is rebuilt every Desktop release, so it is re-derived on an update exactly
like the vsock-port patch, and it is stamped so a re-run with the same payload
and pool is a no-op. `deploy.sh` runs it for every provisioned account after
the images are current, so a runner change cannot be half-deployed — the
containers current while every VM keeps the previous runner — which is a
mistake this payload has already seen.

This bakes the payload in rather than reading it from the `claudeshared` share,
because it does not depend on the still-open question of whether the host can
write that share's directory. Once that is answered, the env — and the runner
with it — can move there, leaving only the unit to re-derive on a release; the
unit reads its environment from a file, so nothing else about it changes.

The bridge address the guest dials follows from the network answer above: QEMU
runs with `-netdev user,id=net0` (slirp) and no `hostfwd`, so the runner reaches
the container at **`http://10.0.2.2:8080`** — the slirp gateway, where the bridge
already listens on every interface. Nothing can dial *into* the guest, which is
the other half of why the unit has to live in the image. A deployment that
restricts guest egress must allow that address
(`CLAUDE_EGRESS_ALLOWED_HOSTS_JSON`).

What is left is the **deployment** half, and it needs the box:

1. **Install it on a real account and watch it run** *(answered on the box)*.
   `/opt/cowork/claude-bin` is a **directory** — the agent the product runs is
   `claude` inside it, staged by the guest's own `coworkd` (the daemon copies
   the SDK binary the host puts on the `claudeshared` share; the share itself
   is noexec). A runner pointed at the bare directory gets `[Errno 13]
   Permission denied` on execve — execve on a directory is EACCES — so
   `guest/runner.py` resolves either form (directory → `claude` inside). But
   **every product claude is cowork-flavoured and talks to coworkd instead of
   answering**: the guest's staged binary refuses outside a session (`claude:
   no session for this uid`) and accepts exactly `claude -p "<prompt>"`, and
   the Desktop container's own copy forwards the prompt into the guest's
   ask-claude socket (`claude: send: write unix @->/run/coworkd/ask-claude.sock:
   write: broken pipe`). Nothing about the product is modified for this — the
   installer stages a **plain upstream Claude Code** instead (found in the
   container when one is there, else fetched once from the pinned npm artifact
   into the account's data root), carries the account's model endpoint and key
   into the guest's root-only `runner.env` (loopback rewritten to `10.0.2.2`),
   and the runner asks the agent the way the product's own runner asks its
   child — read from the shipped binary: `--print`, `--input-format
   stream-json` / `--output-format stream-json`, `--verbose`,
   `--include-partial-messages`, the session's model and permission mode, and
   `--resume` for later turns — minus `--sdk-url`, which the compiled binary
   reserves for Anthropic's own hosts. The prompt is a stream-json user message
   on the agent's stdin, never an argument (so the agent is never started
   "without a prompt"); the runner's idle poll of the pool is held open
   (`x-claudesk-poll-wait`), and a placement or a requeue wakes it on that same
   request — the guest cannot be dialled (nothing is forwarded into the VM), so
   event-driven delivery is a held request rather than a push socket, and
   pickup is immediate (tens of milliseconds) instead of on a tick; every
   assistant message, tool result, partial update
   and the turn's own `result` message — the terminal the reader closes a turn
   on, so a turn never stays pending — lands in the transcript as its own event
   the moment the agent emits it (text streams, and tool calls render as the
   tool rows they are); stderr stays out
   of the transcript; and the conversation id the agent stamps on its own
   events is what a follow-up message resumes, so a session keeps its memory
   across turns even though each turn is a fresh process — and a message that
   lands after a turn released the session re-queues it on its pool, the same
   as the first placement, so the conversation continues rather than ending
   with the turn. The agent answers
   through the **bridge** — its model calls ride `/v1/messages`, forwarded by
   the bridge to the account's gateway with the account's credentials — because
   the guest's egress allowlist makes dialing the gateway directly from inside
   the VM unreliable (a blocked call hangs rather than failing). Remaining: a
   real end-to-end run through that chain, and whether the host can write the
   `claudeshared` share — if it can, the payload should move out of the image
   and only the unit need re-deriving per release.
2. **Check the main process's richer expectations.** It tracks client and
   internal events separately, with tool-call rows, lanes and hold policies on
   top of the envelope contract this bridge answers. A live Desktop shows what it
   does with frames this bridge does not model.
3. **The renderer's own create transform** is still minified beyond a static
   trace; a runtime trace settles it if the main process's shape above turns out
   not to be what the renderer sends.

Per-account **mobile** Code is a separate piece of work, not a gap here: the
facade is one-per-deployment and accounts run no `claude-mobile` container, so it
needs a facade per account (its own port, login and proxy entry).

### Why the places menu stayed Local-only (found)

The first live attempts showed the right things everywhere except the browser's
place menu: the bootstrap carried the entitlements, both environments legs and
the pools API answered the byoc pool with `state: "active"`, and a session could
be placed and handed to the guest runner — yet the composer still offered Local
and nothing else. The gate was one module flag in the renderer, and it does not
read any access document:

- `shared-50`'s `RM` sets the flag (shared-0's `yL`) from
  **`appFeatures.selfHostedSessions.status === "supported"`**. `yL` is the
  `remoteSessionsAllowed` every session-target read starts from
  (`c593f7513`'s `af`: `k = R() && …`), the first term of the environment-list
  filter (`kK`'s `envsByKind`: `if (!E) return { bridges: [], cloud: [] }`) and
  of the pools query's `enabled` (`be = IS() && E`).
- `appFeatures` starts as `window.desktopBootFeatures` (`shared-50`'s `IM`) and,
  in a browser, is never resampled — the async refresher calls
  `claude.settings.AppFeatures.getSupportedFeatures`, a native surface the
  remote preload does not shim (only AppPreferences, Custom3pSetup and
  Custom3pHelperRun are).
- That table is relayed here: `bridge/server.mjs` → `remote-preload.js` →
  `globalThis.desktopBootFeatures`, and it originates in the Desktop wrapper's
  `/boot-features`, whose `relayedBootFeatures` whitelist carries only
  `chatIn3p`, `chatTab`, `desktopHome`, `yukonSilver` (+ the code-actions set).
  `selfHostedSessions` is not in it.

So on every page load the flag was false, `envsByKind` returned empty lists
whatever the endpoints said, and the composer's menu was Local-only by
construction — which is why none of the bootstrap-side grants (however correct)
could change it. A tenant with runners now declares
`selfHostedSessions: {status: "supported"}` in that table
(`withSelfHostedSessions` in `bridge/server.mjs`, over the relayed table, since
on such a tenant sessions genuinely do run on its own infrastructure); the
operator's own instance keeps exactly what the wrapper relayed.

### The session surface the app calls

With the menu open, a session page is what exercises the API next, so the whole
surface a Code session touches is replicated here — read out of the renderer's
own readers (`shared-100`'s session module) and the Desktop main's custom-3p
stubs, then pinned by `code-runners-smoke` and `code-runners-http-smoke`:

| Call | Shape (what the client sends / requires back) |
| --- | --- |
| `GET …/environment_providers/private/organizations/{org}/capabilities` | The org's environment-capabilities document the composer reads wherever a session can be placed — repositories, file transports (`session_files`), push/PRs (`vcs`), web fetch, stores. Its reader parses strictly: `version` and `repositories` are required and `absent`/`unreadable` are read unconditionally; fields left out are treated as *unknown*, not as *no*. This deployment claims only what is true (no repositories, both file transports) and omits the rest. |
| `POST /v1/code/sessions` | `{title?, environment_id? \| self_hosted_runner_pool_id?, config:{sources, outcomes?, model?, …}, events?: [{payload}], tags?}`. A pool worker names its place with `self_hosted_runner_pool_id`; an environment worker with `environment_id`. The answer is `{session}` (the client's `CD`). |
| `GET /v1/code/sessions` | The list; the sidebar's call carries `statuses=active&statuses=paused`, which is how archived sessions drop out. Rows are the same session document. |
| `GET/PUT/DELETE /v1/code/sessions/{id}` | GET reads, PUT is the one edit endpoint (`{title?}`, `{add_tags?}`/`{remove_tags?}`, `{client_metadata?}`), DELETE removes. Each answers `{session}`. |
| `POST …/{id}/archive`, `…/mark_read` | The page's buttons; archive is its own axis (log and place stay, the list filter above stops carrying it). `{session}` back. |
| `PUT …/{id}/mcp-servers` | The MCP editor's save, `{mcp_servers: […]}`. |
| `POST …/{id}/events`, `GET …/events`, `GET …/events/stream` | The transcript — the renderer posts `{events:[{payload}]}` (the user's message is `payload.type === "user"`, `payload.message`), the runner writes single envelopes, the stream replays with `from_sequence_num`. Answered under **both generations of the path**: `ccr_v2_send_events_web` decides whether the client posts to `/v1/code/sessions/{id}/events` or the original `/v1/sessions/{id}/events`, and the Desktop build's hardcoded feature table carries the gate false — so the original leg is the one the browser actually sends its first message over. |
| `POST /v1/code/sessions/heartbeat_check` | The list's liveness probe; answered `{results: [], checks_enabled: false}` — the protocol's own way of saying this deployment does not check, so the client stops asking instead of treating silence as broken sessions. |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | The runner's model calls, forwarded by the bridge to the account's gateway with the account's own credentials. The guest's egress is its own allowlist, so dialing the gateway from inside the VM is not reliable (a blocked call hangs rather than failing) — the bridge is the one address the guest provably reaches. The pool secret is the pass; the streamed answer passes back untouched, and the request body is normalized for the chain: the newest fields the provider would reject without their beta headers (`context_management`, `thinking.display`) are dropped here, one log line per request that needed it, rather than pinning the CLI to the chain's vintage. |
| `GET /v1/code/sessions/watch` | The list's SSE stream. Its reader treats 400/404 as **fatal for the whole surface**, so it is held open and quiet (a comment frame, keepalives) rather than 404ed. |
| `POST /api/organizations/{org}/dust/generate_title_and_branch` | `{first_session_message, title_style, model?}` → `{title, branch_name?}`. The Desktop main answers this in-process with an on-device model; a browser fetches its own origin, so the bridge derives the title (first meaningful line, cleaned, capped) and the branch (its slug). `generate_session_title` (`{title}`) and `command_display_names` (`{results: []}`) are served the same way. |

**The session document.** The renderer normalizes every session through its own
parser, which folds the wire `status`/`worker_status`/`connection_status`
triple into what the UI paints: `active` + no worker status = **pending**,
`active` + `running`/`connected` = running, `active` + `idle` = idle,
`archived` passes through. There is no displayed "failed" — a failed run is an
idle session whose transcript says why (the pool's admin list still records
`state: "failed"`). The store's states are the runner's vocabulary
(pending → offered → active → released/failed) and the app's spelling is
derived at serialization (`sessionDocument` in `bridge/code-runners.mjs`)
rather than stored twice.

**The id is part of the shape.** The app classifies a session id by its prefix
— `session_`/`cse_` is a code session, and a bare uuid (or anything else) reads
as a *local* one — and every code-session reader answers "not found" for an id
it does not classify, starting with the meta fetch that renders "This session
couldn't be found" before the bridge is even asked. Wire ids are therefore
`cse_<32 hex>` (the app's id shape takes `[A-Za-z0-9_]`, no dashes), its
display form `session_<suffix>` resolves the same way, and sessions the store
held before the prefix are migrated at load while still answering their old
bare uuid — every lookup compares canonical forms (`sessionById`).

**The pool-wait state rides the same document.** `self_hosted_runner_state`
carries `pool_name`, and `assigned_runner_label` once a runner has taken the
session — the page's pool-wait card ("Waiting for a runner…") shows while the
session is `pending` (which the document's `status: "active"` + absent
`worker_status` means to the reader) and clears on that label plus transcript
rows, so both spend exactly as long as the truth warrants: the label appears
when the runner claims the session at `…/{id}/token`, nothing before.

Deliberately **not** answered (they 404 and are logged as unhandled Code
requests): the share/support-share links, `/v1/code/github/*` branch-status
reads, and the adjacent product areas the surface links to but this deployment
does not run — triggers, agents, channels, spaces, project templates,
`agent-proxy`, PR-steward, approvals and org memory. None is on a session's
normal path; each is its own feature.

One rule holds those 404s together, and it is worth stating on its own: **an
API-shaped path (`/v1/…`) this bridge does not answer is answered with the
API's own JSON envelope, never the app's HTML.** The catch-all that serves
index.html for document routes used to take API paths too, and a client that
reads JSON classifies a 200-of-HTML as an edge/upstream failure — the
composer's "Service temporarily unreachable". A missing route should look like
a missing route.

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
