#!/bin/sh
#
# Tear down every account a delete has queued, and clear their requests.
#
#   scripts/converge-deprovisions.sh
#
# Run as root — it drives Docker and removes PUID:PGID directories. Two things
# call it: the systemd `.path` unit (ops/systemd/claudesk-deprovision.path) fires
# it the moment authd drops a deprovision request, so an admin's deletion is
# reclaimed on the event rather than on a poll; and claudesk-deprovision.timer
# runs it as a backstop, which also catches a delete taken while the host was down
# (its request waits in the spool) or a teardown that failed.
#
# Unlike converge-users.sh this cannot re-derive its list from authd: the accounts
# are already gone from the database, which is exactly why each request carries its
# own payload. So the spool files ARE the work list, and each is removed only after
# its teardown succeeds — a failure stays queued and is retried, never silently
# leaked. The runs are serial: a teardown stops a Desktop container and deletes a
# multi-GiB data root apiece, so a burst is better spread out than raced.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'converge-deprovisions: no .env in %s\n' "$project_dir" >&2; exit 1; }

# The spool lives under the deployment's data root, next to the authd database.
# Read it without sourcing .env (it may reference values this script has no
# business evaluating), the same shape converge-users.sh and install-reconciler.sh
# use so all three agree on the path.
data_root="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?CLAUDESK_DATA_ROOT=[[:space:]]*//p' .env | tail -n 1)"
data_root="$(printf '%s' "$data_root" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$data_root" ] || data_root=/opt/claudesk/data
spool="$data_root/auth-data/deprovision-requests"

[ -d "$spool" ] || exit 0

ok=0
fail=0
for request in "$spool"/*; do
    [ -f "$request" ] || continue
    email="$(sed -n 's/^email=//p' "$request" | head -n 1)"
    if [ -z "$email" ]; then
        printf 'converge-deprovisions: %s carries no email; dropping\n' "$request" >&2
        rm -f "$request"
        continue
    fi
    if "$project_dir/scripts/deprovision-user.sh" "$email"; then
        rm -f "$request"
        ok=$((ok + 1))
    else
        printf 'converge-deprovisions: %s failed; leaving its request queued\n' "$email" >&2
        fail=$((fail + 1))
    fi
done

if [ "$fail" -eq 0 ]; then
    if [ "$ok" -gt 0 ]; then
        printf 'converge-deprovisions: deprovisioned %s account(s)\n' "$ok"
    fi
    exit 0
fi
printf 'converge-deprovisions: deprovisioned %s account(s), %s failed\n' "$ok" "$fail" >&2
exit 1
