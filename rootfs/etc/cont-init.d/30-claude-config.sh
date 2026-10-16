#!/bin/sh

set -eu

base_url="${CLAUDE_GATEWAY_BASE_URL:-}"
api_key="${CLAUDE_GATEWAY_API_KEY:-}"
auth_scheme="${CLAUDE_GATEWAY_AUTH_SCHEME:-bearer}"
models_json="${CLAUDE_INFERENCE_MODELS_JSON:-}"
remote_gateway_settings="${CLAUDE_REMOTE_GATEWAY_SETTINGS:-0}"
remote_code_actions="${CLAUDE_REMOTE_CODE_ACTIONS:-0}"
# A tenant instance (one account's own, scripts/provision-user.sh) never runs
# Code in this container: the agent belongs on a self-hosted runner inside the
# account's Cowork guest, and this container is privileged enough that an agent
# shell here is close to host root. So the local Code surface is written off
# whatever the flag says — the app config and the bridge agree, and neither is
# the enforcement point on its own (the bridge withholds the IPC surface too).
# See docs/code-in-cowork-vm.md.
tenant="${CLAUDESK_TENANT:-0}"
case "$tenant" in
    0|1)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDESK_TENANT must be 0 or 1\n' >&2
        exit 1
        ;;
esac
if [ "$tenant" = "1" ]; then
    if [ "$remote_code_actions" = "1" ]; then
        printf '[claude-config] CLAUDESK_TENANT=1: keeping the local Code surface off (CLAUDE_REMOTE_CODE_ACTIONS ignored)\n'
    fi
    remote_code_actions=0
fi
gateway_env_authoritative="${CLAUDE_GATEWAY_ENV_AUTHORITATIVE:-0}"
remote_desktop_home="${CLAUDE_REMOTE_DESKTOP_HOME:-}"
allowed_egress_hosts_json="${CLAUDE_EGRESS_ALLOWED_HOSTS_JSON:-}"
vm_memory_gb="${CLAUDE_COWORK_VM_MEMORY_GB:-2}"
vm_cpu_count="${CLAUDE_COWORK_VM_CPU_COUNT:-1}"

case "$vm_memory_gb" in
    1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_COWORK_VM_MEMORY_GB must be an integer from 1 to 16\n' >&2
        exit 1
        ;;
esac

case "$vm_cpu_count" in
    1|2|3|4|5|6|7|8)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_COWORK_VM_CPU_COUNT must be an integer from 1 to 8\n' >&2
        exit 1
        ;;
esac

case "$remote_gateway_settings" in
    0|1)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_REMOTE_GATEWAY_SETTINGS must be 0 or 1\n' >&2
        exit 1
        ;;
esac

case "$remote_code_actions" in
    0|1)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_REMOTE_CODE_ACTIONS must be 0 or 1\n' >&2
        exit 1
        ;;
esac

case "$gateway_env_authoritative" in
    0|1)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_GATEWAY_ENV_AUTHORITATIVE must be 0 or 1\n' >&2
        exit 1
        ;;
esac

# Official 3P `desktopHome` surface key (Unified Claude). Validated strictly
# because an unrecognized value fails closed to `off`, which would remove the
# Chat and Cowork surfaces entirely.
case "$remote_desktop_home" in
    ""|standard|simple|no-vm|off)
        ;;
    *)
        printf '[claude-config] ERROR: CLAUDE_REMOTE_DESKTOP_HOME must be standard, simple, no-vm or off\n' >&2
        exit 1
        ;;
esac

if [ -z "$base_url" ]; then
    printf '[claude-config] ERROR: CLAUDE_GATEWAY_BASE_URL is required\n' >&2
    exit 1
fi

if [ -z "$api_key" ]; then
    printf '[claude-config] ERROR: CLAUDE_GATEWAY_API_KEY is required\n' >&2
    exit 1
fi

case "$auth_scheme" in
    bearer|x-api-key)
        ;;
    *)
        printf '[claude-config] ERROR: auth scheme must be bearer or x-api-key\n' >&2
        exit 1
        ;;
