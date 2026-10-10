import { parse } from "acorn";

// Keep selectors tied to non-mangled properties and behavior, not names of
// chunks, locals, React imports, or textual formatting. Only splice the selected
// expression: regenerating a whole bundle would disturb its module graph.
export const markerIds = ["cowork-native-rewind", "code-native-rewind-v2",
  "ime-keycode-229", "native-message-edit"];
// The file pane's own download writes the reader's UTF-8 contents, which is
// lossy for binary; a header button streams the raw file from the bridge's
// download route instead. The pane header passes paneName "Files" to its
// settings menu, so this is the file pane's trailing actions fragment.
const downloadPatchId = "file-pane-download";
// The first-party provider card ("You're using …" / "Inference configuration")
// advertises the provider switch on the chat and code home surfaces. A Gateway
// deployment fixes the provider, so the card is only noise there. Two i18n
// message ids — content hashes of that copy — pin the component that renders it
// and appear nowhere else in the renderer graph; its body is replaced with an
// unconditional null. The ids are matched only as parsed literals, so a comment
// or string that merely spells them cannot establish the target. This patch is
// required like the download button: a bundle that no longer matches must fail
// candidate preparation rather than silently let the card return.
const inferenceBannerPatchId = "inference-banner";
const inferenceBannerMessageIds = ["+8XhcAcHfK", "1qPkTh9fMa"];
// The native file preview draws into an Electron view over Desktop's own window,
// which the browser never composites, so an Office or PDF file showed a blank
// pane. This patch swaps the preview component's rendered children for an
// <iframe> at the bridge's own preview route (`/api/remote/files/preview`), which
// serves the file as a PDF — Office converted by the office-preview sidecar, PDF
// passed through. It fires only for those extensions; every other file keeps the
// component's original output. The component is pinned by the one className its
// container renders, which appears nowhere else in the renderer graph.
const filePreviewPatchId = "native-file-preview-bridge";
const filePreviewStaticClassName = "h-full w-full relative overflow-hidden";
// A browser-identified renderer resolves its internal code route to claude.ai's
// cloud Code — which the org reports admin-disabled, so every Code route lands on
// `/code/disabled` — while the Desktop identity resolves the same route to the
// local Code surface this bridge drives over the Desktop IPC. The web shell drops
// the Desktop user-agent token on purpose (to get the browser chrome), and that
// same predicate also flips this alias. This patch forces the resolver's desktop
// branch so the local Code stays reachable. Spliced only in web-shell mode: on a
// desktop-identified client the flag is already true, so there it does nothing.
const routeAliasPatchId = "desktop-code-route-alias";
// The chat/cowork session layout refuses to open a *local* session unless the
// client identifies as the Desktop app: when its user-agent check is false it
// redirects away (reason "not_desktop_app") and renders a download upsell in the
// session's place. The web shell drops the Desktop user-agent token on purpose to
// get the browser chrome, so the check is false and every session bounced back to
// the home composer. This patch forces that check — the identifier read back from
// the `if(!x){…"not_desktop_app"…}` guard itself, so it survives renaming — to
// true, which is exactly how the layout already behaves on a desktop-identified
// client. Spliced only in web-shell mode.
const sessionViewerPatchId = "desktop-session-viewer-gate";
const sessionViewerReason = "not_desktop_app";
// The web shell's bottom-left account chip leads with an avatar slot, but in this
// build that component still fetches the account profile and then renders the
// deployment mark, discarding the photo it just read: with a configured
// avatar_image_url the chip never sets an image source, so no request is made and
// the Claude mark stays. This patch makes the slot an account avatar when a photo
// is present — the account Avatar component and its element factory are read back
// from the sibling component that builds the same avatar with `src` (the one the
// user-menu header uses), and the mark remains the no-photo fallback. Spliced
// only in web-shell mode, like the other chrome patches.
const accountChipPatchId = "web-account-chip-avatar";
// The account view hook that feeds that slot (and the user-menu header's avatar)
// takes its photo from the account-profile query alone, while the bootstrap
// account document the same hook already destructures for the name carries the
// very same `avatar_image_url` (the bridge puts it there when it applies the
// operator identity). The profile read is a separate bridge round trip that only
// starts after the bootstrap lands, so the chip painted the deployment mark for
// as long as that read took and only then began the image request. This patch
// makes `photoUrl` fall back to the in-hand account value, so the avatar paints
// on the hook's first non-empty frame and the image download runs alongside the
// profile read; the profile value still wins once it arrives. Spliced only in
// web-shell mode, like the other chrome patches.
const accountPhotoPatchId = "web-account-photo-first-frame";
// Cowork tool permissions — the AskUserQuestion and tool-approval cards — are
// fed by the app's pending-permission store, and the only thing that wires that
// store (subscribes to the session event stream and hydrates from
// `getAll().pendingToolPermissions`) is a hook called inside the Desktop app's
// root. The app tree mounts the Desktop-only side-effect hosts — account sync,
// the permission wiring, the Cowork ask pump — through one slot component that
// renders them only when the client identifies as the Desktop app and null
// otherwise. The web shell drops the Desktop user-agent token on purpose (to get
// the browser chrome), so the store is never wired there: the transcript still
// streams ("Asking a question…"), but no question or approval card ever appears
// and the session waits forever. This patch calls the wiring hook from the slot
// component itself — unconditionally, before the identity gate — so the store
// subscribes and hydrates in either shell. The hook is ref-counted and its
// requests are keyed by request id, so the Desktop root's own call (and the
// duplicate events it already receives) are unaffected. The hook's call is read
// back from the Desktop root's body as the first element of the comma sequence
// that also carries the locale-change effect; both the hook and the API binding
// are read back, so a renamed minifier output still matches. Spliced only in
// web-shell mode.
const coworkPermissionWiringPatchId = "web-cowork-permission-wiring";
// The web shell's "enable notifications" actions — the chat card and the
// settings panel's rows — grant the browser permission and then register with
// claude.ai's Firebase Cloud Messaging project, persisting a server-side push
// preference on the way. Neither half can work against this deployment: there
// is no claude.ai backend to hold the preference, and the Firebase registration
// has no project to land in, so the action always failed and the toggles never
// stuck. This bridge delivers notifications itself (the wrapper relays the
// Desktop main process's notifications, the preload shows them and registers a
// Web Push subscription — see bridge/notifications.mjs). The patch gives the
// renderer's enable function a bridge-first branch: when the remote preload's
// `DesktopNotifications` surface exists, asking it for the browser permission
// is the whole operation and the preference write that follows now succeeds
// against the bridge's local document. The function is matched by the exact
// analytics key it tracks, the `browser_or_permissions` result it returns, and
// the `Notification.requestPermission` call it guards, so an unrelated function
// cannot match. Spliced only in web-shell mode, like the other chrome patches.
const notificationEnablePatchId = "web-notifications-enable-bridge";
const notificationPermissionEventKey = "claudeai.notification.permission.result";
const notificationPermissionDeniedSource = "browser_or_permissions";
const notificationEnableBranch = "{const __claudeskNotifications="
  + "globalThis[\"claude.web\"]?.DesktopNotifications;"
  + "if(__claudeskNotifications?.requestAuthorization){"
  + "const __claudeskRequest=arguments[0]||{};"
  + "let __claudeskResult=\"error\";"
  + "try{__claudeskResult=await __claudeskNotifications.requestAuthorization()}catch{}"
  + "const __claudeskPermission=__claudeskResult===\"denied\"?\"denied\":"
  + "__claudeskResult===\"granted\"?\"granted\":\"default\";"
  + "try{__claudeskRequest.track&&__claudeskRequest.track("
  + "{event_key:\"claudeai.notification.permission.result\",permission:__claudeskPermission})}catch{}"
  + "if(__claudeskResult===\"granted\")return{success:!0,permission:\"granted\"};"
  + "return{success:!1,errorSource:\"browser_or_permissions\",permission:__claudeskPermission}}}";
