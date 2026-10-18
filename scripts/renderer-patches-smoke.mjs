import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { inspectRenderer, patchEmbeddedSources, patchRendererSources } from "../rootfs/opt/claude-cowork-bridge/renderer-patches.mjs";
const { minify } = createRequire(new URL("../rootfs/opt/claude-cowork-bridge/package.json", import.meta.url))("terser");

const native = 'const error="rewindSession unavailable"; callbacks.rewindV2; globalThis.ime=event.keyCode===229; '
  + 'const assetUrl=function(e){return"/"+e}; const actions={edit:"onEdit"};';
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
// The Code session view's subscription: its options object carries the live
// transport as the `subscribeSse` property, read from the ccr feature. With it
// off the hook holds the live leg over a WebSocket the bridge does not speak,
// so the patcher forces the property on and the leg stays on SSE. The
// same-named local binding and a shorthand property are decoys — only the
// property's plain expression value is spliced.
const codeSubscription = 'function useSessionLive(e){'
  + 'let subscribeSse=readFeature("ccr_v2_subscribe_sse_web"),tailFirst=readFeature("ccr_tail_first");'
  + 'return useMemo(()=>e?openSession({orgUuid:e,fetch:api,subscribeSse:subscribeSse,'
  + 'tailFirstTranscript:tailFirst}):null,[e]);}';
const codeSubscriptionDecoy = 'function notTheSubscription(){let subscribeSse=!0;'
  + 'return{subscribeSse}}';
// The hook's own signature carries the same key as a destructuring binding with
// a default — the shape the shipping bundle has beside the call site. A splice
// there would not even parse, so it must be left alone.
const codeSubscriptionDefaults = 'function openSessionLive({orgUuid:e,fetch:t,intl:n,'
  + 'subscribeSse:o=!1,tailFirstTranscript:r}){return open(e,t,n,o,r)}';
// The session list's Code gate: `activeMode === "code" || codeFoldedIntoHome ||
// requested`, where `requested` is the product switcher's sticky intent. The
// web shell forces that operand false, so Code sessions stop merging into the
// Chat list while the Code surface itself is still admitted by activeMode. A
// lookalike without the folded branch is not the gate.
const chatListGate = 'function buildsCodeFeed({activeMode:e,codeFoldedIntoHome:t,requested:n})'
  + '{return e==="code"||t||n}';
const chatListGateDecoy = 'function otherFeed({activeMode:e,requested:n})'
  + '{return e==="code"||n}';
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
// The user menu's flags object: the one literal carrying `signOut` beside
// `inferenceConfig` and `internalTools`. The patcher forces only `signOut` true
// so the app draws its own Sign out row whether or not a writable login reports
// one. A literal missing a sibling name, or carrying only `signOut`, is not a
// target, and no flag but `signOut` may be spliced.
const accountSignOut = 'function menuFlags(){return {hasAccount:!!a,'
  + 'inferenceConfig:e&&!!r&&Zt(r),internalTools:t,signOut:s}}';
const accountSignOutDecoys = 'function twoNames(){return {signOut:s,internalTools:t}}'
  + 'function oneName(){return {signOut:s}}';
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
// The Cowork scheduled-task hosts. The starter host is the declarator whose body
// writes `startSession` through `setState` — the store the runner waits on — and
// the listener host is the component whose whole body calls the hook that
// subscribes to the main process's dispatches and declares the listener ready.
// In web-shell mode both are mounted from the Desktop-checks slot's
// absent-identity branch, reusing the slot's own wrapper element, element factory
// and props, so a desktop-identified client keeps its own mount.
const scheduledTaskHosts = 'function hostsModule(){'
  + 'const starterHost=memo(function(){'
  + 'let start=useStarter();'
  + 'return effect(()=>(sessionStore.setState({startSession:start}),'
  + '()=>{sessionStore.getState().startSession===start'
  + '&&sessionStore.setState({startSession:null})}),[start]),'
  + 'bind(start,{source:"desktop_open_with"}),useOpenHandlers(),null});'
  + 'function scheduledTaskHook(){let api=desktopBridge();'
  + 'return effect(()=>{let gone=!1,off=api?.onOnScheduledTaskEvent?.(()=>{});'
  + 'return waitForStarter().then(()=>{gone||(api?.setEventAckSupported?.(),'
  + 'api?.markListenerReady?.())}),()=>{gone=!0,off?.()}},[])}'
  + 'function listenerHost(){return scheduledTaskHook(),null}'
  + 'function listenerGate(){return isDesktopApp()?el(listenerHost,{}):null}}';
// A lookalike for each host: a setter for a different store key, and a pair of
// functions that use the same two properties but are not one hook plus the
// component that renders it. Kept inside an uncalled function, like the hosts
// themselves, so the gateway variants can execute the module.
const scheduledTaskHostsDecoy = 'function hostsDecoyModule(){'
  + 'const otherHost=memo(function(){'
  + 'return effect(()=>(settingsStore.setState({activeSession:1}),void 0),[]),null});'
  + 'function subscribeOnly(){return dispatch?.onOnScheduledTaskEvent?.(()=>{})}'
  + 'function readyOnly(){return api?.markListenerReady?.()}}';
// The app's own toast, in the chunk that defines it (shared-19 in the shipping
// bundle): the manager hook and the viewport component the provider itself
// mounts. The `toast-global` splice goes into the viewport — after its own
// opening declaration, because the bindings are `let` and the top of the body
// would hit the temporal dead zone — and names the hook read back from the same
// graph. The viewport is the anchor because it is the component whose output can
// be observed from outside: an earlier cut published from the card host rendered
// beside it, which a live web shell mounted without the global ever appearing.
const toastHost = 'function toastHostModule(){'
  + 'function useToastManager(){let e=useToastStore(),t=useToastContext();'
  + 'return{add:useCallback(o=>e.add(o),[]),close:e.close,setPinned:t?.setPinned}}'
  + 'function ToastViewport({className:e}){let{toasts:t}=useToastStore(),n=useToastContext();'
  + 'useEffect(()=>{n?.syncLiveToasts(t)},[t,n]);'
  + 'return jsx(Frame,{children:jsx(Surface,{surface:"popover",render:jsx("div",{'
  + '"data-cds":"Toast",className:cx("cds-reset fixed right-4 bottom-4",e)})})})}}';
// Lookalikes: a component carrying a marker that is not the toast one, and a
// hook-shaped function whose returned object has neither `add` nor `close`.
// Neither may be spliced — the patch refuses rather than publish the manager
// from whatever happens to look closest.
const toastHostDecoy = 'function toastDecoyModule(){'
  + 'function markerOnly(){return jsx("div",{"data-cds":"Toast-Extra",className:"x"})}'
  + 'function useSomethingElse(){let e=useToastStore(),t=useToastContext();'
  + 'return{mode:e.mode,setMode:t?.setMode}}}';
// The Cowork scheduled-task runner: the Desktop-identity check is read back from
// the `flag || refuse(id, log, copy)` short-circuit whose copy only this runner
// carries, then forced true so a routine can be run from the web shell. The
// runner's own starter-timeout refusal passes a conditional, not the copy.
const scheduledTaskRunner = 'function runScheduledTaskModule(){'
  + 'function runScheduledTask(){'
  + 'let desktop=desktopFromUserAgent(),{storedModel:m}=coworkState(),stale=staleModel();'
  + 'return memo(async task=>{desktop||refuse(task.scheduledTaskId,'
  + '"Local scheduled task run requested outside the desktop app — aborting run",'
  + '"Local scheduled tasks can only run in the Claude desktop app");'
  + 'let starter=await waitForStarter({timeoutMs:1e4}).catch(e=>refuse(task.scheduledTaskId,'
  + '"Cowork session starter unavailable for scheduled task run — aborting run",'
  + 'e instanceof Error?e.message:String(e)));'
  + 'return buildRun(task,starter)});}}';
const scheduledTaskRunnerDecoy = 'function otherRunnerModule(){'
  + 'function otherRunner(){'
  + 'let desktop=desktopFromUserAgent();'
  + 'return memo(task=>{desktop||refuse(task.id,"x","Local scheduled task started elsewhere");'
  + 'return buildRun(task)});}}';
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
// The Gateway URL schema: refine() over the URL field, with the message
// conditional that carries Desktop's loopback-http copy. The patcher splices the
// http branch's host *membership* test, so a deployment can point Desktop at an
// http gateway on a host that is not the container's loopback — the address a
// provisioned Cowork VM actually has to dial. The https branch is untouched, and
// a schema whose message lacks that copy, or one that does not allow http at
// all, is not a target.
const gatewayUrlSchema = 'function urlSchema(options={}){return wrap('
  + 'preprocess(value=>{let text=value.trim();'
  + 'return text&&!options.allowHttp&&!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(text)?`https://${text}`:text},'
  + 'string().trim().url().refine(raw=>{try{let{protocol:scheme,hostname:host}=new URL(raw);'
  + 'return scheme==="https:"?!options.rejectLoopback||!isReserved(host)'
  + ':scheme==="http:"&&(!!options.allowHttp||!!options.allowLoopbackHttp&&loopbackHosts.has(host))}'
  + 'catch{return!1}},'
  + '{message:options.allowHttp?"must be an http:// or https:// URL"'
  + ':options.rejectLoopback?"must use https with a non-loopback host"'
  + ':options.allowLoopbackHttp?"must use https (or http on loopback)":"must use https"})))}';
// A schema that tests the same hostname but carries none of the copy: its
// message is the plain https one, so it must not be spliced.
const gatewayUrlDecoy = 'function strictSchema(o={}){return refine(raw=>{'
  + 'let{protocol:p,hostname:h}=new URL(raw);return p==="https:"&&!hosts.has(h)},'
  + '{message:"must use https"})}';
// The titlebar's compact mode switcher: the element whose props carry the
// `data-compact-mode-switcher` label, wrapping the switcher call whose props
// name the segments array. When that array carries a disabled segment — how a
// deployment with Code turned off renders — the patcher hides the whole control,
// since it offers nothing to switch to. The element factory and the segments
// name are mangled here, like the shipping bundle.
const modePicker = 'function CompactModeSwitcher({ref:e}){let t=useLocale(),n="Claude",'
  + 'd=useCodeState(),f=d?.reason??null,'
  + 'F=useMemo(()=>[{value:"cowork",icon:"Chats",tooltip:n},'
  + 'f===null?{value:"code",icon:"Code",tooltip:t("Code")}'
  + ':{value:"code",icon:"Code",tooltip:"Code",disabled:!0,disabledReason:"Code"}],[f,n,t]);'
  + 'return S(Frame,{children:[h(Switch,{ref:e,modes:F.map(s=>s.value),'
  + '"data-compact-mode-switcher":!0,"data-chorus-callout":"pills",className:"flex",'
  + 'children:h(Segmented,{segments:F,value:"cowork","aria-label":t("Mode")})}),'
  + 'h(DiscoveryPopover,{})]})}';
