import { patchRendererSources } from "./renderer-patches.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const ionRoot = resolve(process.argv[2] || "/usr/lib/claude-desktop/resources/ion-dist");
const stateRoot = resolve(process.argv[3] || "/var/lib/claude-cowork-bridge/renderer");
const release = JSON.parse(readFileSync(process.argv[4] || "/opt/claude-cowork-bridge/release.json", "utf8"));
const installedVersion = process.env.CLAUDE_DESKTOP_VERSION || "";

if (!/^\d+\.\d+\.\d+$/.test(installedVersion)) {
  throw new Error("CLAUDE_DESKTOP_VERSION must be an exact three-part version");
}
if (installedVersion !== release.desktopVersion) {
  throw new Error(
    `release supports Desktop ${release.desktopVersion}, installed ${installedVersion}`,
  );
}
if (!/^\d{8}-\d+$/.test(release.patchRelease)) {
  throw new Error("patchRelease is invalid");
}

const outputRoot = resolve(stateRoot, installedVersion, release.patchRelease);
if (!outputRoot.startsWith(`${stateRoot}${sep}`)) throw new Error("renderer output escaped state root");

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const files = await listJavaScriptFiles(ionRoot);
let sources = new Map();
for (const file of files) sources.set(file, await readFile(file, "utf8"));
const officialSources = new Map(sources);

const result = patchRendererSources(sources, process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1");
sources = result.sources;
const patchRecords = result.patches.map(patch => ({
  id: patch.id,
  selector: "javascript-structure",
  path: relative(ionRoot, patch.path),
  original: patch.original,
  inputSha256: sha256(officialSources.get(patch.path)),
  outputSha256: sha256(sources.get(patch.path)),
}));
const markerRecords = result.markers.map(marker => ({
  ...marker,
  matches: marker.matches.map(match => ({ ...match, path: relative(ionRoot, match.path) })),
}));

const changedFiles = new Set(patchRecords.map((record) => record.path));
const generatedFiles = [];
// Validate everything before touching the last working generation. Publish the
// pointer last, with an atomic rename, so failed upgrades retain current.json.
await mkdir(dirname(outputRoot), { recursive: true });
const stagingRoot = await mkdtemp(`${outputRoot}.staging-`);
try {
  for (const relativePath of changedFiles) {
    const destination = resolve(stagingRoot, relativePath);
    const officialSource = officialSources.get(resolve(ionRoot, relativePath));
    const generatedSource = sources.get(resolve(ionRoot, relativePath));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, generatedSource, { mode: 0o644 });
    // These browser bundles are ESM regardless of the staging directory's
    // package scope. Node 18 otherwise checks .js files as CommonJS.
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      encoding: "utf8", input: generatedSource,
    });
    if (syntax.status !== 0) {
      throw new Error(`generated renderer syntax invalid: ${relativePath}\n${syntax.stderr}`);
    }
    generatedFiles.push({
      path: relativePath,
      inputSha256: sha256(officialSource),
      outputSha256: sha256(generatedSource),
    });
  }

  const manifest = {
    desktopVersion: installedVersion,
    patchRelease: release.patchRelease,
    basePath: `/renderer/${installedVersion}/${release.patchRelease}`,
    generatedAt: new Date().toISOString(),
    patches: patchRecords,
    files: generatedFiles,
    markers: markerRecords,
  };
  await writeFile(
    resolve(stagingRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  await rm(outputRoot, { recursive: true, force: true });
  await rename(stagingRoot, outputRoot);
  const pointer = resolve(stateRoot, "current.json.tmp");
  await writeFile(pointer, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  await rename(pointer, resolve(stateRoot, "current.json"));
  console.log(`[renderer-prepare] ready ${manifest.basePath}; patches=${patchRecords.length}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
