#!/bin/sh
#
# Provision one account's own Claude Desktop instance.
#
#   provision-user.sh EMAIL
#
# Creates the account's data directories, reflinks a pristine Cowork VM bundle
# into them, starts its own compose project (own container names, own port, own
# data root) and records the resulting upstream in authd. Idempotent: an account
# that already has an upstream is left alone.
#
# Run as root — it creates directories owned by PUID:PGID and drives Docker.
# authd itself never does any of this; that is the point.
set -eu

email="${1:?usage: provision-user.sh EMAIL}"
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'provision-user: no .env in %s\n' "$project_dir" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. ./.env
set +a

data_root="${CLAUDESK_DATA_ROOT:-/opt/claudesk/data}"
puid="${PUID:-1000}"
pgid="${PGID:-1001}"
port_base="${CLAUDESK_USER_PORT_BASE:-15901}"
# The Cowork VM's vsock port is a compile-time constant in the app, and
# host-side vsock listeners are host-global (see docs/vsock-port.md), so accounts
# on one box each need their own or only one VM can run. Off by default: the
# guest side must be settled first, and a host-only move would send this
# account's guest at whichever helper still holds the default. Set
# CLAUDESK_VM_VSOCK_PORT_BASE (e.g. 51234) to give each account base + its id.
vm_vsock_base="${CLAUDESK_VM_VSOCK_PORT_BASE:-}"

# The shared stack (this compose project) owns authd; the per-user stacks are
# separate projects below.
compose_shared() { docker compose -f compose.yaml "$@"; }
authd() { compose_shared exec -T authd /app/authd "$@"; }

# The role → account-scope decision, driven by a smoke.
# shellcheck source=scripts/lib/account-scope.sh
. "$project_dir/scripts/lib/account-scope.sh"

# The account slug, shared with deprovision-user.sh so the two never disagree on
# the project/name-prefix/data-root an account is keyed by.
# shellcheck source=scripts/lib/slug.sh
. "$project_dir/scripts/lib/slug.sh"

info="$(authd --show "$email")" || exit 1

id=""; user_email=""; first_name=""; role=""; upstream=""; disabled=""; gateway_key=""
while IFS='=' read -r key value; do
    case "$key" in
        id) id="$value" ;;
        email) user_email="$value" ;;
        first_name) first_name="$value" ;;
        role) role="$value" ;;
        upstream) upstream="$value" ;;
        disabled) disabled="$value" ;;
        gateway_key) gateway_key="$value" ;;
    esac
done <<EOF
$info
EOF

[ -n "$id" ] || { printf 'provision-user: could not read account %s\n' "$email" >&2; exit 1; }
if [ "$disabled" = "1" ]; then
    printf 'provision-user: %s is disabled; skipping\n' "$user_email" >&2
    exit 0
fi
# An account that already has an instance is not re-provisioned, but its stack
# is still brought up to date — so re-running this after a rebuild recreates the
# containers that changed, without moving the recorded port.
if [ -n "$upstream" ]; then
    printf 'provision-user: %s already has %s; refreshing its stack\n' "$user_email" "$upstream"
fi

slug="$(claudesk_slug "$user_email")"
if ! claudesk_slug_ok "$slug"; then
    printf 'provision-user: refusing reserved or empty slug "%s" (from %s)\n' "$slug" "$user_email" >&2
    exit 1
fi

# Keep the port already recorded for the account; a new one is 15901 + its id.
if [ -n "$upstream" ]; then
    port="${upstream##*:}"
else
    port=$((port_base + id))
fi
user_root="$data_root/users/$slug"

# Its own directories, owned by the same user the containers run as.
install -d -m 0755 -o "$puid" -g "$pgid" \
    "$user_root/config" "$user_root/workspace" "$user_root/bridge-data" "$user_root/root"

# Share the pristine VM bundle rather than downloading 10 GiB per account.
# The bundle every account's copy is reflinked from. Point CLAUDESK_VM_MASTER at
# an existing one (e.g. another deployment's already-downloaded bundle) if this
# deployment's workspace has not fetched one yet.
master_bundle="${CLAUDESK_VM_MASTER:-$data_root/config/.config/Claude-3p/vm_bundles/claudevm.bundle}"
user_bundle="$user_root/config/.config/Claude-3p/vm_bundles/claudevm.bundle"
if [ -d "$master_bundle" ] && [ ! -e "$user_bundle/rootfs.img" ]; then
    install -d -o "$puid" -g "$pgid" "$user_bundle"
    "$project_dir/scripts/seed-vm-bundle.sh" "$master_bundle" "$user_bundle" >&2 || true
