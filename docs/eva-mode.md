# Eva Mode

Eva Mode is the multi-user shape of this fork: **main is Eva**, authentication is
first-class, and every user gets their own light Claude Desktop instance. The
single-user deployment ("Maddie Mode") lives on the `maddie` branch.

- **Surface:** the unified upstream home (Chat merged into Cowork) with **Code
  fully disabled**. Not a separate "chat + cowork" pair — internally it is one
  Cowork surface with the merge flags on.
- **Auth:** the `authd` service owns users, sessions and invites. It is a plain
  component — it never touches a container runtime.
- **Instances:** one per account. Creating an account provisions its instance via
  a host-side reconciler, so the app itself never holds a container-runtime
  socket. (Currently a compose project per account; Stage 2 moves that to
  systemd units.)

## Stage 1 — the auth layer (shippable on its own)

### Configure

In `.env`:

```dotenv
# First admin. While no admin exists, authd creates this account on startup and
# prints its one-time invite link to the log exactly once. Clear it afterwards.
AUTH_BOOTSTRAP_ADMIN_EMAIL=you@example.com

# Cookie is Secure by default; the entry is HTTPS via the reverse proxy.
AUTH_COOKIE_SECURE=1

# The bridge resolves the signed-in user per request so the sidebar and greeting
# read as that person (see "Identity" below).
AUTH_IDENTITY_URL=http://authd:8080
```

Create the state directory writable by `PUID:PGID` — note `PUID`/`PGID` are
`.env` values, not shell variables, so source it first:

```bash
set -a; . ./.env; set +a
sudo install -d -o "$PUID" -g "$PGID" "${CLAUDESK_DATA_ROOT:-/opt/claudesk/data}/auth-data"
```

