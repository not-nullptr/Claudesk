#!/bin/bash
set -euxo pipefail

STATE=/persistent-root
BASE=/mnt/claudesk-base
ROOT=/mnt/claudesk-root

echo "[persistent-root] starting"

###############################################################################
# Mount setup
###############################################################################

# Don't propagate our mount surgery outside this container's mount namespace.
mount --make-rprivate /

mkdir -p \
    "$STATE/upper" \
    "$STATE/work" \
    "$BASE" \
    "$ROOT"

###############################################################################
# Capture the fresh upstream Docker image as the read-only-ish lower layer.
#
# Non-recursive bind is intentional. We do NOT want Docker's /config,
# /workspace, /dev, /proc, etc mounts folded into the lower layer.
###############################################################################

mount --bind / "$BASE"

###############################################################################
# Persistent writable root
###############################################################################

echo "[persistent-root] mounting overlay"

mount -t overlay overlay \
    -o "lowerdir=$BASE,upperdir=$STATE/upper,workdir=$STATE/work" \
    "$ROOT"

###############################################################################
# Runtime/kernel mounts
###############################################################################

echo "[persistent-root] binding runtime filesystems"

for path in dev proc sys run; do
    mkdir -p "$ROOT/$path"
    mount --rbind "/$path" "$ROOT/$path"
    mount --make-rslave "$ROOT/$path"
done

###############################################################################
# ClauDesk's existing persistent mounts
###############################################################################

echo "[persistent-root] binding claudesk persistent directories"

for path in config workspace; do
    mkdir -p "$ROOT/$path"

    if mountpoint -q "/$path"; then
        mount --rbind "/$path" "$ROOT/$path"
        mount --make-rslave "$ROOT/$path"
    fi
done

###############################################################################
# Docker-managed identity/network files
###############################################################################

echo "[persistent-root] binding docker-managed /etc files"

mkdir -p "$ROOT/etc"

for path in hosts hostname resolv.conf; do
    if [ ! -e "$ROOT/etc/$path" ]; then
        touch "$ROOT/etc/$path"
    fi

    if mountpoint -q "/etc/$path"; then
        mount --bind "/etc/$path" "$ROOT/etc/$path"
    fi
done

###############################################################################
# pivot_root
#
# DO NOT use chroot here.
#
# Chromium uses CLONE_NEWUSER for its namespace sandbox. Linux rejects that
# from a chroot environment with EPERM. pivot_root makes the persistent
# overlay the actual root mount instead.
###############################################################################

echo "[persistent-root] pivoting into persistent root"

mkdir -p "$ROOT/.oldroot"

cd "$ROOT"
pivot_root . .oldroot
cd /

###############################################################################
# Hide the old Docker root.
#
# We cannot actually unmount it because our OverlayFS lowerdir/upperdir backing
# mounts are reachable through it. Mask it instead so applications/agents
# don't accidentally operate on the ephemeral Docker root.
###############################################################################

mount -t tmpfs \
    -o "mode=000,nodev,nosuid,noexec,size=4096" \
    tmpfs /.oldroot

###############################################################################
# Launch original image command (/init)
###############################################################################

echo "[persistent-root] launching: $*"

exec "$@"
