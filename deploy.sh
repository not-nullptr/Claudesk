#!/bin/sh
set -eu

# Build and (re)start this deployment's services, plus the loopback relays from
# compose.gateway.yaml that reach the box-level gateway chain. The chain itself
# (`shitproxy` + the caddy `gateway`) belongs to whichever stack owns it and is
# reached over gateway_net — this deployment must not start it, or it would take
# the box's routing away from every other deployment here (see that file).
# Deploy runs on the host against rootful Docker.
exec sudo docker compose \
    -f compose.yaml -f compose.gateway.yaml \
    up -d --build --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback
