#!/bin/sh
#
# Tear down one account's Claude Desktop instance and its data.
#
#   deprovision-user.sh EMAIL
#   deprovision-user.sh --dry-run EMAIL
#
# The mirror of provision-user.sh: stops and removes the account's own compose
# project, then deletes its data root ($CLAUDESK_DATA_ROOT/users/<slug>) — its
# config (including the reflinked Cowork VM bundle and the user's sessiondata.img),
# its workspace, bridge-data and the persistent-root overlay. Idempotent: a
# project that is already gone and a data root that does not exist are both fine.
#
# Run as root — it drives Docker and removes directories owned by PUID:PGID.
# Normally invoked by scripts/converge-deprovisions.sh when an admin deletes an
# account; an operator does not run this by hand.
set -eu

dry_run=0
if [ "${1:-}" = "--dry-run" ]; then
    dry_run=1
    shift
fi
email="${1:?usage: deprovision-user.sh [--dry-run] EMAIL}"

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'deprovision-user: no .env in %s\n' "$project_dir" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. ./.env
set +a

data_root="${CLAUDESK_DATA_ROOT:-/opt/claudesk/data}"
[ -n "$data_root" ] || { printf 'deprovision-user: empty data root\n' >&2; exit 1; }

# shellcheck source=scripts/lib/slug.sh
. "$project_dir/scripts/lib/slug.sh"

# The same slug provision-user.sh keyed the account by. Fails closed on an empty
# slug and on the reserved ones (which would otherwise resolve to a fixed stack
# rather than a user's — e.g. `gateway` → the claudesk-gateway project).
slug="$(claudesk_slug "$email")"
if ! claudesk_slug_ok "$slug"; then
    printf 'deprovision-user: refusing reserved or empty slug "%s" (from %s)\n' "$slug" "$email" >&2
    exit 1
fi

project="claudesk-$slug"
user_root="$data_root/users/$slug"

if [ "$dry_run" = 1 ]; then
    printf 'deprovision-user: would remove compose project %s\n' "$project"
    printf 'deprovision-user: would remove %s\n' "$user_root"
    exit 0
fi

# Stop and remove the account's containers and its project-scoped network. There
# are no named Docker volumes to remove: all of the account's state is bind-
# mounted under $user_root. The project name is scoped to this account, so the
# shared external gateway_net and the deployment's own (root) stack are untouched.
docker compose -f compose.yaml --project-name "$project" down --remove-orphans

# The big one: config (VM bundle + sessiondata.img), workspace, bridge-data and
# the persistent-root overlay all live here.
rm -rf "$user_root"

printf 'deprovision-user: removed %s and %s\n' "$project" "$user_root"