// The account popover's identity line. The popover's content mounts when the
// menu opens, and its title is read from Desktop's interactiveAuthStore through
// a hook that paints a loading state first and only fills from an async
// getState() — in the web shell a POST to the bridge and on to Desktop IPC, so
// the first painted frame showed the deployment label (the hook's fallback
// branch) and flipped to the account name a frame later. The preload already
// seeds the same store synchronously at page load (initialStores ->
// makeStore.getStateSync; see initialRemoteStores in bridge/server.mjs), so the
// splice reads that seeded snapshot while the async value is still missing. The
// reader is pinned by its whole shape — a function whose body is a single return
// of a zero-argument call's `principalDisplayName` — and that property name
// appears nowhere else in the renderer graph. Spliced only in web-shell mode,
// like the other chrome patches.
const accountMenuNamePatchId = "web-account-menu-name";
const accountNameSyncFallback = 'globalThis["claude.web"]?.LocalAgentModeSessions'
  + '?.interactiveAuthStore?.getStateSync?.()?.principalDisplayName';
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const unwrap = node => node?.type === "ChainExpression" ? unwrap(node.expression) : node;
function property(node, name) {
  node = unwrap(node);
  return node?.type === "MemberExpression"
    && (node.computed ? node.property.type === "Literal" && node.property.value === name
      : node.property.type === "Identifier" && node.property.name === name);
}
function protocol(node) {
  node = unwrap(node);
  return property(node, "protocol") && property(node.object, "location")
    && unwrap(node.object.object)?.type === "Identifier" && node.object.object.name === "window";
}
function literal(node, value) { return node?.type === "Literal" && node.value === value; }
function identifier(node) { node = unwrap(node); return node?.type === "Identifier" ? node.name : undefined; }
function key(node, name) {
  return node?.type === "Property" && (node.key.name === name || node.key.value === name);
}
function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, next, visit);
    else if (value && typeof value === "object") walk(value, next, visit);
  }
}
function contains(node, predicate) {
  let found = false;
  walk(node, [], child => { if (predicate(child)) found = true; });
  return found;
}
function redirectsToNew(node) {
  return contains(node, child => child.type === "CallExpression"
    && property(child.callee, "replace") && literal(child.arguments[0], "/new"));
}
function checksWindow(node) {
  return contains(node, child => child.type === "UnaryExpression" && child.operator === "typeof"
    && child.argument.type === "Identifier" && child.argument.name === "window");
}
function checksFileKind(node) {
  return contains(node, child => child.type === "BinaryExpression"
    && ["==", "==="].includes(child.operator)
    && (literal(child.left, "file") || literal(child.right, "file")));
}
// The route-alias resolver guards each rule with
// `!(X.when==="desktop"&&!Y)`, where Y is the `isDesktop` flag it was called
// with. Read that identifier back from the same graph so the splice names
// whatever the minifier chose; only a function carrying that exact rule matches,
// so a stray `when` comparison cannot establish the target.
function desktopRouteFlagName(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return undefined;
  let name;
  walk(node.body, [], child => {
    if (name || child.type !== "LogicalExpression" || child.operator !== "&&") return;
    const left = unwrap(child.left);
    if (left?.type !== "BinaryExpression" || left.operator !== "===") return;
    if (!property(left.left, "when") || !literal(left.right, "desktop")) return;
    const right = unwrap(child.right);
    if (right?.type !== "UnaryExpression" || right.operator !== "!") return;
    const flag = identifier(right.argument);
    if (flag) name = flag;
  });
  return name;
}
// The push-enablement function (`kK` in the shared chunk) is the one async
// declaration that guards `Notification.requestPermission()`, tracks the
// permission result under its own analytics key, and answers failures with
// `browser_or_permissions`. All three must sit inside the same function body, so
// a helper that merely spells one of the literals cannot establish the target.
// It must be a (non-arrow) declaration: the spliced branch reads the request
// object back from `arguments[0]` instead of naming the minified binding.
function notificationEnableTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.async !== true
    || node.body?.type !== "BlockStatement") return undefined;
  let requestsPermission = false;
  let tracksResult = false;
  let deniedSource = false;
  walk(node.body, [], child => {
    if (child.type === "CallExpression") {
      const callee = unwrap(child.callee);
      if (callee?.type === "MemberExpression" && property(callee, "requestPermission")
        && identifier(callee.object) === "Notification") requestsPermission = true;
    }
    if (literal(child, notificationPermissionEventKey)) tracksResult = true;
    if (literal(child, notificationPermissionDeniedSource)) deniedSource = true;
  });
  return requestsPermission && tracksResult && deniedSource ? node : undefined;
}

