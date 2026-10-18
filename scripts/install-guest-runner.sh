#!/bin/sh
#
# Install the guest-side Code runner into an account's Cowork VM.
#
#   sudo scripts/install-guest-runner.sh EMAIL
#   sudo scripts/install-guest-runner.sh EMAIL --status
#
# It stops the account's Cowork VM itself when one is running (the write needs
# the image closed, and the guest's ext4 journal takes the power-cut; the next
# placed session wakes the VM again), stages the account's *own* Claude Code
# into the guest as /opt/claudesk/claude — the product's binary at
# /opt/cowork/claude-bin refuses outside a coworkd session ("no session for
# this uid") — and carries the account's model endpoint and key into the
# guest's root-only env so the agent can answer.
#
# `--status` mounts the image read-only and reports what is in it — whether the
# payload, agent and service are present and current for this checkout and
# pool, and where the live logs are. It is the check to run when a session says
# "Waiting for a runner…": the bridge log says whether a runner ever polled,
# and this says whether one is installed to poll at all.
#
# Run it on the host, with the account's VM stopped. It mounts that account's
# guest rootfs (rootfs.img, ext4, LABEL=cloudimg-rootfs) and writes in a systemd
# service that runs guest/runner.py from boot:
#
#   /opt/claudesk/runner.py                        the runner
#   /opt/claudesk/claude                           the agent it runs (staged)
#   /etc/claudesk/runner.env                       its environment (pool, bridge,
#                                                  agent, model endpoint)
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
#   * the image must be closed (this script stops a running VM itself), and
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

email="${1:?usage: install-guest-runner.sh EMAIL [--status]}"
mode="${2:-}"
case "$mode" in
    ""|--status) ;;
    *) printf 'install-guest-runner: unknown argument %s\n' "$mode" >&2; exit 1 ;;
esac
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
checkout="${CLAUDESK_GUEST_CHECKOUT:-/sessions}"

# The agent the runner executes. The guest's own /opt/cowork/claude-bin/claude
# is the product's session-bound SDK binary: run it outside a coworkd session
# and it refuses ("claude: no session for this uid"). What gets staged here is
# the account's *own* Claude Code — the same native binary its Desktop runs —
# found in its container and copied into the guest as /opt/claudesk/claude.
# Override with CLAUDESK_GUEST_CLAUDE_SOURCE: `container:/path` (docker cp) or
# a host path (installed).
desktop_container="${slug}-claude-desktop"
container_running=false
if command -v docker >/dev/null 2>&1 &&
    docker exec "$desktop_container" true >/dev/null 2>&1; then
    container_running=true
fi

# What gets staged has to be a *plain* Claude Code. Every claude build the
# product itself ships is cowork-flavoured and talks to coworkd instead of
# answering: the guest's staged SDK binary refuses outside a session ("claude:
# no session for this uid"), and the Desktop container's own copy forwards the
# prompt into coworkd's ask-claude socket ("claude: send: write unix
# @->/run/coworkd/ask-claude.sock: write: broken pipe"). Neither is patched
# here — nothing about the product is modified — the runner is simply given
# the upstream binary: found in the account's container when a plain one is
# there (large, and without the cowork socket), else fetched once from the
# pinned npm artifact (the same native package the Desktop installs from) and
# cached under the account's data root, so later installs need no network.
agent_version="${CLAUDESK_GUEST_CLAUDE_VERSION:-2.1.295}"
agent_source="${CLAUDESK_GUEST_CLAUDE_SOURCE:-}"
if [ -z "$agent_source" ] && [ "$container_running" = true ]; then
    agent_source="$(docker exec "$desktop_container" sh -c '
        for p in /usr/local/bin/claude "$HOME/.local/share/claude/claude" \
                 /opt/claude/claude; do
            [ -f "$p" ] || continue
            size=$(stat -c %s "$p" 2>/dev/null || echo 0)
            [ "$size" -gt 100000000 ] && { echo "$p"; exit 0; }
        done
        find /usr/local /opt /root /home -maxdepth 8 -type f -name claude -size +100M 2>/dev/null |
            while read -r candidate; do
                if ! grep -q "ask-claude.sock" "$candidate" 2>/dev/null; then
                    echo "$candidate"
                    break
                fi
            done
    ' 2>/dev/null || true)"
    [ -z "$agent_source" ] || agent_source="$desktop_container:$agent_source"
fi
agent_download=""
if [ -z "$agent_source" ]; then
    agent_cache="$user_root/bridge-data/guest-claude-$agent_version"
    if [ ! -s "$agent_cache" ]; then
        agent_url="https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-$agent_version.tgz"
        agent_download="$(mktemp)"
        printf 'install-guest-runner: fetching Claude Code %s for staging\n' "$agent_version" >&2
        if ! curl -fsSL --connect-timeout 20 "$agent_url" 2>/dev/null |
            tar -xzO package/claude > "$agent_download" 2>/dev/null || [ ! -s "$agent_download" ]; then
            printf 'install-guest-runner: could not fetch %s\n' "$agent_url" >&2
            printf 'install-guest-runner: set CLAUDESK_GUEST_CLAUDE_SOURCE=container:/path to a plain claude\n' >&2
            exit 1
        fi
        chmod 0755 "$agent_download"
        mv "$agent_download" "$agent_cache" 2>/dev/null || cp "$agent_download" "$agent_cache"
        agent_download=""
    fi
    chmod 0755 "$agent_cache" 2>/dev/null || true
    agent_source="$agent_cache"
