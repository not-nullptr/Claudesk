#!/bin/sh
#
# Install (or refresh) this deployment's reconciler systemd units.
#
#   sudo scripts/install-reconciler.sh [CHECKOUT] [NAME]
#
# Renders claudesk[-NAME]-provision.{service,timer,path} and
# claudesk[-NAME]-deprovision.{service,timer,path} into /etc/systemd/system from
# the templates in ops/systemd/, with this checkout's paths baked in, then enables
# the .path units (they fire the moment authd drops a provisioning or a
# deprovisioning request) and the .timers (their backstops). CHECKOUT defaults to
# this script's checkout; NAME defaults to empty, giving the plain
# claudesk-provision.* / claudesk-deprovision.* names.
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
for kind in provision deprovision; do
    for unit in service timer path; do
        [ -f "$templates/claudesk-$kind.$unit.in" ] \
            || { printf 'install-reconciler: missing %s/claudesk-%s.%s.in\n' "$templates" "$kind" "$unit" >&2; exit 1; }
    done
done

# The spools the .path units watch live under the deployment's data root, next to
# the authd database. Read it without sourcing .env (it may reference values this
# installer has no business evaluating).
data_root="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?CLAUDESK_DATA_ROOT=[[:space:]]*//p' "$checkout/.env" | tail -n 1)"
data_root="$(printf '%s' "$data_root" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$data_root" ] || data_root=/opt/claudesk/data
spool="$data_root/auth-data/provision-requests"
deprovision_spool="$data_root/auth-data/deprovision-requests"

stem="claudesk"
[ -n "$name" ] && stem="claudesk-$name"

unit_dir="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
install -d "$unit_dir"

render() {
    kind="$1"
    spool_for="$2"
    for unit in service timer path; do
        target="$unit_dir/$stem-$kind.$unit"
        sed -e "s|@NAME@|$stem|g" \
            -e "s|@CHECKOUT@|$checkout|g" \
            -e "s|@SPOOL@|$spool_for|g" \
            "$templates/claudesk-$kind.$unit.in" > "$target"
        printf 'install-reconciler: wrote %s\n' "$target"
    done
}
render provision "$spool"
render deprovision "$deprovision_spool"

if [ "$(id -u)" = 0 ]; then
    systemctl daemon-reload
    systemctl enable --now "$stem-provision.path" "$stem-provision.timer" \
        "$stem-deprovision.path" "$stem-deprovision.timer"
    printf 'install-reconciler: enabled %s-provision.* and %s-deprovision.*\n' "$stem" "$stem"
else
    printf 'install-reconciler: not root — wrote units but did not reload or enable them\n' >&2
fi