Running a **second** deployment on the same host (a v2 checkout beside the
production one) also needs the deployment-identity vars, so the two never share
data, container names or state — see [Two deployments on one box](#two-deployments-on-one-box).

### Build and start

The gateway chain is box-level and started once per host, on its own:

```bash
sudo docker compose -f compose.gateway.yaml up -d
```

Then this deployment:

```bash
./scripts/prepare-seccomp.sh
sudo docker compose -f compose.yaml build authd
sudo docker compose -f compose.yaml up -d authd
sudo docker compose logs "${CLAUDESK_NAME_PREFIX:-}claude-authd" | grep 'bootstrap admin invite'
```

Open the printed `/accept-invite?token=…` link, set your name and a password, and
you land in `/admin`. From there, **Create a user** takes just an email and a role
and returns a one-time invite link (shown once) — send it to them; they set their
own first name, API key, password and (optionally) profile photo, and their browser
timezone is captured then. The name, photo and API key are theirs: the admin only
picks email + role at creation, though an admin can still correct them afterwards.

### Each account spends its own API key

By default every account's inference leaves the box under one upstream credential.
To bill each account to their own key, authd holds two secrets per account: the
**upstream API key** they supply when they accept the invite (required) and an
opaque **gateway key** authd mints and `scripts/provision-user.sh` writes into the
instance as `CLAUDE_GATEWAY_API_KEY`. The instance sends that gateway key to the box
gateway, which asks authd (the internal, secret-gated route `/internal/gateway/resolve`)
for the account's own upstream key and uses it upstream. An account authd knows but
that has no key set is refused, never falling back to the operator's key.

The fallback is per-*caller*, not global: a caller authd does not recognise — a
different deployment sharing the same gateway, or any non-account client — keeps
using the static `UPSTREAM_API_KEY`, exactly as before. So a shared box running
this multi-user deployment beside another (for example a single-user build) serves
both: this deployment's accounts on their own keys, everyone else on the shared
one. That also means `UPSTREAM_API_KEY` must stay set for the other callers. See
the shitproxy README's "Per-request credential resolution" for the exact contract.

This needs these host-side pieces:

- `AUTH_GATEWAY_SECRET` in this deployment's `.env` (see `.env.example`).
- shitproxy's `/etc/shitproxy/gateway.env`: `UPSTREAM_KEY_RESOLVER_URL=http://authd:8080/internal/gateway/resolve`
  and `GATEWAY_RESOLVER_SECRET` set to the same secret. Keep `UPSTREAM_API_KEY`
  for the callers this deployment does not own. `compose.gateway.yaml` already puts
  shitproxy on `gateway_net` so that name resolves; re-run
  `docker compose -f compose.gateway.yaml up -d` after pulling.
- the box gateway's Caddyfile (`/etc/litellm/Caddyfile`): on the route(s) into
  shitproxy, stop overwriting `X-Api-Key` with the shared credential, so the
  account's gateway key reaches shitproxy intact; any route that goes straight to
  the router must be moved behind shitproxy (or given the same resolution), or it
  will keep using the shared key.

Two deployments on one box share `gateway_net`, so the name `authd` is ambiguous
there; point `UPSTREAM_KEY_RESOLVER_URL` at the intended deployment's authd by a
distinct alias or its host port (see "Two deployments on one box").

An admin can replace or clear a person's key from `/admin` (the `API key…` action);
the stored value is never sent back to the browser, so it is a blind write, and the
table only shows whether a key is set.

### Each account gets its own instance

Creating an account does not by itself give it a workspace. `authd` records the
account; a **host-side reconciler** creates the instance and writes the upstream
back. That is what keeps `authd` a plain component — it never touches a container
runtime, and no internet-facing service ever holds the Docker socket.

- `scripts/provision-user.sh EMAIL` creates that account's own compose project
  (`claudesk-<slug>`): its own `/config`, `/workspace`, container names and host
  port, with the pristine Cowork VM bundle **reflinked** in, so the 10 GiB image
  is shared rather than copied. It then records `127.0.0.1:<port>` as the
  account's upstream.
- `scripts/install-reconciler.sh` installs the units that run
  `scripts/converge-users.sh`. A **`.path` unit fires the moment authd drops a
  provisioning request** — so a new account's instance is created on the event,
  not on a poll — and a `.timer` runs it every 20 s as a backstop for a missed
  event or a failed provision. authd only writes a file into
  `<data-root>/auth-data/provision-requests` (on account creation, and again when
  a signed-in user reaches the "setting up your workspace" page); it still never
  touches Docker. Run the installer once per deployment, with a distinct `NAME`
  for a second checkout on the same box:

  ```bash
  sudo scripts/install-reconciler.sh                  # a deployment at /opt/claudesk
  sudo scripts/install-reconciler.sh /opt/claudesk-v2 v2
  ```

  Provisioning runs `CLAUDESK_RECONCILE_JOBS` (default 8) accounts at a time —
  mind the memory each instance peaks at.

Putting an instance up is also where an account's **privileges** are decided
(`scripts/lib/account-scope.sh`, pinned by a smoke). A provisioned account runs
the deployment's own `compose.yaml` with the deployment's `.env`, so it inherits
every value the deployment set — most of that is intended (the web shell, the
desktop home, identity's org/plan, the egress policy, the timezone, the VM
sizing). What must **not** be inherited is pinned by role; an account gets none
of these, and an `Admin` account keeps the deployment's own setting:

- `CLAUDE_REMOTE_GATEWAY_SETTINGS` — the writable Gateway/inference
  configuration library: the Setup page and the models/endpoint/credential
  editor, reachable in the web shell and through `POST /api/remote/settings`.
  The account's own endpoint still comes from the environment (the image writes
  it as a managed setting), so an end user can neither view nor edit it, and the
  bridge answers 404 for the whole surface.
- `CLAUDE_REMOTE_DEVELOPER_ACTIONS` — the Developer menu's privileged actions
  and its editor for `claude_desktop_config.json`, `developer_settings.json`,
  MCP logs and trace downloads.
- `CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS` — the Projects/Spaces, Artifact,
  browser-file and Memory mutations. (Cowork **scheduled tasks** are *not*
  scoped here: they are the account's own routines, run in its own instance, and
  the renderer hides its "New task" button and its delete when their methods are
  withheld — so a non-Admin account keeps them, and can manage routines from the
  UI rather than only by asking its agent.)
