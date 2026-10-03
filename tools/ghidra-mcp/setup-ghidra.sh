#!/usr/bin/env bash
# Idempotent installer for the Ghidra MCP toolchain (survives container rebuilds).
#
# Installs into /workspace/tools (persistent volume):
#   - uv (package manager, also provides managed Python)
#   - Temurin JDK 21
#   - Ghidra 12.1.4
#   - clearbluejar/pyghidra-mcp clone (run via `uvx --from`)
#
# The MCP server itself is registered in .mcp.json; run this script once after
# a rebuild so the paths it references exist, then start/restart the session.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

TOOLS=/workspace/tools
GHIDRA_DIR=$TOOLS/ghidra
JDK_DIR=$TOOLS/jdk21
REPO_DIR=$TOOLS/pyghidra-mcp
# The streaming/parallel index patch below is cut against this exact upstream
# commit. Pinning the clone keeps it from rotting against a moving HEAD.
PYGHIDRA_MCP_PIN=323fbdb29dfed42241e6574806223a3454aca908
GHIDRA_ZIP=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
JDK_URL="https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"

mkdir -p "$TOOLS"

if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
UV=$(command -v uv || echo "$HOME/xdg/bin/uv")
PY="$UV run --no-project --python 3.12 python"

if [ ! -x "$GHIDRA_DIR/support/analyzeHeadless" ]; then
    [ -f "$TOOLS/ghidra.zip" ] || curl -sL --retry 3 -o "$TOOLS/ghidra.zip" "$GHIDRA_ZIP"
    $PY - <<'PYEOF'
import zipfile, os
dest = "/workspace/tools/"
z = zipfile.ZipFile(dest + "ghidra.zip")
for info in z.infolist():
    z.extract(info, dest)
    mode = info.external_attr >> 16
    if mode:
        os.chmod(os.path.join(dest, info.filename), mode)
print("extracted", len(z.infolist()), "entries with mode bits")
PYEOF
    ln -sfn "$TOOLS"/ghidra_12.*_PUBLIC "$GHIDRA_DIR"
fi

# Container passwd lists home as /dev/null, and the JDK takes user.home from
# passwd (not $HOME) — Ghidra's LaunchSupport then refuses to start. Pin it.
grep -q "^VMARGS_LINUX=-Duser.home=" "$GHIDRA_DIR/support/launch.properties" || \
    printf '\n# pyghidra-mcp: container passwd home is /dev/null; pin JVM user.home\nVMARGS_LINUX=-Duser.home=/config\n' >> "$GHIDRA_DIR/support/launch.properties"

# pyghidra's launcher reads VMARGS from launch.properties and hands it to the JVM.
# An -Xmx sized off the HOST's RAM (e.g. -Xmx16G on a 125GB box) overcommits a
# container whose cgroup limit is far lower: the JVM never collects until it is
# past memory.max, then the OOM killer reaps it mid-index. Size the heap to the
# container instead, and rewrite any existing -Xmx so a previously hand-edited
# launch.properties is corrected too.
LAUNCH_PROPS="$GHIDRA_DIR/support/launch.properties"
LIMIT_BYTES=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
if [[ "$LIMIT_BYTES" =~ ^[0-9]+$ ]] && [ "$LIMIT_BYTES" -gt 0 ]; then
    XMX_MB=$(( LIMIT_BYTES / 1024 / 1024 * 60 / 100 ))
else
    XMX_MB=4096
fi
if grep -q '^VMARGS=.*-Xmx' "$LAUNCH_PROPS"; then
    sed -i -E "/^VMARGS=/ s|-Xmx[0-9]+[A-Za-z]?|-Xmx${XMX_MB}M|" "$LAUNCH_PROPS"
else
    printf '\n# pyghidra-mcp: size JVM heap to the container cgroup, not the host\nVMARGS=-Xmx%sM\n' "$XMX_MB" >> "$LAUNCH_PROPS"
fi

if [ ! -x "$JDK_DIR/bin/java" ]; then
    [ -f "$TOOLS/jdk21.tar.gz" ] || curl -sL --retry 3 -o "$TOOLS/jdk21.tar.gz" "$JDK_URL"
    $PY -m tarfile -e "$TOOLS/jdk21.tar.gz" "$TOOLS/"
    ln -sfn "$TOOLS"/jdk-21.* "$JDK_DIR"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
    git clone https://github.com/clearbluejar/pyghidra-mcp "$REPO_DIR"
fi
# Fetch the pinned commit explicitly: a --depth 1 clone of the default branch
# may not contain it once upstream moves on.
git -C "$REPO_DIR" fetch --quiet origin "$PYGHIDRA_MCP_PIN" 2>/dev/null || true
git -C "$REPO_DIR" checkout --quiet --detach "$PYGHIDRA_MCP_PIN"

# Apply the local patches idempotently. A patch whose reverse already applies
# is in the tree; anything else is applied forward (and fails loudly if it
# conflicts, rather than silently shipping an unpatched indexer).
for patch in "$SCRIPT_DIR"/patches/*.patch; do
    [ -e "$patch" ] || continue
    if git -C "$REPO_DIR" apply --reverse --check "$patch" 2>/dev/null; then
        echo "already applied: $(basename "$patch")"
    else
        git -C "$REPO_DIR" apply "$patch"
        echo "applied: $(basename "$patch")"
    fi
done

# Install the (patched) source *editable* into a venv, and run the MCP server
# from it. `uvx --from <dir>` caches a built copy of the package and does NOT
# rebuild it when the files change, so a freshly patched tree is silently
# ignored and the server keeps running the previous code -- which cost a
# multi-hour index run that never wrote anything. An editable install reads the
# source directly, so edits (and patches) are live on the next start.
VENV_DIR=$REPO_DIR/.venv
"$UV" venv --python 3.12 --allow-existing "$VENV_DIR"
"$UV" pip install --python "$VENV_DIR/bin/python" -e "$REPO_DIR"

mkdir -p /workspace/ghidra-projects

# Warm the dependency cache so the first MCP launch isn't slow.
GHIDRA_INSTALL_DIR="$GHIDRA_DIR" JAVA_HOME="$JDK_DIR" \
    "$UV" --version >/dev/null

echo "ghidra-mcp toolchain ready:"
echo "  GHIDRA_INSTALL_DIR=$GHIDRA_DIR"
echo "  JAVA_HOME=$JDK_DIR"
echo "  JVM heap=-Xmx${XMX_MB}M (cgroup memory.max=$LIMIT_BYTES)"
echo "  pyghidra-mcp source=$REPO_DIR (pinned $PYGHIDRA_MCP_PIN)"
echo "  MCP server binary=$VENV_DIR/bin/pyghidra-mcp"
