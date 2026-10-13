#!/bin/sh
#
# Recreate every provisioned account's instance.
#
#   sudo scripts/refresh-users.sh
#
# Run after the image has been rebuilt — `deploy.sh` does exactly that, then
# calls this — so a fix that lives in the image (the container init, the bridge,
# the renderer patches) reaches every account without anyone visiting each one.
#
# Idempotent and non-destructive. Each account's data is on the host, under
# CLAUDESK_DATA_ROOT/users/<slug>: its config, workspace, VM bundle and the
# persistent-root overlay that carries runtime installs. A recreate swaps the
# container, not that directory, and provision-user.sh keeps the port authd
# already recorded, so the reverse proxy mapping does not move.
#
# What it does cost: anyone mid-turn is interrupted. Transcripts persist, but a
# session running while this walks the accounts ends where it stands.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

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

refreshed=0
failed=0
while IFS= read -r email; do
    [ -n "$email" ] || continue
    if "$project_dir/scripts/provision-user.sh" "$email"; then
        refreshed=$((refreshed + 1))
    else
        printf 'refresh-users: %s failed; it keeps running what it had\n' "$email" >&2
        failed=$((failed + 1))
    fi
done < "$list"

printf 'refresh-users: recreated %s account(s)' "$refreshed"
[ "$failed" -eq 0 ] || printf ', %s failed' "$failed"
printf '\n'
[ "$failed" -eq 0 ]
