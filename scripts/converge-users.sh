#!/bin/sh
#
# Provision an instance for every account that still needs one.
#
# Run from `ops/systemd/claudesk-provision.timer` on the host — that is what
# makes account creation self-service without authd ever touching a container
# runtime. Safe to run any time: it does nothing when there is nothing pending.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'converge-users: no .env in %s\n' "$project_dir" >&2; exit 1; }

if ! pending="$(docker compose -f compose.yaml exec -T authd /app/authd --pending 2>/dev/null)"; then
    printf 'converge-users: authd is not running; nothing to do\n' >&2
    exit 0
fi
[ -n "$pending" ] || exit 0

printf '%s\n' "$pending" | while IFS= read -r email; do
    [ -n "$email" ] || continue
    "$project_dir/scripts/provision-user.sh" "$email" \
        || printf 'converge-users: %s failed; will retry\n' "$email" >&2
done
