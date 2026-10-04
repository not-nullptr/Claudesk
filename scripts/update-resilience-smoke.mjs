import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "claudesk-update-"));
const ion = join(temporary, "ion");
const state = join(temporary, "state");
const releasePath = join(root, "config/release.json");
const release = JSON.parse(await readFile(releasePath, "utf8"));
const native = 'const message="rewindSession unavailable"; callbacks.rewindV2; event.keyCode===229; const actions={edit:"onEdit"};';
const guards = 'function signin(){const code=user.pendingUserCode;let changedFlag=enabled&&window.location.protocol==="app:";router.replace("/new");return changedFlag;}\n'
  + 'function route(){let changedRoute=typeof window<"u"&&window.location.protocol==="app:";router.replace("/new");return changedRoute;}';
const filePane = 'function fileHeader(){const Dl=()=>null;const k=$(t=>e==="file"?t.fileView:void 0);'
  + 'g(Dl,{variant:"ghost",iconOnly:!0,icon:"Download"});'
  + 'return e==="file"&&v(p,{children:[g(Kg,{sessionRef:C}),g(Um,{sessionRef:C,anchorRef:oe})]});}';
function prepare(version = release.desktopVersion) {
  return spawnSync(process.execPath, [join(root,
    "rootfs/opt/claude-cowork-bridge/prepare-renderer.mjs"), ion, state, releasePath], {
    encoding: "utf8", env: { ...process.env, CLAUDE_DESKTOP_VERSION: version,
      CLAUDE_REMOTE_GATEWAY_SETTINGS: "1" },
  });
}
try {
  await mkdir(ion);
  const source = join(ion, "renamed-bundle.js");
  await writeFile(source, `${native}\n${guards}\n${filePane}`);
  const first = prepare();
  assert.equal(first.status, 0, first.stderr);
  const pointer = await readFile(join(state, "current.json"), "utf8");
  const generatedPath = join(state, release.desktopVersion, release.patchRelease,
    "renamed-bundle.js");
  const generated = await readFile(generatedPath, "utf8");
  assert.ok(generated.includes("changedFlag=enabled&&("), "minifier renaming must survive");
  for (const badSource of [`${native}\n${filePane}`, `${native}\n${guards}\n${guards}\n${filePane}`,
    `${guards}\n${filePane}`, `${native}\nlet changedFlag=enabled&&window.location.protocol==="file:";\n${filePane}`]) {
    await writeFile(source, badSource);
    assert.notEqual(prepare().status, 0, "missing/ambiguous/changed anchors must reject");
    assert.equal(await readFile(join(state, "current.json"), "utf8"), pointer);
    assert.equal(await readFile(generatedPath, "utf8"), generated);
  }
  assert.notEqual(prepare("999.0.0").status, 0, "unknown release must reject");
  assert.equal(await readFile(join(state, "current.json"), "utf8"), pointer);
  console.log("update-resilience-smoke: renamed anchors survive; drift preserves working renderer");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
