import { mkdir, opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveContainedRealPath } from "./downloads.mjs";

// A folder name the picker offers to create must be a single path segment: no
// separators (which would let it escape the browsed directory), no traversal
// names, and nothing a filesystem call reads as a control character.
export function validFolderName(name) {
  if (typeof name !== "string") return false;
  if (!name || name === "." || name === "..") return false;
  if (name.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  return !/[/\\\u0000-\u001f\u007f]/.test(name);
}

export async function listWorkspaceFolders(root, requested = root) {
  if (typeof requested !== "string" || !requested || requested.length > 4096) {
    throw Object.assign(new Error("workspace folder path is invalid"), { statusCode: 400 });
  }
  const canonicalRoot = await resolveContainedRealPath(root, root);
  const path = await resolveContainedRealPath(root, requested);
  if (!(await stat(path)).isDirectory()) {
    throw Object.assign(new Error("workspace path is not a folder"), { statusCode: 400 });
  }
  const folders = [];
  // Bound the response; include only directories whose real paths stay inside
  // the mounted workspace, including safe internal symlinks.
  const directory = await opendir(path);
  let truncated = false;
  for await (const entry of directory) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const child = await resolveContainedRealPath(canonicalRoot, join(path, entry.name));
      if (!(await stat(child)).isDirectory()) continue;
      if (folders.length === 1000) { truncated = true; break; }
      folders.push({ name: entry.name, path: child });
    } catch (error) {
      if (![403, 404].includes(error.statusCode) && !["EACCES", "ENOENT", "ELOOP"].includes(error.code)) throw error;
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { root: canonicalRoot, path, parent: path === canonicalRoot ? null : dirname(path), folders, truncated };
}

// The picker's "New folder" affordance. It mirrors the confinement of the
// listing: the parent must be a real directory inside the workspace, the name
// is one segment, and the created directory is re-resolved against the
// canonical root so a name that lands on a symlink cannot escape. `mkdir`
// without `recursive` is the atomic existence check — an EEXIST is reported as
// a conflict rather than silently reusing an existing folder.
export async function createWorkspaceFolder(root, requested, name) {
  if (!validFolderName(name)) {
    throw Object.assign(new Error("folder name is invalid"), { statusCode: 400 });
  }
  const canonicalRoot = await resolveContainedRealPath(root, root);
  const parent = await resolveContainedRealPath(
    canonicalRoot,
    typeof requested === "string" && requested ? requested : canonicalRoot,
  );
  if (!(await stat(parent)).isDirectory()) {
    throw Object.assign(new Error("workspace path is not a folder"), { statusCode: 400 });
  }
  const target = join(parent, name);
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("a folder with that name already exists"), { statusCode: 409 });
    }
    if (error.code === "EACCES" || error.code === "ENOENT" || error.code === "EPERM") {
      throw Object.assign(new Error("could not create the folder"), { statusCode: 403 });
    }
    throw error;
  }
  const created = await resolveContainedRealPath(canonicalRoot, target);
  return { path: created, name };
}
