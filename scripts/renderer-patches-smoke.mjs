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
// The session-placement helper: after reading the shrimp gate it evaluates the
// platform check that requires the Desktop user-agent token, and the account's
// placement settings decide remote vs local. In web-shell mode the check is
// forced true so placement follows the account (the bridge declares
// `dramatic_shrimp_enabled` false), keeping new sessions on the local path.
const sessionPlacement = 'function placeSession(){"use no memo";'
  + 'let forceLocal=gate("dramatic_shrimp_force_local"),org=orgAvailable(),available=org,'
  + 'remoteAllowed=rule("yukon_silver_dramatic_shrimp"),isApp=desktopClient(),'
  + 'internal=flag("yukon_silver_dramatic_shrimp_internal",!1),{account}=useAccount(),'
  + 'enabled=account?.settings.dramatic_shrimp_enabled,'
  + 'disabledAt=account?.settings.dramatic_shrimp_disabled_at,'
  + 'remote=resolveRemote(enabled,disabledAt);'
  + 'return isApp?{isRemote:remote}:{isRemote:!0,preferenceOverridden:forceLocal}}';
const sessionPlacementDecoy = 'function notThePlacement(){'
  + 'let forceLocal=gate("dramatic_shrimp_force_local"),'
  + 'settings=(account)=>account.settings.dramatic_shrimp_disabled_at,'
  + 'shrimp=rule("yukon_silver_dramatic_shrimp"),isApp=desktopClient(user);'
  + 'return isApp&&shrimp}';
// The account chip: reads the account view — its src binding — and then returns
// the deployment mark, the one shape that fetches the photo and drops it. The
// chip takes extra placement props and answers through a comma sequence, like
// the shipping bundle. The account Avatar component is read back from the
// sibling that builds an avatar with an explicit src, so a renamed component or
// a different factory is tolerated. The hook's own object literal carries a src
// *property* and must not be mistaken for the binding.
// The account view hook is also the shape the photo fallback reads: it
// destructures the account already in hand from the current-account context
// (the bootstrap account, which in the web shell already carries the avatar
// URL) and the profile read (`{data, isLoading}`), and its src is a call over
// the profile data binding. The fallback splice must leave the property in
// place for the chip's binding scan, so the hook keeps its object literal.
const accountChipHook = 'function accountHook(){let{account:e}=ctx(),'
  + '{data:t,isLoading:n}=prof({additionalPermittedStatusCode:404}),r=org();'
  + 'return{name:e?.full_name||"",src:photo(t,r),isLoading:n}};';
const accountChipBody = 'function accountAvatar(){let{name:e,src:t}=accountHook();'
  + 'return k(Av,{name:e,src:t,size:"sm"})}'
  + 'function chipMark({size:e="sm",organization:t,placement:n,anyOrgHasIcon:r=!0}){'
  + 'let{activeOrganization:i}=ctx(),a=t??i,o=e==="md",{name:s,src:c}=accountHook();'
  + 'return a?.has_icon,U(gateId,!1),k(Mark,{size:o?20:16,className:"shrink-0"})}';
const accountChip = accountChipHook + accountChipBody;
// A lookalike view whose photo has no account to fall back to, and one that
// binds the account but answers no photo call, must not be mistaken for the
// account view hook.
const accountPhotoDecoys = 'function photoOnly(){'
  + 'return{name:"",src:profile()?.avatar_image_url||void 0,isLoading:void 0}}'
  + 'function accountOnly(){let{account:e}=ctx();'
  + 'return{name:e?.full_name||"",src:void 0,isLoading:!0}}';
// The user-menu identity reader: one function whose entire body returns the
// auth-store hook's principal display name. The hook paints its loading state on
// the popover's first frame (the menu content mounts on open) and only fills
// from an async store read, so the header's title showed the deployment label
// and flipped to the account name a frame later. In web-shell mode the patcher
// falls back to the preload's synchronously seeded store snapshot
// (getStateSync) while that read is in flight. The reader is pinned by its whole
// shape, so a different property, a call carrying arguments, a member expression
// or a body with other statements is not a target.
const accountMenuName = 'function menuIdentity(){return accountStoreHook()?.principalDisplayName}';
const accountMenuNameDecoys = '// principalDisplayName\n'
  + 'function otherProperty(){return accountStoreHook()?.emailAddress}'
  + 'function callWithArgs(){return accountStoreHook(user)?.principalDisplayName}'
  + 'function notACall(){return account.principalDisplayName}'
  + 'function multiStatement(){track();return accountStoreHook(who)?.principalDisplayName}';
