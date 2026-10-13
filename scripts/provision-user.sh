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

# The shared stack (this compose project) owns authd; the per-user stacks are
# separate projects below.
compose_shared() { docker compose -f compose.yaml "$@"; }
authd() { compose_shared exec -T authd /app/authd "$@"; }

# The role → operator-surfaces decision, driven by a smoke.
# shellcheck source=scripts/lib/surfaces.sh
. "$project_dir/scripts/lib/surfaces.sh"

info="$(authd --show "$email")" || exit 1

id=""; user_email=""; first_name=""; role=""; upstream=""; disabled=""
while IFS='=' read -r key value; do
    case "$key" in
        id) id="$value" ;;
        email) user_email="$value" ;;
        first_name) first_name="$value" ;;
        role) role="$value" ;;
        upstream) upstream="$value" ;;
        disabled) disabled="$value" ;;
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

# ASCII-only slug: LC_ALL=C keeps the character classes to a-z0-9, so a
# non-ASCII local part cannot leak into a container name.
slug="$(printf '%s' "$user_email" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C tr -cs '[:alnum:]' '-' \
    | sed 's/^-*//; s/-*$//')"
[ -n "$slug" ] || { printf 'provision-user: cannot derive a slug from %s\n' "$user_email" >&2; exit 1; }

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
#   - no Code surface.
# Both are overridable for a deployment that wants something else.

# The gateway a provisioned account talks to, and how it authenticates. The
# endpoint must be reachable from inside the Cowork VM, which makes the model
# calls and resolves the name itself: a loopback URL resolves to the guest there,
# however well it answers in the container. `gateway` is the box-level chain on
# gateway_net, which the container resolves through Docker DNS and the guest
# through the container.
#
# The key is a placeholder that never leaves the box. caddy `gateway` replaces
# X-Api-Key with the upstream credential on the one route that goes straight to
# the router, so a deployment's key never has to be an upstream key — and is
# never sent as a bearer token the router would reject, which is what an
# `x-api-key` scheme avoids. Override any of the three with
# CLAUDESK_ACCOUNT_GATEWAY_URL / _API_KEY / _AUTH_SCHEME.
account_gateway_url="${CLAUDESK_ACCOUNT_GATEWAY_URL:-http://gateway:4000}"
account_gateway_key="${CLAUDESK_ACCOUNT_GATEWAY_API_KEY:-sk-local}"
account_gateway_scheme="${CLAUDESK_ACCOUNT_GATEWAY_AUTH_SCHEME:-x-api-key}"
case "$account_gateway_url" in
    *127.0.0.1*|*localhost*|*"::1"*)
        printf 'provision-user: WARNING: gateway URL %s is loopback; the Cowork VM resolves that to itself, so inference will fail\n' \
            "$account_gateway_url" >&2
        ;;
esac

# The operator surfaces belong to whoever administers the box, and a provisioned
# account is an end user. scripts/lib/surfaces.sh decides three of them by role —
# an Admin keeps the deployment's own setting, every other account gets none:
#
#   - the writable Gateway/inference configuration library, so an end user can
#     neither see that page nor edit the endpoint, credential or model list
#     through the bridge API (their endpoint still comes from the environment);
#   - the Developer menu's privileged actions and its editor for the app's own
#     config files;
#   - the Projects/Spaces, Artifact, Memory and Scheduled-Tasks mutations.
#
# (Code is separately off for accounts, and stays off until the deployment turns
# it on.) Override any of them for every account with the matching
# CLAUDESK_ACCOUNT_* variable.
account_operator_surfaces "${role:-User}"

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
CLAUDE_REMOTE_DEVELOPER_ACTIONS="$ACCOUNT_DEVELOPER_ACTIONS" \
CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS="$ACCOUNT_INFRASTRUCTURE_ACTIONS" \
AUTH_IDENTITY_URL="${CLAUDESK_ACCOUNT_IDENTITY_URL:-http://authd:8080}" \
compose_shared --project-name "claudesk-$slug" \
    up -d --force-recreate claude-desktop cowork-bridge claude-gateway-loopback

# Route the account to it; authd re-reads this on every request.
if [ -z "$upstream" ]; then
    authd --set-upstream "$user_email" "127.0.0.1:$port" >&2
fi

printf 'provision-user: %s -> 127.0.0.1:%s (project claudesk-%s)\n' \
    "$user_email" "$port" "$slug"
