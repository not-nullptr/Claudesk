#!/bin/sh
set -eu

# Rebuild and restart the Desktop stack. The Cowork bridge and the office
# preview share the Desktop network namespace, so the gateway relay is
# recreated alongside it.
#
# The bridge is stopped on its own first: it serves the browser's event stream
# from that namespace, so recreating it together with the Desktop container cuts
# the route before the bridge's restart warning can reach anyone. Stopped alone,
# it warns the connected pages (holds CLAUDE_REMOTE_SHUTDOWN_NOTICE_MS, then
# exits) while the route is still up.
sudo docker compose -f compose.yaml build claude-desktop cowork-bridge
if sudo docker compose -f compose.yaml ps --status running --services 2>/dev/null \
    | grep -qx cowork-bridge; then
    sudo docker compose -f compose.yaml stop -t 30 cowork-bridge
fi
sudo docker compose -f compose.yaml \
    up -d --force-recreate claude-desktop cowork-bridge claude-gateway-loopback
