#!/bin/sh
#
# Build the prepared renderer generation once, for the whole box to adopt.
#
#   sh scripts/seed-renderer.sh
#
# Preparing the renderer means parsing ion-dist's chunks with acorn to find the
# patch targets — tens of seconds of CPU, and until now every desktop container
# paid it again for a result that is byte-identical to its neighbours': the
# generation is a pure function of the ion-dist, the release and two flags. On a
# box with N accounts, deploying used to cost N of those, competing for cores.
#
# This runs the desktop image's own preparer in a throwaway container, into a
# directory the desktop service mounts read-only, once per flag combination the
# accounts actually use. Every container then adopts the generation that matches
# its inputs instead of computing it (see CLAUDESK_RENDERER_SEED in compose.yaml
# and prepare-renderer.mjs). Deploying costs one preparation instead of N.
#
# Nothing here is load-bearing for correctness: a container whose inputs match no
# seed prepares its own, exactly as before. A failed run is a slower deploy.
#
# The image must already be built (deploy.sh builds it first).
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

[ -f .env ] || { printf 'seed-renderer: no .env in %s\n' "$project_dir" >&2; exit 1; }

set -a
# shellcheck source=/dev/null
. ./.env
set +a

# The same image the desktop service runs, and the same release it carries. A
# seed built from another image would be for another ion-dist, and a container
# given it would find the keys disagree and prepare its own.
image="${CLAUDESK_DESKTOP_IMAGE:-local/claudesk-desktop:official-linux}"
version="${CLAUDE_DESKTOP_VERSION:?set CLAUDE_DESKTOP_VERSION in .env}"
seed_dir="${CLAUDESK_RENDERER_SEED_DIR:-/opt/claudesk/data/renderer-seed}"

# shellcheck source=scripts/lib/account-scope.sh
. "$project_dir/scripts/lib/account-scope.sh"

# The flag combinations that exist: the deployment's own instance (tenant=0)
# carries the deployment's values, a provisioned account is a tenant (tenant=1)
# and is scoped by role. All three matter — the gateway flag is spliced into the
# renderer and the tenant flag withholds the local Code route alias, so each
# combination is its own generation.
webshell="${CLAUDE_REMOTE_WEB_SHELL:-0}"
gateway_deployment="${CLAUDE_REMOTE_GATEWAY_SETTINGS:-0}"
account_scope User
gateway_user="$ACCOUNT_GATEWAY_SETTINGS"
account_scope Admin
gateway_admin="$ACCOUNT_GATEWAY_SETTINGS"

# Under the data root, which is root's; the containers write it as root too.
sudo mkdir -p "$seed_dir"

built=""
for spec in "$gateway_deployment:$webshell:0" "$gateway_admin:$webshell:1" \
    "$gateway_user:$webshell:1"; do
    case " $built " in *" $spec "*) continue ;; esac
    built="$built $spec"
    gateway="${spec%%:*}"
    rest="${spec#*:}"
    shell_flag="${rest%%:*}"
    tenant_flag="${rest##*:}"
    printf 'seed-renderer: preparing for gateway=%s web-shell=%s tenant=%s\n' \
        "$gateway" "$shell_flag" "$tenant_flag" >&2
    # `--entrypoint node` skips the image's /init: the container init scripts
    # patch the app and write configuration, which needs a whole desktop's worth
    # of environment and has nothing to do with preparing a renderer. This runs
    # the preparer alone, against the image's own ion-dist and release.json.
    sudo docker run --rm \
        --entrypoint node \
        -e CLAUDE_DESKTOP_VERSION="$version" \
        -e CLAUDE_REMOTE_GATEWAY_SETTINGS="$gateway" \
        -e CLAUDE_REMOTE_WEB_SHELL="$shell_flag" \
        -e CLAUDESK_TENANT="$tenant_flag" \
        -e CLAUDESK_RENDERER_SEED_PUBLISH=/seed \
        -e CLAUDESK_RENDERER_JOBS="${CLAUDESK_RENDERER_JOBS:-8}" \
        -v "$seed_dir:/seed" \
        "$image" \
        /opt/claude-cowork-bridge/prepare-renderer.mjs \
        /usr/lib/claude-desktop/resources/ion-dist \
        /tmp/renderer-state \
        /opt/claude-cowork-bridge/release.json
done

printf 'seed-renderer: seed directory %s now holds:\n' "$seed_dir" >&2
find "$seed_dir" -maxdepth 1 -mindepth 1 -type d -printf '  %f\n' 2>/dev/null || true
