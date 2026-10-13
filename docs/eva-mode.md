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

Open the printed `/accept-invite?token=…` link, set a password, and you land in
`/admin`. From there, **Create a user** returns a one-time invite link (shown
once) — send it to them; they set their own password and their browser timezone
is captured then.

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
- `ops/systemd/claudesk-provision.{service,timer}` runs `scripts/converge-users.sh`
  every 20 s, provisioning every account with no upstream yet. Install once (edit
  the path in the `.service` to your checkout):

  ```bash
  sudo cp ops/systemd/claudesk-provision.* /etc/systemd/system/
  sudo systemctl enable --now claudesk-provision.timer
  ```

Until an account's instance exists, `/api/auth/verify` answers `503 Setting up
your workspace` — reload a moment later and it's there.

Operator tools, run inside the shared authd container:

```bash
docker compose -f compose.yaml exec authd /app/authd --create-admin you@example.com
docker compose -f compose.yaml exec authd /app/authd --invite someone@example.com
docker compose -f compose.yaml exec authd /app/authd --pending
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
live and the user has an instance, `503` when they have none yet, and `401`
otherwise. The SPA's assets are namespaced under `/auth-assets/` so they never
collide with the workspace's own `/assets/`.

### Identity

With `AUTH_IDENTITY_URL` set, `bridge/server.mjs` resolves the signed-in user
from the request's session cookie (a short-lived, cookie-keyed cache) and feeds
it into the account documents the chrome reads — so the sidebar, the account
menu and the greeting read as that person rather than the synthetic gateway
identity. Unset, it falls back to the env-configured identity, which is what a
default deployment and the `maddie` branch resolve.

## Two deployments on one box

A second checkout (say `/opt/claudesk-v2`) sharing a host with the production
one collides on four things. Three are the checkout's to set; one is box-level.

| Collision | Handled by |
| --- | --- |
| Host data paths (`/opt/claudesk/data/…`) | `CLAUDESK_DATA_ROOT` |
| Persistent-root state | `CLAUDESK_ROOT_STATE` |
| Container names | `CLAUDESK_NAME_PREFIX` (e.g. `eva-`) |
| Host ports | `COWORK_WEB_PORT`, `CLAUDE_MOBILE_PORT`, `AUTH_PORT` — set distinct values |

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
  passed explicitly.
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
