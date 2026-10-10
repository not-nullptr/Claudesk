#!/bin/sh

set -eu

# Reconcile the installed Desktop package with the image after an upgrade.
#
# This deployment boots from an overlay: the freshly built image is the lower
# layer and the persistent writable layer is the upper. A rebuilt image can
# never update a path the writable layer already carries, so a container
# upgrading from an older image still reports the old Desktop from dpkg (and
# still carries its files) — the wrapper's version guard then refuses the
# mismatch, and booting the old Desktop under the new environment is exactly
# what that guard exists to prevent.
#
# Discarding the writable layer would fix the version but lose every package
# installed at runtime. Instead, install the copy of the package the image
# itself ships (/opt/claude-desktop-package.deb, stashed by the Dockerfile)
# over the old one: Debian package tooling writes the new files and the dpkg
# record into the writable layer, keeps every other package registered, and
# the wrapper re-patches app.asar afterwards as it does after any upgrade.
# Images built before the stash existed fall back to the signed APT
# repository, which keeps every released version.
#
# Runs before 25-cowork-bridge-wrapper.sh, whose guard compares the installed
# version against CLAUDE_DESKTOP_VERSION.

requested="${CLAUDE_DESKTOP_VERSION:-}"
[ -n "$requested" ] || exit 0

installed="$(dpkg-query -W -f='${Version}' claude-desktop 2>/dev/null || true)"
if [ "$installed" = "$requested" ]; then
    exit 0
fi

printf '[claude-package-sync] writable layer carries Desktop %s; upgrading to %s\n' \
    "${installed:-none}" "$requested"

package=/opt/claude-desktop-package.deb
if [ -s "$package" ]; then
    if ! DEBIAN_FRONTEND=noninteractive dpkg -i "$package"; then
        # The new package wants a dependency the old layer lacks: resolve it
        # from the configured repository as the image build would have.
        apt-get update -o Acquire::Retries=3
        DEBIAN_FRONTEND=noninteractive apt-get install -y -f
    fi
else
    printf '[claude-package-sync] no packaged copy in this image; using the APT repository\n'
    apt-get update -o Acquire::Retries=3
    DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades \
        "claude-desktop=$requested"
fi

synced="$(dpkg-query -W -f='${Version}' claude-desktop 2>/dev/null || true)"
if [ "$synced" != "$requested" ]; then
    printf '[claude-package-sync] ERROR: Desktop is %s after the upgrade attempt, wanted %s\n' \
        "${synced:-none}" "$requested" >&2
    exit 1
fi
printf '[claude-package-sync] Desktop %s now installed in the writable layer\n' "$synced"
