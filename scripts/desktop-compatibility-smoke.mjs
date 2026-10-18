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
  let webShellManifest;
  let tenantManifest;
  // Both Gateway modes without the web shell (the plain Desktop client), plus
  // the web shell itself — the deployment's actual mode, which adds the chrome
  // patches (route alias, session Desktop gate, local session placement,
  // account chip avatar, account photo fallback, identity seed, permission
  // wiring, notification enable, the scheduled-task runner gate, the
  // scheduled-task hosts, the new-page home-layout assignment, the forced
  // unified-composer design predicates, the routine fire origin, and the
  // routine form's model/effort picker and start options) — plus a **tenant**
  // web shell, which is the same generation plus the self-hosted start-option
  // patches (folder, branch and worktree). The web shell itself carries the
  // Code bypass-permission patches in both modes. See
  // docs/code-in-cowork-vm.md.
  // A selector that drifts against a new official bundle must fail here, not
  // in production.
  for (const [gateway, webShell, tenant] of [["0", "0", "0"], ["1", "0", "0"],
    ["1", "1", "0"], ["1", "1", "1"]]) {
    const state = join(temporary,
      `renderer-${gateway}${webShell === "1" ? "-web" : ""}${tenant === "1" ? "-tenant" : ""}`);
    const result = run("rootfs/opt/claude-cowork-bridge/prepare-renderer.mjs",
      [resolve(ionRoot), state, releasePath], {
        CLAUDE_DESKTOP_VERSION: release.desktopVersion,
        CLAUDE_REMOTE_GATEWAY_SETTINGS: gateway,
        CLAUDE_REMOTE_WEB_SHELL: webShell,
        CLAUDESK_TENANT: tenant,
      });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(state, "current.json"), "utf8"));
    assert.equal(manifest.desktopVersion, release.desktopVersion);
    assert.equal(manifest.patches.length,
      webShell === "1" ? (tenant === "1" ? 85 : 72) : gateway === "1" ? 8 : 6);
    // A tenant keeps the route alias: `/code` must resolve to the surface this
    // bridge drives, exactly as on the deployment's own instance.
    assert.equal(
      manifest.patches.some(patch => patch.id === "desktop-code-route-alias"),
      webShell === "1",
      "the web shell's Code route alias is spliced for a tenant too");
    assert.equal(manifest.markers.length, 4);
    assert.ok(manifest.patches.some(patch => patch.id === "file-pane-download"),
      "the file pane's streaming download button must be present");
    assert.ok(manifest.patches.some(patch => patch.id === "inference-banner"),
      "the provider card must be removed in both Gateway modes");
    assert.ok(manifest.patches.some(patch => patch.id === "titlebar-mode-picker-without-code"),
      "the titlebar's mode picker must be hidden when Code is off");
    assert.equal(manifest.patches.some(patch => patch.id === "routine-fire-origin"),
      webShell === "1",
      "the routine API card's fire origin must be this deployment in the web shell");
    assert.equal(manifest.patches.some(patch => patch.id === "routine-api-trigger"),
      webShell === "1",
      "the routine form must offer the API trigger in the web shell");
    // The routine form in any served web shell — the operator's own instance
    // and a tenant's alike — carries the Code composer's model+effort picker
    // and the start options its scheduled task stores, and the Code surface
    // offers bypass permissions.
    assert.equal(manifest.patches.some(patch => patch.id === "routine-model-effort-picker"),
      webShell === "1", "the web shell's routine form offers model and effort pickers");
    assert.equal(manifest.patches.some(patch => patch.id === "routine-form-start-option-rows"),
      webShell === "1", "the web shell's routine form offers cwd and permission mode");
    // The Code surface's own routine page and edit dialog render a second
    // instructions composer; it carries the same picker and rows.
    assert.equal(manifest.patches.some(patch => patch.id === "routine-epitaxy-start-options"),
      webShell === "1", "the Code surface's routine page offers the picker and start options");
    assert.equal(manifest.patches.some(patch => patch.id === "routine-model-picker-publish"),
      webShell === "1", "the shared model+effort wrapper is published for that page");
    assert.equal(manifest.patches.some(patch => patch.id === "code-bypass-permission-list"),
      webShell === "1", "the web shell's Code permission modes include bypass");
    assert.equal(manifest.patches.some(patch => patch.id === "code-bypass-availability"),
      webShell === "1", "bypass permissions is available in the web shell");
    assert.equal(manifest.patches.some(patch => patch.id === "code-bypass-self-hosted-modes"),
      webShell === "1", "a self-hosted place's mode list carries bypass");

    if (gateway === "1" && webShell === "0") gatewayManifest = manifest;
    if (webShell === "1" && tenant === "0") webShellManifest = manifest;
    if (tenant === "1") tenantManifest = manifest;
    for (const file of manifest.files) {
      const generated = await readFile(join(state,
        release.desktopVersion, release.patchRelease, file.path), "utf8");
      const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        encoding: "utf8", input: generated,
      });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  // Serve of the marker evidence and of every patched module comes from the
  // web-shell generation, the strongest of the three preparations.
  const paths = new Set([...gatewayManifest.patches, ...webShellManifest.patches]
    .map(patch => patch.path)
    .concat(gatewayManifest.markers.flatMap(marker =>
      marker.matches.map(match => match.path))));
  const originals = new Map(await Promise.all([...paths].map(async path =>
    [path, await readFile(join(ionRoot, path), "utf8")])));
  const orderedPaths = [...paths].sort();
  await writeFile(join(temporary, "health.json"), JSON.stringify({ renderer: webShellManifest }));
  await writeFile(join(temporary, "renderer-assets.txt"), orderedPaths.join("\n"));
  for (const [i, path] of orderedPaths.entries()) {
    const gatewayPrepared = gatewayManifest.files.some(file => file.path === path);
    const webShellPrepared = webShellManifest.files.some(file => file.path === path);
    // A tenant generation carries start-option patches on chunks the owner's
    // generation leaves untouched, so its files live in their own directory.
    const tenantPrepared = tenantManifest.files.some(file => file.path === path);
    const sourcePath = gatewayPrepared
      ? join(temporary, "renderer-1", release.desktopVersion, release.patchRelease, path)
      : webShellPrepared
        ? join(temporary, "renderer-1-web", release.desktopVersion, release.patchRelease, path)
        : tenantPrepared
          ? join(temporary, "renderer-1-web-tenant", release.desktopVersion, release.patchRelease, path)
          : join(ionRoot, path);
    await writeFile(join(temporary, `renderer-${i + 1}.js`), await readFile(sourcePath, "utf8"));
  }
  assert.equal(run("scripts/verify-renderer-markers.mjs", [temporary]).status, 0);
  const firstEvidence = gatewayManifest.markers[0].matches[0];
  const evidenceFile = join(temporary, `renderer-${orderedPaths.indexOf(firstEvidence.path) + 1}.js`);
  const correctEvidence = await readFile(evidenceFile, "utf8");
  await writeFile(evidenceFile, correctEvidence.replaceAll(firstEvidence.evidence[0], "/* altered */"));
  assert.notEqual(run("scripts/verify-renderer-markers.mjs", [temporary]).status, 0,
    "HTTP smoke verifier must reject altered module content");
  // Exercise the real official targets through another compiler pass, rather
  // than just testing handwritten examples that resemble current minification.
  // The web-shell chrome anchors are covered by the unminified
  // preparation above and by renderer-patches-smoke's minified fixtures; heavy
  // multi-pass compression rewrites the route-alias resolver beyond any
  // structural read-back, so only the always-on and Gateway targets run here.
  for (const compress of [false, { passes: 2 }]) {
    const changed = new Map(originals);
    // One moved file per patched source, not per patch: a chunk can carry several
    // targets (the user-menu chunk holds the provider card and the Sign out flag),
    // and re-adding it once per target would duplicate its patches.
    const patchedPaths = [...new Set(gatewayManifest.patches.map(patch => patch.path))];
    for (const [i, path] of patchedPaths.entries()) {
      const source = originals.get(path);
      const compiled = await minify(source, { module: true, compress,
        mangle: { toplevel: true }, format: { quote_style: 1 } });
      assert.ok(compiled.code);
      changed.delete(path);
      changed.set(`moved/chunk-${i}.js`, compiled.code);
    }
    const patched = patchRendererSources(changed, true);
    assert.equal(patched.patches.length, 8);
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
