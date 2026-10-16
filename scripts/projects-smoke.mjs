import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bridge serves claude.ai's projects API itself (the web shell's `/projects`
// page, its create form, the project detail route), backed by the Desktop's
// CoworkSpaces store over IPC (bridge/projects.mjs). These checks pin the two
// things that matter: the project document shape the renderer parses — in
// particular the `cowork_bound_device.local_space_id` marker that makes a
// project a local space — and that each route lands on the right IPC call.
const bridgeRoot = new URL("../bridge/", import.meta.url);
const { createProjectBackend, toProject } = await import(new URL("projects.mjs", bridgeRoot));

const accountUuid = "11111111-2222-4333-8444-555555555555";
const silent = { warn() {} };

let nextId = 0;
function fakeDesktop(spaces) {
  const calls = [];
  return {
    calls,
    async invoke(surface, method, args) {
      calls.push({ surface, method, args });
      assert.equal(surface, "CoworkSpaces", "every call is on the spaces surface");
      if (method === "getAllSpaces") return spaces.map((space) => ({ ...space }));
      if (method === "getSpace") return spaces.find((space) => space.id === args[0]);
      if (method === "createSpace") {
        const params = args[0];
        const now = Date.now();
        const space = {
          id: `space-${++nextId}`,
          name: params.name,
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
          folders: [],
          projects: [],
          links: [],
          createdAt: now,
          updatedAt: now,
        };
        spaces.push(space);
        return { ...space };
      }
      if (method === "updateSpace") {
        const space = spaces.find((entry) => entry.id === args[0]);
        if (!space) return undefined;
        Object.assign(space, args[1]);
        space.updatedAt = Date.now();
        return { ...space };
      }
      if (method === "deleteSpace") {
        const index = spaces.findIndex((space) => space.id === args[0]);
        if (index >= 0) spaces.splice(index, 1);
        return undefined;
      }
      throw new Error(`unexpected IPC: ${method}`);
    },
  };
}

