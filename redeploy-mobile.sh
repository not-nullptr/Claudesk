#!/bin/sh
set -eu

# Rebuild and restart the mobile API and its gateway relay.
sudo docker compose -f compose.yaml -f compose.gateway.yaml \
    up -d --build --force-recreate claude-mobile claude-mobile-gateway-loopback
