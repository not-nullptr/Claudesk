#!/bin/sh
set -eu

# Build and (re)start every service: Claudesk itself plus the operator's
# gateway chain in compose.gateway.yaml (shitproxy is a locally-built image,
# see that file). Deploy runs on the host against rootful Docker.
exec sudo docker compose \
    -f compose.yaml -f compose.gateway.yaml \
    up -d --build --force-recreate \
    claude-desktop cowork-bridge claude-gateway-loopback \
    claude-mobile claude-mobile-gateway-loopback shitproxy
