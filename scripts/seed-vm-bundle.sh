#!/bin/sh
#
# Seed a user's Cowork VM bundle from a pristine master by reflinking it on the
# same btrfs. A reflinked copy is byte-identical, so the app's checksums still
# pass, but it shares every extent — measured at Exclusive 0.00 B, i.e. the
# 10 GiB image costs nothing until that guest actually writes.
#
#   seed-vm-bundle.sh MASTER_BUNDLE_DIR USER_BUNDLE_DIR
#
# MASTER_BUNDLE_DIR is a known-good `claudevm.bundle` (for example one the app
# has already downloaded). USER_BUNDLE_DIR is the `claudevm.bundle` inside a new
# user's config: <config>/Claude-3p/vm_bundles/claudevm.bundle.
set -eu

master="${1:?usage: seed-vm-bundle.sh MASTER_BUNDLE_DIR USER_BUNDLE_DIR}"
dest="${2:?usage: seed-vm-bundle.sh MASTER_BUNDLE_DIR USER_BUNDLE_DIR}"

if [ ! -d "$master" ]; then
    printf 'seed-vm-bundle: master bundle not found: %s\n' "$master" >&2
    exit 1
fi
mkdir -p "$dest"

# The static, shareable members. Reflink each; fall back to a plain copy only if
# the filesystem cannot (which would defeat the purpose — check btrfs next).
for file in \
    rootfs.img rootfs.img.zst \
    vmlinuz vmlinuz.zst \
    initrd initrd.zst \
    initrd-micro initrd-micro.zst \
    efivars.fd
do
    [ -e "$master/$file" ] || continue
    [ -e "$dest/$file" ] && continue
    if cp -a --reflink=always "$master/$file" "$dest/$file" 2>/dev/null; then
        :
    else
        printf 'seed-vm-bundle: WARNING: %s was copied, not reflinked (btrfs?)\n' "$file" >&2
        cp -a "$master/$file" "$dest/$file"
    fi
done

# sessiondata.img is deliberately NOT seeded: it is the user's own state, not
# the master's. Whether the app creates it on first start or needs a sparse file
# to exist is exactly what the Stage 2 spike checks — if it needs one, add
#   truncate -s 10G "$dest/sessiondata.img"
# here.

printf 'seed-vm-bundle: seeded %s from %s\n' "$dest" "$master"
printf 'apparent: '; du -sh --apparent-size "$dest" 2>/dev/null || true
printf 'real:     '; du -sh "$dest" 2>/dev/null || true
if command -v btrfs >/dev/null 2>&1; then
    printf 'btrfs:    '; btrfs filesystem du -s "$dest" | tail -1
else
    printf 'btrfs filesystem du is unavailable here; confirm sharing on the host.\n'
fi
