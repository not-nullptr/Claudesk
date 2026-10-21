import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The composer's model picker is laid out from data the renderer is handed: each
// entry's `section` ("main" | "overflow") picks its group, and the array order is
// the root order, with the "More models" submenu appearing as soon as one entry
// is `overflow`. That data is the bootstrap document's `model_selector_config` —
// one list per surface — which this bridge already rewrites on its way to the
// page, so the operator's main-model list can be pinned at the root without
// patching the renderer. These checks pin that rewrite, its no-op cases, the env
// form of the list, and the route the layout is read from.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const envSection = section(
  serverSource,
  "const MODEL_PICKER_MAX_MODELS =",
  "// Web-shell account identity",
);
const layoutSection = section(
  serverSource,
  "function modelPickerKey",
  "function containsSensitiveCredential",
);

// The bridge sections run in another realm, so their objects are round-tripped
// through this realm's JSON before strict deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load({ env = {}, envCatalogue = [], desktop } = {}) {
  const logs = [];
  const sandbox = {
    process: { env: { ...env } },
    console: { log: (...args) => logs.push(args.join(" ")), warn: () => {} },
    Buffer,
    ...(desktop ? { desktop } : {}),
  };
  vm.runInNewContext(
    `${envSection}${layoutSection}
     const configuredModelCatalogue = ${JSON.stringify(envCatalogue)};
     result = { parse: parseModelList, envList: envMainModels, max: MODEL_PICKER_MAX_MODELS,
       layout: applyModelPickerLayout, key: modelPickerKey, remember: rememberPickerModels,
       catalogue: modelPickerCatalogue, seen: pickerModelsSeen };`,
    sandbox,
  );
  return { ...sandbox.result, logs };
}

/** A Desktop that answers the bridge's own bootstrap read with `document`. */
function desktopServing(document) {
  return {
    protocol: async () => ({
      bodyBase64: Buffer.from(JSON.stringify(document), "utf8").toString("base64"),
    }),
  };
}

const { parse, envList, max, layout, key, logs } = load();

// --- the env form of the list ------------------------------------------------

assert.deepEqual(plain(parse(undefined)), [], "an unset list is empty");
assert.deepEqual(plain(parse("   ")), [], "a blank list is empty");
assert.deepEqual(plain(parse('["a","b"]')), ["a", "b"], "a JSON array is the documented form");
assert.deepEqual(plain(parse(" a, b\nc ,, ")), ["a", "b", "c"], "a separated list works too");
assert.deepEqual(plain(parse('["a","b","c","d"]').slice(2)), ["c", "d"], "order is preserved");
assert.deepEqual(plain(parse('["  a  ", "", 7, null, "b"]')), ["a", "b"],
  "only non-empty strings are ids");
assert.deepEqual(plain(parse("[")), [], "a broken JSON array is not one id");
assert.deepEqual(plain(parse('{"a":1}')), [], "a JSON object is not a list");
assert.deepEqual(plain(parse(JSON.stringify(Array.from({ length: max + 10 }, (_, i) => `m${i}`)))).length,
  max, "the list is bounded");
assert.deepEqual(plain(load({ env: { CLAUDE_MODEL_PICKER_MAIN_MODELS: "x,y" } }).envList), ["x", "y"],
  "CLAUDE_MODEL_PICKER_MAIN_MODELS is the env spelling of the list");
assert.deepEqual(plain(envList), [], "no env list means the native layout");

// --- how a listed id is matched ----------------------------------------------

assert.equal(key(" Opus "), "opus", "ids match case-insensitively and trimmed");
assert.equal(key("opus[1m]"), "opus[1m]", "a long-context spelling is its own id, not the model's");
assert.equal(key(undefined), "", "a nameless entry has no key");

// --- the rewrite, against the shape the deployment really serves --------------
//
// Captured from a live 3P deployment: each entry is `{id, name, description,
// thinking}` with no `section` at all, so today every model sits at the root.
const entry = (id) => ({ id, name: id, description: `${id} description`, thinking: { type: "effort" } });
const surface = (id, ids) => ({ id, models: ids.map(entry) });