// The Desktop signing gate spells the same reason with a member-expression test
// and no declaring initialiser, so it must not be a target.
const signingDecoy = 'function shouldSign(e,t){const n=x=>({kind:"skip",reason:x});'
  + 'if(!t.isDesktopApp)return n("not_desktop_app");return null;}';
// The Desktop-checks slot: the app tree mounts the Desktop-only side-effect hosts
// — account sync, the pending-permission store's wiring, the Cowork ask pump —
// through one slot that renders them only when the client identifies as the
// Desktop app, and null otherwise. The web shell drops that identity on purpose,
// so the store is never wired there and a Cowork ask waits forever. In web-shell
// mode the patcher calls the wiring hook from the slot itself, before the gate;
// the hook's call is read back from the Desktop root's own body as the first
// element of the comma sequence carrying the locale-change effect.
const desktopRoot = 'function desktopRoot({children:e}){'
  + 'const{track:ue}=tracker(),{models:P}=models("cowork");'
  + 'wirePendingPermissions(api),warm(t,le,ue),'
  + 'effect(()=>{window.electronIntl?.requestLocaleChange?.(e.locale)},[e]),'
  + 'effect(()=>{let e=st(build);e&&report?.commitHash?.(e)},[]);'
  + 'return frame({children:e});}';
const desktopChecks = 'function desktopChecks(){return isDesktopApp()'
  + '?wrap(Boundary,{componentName:"DesktopChecks",fallback:null,'
  + 'children:[el(desktopRoot,{}),el(otherChecks,{})]}):null}';
const desktopChecksDecoy = 'const label="DesktopChecks";'
  + 'function notTheSlot(){return render(label);}';
// The push-enablement function: guards Notification.requestPermission, tracks the
// permission result under its own analytics key and answers failures with
// browser_or_permissions. In web-shell mode the patcher splices a bridge-first
// branch so the settings rows and the chat card work against this deployment's
// notification relay instead of claude.ai's Firebase project.
const pushEnable = 'async function pushEnable({accountUuid:e,isClaudeElectronApp:t,onTokenReceived:n,track:r,background:i}){'
  + 'if(!("Notification"in window))return{success:!1,errorSource:"browser_or_permissions"};'
  + 'try{let a=await Notification.requestPermission();'
  + 'r&&r({event_key:"claudeai.notification.permission.result",permission:a});'
  + 'if(a==="granted"){if(t||!e)return{success:!1,errorSource:"internal"};return{success:!0}}'
  + 'return{success:!1,errorSource:"browser_or_permissions",permission:a}}'
  + 'catch{return{success:!1,errorSource:"internal"}}}';
