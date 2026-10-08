import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { patchRendererSources } from "../rootfs/opt/claude-cowork-bridge/renderer-patches.mjs";
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
    `${native}\n${signin}\n${route}\n${filePane}\n${bannerCard}\n${decoy}`]]);
  const result = patchRendererSources(inputs, true);
  assert.equal(result.patches.length, 4);
  const output = result.sources.get(`changed-chunk-${i}.js`);
  assert.ok(output.includes('icon:"Download"'), "the file pane must gain the streaming download button");
  assert.ok(output.includes('/api/remote/files/download?path='), "the button must target the streaming endpoint");
  assert.ok(output.includes('target="_blank"'), "a refused download must not replace the app");
  assert.ok(output.endsWith(decoy), "unrelated checks/comments/strings must remain byte-identical");
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
  assert.deepEqual(disabled.patches.map(patch => patch.id), ["file-pane-download", "inference-banner"],
    "without the Gateway flag only the always-on download button and card removal are spliced");
  const disabledOutput = disabled.sources.get(`changed-chunk-${i}.js`);
  assert.ok(disabledOutput.includes('icon:"Download"'), "the download button stays on with the flag off");
  assert.ok(!disabledOutput.includes("gatewaySettingsEnabled"), "the Gateway guards stay off with the flag off");
  assert.ok(disabledOutput.endsWith(decoy), "the download button must not disturb the tail");
  const compiled = await minify(inputs.get(`changed-chunk-${i}.js`), {
    mangle: true, compress: { unused: false }, format: { quote_style: 1 },
  });
  assert.equal(patchRendererSources(new Map([["new-hash.js", compiled.code]]), true).patches.length, 4,
    "compiler-generated variants must retain every patch");
  assert.throws(() => patchRendererSources(new Map([...inputs, ["duplicated.js", signin]]), true), /expected once, found 2/);
}
// The download target must be unique: a second file pane fragment, or a
// duplicated file pane, is refused rather than double-spliced.
assert.throws(() => patchRendererSources(new Map([["a.js", filePane], ["b.js", filePane]]), false),
  /file-pane-download expected once, found 2/);
assert.equal(patchRendererSources(new Map([["only.js", `${native}\n${filePane}\n${bannerCard}`]]), false).patches
  .map(patch => patch.id).join(","), "file-pane-download,inference-banner");
// Native checks also survive reverse comparisons, computed keys and formatting.
const changedNative = "const error='rewindSession unavailable'; callbacks['rewindV2']; 229 == event['keyCode']; const actions={'edit': 'onEdit'};";
assert.equal(patchRendererSources(new Map([["changed-native.js", `${changedNative}\n${filePane}\n${bannerCard}`]]), false).markers.length, 4);
assert.throws(() => patchRendererSources(new Map([["comments.js", `/* ${native} */\n${filePane}\n${bannerCard}`]]), false), /capability .* missing/);
// The card removal is required: its body is blanked wherever it is found, any
// declaration or string naming the ids is ignored, and a bundle that no longer
// matches is refused rather than letting the card return silently.
const bannerGuard = 'function signin(){const code=user.pendingUserCode;'
  + 'const ok=flag&&(window.location.protocol==="app:");router.replace("/new");return ok;}'
  + 'const route=()=>{const ok=(typeof window!=="undefined")'
  + '&&(window.location.protocol==="app:");router.replace("/new");return ok;};';
const bannerInputs = new Map([["banner-chunk.js",
  `${native}\n${bannerGuard}\n${filePane}\n${bannerCard}\n${bannerDecoy}`]]);
const bannerOut = patchRendererSources(bannerInputs, true).sources.get("banner-chunk.js");
assert.ok(!bannerOut.includes("model allowlist"), "the provider card copy must be removed");
assert.ok(bannerOut.includes("const providerCard=wrap(function({compact:e,fallback:t}){return null;})"),
  "only the card component's body is replaced");
assert.ok(bannerOut.endsWith(bannerDecoy), "a declaration or string naming the ids is not a target");
assert.deepEqual(patchRendererSources(bannerInputs, false).patches.map(patch => patch.id).sort(),
  ["file-pane-download", "inference-banner"],
  "the card is removed independent of the Gateway setting");
assert.throws(() => patchRendererSources(new Map([["no-card.js", `${native}\n${filePane}`]]), false),
  /inference-banner expected once, found 0/,
  "a bundle without the card must be refused, not silently accepted");
const bannerCompiled = await minify(bannerInputs.get("banner-chunk.js"), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.ok(patchRendererSources(new Map([["new-banner.js", bannerCompiled.code]]), true).patches
  .some(patch => patch.id === "inference-banner"), "recompiled card must retain the patch");
console.log("renderer-patches-smoke: syntax variations, behavior and unrelated-code preservation passed");