esac

# An empty list is meaningful, and is what a gateway that serves GET /v1/models
# wants: the Desktop discovers the routes off the endpoint instead of being
# handed a fixed set, and the model picker fills from what the gateway reports.
# A non-empty list is still validated, so a typo cannot silently pin the picker
# to a route the gateway does not serve.
if [ -n "$models_json" ] && ! printf '%s' "$models_json" \
    | jq -e '
        type == "array"
        and length > 0
        and all(.[];
            (type == "string" and length > 0)
            or
            (type == "object" and (.name | type == "string" and length > 0))
        )
    ' >/dev/null; then
    printf '[claude-config] ERROR: CLAUDE_INFERENCE_MODELS_JSON must be empty, or hold model names / model objects with a name\n' >&2
    exit 1
fi
if [ -z "$models_json" ]; then
    models_json=null
fi

if [ -n "$allowed_egress_hosts_json" ] && ! printf '%s' "$allowed_egress_hosts_json" \
    | jq -e '
        type == "array"
        and length > 0
        and all(.[]; type == "string" and length > 0)
    ' >/dev/null; then
    printf '[claude-config] ERROR: CLAUDE_EGRESS_ALLOWED_HOSTS_JSON must be a non-empty JSON string array\n' >&2
    exit 1
fi
if [ -z "$allowed_egress_hosts_json" ]; then
    allowed_egress_hosts_json=null
fi

if [ -L /etc/claude-desktop ]; then
    printf '[claude-config] ERROR: /etc/claude-desktop must not be a symlink\n' >&2
    exit 1
fi

install -d -o root -g root -m 0755 /etc/claude-desktop
tmp_file="$(mktemp /etc/claude-desktop/.managed-settings.XXXXXX)"
developer_tmp=""
app_config_tmp=""
legacy_app_config_tmp=""
trap 'rm -f "$tmp_file" "$developer_tmp" "$app_config_tmp" "$legacy_app_config_tmp"' EXIT HUP INT TERM

jq -n \
    --arg base_url "$base_url" \
    --arg api_key "$api_key" \
    --arg auth_scheme "$auth_scheme" \
    --arg code "$remote_code_actions" \
    --arg remote "$remote_gateway_settings" \
    --arg desktop_home "$remote_desktop_home" \
    --argjson models "$models_json" \
    --argjson allowed_egress_hosts "$allowed_egress_hosts_json" \
    '({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: $base_url,
        inferenceGatewayApiKey: $api_key,
        inferenceGatewayAuthScheme: $auth_scheme,
        inferenceCredentialKind: "static",
        disableDeploymentModeChooser: ($remote == "0"),
        chatTabEnabled: true,
        coworkTabEnabled: true,
        isClaudeCodeForDesktopEnabled: ($code == "1")
    } + if $models == null then {} else {inferenceModels: $models} end
      + if $desktop_home == "" then {} else {desktopHome: $desktop_home} end
      + if $allowed_egress_hosts == null then {} else {coworkEgressAllowedHosts: $allowed_egress_hosts} end)' > "$tmp_file"

# The official Desktop builds its top-level Developer menu only when the
# official user-data setting allowDevTools is enabled.  Keep that setting tied
# to the same explicit opt-in that exposes the writable remote Gateway editor;
# preserve any other official developer settings already present.
user_id="${USER_ID:-1000}"
group_id="${GROUP_ID:-1000}"
user_data_dir="/config/.config/Claude-3p"
developer_settings="$user_data_dir/developer_settings.json"

install -d -o "$user_id" -g "$group_id" -m 0700 "$user_data_dir"
if [ -L "$developer_settings" ]; then
    printf '[claude-config] ERROR: developer settings must not be a symlink\n' >&2
    exit 1
fi

developer_tmp="$(mktemp "$user_data_dir/.developer-settings.XXXXXX")"
if [ -f "$developer_settings" ]; then
    jq --argjson enabled "$remote_gateway_settings" \
        '. + {allowDevTools: ($enabled == 1)}' \
        "$developer_settings" > "$developer_tmp"
