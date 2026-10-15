import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { assembleRenderer, rendererPrefilter } from "./renderer-patches.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
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

const gatewayEnabled = process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1";
const webShellEnabled = process.env.CLAUDE_REMOTE_WEB_SHELL === "1";

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

async function fileExists(path) {
  return stat(path).then(() => true, () => false);
}

// A generation is a few patched chunks and two small files, so copying one is
// cheap; it is done by hand rather than with `fs.cp`, which is still marked
// experimental on the distro Node the image runs and would put a warning in
// every container's init log. Modes are set explicitly to match what the
// generator writes — Electron reads these as the app user.
async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await chmod(destination, 0o755);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else {
      await copyFile(from, to);
      await chmod(to, 0o644);
    }
  }
}

// What the patcher *is*, not just what it is run on. The generation is a pure
// function of the ion-dist sources, the two flags and this code, so a change to
// the patcher has to move the key or the next start would reuse a generation the
// new code would never have produced. The key used to be built from the release
// alone, which is why editing the patcher without bumping `patchRelease` was
// silently ignored: the key was unchanged and the fast path returned the old
// output. `acorn` is in here too because a new parser can change what is
// accepted.
async function patcherKey() {
  const parts = [];
  for (const name of ["renderer-patches.mjs", "prepare-renderer.mjs"]) {
    parts.push(name, await readFile(resolve(moduleDir, name), "utf8"));
  }
  try {
    const acorn = JSON.parse(await readFile(resolve(moduleDir, "node_modules/acorn/package.json"), "utf8"));
    parts.push("acorn", acorn.version ?? "");
  } catch {
    parts.push("acorn", "unresolved");
  }
  return sha256(parts.join("\0"));
}

// The parallel half of the analysis. `inspectRenderer` is a pure function of one
// chunk, so the chunks are dealt to worker threads by size (longest first, to
// the least-loaded bucket) and the results are merged back into the Map
// `assembleRenderer` expects. Only the chunks the prefilter accepts are ever
// handed out, and only ~25 MB of the official 113 MB survives it.
async function inspectInParallel(paths, sizes, gatewayEnabledFlag, webShellEnabledFlag) {
  // `availableParallelism` is Node 18.14+; the image's distro node may predate
  // it, so fall back rather than fail the whole preparation on the import.
  const cores = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  const jobs = Math.max(1, Math.min(
    Number(process.env.CLAUDESK_RENDERER_JOBS) || 8,
    cores,
    paths.length,
  ));
  const buckets = Array.from({ length: jobs }, () => ({ paths: [], bytes: 0 }));
  for (const path of [...paths].sort((a, b) => sizes.get(b) - sizes.get(a))) {
    const bucket = buckets.reduce((least, candidate) => (candidate.bytes < least.bytes ? candidate : least));
    bucket.paths.push(path);
    bucket.bytes += sizes.get(path) ?? 0;
  }
  const workerPath = resolve(moduleDir, "renderer-inspect-worker.mjs");
  const batches = await Promise.all(buckets.filter(bucket => bucket.paths.length).map(bucket =>
    new Promise((resolveBatch, rejectBatch) => {
      const worker = new Worker(workerPath, {
        workerData: { paths: bucket.paths, gatewayEnabled: gatewayEnabledFlag, webShellEnabled: webShellEnabledFlag },
      });
      let settled = false;
      worker.once("message", (analyses) => { settled = true; worker.terminate().then(() => resolveBatch(analyses), () => resolveBatch(analyses)); });
      worker.once("error", (error) => { if (!settled) { settled = true; rejectBatch(error); } });
      worker.once("exit", (code) => {
        if (!settled) { settled = true; rejectBatch(new Error(`renderer inspection worker exited with ${code}`)); }
      });
    })));

  const analyses = new Map();
  for (const batch of batches) {
    for (const [path, analysis] of batch) analyses.set(path, analysis);
  }
  return analyses;
}