function bootstrap() {
  return {
    account: { uuid: "00000000-0000-4000-8000-000000000001" },
    model_selector_config: [
      surface("cowork", ["m-alpha", "m-alpha[1m]", "m-beta", "m-gamma", "m-delta"]),
      surface("chat", ["m-beta", "m-alpha", "m-delta"]),
      surface("code", ["m-gamma"]),
    ],
  };
}

const modelsOf = (document, id) =>
  document.model_selector_config.find((s) => s.id === id).models;
const idsOf = (document, id) => plain(modelsOf(document, id).map((m) => m.id));
const sectionsOf = (document, id) => plain(modelsOf(document, id).map((m) => m.section));

const document = bootstrap();
const before = plain(document);
assert.equal(layout(document, ["m-gamma", "m-alpha"]), true, "a matching list rewrites the document");

assert.deepEqual(idsOf(document, "cowork"),
  ["m-gamma", "m-alpha", "m-alpha[1m]", "m-beta", "m-delta"],
  "main models come first in the operator's order and the rest keep their relative order");
assert.deepEqual(sectionsOf(document, "cowork"),
  ["main", "main", "overflow", "overflow", "overflow"],
  "listed models are at the root and everything else is under More models");
assert.deepEqual(idsOf(document, "chat"), ["m-alpha", "m-beta", "m-delta"],
  "each surface is laid out on its own — chat has no m-gamma");
assert.deepEqual(sectionsOf(document, "chat"), ["main", "overflow", "overflow"]);
assert.deepEqual(sectionsOf(document, "code"), ["main"],
  "a surface of only main models still gets the field written");
assert.deepEqual(plain(modelsOf(document, "cowork")[3]),
  { ...entry("m-beta"), section: "overflow" },
  "an entry keeps everything but its section");
assert.notEqual(plain(document).account, undefined, "the rest of the document is left alone");
assert.equal(before.model_selector_config[0].models[3].section, undefined,
  "the fixture really starts with no sections at all");

assert.equal(layout(document, ["m-gamma", "m-alpha"]), false, "the rewrite is idempotent");
assert.deepEqual(idsOf(document, "cowork"),
  ["m-gamma", "m-alpha", "m-alpha[1m]", "m-beta", "m-delta"], "a second pass changes nothing");

// A long-context spelling is a row of its own with its own id, so it is pinned
// only when it is listed — one root row per model the operator chose.
const longContext = { model_selector_config: [surface("chat", ["m-y", "m-x", "m-x[1m]"])] };
assert.equal(layout(longContext, ["m-x"]), true);
assert.deepEqual(idsOf(longContext, "chat"), ["m-x", "m-y", "m-x[1m]"],
  "the model is pinned alone; its 1M spelling waits under More models");
assert.deepEqual(sectionsOf(longContext, "chat"), ["main", "overflow", "overflow"]);

const bothSpellings = { model_selector_config: [surface("chat", ["m-x[1m]", "m-y", "m-x"])] };
assert.equal(layout(bothSpellings, ["m-x", "m-x[1m]"]), true);
assert.deepEqual(idsOf(bothSpellings, "chat"), ["m-x", "m-x[1m]", "m-y"],
  "listing both spellings puts both at the root, in the order given");

// --- the no-op cases ---------------------------------------------------------

const untouched = bootstrap();
const original = plain(untouched);
assert.equal(layout(untouched, []), false, "an empty list is the native layout");
assert.deepEqual(plain(untouched), original, "an empty list rewrites nothing");

const unmatched = bootstrap();
assert.equal(layout(unmatched, ["some-other-deployment"]), false,
  "a list no entry matches leaves the picker alone rather than emptying it");
assert.deepEqual(plain(unmatched), original, "an unmatched list rewrites nothing");
assert.ok(logs.some((line) => line.includes("none of the configured main models")),
  "an unmatched list is reported, since a typo would otherwise look like the setting did nothing");