else
    jq -n --argjson enabled "$remote_gateway_settings" \
        '{allowDevTools: ($enabled == 1)}' > "$developer_tmp"
fi
install -o "$user_id" -g "$group_id" -m 0600 \
    "$developer_tmp" "$developer_settings"
rm -f "$developer_tmp"
developer_tmp=""
printf '[claude-config] official Developer menu follows CLAUDE_REMOTE_GATEWAY_SETTINGS=%s\n' \
    "$remote_gateway_settings"

# These are official Desktop preferences consumed by the Linux VM startup
# path. The app's getAppConfigPath() resolves to claude_desktop_config.json and
# reads them from its `preferences` object. Merge there instead of patching
# QEMU arguments or the packaged application.
#
# The same file carries the top-level `deploymentMode`, which the Desktop reads
# to decide whether this launch is a first run before sign-in. Unset, it treats
# it as one and defers every credential-dependent boot task — model discovery
# among them, since `invalidateDiscovery()` is then never called — so the model
# picker stays empty and starting a session fails with "your organization's
# model list hasn't loaded yet", while the Setup window's own probe still
# answers and reports models found. The mode chooser is what normally records
# the choice, and a managed deployment disables the chooser, so record it here.
# A value that is already set is left exactly as it is.
app_config="$user_data_dir/claude_desktop_config.json"
if [ -L "$app_config" ]; then
    printf '[claude-config] ERROR: app config must not be a symlink\n' >&2
    exit 1
fi
app_config_tmp="$(mktemp "$user_data_dir/.config.XXXXXX")"
if [ -f "$app_config" ]; then
    jq \
        --argjson memory_gb "$vm_memory_gb" \
        --argjson cpu_count "$vm_cpu_count" \
        '.preferences = ((.preferences // {}) + {
            vmMemoryGB: $memory_gb,
            vmCpuCount: $cpu_count,
            coworkScheduledTasksEnabled: true
        })
        | del(.vmMemoryGB, .vmCpuCount, .coworkScheduledTasksEnabled)
        | if (.deploymentMode // "") == "" then . + {deploymentMode: "3p"} else . end' \
        "$app_config" > "$app_config_tmp"
else
    jq -n \
        --argjson memory_gb "$vm_memory_gb" \
        --argjson cpu_count "$vm_cpu_count" \
        '{preferences: {
            vmMemoryGB: $memory_gb,
            vmCpuCount: $cpu_count,
            coworkScheduledTasksEnabled: true
        },
        deploymentMode: "3p"}' > "$app_config_tmp"
fi
install -o "$user_id" -g "$group_id" -m 0600 "$app_config_tmp" "$app_config"
rm -f "$app_config_tmp"
app_config_tmp=""

# Electron's own config.json state file. Preserve every key — updater state,
# window layout, first-launch stamps are all kept here — and clean only the
# three fields older revisions of this image mistakenly wrote to it.
# `deploymentMode` is NOT read from here: the Desktop reads it from
# claude_desktop_config.json, which is handled above.
legacy_app_config="$user_data_dir/config.json"
if [ -f "$legacy_app_config" ] && [ ! -L "$legacy_app_config" ]; then
    legacy_app_config_tmp="$(mktemp "$user_data_dir/.legacy-config.XXXXXX")"
    jq '
        del(.vmMemoryGB, .vmCpuCount, .coworkScheduledTasksEnabled)
        | if (.preferences | type) == "object" then
            .preferences |= del(.vmMemoryGB, .vmCpuCount, .coworkScheduledTasksEnabled)
          else . end
        | if .preferences == {} then del(.preferences) else . end
    ' "$legacy_app_config" > "$legacy_app_config_tmp"
    install -o "$user_id" -g "$group_id" -m 0600 \
        "$legacy_app_config_tmp" "$legacy_app_config"
    rm -f "$legacy_app_config_tmp"
    legacy_app_config_tmp=""
fi
printf '[claude-config] Cowork VM constrained to %s GiB / %s vCPU; scheduled tasks enabled\n' \
    "$vm_memory_gb" "$vm_cpu_count"