// A marker on an element whose children are not the switcher call, and a
// switcher call with no segments binding: neither is the mode picker.
const modePickerDecoys = 'function markerWithoutSwitcher(){'
  + 'return h(Frame,{"data-compact-mode-switcher":!0,children:h(Other,{})})}'
  + 'function switcherWithoutSegments(){return h(Frame,{"data-compact-mode-switcher":!0,'
  + 'children:h(Segmented,{value:"cowork"})})}';
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
    `${native}\n${signin}\n${route}\n${filePane}\n${bannerCard}\n${previewComponent}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}\n${codeSubscription}\n${codeSubscriptionDecoy}\n${codeSubscriptionDefaults}\n${chatListGate}\n${accountChip}\n${accountPhotoDecoys}\n${accountMenuName}\n${accountMenuNameDecoys}\n${accountSignOut}\n${accountSignOutDecoys}\n${desktopRoot}\n${desktopChecks}\n${desktopChecksDecoy}\n${scheduledTaskHosts}\n${scheduledTaskHostsDecoy}\n${toastHost}\n${toastHostDecoy}\n${scheduledTaskRunner}\n${scheduledTaskRunnerDecoy}\n${pushEnable}\n${pushEnableDecoy}\n${gatewayUrlSchema}\n${gatewayUrlDecoy}\n${signingDecoy}\n${decoy}`]]);
  const result = patchRendererSources(inputs, true);
  assert.equal(result.patches.length, 7);
  const output = result.sources.get(`changed-chunk-${i}.js`);
  assert.equal(result.patches.filter(p => p.id === "account-sign-out-row").length, 1,
    "the user menu's signOut flag must be spliced exactly once");
  assert.ok(output.includes("internalTools:t,signOut:!0}"),
    "the app's own Sign out row must be forced on, and its sibling flags left alone");
  assert.ok(output.includes("{signOut:s,internalTools:t}") && output.includes("{signOut:s}"),
    "a literal without the sibling flags must not be spliced");
  assert.ok(output.includes('icon:"Download"'), "the file pane must gain the streaming download button");
  assert.ok(output.includes('/api/remote/files/download?path='), "the button must target the streaming endpoint");
  assert.ok(output.includes('target="_blank"'), "a refused download must not replace the app");
  assert.ok(output.includes('/api/remote/files/preview?path='), "the preview pane must target the bridge preview route");
  assert.ok(output.endsWith(decoy), "unrelated checks/comments/strings must remain byte-identical");
  assert.ok(output.includes('!!options.allowLoopbackHttp&&!0)'),
    "the gateway URL's http branch must accept a host that is not the container's loopback");
  assert.ok(output.includes('!hosts.has(h)},'),
    "a schema without the loopback-http copy must not be spliced");
  const webResult = patchRendererSources(inputs, true, true);
  assert.equal(webResult.patches.length, 21,
    "the web shell adds the Code route alias, the session Desktop gate, the local session placement, the Code subscription's SSE transport, the session list's Code exclusion, the account-chip avatar, the account photo fallback, the user-menu identity seed, the Cowork permission wiring, the notification-enable bridge, the scheduled-task runner gate, the scheduled-task hosts, the toast-manager global and the chunk loader's asset base");
  assert.equal(webResult.patches.filter(p => p.id === "web-shell-asset-base").length, 1,
    "the chunk loader must resolve through the deployment's asset base");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('(globalThis.__CLAUDESK_ASSET_BASE__||"")+"/"+e'),
    "every lazy chunk must stay in the entry document's release namespace");
  assert.equal(webResult.patches.filter(p => p.id === "web-code-subscribe-sse").length, 1,
    "the Code session's live transport must be held to SSE exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("subscribeSse:!0"),
    "the subscription's transport property is forced on, whatever the feature answers");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('let subscribeSse=readFeature("ccr_v2_subscribe_sse_web")'),
    "the same-named local binding must not be mistaken for the property");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("return{subscribeSse}"),
    "a shorthand property carries no transport read and must stay byte-identical");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("subscribeSse:o=!1"),
    "the hook's destructuring default is a binding, not a transport read — splicing it would not parse");
  assert.equal(result.patches.filter(p => p.id === "web-code-subscribe-sse").length, 0,
    "the transport splice is a web-shell patch and must not appear in the Desktop shell");
  assert.equal(webResult.patches.filter(p => p.id === "web-chat-session-list-no-code").length, 1,
    "the session list's sticky Code intent must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('return e==="code"||t||!1'),
    "only the Code surface's own mode may open the Code feed");
  assert.ok(result.sources.get(`changed-chunk-${i}.js`)
    .includes('return e==="code"||t||n'),
    "the Desktop shell must keep the product-switcher intent");
  assert.equal(result.patches.filter(p => p.id === "web-chat-session-list-no-code").length, 0,
    "the session-list Code exclusion is a web-shell splice");
  // A tenant takes the same renderer as the deployment's own instance: `/code`
  // must resolve to the surface the bridge drives. The isolation guarantee is
  // the environment list and the LocalSessions guard, not the route name.
  const tenantResult = patchRendererSources(inputs, true, true, true);
  assert.equal(tenantResult.patches.length, 21,
    "a tenant's web shell keeps every web-shell patch, the route alias included");
  assert.equal(tenantResult.patches.filter(p => p.id === "desktop-code-route-alias").length, 1,
    "a tenant's `/code` must resolve to the surface this bridge drives");
  assert.equal(tenantResult.patches.filter(p => p.id === "desktop-session-viewer-gate").length, 1,
    "the rest of the web shell is unchanged for a tenant");
  assert.equal(tenantResult.patches.filter(p => p.id === "web-code-subscribe-sse").length, 1,
    "a tenant's Code page gets the SSE transport too — it is the deployment that serves it");
  assert.equal(webResult.patches.filter(p => p.id === "toast-global").length, 1,
    "the toast manager must be published exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes(";globalThis.__CLAUDESK_TOAST__=useToastManager();"),
    "the publish must name the toast hook read back from the graph");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes("let{toasts:t}=useToastStore(),n=useToastContext();;globalThis.__CLAUDESK_TOAST__"),
    "the splice must land after the viewport's own declaration, not at the top of the body");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes("function useSomethingElse()"),
    "a hook-shaped function without add/close must not be published");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`).includes('"data-cds":"Toast-Extra"'),
    "a component carrying some other marker must not be mistaken for the viewport");
  assert.equal(result.patches.filter(p => p.id === "toast-global").length, 0,
    "the toast global is a web-shell splice and must not appear in the Desktop shell");
  assert.ok(!output.includes("__CLAUDESK_TOAST__"),
    "a Desktop-shell renderer must stay byte-identical");
  assert.equal(webResult.patches.filter(p => p.id === "web-scheduled-task-runner").length, 1,
    "the scheduled-task runner's Desktop gate must be spliced exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('desktop||refuse(task.scheduledTaskId,"Local scheduled task run requested outside'),
    "the runner must keep its abort, keyed on the forced flag");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('let desktop=!0,{storedModel:m}=coworkState()'),
    "the runner's platform check must be forced true, leaving its other bindings alone");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('return memo(task=>{desktop||refuse(task.id,"x","Local scheduled task started elsewhere")'),
    "a runner with different copy must not be spliced");
  assert.equal(webResult.patches.filter(p => p.id === "web-scheduled-task-hosts").length, 1,
    "the scheduled-task hosts must be mounted exactly once");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('children:[el(starterHost,{}),el(listenerHost,{})]'),
    "the slot's absent-identity branch must mount both scheduled-task hosts");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('componentName:"DesktopChecks",fallback:null,children:[el(desktopRoot,{}),'
      + 'el(otherChecks,{})]}):(wrap(Boundary,{componentName:"DesktopChecks",fallback:null'),
    "the slot's identity branch must keep its own hosts, and the hoisted ones must render into the same wrapper");
  assert.ok(webResult.sources.get(`changed-chunk-${i}.js`)
    .includes('const otherHost=memo(function(){'),
    "a setter for another store key is not the starter host");
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
    ["file-pane-download", "inference-banner", "native-file-preview-bridge",
      "account-sign-out-row", "gateway-url-any-host-http"],
    "without the Gateway flag only the always-on patches are spliced");
  const disabledOutput = disabled.sources.get(`changed-chunk-${i}.js`);
  assert.ok(disabledOutput.includes('icon:"Download"'), "the download button stays on with the flag off");
  assert.ok(!disabledOutput.includes("gatewaySettingsEnabled"), "the Gateway guards stay off with the flag off");
  assert.ok(disabledOutput.endsWith(decoy), "the download button must not disturb the tail");
  const compiled = await minify(inputs.get(`changed-chunk-${i}.js`), {
    mangle: true, compress: { unused: false }, format: { quote_style: 1 },
  });
  assert.equal(patchRendererSources(new Map([["new-hash.js", compiled.code]]), true).patches.length, 7,
    "compiler-generated variants must retain every patch");
  assert.throws(() => patchRendererSources(new Map([...inputs, ["duplicated.js", signin]]), true), /expected once, found 2/);
}
// The titlebar's compact mode switcher — the "Claude"/"Code" pills. When Code is
// turned off (the managed default) its segments array carries a disabled
// segment, so the control has nothing to switch to and the patcher hides it
// whole; a deployment with Code on keeps it, because then no segment is
// disabled. The splice is a structural read-back, so it survives minification,
// and a marker on an element that does not wrap the switcher call, or a switcher
// call with no segments binding, is not a target.
const pickerPatches = inspectRenderer(modePicker, false).patches
  .filter(patch => patch.id === "titlebar-mode-picker-without-code");
assert.equal(pickerPatches.length, 1, "the compact mode switcher must be spliced once");
assert.ok(pickerPatches[0].replacement.startsWith(
  "(F.some(__claudeskMode=>__claudeskMode.disabled)?null:h(Switch,{"),
  "the splice must hide the switcher whenever a segment is disabled");
assert.ok(pickerPatches[0].original.startsWith("h(Switch,{")
  && pickerPatches[0].original.includes("\"data-compact-mode-switcher\":!0,"),
  "the splice must wrap the whole rendered element");
assert.equal(inspectRenderer(modePickerDecoys, false).patches
  .filter(patch => patch.id === "titlebar-mode-picker-without-code").length, 0,
  "an element that does not wrap the segments switcher is not the mode picker");
// A `signOut` shorthand or method shares or owns its key's extent, so replacing
// its value would corrupt the literal; only a genuine `signOut: <expr>` pair is
// a target.
assert.equal(inspectRenderer(
  "function flags(){return {hasAccount:a,inferenceConfig:e,internalTools:t,signOut}}", false).patches
  .filter(patch => patch.id === "account-sign-out-row").length, 0,
  "a shorthand signOut must not be spliced");
assert.equal(inspectRenderer(
  "function flags(){return {hasAccount:a,inferenceConfig:e,internalTools:t,signOut(){}}}", false).patches
  .filter(patch => patch.id === "account-sign-out-row").length, 0,
  "a signOut method must not be spliced");
const pickerCompiled = await minify(modePicker, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(pickerCompiled.code, false).patches
  .filter(patch => patch.id === "titlebar-mode-picker-without-code").length, 1,
  "a mangled compact mode switcher must still be spliced once");
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]), false, true),
  /web-local-session-placement expected once, found 0/,
  "the web shell must refuse a renderer without the placement helper");
assert.throws(() => patchRendererSources(new Map([["dup-placement.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}`
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
// The session list's Code gate is pinned by its destructured property names and
// its single returned disjunction: a lookalike without the folded branch is not
// a target, and the splice survives minification.
assert.equal(inspectRenderer(chatListGateDecoy, false, true).patches
  .filter(patch => patch.id === "web-chat-session-list-no-code").length, 0,
  "a disjunction without the folded branch is not the session-list gate");
