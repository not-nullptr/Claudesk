#!/usr/bin/env bash
# Shared-server mode: run ONE pyghidra-mcp JVM on 127.0.0.1:8000/mcp that every
# Claude Code session connects to as an HTTP client (repo .mcp.json -> type http).
# Ghidra locks a project to a single process, so this is what lets multiple
# sessions share one analysis instead of each spawning a stdio server that dies
# with LockException. Start it before sessions connect; it must stay running.
#
#   setsid nohup tools/ghidra-mcp/serve-http.sh >/dev/null 2>&1 &
#
# Log: $PYGHIDRA_HTTP_LOG or /workspace/ghidra-projects/http-server.log
set -euo pipefail

TOOLS=/workspace/tools
PROJECT_DIR=/workspace/ghidra-projects
PROJECT_NAME=claude-ipa
LOG=${PYGHIDRA_HTTP_LOG:-$PROJECT_DIR/http-server.log}

export HOME=/config
export GHIDRA_INSTALL_DIR=$TOOLS/ghidra
export JAVA_HOME=$TOOLS/jdk21
export JAVA_HOME_OVERRIDE=$TOOLS/jdk21
export PATH=$TOOLS/jdk21/bin:/config/xdg/bin:/usr/bin:/bin
export PYGHIDRA_INDEX_WORKERS=${PYGHIDRA_INDEX_WORKERS:-2}
export PYGHIDRA_INDEX_BATCH=${PYGHIDRA_INDEX_BATCH:-256}
export PYGHIDRA_DECOMPILER_POOL=${PYGHIDRA_DECOMPILER_POOL:-3}

# The existing project already has the analyzed binary; no input_paths needed
# (matches the previous stdio config, which also passed none).
exec "$TOOLS/pyghidra-mcp/.venv/bin/pyghidra-mcp" \
  --transport streamable-http \
  --host 127.0.0.1 --port 8000 \
  --project-path "$PROJECT_DIR" \
  --project-name "$PROJECT_NAME" \
  "$@" >>"$LOG" 2>&1 </dev/null
