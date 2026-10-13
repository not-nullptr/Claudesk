#!/bin/sh
# shellcheck disable=SC2034  # the ACCOUNT_* values are read by the sourcing script
#
# Which operator surfaces a provisioned account gets. Sourced, not executed.
#
# Putting an instance up is where an account's privileges are decided (see
# docs/eva-mode.md): an Admin account keeps the deployment's own setting, every
# other account gets none of them. That is the whole security decision, so it
# lives here as one function a smoke can drive, rather than as a case that is easy
# to extend for a new surface and forget the non-Admin half of.
#
#   account_operator_surfaces ROLE
#
# Sets, in the caller's shell:
#   ACCOUNT_GATEWAY_SETTINGS        the writable Gateway/inference configuration
#                                   library and the web-shell editor behind it
#   ACCOUNT_DEVELOPER_ACTIONS       the Developer menu's privileged actions and
#                                   its editor for the app's own config files
#   ACCOUNT_INFRASTRUCTURE_ACTIONS  the Projects/Spaces, Artifact, Memory and
#                                   Scheduled-Tasks mutations
#
# The deployment's own values arrive as CLAUDE_REMOTE_* (from the environment the
# caller has sourced); CLAUDESK_ACCOUNT_* force one for every account regardless
# of role. An empty value counts as unset, so a blank line in .env changes
# nothing.

account_operator_surfaces() {
    case "${1:-User}" in
        Admin)
            ACCOUNT_GATEWAY_SETTINGS="${CLAUDESK_ACCOUNT_GATEWAY_SETTINGS:-${CLAUDE_REMOTE_GATEWAY_SETTINGS:-0}}"
            ACCOUNT_DEVELOPER_ACTIONS="${CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS:-${CLAUDE_REMOTE_DEVELOPER_ACTIONS:-0}}"
            ACCOUNT_INFRASTRUCTURE_ACTIONS="${CLAUDESK_ACCOUNT_INFRASTRUCTURE_ACTIONS:-${CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS:-0}}"
            ;;
        *)
            ACCOUNT_GATEWAY_SETTINGS="${CLAUDESK_ACCOUNT_GATEWAY_SETTINGS:-0}"
            ACCOUNT_DEVELOPER_ACTIONS="${CLAUDESK_ACCOUNT_DEVELOPER_ACTIONS:-0}"
            ACCOUNT_INFRASTRUCTURE_ACTIONS="${CLAUDESK_ACCOUNT_INFRASTRUCTURE_ACTIONS:-0}"
            ;;
    esac
}
