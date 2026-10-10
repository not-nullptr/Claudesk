import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import vm from "node:vm";
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
export function fileHeader(){const Dl=()=>null;const k=$(t=>e==="file"?t.fileView:void 0);g(Dl,{variant:"ghost",iconOnly:!0,icon:"Download"});return e==="file"&&v(p,{children:[g(Kg,{sessionRef:C}),g(Um,{sessionRef:C,anchorRef:oe})]});}
function bannerModule(){const providerCard=wrap(function({compact:e,fallback:t}){let s=useStore();if(s.hidden)return t??null;return e?h("div",{children:s.provider}):h(Banner,{title:m({defaultMessage:"You’re using {provider}",id:"+8XhcAcHfK"}),body:m({defaultMessage:"Add MCP servers, set a model allowlist, or change providers any time in the Inference configuration menu.",id:"1qPkTh9fMa"})});});}
export function NativePreview({sessionId:i,filePath:v,cacheBuster:y}){const ready=useState(null);return s("div",{className:"h-full w-full relative overflow-hidden",children:[ready==null?null:s(Spinner,{className:"absolute inset-0 flex items-center justify-center"}),caption&&s("img",{src:caption.src,alt:""})]});}
`);
  const result = spawnSync(process.execPath, [preparePath, ion, state, releasePath], {
    encoding: "utf8", env: { ...process.env, CLAUDE_DESKTOP_VERSION: release.desktopVersion,
      CLAUDE_REMOTE_GATEWAY_SETTINGS: "1", CLAUDE_REMOTE_WEB_SHELL: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(state, "current.json"), "utf8"));
  assert.equal(manifest.patches.length, 5);
  const generation = join(state, release.desktopVersion, release.patchRelease);
  const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
  const handler = wrapper.slice(wrapper.indexOf("async function serveIon("),
    wrapper.indexOf("async function serveDesktopIcon("));
  const overlayRoot = "/state";
  const patchedPath = posix.join(overlayRoot, release.desktopVersion, release.patchRelease, "bundle.js");
  const files = new Map([[patchedPath, Buffer.from("patched")],
    ["/ion/bundle.js", Buffer.from("original")], ["/ion/unchanged.js", Buffer.from("unchanged")]]);
  const serve = vm.runInNewContext(`${handler}\nserveIon`, {
    rendererManifest: manifest, RENDERER_STATE_ROOT: overlayRoot, ION_ROOT: "/ion",
    normalize: posix.normalize, resolve: posix.resolve, extname: posix.extname,
    ionMimeTypes: { ".js": "application/javascript" },
    stat: async path => { if (!files.has(path)) throw new Error("unreadable overlay");
      return { isFile: () => true }; },
    readFile: async path => files.get(path),
  });
  let body;
  const response = { writeHead() {}, end(value) { body = value.toString(); } };
  await serve(response, `${manifest.basePath}/bundle.js`);
  assert.equal(body, "patched", "HTTP must select the manifest's patched file");
  await serve(response, `${manifest.basePath}/unchanged.js`);
  assert.equal(body, "unchanged", "unchanged assets still come from ion-dist");
  files.delete(patchedPath);
  await assert.rejects(serve(response, `${manifest.basePath}/bundle.js`), /unreadable overlay/,
    "unreadable patches must never silently fall back to the original bundle");
  if (process.platform !== "win32") {
    assert.equal((await stat(generation)).mode & 0o777, 0o755,
      "root-prepared overlays must be traversable by the Electron app user");
    if (process.getuid?.() === 0) {
      await chmod(temporary, 0o755);
      const served = spawnSync(process.execPath, ["-e",
        "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
        join(generation, "bundle.js")], { uid: 65534, gid: 65534, encoding: "utf8" });
      assert.equal(served.status, 0, served.stderr);
      assert.ok(served.stdout.includes("gatewaySettingsEnabled"),
        "an unprivileged asset server must read the patched bytes");
    }
  }
  console.log(`renderer-runtime-smoke: ESM staging passed on ${process.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