fi
chown -R "$puid:$pgid" "$user_root/config" 2>/dev/null || true

# Start the instance: its own compose project, names, port and data root. The
# gateway chain is box-level and already running; the socat relay reaches it over
# gateway_net, so this stack never declares shitproxy/gateway. The name and photo
# are resolved live from authd (AUTH_IDENTITY_URL below) so an admin edit or a
# new picture shows without a re-provision; the name/email below stay as the
# no-session fallback.
# Eva semantics, set here rather than inherited from the shared .env:
#   - inference goes through this account's relay into the box-level chain
#     (relay → caddy `gateway` → shitproxy), not straight at the router;
#   - no Code in this container (Eva semantics, set here rather than inherited
#     from the shared .env): `CLAUDESK_TENANT=1` marks one account's own
#     instance, which never exposes the container-local Code executor — its Code
#     belongs on a self-hosted runner inside its Cowork guest.
#   - `CLAUDESK_CODE_RUNNERS=1` answers the self-hosted pool API that runner
#     speaks, so an account is ready the moment one registers. It is on by
#     default and harmless before then: the bridge advertises a pool as a place
#     only once a runner has registered with it, so an account with no runner yet
#     is offered no environment rather than a dead one. Force either with
#     CLAUDESK_ACCOUNT_CODE_RUNNERS. See docs/code-in-cowork-vm.md.

# The gateway a provisioned account talks to, and how it authenticates. The
# endpoint must be reachable from inside the Cowork VM, which makes the model
# calls and resolves the name itself: a loopback URL resolves to the guest there,
# however well it answers in the container. `gateway` is the box-level chain on
# gateway_net, which the container resolves through Docker DNS and the guest
# through the container.
#
# The key is the account's own gateway identity, minted by authd (`gateway_key`
# in `authd --show`). It is opaque and never leaves the box: the box gateway
# (shitproxy) resolves it to this account's own upstream key, so each account's
# inference is billed to the key they supplied, not the operator's. It is not an
# upstream key — which is what the `x-api-key` scheme avoids sending as a bearer
# token the router would reject. The deployment-wide CLAUDESK_ACCOUNT_GATEWAY_API_KEY
# is only a fallback for an authd too old to report one. Override the URL and
# scheme with CLAUDESK_ACCOUNT_GATEWAY_URL / _AUTH_SCHEME.
account_gateway_url="${CLAUDESK_ACCOUNT_GATEWAY_URL:-http://gateway:4000}"
account_gateway_key="${gateway_key:-${CLAUDESK_ACCOUNT_GATEWAY_API_KEY:-sk-local}}"
account_gateway_scheme="${CLAUDESK_ACCOUNT_GATEWAY_AUTH_SCHEME:-x-api-key}"
case "$account_gateway_url" in
    *127.0.0.1*|*localhost*|*"::1"*)
        printf 'provision-user: WARNING: gateway URL %s is loopback; the Cowork VM resolves that to itself, so inference will fail\n' \
            "$account_gateway_url" >&2
        ;;
esac

# A provisioned account inherits the deployment's own configuration — the same
# .env and the same compose.yaml — so what an account must NOT inherit is pinned
# by scripts/lib/account-scope.sh, by role (an Admin keeps the deployment's
# setting, every other account is scoped down):
#
#   - the writable Gateway/inference configuration library, so an end user can
#     neither see that page nor edit the endpoint, credential or model list
#     through the bridge API (their endpoint still comes from the environment);
#   - the Developer menu's privileged actions and its editor for the app's own
#     config files;
#   - the Projects/Spaces, Artifact, browser-file and Memory mutations (Cowork
#     scheduled tasks are the account's own and stay allowed, so an end user can
#     manage routines from the UI rather than only by asking their agent);
#   - the extra download roots (COWORK_REMOTE_READ_ROOTS), so an account reads
#     its own workspace and nothing else.
#
# (Code is not scoped here: it is off for accounts because an account is a
# tenant, and a tenant never runs Code in its container — see CLAUDESK_TENANT
# above. CLAUDESK_ACCOUNT_CODE_ACTIONS cannot lift that; the account's Code
# belongs on a self-hosted runner in its Cowork guest.) Override any of the
# four above for every account with the matching CLAUDESK_ACCOUNT_* variable.
account_scope "${role:-User}"

