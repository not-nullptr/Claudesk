import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { inspectRenderer, patchRendererSources } from "../rootfs/opt/claude-cowork-bridge/renderer-patches.mjs";
const { minify } = createRequire(new URL("../rootfs/opt/claude-cowork-bridge/package.json", import.meta.url))("terser");

const native = 'const error="rewindSession unavailable"; callbacks.rewindV2; globalThis.ime=event.keyCode===229; const actions={edit:"onEdit"};';
// The file pane's trailing actions fragment, kept inside an uncalled function
// so the gateway variants can execute the module without resolving its helpers.
// The pane's fileView selector and a ghost icon-only Button are the otherwise
// mangled names the injected button reads back from the same parsed graph.
const paneAnchors = 'const Dl=()=>null;const k=$(t=>e==="file"?t.fileView:void 0);'
  + 'g(Dl,{variant:"ghost",iconOnly:!0,icon:"Download"});';
const filePane = `function fileHeader(){${paneAnchors}return e==="file"&&v(p,{children:[g(Kg,{sessionRef:C}),g(Um,{sessionRef:C,anchorRef:oe})]});}`;
// The provider card: a call-argument component carrying both of its i18n message
// ids. Its body is blanked so chat and code stop advertising the provider switch.
// A declaration, a comment or a string that merely names the ids is not a target.
// It is kept inside an uncalled function for the same reason as the file pane.
const bannerCard = 'function bannerModule(){const providerCard=wrap(function({compact:e,fallback:t}){'
  + 'let s=useStore();if(s.hidden)return t??null;'
  + 'return e?h("div",{children:s.provider})'
  + ':h(Banner,{title:m({defaultMessage:"You’re using {provider}",id:"+8XhcAcHfK"}),'
  + 'body:m({defaultMessage:"Add MCP servers, set a model allowlist, or change providers any time in the Inference configuration menu.",id:"1qPkTh9fMa"})});});}';
const bannerDecoy = '// id:"+8XhcAcHfK" 1qPkTh9fMa\n'
  + 'function declareOnly(){return "+8XhcAcHfK"+"1qPkTh9fMa";}';
// The native file preview: a component whose container carries the one className
// the patcher pins, with a children array whose element factory and the filePath
// / cacheBuster props are read back from the same graph (all mangled here).
const previewComponent = 'function NativePreview({sessionId:i,filePath:v,cacheBuster:y}){'
  + 'const ready=useState(null);'
  + 'return s("div",{className:"h-full w-full relative overflow-hidden",children:['
  + 'ready==null?null:s(Spinner,{className:"absolute inset-0 flex items-center justify-center"}),'
  + 'caption&&s("img",{src:caption.src,alt:""})]});}';
// The route-alias resolver: `za` guards each rule with `!(X.when==="desktop"&&!Y)`,
// where Y is its `isDesktop` flag. In web-shell mode the patcher forces that
// branch so the local Code route (/epitaxy) stays reachable.
const aliasResolver = 'function Ra(e,{isDesktop:t,isDev:n=!1}){let r=e;'
  + 'for(let i=0;i<4;i++){let i=za(r,t,n);if(i===null)return r===e?null:r;r=i}return r===e?null:r}'
  + 'function za(e,t,n){for(let r of La)'
  + 'if(!(r.when==="desktop"&&!t)&&!(r.when==="web"&&t)&&!(r.skipInDev&&n)&&Ia(e,r.from))'
  + 'return r.to+e.slice(r.from.length);return null}';
// The chat/cowork session layout: a local session is only opened when the client
// identifies as the Desktop app, so the guard redirects with reason
// "not_desktop_app" when the user-agent check is false and falls back to the
// download upsell otherwise. The check is read back from the `if(!x)` guard and
// its declaring initialiser (the zero-argument call). In web-shell mode the
// patcher forces that initialiser to true.
const sessionLayout = 'function SessionLayout({children:e}){'
  + 'let isDesktopApp=desktopFromUserAgent(),pinned=useStore(x=>x.pinned);'
  + 'return useMemo(()=>{if(!(remote||hub)){if(!isDesktopApp){report("not_desktop_app");return}'
  + 'local||ready||report("cowork_gate_off")}},[]);}';
