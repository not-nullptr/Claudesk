import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { listWorkspaceFolders } from "../bridge/workspace-folders.mjs";

const temporary = await mkdtemp(join(tmpdir(), "claudesk-folders-"));
try {
  const root = join(temporary, "workspace");
  const outside = join(temporary, "outside");
  for (const path of [root, outside, join(root, "project space"), join(root, "empty")]) await mkdir(path);
  await writeFile(join(root, "file.txt"), "not a folder");
  await symlink(outside, join(root, "escape"), "junction");
  await symlink(join(root, "project space"), join(root, "alias"), "junction");
  const listing = await listWorkspaceFolders(root);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.folders.map(folder => folder.name), ["alias", "empty", "project space"]);
  assert.equal(listing.folders[0].path, join(root, "project space"));
  assert.equal((await listWorkspaceFolders(root, join(root, "empty"))).folders.length, 0);
  assert.equal((await listWorkspaceFolders(root, join(root, "empty"))).parent, root);
  for (const path of [outside, join(root, "escape"), join(root, "..", "outside")]) {
    await assert.rejects(listWorkspaceFolders(root, path), error => error.statusCode === 403);
  }
  await assert.rejects(listWorkspaceFolders(root, join(root, "missing")), error => error.statusCode === 404);
  await assert.rejects(listWorkspaceFolders(root, join(root, "file.txt")), error => error.statusCode === 400);
  const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
  const start = preload.indexOf("  function browserMethod(");
  const end = preload.indexOf("  const root = Object.create(null);", start);
  let result = ["/workspace/project space"], options;
  const context = { globalThis: { __CLAUDE_PICK_SERVER_FOLDERS__: async value => { options = value; return result; } },
    browseBrowserFiles: () => { throw new Error("folder selection must never upload browser files"); } };
  vm.runInNewContext(`${preload.slice(start, end)}\nthis.method=browserMethod;`, context);
  assert.equal(await context.method("FileSystem", "browseFolder")("Choose a folder", true, true, "/workspace/empty"), result[0]);
  assert.equal(options.initialPath, "/workspace/empty");
  result = ["/workspace/a", "/workspace/b"];
  assert.deepEqual(await context.method("FileSystem", "browseFolders")("Select folders"), result);
  assert.equal(options.multiple, true);
  assert.equal(await context.method("CoworkUserFiles", "pickTarget")(), result[0]);
  result = null;
  assert.equal(await context.method("FileSystem", "browseFolder")(), null);
  assert.equal(await context.method("FileSystem", "browseFolders")(), null);
  console.log("workspace-folders-smoke: server paths, confinement, multi-selection and cancellation passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
