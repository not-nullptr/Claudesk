#!/bin/sh
set -eu

# Bring up this deployment. The gateway chain (compose.gateway.yaml) is box-level
# and started once per host — separately — so it is not part of this.
exec sudo docker compose -f compose.yaml \
    up -d --build --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback authd
