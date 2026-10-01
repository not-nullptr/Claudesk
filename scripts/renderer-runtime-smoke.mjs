import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// This test deliberately supports the container's Node 18 runtime and stages
// ESM .js files outside a type:module package scope, as container startup does.
const releasePath = fileURLToPath(new URL("../config/release.json", import.meta.url));
const preparePath = fileURLToPath(new URL("../rootfs/opt/claude-cowork-bridge/prepare-renderer.mjs", import.meta.url));
const release = JSON.parse(await readFile(releasePath, "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "claudesk-runtime-"));
try {
  const ion = join(temporary, "ion");
  const state = join(temporary, "state");
  await mkdir(ion);
  await writeFile(join(ion, "bundle.js"), `import { callback } from './not-loaded.js';
export const message='rewindSession unavailable';
callback.rewindV2; event.keyCode===229; const actions={edit:'onEdit'};
export function signin(){const code=user.pendingUserCode;const allowed=enabled&&window.location.protocol==='app:';router.replace('/new');return allowed;}
export function route(){const allowed=typeof window!=='undefined'&&window.location.protocol==='app:';router.replace('/new');return allowed;}
`);
  const result = spawnSync(process.execPath, [preparePath, ion, state, releasePath], {
    encoding: "utf8", env: { ...process.env, CLAUDE_DESKTOP_VERSION: release.desktopVersion,
      CLAUDE_REMOTE_GATEWAY_SETTINGS: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(state, "current.json"), "utf8"));
  assert.equal(manifest.patches.length, 2);
  console.log(`renderer-runtime-smoke: ESM staging passed on ${process.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