fi

# Where the agent's model calls go. The guest's egress is its own allowlist —
# dialing the account's gateway directly from inside the VM is not something to
# rely on (a blocked call hangs rather than fails) — so they go through the
# bridge on the one address the guest provably reaches (it polls over it), and
# the bridge forwards them to the gateway with the account's own credentials.
# The pass is the pool secret, which this file already carries.

if [ -n "$agent_source" ]; then
    claude_bin="${CLAUDESK_GUEST_CLAUDE_BIN:-/opt/claudesk/claude}"
else
    # Nothing to stage: fall back to the product's path, which only works
    # inside a coworkd session — said out loud rather than discovered later.
    claude_bin="${CLAUDESK_GUEST_CLAUDE_BIN:-/opt/cowork/claude-bin}"
    printf 'install-guest-runner: no agent source found; the guest keeps its own %s\n' "$claude_bin" >&2
    printf 'install-guest-runner: set CLAUDESK_GUEST_CLAUDE_SOURCE=container:/path to stage one\n' >&2
fi

# What the agent is invoked with — flag for flag what the product's own runner
# passes its child (read from the shipped binary's spawn: `--print`, stream-json
# both ways, `--verbose`, partial messages), minus `--sdk-url`, whose compiled
# host allowlist only admits Anthropic's own endpoints. The prompt never rides
# argv: the runner writes it to the agent's stdin as a stream-json message, so
# the agent is never started "without a prompt". The Desktop's own behaviour is
# untouched; this only shapes how the runner asks.
agent_args="${CLAUDESK_GUEST_RUNNER_ARGS:---print --input-format stream-json --output-format stream-json --verbose --include-partial-messages}"
# The agent's model calls ride the bridge (below); its own nonessential traffic
# (update checks, telemetry) would ride the guest's narrow egress allowlist,
# where a blocked call hangs rather than fails, and none of it is needed to
# answer.
model_env="ANTHROPIC_BASE_URL=\"$runner_base\"
ANTHROPIC_AUTH_TOKEN=\"$secret\"
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1"

# A stamp over everything that lands in the image, so a re-run with an unchanged
# payload and the same pool is a no-op while an edited runner, a new agent or a
# rotated secret is applied. The secret itself never lands in the stamp — only
# enough of its hash to make a rotation re-run the install.
stamp="$(cat "$project_dir/guest/runner.py" "$project_dir/scripts/install-guest-runner.sh" \
    | sha256sum | cut -d' ' -f1)"
stamp="$stamp:$pool_id:$runner_base:$claude_bin:$checkout:$agent_source"
stamp="$stamp:$(printf '%s' "$secret" | sha256sum | cut -c1-16)"

