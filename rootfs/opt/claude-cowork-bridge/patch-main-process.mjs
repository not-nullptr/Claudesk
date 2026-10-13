// Rewrite the Desktop main process's own copy of the Gateway URL schema in an
// already-extracted app archive, before it is repacked.
//
//   patch-main-process.mjs /path/to/extracted/app
//
// The renderer patcher (prepare-renderer.mjs) covers the app UI, which is where
// the settings field lives. The main process bundles the same schema again, and
// the Gateway connection test and model discovery run there — so without this an
// http endpoint off the loopback is accepted by the field and then refused by
// the process that actually dials it. Only that one splice is applied; the
// renderer's required patches mean nothing here.
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { patchEmbeddedSources } from "./renderer-patches.mjs";

const root = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: patch-main-process.mjs EXTRACTED_APP_DIR");
const buildRoot = resolve(root, ".vite/build");
if (!buildRoot.startsWith(`${root}${sep}`)) throw new Error("build directory escaped the app root");

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

const files = await listJavaScriptFiles(buildRoot);
const sources = new Map();
for (const file of files) sources.set(file, await readFile(file, "utf8"));

const result = patchEmbeddedSources(sources);
if (!result.patches.length) {
  throw new Error(
    "main process Gateway URL guard not found; the endpoint would be refused and the gateway would not answer",
  );
}
// The archive builds the schema into more than one entry (the main bundle and
// the preload), so a file may legitimately be one target — but never two.
const perFile = new Map();
for (const patch of result.patches) perFile.set(patch.path, (perFile.get(patch.path) || 0) + 1);
for (const [path, count] of perFile) {
  if (count !== 1) throw new Error(`main process Gateway URL guard in ${path} expected once, found ${count}`);
}
for (const [path, text] of result.sources) {
  if (text === sources.get(path)) continue;
  await writeFile(path, text);
}
// The archive carries V8 code caches for the entries it shipped. A rewritten
// entry must not be served from a cache compiled against the old source.
const cacheRoot = resolve(root, "compile-cache");
const cached = await readdir(cacheRoot).catch(() => []);
for (const patch of result.patches) {
  const base = patch.path.slice(patch.path.lastIndexOf("/") + 1);
  for (const entry of cached) {
    if (entry.includes(base)) await rm(resolve(cacheRoot, entry), { force: true });
  }
}
console.log(`patch-main-process: rewrote the Gateway URL guard in ${result.patches[0].path}`);