const chatListCompiled = await minify(chatListGate, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(chatListCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-chat-session-list-no-code").length, 1,
  "a mangled session-list gate must still be spliced once");
// The download target must be unique: a second file pane fragment, or a
// duplicated file pane, is refused rather than double-spliced.
assert.throws(() => patchRendererSources(new Map([["a.js", filePane], ["b.js", filePane]]), false),
  /file-pane-download expected once, found 2/);
// The web shell requires the alias splice: a renderer with no resolver refuses.
assert.throws(() => patchRendererSources(new Map([["no-alias.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}`]]), false, true),
  /desktop-code-route-alias expected once, found 0/,
  "the web shell must refuse a renderer without the route-alias resolver");
// ...and the session Desktop gate: a renderer whose session layout no longer
// matches must be refused rather than ship a shell where every session bounces.
assert.throws(() => patchRendererSources(new Map([["no-session-gate.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}`]]), false, true),
  /desktop-session-viewer-gate expected once, found 0/,
  "the web shell must refuse a renderer without the session Desktop gate");
// ...and the account chip's avatar: a renderer whose chip still renders the
// photo-less mark must be refused rather than ship a shell where a configured
// pfp never renders (the chip never sets a source, so no image is requested).
assert.throws(() => patchRendererSources(new Map([["no-chip.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`]]), false, true),
  /web-account-chip-avatar expected once, found 0/,
  "the web shell must refuse a renderer without the account-chip avatar");
// Two chips (or a second photo-less account-view component) must refuse rather
// than splice the avatar into the wrong slot.
const accountChipB = accountChip.replaceAll("chipMark", "chipMarkB")
  .replaceAll("accountHook", "accountHookB").replaceAll("accountAvatar", "accountAvatarB");
assert.throws(() => patchRendererSources(new Map([["dup-chip.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChipBody}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}\n${accountMenuName}`]]),
  false, true),
  /web-account-photo-first-frame expected once, found 0/,
  "the web shell must refuse a renderer without the account view hook");
// Two view hooks must refuse rather than splice the fallback into the wrong one.
assert.throws(() => patchRendererSources(new Map([["dup-photo-hook.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
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
const webShellFixtures = `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}`
  + `\n${sessionLayout}\n${sessionPlacement}\n${accountChip}\n${desktopRoot}\n${desktopChecks}\n${pushEnable}`
  + `\n${scheduledTaskHosts}\n${scheduledTaskRunner}\n${toastHost}`;
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
    + `\n${accountChip}\n${desktopRoot}\n${desktopChecks}`]]), false, true),
  /web-notifications-enable-bridge expected once, found 0/,
  "the web shell must refuse a renderer without the push-enablement function");
// Two push-enablement functions must refuse rather than splice the branch into
// the wrong one.
assert.throws(() => patchRendererSources(new Map([["dup-push-enable.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}`]]), false).patches
  .map(patch => patch.id).join(","),
    "file-pane-download,inference-banner,native-file-preview-bridge,account-sign-out-row");
// Native checks also survive reverse comparisons, computed keys and formatting.
const changedNative = "const error='rewindSession unavailable'; callbacks['rewindV2']; 229 == event['keyCode']; const actions={'edit': 'onEdit'};";
assert.equal(patchRendererSources(new Map([["changed-native.js",
  `${changedNative}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}`]]), false).markers.length, 4);
assert.throws(() => patchRendererSources(new Map([["comments.js",
  `/* ${native} */\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}`]]), false), /capability .* missing/);
// The card removal is required: its body is blanked wherever it is found, any
// declaration or string naming the ids is ignored, and a bundle that no longer
// matches is refused rather than letting the card return silently.
const bannerGuard = 'function signin(){const code=user.pendingUserCode;'
  + 'const ok=flag&&(window.location.protocol==="app:");router.replace("/new");return ok;}'
  + 'const route=()=>{const ok=(typeof window!=="undefined")'
  + '&&(window.location.protocol==="app:");router.replace("/new");return ok;};';
const bannerInputs = new Map([["banner-chunk.js",
  `${native}\n${bannerGuard}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${bannerDecoy}`]]);
const bannerOut = patchRendererSources(bannerInputs, true).sources.get("banner-chunk.js");
assert.ok(!bannerOut.includes("model allowlist"), "the provider card copy must be removed");
assert.ok(bannerOut.includes("const providerCard=wrap(function({compact:e,fallback:t}){return null;})"),
  "only the card component's body is replaced");
assert.ok(bannerOut.endsWith(bannerDecoy), "a declaration or string naming the ids is not a target");
assert.deepEqual(patchRendererSources(bannerInputs, false).patches.map(patch => patch.id).sort(),
  ["account-sign-out-row", "file-pane-download", "inference-banner", "native-file-preview-bridge"],
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}`]]);
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n`
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
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}\n${accountChip}`]]), false, true),
  /web-cowork-permission-wiring expected once, found 0/,
  "the web shell must refuse a renderer without the Desktop-checks slot");
assert.throws(() => patchRendererSources(new Map([["dup-checks.js",
  `${native}\n${filePane}\n${bannerCard}\n${previewComponent}\n${accountSignOut}\n${aliasResolver}\n${sessionLayout}\n${sessionPlacement}`
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
// ...and the two scheduled-task gates. A renderer whose runner no longer matches,
// or whose slot cannot give up both hosts, must be refused rather than ship a
// Routines list that can be added to but never run.
assert.throws(() => patchRendererSources(new Map([["no-runner.js",
  `${webShellFixtures.replace(scheduledTaskRunner, "const nothing={};")}\n${accountMenuName}`]]),
  false, true), /web-scheduled-task-runner expected once, found 0/,
  "the web shell must refuse a renderer without the scheduled-task runner");
assert.throws(() => patchRendererSources(new Map([["dup-runner.js",
  `${webShellFixtures}\n${accountMenuName}\n${scheduledTaskRunner.replaceAll("runScheduledTask", "runScheduledTaskB")}`]]),
  false, true), /web-scheduled-task-runner expected once, found 2/,
  "a second scheduled-task runner must refuse rather than double-splice");
assert.throws(() => patchRendererSources(new Map([["no-hosts.js",
  `${webShellFixtures.replace(scheduledTaskHosts, "const noHosts={};")}\n${accountMenuName}`]]),
  false, true), /web-scheduled-task-hosts expected once, found 0/,
  "the web shell must refuse a renderer whose scheduled-task hosts cannot be read back");
// Both splices are structural read-backs, so they survive minification.
const scheduledTaskCompiled = await minify(
  `${desktopRoot}\n${desktopChecks}\n${scheduledTaskHosts}\n${scheduledTaskRunner}`,
  { mangle: true, compress: { unused: false }, format: { quote_style: 1 } });
const scheduledTaskIds = inspectRenderer(scheduledTaskCompiled.code, false, true).patches
  .map(patch => patch.id);
assert.ok(scheduledTaskIds.includes("web-scheduled-task-runner")
  && scheduledTaskIds.includes("web-scheduled-task-hosts"),
  "a mangled scheduled-task runner and slot must still be spliced");
assert.equal(inspectRenderer(
  `${desktopChecks.replace("DesktopChecks", "OtherLabel")}\n${scheduledTaskHosts}`, false, true).patches
  .filter(patch => patch.id === "web-scheduled-task-hosts").length, 0,
  "a slot that is not the Desktop-checks slot is not a mount point for the scheduled-task hosts");
// The routine API card's fire origin: the conditional that answers
// `https://api.anthropic.com` (staging for a staging host). In web-shell mode it
// is replaced with the page's own origin, so the card's copied URL names this
// deployment. Only a return whose two arms are exactly those literals matches.
const routineOriginChunk = 'function apiOrigin(){let e=typeof window<"u"'
  + '?window.location.hostname:"";return"".includes("staging")||e.includes("staging")'
  + '?"https://api-staging.anthropic.com":"https://api.anthropic.com"}';
const routineOriginDecoy = 'function apiOriginAlready(){return location.origin}';
assert.equal(inspectRenderer(routineOriginChunk, false, false).patches.length, 0,
  "the routine fire origin is left alone outside web-shell mode");
assert.equal(inspectRenderer(routineOriginDecoy, false, true).patches.length, 0,
  "a function that already returns the page origin is not a target");
assert.equal(inspectRenderer(`${routineOriginChunk}\n${routineOriginDecoy}`, false, true).patches
  .filter(patch => patch.id === "routine-fire-origin").length, 1,
  "an unrelated origin function in the same chunk must not stop the splice");
assert.equal(inspectRenderer(`${routineOriginChunk}\n`
  + `${routineOriginChunk.replace("apiOrigin", "apiOriginB")}`, false, true).patches
  .filter(patch => patch.id === "routine-fire-origin").length, 0,
  "a second cloud-origin conditional must refuse rather than splice one of two");
const routineOriginOut = patchRendererSources(
  new Map([["routine-origin.js",
    `${webShellFixtures}\n${accountMenuName}\n${routineOriginChunk}`]]), false, true)
  .sources.get("routine-origin.js");
assert.ok(routineOriginOut.includes("return window.location.origin"),
  "the fire origin must become the page's own origin");
assert.ok(!routineOriginOut.includes("https://api.anthropic.com"),
  "the cloud origin must not survive the splice");
const routineOriginCompiled = await minify(routineOriginChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(routineOriginCompiled.code, false, true).patches
  .filter(patch => patch.id === "routine-fire-origin").length, 1,
  "a mangled cloud-origin conditional must still be spliced once");
// The routine form's trigger cards: the Desktop build ships the schedule-only
// subset, so the form cannot create an API-only routine (or add an API trigger).
// The patch appends the API card to the array the `availableCards` memo filters.
const routineTriggerCards = 'function routineForm(){return{availableCards:'
  + 'useMemo(()=>scheduleCards.filter(e=>e.type==="github"?routinesFeature'
  + '&&(oneCard||!added.has("github")):!added.has(e.type)),'
  + '[routinesFeature,oneCard,added])};}';
const routineTriggerDecoy = 'function other(){return{availableCards:'
  + 'useMemo(()=>cards.filter(e=>e.type==="github"),[])};}';
assert.equal(inspectRenderer(routineTriggerCards, false, false).patches
  .filter(patch => patch.id === "routine-api-trigger").length, 0,
  "the API trigger card is left alone outside web-shell mode");
assert.equal(inspectRenderer(routineTriggerDecoy, false, true).patches
  .filter(patch => patch.id === "routine-api-trigger").length, 0,
  "an availableCards memo without the routine card filter is not a target");
assert.equal(inspectRenderer(`${routineTriggerCards}\n${routineTriggerDecoy}`, false, true).patches
  .filter(patch => patch.id === "routine-api-trigger").length, 1,
  "a lookalike in the same chunk must not stop the splice");
assert.equal(inspectRenderer(`${routineTriggerCards}\n`
  + `${routineTriggerCards.replace("routineForm", "routineFormB")}`, false, true).patches
  .filter(patch => patch.id === "routine-api-trigger").length, 0,
  "a second availableCards target must refuse rather than splice one of two");
const routineTriggerOut = patchRendererSources(
  new Map([["routine-cards.js",
    `${webShellFixtures}\n${accountMenuName}\n${routineTriggerCards}`]]), false, true)
  .sources.get("routine-cards.js");
assert.ok(routineTriggerOut.includes('[...scheduleCards,{type:"api",icon:"Code"'),
  "the API card must be appended to the trigger cards");
assert.ok(routineTriggerOut.includes('filter(e=>e.type==="github"'),
  "the existing filter must be left in place");
const routineTriggerCompiled = await minify(routineTriggerCards, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(routineTriggerCompiled.code, false, true).patches
  .filter(patch => patch.id === "routine-api-trigger").length, 1,
  "a mangled availableCards memo must still be spliced once");
// The home-layout assignment: the chunk that reads the new-page gate returns
// the assignment object the Desktop build compiles out — eligible, settled and
// assignment hardcoded false — so the renderer always settles on the classic
// home layout. In web-shell mode the object is spliced to the all-assigned
// shape the web bundle produces for a visitor in the experiment.
const homeLayoutChunk = 'function homeAssignment(){useLocale().locale;readGate();'
  + 'let eligible=!1;const gate="__gb__1085985672";observe(gate);'
  + 'let settled=eligible,stringsDelivered=serverGates(gate),{data,fetchStatus}=useBootstrap();'
  + 'useForced();let{activeOrganization,featureFlagsOrgUuid}=useAccount();'
  + 'return{eligible,settled,assignment:settled,stringsDelivered,stringsVouched:eligible,'
  + 'stringsUndelivered:eligible};}';
// A lookalike object that shares one property name, and a second assignment
// object in the same chunk, are both refused rather than spliced.
const homeLayoutDecoy = 'function other(){return{eligible:!0,settled:!1};}';
const homeLayoutTwin = homeLayoutChunk.replace("homeAssignment", "homeAssignmentB")
  .replace('"__gb__1085985672"', '"__gb__0000000000"');
assert.equal(inspectRenderer(homeLayoutChunk, false, false).patches.length, 0,
  "the home-layout assignment is left alone outside web-shell mode");
assert.equal(inspectRenderer(homeLayoutDecoy, false, true).patches.length, 0,
  "an object sharing one property name is not the assignment");
assert.equal(inspectRenderer(`${homeLayoutChunk}\n${homeLayoutDecoy}`, false, true).patches
  .filter(patch => patch.id === "web-new-page-home-layout").length, 1,
  "a lookalike in the same chunk must not stop the splice");
assert.equal(inspectRenderer(`${homeLayoutChunk}\n${homeLayoutTwin}`, false, true).patches
  .filter(patch => patch.id === "web-new-page-home-layout").length, 0,
  "a second assignment object must refuse rather than splice one of two");
const homeLayoutOut = patchRendererSources(
  new Map([["home-layout.js", `${webShellFixtures}\n${accountMenuName}\n${homeLayoutChunk}`]]),
  false, true).sources.get("home-layout.js");
assert.ok(homeLayoutOut.includes('return{eligible:!0,settled:!0,assignment:!0,'
  + 'stringsDelivered:!0,stringsVouched:!0,stringsUndelivered:!1}'),
  "the assignment must be spliced to the all-assigned shape in web-shell mode");
assert.ok(!homeLayoutOut.includes("stringsVouched:eligible"),
  "the compiled-out shape must not survive the splice");
const homeLayoutCompiled = await minify(homeLayoutChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(homeLayoutCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-new-page-home-layout").length, 1,
  "a mangled assignment object must still be spliced once");
// The unified-composer design predicates: functions that answer "is the marlin
// design on?" from the GrowthBook feature by name, ending with the side-panel
// guard. In web-shell mode their flag operand is forced true, leaving that guard
// alone; a function that does not read the feature is not a target.
const designPredicates = 'var marlinFlag="voyage_composer_marlin";'
  + 'function designFromFlag(){let{on:e,inPayload:t}=features(marlinFlag);'
  + 'return(e||t)&&!inSidePanel()}'
  + 'function designByName(){return reads("voyage_composer_marlin")&&!inSidePanel()}'
  + 'function latchAware(){let{on:e}=features(marlinFlag),n=deviceLatch();return pick(n)&&!inSidePanel()}'
  + 'function unrelatedGate(){let e=otherSignal();return e&&!inSidePanel()}';
const designDecoy = 'function other(){let e=reads("some_other_feature");return e&&!inSidePanel()}';
assert.equal(inspectRenderer(designPredicates, false, false).patches
  .filter(patch => patch.id === "web-composer-design-forced").length, 0,
  "the design predicates are left alone outside web-shell mode");
const designIds = inspectRenderer(`${designPredicates}\n${designDecoy}`, false, true).patches
  .filter(patch => patch.id === "web-composer-design-forced");
assert.equal(designIds.length, 3,
  "each predicate that reads the feature must be forced, and no other guard");
assert.deepEqual(designIds.map(patch => patch.original).sort(),
  ["e||t", "pick(n)", 'reads("voyage_composer_marlin")'],
  "only the flag operand is spliced, never the side-panel guard");
const designOut = patchRendererSources(
  new Map([["design.js", `${webShellFixtures}\n${accountMenuName}\n${designPredicates}`]]), false, true)
  .sources.get("design.js");
assert.ok(designOut.includes("return(!0)&&!inSidePanel()"),
  "the forced operand must leave the side-panel guard in place");
assert.ok(!designOut.includes("pick(n)&&"), "the latch-aware predicate's operand must be replaced");
assert.ok(designOut.includes("return e&&!inSidePanel()"),
  "a guard that does not read the feature must survive untouched");
const designCompiled = await minify(designPredicates, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(designCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-composer-design-forced").length, 3,
  "a mangled set of design predicates must still be forced");
// The layout variant where the composer host consumes it — a `layoutVariant`
// prop default the component's own ternary also names — and the route surface
// kind, the only place the three route names appear together. Both are forced in
// web-shell mode, each publishing the value it replaced.
const variantFixture = (suffix = "") => 'function page' + suffix + '({topContent:e,'
  + 'layoutVariant:t=defaultVariant}={}){let h=isStart()?defaultVariant:t;return h}'
  + 'function otherPage' + suffix + '({layoutVariant:t=otherDefault}={}){'
  + 'let h=isStart()?firstDefault:t;return h}';
const surfaceFixture = (suffix = "") => 'function surfaceKind' + suffix + '(){let e=hubHost(),t=lookActive();'
  + 'return e?"hub":t?"outside":"none"}'
  + 'function otherKind' + suffix + '(){return opts.mode?"hub":"none"}';
assert.equal(inspectRenderer(`${variantFixture()}\n${surfaceFixture()}`, false, false).patches
  .filter(patch => patch.id === "web-new-page-home-variant"
    || patch.id === "web-home-composer-arrangement").length, 0,
  "neither decision is forced outside web-shell mode");
const forced = inspectRenderer(`${variantFixture()}\n${surfaceFixture()}`, false, true).patches
  .filter(patch => patch.id === "web-new-page-home-variant"
    || patch.id === "web-home-composer-arrangement");
assert.deepEqual(forced.map(patch => patch.id).sort(),
  ["web-home-composer-arrangement", "web-new-page-home-variant"]);
assert.deepEqual(forced.map(patch => patch.original).sort(),
  ['e?"hub":t?"outside":"none"', 'isStart()?defaultVariant:t'],
  "only the consuming ternary and the three-name conditional are spliced");
assert.deepEqual(forced.map(patch => patch.replacement).sort(), ['"home"', '"outside"'],
  "each decision is forced to the deployed answer");
// A ternary whose consequent is not the component's own prop default is not a
// target, and two candidates in one chunk refuse rather than pick one.
assert.ok(!inspectRenderer(`${variantFixture()}\n${surfaceFixture()}`, false, true).patches
  .some(patch => patch.original === "isStart()?firstDefault:t"),
  "a ternary naming another default must not be spliced");
assert.equal(inspectRenderer(`${variantFixture()}\n${variantFixture("B")}`, false, true).patches
  .filter(patch => patch.id === "web-new-page-home-variant").length, 0,
  "two candidates must refuse the splice");
assert.equal(inspectRenderer(`${surfaceFixture()}\n${surfaceFixture("B")}`, false, true).patches
  .filter(patch => patch.id === "web-home-composer-arrangement").length, 0,
  "a second three-name conditional must refuse the splice");
const decisionsOut = patchRendererSources(
  new Map([["decisions.js", `${webShellFixtures}\n${accountMenuName}\n${variantFixture()}\n${surfaceFixture()}`]]),
  false, true).sources.get("decisions.js");
assert.ok(decisionsOut.includes('let h="home"'),
  "the consuming ternary must be spliced to the home arm");
assert.ok(decisionsOut.includes('return "outside"'),
  "the route surface kind must be spliced to the outside arm");
assert.ok(decisionsOut.includes('let h=isStart()?firstDefault:t'),
  "a ternary naming another component's default must survive untouched");
assert.ok(decisionsOut.includes('return opts.mode?"hub":"none"'),
  "a two-name conditional must survive untouched");
const decisionsCompiled = await minify(`${variantFixture()}\n${surfaceFixture()}`, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
const compiledIds = inspectRenderer(decisionsCompiled.code, false, true).patches.map(patch => patch.id);
assert.ok(compiledIds.includes("web-new-page-home-variant")
  && compiledIds.includes("web-home-composer-arrangement"),
  "a mangled pair of decisions must still be spliced");
// The projects-allowed predicate. The Desktop build reads the plan capabilities
// and the limits feature, then answers a module constant it never assigns, so
// projects are shut however either would evaluate. In web-shell mode the body is
// rebuilt as the disjunction claude.ai ships: the same four reads hoisted into
// declarators (they are hooks, so hoisting keeps their order fixed rather than
// short-circuiting a prefix of them) and the feature compared `> 0`.
const projectsConstant = "foldedProjectsAllowed";
const projectsPredicate = (name = "projectsAllowed") => `function ${name}(){return readPro(),`
  + `readMax(),readRaven(),limits("claude_ai_projects_limits","max_free_projects",0,schema),`
  + `${projectsConstant}}`;
const projectsChunk = `var ${projectsConstant}=!1;${projectsPredicate()}`
  // The bundle's own sibling limit helper: the same four reads, but declared and
  // guarded, so it must survive the splice untouched.
  + 'function freeProjectLimit(){let p=readPro(),m=readMax(),r=readRaven(),'
  + 'n=limits("claude_ai_projects_limits","max_free_projects",0,schema);'
  + 'if(!(p||m||r))return n>0?n:0}'
  // A five-expression sequence that never names the feature is not a target.
  + 'function unrelatedSequence(){return a(),b(),c(),d(),constant}';
assert.equal(inspectRenderer(projectsChunk, false, false).patches
  .filter(patch => patch.id === "web-projects-allowed").length, 0,
  "the projects predicate is left alone outside web-shell mode");
const projectsPatches = inspectRenderer(projectsChunk, false, true).patches
  .filter(patch => patch.id === "web-projects-allowed");
assert.equal(projectsPatches.length, 1,
  "exactly the predicate reading the limits feature must be rebuilt, and its sibling not");
assert.ok(projectsPatches[0].original.includes('limits("claude_ai_projects_limits"')
  && projectsPatches[0].original.endsWith(`,${projectsConstant}}`),
  "only the predicate's body is spliced");
assert.equal(inspectRenderer(`${projectsPredicate()}\n${projectsPredicate("projectsAllowedB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-allowed").length, 0,
  "two candidates must refuse the splice rather than rebuild one of two");
const projectsOut = patchRendererSources(
  new Map([["projects.js", `${webShellFixtures}\n${accountMenuName}\n${projectsChunk}`]]), false, true)
  .sources.get("projects.js");
assert.ok(projectsOut.includes("const __claudeskPlanPro=readPro(),__claudeskPlanMax=readMax(),"
  + "__claudeskPlanRaven=readRaven(),__claudeskFreeProjects="
  + 'limits("claude_ai_projects_limits","max_free_projects",0,schema);'
  + "return __claudeskFreeProjects>0||__claudeskPlanPro||__claudeskPlanMax"
  + "||__claudeskPlanRaven}"),
  "the body must be rebuilt as the hoisted four-read disjunction");
assert.ok(!projectsOut.includes(`return readPro(),`),
  "the folded comma sequence must not survive the splice");
assert.ok(projectsOut.includes('if(!(p||m||r))return n>0?n:0}'),
  "the bundle's own guarded limit helper must survive untouched");
assert.ok(projectsOut.includes("function unrelatedSequence(){return a(),b(),c(),d(),constant}"),
  "a five-expression sequence that never names the feature must survive untouched");
const projectsCompiled = await minify(projectsChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(projectsCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-allowed").length, 1,
  "a mangled predicate must still be rebuilt once");
// The atrium capability. The picker's `remoteProjectsEnabled` is the same fold
// once more: the Desktop build reads the atrium feature and then answers a
// module constant it never assigns, so the composer's picker is a folder picker.
// The patch splices the comma sequence down to the read, keeping the read where
// it was so hook order is unchanged.
const atriumConstant = "foldedAtrium";
const atriumReader = (name = "remoteProjectsEnabled") => `function ${name}(){return `
  + `read("yukon_silver_dramatic_shrimp_atrium"),${atriumConstant}}`;
const atriumChunk = `var ${atriumConstant}=!1;${atriumReader()}`
  // The same reader in the same discarded position, naming a different feature:
  // only the atrium literal pins the target, so this must survive untouched.
  + `function otherFlags(){return read("ccr_auto_permission_mode"),${atriumConstant}}`
  // A two-expression sequence whose read names no feature is not a target.
  + `function unrelatedPair(){return read(),${atriumConstant}}`;
assert.equal(inspectRenderer(atriumChunk, false, false).patches
  .filter(patch => patch.id === "web-projects-atrium").length, 0,
  "the atrium capability is left alone outside web-shell mode");
const atriumPatches = inspectRenderer(atriumChunk, false, true).patches
  .filter(patch => patch.id === "web-projects-atrium");
assert.equal(atriumPatches.length, 1,
  "exactly the reader naming the atrium feature must be unwrapped, and its sibling not");
assert.equal(atriumPatches[0].original,
  `read("yukon_silver_dramatic_shrimp_atrium"),${atriumConstant}`,
  "only the comma sequence is spliced");
assert.equal(atriumPatches[0].replacement, `read("yukon_silver_dramatic_shrimp_atrium")`,
  "the sequence must be spliced down to the feature read itself");
assert.equal(inspectRenderer(`${atriumReader()}\n${atriumReader("remoteProjectsEnabledB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-atrium").length, 0,
  "two candidates must refuse the splice rather than unwrap one of two");
const atriumOut = patchRendererSources(
  new Map([["atrium.js", `${webShellFixtures}\n${accountMenuName}\n${atriumChunk}`]]),
  false, true).sources.get("atrium.js");
assert.ok(atriumOut.includes(
  'function remoteProjectsEnabled(){return read("yukon_silver_dramatic_shrimp_atrium")}'),
  "the capability must answer the feature read instead of the folded constant");
assert.ok(!atriumOut.includes(`read("yukon_silver_dramatic_shrimp_atrium"),${atriumConstant}`),
  "the folded comma sequence must not survive the splice");
assert.ok(atriumOut.includes(`read("ccr_auto_permission_mode"),${atriumConstant}`),
  "a discarded read of another feature must survive untouched");
assert.ok(atriumOut.includes(`function unrelatedPair(){return read(),${atriumConstant}}`),
  "a sequence that names no feature must survive untouched");
const atriumCompiled = await minify(atriumChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(atriumCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-atrium").length, 1,
  "a mangled capability must still be unwrapped once");
// The server-projects predicate. Every capability predicate in the bundle is
// spelled `let first = …, probe = read().isAvailable; return a && b && …`, so the
// shape alone matches four of them — the search one, the Cowork one and another
// feature's. The patch pins the one that also reads the account's active
// organization and chains three operands rather than two; the fixture carries the
// sibling spellings to prove they are left alone.
const serverProjectsPredicate = (name = "serverProjectsAvailable") =>
  `function ${name}(){let{activeOrganization:e}=session(),t=projectsPredicate(),`
  + "n=accountProbe().isAvailable;return!!e&&t&&n}";
const siblingCapabilityPredicates =
  "function searchAvailable(){let e=flag(),t=searchProbe().isAvailable;return e&&t}"
  + "function coworkAvailable(){let e=otherFlag(),t=coworkProbe().isAvailable;return e&&t}";
const serverProjectsChunk = `${serverProjectsPredicate()}${siblingCapabilityPredicates}`;
assert.equal(inspectRenderer(`${webShellFixtures}\n${serverProjectsChunk}`, false, false).patches
  .filter(patch => patch.id === "web-projects-remote-list").length, 0,
  "the predicate is left alone outside web-shell mode");
const serverProjectsPatches = inspectRenderer(`${webShellFixtures}\n${serverProjectsChunk}`,
  false, true).patches.filter(patch => patch.id === "web-projects-remote-list");
assert.equal(serverProjectsPatches.length, 1,
  "exactly the projects predicate must be spliced, and its siblings not");
assert.equal(serverProjectsPatches[0].original, "!!e&&t&&n",
  "only the returned expression is spliced");
assert.equal(serverProjectsPatches[0].replacement, "!1",
  "the predicate must answer false");
assert.equal(inspectRenderer(
  `${webShellFixtures}\n${serverProjectsPredicate()}\n${serverProjectsPredicate("other")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-remote-list").length, 0,
  "two candidates must refuse the splice rather than force one of two");
const serverProjectsOut = patchRendererSources(new Map([["server.js",
  `${webShellFixtures}\n${accountMenuName}\n${serverProjectsChunk}`]]), false, true)
  .sources.get("server.js");
assert.ok(serverProjectsOut.includes("{let{activeOrganization:e}=session(),"
  + "t=projectsPredicate(),n=accountProbe().isAvailable;return!1}"),
  "the declarators, and the hooks in them, must survive the splice");
assert.ok(serverProjectsOut.includes("function searchAvailable(){let e=flag(),"
  + "t=searchProbe().isAvailable;return e&&t}"),
  "a two-operand capability predicate must survive untouched");
assert.ok(serverProjectsOut.includes("function coworkAvailable(){let e=otherFlag(),"
  + "t=coworkProbe().isAvailable;return e&&t}"),
  "the Cowork capability predicate must survive untouched");
const serverProjectsCompiled = await minify(serverProjectsChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(`${webShellFixtures}\n${serverProjectsCompiled.code}`, false, true)
  .patches.filter(patch => patch.id === "web-projects-remote-list").length, 1,
  "a mangled predicate must still be spliced once");

// The hub-writable flag, folded to a constant the way the atrium capability is.
// The bundle spells the fold twice off the same constant, so both are spliced and
// the read — which the bridge grants — becomes the answer.
const hubWritableFold = (name = "amberTributaryHeron") => `function ${name}(){`
  + `return read("amber_tributary_heron"),{enabled:heronConstant}}`;
const hubWritableChunk = `var heronConstant=!1;${hubWritableFold()}${hubWritableFold("_heron")}`
  // The same discarded read answering a *different* feature is not this fold.
  + 'function otherFold(){return read("amber_tributary_osprey"),{enabled:heronConstant}}'
  // A read whose answer is not the constant object is not this fold either.
  + 'function plainRead(){return read("amber_tributary_heron")}';
assert.equal(inspectRenderer(`${webShellFixtures}\n${hubWritableChunk}`, false, false).patches
  .filter(patch => patch.id === "web-cowork-hub-writable").length, 0,
  "the fold is left alone outside web-shell mode");
const hubWritablePatches = inspectRenderer(`${webShellFixtures}\n${hubWritableChunk}`, false, true)
  .patches.filter(patch => patch.id === "web-cowork-hub-writable");
assert.equal(hubWritablePatches.length, 2,
  "every function carrying the fold must be spliced, and its neighbours not");
assert.ok(hubWritablePatches.every(patch =>
  patch.original === 'read("amber_tributary_heron"),{enabled:heronConstant}'
  && patch.replacement === '{enabled:read("amber_tributary_heron")}'),
  "the object must be rebuilt around the read itself");
const hubWritableOut = patchRendererSources(new Map([["hub.js",
  `${webShellFixtures}\n${accountMenuName}\n${hubWritableChunk}`]]), false, true)
  .sources.get("hub.js");
assert.ok(hubWritableOut.includes(
  'function amberTributaryHeron(){return {enabled:read("amber_tributary_heron")}}'),
  "the flag must answer the feature read instead of the folded constant");
assert.ok(hubWritableOut.includes("var heronConstant=!1;"),
  "the folded constant itself must survive");
assert.ok(hubWritableOut.includes(
  'function otherFold(){return read("amber_tributary_osprey"),{enabled:heronConstant}}'),
  "a fold answering another feature must survive untouched");
assert.ok(hubWritableOut.includes('function plainRead(){return read("amber_tributary_heron")}'),
  "a bare read without the object must survive untouched");
const hubWritableCompiled = await minify(hubWritableChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(`${webShellFixtures}\n${hubWritableCompiled.code}`, false, true)
  .patches.filter(patch => patch.id === "web-cowork-hub-writable").length, 2,
  "a mangled pair of folds must still be spliced");

// The two consumers that read those queries' pending state. A disabled query is
// still pending in react-query, so both have to be told the list settled empty —
// the picker's report object, and the projects page's list hook.
const pageListHook = (name = "usePageProjects") => `function ${name}({enabled:e}={}){`
  + "let f=query({enabled:e}),{data:p,isPending:m,error:h,dataUpdatedAt:g,refetch:_}=f,"
  + "v=loadingOf(f),S=spacesLoading(),{projects:D,isLoading:ee}=spaces({enabled:!0});"
  + "return{projects:[...p?.data??[],...D],isInitialLoading:m||S||ee,"
  + "hasMore:p?.pagination.has_more??!1,isPending:m,chatProjectsEnabled:e,"
  + "chatProjectsLoading:v,spacesLoading:S,chatProjectsError:h,"
  + "chatProjectsUpdatedAt:g,refetch:_}}";
const pageListDecoy = "function other(){return{projects:[],isPending:m,loading:v}}";
const pageListChunk = `${pageListHook()}${pageListDecoy}`;
assert.equal(inspectRenderer(`${webShellFixtures}\n${pageListChunk}`, false, false).patches
  .filter(patch => patch.id === "web-projects-remote-list").length, 0,
  "the page's list hook is left alone outside web-shell mode");
const pageListPatches = inspectRenderer(`${webShellFixtures}\n${pageListChunk}`, false, true)
  .patches.filter(patch => patch.id === "web-projects-remote-list");
assert.deepEqual(pageListPatches.map(patch => patch.original), ["m||S||ee", "m", "v"],
  "the page's loading terms must be forced, and its project list left alone");
assert.ok(pageListPatches.every(patch => patch.replacement === "!1"));
assert.equal(inspectRenderer(`${webShellFixtures}\n${pageListChunk}${pageListHook("two")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-remote-list").length, 0,
  "two list hooks must refuse the splice rather than force one of two");
const pageListOut = patchRendererSources(new Map([["page.js",
  `${webShellFixtures}\n${accountMenuName}\n${pageListChunk}`]]), false, true)
  .sources.get("page.js");
assert.ok(pageListOut.includes("isInitialLoading:!1,hasMore:p?.pagination.has_more??!1,"
  + "isPending:!1,chatProjectsEnabled:e,chatProjectsLoading:!1,spacesLoading:S,"
  + "chatProjectsError:h"),
  "the page must report a settled, empty list and keep everything else");
assert.ok(pageListOut.includes("function other(){return{projects:[],isPending:m,loading:v}}"),
  "an object with only some of the keys must not be mistaken for the hook's report");
const pageListCompiled = await minify(pageListChunk, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(`${webShellFixtures}\n${pageListCompiled.code}`, false, true)
  .patches.filter(patch => patch.id === "web-projects-remote-list").length, 3,
  "a mangled page hook must still be forced three times");
// The sidebar's Projects entry. Both builds filter their nav items through one
// negated `||` chain, and both clauses about the entry itself are false on
// claude.ai while being true here: one is Desktop-only (built on
// `globalThis.desktopBootFeatures`, which a browser page never has) and the
// other reads a value the Desktop build compiles to a constant. The patch drops
// every operand that tests `id === "projects"` from that chain, keeping the mode
// and eligibility filters.
const navChain = (clauses = ['n.id==="projects"&&!a&&!o', 'n.id==="projects"&&t==="chat"&&!supported']) =>
  'function navItems(){return items.filter(n=>{let r=F&&n.id==="scheduled";'
  + 'return!(n.modes!==void 0&&!n.modes.includes(t)&&!r||!eligible(n,e)'
  + `||${clauses.join("||")})}).map(r=>r.href)}`;
assert.equal(inspectRenderer(navChain(), false, false).patches
  .filter(patch => patch.id === "web-projects-sidebar-entry").length, 0,
  "the nav clauses are left alone outside web-shell mode");
const navPatches = inspectRenderer(navChain(), false, true).patches
  .filter(patch => patch.id === "web-projects-sidebar-entry");
assert.equal(navPatches.length, 1, "the clauses must be removed exactly once");
assert.equal(navPatches[0].replacement,
  "!(n.modes!==void 0&&!n.modes.includes(t)&&!r||!eligible(n,e))",
  "every projects operand must go, and the mode and eligibility filters must stay");
assert.ok(!navPatches[0].replacement.includes("projects"),
  "no clause naming the entry may survive the splice");
// A chain carrying only one of the two project clauses is still the same filter,
// and a chain that never mentions the surface is a different one.
for (const [label, clauses] of [
  ["only the shared clause", ['n.id==="projects"&&!a&&!o']],
  ["only the surface clause", ['n.id==="projects"&&t==="chat"&&!supported']],
]) {
  const sole = inspectRenderer(navChain(clauses), false, true).patches
    .filter(patch => patch.id === "web-projects-sidebar-entry");
  assert.equal(sole.length, 1, `${label} alone must still be dropped`);
  assert.ok(!sole[0].replacement.includes("projects"), `${label} must not survive`);
}
assert.equal(inspectRenderer(navChain(['n.modes.includes(t)&&t==="chat"']), false, true).patches
  .filter(patch => patch.id === "web-projects-sidebar-entry").length, 0,
  "a chain that never names the projects entry must survive untouched");
assert.equal(inspectRenderer(`${navChain()}\n${navChain().replace("navItems", "navItemsB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-sidebar-entry").length, 0,
  "two filters of the same shape must refuse rather than splice one of two");
const navOut = patchRendererSources(
  new Map([["nav.js", `${webShellFixtures}\n${accountMenuName}\n${navChain()}`]]), false, true)
  .sources.get("nav.js");
assert.ok(navOut.includes('if(n.gate!==void 0&&!l.has(n.gate))return!1;')
  || navOut.includes("!eligible(n,e)"),
  "the rest of the filter must survive untouched");
assert.ok(!navOut.includes('n.id==="projects"'),
  "no projects operand may survive the splice");
const navCompiled = await minify(navChain(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(navCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-sidebar-entry").length, 1,
  "a mangled nav filter must still have its projects operands dropped");
// The composer's project slot. One function answers with the four mode literals,
// and its inputs only short-circuit to "disabled" on this shell: the pending
// first send it reads is null until a send is being prepared, so on a New page
// nothing renders. The returned expression is forced to the deployed answer,
// leaving the declarators above it — the flag reads and surface hook calls —
// exactly where they are.
const composerSlot = (inner = 'm?h?"disabled":t&&p?"pending":s&&!f?"projects":"enabled"'
  + ':a&&t&&(!n.coworkSettled||p)?"pending":"disabled"') =>
  'function composerMode(){let e=readStore(),t=isApp(),{surfaces:n,unifiedComposerDesign:r}=ctx(),'
  + 'a=e!==null&&r,o=allowed(),s=t&&n.settled,f=hub(),p=!f&&e?.gatePending===!0,m=a&&(!t||f||s),'
  + `h=gate(m);return ${inner}}`;
assert.equal(inspectRenderer(composerSlot(), false, false).patches
  .filter(patch => patch.id === "web-projects-composer-slot").length, 0,
  "the composer's answer is left alone outside web-shell mode");
const slotPatches = inspectRenderer(composerSlot(), false, true).patches
  .filter(patch => patch.id === "web-projects-composer-slot");
assert.equal(slotPatches.length, 1, "the answer must be forced exactly once");
assert.equal(slotPatches[0].replacement, '"enabled"',
  "the answer is forced to the arm that renders a slot");
assert.ok(slotPatches[0].original.includes('"projects"') && slotPatches[0].original.includes('"disabled"'),
  "only the returned conditional is spliced");
// A three-literal conditional, or a function whose conditional is not what it
// returns, is a different shape.
assert.equal(inspectRenderer(composerSlot('m?"disabled":"enabled"'), false, true).patches
  .filter(patch => patch.id === "web-projects-composer-slot").length, 0,
  "a conditional missing a mode literal must survive");
assert.equal(inspectRenderer(`${composerSlot()}\n${composerSlot().replace("composerMode", "composerModeB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-composer-slot").length, 0,
  "two answers in one chunk must refuse rather than splice one of two");
const slotOut = patchRendererSources(
  new Map([["composer.js", `${webShellFixtures}\n${accountMenuName}\n${composerSlot()}`]]), false, true)
  .sources.get("composer.js");
assert.ok(slotOut.includes('h=gate(m);return "enabled"}'),
  "the declarators must survive and only the answer change");
assert.ok(!slotOut.includes('"projects"'),
  "no mode literal may survive the splice");
const slotCompiled = await minify(composerSlot(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(slotCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-composer-slot").length, 1,
  "a mangled composer answer must still be forced once");
// The chin chooser. The unified composer picks its chin in one block: an empty
// one when collapsed, then the branch that draws the project chip — which needs
// the pending-first-send store and a surface value a browser page never reaches
// — then a fallback. That branch is forced on, keeping its own `kind` comparison
// so a cowork chin is not turned into a chat one.
const chinChooser = (branch = 'n.kind==="chat"&&m!==null&&h',
  guard = 'if(e==="unified")') =>
  `function chin(){${guard}{if(F)return S(Chin,{ref:L,open:!1});`
  + `if(${branch})return S(xP,{wrapperRef:L,collapsed:R,projectLabel:c});`
  + 'if(n.kind==="chat"&&g)return S(SP,{wrapperRef:L,collapsed:R});'
  + 'let e=n.kind==="cowork"?S(Foo,{}):h&&n.kind==="chat"?S(oP,{}):null;'
  + 'return S(Chin,{ref:L,open:i,leading:e})}}';
assert.equal(inspectRenderer(chinChooser(), false, false).patches
  .filter(patch => patch.id === "web-projects-composer-chin").length, 0,
  "the chin chooser is left alone outside web-shell mode");
const chinPatches = inspectRenderer(chinChooser(), false, true).patches
  .filter(patch => patch.id === "web-projects-composer-chin");
assert.equal(chinPatches.length, 1, "the chip branch must be forced exactly once");
assert.equal(chinPatches[0].original, 'n.kind==="chat"&&m!==null&&h',
  "only the branch that reads the first-send store is spliced");
assert.equal(chinPatches[0].replacement, "!0",
  "the branch must be forced open, surface kind included");
// The fallback branch does not read the store, so it is not a target, and a
// block that is not the unified chooser is out of reach entirely.
assert.equal(inspectRenderer(chinChooser('n.kind==="chat"&&g'), false, true).patches
  .filter(patch => patch.id === "web-projects-composer-chin").length, 0,
  "a branch that does not read the store must survive untouched");
assert.equal(inspectRenderer(chinChooser(undefined, 'if(e==="below")'), false, true).patches
  .filter(patch => patch.id === "web-projects-composer-chin").length, 0,
  "a block that is not the unified chooser must survive untouched");
const chinOut = patchRendererSources(
  new Map([["chin.js", `${webShellFixtures}\n${accountMenuName}\n${chinChooser()}`]]), false, true)
  .sources.get("chin.js");
assert.ok(chinOut.includes("if(!0)return S(xP,"),
  "the chip branch must be forced open");
assert.ok(chinOut.includes('if(n.kind==="chat"&&g)return S(SP,'),
  "the fallback branch must survive untouched");
const chinCompiled = await minify(chinChooser(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(chinCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-composer-chin").length, 1,
  "a mangled chin chooser must still have its chip branch forced");
// The folder/project picker's capability object. Its `isClaudeApp` asks whether
// this is the Claude app — the same zero-argument platform check the session
// patches force — and the picker refuses to draw at all when it is false and no
// web picker is available. Only that one property's value is spliced; the
// binding stays, because `webPickerPending` in the same object reads it.
const pickerObject = (value = "isApp", backend = "!0") =>
  'function pickerCaps(keepMounted,traffic){let n=isApp(),r=userData(),i=remoteMode(),a=remoteEnabled(),'
  + 'o=allowed(),s=spaces(),c=a&&o,l=c&&policy(traffic,i.orgAvailable,s)&&!i.isLoading;'
  + `return{isClaudeApp:${value},userDataPending:r,coworkRemoteMode:i,remoteProjectsEnabled:a,`
  + `atriumCreate:c,webPickerEnabled:l,webPickerPending:keepMounted&&!n&&!l&&PENDING,noBackend:${backend}}}`;
assert.equal(inspectRenderer(pickerObject(), false, false).patches
  .filter(patch => patch.id === "web-projects-folder-picker").length, 0,
  "the picker caps are left alone outside web-shell mode");
const projectsPickerPatches = inspectRenderer(pickerObject(), false, true).patches
  .filter(patch => patch.id === "web-projects-folder-picker");
assert.equal(projectsPickerPatches.length, 2, "both capability flags must be forced");
assert.deepEqual(projectsPickerPatches.map(patch => patch.original).sort(), ["!0", "isApp"],
  "only the two property values are spliced");
assert.deepEqual(projectsPickerPatches.map(patch => patch.replacement).sort(), ["!0", "!1"],
  "the app flag goes true and the folded backend flag goes false");
// An object carrying one flag but not the picker's other capability is a
// different object, and two candidates refuse rather than splice one of two.
assert.equal(inspectRenderer('function other(){let n=isApp();return{isClaudeApp:n,noBackend:!0}}',
  false, true).patches.filter(patch => patch.id === "web-projects-folder-picker").length, 0,
  "an object without the picker's own fields must survive untouched");
assert.equal(inspectRenderer(`${pickerObject()}\n${pickerObject().replace("pickerCaps", "pickerCapsB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-folder-picker").length, 0,
  "two capability objects must refuse rather than splice one of two");
const projectsPickerOut = patchRendererSources(
  new Map([["picker.js", `${webShellFixtures}\n${accountMenuName}\n${pickerObject()}`]]), false, true)
  .sources.get("picker.js");
assert.ok(projectsPickerOut.includes("isClaudeApp:!0,userDataPending:r"),
  "the app flag must be forced in place");
assert.ok(projectsPickerOut.includes("noBackend:!1}}"),
  "the folded backend flag must be restored to the web bundle's value");
assert.ok(projectsPickerOut.includes("webPickerPending:keepMounted&&!n&&!l&&PENDING"),
  "the binding must survive for the other field that reads it");
const projectsPickerCompiled = await minify(pickerObject(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(projectsPickerCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-folder-picker").length, 2,
  "a mangled capability object must still have both flags forced");
// The project selector's own scope guard, which answers null before the picker
// above is reached. Pinned by the two prop names it destructures, which the
// minifier leaves alone, and by the null it returns.
const selectorComponent = (test = "locked&&!isApp", props = "selectionChip:r=!1,plainTrigger:i=!1") =>
  `var selector=memo(function({isCollapsed:e=!1,${props},projectsOnly:a=!1}){`
  + 'let c=scopeLocked(),m=isApp();return ' + test + '?null:S(Picker,{projectLocked:c,plainTrigger:i})})';
assert.equal(inspectRenderer(selectorComponent(), false, false).patches
  .filter(patch => patch.id === "web-projects-selector-scope").length, 0,
  "the selector guard is left alone outside web-shell mode");
const selectorPatches = inspectRenderer(selectorComponent(), false, true).patches
  .filter(patch => patch.id === "web-projects-selector-scope");
assert.equal(selectorPatches.length, 1, "the scope guard must be forced exactly once");
assert.equal(selectorPatches[0].original, "locked&&!isApp");
assert.equal(selectorPatches[0].replacement, "!1", "only the guard's test is spliced");
// A component with one of the two prop names, or with no null conditional, is a
// different component and must survive.
assert.equal(inspectRenderer(selectorComponent("locked&&!isApp", "selectionChip:r=!1"), false, true)
  .patches.filter(patch => patch.id === "web-projects-selector-scope").length, 0,
  "a component with one prop name only must survive untouched");
assert.equal(inspectRenderer(selectorComponent("locked?null:S(Picker,{})", "selectionChip:r=!1,plainTrigger:i=!1"),
  false, true).patches.filter(patch => patch.id === "web-projects-selector-scope").length, 0,
  "a component whose conditional returns no null must survive untouched");
assert.equal(inspectRenderer(
  `${selectorComponent()}\n${selectorComponent().replace("var selector", "var selectorB")}`,
  false, true).patches.filter(patch => patch.id === "web-projects-selector-scope").length, 0,
  "two selectors must refuse rather than splice one of two");
const selectorOut = patchRendererSources(
  new Map([["selector.js", `${webShellFixtures}\n${accountMenuName}\n${selectorComponent()}`]]), false, true)
  .sources.get("selector.js");
assert.ok(selectorOut.includes("return !1?null:S(Picker,"),
  "the guard must be forced off in place");
const selectorCompiled = await minify(selectorComponent(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(selectorCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-selector-scope").length, 1,
  "a mangled selector must still have its guard forced");
// The slot component's first branch, which draws the same element for a project
// the composer is already bound to. Pinned as the returned conditional carrying
// two slot elements, which is what separates it from the sibling that draws one.
const boundSlot = (test = "!isApp()&&hostProjectUuid!==void 0", second = true) =>
  'function slot({pickersCollapsed:e}){let mode=readMode(),isApp=isAppFn(),hostProjectUuid=host();'
  + `return ${test}?S("div",{"data-home-project-slot":!0,className:"min-w-0 shrink-[999] empty:hidden",`
  + 'children:S(Bound,{projectUuid:hostProjectUuid})})'
  + (second
    ? ':mode==="enabled"||mode==="projects"?S("div",{"data-home-project-slot":!0,'
      + 'className:"min-w-0 shrink-[999] empty:hidden",children:S(Selector,{})}):null'
    : ":null")
  + '}';
assert.equal(inspectRenderer(boundSlot(), false, false).patches
  .filter(patch => patch.id === "web-projects-bound-slot").length, 0,
  "the bound-project branch is left alone outside web-shell mode");
const boundPatches = inspectRenderer(boundSlot(), false, true).patches
  .filter(patch => patch.id === "web-projects-bound-slot");
assert.equal(boundPatches.length, 1, "the bound-project branch must be forced off once");
assert.equal(boundPatches[0].original, "!isApp()&&hostProjectUuid!==void 0");
assert.equal(boundPatches[0].replacement, "!1", "only that branch's test is spliced");
assert.equal(inspectRenderer(boundSlot(undefined, false), false, true).patches
  .filter(patch => patch.id === "web-projects-bound-slot").length, 0,
  "a component drawing one slot element must survive untouched");
const boundOut = patchRendererSources(
  new Map([["bound.js", `${webShellFixtures}\n${accountMenuName}\n${boundSlot()}`]]), false, true)
  .sources.get("bound.js");
assert.ok(boundOut.includes('return !1?S("div",{"data-home-project-slot":!0'),
  "the branch must be forced off in place");
assert.ok(boundOut.includes('mode==="enabled"||mode==="projects"?S("div",'),
  "the selector branch must survive untouched");
const boundCompiled = await minify(boundSlot(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(boundCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-bound-slot").length, 1,
  "a mangled slot component must still have its bound branch forced off");
// The picker trigger's `showProjects`, the one term of its "is there anything to
// draw" test that is a choice rather than data or state. Pinned as the property
// inside an object literal, so the same name destructured as a pattern is out of
// reach.
const pickerSection = (value = "showProjects", pattern = "") =>
  'var Trigger=memo(function(' + (pattern ? `{showProjects:${pattern},hideFolders:i=!1}` : "e")
  + '){let d=showProjects,u=onCreate,we=d??u!==void 0;return S(Btn,{hideFolders:i})});'
  + `var Host=memo(function(e){let we=flag(),Ee=we||data();`
  + `return Ee?S(Trigger,{${value}:we,onCreateProject:u}):null});`;
assert.equal(inspectRenderer(pickerSection(), false, false).patches
  .filter(patch => patch.id === "web-projects-picker-section").length, 0,
  "the picker section flag is left alone outside web-shell mode");
const sectionPatches = inspectRenderer(pickerSection(), false, true).patches
  .filter(patch => patch.id === "web-projects-picker-section");
assert.equal(sectionPatches.length, 1, "the section flag must be forced once");
assert.equal(sectionPatches[0].original, "we", "the property's value binding is what is spliced");
assert.equal(sectionPatches[0].replacement, "!0", "only the property value is spliced");
assert.equal(inspectRenderer(pickerSection("showProjects", "showProjects"), false, true).patches
  .filter(patch => patch.id === "web-projects-picker-section").length, 1,
  "a destructured pattern of the same name must not be mistaken for the property");
const sectionOut = patchRendererSources(
  new Map([["section.js", `${webShellFixtures}\n${accountMenuName}\n${pickerSection()}`]]), false, true)
  .sources.get("section.js");
assert.ok(sectionOut.includes("S(Trigger,{showProjects:!0,onCreateProject:u})"),
  "the flag must be forced in place");
assert.ok(sectionOut.includes("return S(Btn,{hideFolders:i})"),
  "the rest of the component must survive untouched");
const sectionCompiled = await minify(pickerSection(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(sectionCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-projects-picker-section").length, 1,
  "a mangled props object must still have its section flag forced");
// The permission binding hook, which answers only while the pending-first-send
// store exists and otherwise leaves the composer's permission control drawing a
// skeleton. Pinned by the object it returns, whose `autoPickIsDraftOnly` name
// appears nowhere else in the graph.
const permissionBinding = (test = "store()!==null&&flags?.arms===!0", marker = true) =>
  'function permissionBinding(){let e=pendingFirstSend(),t=e?.newChatAutoArms;'
  + 'return useMemo(()=>{' + `if(${test})return arms(model)?{permissionMode:"auto",`
  + 'setPermissionMode:set,autoPickIsDraftOnly:!0,modelRequiresAuto:!0}'
  + (marker ? ':{permissionMode:mode(),setPermissionMode:set,autoPickIsDraftOnly:!0,modelRequiresAuto:!1}'
    : ':void 0')
  + '},[e,t])}';
assert.equal(inspectRenderer(permissionBinding(), false, false).patches
  .filter(patch => patch.id === "web-permission-binding").length, 0,
  "the permission binding is left alone outside web-shell mode");
const bindingPatches = inspectRenderer(permissionBinding(), false, true).patches
  .filter(patch => patch.id === "web-permission-binding");
assert.equal(bindingPatches.length, 1, "the binding guard must be forced once");
assert.equal(bindingPatches[0].original, "store()!==null&&flags?.arms===!0");
assert.equal(bindingPatches[0].replacement, "!0", "only the guard's test is spliced");
assert.equal(inspectRenderer(permissionBinding().replaceAll("autoPickIsDraftOnly:!0", "draftOnly:!0"),
  false, true).patches.filter(patch => patch.id === "web-permission-binding").length, 0,
  "a guard whose body carries no draft-only marker must survive untouched");
const bindingOut = patchRendererSources(
  new Map([["binding.js", `${webShellFixtures}\n${accountMenuName}\n${permissionBinding()}`]]), false, true)
  .sources.get("binding.js");
assert.ok(bindingOut.includes('useMemo(()=>{if(!0)return arms(model)?'),
  "the guard must be forced open in place");
assert.ok(bindingOut.includes("},[e,t])"),
  "the hook's dependencies must survive untouched");
const bindingCompiled = await minify(permissionBinding(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(bindingCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-permission-binding").length, 1,
  "a mangled binding hook must still have its guard forced");
// The composer's picker asks for its mode list with `excludeBypass: true`, which
// drops the "Skip all approvals" row the deployment deliberately offers.
const bypassRow = (props = 'excludeBypass:!0,sessionBinding:t') =>
  `function Pickers({collapsed:e,binding:t}){return S(ModePicker,{variant:"session",placement:"chin",`
  + `${props},triggerSize:"inherit"})}`;
assert.equal(inspectRenderer(bypassRow(), false, false).patches
  .filter(patch => patch.id === "web-permission-bypass-row").length, 0,
  "the bypass flag is left alone outside web-shell mode");
const bypassPatches = inspectRenderer(bypassRow(), false, true).patches
  .filter(patch => patch.id === "web-permission-bypass-row");
assert.equal(bypassPatches.length, 1, "the bypass flag must be cleared once");
assert.equal(bypassPatches[0].original, "!0");
assert.equal(bypassPatches[0].replacement, "!1", "only that property's value is spliced");
// A picker that excludes bypass without a session binding is a different call
// site and must survive.
assert.equal(inspectRenderer(bypassRow("excludeBypass:!0,other:t"), false, true).patches
  .filter(patch => patch.id === "web-permission-bypass-row").length, 0,
  "a call site without a session binding must survive untouched");
const bypassOut = patchRendererSources(
  new Map([["bypass.js", `${webShellFixtures}\n${accountMenuName}\n${bypassRow()}`]]), false, true)
  .sources.get("bypass.js");
assert.ok(bypassOut.includes("excludeBypass:!1,sessionBinding:t"),
  "the bypass row must be restored in place");
const bypassCompiled = await minify(bypassRow(), {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(bypassCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-permission-bypass-row").length, 1,
  "a mangled picker call must still have its bypass flag cleared");
// The draft's two permission-mode mappers. The New page's picker writes the
// *pending draft's* mode, and that pair knows only `auto` and the default — so a
// click on Skip all approvals is dropped by the writer and, even if stored, read
// back as the default. Both are widened; widening one alone does nothing.
// The chunk prefilter is a string test, so the fixture must carry a token the
// patcher looks for — the composer feature name stands in for one.
const draftMappers = () =>
  'var marlinFlag="voyage_composer_marlin",aM="auto",oM="acceptEdits";function defaultMode(){return manual}'
  + 'function toWire(e){if(e==="auto")return aM;if(e===defaultMode())return oM}'
  + 'function fromWire(e){if(e==="auto")return"auto";if(e==="acceptEdits")return defaultMode()}'
  + 'function unrelated(e){if(e==="auto")return aM}';
assert.equal(inspectRenderer(draftMappers(), false, false).patches
  .filter(patch => patch.id === "web-draft-bypass-mode").length, 0,
  "the draft mappers are left alone outside web-shell mode");
const mapperPatches = inspectRenderer(draftMappers(), false, true).patches
  .filter(patch => patch.id === "web-draft-bypass-mode");
assert.equal(mapperPatches.length, 2, "both mappers must be widened");
assert.deepEqual(mapperPatches.map(patch => patch.replacement).sort(), [
  '{if(e==="auto")return"auto";if(e==="acceptEdits")return defaultMode();'
    + 'if(e==="bypassPermissions")return "bypassPermissions";}',
  '{if(e==="auto")return aM;if(e===defaultMode())return oM;'
    + 'if(e==="bypassPermissions")return "bypassPermissions";}',
].sort(), "each mapper keeps its body and gains the bypass wire value");
// A function that opens on "auto" but has only one branch, or a second branch
// that is neither a call nor the expected literal, is not a mapper.
assert.equal(inspectRenderer('var marlinFlag="voyage_composer_marlin";function half(e){if(e==="auto")return aM}', false, true).patches
  .filter(patch => patch.id === "web-draft-bypass-mode").length, 0,
  "a one-branch function must survive untouched");
assert.equal(inspectRenderer('var marlinFlag="voyage_composer_marlin";function other(e){if(e==="auto")return aM;if(e==="plan")return pM}',
  false, true).patches.filter(patch => patch.id === "web-draft-bypass-mode").length, 0,
  "a function whose second mode is neither must survive untouched");
const mapperOut = patchRendererSources(
  new Map([["draft.js", `${webShellFixtures}\n${accountMenuName}\n${draftMappers()}`]]), false, true)
  .sources.get("draft.js");
assert.ok(mapperOut.includes('if(e===defaultMode())return oM;if(e==="bypassPermissions")return "bypassPermissions";'),
  "the writer must keep its body and gain the value");
assert.ok(mapperOut.includes('if(e==="acceptEdits")return defaultMode();if(e==="bypassPermissions")return "bypassPermissions";'),
  "the reader must keep its body and gain the value");
assert.ok(mapperOut.includes("function unrelated(e){if(e===\"auto\")return aM}"),
  "an unrelated function must survive untouched");
// Names mangled, structure kept: that is what the selector pins, and what the
// real bundle's mappers are. Compression is off here because folding these two
// one-liners into a conditional is a reshape the real build does not do, and a
// fixture that does it is testing the fixture rather than the patch.
const mapperCompiled = await minify(draftMappers(), {
  mangle: true, compress: false, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(mapperCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-draft-bypass-mode").length, 2,
  "mangled mappers must still be widened");
// The main process bundles the same schema and runs the Gateway connection test
// and model discovery there, so the renderer splice alone leaves the process
// that dials the endpoint still refusing it. patchEmbeddedSources applies only
// the Gateway URL splice to an already-extracted app archive, where the
// renderer's required patches do not exist and must not be demanded.
const embedded = patchEmbeddedSources(new Map([["main.js", gatewayUrlSchema]]));
assert.equal(embedded.patches.length, 1, "the main bundle's copy must be spliced");
assert.ok(embedded.sources.get("main.js").includes("!!options.allowLoopbackHttp&&!0)"));
assert.equal(patchEmbeddedSources(new Map([["main.js", gatewayUrlDecoy]])).patches.length, 0,
  "a main bundle without that copy is left alone, not refused");
const bothEntries = patchEmbeddedSources(new Map([
  ["index.pre.js", gatewayUrlSchema], ["index.chunk.js", gatewayUrlSchema]]));
assert.equal(bothEntries.patches.length, 2,
  "an archive that builds the schema into two entries splices both");
assert.ok([...bothEntries.sources.values()].every(text => text.includes("&&!0)")));
const embeddedCompiled = await minify(gatewayUrlSchema, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(patchEmbeddedSources(new Map([["main.js", embeddedCompiled.code]])).patches.length, 1,
  "a re-minified main bundle must still be spliced");
// The root's caught-error option. React 19 creates the root with
// `{onCaughtError, onRecoverableError}` and the bundle hands `onCaughtError` the
// app's own reporter, which does not log — so a boundary-caught render error
// reaches neither the console nor the network, and the crash page's error code
// is a hash of the message. In web-shell mode the option's value is wrapped to
// log the error and React's error info before delegating to the app's handler.
const crashLogRoot = 'function boot(){start("render_start");'
  + 'createRoot(el,{onCaughtError:reportCrash,onRecoverableError:reportRecoverable}).render(app)}';
// A like-named member *read* elsewhere is not the option: React only ever reads
// `options.onCaughtError`. Nor is a root option without the sibling, and a
// second root in the same chunk refuses rather than splicing one of two.
const crashLogDecoy = 'function readOptions(o){if(o.onCaughtError!==void 0)'
  + 'return o.onCaughtError(e,i);return null;'
  + 'createRoot(el,{onCaughtError:loneHandler}).render(other)}';
const crashLogTwin = crashLogRoot.replace("boot", "bootAgain").replace("reportCrash", "reportCrashB");
assert.equal(inspectRenderer(crashLogRoot, false, false).patches.length, 0,
  "the caught-error option is left alone outside web-shell mode");
assert.equal(inspectRenderer(crashLogDecoy, false, true).patches
  .filter(patch => patch.id === "web-crash-log").length, 0,
  "a member read and a lone option are not the root's caught-error pair");
assert.equal(inspectRenderer(`${crashLogRoot}\n${crashLogTwin}`, false, true).patches
  .filter(patch => patch.id === "web-crash-log").length, 0,
  "a second root option must refuse rather than splice one of two");
const crashLogOut = patchRendererSources(
  new Map([["entry.js", `${webShellFixtures}\n${accountMenuName}\n${crashLogRoot}`]]), false, true)
  .sources.get("entry.js");
assert.ok(crashLogOut.includes('console.error("[claudesk] render error",...__claudeskCaught)'),
  "the handler must log the error in web-shell mode");
assert.ok(crashLogOut.includes("return (reportCrash)(...__claudeskCaught)"),
  "the app's own handler must still run after the log");
const crashLogCompiled = await minify(crashLogRoot, {
  mangle: true, compress: { unused: false }, format: { quote_style: 1 },
});
assert.equal(inspectRenderer(crashLogCompiled.code, false, true).patches
  .filter(patch => patch.id === "web-crash-log").length, 1,
  "a mangled root option must still be wrapped exactly once");
// The self-hosted Code start options a tenant's web shell adds. The three
// place-kind switches decide whether a place is folder-bearing, worktree-capable
// and draft-owning; the branch hook reads git state only for `local`; the intent
// builder drops the folder/branch/worktree of a `byoc`/`pool` place; and the
// create serializer + wire mapper carry them to the runner. Each splice is a
// tenant-and-web-shell patch, so nothing changes for the Desktop shell, the
// operator's own web shell, or a tenant without the web shell.
const placeKindSwitch = name => `function ${name}(e){switch(e){case"local":case"ssh":case"wsl":`
  + 'return!0;case"bridge":case"anthropic_cloud":case"byoc":case"pool":case"project":return!1}}';
const selfHostedPlaceKinds = placeKindSwitch("placeKindA") + placeKindSwitch("placeKindB")
  + placeKindSwitch("placeKindC")
  + 'function placeKindDecoy(e){switch(e){case"local":return!0;case"byoc":return!1}}'
  + 'function needsFolder(env, flag){return placeKindA(env)&&!flag}'
  + 'function needsFolderDecoy(env, flag){return otherKind(env)&&!flag}';
const selfHostedBranchHook = 'function branchHook({envType:e,needsFolder:t,selectedFolder:n}){'
  + 'let p="local",m=t&&p?n:null,h=e==="local"?m:null;'
  + 'return{worktree:!1,setWorktree:noop,worktreeSupported:!1,isGitRepo:!0,'
  + 'isGitRepoSettled:!0,useWorktree:!1,displayBranch:"main",headBranch:"main",'
  + 'defaultBranch:"main",branches:[],branchPickerDisabled:!1,sourceBranch:"main",'
  + 'handleSelectSourceBranch:noop}}';
const selfHostedIntent = 'function startIntent({envType:r,selectedFolder:c,useWorktree:I,'
  + 'displayBranch:ne,sourceBranch:re}){switch(r){case"local":case"ssh":case"wsl":'
  + 'return{kind:"local"};case"bridge":return{kind:"bridge"};'
  + 'case"byoc":return{kind:"cloud",environmentId:"e"};'
  + 'case"anthropic_cloud":return{kind:"cloud",environmentId:"e"};'
  + 'case"pool":return{kind:"pool",poolId:"p"};case"project":return null}}';
const selfHostedCreate = 'async function createBody({title:e,gitRepoUrls:s,sourceBranch:c,worker:f}){'
  + 'return{title:e,events:[],...f.type==="environment"?{environment_id:f.id}'
  + ':{self_hosted_runner_pool_id:f.id},session_context:{sources:[],outcomes:[]}}}';
const selfHostedWire = 'function wireBody(e){let t=e.session_context;return{title:e.title,'
  + 'config:{sources:t.sources,outcomes:t.outcomes,cwd:t.cwd,model:t.model}}}';
const selfHostedFolderPicker = 'function pickFolder(title, initialPath){'
  + 'let browse=fileSystem?.browseFolder;if(browse)return run(()=>browse(title,void 0,void 0,initialPath))}';
const selfHostedStrip = 'function composer({envType:e}){'
  + 'let needsFolder=draftNeedsFolder,rail=isRail,localKind=isLocal;'
  + 'return needsFolder&&!(rail&&(localKind||e==="ssh"))&&render(Strip,'
  + '{onWorktreeChange:onWorktreeChange,worktreeSupported:worktreeSupported,'
  + 'onSelectBranch:onSelectBranch})}';
const selfHostedFixtures = [selfHostedPlaceKinds, selfHostedBranchHook, selfHostedIntent,
  selfHostedCreate, selfHostedWire, selfHostedFolderPicker, selfHostedStrip].join("\n");
const selfHostedIds = ["web-code-selfhosted-place-kind", "web-code-selfhosted-needs-folder",
  "web-code-selfhosted-branch-read", "web-code-selfhosted-intent",
  "web-code-selfhosted-create", "web-code-selfhosted-folder-picker",
  "web-code-selfhosted-strip"];
assert.equal(inspectRenderer(selfHostedFixtures, false, true).patches
  .filter(patch => selfHostedIds.includes(patch.id)).length, 0,
  "the self-hosted start options are a tenant patch, not a web-shell one");
assert.equal(inspectRenderer(selfHostedFixtures, false, false, true).patches
  .filter(patch => selfHostedIds.includes(patch.id)).length, 0,
  "the self-hosted start options require the web shell");
const tenantStartOptions = inspectRenderer(selfHostedFixtures, false, true, true);
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-place-kind").length, 3,
  "all three place-kind switches must be rewritten, and the lookalike left alone");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-needs-folder").length, 1,
  "the folder-kind flag must stop gating self-hosted places on this-device policy");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-branch-read").length, 1,
  "the branch hook's local-only read must be widened exactly once");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-intent").length, 3,
  "all three self-hosted intent arms must carry the start options");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-create").length, 3,
  "the create serializer binds and spreads the options and the wire mapper forwards them");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-folder-picker").length, 1,
  "the Code folder picker must prefer the VM-backed browse method");
assert.equal(tenantStartOptions.patches
  .filter(patch => patch.id === "web-code-selfhosted-strip").length, 1,
  "the strip's own mount gate must be widened at the mount site");
const selfHostedOut = patchRendererSources(
  new Map([["tenant.js", `${webShellFixtures}\n${accountMenuName}\n${selfHostedFixtures}`]]),
  false, true, true).sources.get("tenant.js");
assert.ok(selfHostedOut.includes('case"wsl":case"anthropic_cloud":case"byoc":case"pool":return!0;'
  + 'case"bridge":case"project":return!1'),
  "self-hosted places must join the folder/worktree-capable arm");
assert.ok(selfHostedOut.includes('needsFolder(env, flag){return placeKindA(env)'
  + '&&(!flag||env==="anthropic_cloud"||env==="byoc"||env==="pool")}'),
  "self-hosted places must need a folder regardless of the this-device flag");
assert.ok(selfHostedOut.includes('h=(e==="local"||e==="anthropic_cloud"||e==="byoc"||e==="pool")?m:null'),
  "branch state must be read for a self-hosted place's folder");
assert.ok(selfHostedOut.includes('...(c&&{cwd:c}),...(c&&I&&{useWorktree:!0}),'
  + '...(c&&(I?ne:re)&&{sourceBranch:I?ne:re})'),
  "the intent must carry the folder, worktree flag and source branch");
assert.ok(selfHostedOut.includes('cwd:__claudeskCwd,useWorktree:__claudeskWorktree'),
  "the create serializer must bind the two new values");
assert.ok(selfHostedOut.includes('...(__claudeskCwd&&{cwd:__claudeskCwd}),'
  + '...(c&&{source_branch:c}),...(__claudeskWorktree&&{use_worktree:!0})'),
  "the create body's session context must carry all three options");
assert.ok(selfHostedOut.includes('...(t.source_branch&&{source_branch:t.source_branch}),'
  + '...(t.use_worktree&&{use_worktree:t.use_worktree})'),
  "the wire config must forward the branch and worktree flag");
assert.ok(selfHostedOut.includes('(fileSystem?.browseCodeFolder??fileSystem?.browseFolder)'),
  "the Code folder picker must prefer the guest-backed browse method");
assert.ok(selfHostedOut.includes('return ((needsFolder||e==="anthropic_cloud"||e==="byoc"'
  + '||e==="pool")&&(globalThis.__CLAUDESK_STRIP_MOUNTED__=!0))&&render(Strip,'),
  "self-hosted places must mount the strip, and no other composer must");

console.log("renderer-patches-smoke: syntax variations, behavior and unrelated-code preservation passed");
