#!/bin/sh
#
# Install (or refresh) this deployment's reconciler systemd units.
#
#   sudo scripts/install-reconciler.sh [CHECKOUT] [NAME]
#
# Renders claudesk[-NAME]-provision.{service,timer,path} into /etc/systemd/system
# from the templates in ops/systemd/, with this checkout's paths baked in, then
# enables the .path unit (fires the moment authd drops a provisioning request)
# and the .timer (a 20 s backstop). CHECKOUT defaults to this script's checkout;
# NAME defaults to empty, giving the plain claudesk-provision.* names.
#
# Run it once per deployment. Two deployments on one box carry the same unit
# names otherwise, and one would silently drive the other's accounts — pass a
# distinct NAME for the second (e.g. `... /opt/claudesk-v2 v2`). NAME must match
# [a-z0-9-].
set -eu

here="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
checkout="${1:-$(CDPATH='' cd -- "$here/.." && pwd)}"
name="${2:-}"

if [ -n "$name" ]; then
    case "$name" in
        ''|*[!a-z0-9-]*)
            printf 'install-reconciler: NAME must match [a-z0-9-]\n' >&2
            exit 2
            ;;
    esac
fi

[ -d "$checkout" ] || { printf 'install-reconciler: no checkout at %s\n' "$checkout" >&2; exit 1; }
[ -f "$checkout/.env" ] || { printf 'install-reconciler: no .env in %s\n' "$checkout" >&2; exit 1; }

templates="$checkout/ops/systemd"
for unit in service timer path; do
    [ -f "$templates/claudesk-provision.$unit.in" ] \
        || { printf 'install-reconciler: missing %s/claudesk-provision.%s.in\n' "$templates" "$unit" >&2; exit 1; }
done

# The spool the .path unit watches lives under the deployment's data root, next
# to the authd database. Read it without sourcing .env (it may reference values
# this installer has no business evaluating).
data_root="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?CLAUDESK_DATA_ROOT=[[:space:]]*//p' "$checkout/.env" | tail -n 1)"
data_root="$(printf '%s' "$data_root" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$data_root" ] || data_root=/opt/claudesk/data
spool="$data_root/auth-data/provision-requests"

stem="claudesk"
[ -n "$name" ] && stem="claudesk-$name"

unit_dir="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
install -d "$unit_dir"

for unit in service timer path; do
    target="$unit_dir/$stem-provision.$unit"
    sed -e "s|@NAME@|$stem|g" \
        -e "s|@CHECKOUT@|$checkout|g" \
        -e "s|@SPOOL@|$spool|g" \
        "$templates/claudesk-provision.$unit.in" > "$target"
    printf 'install-reconciler: wrote %s\n' "$target"
done

if [ "$(id -u)" = 0 ]; then
    systemctl daemon-reload
    systemctl enable --now "$stem-provision.path" "$stem-provision.timer"
    printf 'install-reconciler: enabled %s-provision.path and %s-provision.timer\n' "$stem" "$stem"
else
    printf 'install-reconciler: not root — wrote units but did not reload or enable them\n' >&2
fi
