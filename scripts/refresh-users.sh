#!/bin/sh
#
# Recreate every account that already has an instance.
#
#   [CLAUDESK_RECONCILE_JOBS=8] sudo scripts/refresh-users.sh
#
# Run after the image has been rebuilt — `deploy.sh` does exactly that, then
# calls this — so a fix that lives in the image (the container init, the bridge,
# the renderer patches) reaches every account without anyone visiting each one.
# `deploy.sh` then also runs converge-users.sh, so a deploy both recreates the
# accounts that have an instance and creates any that were still pending.
#
# Idempotent and non-destructive. Each account's data is on the host, under
# CLAUDESK_DATA_ROOT/users/<slug>: its config, workspace, VM bundle and the
# persistent-root overlay that carries runtime installs. A recreate swaps the
# container, not that directory, and provision-user.sh keeps the port authd
# already recorded, so the reverse proxy mapping does not move.
#
# What it does cost: anyone mid-turn is interrupted. Transcripts persist, but a
# session running while this walks the accounts ends where it stands. Accounts
# are recreated CLAUDESK_RECONCILE_JOBS (default 8) at a time, so a roll-out also
# starts that many instances at once — mind the memory each one peaks at.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

# shellcheck source=scripts/lib/reconcile.sh
. "$project_dir/scripts/lib/reconcile.sh"

[ -f .env ] || { printf 'refresh-users: no .env in %s\n' "$project_dir" >&2; exit 1; }

if ! accounts="$(docker compose -f compose.yaml exec -T authd /app/authd --provisioned 2>/dev/null)"; then
    printf 'refresh-users: authd is not running; nothing to do\n' >&2
    exit 0
fi
[ -n "$accounts" ] || { printf 'refresh-users: no provisioned accounts\n'; exit 0; }

# Read the list from a file, not a pipe: a `while` over a pipe runs in a
# subshell, and the failure count would be lost with it.
list="$(mktemp)"
trap 'rm -f "$list"' EXIT HUP INT TERM
printf '%s\n' "$accounts" > "$list"

if reconcile_list "$project_dir" "$list"; then
    printf 'refresh-users: recreated %s account(s)\n' "$RECONCILE_OK"
    exit 0
fi
printf 'refresh-users: recreated %s account(s), %s failed\n' \
    "$RECONCILE_OK" "$RECONCILE_FAIL" >&2
exit 1