# This account's Cowork vsock port (empty leaves the app's default). Computed
# here, once the account's id is known.
vm_vsock_port=""
[ -z "$vm_vsock_base" ] || vm_vsock_port=$((vm_vsock_base + id))

# Only the values above are scoped away from the deployment; the rest of its .env
# (web shell, desktop home, identity org/plan, egress policy, timezone, VM sizing)
# is inherited on purpose. CLAUDE_REMOTE_LOGIN_SHELL is scoped away too, and to
# 0 specifically: it is set on the deployment's own instance, which compose
# reads from this same .env, and an account carrying it would refuse its own API
# and serve a sign-in page in place of the workspace. Host bash is pinned off for
# every account: this image
# requires Cowork VM mode and refuses the host-bash mode at build time, so the pin
# only keeps an account from naming a mode the deployment set for itself.
#
# The services recreated at the end are CLAUDESK_RECREATE_SERVICES, defaulting to
# the full set. That set is right after an image change — the desktop container
# is what re-prepares the renderer, so it has to come back for a renderer fix to
# reach anyone. A change that lives only in the bridge does not need it, and
# skipping it is the difference between seconds and the minute of parsing every
# desktop container pays at startup (see prepare-renderer.mjs);
# scripts/deploy-bridge-only.sh sets the narrow set. The value is a deliberate
# list of names, so it must split.
# shellcheck disable=SC2086
CLAUDESK_DATA_ROOT="$user_root" \
CLAUDESK_ROOT_STATE="$user_root/root" \
CLAUDESK_NAME_PREFIX="$slug-" \
COWORK_WEB_PORT="$port" \
CLAUDE_REMOTE_ACCOUNT_NAME="$first_name" \
CLAUDE_REMOTE_ACCOUNT_EMAIL="$user_email" \
CLAUDE_GATEWAY_BASE_URL="$account_gateway_url" \
CLAUDE_GATEWAY_API_KEY="$account_gateway_key" \
CLAUDE_GATEWAY_AUTH_SCHEME="$account_gateway_scheme" \
CLAUDE_GATEWAY_ENV_AUTHORITATIVE=1 \
CLAUDE_REMOTE_GATEWAY_SETTINGS="$ACCOUNT_GATEWAY_SETTINGS" \
CLAUDE_REMOTE_CODE_ACTIONS="${CLAUDESK_ACCOUNT_CODE_ACTIONS:-0}" \
CLAUDESK_TENANT=1 \
CLAUDESK_CODE_RUNNERS="${CLAUDESK_ACCOUNT_CODE_RUNNERS:-1}" \
CLAUDE_REMOTE_LOGIN_SHELL=0 \
CLAUDE_REMOTE_DEVELOPER_ACTIONS="$ACCOUNT_DEVELOPER_ACTIONS" \
CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS="$ACCOUNT_INFRASTRUCTURE_ACTIONS" \
COWORK_REMOTE_READ_ROOTS="$ACCOUNT_READ_ROOTS" \
CLAUDE_COWORK_HOST_BASH=0 \
CLAUDESK_VM_VSOCK_PORT="$vm_vsock_port" \
CLAUDESK_VM_VSOCK_GUEST_SITES="${CLAUDESK_VM_VSOCK_GUEST_SITES:-0}" \
AUTH_IDENTITY_URL="${CLAUDESK_ACCOUNT_IDENTITY_URL:-http://authd:8080}" \
compose_shared --project-name "claudesk-$slug" \
    up -d --force-recreate ${CLAUDESK_RECREATE_SERVICES:-claude-desktop cowork-bridge claude-gateway-loopback}

# Route the account to it; authd re-reads this on every request.
if [ -z "$upstream" ]; then
    authd --set-upstream "$user_email" "127.0.0.1:$port" >&2
fi

printf 'provision-user: %s -> 127.0.0.1:%s (project claudesk-%s)\n' \
    "$user_email" "$port" "$slug"