- `COWORK_REMOTE_READ_ROOTS` — the extra roots the authenticated download route
  may serve. An account reads its own workspace and nothing else; the operator's
  own `/config` is not a tenant's to fetch. (`CLAUDE_COWORK_HOST_BASH` is pinned
  off for every account too: the image requires Cowork VM mode.)

`provision-user.sh` reads the role from `authd --show` and decides;
`CLAUDESK_ACCOUNT_GATEWAY_SETTINGS` / `_DEVELOPER_ACTIONS` /
`_INFRASTRUCTURE_ACTIONS` / `_READ_ROOTS` force a value for every account
regardless of role. Code stays off for accounts separately, and stays off until
the deployment turns it on.

Until an account's instance exists, `/api/auth/verify` answers `503 Setting up
your workspace`; that page refreshes itself, and reaching it nudges the
reconciler, so the account is provisioned on demand rather than on the timer's
next tick.

### Connectors (remote MCP servers)

The bundle's Connectors surface (Settings → Connectors, the "Add connector"
control, the plugin-connector rows) speaks claude.ai's connectors API —
`/api/organizations/{org}/mcp/remote_servers…`. A self-hosted account's org is
the bridge's own synthetic one, so there is no upstream to forward to; the bridge
answers the family itself and stores the definitions in `bridge/connectors.mjs`
(one `connectors.json` under the account's `bridge-data`). Adding a connector
from the web shell therefore needs no claude.ai account.

Connection and tool listing are driven by the renderer over the Desktop IPC
(`getDirectMcpServerStatuses`, `authorizeDirectMcpServer`, `directMcpListResources`,
…). Those methods used to sit behind the Developer-menu gate, which a plain
account does not have, so they now ride their own flag instead of
`CLAUDE_REMOTE_DEVELOPER_ACTIONS`: on with the web shell, off without it, and
`CLAUDE_REMOTE_MCP_CONNECTORS` (`=1` / `=0`) pins either way.
`scripts/bridge-parity-smoke.mjs` keeps the outer and inner allowlists in step.

### Deleting an account reclaims its instance

Deleting a user in `/admin` is the mirror of creating one, and just as hands-off:
the same reconciler tears the instance down. `authd` cannot ask for it the way it
does a provision — a provision request just names the account and the host
re-reads it from the database, but by the time a deletion is reclaimed the row is
already gone. So the deprovision request **carries its payload**: before the row
is deleted, `authd` writes the account's email/id/upstream into
`<data-root>/auth-data/deprovision-requests`, and `scripts/deprovision-user.sh`
stops and removes the account's compose project (`claudesk-<slug>`) and deletes
its data root (`<data-root>/users/<slug>` — its config, reflinked VM bundle,
workspace and persistent-root overlay).

`scripts/install-reconciler.sh` installs the matching units, so this runs on the
event exactly as provisioning does. A request is cleared only after its teardown
succeeds, so a failure — or a delete taken while the host was down — stays queued
and is retried by the `.timer` backstop rather than leaking. Two safety points:
teardown refuses to run for a **reserved** slug (the box gateway stack is the
compose project `claudesk-gateway`, which an account slug like `gateway` would
otherwise collide with, so `scripts/lib/slug.sh` reserves it for provisioning
too), and the `disabled` flag and a password reset are **reversible** — they
never tear anything down. Only a real delete reclaims.

### Rolling an image fix out to every account

A container is pinned to the image it was created from, so a fix that lives in
the image — the container init, the bridge, the renderer patches — reaches an
account only when its containers are recreated. `deploy.sh` does the whole
roll-out: it pulls the checkout, builds and recreates the deployment's own
services, recreates every provisioned account's instance (`scripts/refresh-users.sh`),
and then provisions any account still pending (`scripts/converge-users.sh`).
Both passes run `CLAUDESK_RECONCILE_JOBS` (default 8) at a time.

```bash
./deploy.sh          # as the deploy user; it asks for root where it needs it
```

`scripts/refresh-users.sh` is safe to run on its own and safe to re-run. It is
not destructive: an account's config, workspace, VM bundle and persistent-root
overlay are host directories under `CLAUDESK_DATA_ROOT/users/<slug>`, and a
recreate swaps containers rather than that directory. The port authd recorded
for an account is kept, so the proxy mapping does not move. What a roll-out does
cost is in-flight turns — anyone mid-session when the script reaches them is
interrupted, though transcripts persist.

Operator tools, run inside the shared authd container:

```bash
docker compose -f compose.yaml exec authd /app/authd --create-admin you@example.com
docker compose -f compose.yaml exec authd /app/authd --invite someone@example.com
docker compose -f compose.yaml exec authd /app/authd --pending
docker compose -f compose.yaml exec authd /app/authd --provisioned
docker compose -f compose.yaml exec authd /app/authd --set-upstream someone@example.com 127.0.0.1:15903
```

### Reverse proxy

The service is loopback-only; the proxy is the single gate. Everything the auth
service owns goes to it directly; everything else is the user's workspace behind
`forward_auth`, which returns the upstream to route to.

```caddyfile
claude.example.com {
	# SPA routes, its assets, and the API all belong to authd.
	@auth path /login /accept-invite /admin /auth-assets/* /api/auth/* /api/admin/*
	handle @auth {
		reverse_proxy 127.0.0.1:15830
	}

	# Everything else is the workspace, behind the session check.
	handle {
		forward_auth 127.0.0.1:15830 {
			uri /api/auth/verify
			copy_headers X-Instance-Upstream
		}
		reverse_proxy {http.request.header.X-Instance-Upstream}
	}

	# Send unauthenticated visitors to the login page instead of a bare 401.
	handle_errors {
		@unauth expression {http.error.status_code} == 401
		redir @unauth /login?next={http.request.uri} 302
	}
}
```

`/api/auth/verify` answers `200` with `X-Instance-Upstream` when the session is
live and the user has an instance, `503` when they have none yet (a page, since
`forward_auth` hands the body back), and when there is no session it **redirects
to `/login` for a page load but keeps the plain `401` for a sub-resource fetch**.
That split matters: `forward_auth` hands the auth response back to whoever
asked, so a visitor who lands on a URL should get a page rather than a JSON
error — but an app fetch that followed that redirect would land on the sign-in
page's HTML, receive it as a `200`, and conclude it was still signed in. It
decides with the browser's own `Sec-Fetch-*` hints, falling back to `Accept`.
Either way it is non-2xx, which is how `forward_auth` refuses the request and
reports no upstream. The SPA's assets are namespaced under `/auth-assets/` so
they never collide with the workspace's own `/assets/`.

### Identity

With `AUTH_IDENTITY_URL` set, `bridge/server.mjs` resolves the signed-in user
from the request's session cookie (a short-lived, cookie-keyed cache) and feeds
it into the account documents the chrome reads — so the sidebar, the account
menu and the greeting read as that person rather than the synthetic gateway
identity. Unset, it falls back to the env-configured identity, which is what a
default deployment and the `maddie` branch resolve.

The person's **name and profile photo** come from the account too: each
provisioned instance sets `AUTH_IDENTITY_URL` (see `scripts/provision-user.sh`),
so an admin edit or a new picture shows live, without a re-provision. A photo is
served by `authd` itself at `GET /api/auth/avatar/:id` — same-origin for the web
shell (the proxy already sends `/api/auth/*` to authd), gated on a live session,
and **404 when the person has no photo**, which is the chrome's cue to fall back
to the default mark. Photos are stored beside the account in authd's SQLite, up
to 2 MiB (PNG/JPEG/WebP/GIF/AVIF).

**Signing out** is the same seam read the other way. The app's own "Sign out"
ends a claude.ai session, which is not what holds this one, so the preload
replaces it wherever it appears — the account menu's item and the whole-page
button, both matched by their own copy — with a `POST /api/auth/logout` against
authd and a trip back to the sign-in page. That only applies where
`AUTH_IDENTITY_URL` is set: the bridge tells the preload so, and a deployment
without the auth service keeps the app's own behaviour.

The app renders its own row only when it believes it holds a login (`signOut`
comes from the bootstrap's `login`, which is written by the *writable*
configuration — so an admin's instance has one and a managed account
legitimately does not, even though authd holds a session for both). A renderer
patch (`account-sign-out-row`) forces that flag true, so the app draws its
genuine menu item — icon, hover styling and keyboard handling included — on
every deployment, where a managed account previously got a clone of a
neighbouring row that carried none of them. The preload then only has to
intercept the click, exactly as it already did for the row an admin had.

### The sign-in page

`/login` and `/accept-invite` are a hand-port of **Claude's own sign-in screen**,
rendered by authd's SPA: the centered shell with the Claude lockup, a serif
display heading, and the rounded card holding the form. It is a *visual* port,
not a runtime reuse — the official page is claude.ai SSO / magic-link / MFA
against `/api/auth/{login_methods,send_magic_link,verify_google,…}` and has no
password field, so running it here would mean synthesising a signed-out
bootstrap (the bridge only *edits* the running Desktop's) and reimplementing
claude.ai's auth API against authd. The port keeps authd's email + password
semantics, adds the password field beneath the email, and drops the Google/Apple
buttons, which have nothing to authenticate against.

Two details are deliberate. The official styles are Tailwind utilities compiled
into a 1.6 MB sheet we do not ship, so the card, inputs and button are
reproduced by hand in `web/src/styles.css` rather than linked — expect cosmetic
drift if Anthropic restyles, and treat a refresh as a manual chore. And the
official footer's "you acknowledge Anthropic's Privacy Policy" line is omitted:
this is not Anthropic's screen, and that claim would be false here.

The assets come from the Desktop renderer on the box:

- the two faces (`anthropic-serif`, `anthropic-sans`, woff2 from
  `assets/v1/`) are vendored under `web/src/assets/fonts/` and referenced from
  `styles.css` by a *relative* url, so Vite emits them into `/auth-assets/` —
  the one prefix the proxy already sends to authd. A `public/`-rooted
  `/fonts/…` would fall through to the workspace and `forward_auth` would 401 an
  unauthenticated visitor.
- the lockup is inlined in `web/src/components/ClaudeLogo.tsx`, paths copied
  from the renderer's `ClaudeLogo` (the 24px viewBox).

### The login shell — the bundle's own sign-in page

`CLAUDE_REMOTE_LOGIN_SHELL=1` turns an instance into a front door: it serves the
renderer's **own** `/login` — Claude's sign-in page, out of the same bundle the
workspace runs, not a copy of it — and refuses **every** API request, so the
instance cannot proxy the Desktop, hold a session or run inference, signed in or
not.

Two things make that work.

The page needs no data to appear. The app routes itself to its own `/login` the
moment the bootstrap answers an error (`isLoggedOut` in the bootstrap store), so
the refused bootstrap *is* what puts the page up — no synthesised account
document, and nothing from claude.ai.

Credentials go straight to `authd`, which the proxy already sends `/api/auth/*`
to. `bridge/public/remote-preload.js` extends the card in the DOM — adding a
password field beneath the email, pointing the form at `/api/auth/login`, and
dropping the Google/Apple buttons, which have nothing behind them here. That
lives in the preload rather than a renderer patch on purpose: the card belongs
to React, so the additions have to survive its re-renders, and this way a tweak
costs a bridge restart instead of a renderer rebuild.

Those page edits fire on the instance's mode **or** on the route: this bundle's
sign-in page is only ever reached without a session at `/login`, since every
other path is the workspace behind the session gate, so the route is as good a
signal as the flag — and it keeps the page right when the mode has not actually
been applied, which is otherwise silent. The *gate* still depends on the flag
alone; the bridge says in its startup log when it is one, so a missing mode is
visible rather than mistaken for a working deployment.

The proxy side is host-side (the Caddyfile is not in this repo). The login page
needs its own handler ahead of the session gate — `/login` comes **out** of the
authd matcher, or authd's own page is what shows, and the paths the page loads
have to bypass `forward_auth` too, or they 401 and the browser is handed the
login HTML in place of a module or a stylesheet:

```caddyfile
	# The login shell: the renderer's own sign-in page and everything it loads,
	# served by the deployment's own instance (CLAUDE_REMOTE_LOGIN_SHELL=1).
	# Static only — never an API path. Anything here is served without a session,
	# and the only thing standing between it and the workspace is that instance's
	# own gate; if the mode is ever not in effect, an API path here would hand
	# out the workspace.
	@loginshell path /login /renderer/* /remote-preload.js /remote-main-menu.js \
		/remote-main-menu.css /remote-shell.css /remote-folder-picker.js \
		/fonts/* /favicon.ico /manifest.webmanifest
	handle @loginshell {
		reverse_proxy 127.0.0.1:15831
	}

	# Everything authd owns. /login is deliberately absent, above.
	@authd path /accept-invite /admin /auth-assets/* /api/auth/* /api/admin/*
	handle @authd {
		reverse_proxy 127.0.0.1:15832
	}

	handle {
		forward_auth 127.0.0.1:15832 {
			uri /api/auth/verify
			copy_headers X-Instance-Upstream
		}
		reverse_proxy {http.request.header.X-Instance-Upstream}
	}

	handle_errors {
		@unauth expression {http.error.status_code} == 401
		redir @unauth /login 302
	}
```

The port is the deployment's own `COWORK_WEB_PORT`. Because a `handle` matcher
is an allow-list, a path the page needs but that is missing here fails visibly —
as an asset the browser refuses to run — rather than subtly; add it to the
matcher if a future build asks for one. (A `handle_errors` branch that
`reverse_proxy`es the 401 to the same instance would cover every path at once;
it is not used here because Caddy keeps the original status on that branch,
which would serve the page and its scripts under a 401.) Add
`CLAUDE_REMOTE_WEB_SHELL=1` on the instance to render the browser chrome (the
marketing sign-in page with the hero) instead of the Desktop chrome.

The page's **bootstrap deliberately stays out of this matcher**. It is what the
app reads to decide whether it is signed out, and it is answered by the session
gate instead: `forward_auth` calls `/api/auth/verify`, which returns the plain
`401` a fetch needs, the app concludes it is signed out, and it routes itself to
its own `/login` — which is this matcher. Routing the bootstrap here would work
only while the instance is correctly in login-shell mode, and would serve the
workspace's own bootstrap document if it were not; the bridge logs
`login shell: the whole API is refused` at startup precisely so that state is
visible rather than guessed at.

Worth knowing before you expect a pixel match: the hero media is **not** in the
bundle — the still is fetched from the web root and the video from
`assets.claude.ai` — so the right-hand column is empty unless those are vendored
alongside the fonts; and this build's card may render no provider buttons at
all, in which case there is nothing to drop.

`scripts/login-shell-smoke.mjs` boots the bridge in this mode and asserts the
refusals, so the property cannot rot quietly.

## Two deployments on one box

A second checkout (say `/opt/claudesk-v2`) sharing a host with the production
one collides on four things. Three are the checkout's to set; one is box-level.

| Collision | Handled by |
| --- | --- |
| Host data paths (`/opt/claudesk/data/…`) | `CLAUDESK_DATA_ROOT` |
| Persistent-root state | `CLAUDESK_ROOT_STATE` |
| Container names | `CLAUDESK_NAME_PREFIX` (e.g. `eva-`) |
| Host ports | `COWORK_WEB_PORT`, `CLAUDE_MOBILE_PORT`, `AUTH_PORT` — set distinct values |
| Reconciler systemd units & watched spools | `install-reconciler.sh <checkout> <name>` — a distinct `NAME` per deployment |

```dotenv
CLAUDESK_DATA_ROOT=/opt/claudesk-v2/data
CLAUDESK_ROOT_STATE=/var/lib/claudesk-v2-root
CLAUDESK_NAME_PREFIX=eva-
COWORK_WEB_PORT=15831
CLAUDE_MOBILE_PORT=8082
AUTH_PORT=15832
```

Two things are **not** per-checkout:

- **The gateway chain is box-level.** `compose.gateway.yaml` (shitproxy + the
  caddy `gateway`) is its own stack: start it once with
  `docker compose -f compose.gateway.yaml up -d`, and every deployment on the
  host reaches it over `gateway_net`. Neither deployment declares it, so neither
  fights the other for its name or its host port.
- **Service aliases on the shared `gateway_net` are not project-scoped.** Both
  stacks attach `authd` and `claude-desktop` to that external network, so a
  bridge asking for `authd` can resolve the *other* deployment's container. The
  cookie will not validate there, so it degrades to the env identity rather than
  leaking — but it is wrong. Until this is scoped per deployment (giving each its
  own network, which the per-user work in Stage 2 will produce anyway), don't run
  both stacks' bridges against the same `gateway_net`.

## Stage 2 — per-user light instances

**Not built yet — spike first.** The plan is one systemd-owned instance per user;
the honest unknowns (rootless KVM/vsock, the baseimage init under rootless
podman, and the update machinery) are all settled by one afternoon on the box.

### The model

- One `claude-desktop` (+ its bridge/office sidecars) per user, as a **systemd
  unit pair**: a `.socket` that listens on the user's loopback port and a
  `.container` (rootless-podman quadlet) that the first connection starts through
  `systemd-socket-proxyd`. On-demand comes from systemd, not from the app.
- `MemoryMax`/`CPUQuota` cap each unit; `/dev/kvm` and `/dev/vhost-vsock` are
  passed explicitly. The Cowork VM's vsock port is host-global, so more than one
  VM per host needs a port per instance — see docs/vsock-port.md.
- No persistent-root overlay: Eva has no user-controlled container to need it, so
  an instance drops `CAP_SYS_ADMIN`, `userns_mode: host`, `apparmor=unconfined`
  and `pivot_root` and runs the base seccomp profile.
- `authd` registers each user's `upstream`, which Caddy routes to.

### The VM disk is shared, not copied

`rootfs.img` is a 10 GiB image that is 52 % zeros; the pristine bundle is seeded
once and **reflinked** per user on the same btrfs, so a new user costs only the
extents their guest actually writes:

```bash
cp -a --reflink=always "$MASTER/rootfs.img"    "$user_dir/claudevm.bundle/"
cp -a --reflink=always "$MASTER/rootfs.img.zst" "$user_dir/claudevm.bundle/"
# ... the static files; deliberately NOT sessiondata.img — each user's is theirs.
```

Measured on the box: a reflinked copy reports `Exclusive 0.00 B`. Confirm the app
adopts the seeded bundle instead of re-downloading it, and re-check `btrfs
filesystem du -s` after real Cowork use to see how much a guest dirties.

### Spike checklist

1. Rootless podman runs *this* image: the jlesage `/init`, Xvfb, the bridge, and
   the Cowork VM with `/dev/kvm` + `/dev/vhost-vsock` in a rootless container.
2. A `.socket` + `systemd-socket-proxyd` starts it on first connection.
3. The VM comes up light (`mem=%dMB` at 1024 in the qemu args) and idle-stops.
4. A reflinked bundle is adopted without a re-download.

If rootless KVM/vsock or the baseimage init fight back, fall back to
`systemd-nspawn` (btrfs snapshots give the disk sharing for free), or to
systemd-managed *rootful* podman units, which still keeps the socket out of the
app.

### Update machinery

`scripts/monthly-update.sh` is compose-coupled today. Stage 2 rewrites it to
build the candidate image, gate on `config/release.json`, and restart the N
units with a rollback image — and to refresh the stale `/vol2/1000/…` paths in
`ops/systemd`.