// The same analytics key and result literal without the permission call (or
// without the async declaration) must not be mistaken for the target.
const pushEnableDecoy = 'function pushEnableDecoy(){'
  + 'const text="claudeai.notification.permission.result";'
  + 'return{errorSource:"browser_or_permissions",note:text};}'
  + 'const pushEnableArrow=async()=>({errorSource:"browser_or_permissions",'
  + 'note:Notification.requestPermission,key:"claudeai.notification.permission.result"});';
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
    `${native}\n${signin}\n${route}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}\n${accountChip}\n${accountPhotoDecoys}\n${accountMenuName}\n${accountMenuNameDecoys}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${pushEnableDecoy}\n${signingDecoy}\n${decoy}`]]);
  const result = patchRendererSources(inputs, true);
  assert.equal(result.patches.length, 5);
  const output = result.sources.get(`changed-chunk-${i}.js`);
  assert.ok(output.includes('icon:"Download"'), "the file pane must gain the streaming download button");
  assert.ok(output.includes('/api/remote/files/download?path='), "the button must target the streaming endpoint");
  assert.ok(output.includes('target="_blank"'), "a refused download must not replace the app");
  assert.ok(output.includes('/api/remote/files/preview?path='), "the preview pane must target the bridge preview route");
  assert.ok(output.endsWith(decoy), "unrelated checks/comments/strings must remain byte-identical");
  const webResult = patchRendererSources(inputs, true, true);
  assert.equal(webResult.patches.length, 13,
    "the web shell adds the Code route alias, the session Desktop gate, the local session placement, the account-chip avatar, the account photo fallback, the user-menu identity seed, the Cowork permission wiring and the notification-enable bridge");
  assert.equal(webResult.patches.filter(p => p.id === "desktop-code-route-alias").length, 1);
  assert.equal(webResult.patches.filter(p => p.id === "web-notifications-enable-bridge").length, 1,
    "the push-enablement function must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('if(__claudeskNotifications?.requestAuthorization){'),
    "the push enablement must consult the remote DesktopNotifications bridge first");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('return{success:!1,errorSource:"internal"}}'),
    "the original Firebase path must remain after the bridge-first branch");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('function pushEnableDecoy(){const text='),
    "a function without the permission call must not be spliced");
  assert.equal(webResult.patches.filter(p => p.id === "web-account-chip-avatar").length, 1,
    "the account chip's avatar slot must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('(c?k(Av,{name:s,src:c,className:"shrink-0",style:{width:(o?20:16)+"px",height:(o?20:16)+"px"}})'
      + ':k(Mark,{size:o?20:16,className:"shrink-0"}))'),
    "the chip must show the account avatar at the mark's own pixel size, and keep the mark otherwise");
  assert.equal(webResult.patches.filter(p => p.id === "web-account-photo-first-frame").length, 1,
    "the account view's photo fallback must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('src:(photo(t,r)||e?.avatar_image_url)'),
    "the photo must fall back to the bootstrap account while the profile read is in flight");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('src:profile()?.avatar_image_url'),
    "a lookalike view's own literal must not be spliced");
  assert.equal(webResult.patches.filter(p => p.id === "web-account-menu-name").length, 1,
    "the user-menu identity must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('return (accountStoreHook()?.principalDisplayName??globalThis["claude.web"]'
      + '?.LocalAgentModeSessions?.interactiveAuthStore?.getStateSync?.()?.principalDisplayName)'),
    "the identity must fall back to the preload's seeded store snapshot");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('function otherProperty(){return accountStoreHook()?.emailAddress}')
    && webResult.sources.get(`changed-chunk-${i}.js`)
      .includes('function multiStatement(){track();return accountStoreHook(who)?.principalDisplayName}'),
    "only a zero-argument call's principalDisplayName reader is the identity target");
  assert.ok(!result.sources.get(`changed-chunk-${i}.js`).includes("getStateSync"),
    "the identity fallback stays off without the web shell");
  assert.ok(!result.sources.get(`changed-chunk-${i}.js`).includes("||e?.avatar_image_url)"),
    "the account photo fallback stays off without the web shell");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("function za(e,t,n){t=!0;"),
    "the alias resolver must take the desktop branch under the web shell");
  assert.equal(webResult.patches.filter(p => p.id === "desktop-session-viewer-gate").length, 1,
    "the session layout Desktop gate must be spliced once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("let isDesktopApp=!0,pinned="),
    "the session layout must treat the web shell as the Desktop app");
  assert.equal(webResult.patches.filter(p => p.id === "web-local-session-placement").length, 1,
    "the session placement must take the desktop branch exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("isApp=!0,"),
    "the web shell must place new sessions on the desktop-capable branch");
  assert.ok(result.sources.get(`changed-chunk-${i}.js`).includes("isApp=desktopClient(),"),
    "the placement check stays untouched without the web shell");
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
// ...and the session placement: a helper without the exact gate-then-platform
// sequence refuses rather than splice over the closest-looking call, a
// platform call carrying arguments is not the sequence, and the splice
// survives minification like the other structural read-backs.
assert.throws(() => patchRendererSources(new Map([["no-placement.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]), false, true),
  /web-local-session-placement expected once, found 0/,
  "the web shell must refuse a renderer without the placement helper");
assert.throws(() => patchRendererSources(new Map([["dup-placement.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}`
    + `\n${sessionPlacement}\n${sessionPlacement.replaceAll("placeSession", "placeSessionB")}\n${accountChip}\n${desktopRoot}`
    + `\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]), false, true),
  /web-local-session-placement expected once, found 2/);
assert.equal(inspectRenderer(sessionPlacementDecoy, false, true).patches
  .filter(patch => patch.id === "web-local-session-placement").length, 0,
  "a platform call carrying arguments is not the placement target");
const placementCompiled = await minify(sessionPlacement, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(placementCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-local-session-placement").length, 1,
  "a mangled placement helper must still be spliced once");
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`]]), false, true),
  /web-account-chip-avatar expected once, found 0/,
  "the web shell must refuse a renderer without the account-chip avatar");
// Two chips (or a second photo-less account-view component) must refuse rather
// than splice the avatar into the wrong slot.
const accountChipB = accountChip.replaceAll("chipMark", "chipMarkB")
  .replaceAll("accountHook", "accountHookB").replaceAll("accountAvatar", "accountAvatarB");
assert.throws(() => patchRendererSources(new Map([["dup-chip.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${accountChipB}`]]), false, true),
  /web-account-chip-avatar expected once, found 2/);
// The avatar component and the photo binding are structural read-backs, so the
// patch survives minification, not just renaming by hand. The menu-name reader
// rides along because in the shipping bundle it shares the account chunk and
// carries the token the patcher's string prefilter keys on
// (`principalDisplayName`), which the minified account chip alone would not.
const chipCompiled = await minify(`${accountChip}\n${accountMenuName}`, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(chipCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-account-chip-avatar").length, 1,
  "a mangled account chip must still be spliced once");
// ...and the account view's photo fallback: a renderer whose view hook no longer
// matches must be refused rather than ship a chip whose photo waits for the
// profile read while the bootstrap account already carries it.
assert.throws(() => patchRendererSources(new Map([["no-photo-hook.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChipBody}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]),
  false, true),
  /web-account-photo-first-frame expected once, found 0/,
  "the web shell must refuse a renderer without the account view hook");
// Two view hooks must refuse rather than splice the fallback into the wrong one.
assert.throws(() => patchRendererSources(new Map([["dup-photo-hook.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${accountChipHook.replaceAll("accountHook", "accountHookB")}`
    + `\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]), false, true),
  /web-account-photo-first-frame expected once, found 2/,
  "a second account view hook must refuse rather than double-splice");
// A view with no account to fall back to, or no photo read to fall back from,
// is not the hook the chip paints from.
assert.equal(inspectRenderer(accountPhotoDecoys, false, true).patches
  .filter(patch => patch.id === "web-account-photo-first-frame").length, 0,
  "only the account view that reads the profile's own avatar field is a target");
assert.equal(inspectRenderer(chipCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-account-photo-first-frame").length, 1,
  "a mangled account view hook must still be spliced once");
// The full web-shell fixture set, reused for the identity-reader refusals below
// and for the Desktop-checks success case.
const webShellFixtures = `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}`
  + `\n${sessionLayout}\n${sessionPlacement}\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}`;
// ...and the user-menu identity: a renderer whose identity reader no longer
// matches must be refused rather than ship a menu whose title flips to the
// account name a frame after it opens.
assert.throws(() => patchRendererSources(new Map([["no-menu-name.js", webShellFixtures]]), false, true),
  /web-account-menu-name expected once, found 0/,
  "the web shell must refuse a renderer without the user-menu identity reader");
assert.throws(() => patchRendererSources(new Map([["dup-menu-name.js",
  `${webShellFixtures}\n${accountMenuName}\n${accountMenuName.replace("menuIdentity", "menuIdentityB")}`]]),
  false, true),
  /web-account-menu-name expected once, found 2/,
  "a second identity reader must refuse rather than double-splice");
assert.equal(inspectRenderer(accountMenuNameDecoys, false, true).patches
  .filter(patch => patch.id === "web-account-menu-name").length, 0,
  "lookalike readers must not be mistaken for the identity target");
const nameCompiled = await minify(accountMenuName, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(nameCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-account-menu-name").length, 1,
  "a mangled identity reader must still be spliced once");
// The fallback reads the preload's snapshot only while the async hook is empty,
// the live store value wins once it resolves, and an absent preload surface
// leaves the original reader behavior (and the deployment-label fallback) intact.
const nameOut = patchRendererSources(
  new Map([["menu-name.js", `${webShellFixtures}\n${accountMenuName}`]]), false, true)
  .sources.get("menu-name.js");
const seededName = { callbacks: {}, event: {}, accountStoreHook: () => null,
  globalThis: { "claude.web": { LocalAgentModeSessions: { interactiveAuthStore: {
    getStateSync: () => ({ principalDisplayName: "Ada" }) } } } } };
vm.runInNewContext(`${nameOut}\nresult=menuIdentity();`, seededName);
assert.equal(seededName.result, "Ada",
  "the seeded snapshot must answer while the store hook is still loading");
const liveName = { callbacks: {}, event: {},
  accountStoreHook: () => ({ principalDisplayName: "Live" }), globalThis: {} };
vm.runInNewContext(`${nameOut}\nresult=menuIdentity();`, liveName);
assert.equal(liveName.result, "Live", "the live store value must win once the hook resolves");
const bareName = { callbacks: {}, event: {}, accountStoreHook: () => null, globalThis: {} };
vm.runInNewContext(`${nameOut}\nresult=menuIdentity();`, bareName);
assert.equal(bareName.result, undefined,
  "without the preload surface the original reader behavior must remain");
// The photo fallback answers from the account already in hand while the profile
// read is in flight, the resolved profile value wins once it arrives, and an
// account without the field leaves the original photo-less behavior intact.
const photoOut = patchRendererSources(
  new Map([["account-photo.js", `${webShellFixtures}\n${accountMenuName}`]]), false, true)
  .sources.get("account-photo.js");
const heldPhoto = { callbacks: {}, event: {},
  ctx: () => ({ account: { full_name: "Ada", avatar_image_url: "/api/remote/account/avatar?v=1" } }),
  prof: () => ({ data: undefined, isLoading: true }),
  photo: () => undefined, org: () => ({}) };
vm.runInNewContext(`${photoOut}\nresult=accountHook().src;`, heldPhoto);
assert.equal(heldPhoto.result, "/api/remote/account/avatar?v=1",
  "the in-hand account's photo must answer while the profile read is in flight");
const livePhoto = { callbacks: {}, event: {},
  ctx: () => ({ account: { full_name: "Ada", avatar_image_url: "/stale.png" } }),
  prof: () => ({ data: { avatar_image_url: "/profile.png" }, isLoading: false }),
  photo: data => data?.avatar_image_url, org: () => ({}) };
vm.runInNewContext(`${photoOut}\nresult=accountHook().src;`, livePhoto);
assert.equal(livePhoto.result, "/profile.png", "the resolved profile value must win once it arrives");
const barePhoto = { callbacks: {}, event: {},
  ctx: () => ({ account: { full_name: "Ada" } }), prof: () => ({ data: undefined }),
  photo: () => undefined, org: () => ({}) };
vm.runInNewContext(`${photoOut}\nresult=accountHook().src;`, barePhoto);
assert.equal(barePhoto.result, undefined,
  "an account without a photo must keep the original photo-less behavior");
// ...and the notification-enable bridge: a renderer whose push enablement no
// longer matches must be refused rather than ship an enable action that dies in
// a Firebase registration this deployment can never complete.
assert.throws(() => patchRendererSources(new Map([["no-push-enable.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}`]]), false, true),
  /web-notifications-enable-bridge expected once, found 0/,
  "the web shell must refuse a renderer without the push-enablement function");
// Two push-enablement functions must refuse rather than splice the branch into
// the wrong one.
assert.throws(() => patchRendererSources(new Map([["dup-push-enable.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n`
    + `${pushEnable.replaceAll("pushEnable", "pushEnableB")}`]]), false, true),
  /web-notifications-enable-bridge expected once, found 2/);
// A decoy that merely spells the analytics key and the result literal (with the
// permission call elsewhere) is not a target.
assert.equal(inspectRenderer(pushEnableDecoy, false, true).patches
  .filter(patch => patch.id === "web-notifications-enable-bridge").length, 0,
  "only the function that guards requestPermission is the push-enablement target");
// The target is a structural read-back, so it survives minification.
const pushEnableCompiled = await minify(pushEnable, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(pushEnableCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-notifications-enable-bridge").length, 1,
  "a mangled push-enablement function must still be spliced once");
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
// bridge route carrying a `#toolbar=0` fragment (Chrome's viewer reads it and
// hides its own toolbar), reading the element factory and the filePath/cacheBuster
// props back from the component. The preview chunk carries none of the other
// anchors, so its own DeclineReason test id must be enough to trigger inspection.
const previewProbe = `const id="native-file-preview-error";\n${previewComponent};`;
assert.ok(inspectRenderer(previewProbe, false).patches.some(patch => patch.id === "native-file-preview-bridge"),
  "the preview chunk's own token must trigger inspection without the other anchors");
const previewInputs = new Map([["preview-chunk.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}`]]);
const previewOut = patchRendererSources(previewInputs, false).sources.get("preview-chunk.js");
assert.ok(previewOut.includes(
  's("iframe",{src:"/api/remote/files/preview?path="+encodeURIComponent(v)'
    + '+"&v="+encodeURIComponent(String(y??""))+"#toolbar=0"'),
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
// The Cowork permission wiring: the Desktop-checks slot is the only component
// rendering the Desktop-only side-effect hosts, and the wiring hook's call is
// read back from the Desktop root's own body (the first element of the comma
// sequence carrying the locale-change effect), so a renamed hook or API binding
// is tolerated. In web-shell mode the hook is called from the slot itself,
// before the identity gate, so the pending-permission store subscribes in the
// browser too; the Desktop root's own call is left untouched.
const checksInputs = new Map([["checks-chunk.js",
  `${webShellFixtures}\n${accountMenuName}`]]);
const checksOut = patchRendererSources(checksInputs, false, true).sources.get("checks-chunk.js");
assert.ok(checksOut.includes("function desktopChecks(){wirePendingPermissions(api);return isDesktopApp()"),
  "the slot must wire the pending-permission store before its identity gate");
assert.ok(checksOut.includes("wirePendingPermissions(api),warm(t,le,ue),"),
  "the Desktop root's own wiring call must be left alone");
assert.ok(!patchRendererSources(checksInputs, false).sources.get("checks-chunk.js")
  .includes("function desktopChecks(){wirePendingPermissions(api);"),
  "the wiring stays off without the web shell");
assert.throws(() => patchRendererSources(new Map([["no-checks.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}\n${accountChip}`]]), false, true),
  /web-cowork-permission-wiring expected once, found 0/,
  "the web shell must refuse a renderer without the Desktop-checks slot");
assert.throws(() => patchRendererSources(new Map([["dup-checks.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n`
    + desktopChecks.replaceAll("desktopChecks", "desktopChecksB").replaceAll("otherChecks", "otherChecksB")]]),
  false, true), /web-cowork-permission-wiring expected once, found 2/,
  "a second Desktop-checks slot must refuse rather than double-splice");
assert.equal(inspectRenderer(desktopChecksDecoy, false, true).patches
  .filter(patch => patch.id === "web-cowork-permission-wiring").length, 0,
  "a string that merely spells the slot's label is not a target");
const checksCompiled = await minify(`${desktopRoot}\n${desktopChecks}`, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(checksCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-cowork-permission-wiring").length, 1,
  "a mangled Desktop root and slot must still be spliced");
console.log("renderer-patches-smoke: syntax variations, behavior and unrelated-code preservation passed");