// The session layout's Desktop gate is `if(!x){ …redirect with reason
// "not_desktop_app"… }`. Read the negated identifier back from that exact guard so
// the splice names whatever the minifier chose. The reason literal must sit inside
// the guard's consequent; the Desktop signing gate's own `if(!t.isDesktopApp)
// return …("not_desktop_app")` has a member-expression test, so `identifier`
// yields nothing there and it is not a target.
function sessionViewerFlagName(node) {
  if (node.type !== "IfStatement") return undefined;
  if (!contains(node.consequent, child => child.type === "CallExpression"
    && literal(child.arguments[0], sessionViewerReason))) return undefined;
  const test = unwrap(node.test);
  if (test?.type !== "UnaryExpression" || test.operator !== "!") return undefined;
  return identifier(test.argument);
}
// The flag is initialised once, by a zero-argument call (the user-agent check) in
// the layout component's own body. Only a direct body declaration is a target, so
// a shadowed name inside a nested closure cannot be spliced.
function flagInitializer(scope, flag) {
  if (scope?.body?.type !== "BlockStatement") return undefined;
  for (const statement of scope.body.body || []) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === flag
        && declarator.init?.type === "CallExpression"
        && declarator.init.arguments.length === 0) return declarator.init;
    }
  }
  return undefined;
}