mount_dir="$(mktemp -d)"
loop_device=""
cleanup() {
    if mountpoint -q "$mount_dir" 2>/dev/null || grep -q " $mount_dir " /proc/mounts 2>/dev/null; then
        umount "$mount_dir" || true
    fi
    [ -z "$loop_device" ] || losetup -d "$loop_device" || true
    [ -z "${agent_download:-}" ] || rm -f "$agent_download"
    rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

# The VM must not have the image open while it is written — the guest mounts it
# itself. A running VM is stopped here rather than refused: the ask that
# matters is "make the write safe", the account's container can end its own
# QEMU the way its idle-stop does, and the guest's ext4 journal takes the
# power-cut. The next placed session wakes the VM again (the bridge asks the
# Desktop to start it on placement). `--status` mounts read-only and is left
# alone.
if [ "$mode" != "--status" ] && [ "$container_running" = true ] &&
    docker exec "$desktop_container" pgrep -f qemu-system-x86_64 >/dev/null 2>&1; then
    printf 'install-guest-runner: stopping the Cowork VM of %s for the write\n' "$email" >&2
    docker exec "$desktop_container" pkill -f qemu-system-x86_64 >/dev/null 2>&1 || true
    waited=0
    while [ "$waited" -lt 30 ] &&
        docker exec "$desktop_container" pgrep -f qemu-system-x86_64 >/dev/null 2>&1; do
        sleep 1
        waited=$((waited + 1))
    done
    if docker exec "$desktop_container" pgrep -f qemu-system-x86_64 >/dev/null 2>&1; then
        printf 'install-guest-runner: VM did not stop in 30s; force-killing\n' >&2
        docker exec "$desktop_container" pkill -9 -f qemu-system-x86_64 >/dev/null 2>&1 || true
        sleep 2
    fi
fi
if [ "$mode" != "--status" ] && grep -q "rootfs.img" /proc/mounts 2>/dev/null; then
    printf 'install-guest-runner: a guest image is still mounted on the host; cannot write safely\n' >&2
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

if [ "$mode" = "--status" ]; then
    mount -o ro "$root_part" "$mount_dir" || {
        printf 'install-guest-runner: could not read the image (is the VM mounting it?); stop the VM and retry\n' >&2
        exit 1
    }
    printf 'install-guest-runner: %s — guest Code runner\n' "$email"
    if [ -f "$mount_dir/etc/claudesk/runner.stamp" ]; then
        if [ "$(cat "$mount_dir/etc/claudesk/runner.stamp")" = "$stamp" ]; then
            printf '  payload:  installed, current for this checkout and pool\n'
        else
            printf '  payload:  installed, but stale — re-run without --status to update\n'
        fi
    else
        printf '  payload:  absent — the image was re-derived by a Desktop update, or never had it\n'
        printf '            (re-run this script without --status)\n'
    fi
    if [ -f "$mount_dir/opt/claudesk/claude" ]; then
        printf '  agent:    staged at /opt/claudesk/claude (%s bytes)\n' \
            "$(stat -c %s "$mount_dir/opt/claudesk/claude")"
    else
        printf '  agent:    none staged — the runner falls back to the product binary, which\n'
        printf '            refuses outside a coworkd session ("no session for this uid")\n'
    fi
    if [ -f "$mount_dir/etc/claudesk/runner.env" ]; then
        grep -E '^CLAUDESK_RUNNER_(BASE|CLAUDE_BIN|CHECKOUT|AGENT_ARGS)=' "$mount_dir/etc/claudesk/runner.env" \
            | sed 's/^/  /'
        grep -E '^ANTHROPIC_BASE_URL=' "$mount_dir/etc/claudesk/runner.env" | sed 's/^/  /'
        printf '  secret:   present (not printed)\n'
    else
        printf '  env:      absent — the service has no pool to talk to\n'
    fi
    if [ -e "$mount_dir/etc/systemd/system/multi-user.target.wants/claudesk-code-runner.service" ]; then
        printf '  service:  enabled at boot\n'
    else
        printf '  service:  not enabled — it would never start\n'
    fi
    printf '  with the VM running, the live answers are:\n'
    printf '    bridge:  sudo docker logs --since 30m %s-claude-cowork-bridge 2>&1 | grep -E "runner ccrunner|placed on pool|started on pool"\n' "$slug"
    printf '    guest:   journalctl -u claudesk-code-runner -n 50   (inside the guest)\n'
    exit 0
fi

mount "$root_part" "$mount_dir"

if [ -f "$mount_dir/etc/claudesk/runner.stamp" ] &&
    [ "$(cat "$mount_dir/etc/claudesk/runner.stamp")" = "$stamp" ]; then
    printf 'install-guest-runner: %s is already current\n' "$email" >&2
    exit 0
fi

install -d "$mount_dir/opt/claudesk" "$mount_dir/etc/claudesk" \
    "$mount_dir/etc/systemd/system/multi-user.target.wants"
# The agent's HOME: the unit runs with ProtectHome=read-only, so the guest's
# /root cannot hold the transcripts `--resume` replays; this can.
install -d -m 0700 "$mount_dir/var/lib/claudesk-runner/home"
install -m 0755 "$project_dir/guest/runner.py" "$mount_dir/opt/claudesk/runner.py"

if [ -n "$agent_source" ]; then
    printf 'install-guest-runner: staging the agent from %s\n' "$agent_source" >&2
    case "$agent_source" in
        *:*) docker cp "$agent_source" "$mount_dir/opt/claudesk/claude" ;;
        *) install -m 0755 "$agent_source" "$mount_dir/opt/claudesk/claude" ;;
    esac
    chmod 0755 "$mount_dir/opt/claudesk/claude"
fi

umask 077
cat > "$mount_dir/etc/claudesk/runner.env" <<ENV
# Written by scripts/install-guest-runner.sh — the pool this guest serves, the
# bridge it serves it to, the agent it runs and the account's model endpoint.
# Regenerated on each install; root-only. A session placed with a folder names a
# host path (/workspace/...); the runner maps it onto the guest's shared root,
# /mnt/.virtiofs-root unless CLAUDESK_RUNNER_SHARED_ROOT says otherwise.
CLAUDESK_RUNNER_BASE=$runner_base
CLAUDESK_RUNNER_SECRET=$secret
CLAUDESK_RUNNER_CLAUDE_BIN=$claude_bin
CLAUDESK_RUNNER_CHECKOUT=$checkout
# The account's shared workspace is bound back at /workspace in the guest (see
# guest/runner.py), so a session and a shell see the same path as the container.
CLAUDESK_RUNNER_WORKSPACE_ALIAS=/workspace
CLAUDESK_RUNNER_AGENT_ARGS="$agent_args"
$model_env
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
