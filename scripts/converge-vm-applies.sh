#!/bin/sh
#
# Recreate every account whose admin asked to apply saved VM specs.
#
#   scripts/converge-vm-applies.sh
#
# Run as root — it drives Docker, through provision-user.sh. Two things call it:
# the systemd `.path` unit (ops/systemd/claudesk-vm-apply.path) fires it the
# moment authd drops a request, so an admin's Apply lands on the event; the
# `.timer` is the backstop for a request written while the host was down or a
# reconcile that failed. The files ARE the work list (each carries the account's
# email), and a request is removed only after provision-user.sh succeeds, so a
# failure stays queued rather than silently leaving the dashboard's applied
# values stale forever.
#
# Serial on purpose: each request force-recreates an account's Desktop, bridge
# and gateway relay, which stops its VM and interrupts any running turn. A
# burst of Applies is better spread out than raced.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'converge-vm-applies: no .env in %s\n' "$project_dir" >&2; exit 1; }

# Derive the spool the same way the other converge scripts and the installer do,
# without sourcing .env (it may reference values this script must not evaluate).
data_root="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?CLAUDESK_DATA_ROOT=[[:space:]]*//p' .env | tail -n 1)"
data_root="$(printf '%s' "$data_root" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$data_root" ] || data_root=/opt/claudesk/data
spool="$data_root/auth-data/vm-apply-requests"

[ -d "$spool" ] || exit 0

ok=0
fail=0
for request in "$spool"/*; do
    [ -f "$request" ] || continue
    email="$(sed -n 's/^email=//p' "$request" | head -n 1)"
    if [ -z "$email" ]; then
        printf 'converge-vm-applies: %s carries no email; dropping\n' "$request" >&2
        rm -f "$request"
        continue
    fi
    if "$project_dir/scripts/provision-user.sh" "$email"; then
        rm -f "$request"
        ok=$((ok + 1))
    else
        printf 'converge-vm-applies: %s failed; leaving its request queued\n' "$email" >&2
        fail=$((fail + 1))
    fi
done

if [ "$fail" -eq 0 ]; then
    if [ "$ok" -gt 0 ]; then
        printf 'converge-vm-applies: applied VM specs for %s account(s)\n' "$ok"
    fi
    exit 0
fi
printf 'converge-vm-applies: applied %s account(s), %s failed\n' "$ok" "$fail" >&2
exit 1
