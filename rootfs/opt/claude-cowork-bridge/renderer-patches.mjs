import { parse } from "acorn";

// Keep selectors tied to non-mangled properties and behavior, not names of
// chunks, locals, React imports, or textual formatting. Only splice the selected
// expression: regenerating a whole bundle would disturb its module graph.
export const markerIds = ["cowork-native-rewind", "code-native-rewind-v2",
  "ime-keycode-229", "native-message-edit"];
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

export function inspectRenderer(source, gatewayEnabled) {
  const evidence = Object.fromEntries(markerIds.map(id => [id, []]));
  const patches = [];
  // String prefilter is only an optimization; all acceptance uses parsed nodes.
  if (!/rewind|keyCode|onEdit|protocol/.test(source)) return { evidence, patches };
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const redirectScopes = new Map();
  walk(ast, [], (node, ancestors) => {
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
  const required = gatewayEnabled
    ? ["gateway-setup-signin-web-guard", "gateway-setup-route-web-guard"] : [];
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
