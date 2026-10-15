import { patchRendererSources } from "./renderer-patches.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
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

async function prepareRenderer() {
  const files = await listJavaScriptFiles(ionRoot);
let sources = new Map();
for (const file of files) sources.set(file, await readFile(file, "utf8"));
const officialSources = new Map(sources);

  // What this generation was made from, so an unchanged start can skip the work
  // entirely. The preparation is a pure function of the renderer sources plus the
  // two flags and the release it is stamped with, and it costs about a minute of
  // parsing for every container that starts — this deployment's own instance and
  // every account's, all of them byte-identical. Container initialization runs it
  // on *every* start, including the "already patched" fast path, so without a key
  // a restart or a redundant recreate pays that minute again for output it
  // already has.
  const inputsHash = createHash("sha256");
  for (const value of [installedVersion, release.patchRelease,
    process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1" ? "gateway" : "no-gateway",
    process.env.CLAUDE_REMOTE_WEB_SHELL === "1" ? "web-shell" : "desktop-shell"]) {
    inputsHash.update(value).update("\0");
  }
  for (const path of [...sources.keys()].sort()) {
    inputsHash.update(relative(ionRoot, path)).update("\0").update(sources.get(path)).update("\0");
  }
  const inputsKey = inputsHash.digest("hex");
  const basePath = `/renderer/${installedVersion}/${release.patchRelease}`;

  // The key alone is not enough: the output directory can be gone (a fresh
  // container, a wiped state root) with the key still on the host. The
  // generation's own manifest and its record of the inputs must both be there.
  const recorded = await readFile(resolve(outputRoot, ".inputs"), "utf8").catch(() => null);
  const manifestPresent = await readFile(resolve(outputRoot, "manifest.json"))
    .then(() => true, () => false);
  if (recorded === inputsKey && manifestPresent) {
    console.log(`[renderer-prepare] ready ${basePath}; inputs unchanged`);
    return;
  }

  const result = patchRendererSources(sources, process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1",
  process.env.CLAUDE_REMOTE_WEB_SHELL === "1");
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
    // Container initialization runs as root; Electron serves these assets as
    // the app user. mkdtemp defaults to 0700, even after the directory is renamed.
    await chmod(stagingRoot, 0o755);
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
    // Written last, so a generation that failed above never claims the inputs.
    await writeFile(resolve(outputRoot, ".inputs"), inputsKey, { mode: 0o644 });
    console.log(`[renderer-prepare] ready ${manifest.basePath}; patches=${patchRecords.length}`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

await prepareRenderer();
