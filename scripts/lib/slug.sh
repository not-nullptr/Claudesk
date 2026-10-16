#!/bin/sh
#
# Shared account-slug derivation. Sourced, not executed.
#
#   claudesk_slug EMAIL
#
# The ASCII-only slug an account's resources are keyed by: the per-user compose
# project (claudesk-<slug>), its container-name prefix (<slug>-) and its data
# root ($CLAUDESK_DATA_ROOT/users/<slug>). provision-user.sh creates those and
# deprovision-user.sh removes them, so they MUST agree — which is why the rule
# lives here rather than being copied into each. LC_ALL=C keeps the character
# classes to a-z0-9, so a non-ASCII local part cannot leak into a container name.
claudesk_slug() {
    printf '%s' "$1" \
        | LC_ALL=C tr '[:upper:]' '[:lower:]' \
        | LC_ALL=C tr -cs '[:alnum:]' '-' \
        | sed 's/^-*//; s/-*$//'
}

# Slugs an account must never take. A per-user compose project is named
# claudesk-<slug>, so a colliding slug would let provisioning or teardown reach a
# fixed stack instead of a user's. The box gateway stack is pinned to the project
# name claudesk-gateway (compose.gateway.yaml), so an account like gateway@… would
# resolve to `gateway` and hand a teardown the gateway itself.
#
# `claudesk` is reserved for a name rather than a project: the deployment's own
# instance registers the network aliases `${CLAUDESK_NAME_PREFIX:-claudesk-}desktop`
# and `…mobile` on the shared gateway_net, so an account slugging to `claudesk`
# would register the same two and put back the ambiguity those aliases exist to
# remove (see docs/eva-mode.md, "Two deployments on one box"). Keep this in sync
# with any other fixed claudesk-* name.
CLAUDESK_RESERVED_SLUGS="gateway claudesk"

# claudesk_slug_ok SLUG — true when the slug is non-empty and safe to key an
# account by. Fails closed, so a caller can `|| { error; exit 1; }`.
claudesk_slug_ok() {
    [ -n "$1" ] || return 1
    case " $CLAUDESK_RESERVED_SLUGS " in
        *" $1 "*) return 1 ;;
    esac
    return 0
}

