#!/bin/sh
#
# Install the guest-side Code runner into an account's Cowork VM.
#
#   sudo scripts/install-guest-runner.sh EMAIL
#
# Run it on the host, with the account's VM stopped. It mounts that account's
# guest rootfs (rootfs.img, ext4, LABEL=cloudimg-rootfs) and writes in a systemd
# service that runs guest/runner.py from boot:
#
#   /opt/claudesk/runner.py                        the runner
#   /etc/claudesk/runner.env                       its environment (pool + bridge)
#   /etc/systemd/system/claudesk-code-runner.service
#
# Why the guest's own disk and not the host: there is no host-to-guest exec API.
# The Desktop starts the VM with `{bundlePath, memoryGB, cpuCount, …}` and
# nothing else, the guest cannot be dialled into (QEMU user-mode networking, no
# hostfwd), and the app's own "push a payload into the guest" path is internal to
# its main process. The one thing we do control is this disk: it is per account,
# on the host, and this deployment already patches it for the vsock port.
#
# Two things must be true for the service to do anything:
#
#   * the VM must be stopped (a running VM has this image mounted), and
#   * the guest must be able to reach the bridge. It reaches the container
#     through QEMU's user-mode gateway, http://10.0.2.2:8080, which is where the
#     bridge listens — but the guest has its own egress allowlist, so a
#     deployment that restricts egress has to allow it
#     (CLAUDE_EGRESS_ALLOWED_HOSTS_JSON).
#
# The image is rebuilt with every Desktop release (docs/desktop-2.42304-review.md),
# so this is re-derived on an update exactly like the vsock-port patch: re-run it
# after the bundle is re-seeded. It is idempotent — the payload is stamped, and a
# second run with the same stamp and the same pool does nothing.
set -eu

email="${1:?usage: install-guest-runner.sh EMAIL}"
project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'install-guest-runner: no .env in %s\n' "$project_dir" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. ./.env
set +a

# shellcheck source=scripts/lib/slug.sh
. "$project_dir/scripts/lib/slug.sh"

data_root="${CLAUDESK_DATA_ROOT:-/opt/claudesk/data}"
slug="$(claudesk_slug "$email")"
user_root="$data_root/users/$slug"
bundle="$user_root/config/.config/Claude-3p/vm_bundles/claudevm.bundle"
rootfs="$bundle/rootfs.img"
state="$user_root/bridge-data/code-runners.json"

[ -f "$rootfs" ] || { printf 'install-guest-runner: no guest image at %s\n' "$rootfs" >&2; exit 1; }
[ -f "$state" ] || {
    printf 'install-guest-runner: %s has no pool yet (%s)\n' "$email" "$state" >&2
    printf 'install-guest-runner: provision and start it first, so the bridge mints one\n' >&2
    exit 1
}

pool_id="$(jq -r '.pools[0].pool_id // empty' "$state")"
secret="$(jq -r '.pools[0].secret // empty' "$state")"
if [ -z "$pool_id" ] || [ -z "$secret" ]; then
    printf 'install-guest-runner: %s holds no pool (yet)\n' "$state" >&2
    exit 1
fi

# The guest reaches the container on slirp's host address. Overridable because a
# deployment that gives its VMs a different network (a tap, a proxy) needs
# another address.
runner_base="${CLAUDESK_GUEST_RUNNER_BASE:-http://10.0.2.2:8080}"
claude_bin="${CLAUDESK_GUEST_CLAUDE_BIN:-/opt/cowork/claude-bin}"
checkout="${CLAUDESK_GUEST_CHECKOUT:-/sessions}"

# A stamp over everything that lands in the image, so a re-run with an unchanged
# payload and the same pool is a no-op while an edited runner is applied.
stamp="$(cat "$project_dir/guest/runner.py" "$project_dir/scripts/install-guest-runner.sh" \
    | sha256sum | cut -d' ' -f1)"
stamp="$stamp:$pool_id:$runner_base:$claude_bin:$checkout"