// The account chip: reads the account view — its photoUrl binding — and then
// returns the deployment mark, the one shape that fetches the photo and drops
// it. The account Avatar component is read back from the sibling that builds an
// avatar with an explicit src, so a renamed component or a different factory is
// tolerated. The hook's own object literal carries a photoUrl *property* and
// must not be mistaken for the binding.
const accountChip = 'function accountHook(){let{account:e}=ctx();'
  + 'return{name:e?.full_name||"",photoUrl:profile()?.avatar_image_url||void 0,illustration:profile()?.avatar||void 0}};'
  + 'function accountAvatar(){let{name:e,photoUrl:t,illustration:n}=accountHook();'
  + 'return k(Av,{name:e,src:t??illu(n),size:"sm"})}'
  + 'function chipMark({size:e="sm",organization:t}){let{activeOrganization:n}=ctx(),r=e==="md",'
  + '{name:i,photoUrl:a,illustration:o}=accountHook();return k(Mark,{size:r?20:16,className:"shrink-0"})}';
// The Desktop signing gate spells the same reason with a member-expression test
// and no declaring initialiser, so it must not be a target.
const signingDecoy = 'function shouldSign(e,t){const n=x=>({kind:"skip",reason:x});'
  + 'if(!t.isDesktopApp)return n("not_desktop_app");return null;}';
const variants = [
  { comparison: 'window.location.protocol==="app:"', windowCheck: 'typeof window<"u"' },
  { comparison: "'app:' == window [ 'location' ] [ 'protocol' ]", windowCheck: "typeof window !== 'undefined'" },
  { comparison: '(window.location.protocol) === ("app:")', windowCheck: '"undefined" != typeof window' },
  { comparison: '"app:"===window?.location?.protocol', windowCheck: 'typeof window !== "undefined"' },
  { comparison: 'window.location.protocol!=="app:"', windowCheck: 'typeof window<"u"', negative: true },
];
for (const [i, variant] of variants.entries()) {
  const flag = i % 2 ? "$available" : "availableRenamed";
  const gate = i % 2 ? "$guard" : "guardRenamed";
  const signin = `function signin(){const code=user.pendingUserCode;const ${gate}=${flag}&&(${variant.comparison});router.replace('/new');return ${gate};}`;
  const route = `const route=()=>{const ${gate}=(${variant.windowCheck})&&(${variant.comparison});router['replace']('/new');return ${gate};};`;
  const decoy = `// window.location.protocol==="app:"\nconst text='window.location.protocol==="app:"';function other(){return window.location.protocol==="app:"}`;
  const inputs = new Map([[`changed-chunk-${i}.js`,
    `${native}\n${signin}\n${route}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${accountChip}\n${signingDecoy}\n${decoy}`]]);
  const result = patchRendererSources(inputs, true);
  assert.equal(result.patches.length, 5);
  const output = result.sources.get(`changed-chunk-${i}.js`);
  assert.ok(output.includes('icon:"Download"'), "the file pane must gain the streaming download button");
  assert.ok(output.includes('/api/remote/files/download?path='), "the button must target the streaming endpoint");
  assert.ok(output.includes('target="_blank"'), "a refused download must not replace the app");
  assert.ok(output.includes('/api/remote/files/preview?path='), "the preview pane must target the bridge preview route");
  assert.ok(output.endsWith(decoy), "unrelated checks/comments/strings must remain byte-identical");
  const webResult = patchRendererSources(inputs, true, true);
  assert.equal(webResult.patches.length, 8,
    "the web shell adds the Code route alias, the session Desktop gate and the account-chip avatar");
  assert.equal(webResult.patches.filter(p => p.id === "desktop-code-route-alias").length, 1);
  assert.equal(webResult.patches.filter(p => p.id === "web-account-chip-avatar").length, 1,
    "the account chip's avatar slot must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('(a?k(Av,{name:i,src:a,size:e,className:"shrink-0"}):k(Mark,{size:r?20:16,className:"shrink-0"})'),
    "the chip must show the account avatar when a photo exists and keep the mark otherwise");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes('photoUrl:profile()?.avatar_image_url'),
    "the hook's photoUrl property must not be mistaken for a binding");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("function za(e,t,n){t=!0;"),
    "the alias resolver must take the desktop branch under the web shell");
  assert.equal(webResult.patches.filter(p => p.id === "desktop-session-viewer-gate").length, 1,
    "the session layout Desktop gate must be spliced once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("let isDesktopApp=!0,pinned="),
    "the session layout must treat the web shell as the Desktop app");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes('if(!t.isDesktopApp)return n("not_desktop_app")'),
    "the signing gate's member-expression test must not be a target");
  for (const protocol of ["app:", "https:"]) for (const gateway of [false, true]) for (const available of [false, true]) {
    const context = { window: { location: { protocol } },
      globalThis: { __CLAUDE_REMOTE_BOOTSTRAP__: { gatewaySettingsEnabled: gateway } },
      [flag]: available, user: { pendingUserCode: "code" }, router: { replace() {} },
      callbacks: {}, event: {}, result: null };
    vm.runInNewContext(`${output}\nresult=[signin(),route()];`, context);
    const isDesktop = protocol === "app:" || gateway;
    const predicate = variant.negative ? !isDesktop : isDesktop;
    assert.deepEqual(Array.from(context.result), [available && predicate, predicate],
      "patch must preserve feature flags and only extend desktop eligibility");
  }
  const disabled = patchRendererSources(inputs, false);
  assert.deepEqual(disabled.patches.map(patch => patch.id),
    ["file-pane-download", "inference-banner", "native-file-preview-bridge"],
    "without the Gateway flag only the always-on download button, card removal and preview are spliced");
  const disabledOutput = disabled.sources.get(`changed-chunk-${i}.js`);
  assert.ok(disabledOutput.includes('icon:"Download"'), "the download button stays on with the flag off");
  assert.ok(!disabledOutput.includes("gatewaySettingsEnabled"), "the Gateway guards stay off with the flag off");
  assert.ok(disabledOutput.endsWith(decoy), "the download button must not disturb the tail");
  const compiled = await minify(inputs.get(`changed-chunk-${i}.js`), {
    mangle: true, compress: { unused: false }, format: { quote_style: 1 },
  });
  assert.equal(patchRendererSources(new Map([["new-hash.js", compiled.code]]), true).patches.length, 5,
    "compiler-generated variants must retain every patch");
  assert.throws(() => patchRendererSources(new Map([...inputs, ["duplicated.js", signin]]), true), /expected once, found 2/);
}
// The session Desktop gate is a structural read-back, so it must survive
// minification: the flag is renamed, but the `if(!x)` guard and the zero-argument
// initialiser it points at are unchanged.
const compiledSession = await minify(`${sessionLayout}\n${signingDecoy}`, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(compiledSession.code, false, true).patches
  .filter(patch => patch.id === "desktop-session-viewer-gate").length, 1,
  "a mangled session layout must still be spliced");
