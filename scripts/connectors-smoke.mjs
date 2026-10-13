import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bridge serves claude.ai's connectors API itself (the web shell's Settings →
// Connectors surface), backed by bridge/connectors.mjs. These checks pin the
// store's contract: the document shape the renderer parses, the URL-keyed
// duplicate rule, persistence across a restart, and the tool-policy / reenable
// bookkeeping the surface writes.
const bridgeRoot = new URL("../bridge/", import.meta.url);
const { createConnectorStore } = await import(new URL("connectors.mjs", bridgeRoot));

const silent = { warn() {} };
const dir = await mkdtemp(join(tmpdir(), "claudesk-connectors-"));
const store = createConnectorStore({ stateDir: dir, log: silent });

const url = "https://mcp.example.com/mcp";
const { document, existing } = await store.create({ name: "Example", url });
assert.equal(existing, false, "a first create is not an existing record");
assert.match(document.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "the document carries a uuid");
assert.equal(document.name, "Example");
assert.equal(document.url, url);
assert.equal(document.is_authenticated, false, "a new connector starts unauthenticated");
assert.equal(document.existing, false);
assert.ok(document.created_at && document.updated_at, "timestamps are present");
assert.equal((await store.list()).length, 1);

// A connector is keyed by URL: the same server twice returns the existing
// record with `existing: true`, which the renderer's create handler branches on.
const duplicate = await store.create({ name: "Another name", url });
assert.equal(duplicate.existing, true, "a duplicate url reports existing");
assert.equal(duplicate.document.uuid, document.uuid, "the duplicate is the same record");
assert.equal((await store.list()).length, 1, "a duplicate url is not stored twice");

// Get, miss, edit.
assert.equal((await store.get(document.uuid)).name, "Example");
assert.equal(await store.get("00000000-0000-4000-8000-000000000000"), null, "an unknown id is null");
const renamed = await store.update(document.uuid, { name: "Renamed" });
assert.equal(renamed.name, "Renamed");
assert.equal(renamed.label, "Renamed", "an automatic label follows a rename");

// Validation.
await assert.rejects(() => store.create({ name: "", url }), /name/, "an empty name is refused");
await assert.rejects(() => store.create({ name: "Bad", url: "ftp://host/x" }),
  /http/, "a non-http url is refused");

// Tool policies and the enable toggle.
assert.deepEqual(await store.toolPolicies(document.uuid), [], "a new connector has no policies");
await store.setToolPolicy(document.uuid, "search", "allowed");
assert.deepEqual(await store.toolPolicies(document.uuid),
  [{ tool_name: "search", max_permission: "allowed" }], "a policy is stored");
await store.setToolPolicy(document.uuid, "search", null);
assert.deepEqual(await store.toolPolicies(document.uuid), [], "a null policy clears the entry");
assert.equal((await store.setEnabled(document.uuid, false)).uuid, document.uuid);

// `_with_connection` items carry the connection fields, all null until the
// Desktop reports a status (the renderer fills them from its own IPC hydration).
const withConnection = await store.listWithConnection();
assert.equal(withConnection.length, 1);
assert.equal(withConnection[0].connection_state, null, "connection state is null by default");
assert.equal(withConnection[0].is_authenticated, false);

// A second store over the same directory sees the persisted records.
const reopened = createConnectorStore({ stateDir: dir, log: silent });
const reloaded = await reopened.list();
assert.equal(reloaded.length, 1, "records survive a restart");
assert.equal(reloaded[0].name, "Renamed", "the edit survived");

// Removing.
assert.equal(await store.remove(document.uuid), true, "removing the record succeeds");
assert.equal(await store.remove(document.uuid), false, "removing it again is a no-op");
assert.deepEqual(await store.list(), [], "the list is empty after removal");

console.log("connectors-smoke: ok");
