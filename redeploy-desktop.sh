#!/bin/sh
set -eu

# Rebuild and restart the Desktop stack. The Cowork bridge and the office
# preview share the Desktop network namespace, so the gateway relay is
# recreated alongside it.
sudo docker compose -f compose.yaml build claude-desktop cowork-bridge
sudo docker compose -f compose.yaml \
    up -d --force-recreate claude-desktop cowork-bridge claude-gateway-loopback
