import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { patchRendererSources } from "../rootfs/opt/claude-cowork-bridge/renderer-patches.mjs";

const { minify } = createRequire(new URL("../rootfs/opt/claude-cowork-bridge/package.json", import.meta.url))("terser");

// Pass ion-dist from an extracted official package to verify real release anchors.
const ionRoot = process.argv[2];
assert.ok(ionRoot, "usage: node scripts/desktop-compatibility-smoke.mjs /path/to/ion-dist");
const root = resolve(import.meta.dirname, "..");
const releasePath = join(root, "config/release.json");
const release = JSON.parse(await readFile(releasePath, "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "claudesk-compatibility-"));
function run(script, args, env = {}) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
}
try {
  let gatewayManifest;
  for (const gateway of ["0", "1"]) {
    const state = join(temporary, `renderer-${gateway}`);
    const result = run("rootfs/opt/claude-cowork-bridge/prepare-renderer.mjs",
      [resolve(ionRoot), state, releasePath], {
        CLAUDE_DESKTOP_VERSION: release.desktopVersion,
        CLAUDE_REMOTE_GATEWAY_SETTINGS: gateway,
      });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(state, "current.json"), "utf8"));
    assert.equal(manifest.desktopVersion, release.desktopVersion);
    assert.equal(manifest.patches.length, gateway === "1" ? 2 : 0);
    assert.equal(manifest.markers.length, 4);
    if (gateway === "1") gatewayManifest = manifest;
    for (const file of manifest.files) {
      const syntax = spawnSync(process.execPath, ["--check", join(state,
        release.desktopVersion, release.patchRelease, file.path)], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  // Exercise the real official targets through another compiler pass, rather
  // than just testing handwritten examples that resemble current minification.
  const paths = new Set([...gatewayManifest.patches.map(patch => patch.path),
    ...gatewayManifest.markers.flatMap(marker => marker.matches.map(match => match.path))]);
  const originals = new Map(await Promise.all([...paths].map(async path =>
    [path, await readFile(join(ionRoot, path), "utf8")])));
  const orderedPaths = [...paths].sort();
  await writeFile(join(temporary, "health.json"), JSON.stringify({ renderer: gatewayManifest }));
  await writeFile(join(temporary, "renderer-assets.txt"), orderedPaths.join("\n"));
  for (const [i, path] of orderedPaths.entries()) {
    const prepared = gatewayManifest.files.some(file => file.path === path);
    const sourcePath = prepared ? join(temporary, "renderer-1", release.desktopVersion,
      release.patchRelease, path) : join(ionRoot, path);
    await writeFile(join(temporary, `renderer-${i + 1}.js`), await readFile(sourcePath, "utf8"));
  }
  assert.equal(run("scripts/verify-renderer-markers.mjs", [temporary]).status, 0);
  const firstEvidence = gatewayManifest.markers[0].matches[0];
  const evidenceFile = join(temporary, `renderer-${orderedPaths.indexOf(firstEvidence.path) + 1}.js`);
  const correctEvidence = await readFile(evidenceFile, "utf8");
  await writeFile(evidenceFile, correctEvidence.replaceAll(firstEvidence.evidence[0], "/* altered */"));
  assert.notEqual(run("scripts/verify-renderer-markers.mjs", [temporary]).status, 0,
    "HTTP smoke verifier must reject altered module content");
  for (const compress of [false, { passes: 2 }]) {
    const changed = new Map(originals);
    for (const [i, patch] of gatewayManifest.patches.entries()) {
      const source = originals.get(patch.path);
      const compiled = await minify(source, { module: true, compress,
        mangle: { toplevel: true }, format: { quote_style: 1 } });
      assert.ok(compiled.code);
      changed.delete(patch.path);
      changed.set(`moved/chunk-${i}.js`, compiled.code);
    }
    const patched = patchRendererSources(changed, true);
    assert.equal(patched.patches.length, 2);
    assert.ok(patched.patches.every(patch => patch.path.startsWith("moved/")));
    assert.equal(patched.markers.length, 4);
  }
  const packagePath = join(temporary, "package.json");
  const official = { name: "@ant/desktop", version: release.desktopVersion,
    main: ".vite/build/index.pre.js" };
  await writeFile(packagePath, JSON.stringify(official));
  const patcher = "rootfs/opt/claude-cowork-bridge/patch-package.mjs";
  assert.equal(run(patcher, [packagePath, releasePath], { CLAUDE_COWORK_HOST_BASH: "0" }).status, 0);
  const patched = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(patched.claudeCoworkBridgeOriginalMain, official.main);
  assert.equal(patched.main, "bridge-wrapper/loader.cjs");
  await writeFile(packagePath, JSON.stringify(official));
  assert.notEqual(run(patcher, [packagePath, releasePath], { CLAUDE_COWORK_HOST_BASH: "1" }).status, 0);
  assert.deepEqual(JSON.parse(await readFile(packagePath, "utf8")), official);
  await writeFile(packagePath, JSON.stringify({ ...official, version: "0.0.0" }));
  assert.notEqual(run(patcher, [packagePath, releasePath]).status, 0);
  console.log(`desktop-compatibility-smoke: Desktop ${release.desktopVersion} real bundles, re-minification, served evidence and guards passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
