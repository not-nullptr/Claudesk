#!/bin/sh
#
# Provision an instance for every account that still needs one.
#
#   [CLAUDESK_RECONCILE_JOBS=4] scripts/converge-users.sh
#
# Run as root — it drives Docker and creates directories owned by PUID:PGID.
# authd itself never does; that is the point.
#
# Two things call this: the systemd `.path` unit
# (ops/systemd/claudesk-provision.path) fires it the moment authd drops a
# provisioning request, so a new account is created on the event rather than on
# a poll; and claudesk-provision.timer runs it every 20 s as a backstop. Safe to
# run any time — it does nothing when nothing is pending.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

# shellcheck source=scripts/lib/reconcile.sh
. "$project_dir/scripts/lib/reconcile.sh"

[ -f .env ] || { printf 'converge-users: no .env in %s\n' "$project_dir" >&2; exit 1; }

# Empty the watch spool first: the `.path` unit fires while the directory is
# non-empty, so it has to be clear before we finish or it would either loop the
# unit or miss the next account. A request that lands mid-run just re-fires it.
# The path is derived exactly as install-reconciler.sh derives it, so the unit and
# this script always agree on which directory to watch.
data_root="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?CLAUDESK_DATA_ROOT=[[:space:]]*//p' .env | tail -n 1)"
data_root="$(printf '%s' "$data_root" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$data_root" ] || data_root=/opt/claudesk/data
spool="$data_root/auth-data/provision-requests"
if [ -d "$spool" ]; then
    rm -f "$spool"/* 2>/dev/null || true
fi

if ! pending="$(docker compose -f compose.yaml exec -T authd /app/authd --pending 2>/dev/null)"; then
    printf 'converge-users: authd is not running; nothing to do\n' >&2
    exit 0
fi
[ -n "$pending" ] || exit 0

list="$(mktemp)"
trap 'rm -f "$list"' EXIT HUP INT TERM
printf '%s\n' "$pending" > "$list"

if reconcile_list "$project_dir" "$list"; then
    printf 'converge-users: provisioned %s account(s)\n' "$RECONCILE_OK"
    exit 0
fi
printf 'converge-users: provisioned %s account(s), %s failed\n' \
    "$RECONCILE_OK" "$RECONCILE_FAIL" >&2
exit 1