// The account view a component reads from the profile hook:
// `let{name:i,photoUrl:a,illustration:o}=CB()`. Only a destructuring of a
// zero-argument call establishes it — an object literal that merely carries a
// photoUrl property (the hook itself) is not a binding.
function accountViewBindings(scope) {
  let bindings;
  walk(scope.body ?? scope, [], (node) => {
    if (bindings || node.type !== "VariableDeclarator" || node.id?.type !== "ObjectPattern") return;
    if (node.init?.type !== "CallExpression" || node.init.arguments.length !== 0) return;
    const entries = new Map();
    for (const property of node.id.properties) {
      if (property.type !== "Property" || property.value?.type !== "Identifier") continue;
      const name = property.key.name ?? property.key.value;
      if (typeof name === "string") entries.set(name, property.value.name);
    }
    if (!entries.has("photoUrl") || !entries.has("name")) return;
    bindings = { photo: entries.get("photoUrl"), name: entries.get("name") };
  });
  return bindings;
}
// The account Avatar component, read back from the sibling components that build
// an avatar from the same account view with an explicit `src` (the user-menu
// header's avatar). They pass it as the first argument of the element factory, so
// this reads the argument, not the factory, and refuses on more than one name.
function accountAvatarComponent(ast) {
  const names = new Set();
  walk(ast, [], (node) => {
    if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return;
    if (!accountViewBindings(node)) return;
    const returned = node.body.body.find((statement) => statement.type === "ReturnStatement")?.argument;
    if (returned?.type !== "CallExpression") return;
    const props = returned.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
    if (!props?.properties.some((entry) => key(entry, "src"))) return;
    const name = identifier(returned.arguments[0]);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
// The chip's avatar slot: a component taking `{size, organization}` that reads the
// account view and then renders a call whose props carry no `src` — the one shape
// that reads the photo and drops it.
function accountChipTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  const params = node.params?.[0];
  if (params?.type !== "ObjectPattern") return undefined;
  const paramKeys = params.properties.filter((property) => property.type === "Property")
    .map((property) => property.key.name ?? property.key.value);
  if (!paramKeys.includes("size") || !paramKeys.includes("organization")) return undefined;
  const bindings = accountViewBindings(node);
  if (!bindings) return undefined;
  const returned = node.body.body.find((statement) => statement.type === "ReturnStatement")?.argument;
  if (returned?.type !== "CallExpression") return undefined;
  const props = returned.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  if (props.properties.some((entry) => key(entry, "src"))) return undefined;
  const size = props.properties.find((entry) => key(entry, "size"));
  if (!size) return undefined;
  return { call: returned, bindings, sizeValue: size.value };
}
// The account view hook: a zero-parameter function that destructures `account`
// from a zero-argument context call, reads the profile document, and returns the
// view object holding `name`, `photoUrl` and `illustration` — the photo a read of
// the profile's own `avatar_image_url`. Minified names, extra declarations and
// the profile call's arguments are tolerated; a function that merely returns an
// object with a photoUrl property, or reads the field without binding the
// account that carries it, is not a target. The splice reads the account
// binding's own name back from the destructuring.
function accountPhotoRead(node) {
  if (!functionTypes.has(node.type) || node.params?.length) return undefined;
  if (node.body?.type !== "BlockStatement") return undefined;
  const statements = node.body.body;
  const returned = statements.at(-1);
  if (returned?.type !== "ReturnStatement"
    || returned.argument?.type !== "ObjectExpression") return undefined;
  const properties = returned.argument.properties;
  const entry = name => properties.find(candidate => key(candidate, name));
  const photo = entry("photoUrl");
  if (!photo || !entry("name") || !entry("illustration")) return undefined;
  if (!contains(photo.value, child => property(child, "avatar_image_url"))) return undefined;
  let account;
  for (const statement of statements.slice(0, -1)) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== "ObjectPattern"
        || declarator.init?.type !== "CallExpression"
        || declarator.init.arguments.length !== 0) continue;
      for (const binding of declarator.id.properties) {
        if (binding.type !== "Property" || !key(binding, "account")) continue;
        const name = identifier(binding.value);
        if (name) account = name;
      }
    }
  }
  if (!account) return undefined;
  return { start: photo.value.start, end: photo.value.end, account };
}
// The mark is drawn at an explicit pixel size (`size:r?20:16`); the Avatar reads
// its `size` as a design token of its own scale, so passing the token made the
// photo larger than the slot the row reserves and ate the row's padding. Pin the
// avatar to the mark's own size expression instead, read back from this call.
function accountChipPatch({ call, bindings, sizeValue }, source, avatar) {
  const factory = identifier(call.callee);
  if (!factory || !avatar || !bindings.photo || !bindings.name) return undefined;
  const pixels = `(${source.slice(sizeValue.start, sizeValue.end)})+"px"`;
  const original = source.slice(call.start, call.end);
  return { original,
    replacement: `(${bindings.photo}?${factory}(${avatar},{name:${bindings.name}`
      + `,src:${bindings.photo},className:"shrink-0"`
      + `,style:{width:${pixels},height:${pixels}}}):${original})` };
}
// The identity reader's whole body is `return X()?.principalDisplayName` with a
// zero-argument call. Any other property, a call carrying arguments, a member
// expression or additional statements refuses, so a lookalike helper cannot
// establish the target.
function accountMenuNameRead(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  const statements = node.body.body;
  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return undefined;
  const argument = unwrap(statements[0].argument);
  if (argument?.type !== "MemberExpression" || !property(argument, "principalDisplayName")) {
    return undefined;
  }
  const call = unwrap(argument.object);
  if (call?.type !== "CallExpression" || call.arguments.length !== 0) return undefined;
  return identifier(call.callee) ? statements[0].argument : undefined;
}

