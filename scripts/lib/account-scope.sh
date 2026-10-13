#!/bin/sh
# shellcheck disable=SC2034  # the ACCOUNT_* values are read by the sourcing script
#
# What a provisioned account gets, scoped away from the deployment's own
# configuration. Sourced, not executed.
#
# provision-user.sh sources the deployment's .env and runs the per-user compose
# against the same compose.yaml, so an account inherits every value the
# deployment set unless it is pinned here. Most of that is intended and stays: the
# web shell, the desktop home, identity's organization/plan/deployment, the egress
# policy, the timezone and the VM sizing are all deployment-wide on purpose. What
# must be pinned is the values that are an operator's alone, or that widen one
# account's reach. That is the whole rule, and it lives here as one function a
# smoke can drive rather than as a scattered set of inline overrides.
#
#   account_scope ROLE
#
# Sets, in the caller's shell:
#   ACCOUNT_GATEWAY_SETTINGS        the writable Gateway/inference configuration
#                                   library and the web-shell editor behind it
#   ACCOUNT_DEVELOPER_ACTIONS       the Developer menu's privileged actions and
#                                   its editor for the app's own config files
#   ACCOUNT_INFRASTRUCTURE_ACTIONS  the Projects/Spaces, Artifact, Memory and
#                                   Scheduled-Tasks mutations
#   ACCOUNT_READ_ROOTS              extra roots the authenticated download route
#                                   may serve, beyond the account's own workspace
#
# An Admin account keeps the deployment's own setting for each; every other
# account gets none of the surfaces, and the workspace alone for the read roots
# (its own config, sessions and any credential an operator path left there are
# not a tenant's to fetch). The deployment's values arrive as CLAUDE_REMOTE_* /
# COWORK_* from the environment the caller has sourced; CLAUDESK_ACCOUNT_* force
# one for every account regardless of role. An empty value counts as unset, so a
# blank line in .env changes nothing.

account_scope() {
    case "${1:-User}" in
        Admin)
            ACCOUNT_GATEWAY_SETTINGS="${CLAUDESK_ACCOUNT_GATEWAY_SETTINGS:-${CLAUDE_REMOTE_GATEWAY_SETTINGS:-0}}"
            ACCOUNT_DEVELOPER_ACTIONS="${CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS:-${CLAUDE_REMOTE_DEVELOPER_ACTIONS:-0}}"
            ACCOUNT_INFRASTRUCTURE_ACTIONS="${CLAUDESK_ACCOUNT_INFRASTRUCTURE_ACTIONS:-${CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS:-0}}"
            ACCOUNT_READ_ROOTS="${CLAUDESK_ACCOUNT_READ_ROOTS:-${COWORK_REMOTE_READ_ROOTS:-}}"
            ;;
        *)
            ACCOUNT_GATEWAY_SETTINGS="${CLAUDESK_ACCOUNT_GATEWAY_SETTINGS:-0}"
            ACCOUNT_DEVELOPER_ACTIONS="${CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS:-0}"
            ACCOUNT_INFRASTRUCTURE_ACTIONS="${CLAUDESK_ACCOUNT_INFRASTRUCTURE_ACTIONS:-0}"
            ACCOUNT_READ_ROOTS="${CLAUDESK_ACCOUNT_READ_ROOTS:-}"
            ;;
    esac
}
