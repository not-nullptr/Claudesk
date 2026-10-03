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

TOOLS=/workspace/tools
GHIDRA_DIR=$TOOLS/ghidra
JDK_DIR=$TOOLS/jdk21
REPO_DIR=$TOOLS/pyghidra-mcp
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
    $PY -m zipfile -e "$TOOLS/ghidra.zip" "$TOOLS/"
    ln -sfn "$TOOLS"/ghidra_12.*_PUBLIC "$GHIDRA_DIR"
fi

# Container passwd lists home as /dev/null, and the JDK takes user.home from
# passwd (not $HOME) — Ghidra's LaunchSupport then refuses to start. Pin it.
grep -q "^VMARGS_LINUX=-Duser.home=" "$GHIDRA_DIR/support/launch.properties" || \
    printf '\n# pyghidra-mcp: container passwd home is /dev/null; pin JVM user.home\nVMARGS_LINUX=-Duser.home=/config\n' >> "$GHIDRA_DIR/support/launch.properties"

if [ ! -x "$JDK_DIR/bin/java" ]; then
    [ -f "$TOOLS/jdk21.tar.gz" ] || curl -sL --retry 3 -o "$TOOLS/jdk21.tar.gz" "$JDK_URL"
    $PY -m tarfile -e "$TOOLS/jdk21.tar.gz" "$TOOLS/"
    ln -sfn "$TOOLS"/jdk-21.* "$JDK_DIR"
fi

[ -d "$REPO_DIR" ] || git clone --depth 1 https://github.com/clearbluejar/pyghidra-mcp "$REPO_DIR"

mkdir -p /workspace/ghidra-projects

# Warm the dependency cache so the first MCP launch isn't slow.
GHIDRA_INSTALL_DIR="$GHIDRA_DIR" JAVA_HOME="$JDK_DIR" \
    "$UV" --version >/dev/null

echo "ghidra-mcp toolchain ready:"
echo "  GHIDRA_INSTALL_DIR=$GHIDRA_DIR"
echo "  JAVA_HOME=$JDK_DIR"
echo "  pyghidra-mcp source=$REPO_DIR"