// The provider card is the sole component passed to a wrapper call whose body
// carries both of its message ids; declarations and unrelated helper functions
// are not arguments, so they are not targets.
function inferenceBannerTarget(node, ancestors) {
  if (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") return false;
  if (node.body?.type !== "BlockStatement") return false;
  const parent = ancestors[ancestors.length - 1];
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return false;
  return inferenceBannerMessageIds.every(id =>
    contains(node.body, child => literal(child, id)));
}
// The file pane's trailing actions, gated by the pane kind (an `==="file"`
// check on the enclosing logical expression), are a two-element children array
// holding a session-scoped search button and a session-scoped anchor control.
// Selecting the array itself keeps the splice to the single insertion point and
// leaves the surrounding header untouched.
function filePaneDownloadTarget({ type, elements }, ancestors) {
  if (type !== "ArrayExpression" || elements.length !== 2) return false;
  if (!key(ancestors.at(-1), "children")) return false;
  const object = ancestors.at(-2);
  if (object?.type !== "ObjectExpression") return false;
  const call = ancestors.at(-3);
  if (call?.type !== "CallExpression" || !call.arguments.includes(object)) return false;
  const guard = ancestors.at(-4);
  return guard?.type === "LogicalExpression" && guard.operator === "&&"
    && guard.right === call && checksFileKind(guard.left);
}
// The injected button references only names that would otherwise be mangled, so
// each is read back from the same parsed graph rather than hard-coded: the file
// pane's absolute path (`x=$(t=>e==="file"?t.fileView:…:void 0)`), the element
// factory the pane already calls, and the ghost icon-only Button component.
// Ambiguous or missing anchors return undefined, and the caller then refuses to
// emit a patch instead of producing code that breaks under a future minifier.
function fileViewVariable(scope) {
  const names = new Set();
  walk(scope, [], node => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
    const selector = node.init?.type === "CallExpression" ? node.init.arguments[0] : undefined;
    if (selector?.type !== "ArrowFunctionExpression") return;
    if (!contains(selector, child => property(child, "fileView"))) return;
    if (!checksFileKind(selector)) return;
    names.add(node.id.name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function ghostIconButton(ast) {
  const names = new Set();
  walk(ast, [], node => {
    if (node.type !== "CallExpression") return;
    const props = node.arguments.map(unwrap).find(argument => argument?.type === "ObjectExpression");
    if (!props) return;
    if (!props.properties.some(entry => key(entry, "variant") && literal(entry.value, "ghost"))
      || !props.properties.some(entry => key(entry, "icon"))
      || !props.properties.some(entry => key(entry, "iconOnly"))) return;
    const name = identifier(node.arguments[0]);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function filePaneDownloadPatch(node, ancestors, source, button) {
  const element = node.elements[0];
  const factory = element?.type === "CallExpression" ? identifier(element.callee) : undefined;
  const scope = [...ancestors].reverse().find(parent => functionTypes.has(parent.type));
  const fileView = scope ? fileViewVariable(scope) : undefined;
  if (!factory || !fileView || !button) return;
  // A new tab keeps a refused download (or a JSON error) from replacing the
  // app, and gives the browser's own download manager a real navigation target.
  const handler = `()=>{const filePath=${fileView}&&${fileView}.path;`
    + 'if(typeof filePath!="string"||filePath==="")return;'
    + 'const link=document.createElement("a");'
    + 'link.href="/api/remote/files/download?path="+encodeURIComponent(filePath);'
    + 'link.target="_blank";link.rel="noopener noreferrer";'
    + 'document.body.append(link);link.click();link.remove();}';
  const injected = `${fileView}&&${fileView}.path?${factory}(${button},`
    + `{variant:"ghost",iconOnly:!0,icon:"Download","aria-label":"Download file",onClick:${handler}}):null`;
  const original = source.slice(node.start, node.end);
  return { original, replacement: `[${original.slice(1, -1)},${injected}]` };
}

// The native preview component renders a container div with this exact className
// and a children array holding the loading spinner, the decline UI and the parked
// capture image. Selecting the array keeps the splice to the single render point
// and leaves the component's effects (which the preload stubs) untouched.
function filePreviewChildrenArray(call) {
  if (call.type !== "CallExpression") return undefined;
  const props = call.arguments.map(unwrap).find(argument => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  if (!props.properties.some(entry => key(entry, "className")
    && literal(entry.value, filePreviewStaticClassName))) return undefined;
  const children = props.properties.find(entry => key(entry, "children"));
  return children?.value?.type === "ArrayExpression" ? children.value : undefined;
}
// A component prop destructured by name, e.g. {filePath:v,cacheBuster:y} -> "v".
function destructuredPropName(scope, name) {
  const params = scope?.params?.[0];
  if (params?.type !== "ObjectPattern") return undefined;
  const entry = params.properties.find(property => property.type === "Property"
    && key(property, name));
  return entry?.value?.type === "Identifier" ? entry.value.name : undefined;
}
// The element factory the array's own calls use (a type string as the first
// argument), read back rather than assumed, so a renamed factory cannot break the
// emitted iframe.
function arrayElementFactory(array) {
  const names = new Set();
  walk(array, [], node => {
    if (node.type !== "CallExpression") return;
    const first = node.arguments[0];
    if (first?.type !== "Literal" || typeof first.value !== "string") return;
    const name = identifier(node.callee);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function filePreviewPatch(node, ancestors, source, array) {
  const scope = [...ancestors].reverse().find(parent => functionTypes.has(parent.type));
  const path = destructuredPropName(scope, "filePath");
  const cacheBuster = destructuredPropName(scope, "cacheBuster");
  const factory = arrayElementFactory(array);
  if (!path || !factory) return;
  // The bridge route answers with a PDF; cacheBuster re-requests when the file's
  // content changes. Office and PDF only — any other file keeps the original
  // children, so html/svg stay on their existing path. The `#toolbar=0` fragment
  // is a PDF open parameter Chrome's viewer reads off the URL: it hides the
  // viewer's own toolbar, leaving the pane to show only the document instead of
  // a second set of controls (its Download would save the converted `.docx.pdf`).
  const url = `"/api/remote/files/preview?path="+encodeURIComponent(${path})`
    + (cacheBuster ? `+"&v="+encodeURIComponent(String(${cacheBuster}??""))` : "")
    + '+"#toolbar=0"';
  const iframe = `${factory}("iframe",{src:${url},className:"h-full w-full border-0",`
    + 'title:"File preview"})';
  const original = source.slice(array.start, array.end);
  const condition = `/(?:pdf|docx?|pptx?|xlsx?)$/i.test(${path})`;
  return { original,
    replacement: `(${condition}?[${iframe}]:[${original.slice(1, -1)}])` };
}

// The Desktop-only checks slot: the one component rendering a call whose props
// carry the `componentName:"DesktopChecks"` label. That label is the bundle's own
// copy and appears nowhere else, and only parsed props are inspected, so a string
// or comment that merely spells it is not a target.
function desktopChecksComponent(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  let found = false;
  walk(node.body, [], (child) => {
    if (found || child.type !== "CallExpression") return;
    const props = child.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
    if (props?.properties.some((entry) => key(entry, "componentName")
      && literal(entry.value, "DesktopChecks"))) found = true;
  });
  return found ? node : undefined;
}
// The pending-permission store's wiring call (`wiring(api)`), read back from the
// Desktop root's own body: the call is the first element of the comma sequence
// that also carries the locale-change effect — a stable property name — so a
// renamed hook or API binding is tolerated. A lone one-argument identifier call
// is too common to pin anywhere else; any other sequence carrying the same
// effect refuses the patch instead of guessing which call wires the store.
function coworkWiringCall(ast) {
  const calls = [];
  walk(ast, [], (node) => {
    if (node.type !== "SequenceExpression" || !node.expressions.length) return;
    if (!node.expressions.some((expression) => contains(expression,
      (child) => property(child, "requestLocaleChange")))) return;
    const first = unwrap(node.expressions[0]);
    if (first?.type !== "CallExpression" || first.arguments.length !== 1) return;
    const callee = identifier(first.callee);
    const api = identifier(first.arguments[0]);
    if (callee && api) calls.push({ callee, api });
  });
  return calls.length === 1 ? calls[0] : undefined;
}

export function inspectRenderer(source, gatewayEnabled, webShellEnabled = false) {
  const evidence = Object.fromEntries(markerIds.map(id => [id, []]));
  const patches = [];
  // String prefilter is only an optimization; all acceptance uses parsed nodes.
  // `native-file-preview-error` is the DeclineReason UI's test id; the preview
  // component's own chunk matches none of the other tokens, so without it the
  // patch below would never be attempted on the file it targets. The route-alias
  // chunk likewise carries none of them, so its own `when==="desktop"` rule is
  // listed too. The session layout carries its own `not_desktop_app` reason. The
  // account chip's chunk is reached by the API field it reads (`avatar_image_url`),
  // and the user-menu identity reader in the same chunk by `principalDisplayName`;
  // the Desktop-checks slot by its own component label.
  if (!/rewind|keyCode|onEdit|protocol|sessionRef|native-file-preview-error|when==="desktop"|not_desktop_app|avatar_image_url|principalDisplayName|DesktopChecks|claudeai\.notification\.permission\.result/.test(source)) {
    return { evidence, patches };
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const redirectScopes = new Map();
  let button;
  let avatarComponent;
  walk(ast, [], (node, ancestors) => {
    if (filePaneDownloadTarget(node, ancestors)) {
      button ??= ghostIconButton(ast);
      const patch = filePaneDownloadPatch(node, ancestors, source, button);
      if (patch) patches.push({ id: downloadPatchId, start: node.start, end: node.end, ...patch });
    }
    if (inferenceBannerTarget(node, ancestors)) {
      patches.push({ id: inferenceBannerPatchId, start: node.body.start, end: node.body.end,
        original: source.slice(node.body.start, node.body.end), replacement: "{return null;}" });
    }
    if (webShellEnabled) {
      const chip = accountChipTarget(node);
      if (chip) {
        avatarComponent ??= accountAvatarComponent(ast);
        const patch = accountChipPatch(chip, source, avatarComponent);
        if (patch) patches.push({ id: accountChipPatchId, start: chip.call.start, end: chip.call.end, ...patch });
      }
      const menuName = accountMenuNameRead(node);
      if (menuName) {
        const original = source.slice(menuName.start, menuName.end);
        patches.push({ id: accountMenuNamePatchId, start: menuName.start, end: menuName.end,
          original, replacement: `(${original}??${accountNameSyncFallback})` });
      }
      const accountPhoto = accountPhotoRead(node);
      if (accountPhoto) {
        const original = source.slice(accountPhoto.start, accountPhoto.end);
        patches.push({ id: accountPhotoPatchId, start: accountPhoto.start, end: accountPhoto.end,
          original, replacement: `(${original}||${accountPhoto.account}?.avatar_image_url)` });
      }
      const routeFlag = desktopRouteFlagName(node);
      if (routeFlag) {
        patches.push({ id: routeAliasPatchId, start: node.body.start + 1, end: node.body.start + 1,
          original: "", replacement: `${routeFlag}=!0;` });
      }
      const sessionFlag = sessionViewerFlagName(node);
      if (sessionFlag) {
        // The guard lives in the layout component's effect closure, so walk out
        // to the nearest enclosing scope that actually declares the flag.
        const init = [...ancestors].reverse()
          .filter(parent => functionTypes.has(parent.type))
          .map(scope => flagInitializer(scope, sessionFlag))
          .find(Boolean);
        if (init) {
          patches.push({ id: sessionViewerPatchId, start: init.start, end: init.end,
            original: source.slice(init.start, init.end), replacement: "!0" });
        }
      }
      const wiringHost = desktopChecksComponent(node);
      if (wiringHost) {
        const wiring = coworkWiringCall(ast);
        if (wiring) {
          patches.push({ id: coworkPermissionWiringPatchId,
            start: wiringHost.body.start + 1, end: wiringHost.body.start + 1,
            original: "", replacement: `${wiring.callee}(${wiring.api});` });
        }
      }
      const enableTarget = notificationEnableTarget(node);
      if (enableTarget) {
        patches.push({ id: notificationEnablePatchId, start: enableTarget.body.start + 1,
          end: enableTarget.body.start + 1, original: "", replacement: notificationEnableBranch });
      }
    }
    const previewArray = filePreviewChildrenArray(node);
    if (previewArray) {
      const patch = filePreviewPatch(node, ancestors, source, previewArray);
      if (patch) {
        patches.push({ id: filePreviewPatchId, start: previewArray.start, end: previewArray.end,
          ...patch });
      }
    }
    let marker;
    if (literal(node, "rewindSession unavailable")) marker = markerIds[0];
    if (property(node, "rewindV2") || key(node, "rewindV2")) marker = markerIds[1];
    if (node.type === "BinaryExpression" && ["==", "==="].includes(node.operator)
      && ((property(node.left, "keyCode") && literal(node.right, 229))
        || (property(node.right, "keyCode") && literal(node.left, 229)))) marker = markerIds[2];
    if (key(node, "edit") && literal(node.value, "onEdit")) marker = markerIds[3];
    if (marker) evidence[marker].push(source.slice(node.start, node.end));

    if (!gatewayEnabled || node.type !== "BinaryExpression"
      || !["==", "===", "!=", "!=="].includes(node.operator)
      || !((protocol(node.left) && literal(node.right, "app:"))
        || (protocol(node.right) && literal(node.left, "app:")))) return;
    // Both setup routes redirect to /new when unavailable. An app: check in an
    // unrelated feature, a string, a comment or a nested helper is not a target.
    const scopeIndex = ancestors.findLastIndex(parent => functionTypes.has(parent.type));
    if (scopeIndex < 0) return;
    const scope = ancestors[scopeIndex];
    if (!redirectScopes.has(scope)) redirectScopes.set(scope, redirectsToNew(scope));
    if (!redirectScopes.get(scope)) return;
    const guard = ancestors.slice(scopeIndex + 1).findLast(parent =>
      parent.type === "LogicalExpression" && parent.operator === "&&");
    if (!guard) return;
    const id = checksWindow(guard.left)
      ? "gateway-setup-route-web-guard" : "gateway-setup-signin-web-guard";
    if (id === "gateway-setup-signin-web-guard"
      && !contains(scope, child => property(child, "pendingUserCode"))) return;
    const original = source.slice(node.start, node.end);
    const remote = "globalThis.__CLAUDE_REMOTE_BOOTSTRAP__?.gatewaySettingsEnabled===true";
    patches.push({ id, start: node.start, end: node.end, original,
      replacement: node.operator.includes("!") ? `(${original}&&!(${remote}))` : `(${original}||${remote})` });
  });
  return { evidence, patches };
}

export function patchRendererSources(sources, gatewayEnabled, webShellEnabled = false) {
  const matches = new Map();
  const markers = new Map(markerIds.map(id => [id, []]));
  for (const [path, source] of sources) {
    const result = inspectRenderer(source, gatewayEnabled, webShellEnabled);
    for (const patch of result.patches) {
      if (!matches.has(patch.id)) matches.set(patch.id, []);
      matches.get(patch.id).push({ path, ...patch });
    }
    for (const [id, evidence] of Object.entries(result.evidence)) {
      if (evidence.length) markers.get(id).push({ path, count: evidence.length, evidence });
    }
  }
  const required = [downloadPatchId, inferenceBannerPatchId, filePreviewPatchId,
    ...(webShellEnabled
      ? [routeAliasPatchId, sessionViewerPatchId, accountChipPatchId, accountPhotoPatchId,
          coworkPermissionWiringPatchId, notificationEnablePatchId, accountMenuNamePatchId]
      : []),
    ...(gatewayEnabled
      ? ["gateway-setup-signin-web-guard", "gateway-setup-route-web-guard"] : [])];
  for (const id of required) {
    const count = matches.get(id)?.length || 0;
    if (count !== 1) throw new Error(`renderer patch ${id} expected once, found ${count}`);
  }
  for (const [id, found] of markers) {
    if (!found.length) throw new Error(`required renderer capability ${id} is missing`);
  }
  const output = new Map(sources);
  const patches = [...matches.values()].flat();
  for (const path of new Set(patches.map(patch => patch.path))) {
    let source = output.get(path);
    for (const patch of patches.filter(patch => patch.path === path).sort((a, b) => b.start - a.start)) {
      source = source.slice(0, patch.start) + patch.replacement + source.slice(patch.end);
    }
    // Parse the final code even if the caller is only doing a dry run.
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    output.set(path, source);
  }
  return { sources: output, patches,
    markers: [...markers].map(([id, found]) => ({ id, matches: found })) };
}
