import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The web shell reads the bootstrap's GrowthBook table for the few rollout gates
// that decide whether a *browser* client is offered Code and Cowork. The bridge
// grants them by name (ion-dist addresses a feature by a Java-style 32-bit hash
// of it), because the self-hosted bootstrap carries Desktop's hardcoded table,
// which has neither gate. These checks pin the hash the table is keyed by, that
// only an absent gate is added — an upstream value, including a false one, is
// never overwritten — and that the whole rewrite is the web shell's.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const flagSection = section(serverSource, "const webShellEnabled =", "const remoteUserName =");
const grantSection = section(
  serverSource,
  "function growthbookKey",
  "function containsSensitiveCredential",
);

// The bridge sections run in another realm, so their objects are round-tripped
// through this realm's JSON before strict deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load({ webShell = false, env = {} } = {}) {
  const sandbox = { process: { env: { ...env } } };
  const flags = flagSection.replace(
    /const webShellEnabled = .*;/,
    `const webShellEnabled = ${webShell};`,
  );
  vm.runInNewContext(
    `${flags}${grantSection}
     result = { granted: webShellGrantedGates, grant: grantWebShellGates,
       hash: growthbookKey, enabled: webShellEnabled };`,
    sandbox,
  );
  return sandbox.result;
}

const { granted, grant, hash, enabled } = load();
assert.deepEqual(plain(granted), ["bad_moon_rising", "yukon_silver_dramatic_shrimp_clocks"],
  "the web shell's gates are the Code and Cowork entry points");
assert.equal(enabled, false, "the rewrite is off unless the web shell is asked for");
assert.equal(load({ webShell: true }).enabled, true, "CLAUDE_REMOTE_WEB_SHELL turns it on");

// Every granted gate lands under its own Java-hash key, and nothing else does.
const bootstrap = { growthbook: { features: { existing: { defaultValue: true } } } };
assert.equal(grant(bootstrap), true, "an absent gate must be added");
for (const name of granted) {
  assert.deepEqual(plain(bootstrap.growthbook.features[hash(name)]), { defaultValue: true },
    `${name} must be granted as true under its hashed key`);
}
assert.equal(grant(bootstrap), false, "a granted table must not be rewritten again");
assert.equal(Object.keys(bootstrap.growthbook.features).length, granted.length + 1,
  "no gate beyond the granted ones and the upstream entry may be added");

// The hash is ion-dist's own: the name the app passes to its flag reader, keyed
// as the bundle's precomputed `__gb__` literal would be. `bad_moon_rising` is
// pinned to the id the shipped bundle reads it by.
assert.equal(hash("bad_moon_rising"), "2831057674",
  "a gate name must hash to the id ion-dist reads it by");
assert.equal(hash("__gb__123456"), "123456", "a literal id passes through unchanged");

// An upstream value is authoritative, in either direction: the gate the
// deployment already carries keeps whatever it says.
const upstream = { growthbook: { features: { [hash("bad_moon_rising")]: { defaultValue: false } } } };
assert.equal(grant(upstream), true, "the one absent gate is still added");
assert.deepEqual(plain(upstream.growthbook.features[hash("bad_moon_rising")]), { defaultValue: false },
  "an upstream false must be left alone");
const all = { growthbook: { features: Object.fromEntries(
  granted.map(name => [hash(name), { defaultValue: false }])) } };
assert.equal(grant(all), false, "a table carrying every gate is untouched");
assert.deepEqual(plain(all.growthbook.features),
  Object.fromEntries(granted.map(name => [hash(name), { defaultValue: false }])),
  "an upstream false for a granted gate survives");

// A response without the table cannot be granted into, and must not throw.
assert.equal(grant({}), false, "a table-less document is left alone");
assert.equal(grant({ growthbook: {} }), false, "a table-less growthbook is left alone");
assert.equal(grant({ growthbook: { features: null } }), false, "a null table is left alone");

console.log("web-shell-gates-smoke: gate grants, hashed keys and upstream preservation passed");
