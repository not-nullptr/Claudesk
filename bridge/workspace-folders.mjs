import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveContainedRealPath } from "./downloads.mjs";

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
