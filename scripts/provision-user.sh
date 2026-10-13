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

info="$(authd --show "$email")" || exit 1

id=""; user_email=""; first_name=""; upstream=""; disabled=""
while IFS='=' read -r key value; do
    case "$key" in
        id) id="$value" ;;
        email) user_email="$value" ;;
        first_name) first_name="$value" ;;
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
if [ -n "$upstream" ]; then
    printf 'provision-user: %s already has %s\n' "$user_email" "$upstream"
    exit 0
fi

# ASCII-only slug: LC_ALL=C keeps the character classes to a-z0-9, so a
# non-ASCII local part cannot leak into a container name.
slug="$(printf '%s' "$user_email" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C tr -cs '[:alnum:]' '-' \
    | sed 's/^-*//; s/-*$//')"
[ -n "$slug" ] || { printf 'provision-user: cannot derive a slug from %s\n' "$user_email" >&2; exit 1; }

port=$((port_base + id))
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
# gateway_net, so this stack never declares shitproxy/gateway. The identity comes
# from the account, not from authd (each instance is one person).
CLAUDESK_DATA_ROOT="$user_root" \
CLAUDESK_ROOT_STATE="$user_root/root" \
CLAUDESK_NAME_PREFIX="$slug-" \
COWORK_WEB_PORT="$port" \
CLAUDE_REMOTE_ACCOUNT_NAME="$first_name" \
CLAUDE_REMOTE_ACCOUNT_EMAIL="$user_email" \
AUTH_IDENTITY_URL='' \
compose_shared --project-name "claudesk-$slug" \
    up -d claude-desktop cowork-bridge claude-gateway-loopback

# Route the account to it; authd re-reads this on every request.
authd --set-upstream "$user_email" "127.0.0.1:$port" >&2

printf 'provision-user: %s -> 127.0.0.1:%s (project claudesk-%s)\n' \
    "$user_email" "$port" "$slug"
