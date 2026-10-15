#!/bin/sh
set -eu

# Bring this deployment up to date, and bring every account with it.
#
#   1. pull this checkout,
#   2. build the shared shitproxy image and restart the box-level gateway chain
#      (compose.gateway.yaml), when a shitproxy checkout is present,
#   3. build and recreate the deployment's own services,
#   4. recreate each provisioned account's instance, so an image fix reaches them
#      all, and create any account that was still pending.
#
# Run as the deploy user, not as root: the pull lands in their checkout. The
# steps that need root ask for it. Accounts are reconciled CLAUDESK_RECONCILE_JOBS
# (default 8) at a time.

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

# One value out of .env, without sourcing it (the file is compose's, not this
# shell's). Same shape converge-users.sh uses to read CLAUDESK_DATA_ROOT.
env_value() {
    [ -f .env ] || return 0
    sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?$1=[[:space:]]*//p" .env \
        | tail -n 1 \
        | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# --ff-only: a deployment pull that would need a merge is a mistake to make
# quietly on a running host.
git pull --ff-only

# The gateway chain (shitproxy + its Caddy front door) is box-level and shared by
# every deployment on the host, so its image is built and the stack restarted only
# when the shitproxy checkout is actually here. A second deployment that must not
# touch the shared chain sets CLAUDESK_DEPLOY_GATEWAY=0; a checkout elsewhere sets
# SHITPROXY_DIR. Both may live in .env, and both can be overridden in the shell.
#
# `docker build` rather than `docker compose build`: the base compose.gateway.yaml
# deliberately carries no build context, so there is nothing for Compose to build
# without a local compose.override.yaml. Building here tags the image the base
# file already names (${SHITPROXY_IMAGE:-local/shitproxy:latest}), and the `up -d`
# below recreates shitproxy because its image changed.
deploy_gateway="${CLAUDESK_DEPLOY_GATEWAY:-$(env_value CLAUDESK_DEPLOY_GATEWAY)}"
deploy_gateway="${deploy_gateway:-1}"
shitproxy_dir="${SHITPROXY_DIR:-$(env_value SHITPROXY_DIR)}"
shitproxy_dir="${shitproxy_dir:-/workspace/shitproxy}"
shitproxy_image="${SHITPROXY_IMAGE:-$(env_value SHITPROXY_IMAGE)}"
shitproxy_image="${shitproxy_image:-local/shitproxy:latest}"

if [ "$deploy_gateway" = 1 ]; then
    if [ -f "$shitproxy_dir/Dockerfile" ]; then
        sudo docker build -t "$shitproxy_image" "$shitproxy_dir"
        # compose.gateway.yaml pins its own Compose project (name:), so a gateway
        # left by an older project name still holds the fixed `shitproxy` /
        # `gateway` container names and the pinned project cannot start ("name is
        # already in use"). Both carry their whole config in the image and /etc —
        # no volumes — so recreating them costs only the restart of the pull.
        for name in shitproxy gateway; do
            gateway_project="$(sudo docker inspect \
                -f '{{ index .Config.Labels "com.docker.compose.project" }}' \
                "$name" 2>/dev/null || true)"
            if [ -n "$gateway_project" ] && [ "$gateway_project" != claudesk-gateway ]; then
                printf 'deploy: %s belongs to compose project %s; recreating it under claudesk-gateway\n' \
                    "$name" "$gateway_project" >&2
                sudo docker rm -f "$name"
            fi
        done
        sudo docker compose -f compose.gateway.yaml up -d --remove-orphans
    else
        printf 'deploy: no shitproxy checkout at %s; leaving the gateway image as-is\n' \
            "$shitproxy_dir" >&2
    fi
fi

# Stop the bridge on its own first, before anything else is touched. It serves
# the browser's event stream from the *desktop* container's network namespace
# (network_mode: service:claude-desktop), so recreating the two together tears
# that route down at the same moment the bridge would be warning anyone — the
# notice goes out into a namespace nothing is listening on any more. Stopping
# the bridge alone leaves the route up while it broadcasts, holds
# CLAUDE_REMOTE_SHUTDOWN_NOTICE_MS and exits; the pages keep the warning after
# their stream drops, and the next bridge replays it to whoever reconnects.
if sudo docker compose -f compose.yaml ps --status running --services 2>/dev/null \
    | grep -qx cowork-bridge; then
    sudo docker compose -f compose.yaml stop -t 30 cowork-bridge
fi

# Build as its own step, before anything is recreated. `up -d --force-recreate`
# alone reuses the image, so a build that did not happen leaves every service —
# and, worse, every account, whose stack is recreated with no --build at all —
# running fresh containers around old code. Separating the build makes a failure
# attributable instead of silent.
sudo docker compose -f compose.yaml build \
    claude-desktop cowork-bridge claude-mobile authd

# Prove the images actually took before the accounts are recreated. This is the
# check whose absence cost an afternoon: the browser was served a renderer
# release from two deploys earlier, from an account stack recreated seconds
# before, with nothing anywhere reporting a problem.
# shellcheck source=scripts/lib/image-release.sh
. "$project_dir/scripts/lib/image-release.sh"
assert_images_current "$project_dir"

sudo docker compose -f compose.yaml up -d --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback authd

# Only after authd above is the rebuilt one, so --provisioned answers from the
# new binary. Recreate the accounts that have an instance, then create any that
# are still pending — a freshly invited account the reconciler has not reached
# yet is pending, not provisioned, so refresh alone would skip it.
sudo "$project_dir/scripts/refresh-users.sh"
sudo "$project_dir/scripts/converge-users.sh"

# What was built is not the same question as what is serving. The check above
# proves the images carry this release; it says nothing about the containers, and
# an instance nobody recreated goes on serving the old renderer while every
# command in this script reports success. That is not hypothetical: a browser was
# chased through three rounds of rebuilds that were all landing correctly, while
# the tab under test was served by an instance that had never been touched.
# Sweep what is actually listening and name anything left behind.
verify_instances() {
    expected="$1"
    stale=0
    for port in $(sudo docker ps --format '{{.Ports}}' \
        | grep -o '127\.0\.0\.1:[0-9]*' | cut -d: -f2 | sort -un); do
        release="$(curl -s --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null \
            | tr ',' '\n' | sed -n 's/.*"patchRelease":"\([^"]*\)".*/\1/p' | head -n 1)"
        # Anything that does not answer with a Claudesk release is not an
        # instance of ours — authd, the gateway, a plain HTTP port.
        [ -n "$release" ] || continue
        if [ "$release" != "$expected" ]; then
            printf 'deploy: instance on port %s still serves %s, not %s\n' \
                "$port" "$release" "$expected" >&2
            stale=1
        fi
    done
    if [ "$stale" -ne 0 ]; then
        printf '%s\n' \
            'deploy: an instance above was not recreated, and a browser is served' \
            'deploy: from whichever one its session maps to — whatever the images' \
            'deploy: say. Re-run this script, or recreate that account directly:' \
            'deploy:   sudo scripts/refresh-users.sh' >&2
    fi
    # A warning, not a failure: another Claudesk deployment on this host is
    # legitimately allowed to be on its own release.
    return 0
}
verify_instances "$RELEASE_EXPECTED"