mount_dir="$(mktemp -d)"
loop_device=""
cleanup() {
    if mountpoint -q "$mount_dir" 2>/dev/null || grep -q " $mount_dir " /proc/mounts 2>/dev/null; then
        umount "$mount_dir" || true
    fi
    [ -z "$loop_device" ] || losetup -d "$loop_device" || true
    rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

# The VM must not have the image open. Writing behind a running guest would
# corrupt it, and the guest mounts this image itself — so ask the account's own
# container whether its VM is up, falling back to the host's mount table when
# docker is not reachable from here.
desktop_container="${slug}-claude-desktop"
if command -v docker >/dev/null 2>&1 &&
    docker exec "$desktop_container" pgrep -f qemu-system-x86_64 >/dev/null 2>&1; then
    printf 'install-guest-runner: %s has a running Cowork VM; stop it first\n' "$email" >&2
    printf 'install-guest-runner: it idle-stops on its own (CLAUDE_COWORK_VM_IDLE_MINUTES)\n' >&2
    exit 1
fi
if grep -q "rootfs.img" /proc/mounts 2>/dev/null; then
    printf 'install-guest-runner: a guest image is mounted on the host; stop the VM first\n' >&2
    exit 1
fi

printf 'install-guest-runner: attaching %s\n' "$rootfs" >&2
loop_device="$(losetup --find --partscan --show "$rootfs")"
# Partition nodes can be missing even with --partscan (an older kernel, or a
# loop device created without it), and the labels are only there if blkid can
# read them — so this asks again rather than trusting the first answer, and
# falls back to the whole device for an image that carries no partition table.
refresh_partitions() {
    partx -u "$loop_device" >/dev/null 2>&1 || partprobe "$loop_device" >/dev/null 2>&1 || true
    sleep 0.2
}
find_root_part() {
    # `-l` matters: without it lsblk draws a tree and the name column comes back
    # as "├─/dev/loop0p1", which is not a device anyone can mount. The sed is a
    # second line of defence for an lsblk that drops the glyphs somewhere else.
    as_device() { printf '%s\n' "$1" | sed 's|^[^/]*||'; }
    candidate="$(lsblk -lpno NAME,LABEL "$loop_device" 2>/dev/null |
        awk '$2 == "cloudimg-rootfs" { print $1; exit }')"
    [ -z "$candidate" ] || { as_device "$candidate"; return; }
    candidate="$(lsblk -lpno NAME,FSTYPE "$loop_device" 2>/dev/null |
        awk '$2 == "ext4" { print $1; exit }')"
    [ -z "$candidate" ] || { as_device "$candidate"; return; }
    # No partition table: the filesystem is the image.
    if blkid -s TYPE -o value "$loop_device" 2>/dev/null | grep -qx ext4; then
        printf '%s\n' "$loop_device"
    fi
}
# An operator who already knows the device can name it and skip the detection.
root_part="${CLAUDESK_GUEST_ROOT_PART:-}"
if [ -z "$root_part" ]; then
    root_part="$(find_root_part)"
fi
if [ -z "$root_part" ]; then
    refresh_partitions
    root_part="$(find_root_part)"
fi
if [ -z "$root_part" ]; then
    printf 'install-guest-runner: no ext4 root found in %s. What is there:\n' "$rootfs" >&2
    lsblk -fo NAME,SIZE,FSTYPE,LABEL "$loop_device" >&2 || true
    printf 'install-guest-runner: (the guest boots an ext4 labelled cloudimg-rootfs;\n' >&2
    printf 'install-guest-runner:  set CLAUDESK_GUEST_ROOT_PART=/dev/loopXpN to name it)\n' >&2
    exit 1
fi
printf 'install-guest-runner: root partition %s\n' "$root_part" >&2

mount "$root_part" "$mount_dir"

if [ -f "$mount_dir/etc/claudesk/runner.stamp" ] &&
    [ "$(cat "$mount_dir/etc/claudesk/runner.stamp")" = "$stamp" ]; then
    printf 'install-guest-runner: %s is already current\n' "$email" >&2
    exit 0
fi

install -d "$mount_dir/opt/claudesk" "$mount_dir/etc/claudesk" \
    "$mount_dir/etc/systemd/system/multi-user.target.wants"
install -m 0755 "$project_dir/guest/runner.py" "$mount_dir/opt/claudesk/runner.py"

umask 077
cat > "$mount_dir/etc/claudesk/runner.env" <<ENV
# Written by scripts/install-guest-runner.sh — the pool this guest serves and
# the bridge it serves it to. Regenerated on each install.
CLAUDESK_RUNNER_BASE=$runner_base
CLAUDESK_RUNNER_SECRET=$secret
CLAUDESK_RUNNER_CLAUDE_BIN=$claude_bin
CLAUDESK_RUNNER_CHECKOUT=$checkout
ENV
chmod 0600 "$mount_dir/etc/claudesk/runner.env"
printf '%s\n' "$stamp" > "$mount_dir/etc/claudesk/runner.stamp"

cat > "$mount_dir/etc/systemd/system/claudesk-code-runner.service" <<'UNIT'
[Unit]
Description=Claudesk Code runner (self-hosted pool)
Documentation=https://github.com/not-nullptr/Claudesk/blob/main/docs/code-in-cowork-vm.md
# The guest's own daemon owns the session disks and the shared directory; the
# runner only talks to the bridge and spawns the agent.
After=network-online.target coworkd.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/claudesk/runner.env
ExecStart=/usr/bin/python3 /opt/claudesk/runner.py
Restart=always
RestartSec=5
# The agent runs with the session's own user inside the guest; this process only
# polls and writes events, so it needs nothing beyond its own files.
NoNewPrivileges=yes
ProtectHome=read-only
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
ln -sf ../claudesk-code-runner.service \
    "$mount_dir/etc/systemd/system/multi-user.target.wants/claudesk-code-runner.service"

umount "$mount_dir"
trap - EXIT HUP INT TERM
cleanup

printf 'install-guest-runner: installed for %s (pool %s -> %s)\n' "$email" "$pool_id" "$runner_base"
printf 'install-guest-runner: the service starts on the guest'"'"'s next boot\n'