// A generation the deployment already built, for exactly this key. Deploying
// costs one preparation for the whole box instead of one per account; a
// container that finds its key missing simply falls through and prepares its
// own, so a stale or absent seed is slow, never wrong.
async function adoptSeed(inputsKey) {
  const seedRoot = process.env.CLAUDESK_RENDERER_SEED;
  if (!seedRoot) return false;
  const seed = resolve(seedRoot, inputsKey);
  if (!(await fileExists(resolve(seed, "manifest.json")))) return false;
  if ((await readFile(resolve(seed, ".inputs"), "utf8").catch(() => null)) !== inputsKey) return false;
  const manifest = JSON.parse(await readFile(resolve(seed, "manifest.json"), "utf8"));
  if (manifest.basePath !== `/renderer/${installedVersion}/${release.patchRelease}`) return false;

  await mkdir(dirname(outputRoot), { recursive: true });
  const stagingRoot = await mkdtemp(`${outputRoot}.staging-`);
  try {
    // Container initialization runs as root; Electron serves these assets as
    // the app user. mkdtemp defaults to 0700, even after the directory is renamed.
    await chmod(stagingRoot, 0o755);
    await copyTree(seed, stagingRoot);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, outputRoot);
    await publishPointer(manifest);
    console.log(`[renderer-prepare] ready ${manifest.basePath}; adopted from the deploy's seed`);
    return true;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function publishPointer(manifest) {
  const pointer = resolve(stateRoot, "current.json.tmp");
  await writeFile(pointer, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  await rename(pointer, resolve(stateRoot, "current.json"));
}

// Hand this generation to the deploy's seed directory, keyed by its inputs, so
// the next account's container adopts it instead of paying for the parse. Only
// the deploy sets the variable, and only its own one-off prepare writes here —
// a container never does. Best-effort on purpose: failing to share a generation
// is a container preparing its own, which is always correct.
async function publishSeed(inputsKey, generationRoot) {
  const seedRoot = process.env.CLAUDESK_RENDERER_SEED_PUBLISH;
  if (!seedRoot) return;
  try {
    const destination = resolve(seedRoot, inputsKey);
    await mkdir(resolve(seedRoot), { recursive: true });
    const staging = await mkdtemp(resolve(seedRoot, ".publishing-"));
    await copyTree(generationRoot, staging);
    await rm(destination, { recursive: true, force: true });
    // A rename from a staging directory in the same seed root, so a container
    // reading the seed never sees a half-written generation.
    await rename(staging, destination);
    console.log(`[renderer-prepare] shared this generation as seed ${inputsKey.slice(0, 12)}`);
  } catch (error) {
    console.error(`[renderer-prepare] could not publish a seed (${error.message}); continuing`);
  }
}

async function prepareRenderer() {
  const files = await listJavaScriptFiles(ionRoot);
  let sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, "utf8"));
  const officialSources = new Map(sources);

  // What this generation was made from, so an unchanged start can skip the work
  // entirely. The preparation is a pure function of the renderer sources plus the
  // two flags, the patcher and the release it is stamped with, and it costs tens
  // of seconds for every container that starts — this deployment's own instance
  // and every account's, all of them byte-identical. Container initialization
  // runs it on *every* start, including the "already patched" fast path, so
  // without a key a restart or a redundant recreate pays that cost again for
  // output it already has.
  const inputsHash = createHash("sha256");
  for (const value of [installedVersion, release.patchRelease,
    gatewayEnabled ? "gateway" : "no-gateway",
    webShellEnabled ? "web-shell" : "desktop-shell",
    await patcherKey()]) {
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
  const manifestPresent = await fileExists(resolve(outputRoot, "manifest.json"));
  if (recorded === inputsKey && manifestPresent) {
    console.log(`[renderer-prepare] ready ${basePath}; inputs unchanged`);
    return;
  }

  if (await adoptSeed(inputsKey)) return;

  // Only the chunks the prefilter accepts are worth handing to a parser: the
  // other ~3300 chunks of ion-dist carry no target at all.
  const sizes = new Map([...sources].map(([path, source]) => [path, source.length]));
  const candidates = [...sources].filter(([, source]) => rendererPrefilter.test(source)).map(([path]) => path);
  const result = assembleRenderer(sources,
    await inspectInParallel(candidates, sizes, gatewayEnabled, webShellEnabled),
    gatewayEnabled, webShellEnabled);
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
    await publishPointer(manifest);
    // Written last, so a generation that failed above never claims the inputs.
    await writeFile(resolve(outputRoot, ".inputs"), inputsKey, { mode: 0o644 });
    await publishSeed(inputsKey, outputRoot);
    console.log(`[renderer-prepare] ready ${manifest.basePath}; patches=${patchRecords.length}`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

await prepareRenderer();
