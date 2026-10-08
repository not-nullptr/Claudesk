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
// or string that merely spells them cannot establish the target.
const inferenceBannerPatchId = "inference-banner";
const inferenceBannerMessageIds = ["+8XhcAcHfK", "1qPkTh9fMa"];
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
// The provider card is the sole component passed to a wrapper call whose body
// carries both of its message ids; declarations and unrelated helper functions
// are not arguments, so they are not targets. A missing target is tolerated at
// the call site: the desired end state is "no card", and an upstream that
// already dropped it needs no patch.
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

export function inspectRenderer(source, gatewayEnabled) {
  const evidence = Object.fromEntries(markerIds.map(id => [id, []]));
  const patches = [];
  // String prefilter is only an optimization; all acceptance uses parsed nodes.
  if (!/rewind|keyCode|onEdit|protocol|sessionRef/.test(source)) return { evidence, patches };
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const redirectScopes = new Map();
  let button;
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

export function patchRendererSources(sources, gatewayEnabled) {
  const matches = new Map();
  const markers = new Map(markerIds.map(id => [id, []]));
  for (const [path, source] of sources) {
    const result = inspectRenderer(source, gatewayEnabled);
    for (const patch of result.patches) {
      if (!matches.has(patch.id)) matches.set(patch.id, []);
      matches.get(patch.id).push({ path, ...patch });
    }
    for (const [id, evidence] of Object.entries(result.evidence)) {
      if (evidence.length) markers.get(id).push({ path, count: evidence.length, evidence });
    }
  }
  const required = [downloadPatchId, ...(gatewayEnabled
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
