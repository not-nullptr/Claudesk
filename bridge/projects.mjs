// Projects for the web shell.
//
// The official bundle's project surfaces — the `/projects` page, the
// `/projects/create` form, the `/project/<uuid>` detail route and the composer's
// project selector — speak claude.ai's projects API
// (`/api/organizations/{org}/projects…`), which a self-hosted deployment has no
// backend for: the bridge is the origin for `/api/*` and answered this family
// with the fall-through 404, which is what "creating a project" hit.
//
// This deployment does have one real projects backend, though: the Desktop main
// process's CoworkSpaces store, reached over the `claude.web.CoworkSpaces` IPC
// surface. So the bridge answers the project routes itself, translating between
// the renderer's project document and a space, exactly as bridge/connectors.mjs
// answers the connectors family. Nothing is forwarded upstream and no renderer
// patch is involved, so a Desktop update that moves or renames the local code
// cannot break this.
//
// A space is `{id, name, description?, folders[{path}], projects[{uuid}],
// links[], instructions?, origin?, migration?, createdAt, updatedAt}` (pinned by
// the Desktop main process's own IPC validators). A *project* is the same thing
// under claude.ai's spelling: `uuid` is the space's `id`, `prompt_template` is
// its `instructions`, and the space is announced as this device's binding
// (`cowork_bound_device.local_space_id`), which is the marker the renderer reads
// to treat a project as a local space.
//
// One instance is one account — Eva mode gives every account its own container
// and its own `bridge-data` volume — so the few fields a space does not model
// (the star flag) live in a single per-instance file, keyed by project uuid.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateFileName = "project-stars.json";

// A space carries no device identity, and the Desktop's device registry is not a
// surface this bridge forwards (`DeviceRegistry.getLocalDeviceInfo` is not on the
// allow-list). The binding still has to name *a* device — non-empty is the only
// thing the renderer's `cowork_bound_device` reader requires — so the project
// answers as bound to one stable synthetic device. The consequence is that the
// "this computer" knowledge row reads as not-here; see the note in the plan.
const syntheticDeviceId = "claudesk-project-device";

// `order_by` values the renderer sends, mapped onto the space fields we sort by.
const createdSort = "created_at";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoFromMillis(value) {
  const millis = typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  return new Date(millis).toISOString();
}

function folderPaths(space) {
  if (!Array.isArray(space?.folders)) return [];
  const paths = [];
  for (const folder of space.folders) {
    const path = isRecord(folder) ? folder.path : folder;
    if (typeof path === "string" && path) paths.push(path);
  }
  return paths;
}

// The project document the renderer parses (`Kr` in c69c27f34, the `HP` field
// list in shared-25). Fields the store does not model are stated explicitly —
// `null` for the ordinary case — so the shape stays stable across bundle bumps.
export function toProject(space, { accountUuid, starred = false } = {}) {
  const updatedAt = isoFromMillis(space.updatedAt);
  return {
    uuid: space.id,
    name: typeof space.name === "string" ? space.name : "",
    description: typeof space.description === "string" ? space.description : "",
    // An ordinary project, not a haystack/starter one: `type` null is what makes
    // the detail route take the non-setup branch (`E = !y.type && !y.subtype`).
    type: null,
    subtype: null,
    is_private: true,
    is_starred: starred === true,
    is_starter_project: false,
    is_harmony_project: false,
    created_at: isoFromMillis(space.createdAt),
    updated_at: updatedAt,
    archived_at: null,
    creator: { uuid: accountUuid ?? null },
    archiver: null,
    moved_to: null,
    // The create form sends the project's instructions as `prompt_template`;
    // the space keeps them as `instructions`. Both spellings round-trip.
    prompt_template: typeof space.instructions === "string" ? space.instructions : "",
    settings: {},
    permissions: {},
    // The space's folders are this computer's grant, and `local_space_id` is the
    // marker that tells the renderer the project *is* a local space.
    cowork_bound_device: {
      device_id: syntheticDeviceId,
      folders: folderPaths(space),
      local_space_id: space.id,
      migration_status: "complete",
      bound_at: updatedAt,
    },
    // Read only when the caller asked (`?include_has_sync_sources`). A space has
    // no claude.ai sync sources; this deployment's files are the folders above.
    has_sync_sources: false,
    sync_sources: [],
    counts: {},
  };
}

