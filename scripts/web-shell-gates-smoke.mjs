import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The web shell reads the bootstrap's GrowthBook table for rollout gates. Code
// and Cowork are added only when absent, while the composer redesign is forced
// on even if the upstream explicitly carries false. ion-dist keys each feature
// by a Java-style 32-bit hash. These checks pin the keys and rewrite behavior.
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
       grantComposer: grantWebShellComposerDesign, hash: growthbookKey,
       grantProjects: grantProjectsLimits, enabled: webShellEnabled };`,
    sandbox,
  );
  return sandbox.result;
}

const { granted, grant, grantComposer, grantProjects, hash, enabled } = load();
assert.deepEqual(plain(granted),
  ["bad_moon_rising", "yukon_silver_dramatic_shrimp_clocks", "yukon_silver_folders"],
  "the web shell's gates are the Code, Cowork and folder entry points");
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
assert.equal(hash("voyage_composer_marlin"), "2295073874",
  "the Marlin composer gate must hash to the id ion-dist reads it by");
assert.equal(hash("__gb__123456"), "123456", "a literal id passes through unchanged");

// The redesign is enabled even if the upstream table carries false, and its
// entry is not rewritten again once the effective value is already true.
const composerKey = hash("voyage_composer_marlin");
const composerAbsent = { growthbook: { features: { existing: { defaultValue: true } } } };
assert.equal(grantComposer(composerAbsent), true, "an absent composer gate must be enabled");
assert.deepEqual(plain(composerAbsent.growthbook.features[composerKey]), { defaultValue: true });
assert.equal(grantComposer(composerAbsent), false, "an enabled composer gate must be idempotent");
const composerFalse = { growthbook: { features: { [composerKey]: { defaultValue: false } } } };
assert.equal(grantComposer(composerFalse), true, "an explicit false composer gate must be overridden");
assert.deepEqual(plain(composerFalse.growthbook.features[composerKey]), { defaultValue: true });
const composerTrue = { growthbook: { features: { [composerKey]: { value: true } } } };
assert.equal(grantComposer(composerTrue), false, "an already-true composer gate must be preserved");
assert.deepEqual(plain(composerTrue.growthbook.features[composerKey]), { value: true });
assert.match(serverSource,
  /if \(webShellEnabled && bootstrapResponsePath\.test\(url\.pathname\)\s*&& grantWebShellComposerDesign\(parsed\)\) \{\s*rewrote = true;\s*\}/,
  "the composer override is limited to web-shell bootstrap responses");

// Projects: the free-plan allowance feature. It carries a *value*, not a
// boolean, so the absence test the other gates use is not enough — an entry the
// upstream already carries can still answer an allowance of zero, or carry no
// `max_free_projects` field, and the renderer reads that as no allowance exactly
// as it reads a missing entry. Only a positive allowance is left alone.
const projectsKey = hash("claude_ai_projects_limits");
const projectsFallback = { defaultValue: { max_free_projects: 5 } };
const projectsAbsent = { growthbook: { features: {} } };
assert.equal(grantProjects(projectsAbsent), true, "an absent allowance must be added");
assert.deepEqual(plain(projectsAbsent.growthbook.features[projectsKey]), projectsFallback,
  "the allowance is granted as a field-value object the renderer reads `max_free_projects` off");
assert.equal(grantProjects(projectsAbsent), false, "a granted allowance must not be rewritten");
for (const [label, entry] of [
  ["an upstream allowance", { defaultValue: { max_free_projects: 20 } }],
  ["an upstream allowance carried as a plain number", { defaultValue: 20 }],
  ["an upstream allowance on the evaluated value", { value: { max_free_projects: 3 } }],
]) {
  const upstream = { growthbook: { features: { [projectsKey]: entry } } };
  assert.equal(grantProjects(upstream), false, `${label} must be left alone`);
  assert.deepEqual(plain(upstream.growthbook.features[projectsKey]), entry,
    `${label} must survive untouched`);
}
for (const [label, entry] of [
  ["a zero allowance", { defaultValue: { max_free_projects: 0 } }],
  ["a zero allowance carried as a plain number", { defaultValue: 0 }],
  ["an allowance object with no field", { defaultValue: {} }],
  ["an explicit false", { defaultValue: false }],
]) {
  const upstream = { growthbook: { features: { [projectsKey]: entry } } };
  assert.equal(grantProjects(upstream), true, `${label} must be raised to the fallback`);
  assert.deepEqual(plain(upstream.growthbook.features[projectsKey]), projectsFallback,
    `${label} must not leave the renderer reading no allowance`);
}
assert.equal(grantProjects({}), false, "a table-less document is left alone");
assert.match(serverSource,
  /if \(webShellEnabled && bootstrapResponsePath\.test\(url\.pathname\)\s*&& grantProjectsLimits\(parsed\)\) \{\s*rewrote = true;\s*\}/,
  "the allowance is limited to web-shell bootstrap responses");

// For Code and Cowork, an upstream value is authoritative in either direction.
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
