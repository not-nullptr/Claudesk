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

A session's events are served too: `GET …/sessions/{id}/events` (paged,
`after_sequence_num` resumes), `POST` to append — `{events:[{payload}]}` from the
renderer, a bare `{payload}` from a runner — and `GET …/events/stream`, which
replays the history as `client_event` frames and then tails it. The envelopes are
the store's to number (`event_id`, a positive digit-string `sequence_num`), and
they are held to the app's own contract by `scripts/lib/code-wire-contract.mjs`
in the smokes, not to a hand-written idea of the shape.

`bridge/server.mjs` routes `/v1/code/runners/*`,
`/v1/environment_providers/…/environments[/{id}]` and those two session shapes to
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

The runner's half of the loop is exercised too, without a runner binary:
`scripts/code-runner-client.mjs` speaks the runner's protocol (register, poll,
token, transcript, release) and `scripts/code-runner-loop-smoke.mjs` boots the
bridge, has a runner claim the pool, places a session, runs it and reads the
transcript back under the app's contract. The same client pointed at a live
instance (`--base URL --secret …`) is the diagnostic for whether a tenant's pool
answers and what it offers.

What is left is the **deployment** half, and it needs the box:

1. **Run the runner in the guest.** The guest already carries a `claude` the host
   provides at `/opt/cowork/claude-bin`, so the open questions are whether that
   binary exposes `self-hosted-runner`, whether the guest can reach the bridge
   through its own egress allowlist, and how the VM's idle-stop sits against a
   30 s poll loop. `code-runner-client.mjs` is the reference for what the bridge
   expects of it.
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
