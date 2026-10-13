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
# (default 4) at a time.

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
        sudo docker compose -f compose.gateway.yaml up -d
    else
        printf 'deploy: no shitproxy checkout at %s; leaving the gateway image as-is\n' \
            "$shitproxy_dir" >&2
    fi
fi

sudo docker compose -f compose.yaml \
    up -d --build --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback authd

# Only after authd above is the rebuilt one, so --provisioned answers from the
# new binary. Recreate the accounts that have an instance, then create any that
# are still pending — a freshly invited account the reconciler has not reached
# yet is pending, not provisioned, so refresh alone would skip it.
sudo "$project_dir/scripts/refresh-users.sh"
sudo "$project_dir/scripts/converge-users.sh"
