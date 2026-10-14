#!/bin/sh
set -eu

# Warn every connected page that this instance is about to go down, ahead of a
# planned deploy:
#
#   scripts/announce-restart.sh
#   scripts/announce-restart.sh "Custom title" "Custom body"
#
# The bridge sends the same notice by itself when it is stopped (see its SIGTERM
# handler), but that fires at the moment of shutdown — this is for giving people
# a minute or two of warning *before* you stop the stack.
#
# The request goes over loopback inside the container, which is the point: the
# route has no separate auth (the bridge does no route-level authorization), so
# it must not be reachable through the proxy. Set
# CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS=1 on the bridge service or the route
# answers 404. The image is node:22-alpine — no curl — so use the node in there.

container="${CLAUDESK_BRIDGE_CONTAINER:-${CLAUDESK_NAME_PREFIX:-}claude-cowork-bridge}"

sudo docker exec \
  -e NOTICE_TITLE="${1-}" \
  -e NOTICE_DESCRIPTION="${2-}" \
  "$container" node -e '
    const port = process.env.BRIDGE_PORT || "8080";
    const payload = {};
    if (process.env.NOTICE_TITLE) payload.title = process.env.NOTICE_TITLE;
    if (process.env.NOTICE_DESCRIPTION) payload.description = process.env.NOTICE_DESCRIPTION;
    fetch(`http://127.0.0.1:${port}/api/remote/notice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      const text = await response.text();
      if (!response.ok) {
        console.error(`announce-restart: HTTP ${response.status}: ${text}`);
        process.exit(1);
      }
      console.log(`announce-restart: notice sent: ${text}`);
    }).catch((error) => {
      console.error(`announce-restart: ${error.message}`);
      process.exit(1);
    });
  '
