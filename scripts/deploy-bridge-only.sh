#!/bin/sh
#
# Roll out a change that lives in the bridge, without touching a single desktop
# container.
#
#   sh scripts/deploy-bridge-only.sh
#
# deploy.sh is the whole deployment: it rebuilds every image and recreates every
# account's desktop container, which is what a renderer or Desktop fix needs. It
# is also minutes of work, most of it the renderer preparation each desktop
# container runs at startup — for output that only changes when the renderer
# patches do. A bridge fix (an API document, a shim, the remote bridge itself)
# needs none of that: those containers serve the browser, and recycling them is
# enough.
#
# The guard is the point. Bridge and desktop images are stamped from the same
# config/release.json, so if that file moved — a patchRelease bump, which is what
# a renderer change ships with — this refuses and points at deploy.sh instead.
# Rolling a renderer change out this way would look like it worked and change
# nothing, which is the failure scripts/lib/image-release.sh exists to prevent.
set -eu

project_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

git pull --ff-only

[ -f .env ] || { printf 'deploy-bridge-only: no .env in %s\n' "$project_dir" >&2; exit 1; }

# shellcheck source=scripts/lib/image-release.sh
. "$project_dir/scripts/lib/image-release.sh"

expected="$(sed -n 's/.*"patchRelease"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$project_dir/config/release.json" | head -n 1)"
for spec in \
    "local/claude-cowork-bridge:latest /app/release.json" \
    "local/claudesk-desktop:official-linux /opt/claude-cowork-bridge/release.json"
do
    image="${spec%% *}"
    path="${spec##* }"
    current="$(image_release "$image" "$path")"
    if [ "$current" != "$expected" ]; then
        printf 'deploy-bridge-only: %s carries release %s, this checkout wants %s\n' \
            "$image" "${current:-nothing}" "$expected" >&2
        printf 'deploy-bridge-only: config/release.json moved, so the desktop image must be\n' >&2
        printf 'deploy-bridge-only: rebuilt too — run sh deploy.sh instead.\n' >&2
        exit 1
    fi
done

# Stop the bridge on its own first, as deploy.sh does: it serves the browser's
# event stream from the *desktop* container's namespace, so it warns the
# connected pages, holds, and only then exits.
if sudo docker compose -f compose.yaml ps --status running --services 2>/dev/null \
    | grep -qx cowork-bridge; then
    sudo docker compose -f compose.yaml stop -t 30 cowork-bridge
fi

sudo docker compose -f compose.yaml build cowork-bridge
sudo docker compose -f compose.yaml up -d --force-recreate cowork-bridge

# Each account's bridge is a container of the same image, so it needs the new one
# too — and only it. The desktops stay up, which is also why nobody mid-turn is
# interrupted by this.
CLAUDESK_RECREATE_SERVICES=cowork-bridge sudo "$project_dir/scripts/refresh-users.sh"

printf 'deploy-bridge-only: bridge image rolled out; desktops left running\n'