// A space record as the Desktop stores one.
const spaceRecord = {
  id: "7b1b1b1b-2222-4333-8444-555555555555",
  name: "Q3 planning",
  description: "the quarter",
  folders: [{ path: "/workspace/Q3" }],
  projects: [],
  links: [],
  instructions: "keep it short",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

// --- the document shape --------------------------------------------------
const document = toProject(spaceRecord, { accountUuid, starred: true });
assert.equal(document.uuid, spaceRecord.id, "the project uuid is the space id");
assert.equal(document.name, "Q3 planning");
assert.equal(document.description, "the quarter");
assert.equal(document.type, null, "an ordinary project (drives the detail route's branch)");
assert.equal(document.is_starred, true);
assert.equal(document.is_starter_project, false);
assert.equal(document.prompt_template, "keep it short", "instructions surface as prompt_template");
assert.equal(document.creator.uuid, accountUuid);
assert.equal(document.archived_at, null);
assert.match(document.created_at, /^\d{4}-\d\d-\d\dT/, "timestamps are ISO strings");
assert.deepEqual(
  document.cowork_bound_device,
  {
    device_id: "claudesk-project-device",
    folders: ["/workspace/Q3"],
    local_space_id: spaceRecord.id,
    migration_status: "complete",
    bound_at: document.updated_at,
  },
  "the space is announced as this device's binding",
);

// A space with no folders still names a (folder-less) binding — the renderer's
// reader only requires a non-empty device id.
const bare = toProject({ id: "x", name: "y", createdAt: 1, updatedAt: 1 }, { accountUuid });
assert.equal(bare.cowork_bound_device.local_space_id, "x");
assert.deepEqual(bare.cowork_bound_device.folders, []);
assert.equal(bare.is_starred, false);

// --- the routes ----------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), "claudesk-projects-"));
const spaces = [{ ...spaceRecord }];
const desktop = fakeDesktop(spaces);
const backend = createProjectBackend({ desktop, stateDir: dir, log: silent });

// GET /projects — a bare array.
let listed = await backend.list({ accountUuid, searchParams: new URLSearchParams() });
assert.equal(Array.isArray(listed), true, "the v1 list is a bare array");
assert.equal(listed.length, 1);
assert.equal(listed[0].uuid, spaceRecord.id);

// POST /projects — the create form's body, with the `is_starred: true` it forces.
const created = await backend.create({
  accountUuid,
  body: {
    name: "New project",
    description: "a goal",
    prompt_template: "be brief",
    type: undefined,
    is_private: true,
    is_starred: true,
  },
});
assert.equal(created.name, "New project");
assert.equal(created.prompt_template, "be brief", "prompt_template becomes instructions");
assert.equal(created.is_starred, true, "a created project comes back starred");
assert.equal(spaces.length, 2, "createSpace ran");
const createCall = desktop.calls.find((call) => call.method === "createSpace");
assert.deepEqual(
  createCall.args,
  [{ name: "New project", description: "a goal", instructions: "be brief" }],
  "only the params the IPC validator admits are forwarded",
);

// GET /projects_v2 — the page envelope.
const page = await backend.page({ accountUuid, searchParams: new URLSearchParams() });
assert.equal(Array.isArray(page.data), true);
assert.equal(page.data.length, 2);
assert.equal(page.pagination.total, 2);
assert.equal(page.pagination.has_more, false);

// Filtering the list the way the picker does.
const starredOnly = await backend.list({
  accountUuid,
  searchParams: new URLSearchParams("starred=true"),
});
assert.deepEqual(
  starredOnly.map((project) => project.uuid),
  [created.uuid],
  "only the created project is starred",
);
const byUuid = await backend.list({
  accountUuid,
  searchParams: new URLSearchParams(`uuids=${spaceRecord.id}`),
});
assert.deepEqual(byUuid.map((project) => project.uuid), [spaceRecord.id]);
const searched = await backend.list({
  accountUuid,
  searchParams: new URLSearchParams("searchQuery=planning"),
});
assert.deepEqual(searched.map((project) => project.uuid), [spaceRecord.id]);

// GET /projects/{uuid}
const single = await backend.get(spaceRecord.id, { accountUuid });
assert.equal(single.uuid, spaceRecord.id);
assert.equal(await backend.get("missing", { accountUuid }), null);

// PUT /projects/{uuid} — a rename plus a star change.
const renamed = await backend.update({
  accountUuid,
  projectUuid: spaceRecord.id,
  body: { name: "Renamed" },
});
assert.equal(renamed.name, "Renamed");
assert.equal(spaces.find((space) => space.id === spaceRecord.id).name, "Renamed");
const unstarred = await backend.update({
  accountUuid,
  projectUuid: spaceRecord.id,
  body: { is_starred: false },
});
assert.equal(unstarred.is_starred, false);
assert.deepEqual(await backend.starredIds(), [created.uuid], "the star came off one, not the other");

// GET /projects/count
assert.equal(await backend.count(), 2);

// DELETE /projects/{uuid}
await backend.remove({ projectUuid: spaceRecord.id });
assert.equal(spaces.length, 1, "deleteSpace ran");
assert.equal(await backend.get(spaceRecord.id, { accountUuid }), null);

// --- stars survive a restart (a fresh bridge reading the same state dir) ---
const second = createProjectBackend({ desktop: fakeDesktop(spaces), stateDir: dir, log: silent });
await second.setStar({ projectUuid: created.uuid, starred: true });
const third = createProjectBackend({ desktop: fakeDesktop(spaces), stateDir: dir, log: silent });
assert.deepEqual(await third.starredIds(), [created.uuid], "stars persist across a restart");
const reloaded = await third.get(created.uuid, { accountUuid });
assert.equal(reloaded.is_starred, true);

console.log("projects-smoke: ok");