for (const [label, value] of [
  ["a document with no model config", { account: {} }],
  ["a null model config", { model_selector_config: null }],
  ["a surface with no list", { model_selector_config: [{ id: "chat" }] }],
  ["no document at all", null],
]) {
  assert.equal(layout(value, ["m-alpha"]), false,
    `${label} is left alone`);
}

// --- the catalogue the admin page's card offers ------------------------------
//
// The card shows the deployment's models with the label each displays as, which
// the served document carries and no env list knows under discovery.
const envOnly = [{ id: "env-model", name: "Env Model" }];
const returned = ["m-alpha", "m-alpha[1m]", "m-beta", "m-gamma", "m-delta"]
  .map((id) => ({ id, name: id }));

const withEnv = load({ envCatalogue: envOnly, desktop: desktopServing(bootstrap()) });
assert.deepEqual(plain(await withEnv.catalogue()), returned,
  "a card opened before any page load asks the Desktop for the picker's list");

const served = bootstrap();
assert.equal(withEnv.remember(served), undefined, "recording is a side effect");
assert.deepEqual(plain(await withEnv.catalogue()), returned,
  "the served picker list is the catalogue, with the names the menu shows");

// A Desktop that will not answer — a bridge that cannot reach it — leaves the
// env list, and no env list at all leaves an empty card rather than a crash.
const broken = load({
  envCatalogue: envOnly,
  desktop: { protocol: async () => { throw new Error("no desktop"); } },
});
assert.deepEqual(plain(await broken.catalogue()), envOnly,
  "a Desktop read that fails falls back to the env list");
const bare = load({});
assert.deepEqual(plain(await bare.catalogue()), [],
  "no Desktop and no env list is an empty catalogue, not a failure");

// The unified home renders the cowork surface; chat is the fallback for a build
// without it, and any surface beats leaving the card empty.
const chatOnly = { model_selector_config: [surface("chat", ["m-one"])] };
const chatFallback = load({ envCatalogue: envOnly, desktop: desktopServing(chatOnly) });
assert.deepEqual(plain(await chatFallback.catalogue()), [{ id: "m-one", name: "m-one" }],
  "a document without a cowork surface falls back to chat");

const emptyServed = load({
  envCatalogue: envOnly,
  desktop: desktopServing({ model_selector_config: [surface("cowork", [])] }),
});
assert.deepEqual(plain(await emptyServed.catalogue()), envOnly,
  "a served list with no models in it leaves the env list in place");

const names = load({ desktop: desktopServing({ model_selector_config: [
  { id: "cowork", models: [{ id: "m-1", name: "Nice Name" }, { id: "m-2" }, { name: "no id" }] },
] }) });
assert.deepEqual(plain(await names.catalogue()),
  [{ id: "m-1", name: "Nice Name" }, { id: "m-2", name: "m-2" }],
  "each entry is named by its own label, an id with no label by its id, and an entry "
    + "with no id is dropped");
assert.equal(names.remember({}), undefined, "a document with no model config is ignored");
assert.equal(names.remember(null), undefined, "no document is ignored");

// The layout is only ever applied to the bootstrap response the picker reads, and
// the list comes from the auth service's narrow deployment route. The same block
// resolves a bare gateway alias to the prefixed route before the list is
// remembered, because those ids are what every surface sends.
assert.match(serverSource,
  /if \(bootstrapResponsePath\.test\(url\.pathname\)\) \{[\s\S]*?if \(applyModelPickerLayout\(parsed, await resolveMainModels\(\)\)\) rewrote = true;[\s\S]*?if \(await canonicalizePickerModelIds\(parsed\)\) rewrote = true;[\s\S]*?rememberPickerModels\(parsed\);[\s\S]*?\}/,
  "the layout, alias resolution and catalogue are limited to bootstrap responses");
assert.match(serverSource, /fetch\(`\$\{authIdentityUrl\}\/api\/auth\/deployment`/,
  "the operator's list is read from authd's deployment route");
assert.match(serverSource, /const envMainModels = parseModelList\(process\.env\.CLAUDE_MODEL_PICKER_MAIN_MODELS\)/,
  "the env list is parsed once at startup");

console.log("model-picker-smoke: layout rewrite, catalogue and no-op cases passed");
