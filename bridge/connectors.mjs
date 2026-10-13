// Remote MCP "connectors" for the web shell.
//
// The official bundle's Connectors surface (the "Add connector" control, the
// plugin-connector rows, Settings → Connectors) talks to claude.ai's connectors
// API — POST/GET/PUT/DELETE `/api/organizations/{org}/mcp/remote_servers…` —
// which a self-hosted deployment has no backend for. The bridge answers that
// family itself (see the routes in server.mjs), and this controller is its
// store: the definitions a user adds, persisted under the bridge state
// directory so they survive a restart and a container recreate.
//
// One instance is one account — Eva mode gives every account its own container
// and its own `bridge-data` volume — so the file holds a single flat list, with
// no account keying inside it.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateFileName = "connectors.json";
const maxServers = 64;
const maxNameLength = 200;
const maxUrlLength = 2000;
const maxLabelLength = 200;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

// A URL the connector may dial. The client accepts anything it sends; the
// deployment only needs to refuse a value that is not a plain http(s) URL, so a
// bad entry fails here rather than at connect time.
function normalizedUrl(value) {
  const url = clampString(value, maxUrlLength).trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

// The document the renderer parses (the bundle's `ck` schema). Every field the
// store does not model is nullable/optional in that schema, so it is emitted as
// `null` rather than omitted, which keeps the shape stable across bundle bumps.
function toDocument(record) {
  return {
    uuid: record.uuid,
    name: record.name,
    url: record.url,
    created_at: record.created_at,
    updated_at: record.updated_at,
    custom_oauth_client_id: record.custom_oauth_client_id ?? null,
    custom_oauth_client_secret: record.custom_oauth_client_secret ?? null,
    mcp_directory_server_uuid: record.mcp_directory_server_uuid ?? null,
    installation_source: record.installation_source ?? null,
    label: record.label ?? null,
    owner_account_uuid: null,
    additional_install: null,
    label_is_automatic: record.label_is_automatic ?? null,
    needs_label: record.needs_label ?? null,
    label_editable: record.label_editable ?? null,
    sign_in_pending: record.sign_in_pending ?? null,
    existing: record.existing === true,
    is_authenticated: record.is_authenticated === true,
    id_jag_config: null,
    cai_flags: [],
    oauth_overrides: record.oauth_overrides ?? null,
    claude_mode_offered: null,
  };
}

// `_with_connection` items carry the server plus its liveness. `connection` is
// what the Desktop reports for the server, or null when it is unknown — the
// renderer treats null as "not connected" and offers Connect.
function toConnectionDocument(record, connection) {
  const state = connection?.state;
  return {
    ...toDocument(record),
    connection_state: state === "initiated" || state === "connected" || state === "error"
      || state === "user_disconnected" ? state : null,
    connection_auth_type: typeof connection?.authType === "string" ? connection.authType : null,
    last_connected_at: connection?.lastConnectedAt ?? null,
    last_used_at: connection?.lastUsedAt ?? null,
    state_changed_at: connection?.stateChangedAt ?? null,
    use_days_bitmap: null,
  };
}

export function createConnectorStore({ stateDir, log = console }) {
  const state = { servers: [] };
  let persistChain = Promise.resolve();
  const statePath = join(stateDir, stateFileName);

  async function loadState() {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (Array.isArray(parsed?.servers)) {
        state.servers = parsed.servers
          .filter((entry) => isRecord(entry)
            && typeof entry.uuid === "string" && entry.uuid
            && typeof entry.url === "string" && entry.url)
          .map((entry) => ({
            uuid: entry.uuid,
            name: clampString(entry.name, maxNameLength),
            url: clampString(entry.url, maxUrlLength),
            created_at: typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString(),
            updated_at: typeof entry.updated_at === "string" ? entry.updated_at : new Date().toISOString(),
            custom_oauth_client_id: entry.custom_oauth_client_id ?? null,
            custom_oauth_client_secret: entry.custom_oauth_client_secret ?? null,
            mcp_directory_server_uuid: entry.mcp_directory_server_uuid ?? null,
            installation_source: entry.installation_source ?? null,
            label: typeof entry.label === "string" ? entry.label.slice(0, maxLabelLength) : null,
            label_is_automatic: entry.label_is_automatic ?? null,
            label_editable: entry.label_editable ?? null,
            needs_label: entry.needs_label ?? null,
            sign_in_pending: entry.sign_in_pending ?? null,
            is_authenticated: entry.is_authenticated === true,
            oauth_overrides: entry.oauth_overrides ?? null,
            enabled: entry.enabled !== false,
            tool_policies: Array.isArray(entry.tool_policies)
              ? entry.tool_policies.filter((policy) => isRecord(policy) && typeof policy.tool_name === "string")
              : [],
          }))
          .slice(0, maxServers);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        log.warn(`[cowork-bridge] connector state could not be read: ${error.message}`);
      }
    }
  }

  // Reads and writes wait for the stored state to load, or a request arriving
  // during startup would persist over it with an empty document.
  const ready = loadState();

  function persistState() {
    // Serialize writes; a failed write must not reject the caller (the request
    // that triggered it has already succeeded from the browser's point of view).
    persistChain = persistChain.then(async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, statePath);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        log.warn(`[cowork-bridge] connector state could not be saved: ${error.message}`);
      }
    });
    return persistChain;
  }

  function find(uuid) {
    return state.servers.find((entry) => entry.uuid === uuid) ?? null;
  }

  async function list() {
    await ready;
    return state.servers.map((record) => toDocument(record));
  }

  // `connectionFor(record)` returns the Desktop's status for a server, or null
  // when there is none — the route supplies it so the store stays free of IPC.
  async function listWithConnection(connectionFor = () => null) {
    await ready;
    return state.servers.map((record) => toConnectionDocument(record, connectionFor(record)));
  }

  async function get(uuid) {
    await ready;
    const record = find(uuid);
    return record ? toDocument(record) : null;
  }

  // A connector is keyed by its URL: adding the same server twice returns the
  // existing record with `existing: true`, which is what the renderer's create
  // handler branches on.
  async function create(input) {
    await ready;
    const name = clampString(input?.name, maxNameLength).trim();
    const url = normalizedUrl(input?.url);
    if (!name) throw new Error("connector name is required");
    if (!url) throw new Error("connector url must be an http(s) URL");
    const existing = state.servers.find((entry) => entry.url === url);
    if (existing) return { document: { ...toDocument(existing), existing: true }, existing: true };
    if (state.servers.length >= maxServers) throw new Error("too many connectors");
    const now = new Date().toISOString();
    const record = {
      uuid: randomUUID(),
      name,
      url,
      created_at: now,
      updated_at: now,
      custom_oauth_client_id: input?.custom_oauth_client_id ?? null,
      custom_oauth_client_secret: input?.custom_oauth_client_secret ?? null,
      mcp_directory_server_uuid: input?.mcp_directory_server_uuid ?? null,
      installation_source: input?.installation_source ?? null,
      label: name,
      label_is_automatic: true,
      label_editable: true,
      needs_label: false,
      sign_in_pending: null,
      is_authenticated: false,
      oauth_overrides: input?.oauth_overrides ?? null,
      enabled: true,
      tool_policies: [],
    };
    state.servers.push(record);
    await persistState();
    return { document: toDocument(record), existing: false };
  }

  async function update(uuid, input) {
    await ready;
    const record = find(uuid);
    if (!record) return null;
    if (input?.name !== undefined) {
      const name = clampString(input.name, maxNameLength).trim();
      if (!name) throw new Error("connector name is required");
      record.name = name;
      // A renamed connector whose label is still automatic follows the name, the
      // way the surface shows one label per row.
      if (record.label_is_automatic !== false) record.label = name;
    }
    if (input?.url !== undefined) {
      const url = normalizedUrl(input.url);
      if (!url) throw new Error("connector url must be an http(s) URL");
      record.url = url;
    }
    if (input?.custom_oauth_client_id !== undefined) {
      record.custom_oauth_client_id = input.custom_oauth_client_id ?? null;
    }
    if (input?.custom_oauth_client_secret !== undefined) {
      record.custom_oauth_client_secret = input.custom_oauth_client_secret ?? null;
    }
    if (input?.label !== undefined && record.label_is_automatic === false) {
      record.label = clampString(input.label, maxLabelLength);
    }
    record.updated_at = new Date().toISOString();
    await persistState();
    return toDocument(record);
  }

  async function remove(uuid) {
    await ready;
    const index = state.servers.findIndex((entry) => entry.uuid === uuid);
    if (index === -1) return false;
    state.servers.splice(index, 1);
    await persistState();
    return true;
  }

  // The org's "re-enable" toggle (a per-tool policy that got blocked), and the
  // enable/disable state the row shows.
  async function setEnabled(uuid, enabled) {
    await ready;
    const record = find(uuid);
    if (!record) return null;
    record.enabled = enabled !== false;
    record.updated_at = new Date().toISOString();
    await persistState();
    return toDocument(record);
  }

  async function toolPolicies(uuid) {
    await ready;
    const record = find(uuid);
    return record ? record.tool_policies.map((policy) => ({ ...policy })) : null;
  }

  async function setToolPolicy(uuid, toolName, maxPermission) {
    await ready;
    const record = find(uuid);
    if (!record) return null;
    const name = clampString(toolName, 200);
    const rest = record.tool_policies.filter((policy) => policy.tool_name !== name);
    if (maxPermission !== null && maxPermission !== undefined) {
      rest.push({ tool_name: name, max_permission: clampString(maxPermission, 40) });
    }
    record.tool_policies = rest;
    record.updated_at = new Date().toISOString();
    await persistState();
    return record.tool_policies.map((policy) => ({ ...policy }));
  }

  return {
    create,
    get,
    list,
    listWithConnection,
    remove,
    setEnabled,
    setToolPolicy,
    toolPolicies,
    update,
  };
}
