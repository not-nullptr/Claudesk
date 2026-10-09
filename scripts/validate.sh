#!/bin/sh

set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

find bridge bridge-wrapper rootfs/opt \
    -type d -name node_modules -prune -o \
    -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
    -exec node --check {} \;

find rootfs scripts -type f -name '*.sh' -exec sh -n {} \;

# Lifted out of the Frida probe, so it checks the reader the probe actually runs.
node tools/frida/swift-string-harness.mjs

node scripts/security-smoke.mjs
node scripts/session-file-smoke.mjs
node scripts/office-preview-smoke.mjs
node scripts/official-index-smoke.mjs
node scripts/bridge-parity-smoke.mjs
node scripts/greeting-smoke.mjs
node scripts/account-smoke.mjs
node scripts/account-settings-smoke.mjs
node scripts/update-resilience-smoke.mjs
node scripts/renderer-patches-smoke.mjs
node scripts/renderer-runtime-smoke.mjs
node scripts/updater-smoke.mjs
node scripts/workspace-folders-smoke.mjs
node scripts/preload-file-open-smoke.mjs
node scripts/attachment-mentions-smoke.mjs
node scripts/upload-stream-smoke.mjs
node scripts/totp-smoke.mjs
node scripts/desktop-translators-smoke.mjs
node scripts/code-events-smoke.mjs
node scripts/mobile-image-smoke.mjs
node scripts/mobile-api-smoke.mjs
node scripts/folder-picker-ui-smoke.mjs
node scripts/code-preferences-smoke.mjs
node scripts/start-permission-mode-smoke.mjs
node scripts/cowork-skip-approvals-smoke.mjs
node scripts/model-selector-state-smoke.mjs
node scripts/realtime-stream-smoke.mjs
node scripts/renderer-relay-smoke.mjs

jq -e . \
    bridge/public/manifest.webmanifest \
    bridge-wrapper/package.json \
    security/claude-desktop.json \
    >/dev/null

if command -v shellcheck >/dev/null 2>&1; then
    find rootfs scripts -type f -name '*.sh' -print0 \
        | xargs -0 shellcheck
else
    printf '%s\n' 'validate: shellcheck is unavailable; skipped shell lint' >&2
fi

if docker compose version >/dev/null 2>&1; then
    # Compose requires the env_file path to exist even when CI supplies overrides.
    validation_env_created=0

    # Remove only the temporary file created by this validation run.
    cleanup_validation_env() {
        if [ "$validation_env_created" -eq 1 ]; then
            rm -f .env
        fi
    }

    # Keep local developer credentials intact while making CI validation self-contained.
    trap cleanup_validation_env 0 HUP INT TERM
    if [ ! -f .env ]; then
        cp .env.example .env
        validation_env_created=1
    fi

    CLAUDE_GATEWAY_BASE_URL=https://gateway.example.invalid \
    CLAUDE_GATEWAY_API_KEY=validation-placeholder \
    CLAUDE_INFERENCE_MODELS_JSON='["claude-validation-model"]' \
    CLAUDE_MOBILE_API_EMAIL=validation@example.invalid \
    CLAUDE_MOBILE_API_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ \
        docker compose config --quiet

    # Remove the temporary file before reporting success and disable the trap.
    cleanup_validation_env
    trap - 0 HUP INT TERM
else
    printf '%s\n' 'validate: Docker Compose is unavailable; skipped Compose validation' >&2
fi

printf '%s\n' 'validate: all available checks passed'