// The download target must be unique: a second file pane fragment, or a
// duplicated file pane, is refused rather than double-spliced.
assert.throws(() => patchRendererSources(new Map([["a.js", filePane], ["b.js", filePane]]), false),
  /file-pane-download expected once, found 2/);
// The web shell requires the alias splice: a renderer with no resolver refuses.
assert.throws(() => patchRendererSources(new Map([["no-alias.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}`]]), false, true),
  /desktop-code-route-alias expected once, found 0/,
  "the web shell must refuse a renderer without the route-alias resolver");
// ...and the session Desktop gate: a renderer whose session layout no longer
// matches must be refused rather than ship a shell where every session bounces.
assert.throws(() => patchRendererSources(new Map([["no-session-gate.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}`]]), false, true),
  /desktop-session-viewer-gate expected once, found 0/,
  "the web shell must refuse a renderer without the session Desktop gate");
// ...and the account chip's avatar: a renderer whose chip still renders the
// photo-less mark must be refused rather than ship a shell where a configured
// pfp never renders (the chip never sets a source, so no image is requested).
assert.throws(() => patchRendererSources(new Map([["no-chip.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}`]]), false, true),
  /web-account-chip-avatar expected once, found 0/,
  "the web shell must refuse a renderer without the account-chip avatar");
// Two chips (or a second photo-less account-view component) must refuse rather
// than splice the avatar into the wrong slot.
const accountChipB = accountChip.replaceAll("chipMark", "chipMarkB")
  .replaceAll("accountHook", "accountHookB").replaceAll("accountAvatar", "accountAvatarB");
assert.throws(() => patchRendererSources(new Map([["dup-chip.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}`
    + `\n${accountChip}\n${accountChipB}`]]), false, true),
  /web-account-chip-avatar expected once, found 2/);
// The avatar component and the photo binding are structural read-backs, so the
// patch survives minification, not just renaming by hand.
const chipCompiled = await minify(accountChip, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(chipCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-account-chip-avatar").length, 1,
  "a mangled account chip must still be spliced once");
// A guard that merely mentions the reason (with a member-expression test) is not
// a target, so the signing gate must not be mistaken for the session layout.
assert.equal(inspectRenderer(signingDecoy, false, true).patches
  .filter(patch => patch.id === "desktop-session-viewer-gate").length, 0,
  "a member-expression test naming the reason is not the session layout");
assert.equal(patchRendererSources(new Map([["only.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}`]]), false).patches
  .map(patch => patch.id).join(","), "file-pane-download,inference-banner,native-file-preview-bridge");
// Native checks also survive reverse comparisons, computed keys and formatting.
const changedNative = "const error='rewindSession unavailable'; callbacks['rewindV2']; 229 == event['keyCode']; const actions={'edit': 'onEdit'};";
assert.equal(patchRendererSources(new Map([["changed-native.js",
  `${changedNative}\n${filePane}\n${bannerCard}\n${previewComponent}`]]), false).markers.length, 4);
assert.throws(() => patchRendererSources(new Map([["comments.js",
  `/* ${native} */\n${filePane}\n${bannerCard}\n${previewComponent}`]]), false), /capability .* missing/);
// The card removal is required: its body is blanked wherever it is found, any
// declaration or string naming the ids is ignored, and a bundle that no longer
// matches is refused rather than letting the card return silently.
const bannerGuard = 'function signin(){const code=user.pendingUserCode;'
  + 'const ok=flag&&(window.location.protocol==="app:");router.replace("/new");return ok;}'
  + 'const route=()=>{const ok=(typeof window!=="undefined")'
  + '&&(window.location.protocol==="app:");router.replace("/new");return ok;};';
const bannerInputs = new Map([["banner-chunk.js",
  `${native}\n${bannerGuard}\n${filePane}\n${bannerCard}\n${previewComponent}\n${bannerDecoy}`]]);
const bannerOut = patchRendererSources(bannerInputs, true).sources.get("banner-chunk.js");
assert.ok(!bannerOut.includes("model allowlist"), "the provider card copy must be removed");
assert.ok(bannerOut.includes("const providerCard=wrap(function({compact:e,fallback:t}){return null;})"),
  "only the card component's body is replaced");
assert.ok(bannerOut.endsWith(bannerDecoy), "a declaration or string naming the ids is not a target");
assert.deepEqual(patchRendererSources(bannerInputs, false).patches.map(patch => patch.id).sort(),
  ["file-pane-download", "inference-banner", "native-file-preview-bridge"],
  "the card is removed independent of the Gateway setting");
assert.throws(() => patchRendererSources(new Map([["no-card.js", `${native}\n${filePane}`]]), false),
  /inference-banner expected once, found 0/,
  "a bundle without the card must be refused, not silently accepted");
const bannerCompiled = await minify(bannerInputs.get("banner-chunk.js"), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.ok(patchRendererSources(new Map([["new-banner.js", bannerCompiled.code]]), true).patches
  .some(patch => patch.id === "inference-banner"), "recompiled card must retain the patch");
// The preview patch rewrites the native preview's children to an <iframe> at the
// bridge route, reading the element factory and the filePath/cacheBuster props
// back from the component. The preview chunk carries none of the other anchors,
// so its own DeclineReason test id must be enough to trigger inspection.
const previewProbe = `const id="native-file-preview-error";\n${previewComponent};`;
assert.ok(inspectRenderer(previewProbe, false).patches.some(patch => patch.id === "native-file-preview-bridge"),
  "the preview chunk's own token must trigger inspection without the other anchors");
const previewInputs = new Map([["preview-chunk.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}`]]);
const previewOut = patchRendererSources(previewInputs, false).sources.get("preview-chunk.js");
assert.ok(previewOut.includes(
  's("iframe",{src:"/api/remote/files/preview?path="+encodeURIComponent(v)+"&v="+encodeURIComponent(String(y??""))'),
  "the preview gains an iframe built from the read-back factory and props");
assert.ok(previewOut.includes("/(?:pdf|docx?|pptx?|xlsx?)$/i.test(v)"),
  "only Office and PDF switch to the iframe; everything else keeps the native render");
// Two preview containers, or a container whose props are not the ones read back,
// must refuse rather than splice a preview that would never fire.
assert.throws(() => patchRendererSources(new Map([["dup-preview.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n`
    + `${previewComponent.replace("function NativePreview", "function NativePreviewB")}`]]), false),
  /native-file-preview-bridge expected once, found 2/);
assert.throws(() => patchRendererSources(new Map([["no-preview.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent.replace("filePath:v", "sourcePath:v")}`]]), false),
  /native-file-preview-bridge expected once, found 0/);
const previewCompiled = await minify(previewInputs.get("preview-chunk.js"), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.ok(patchRendererSources(new Map([["new-preview.js", previewCompiled.code]]), false).patches
  .some(patch => patch.id === "native-file-preview-bridge"),
  "recompiled preview must retain the patch");
console.log("renderer-patches-smoke: syntax variations, behavior and unrelated-code preservation passed");
