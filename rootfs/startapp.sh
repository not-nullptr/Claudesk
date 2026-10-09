#!/bin/sh

set -eu

export HOME=/config
export XDG_CONFIG_HOME=/config/.config
export XDG_CACHE_HOME=/config/.cache
export ELECTRON_OZONE_PLATFORM_HINT=x11

# Auto permission mode reviews shell and network tool calls with a safety
# classifier, and the classifier model is resolved, not fixed: Claude Code tries
# a Sonnet 5 default on the session's first auto-mode request and, when the
# provider is not the Anthropic API and that model is unavailable, falls back to
# an Opus model — `ANTHROPIC_DEFAULT_OPUS_MODEL` when set, otherwise Opus 5.
# This stack's gateway carries neither, so the fallback requests claude-opus-5,
# the gateway answers "temporarily unavailable", and every fetch/exec trips
# "auto mode cannot determine the safety of <tool>". Point the fallback at a
# model the gateway serves (see CLAUDE_AUTO_MODE_MODEL). Exported before the app
# is exec'd so the Code engine Desktop spawns inherits it. It also remaps the
# `opus` model alias for the whole session, which is inert here — the Code
# surface offers the gateway's own models, not the alias.
if [ -n "${CLAUDE_AUTO_MODE_MODEL:-}" ]; then
    export ANTHROPIC_DEFAULT_OPUS_MODEL="${CLAUDE_AUTO_MODE_MODEL}"
    printf '[claude-start] auto-mode classifier fallback model=%s\n' \
        "${CLAUDE_AUTO_MODE_MODEL}"
fi

mkdir -p \
    "$XDG_CONFIG_HOME" \
    "$XDG_CACHE_HOME" \
    /config/log \
    /workspace

# Electron's singleton links live in the persistent profile.  A container
# replacement gives the process namespace a new lifetime, so a lock pointing
# at the previous container can collide with an unrelated reused PID and make
# the official app exit immediately.  These links contain no user data.
rm -f \
    /config/.config/Claude/SingletonCookie \
    /config/.config/Claude/SingletonLock \
    /config/.config/Claude/SingletonSocket \
    /config/.config/Claude-3p/SingletonCookie \
    /config/.config/Claude-3p/SingletonLock \
    /config/.config/Claude-3p/SingletonSocket

installed_version="$(dpkg-query -W -f='${Version}' claude-desktop 2>/dev/null || printf 'unknown')"
printf '[claude-start] launching official Claude Desktop %s\n' "$installed_version"

set -- \
    --ozone-platform=x11 \
    --disable-setuid-sandbox \
    --password-store=basic

if [ "${CLAUDE_DISABLE_GPU:-1}" = "1" ]; then
    set -- "$@" --disable-gpu
fi

if [ "${COWORK_BRIDGE_ENABLED:-0}" = "1" ]; then
    printf '[claude-start] Cowork IPC wrapper enabled on loopback:%s\n' \
        "${COWORK_BRIDGE_INTERNAL_PORT:-9222}"
fi

exec /usr/bin/claude-desktop "$@"