// The project request body mapped onto `createSpace`'s params
// `{name, description?, instructions?, origin?}` — the only keys its IPC
// validator admits, so nothing the renderer sends beyond these is forwarded.
function toCreateParams(body) {
  const params = { name: typeof body?.name === "string" ? body.name : "" };
  if (typeof body?.description === "string" && body.description) {
    params.description = body.description;
  }
  const instructions = body?.prompt_template ?? body?.instructions;
  if (typeof instructions === "string" && instructions) params.instructions = instructions;
  return params;
}

// `updateSpace`'s params: `{name?, description?, instructions?, ccdFolderPath?,
// autoMountFolders?}`.
function toUpdateParams(body) {
  const params = {};
  if (typeof body?.name === "string") params.name = body.name;
  if (typeof body?.description === "string") params.description = body.description;
  const instructions = body?.prompt_template ?? body?.instructions;
  if (typeof instructions === "string") params.instructions = instructions;
  return params;
}

function sortProjects(projects, orderBy) {
  const sorted = [...projects];
  if (orderBy === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (orderBy === createdSort) {
    sorted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  } else {
    // `latest_activity` is the renderer's default.
    sorted.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
  return sorted;
}

// Filter a mapped project list by the query params the two list endpoints send.
function filterProjects(projects, params) {
  const uuids = params.uuids;
  const wanted = Array.isArray(uuids) ? new Set(uuids) : null;
  const starred = params.starred;
  const search = typeof params.searchQuery === "string" ? params.searchQuery.trim().toLowerCase() : "";
  return projects.filter((project) => {
    if (wanted && !wanted.has(project.uuid)) return false;
    if (starred !== undefined && project.is_starred !== starred) return false;
    if (search && !project.name.toLowerCase().includes(search)) return false;
    return true;
  });
}

function readParams(searchParams) {
  const uuids = searchParams.getAll("uuids").flatMap((value) => value.split(",")).filter(Boolean);
  const bool = (name) => {
    const value = searchParams.get(name);
    if (value === null) return undefined;
    return value === "true";
  };
  const int = (name, fallback) => {
    const value = Number.parseInt(searchParams.get(name) ?? "", 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  return {
    limit: int("limit", 30),
    offset: int("offset", 0),
    uuids: uuids.length ? uuids : undefined,
    starred: bool("starred"),
    archived: bool("is_archived"),
    searchQuery: searchParams.get("searchQuery") ?? undefined,
    orderBy: searchParams.get("order_by") ?? undefined,
  };
}

export function createProjectBackend({ desktop, stateDir, log = console } = {}) {
  const statePath = stateDir ? join(stateDir, stateFileName) : null;
  // The star flags, loaded lazily and written back on change. A read failure is
  // an empty set — stars are cosmetic, so losing them must not fail a page.
  let stars = null;
  let starsLoading = null;
  let writeChain = Promise.resolve();

  async function loadStars() {
    if (stars) return stars;
    if (!statePath) return (stars = new Set());
    starsLoading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(statePath, "utf8"));
        return new Set(Array.isArray(parsed?.stars) ? parsed.stars.filter((id) => typeof id === "string") : []);
      } catch {
        return new Set();
      }
    })();
    const loaded = await starsLoading;
    return (stars = loaded);
  }

  // Serialized so two quick toggles cannot interleave their temp-file writes,
  // and awaited by the caller so a star survives a bridge restart immediately
  // after it is set.
  function persistStars() {
    if (!statePath || !stars) return Promise.resolve();
    const snapshot = [...stars];
    const write = writeChain.then(async () => {
      try {
        await mkdir(stateDir, { recursive: true });
        const temporary = `${statePath}.tmp`;
        await writeFile(temporary, JSON.stringify({ stars: snapshot }), "utf8");
        await rename(temporary, statePath);
      } catch (error) {
        log.warn?.(`[cowork-bridge] could not persist project stars: ${error.message}`);
      }
    });
    writeChain = write.catch(() => undefined);
    return write;
  }

  async function setStar(projectUuid, starred) {
    const current = await loadStars();
    if (starred) current.add(projectUuid);
    else current.delete(projectUuid);
    await persistStars();
  }

  async function spaces() {
    const value = await desktop.invoke("CoworkSpaces", "getAllSpaces", []);
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }

  async function mapped({ accountUuid }) {
    const current = await loadStars();
    return (await spaces()).map((space) => toProject(space, {
      accountUuid,
      starred: current.has(space.id),
    }));
  }

  async function spaceByUuid(projectUuid, { accountUuid }) {
    const space = await desktop.invoke("CoworkSpaces", "getSpace", [projectUuid]);
    if (!isRecord(space)) return null;
    const current = await loadStars();
    return toProject(space, { accountUuid, starred: current.has(space.id) });
  }

  return {
    // GET /projects — a bare array (the renderer reads either shape; see `SN`).
    async list({ accountUuid, searchParams }) {
      const params = readParams(searchParams);
      const projects = await mapped({ accountUuid });
      const filtered = filterProjects(projects, params);
      const sorted = sortProjects(filtered, params.orderBy);
      return sorted.slice(params.offset, params.offset + params.limit);
    },

    // GET /projects_v2 — the same rows in a page envelope. The renderer reads
    // `data`; `pagination` is stated for completeness.
    async page({ accountUuid, searchParams }) {
      const params = readParams(searchParams);
      const projects = await mapped({ accountUuid });
      const filtered = filterProjects(projects, params);
      const sorted = sortProjects(filtered, params.orderBy);
      const data = sorted.slice(params.offset, params.offset + params.limit);
      return {
        data,
        pagination: {
          has_more: params.offset + data.length < sorted.length,
          limit: params.limit,
          offset: params.offset,
          total: sorted.length,
        },
      };
    },

    async count() {
      return (await spaces()).length;
    },

    get: (projectUuid, context) => spaceByUuid(projectUuid, context),

    async create({ accountUuid, body }) {
      const space = await desktop.invoke("CoworkSpaces", "createSpace", [toCreateParams(body)]);
      if (!isRecord(space)) throw new Error("createSpace answered nothing");
      // The renderer's create mutation forces `is_starred: true` into the body,
      // so a fresh project is starred unless the caller says otherwise.
      const starred = body?.is_starred !== false;
      if (starred) await setStar(space.id, true);
      return toProject(space, { accountUuid, starred });
    },

    async update({ accountUuid, projectUuid, body }) {
      const current = await loadStars();
      if (typeof body?.is_starred === "boolean") await setStar(projectUuid, body.is_starred);
      const params = toUpdateParams(body);
      const space = Object.keys(params).length
        ? await desktop.invoke("CoworkSpaces", "updateSpace", [projectUuid, params])
        : await desktop.invoke("CoworkSpaces", "getSpace", [projectUuid]);
      if (!isRecord(space)) return null;
      const starred = typeof body?.is_starred === "boolean"
        ? body.is_starred
        : current.has(projectUuid);
      return toProject(space, { accountUuid, starred });
    },

    async remove({ projectUuid }) {
      await desktop.invoke("CoworkSpaces", "deleteSpace", [projectUuid]);
      const current = await loadStars();
      if (current.delete(projectUuid)) await persistStars();
    },

    async setStar({ projectUuid, starred }) {
      await setStar(projectUuid, starred);
    },

    // For tests: the star set as currently held.
    async starredIds() {
      return [...(await loadStars())];
    },
  };
}