if [ "$remote_gateway_settings" = "1" ]; then
    config_library="$user_data_dir/configLibrary"
    meta_file="$config_library/_meta.json"

    install -d -o "$user_id" -g "$group_id" -m 0700 \
        "$user_data_dir" "$config_library"

    if [ ! -e "$meta_file" ]; then
        config_id="$(sed -n '1p' /proc/sys/kernel/random/uuid)"
        config_file="$config_library/$config_id.json"
        meta_tmp="$(mktemp "$config_library/.meta.XXXXXX")"
        jq -n \
            --arg id "$config_id" \
            '{appliedId: $id, entries: [{id: $id, name: "Default"}]}' \
            > "$meta_tmp"
        install -o "$user_id" -g "$group_id" -m 0600 "$tmp_file" "$config_file"
        install -o "$user_id" -g "$group_id" -m 0600 "$meta_tmp" "$meta_file"
        rm -f "$meta_tmp"
        printf '[claude-config] seeded writable 3P configuration library from environment\n'
    else
        applied_id="$(jq -r '.appliedId // empty' "$meta_file")"
        case "$applied_id" in
            ????????-????-????-????-????????????)
                ;;
            *)
                printf '[claude-config] ERROR: existing configLibrary metadata has an invalid appliedId\n' >&2
                exit 1
                ;;
        esac
        if [ ! -f "$config_library/$applied_id.json" ]; then
            printf '[claude-config] ERROR: existing configLibrary applied configuration is missing\n' >&2
            exit 1
        fi
        if [ "$allowed_egress_hosts_json" != "null" ]; then
            egress_tmp="$(mktemp "$config_library/.egress.XXXXXX")"
            jq --argjson allowed_egress_hosts "$allowed_egress_hosts_json" \
                '. + {coworkEgressAllowedHosts: $allowed_egress_hosts} | del(.allowedEgressHosts)' \
                "$config_library/$applied_id.json" > "$egress_tmp"
            install -o "$user_id" -g "$group_id" -m 0600 \
                "$egress_tmp" "$config_library/$applied_id.json"
            rm -f "$egress_tmp"
            printf '[claude-config] applied explicit egress policy from environment\n'
        fi
        # The Code surface follows the environment both ways, like the egress and
        # desktop-home flags below: a deployment that turns Code off has to turn
        # it off in an existing writable configuration, not merely fail to turn
        # it on. Only write when it actually differs, so a steady state does not
        # rewrite the file on every boot.
        if [ "$remote_code_actions" = "1" ]; then
            code_enabled=true
        else
            code_enabled=false
        fi
        if [ "$(jq -r '.isClaudeCodeForDesktopEnabled // empty' \
                "$config_library/$applied_id.json")" != "$code_enabled" ]; then
            code_tmp="$(mktemp "$config_library/.code.XXXXXX")"
            jq --argjson enabled "$code_enabled" \
                '. + {isClaudeCodeForDesktopEnabled: $enabled}' \
                "$config_library/$applied_id.json" > "$code_tmp"
            install -o "$user_id" -g "$group_id" -m 0600 \
                "$code_tmp" "$config_library/$applied_id.json"
            rm -f "$code_tmp"
        fi
        printf '[claude-config] official Code surface follows CLAUDE_REMOTE_CODE_ACTIONS=%s\n' \
            "$remote_code_actions"
        # The endpoint and its credential are provisioning values: the Cowork VM
        # makes the model calls and is confined to the guest, so an account whose
        # endpoint is not reachable from there simply cannot infer, and one whose
        # credential or scheme is stale answers 401 on the route caddy sends
        # straight to the router. A deployment that moves any of the three has to
        # move it in the writable configuration, not merely fail to write a new
        # one. Opt-in, so a deployment where they are edited in the official
        # Gateway panel keeps those edits.
        if [ "$gateway_env_authoritative" = "1" ] \
            && [ "$(jq -r '[.inferenceGatewayBaseUrl // empty, .inferenceGatewayApiKey // empty, .inferenceGatewayAuthScheme // empty] | @tsv' \
                "$config_library/$applied_id.json")" \
                != "$(printf '%s\t%s\t%s' "$base_url" "$api_key" "$auth_scheme")" ]; then
            gateway_tmp="$(mktemp "$config_library/.gateway.XXXXXX")"
            jq --arg base_url "$base_url" --arg api_key "$api_key" --arg auth_scheme "$auth_scheme" \
                '. + {inferenceGatewayBaseUrl: $base_url, inferenceGatewayApiKey: $api_key,
                      inferenceGatewayAuthScheme: $auth_scheme}' \
                "$config_library/$applied_id.json" > "$gateway_tmp"
            install -o "$user_id" -g "$group_id" -m 0600 \
                "$gateway_tmp" "$config_library/$applied_id.json"
            rm -f "$gateway_tmp"
            printf '[claude-config] inference endpoint applied from environment\n'
        fi
        # Unified Claude follows the environment the same way as the Code flag,
        # but only while the variable is set: an unset value leaves whatever the
        # Setup window last wrote to the writable configuration.
        if [ "$remote_desktop_home" != "" ]; then
            desktop_home_tmp="$(mktemp "$config_library/.desktop-home.XXXXXX")"
            jq --arg desktop_home "$remote_desktop_home" \
                '. + {desktopHome: $desktop_home}' \
                "$config_library/$applied_id.json" > "$desktop_home_tmp"
            install -o "$user_id" -g "$group_id" -m 0600 \
                "$desktop_home_tmp" "$config_library/$applied_id.json"
            rm -f "$desktop_home_tmp"
            printf '[claude-config] unified Chat/Cowork home applied from environment\n'
        fi

        # `allowedPluginMarketplaces` is a provisioning list. The current
        # Desktop retries `plugin marketplace add` on every launch and reports
        # already-present clones as load failures. Once every configured entry
        # exists in the official persistent marketplace registry, remove the
        # one-shot list and let the native registry remain the source of truth.
        configured_marketplace_count="$(jq '.allowedPluginMarketplaces // [] | length' \
            "$config_library/$applied_id.json")"
        if [ "$configured_marketplace_count" -gt 0 ]; then
            known_marketplaces_complete=0
            marketplace_session_root="$user_data_dir/local-agent-mode-sessions"
            if [ -d "$marketplace_session_root" ]; then
                # Read one path per line so spaces in persistent session paths
                # are preserved instead of being split by command substitution.
                if find "$marketplace_session_root" \
                    -type f -name known_marketplaces.json -print 2>/dev/null |
                    while IFS= read -r known_marketplaces; do
                        if jq -e --argjson expected "$configured_marketplace_count" \
                            'type == "object" and length >= $expected' \
                            "$known_marketplaces" >/dev/null; then
                            printf '%s\n' "$known_marketplaces"
                        fi
                    done | grep -q .; then
                    known_marketplaces_complete=1
                fi
            fi
            if [ "$known_marketplaces_complete" -eq 1 ]; then
                marketplace_tmp="$(mktemp "$config_library/.marketplaces.XXXXXX")"
                jq 'del(.allowedPluginMarketplaces)' \
                    "$config_library/$applied_id.json" > "$marketplace_tmp"
                install -o "$user_id" -g "$group_id" -m 0600 \
                    "$marketplace_tmp" "$config_library/$applied_id.json"
                rm -f "$marketplace_tmp"
                printf '[claude-config] marketplace provisioning completed; using persistent native registry\n'
            fi
        fi
        printf '[claude-config] preserving existing writable 3P configuration library\n'
    fi

    rm -f /etc/claude-desktop/managed-settings.json
    printf '[claude-config] remote Gateway settings enabled; managed configuration disabled\n'
    exit 0
fi

rm -f /etc/claude-desktop/managed-settings.json
install -o root -g "${GROUP_ID:-1000}" -m 0440 \
    "$tmp_file" \
    /etc/claude-desktop/managed-settings.json

printf '[claude-config] managed 3P Gateway configuration installed; model discovery disabled\n'

