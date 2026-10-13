#!/bin/sh

set -eu

# Give this instance's Cowork VM a vsock port of its own.
#
# The guest reaches the host over vsock: the guest's `coworkd` dials (host CID 2,
# port 51234) and the host's `cowork-linux-helper` listens on the same port. Both
# values are compile-time constants with no flag or env behind them, and
# host-side vsock listeners go through the single host `/dev/vhost-vsock`, so
# that port is global per *host* — two instances on one box cannot both run a
# Cowork VM (the second gets "address already in use"). Moving each instance's
# pair to a port of its own is the only way to run more than one.
#
# Set CLAUDESK_VM_VSOCK_PORT to a port unique to this instance (the deployment
# and every account must differ). Unset keeps the app's default and changes
# nothing.
#
# CLAUDESK_VM_VSOCK_GUEST_SITES tells this script whether the guest must be
# patched too:
#   0 (default)  the guest follows the host — patch only the helper. Use this
#                only after confirming the guest dials the port the host was
#                given (see docs/vsock-port.md).
#   N            the guest image hardcodes the port; rewrite N sites in
#                rootfs.img (encoding from CLAUDESK_VM_VSOCK_GUEST_ENCODING,
#                default `bb`).
#
# The helper is never written in place: it is copied into the instance's
# persistent root, patched there, and bind-mounted over the original path. A
# bind mount lives only for the container's life, so an app update brings a
# pristine helper back and this script re-derives the patch — no stale patched
# binary can shadow a newer one.

port="${CLAUDESK_VM_VSOCK_PORT:-}"
[ -n "$port" ] || exit 0

case "$port" in
    ''|*[!0-9]*)
        printf '[cowork-vsock] CLAUDESK_VM_VSOCK_PORT must be a port number, got %s\n' "$port" >&2
        exit 1
        ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    printf '[cowork-vsock] CLAUDESK_VM_VSOCK_PORT %s is outside 1024-65535\n' "$port" >&2
    exit 1
fi

default_port=51234
if [ "$port" -eq "$default_port" ]; then
    printf '[cowork-vsock] port %s is the default; nothing to do\n' "$port"
    exit 0
fi

patcher="${CLAUDESK_VM_VSOCK_PATCHER:-/opt/claude-cowork-bridge/patch-vsock-port.mjs}"
helper="${CLAUDESK_VM_VSOCK_HELPER:-/usr/lib/claude-desktop/resources/cowork-linux-helper}"
state="${CLAUDESK_VM_VSOCK_STATE:-/var/lib/claudesk-vsock}"
patched="$state/cowork-linux-helper"

guest_sites="${CLAUDESK_VM_VSOCK_GUEST_SITES:-0}"
case "$guest_sites" in
    ''|*[!0-9]*)
        printf '[cowork-vsock] CLAUDESK_VM_VSOCK_GUEST_SITES must be a count, got %s\n' "$guest_sites" >&2
        exit 1
        ;;
esac
guest_encoding="${CLAUDESK_VM_VSOCK_GUEST_ENCODING:-bb}"
bundle="${CLAUDESK_VM_BUNDLE_DIR:-/config/.config/Claude-3p/vm_bundles/claudevm.bundle}"

# The guest image carries the other half of the pair. Patch it first: a host that
# moved its port while the guest still dials the default would send this
# instance's guest at whichever helper still holds the default.
if [ "$guest_sites" -gt 0 ]; then
    image="$bundle/rootfs.img"
    [ -f "$image" ] || { printf '[cowork-vsock] guest image %s not found\n' "$image" >&2; exit 1; }
    if ! /usr/bin/node "$patcher" patch \
        --file "$image" --port "$port" --default "$default_port" \
        --encoding "$guest_encoding" --expect "$guest_sites"; then
        printf '[cowork-vsock] guest rootfs.img does not match the expected %s site(s); refusing to move only half the pair\n' \
            "$guest_sites" >&2
        printf '[cowork-vsock] run: node %s scan --file %s --encoding all\n' "$patcher" "$image" >&2
        exit 1
    fi
fi

install -d -m 0700 "$state"
# `$helper` resolves through the overlay to the image's file: the bind mount below
# is the only thing that ever changes what it holds, and that mount is gone on
# the next container start. So this copy is always the pristine helper.
cp -f "$helper" "$patched"
if ! /usr/bin/node "$patcher" patch \
    --file "$patched" --port "$port" --default "$default_port" --encoding bb --expect 1; then
    printf '[cowork-vsock] cowork-linux-helper does not carry the expected port site; refusing to patch\n' >&2
    exit 1
fi

mountpoint -q "$helper" && umount "$helper"
mount --bind "$patched" "$helper"
printf '[cowork-vsock] Cowork VM vsock port set to %s (guest sites patched: %s)\n' "$port" "$guest_sites"
