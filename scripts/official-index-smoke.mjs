import assert from "node:assert/strict";
import { shimOfficialIndex } from "../bridge/official-index.mjs";

// The official entry carries one module script; the bootstrap is spliced before
// it and the asset roots are rewritten to the prepared renderer.
const entry = '<!doctype html><html><head>'
  + '<link rel="manifest" href="/manifest.json">'
  + '<script type="module" crossorigin src="/assets/v1/index-DrchryRN.js"></script>'
  + '</head><body></body></html>';
const base = "/renderer/2.9939.4/20261009-2";
const marker = "globalThis.__CLAUDE_REMOTE_BOOTSTRAP__=";

// Mirrors server.mjs's htmlSafeJson so the check compares like for like.
function escapeBootstrap(config) {
  return JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

// The end of the first JSON value at `start`, string- and escape-aware.
function jsonEndIndex(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function bootstrapOf(html) {
  const start = html.indexOf(marker) + marker.length;
  const end = jsonEndIndex(html, start);
  assert.notEqual(end, -1, "the injected bootstrap must be a complete JSON value");
  return html.slice(start, end);
}

function shim(config, options = {}) {
  const bootstrapJson = escapeBootstrap(config);
  const html = shimOfficialIndex(options.entry ?? entry, {
    injection: `<script>globalThis.__CLAUDE_REMOTE_BOOTSTRAP__=${bootstrapJson}</script>`,
    overrideStyles: '<link rel="stylesheet" href="/remote-shell.css">',
    rendererBase: base,
    bootstrapJson,
    ...(options.webShell === undefined ? {} : { webShell: options.webShell }),
  });
  return { html, bootstrapJson };
}

// The regression: a renderer patch whose `original` is verbatim source carrying
// a `$&` replacement pattern — the native-file-preview patch splices a children
// array holding `$&&s("img",…)`. A String.replace saw that inside the JSON and
// rewrote it to the matched `<script type="module"`, so the inline bootstrap
// became a SyntaxError, the preload bailed out, and ion-dist dropped Chat.
const patchManifest = {
  desktopVersion: "2.9939.4",
  patchRelease: "20261009-2",
  patches: [{
    id: "native-file-preview-bridge",
    path: "assets/v1/c6e1d8764-Cs1moXV4.js",
    original: '[z===null?L?s(x,{className:"absolute inset-0"}):null:s(H,{declineReason:z}),'
      + '$&&s("img",{src:$.src,alt:""})]',
    replacement: '($&&s("iframe",{src:""}))',
  }],
};

const configs = [
  { transport: "official-ion-dist-remote-ipc", desktopRuntime: { renderer: patchManifest } },
  // Every other `$` replacement form a future patch could carry.
  { transport: "official-ion-dist-remote-ipc", desktopRuntime: { note: "$' and $` and $1 and $$" } },
];
for (const config of configs) {
  const { html, bootstrapJson } = shim(config);
  assert.ok(html.includes(bootstrapJson), "the bootstrap JSON must be spliced verbatim");
  assert.deepEqual(JSON.parse(bootstrapOf(html)), config,
    "the injected bootstrap must parse back to the config");
  assert.ok(html.includes(`${base}/assets/`), "asset roots are rewritten to the renderer base");
  assert.ok(!html.includes('rel="manifest" href="/manifest.json"'), "the official manifest link is dropped");
}

// A `$`-expanded or otherwise drifted injection must be refused, not served.
assert.throws(
  () => shimOfficialIndex('<head><script type="module" src="/assets/x.js"></head>', {
    injection: "<script>globalThis.__CLAUDE_REMOTE_BOOTSTRAP__={}</script>",
    overrideStyles: "",
    rendererBase: base,
    bootstrapJson: '{"transport":"different"}',
  }),
  /refusing an unshimmed page/,
  "a bootstrap that did not survive the splice must be refused",
);
assert.throws(
  () => shimOfficialIndex('<head><script type="module" src="/x.js"></head>', {
    injection: "<script>shim</script>",
    overrideStyles: "",
    rendererBase: base,
    bootstrapJson: "<script>shim</script>",
  }),
  /refusing a mixed renderer module graph/,
  "an entry with no rewritten asset root must be refused",
);

// The Desktop package's entry carries neither of the two attributes claude.ai's
// server fills in, and they are what the first paint reads: the smaller home
// greeting is keyed off `html[data-new-page-layout=home]`, and the marlin card
// off `data-composer-arm=marlin`. The web shell fills them in; every other mode
// serves the entry exactly as it came.
const desktopEntry = '<!doctype html><html lang="en" class="cds-root"><head>'
  + '<link rel="manifest" href="/manifest.json">'
  + '<script type="module" crossorigin src="/assets/v1/index-DrchryRN.js"></script>'
  + '</head><body><div id="static-composer" hidden></div></body></html>';
const plain = shim(configs[0], { entry: desktopEntry }).html;
assert.ok(!plain.includes("data-new-page-layout") && !plain.includes("data-composer-arm"),
  "a non-web-shell entry must be served unchanged");
const shell = shim(configs[0], { entry: desktopEntry, webShell: true });
assert.ok(shell.html.includes('<html data-new-page-layout="home" lang="en"'),
  "the web shell must mark the entry's home layout");
assert.ok(shell.html.includes('<div id="static-composer" data-composer-arm="marlin" hidden>'),
  "the web shell must mark the entry's composer arm");
assert.ok(shell.html.includes(shell.bootstrapJson), "the bootstrap must survive the annotations");
assert.ok(shell.html.includes(`${base}/assets/`), "the asset roots must still be rewritten");
// An entry without that markup is annotated nowhere rather than refused: this
// only changes which design paints first, so it must never fail preparation.
const bare = shim(configs[0], { webShell: true }).html;
assert.ok(!bare.includes("data-composer-arm"), "an entry without the skeleton is left alone");

console.log("official-index-smoke: bootstrap splice survives $&/$'/$`/$$ and refuses drift");
