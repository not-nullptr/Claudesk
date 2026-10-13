#!/bin/sh
set -eu

# Bring this deployment up to date, and bring every provisioned account with it.
#
#   1. pull this checkout,
#   2. build and recreate the deployment's own services,
#   3. recreate each account's instance, so an image fix reaches them all.
#
# The gateway chain (compose.gateway.yaml) is box-level and started once per
# host — separately — so it is not part of this.
#
# Run as the deploy user, not as root: the pull lands in their checkout. The
# steps that need root ask for it.

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
cd "$project_dir"

# --ff-only: a deployment pull that would need a merge is a mistake to make
# quietly on a running host.
git pull --ff-only

sudo docker compose -f compose.yaml \
    up -d --build --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback authd

# Only after authd above is the rebuilt one, so --provisioned answers from the
# new binary. Accounts are recreated one at a time; a failure is reported and
# leaves that account on what it was running.
sudo "$project_dir/scripts/refresh-users.sh"
