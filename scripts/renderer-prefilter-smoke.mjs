// Guards the chunk prefilter in renderer-patches.mjs.
//
//   node scripts/renderer-prefilter-smoke.mjs [ION_DIST_DIR]
//
// The filter is an optimization: it decides which of ion-dist's chunks get
// parsed, and a needle that is wrong in the *permissive* direction only costs
// time. A needle that is wrong in the *restrictive* direction loses a patch —
// silently, for every patch that is not in the required set, since nothing else
// asserts that an optional patch fired.
//
// Two things are checked:
//
//   * Always: the compiled regex is not degenerate. A trailing `|` in the needle
//     list is an empty alternative that matches every string, which disables the
//     filter outright and puts the whole 113 MB back through acorn. That
//     happened in 2026-10-15's `web shell: force the New page's composer arm…`,
//     and every test still passed. This is the assertion that would have caught
//     it.
//
//   * With a directory (the real ion-dist, inside a prepared container): every
//     chunk a full unfiltered pass produces a patch or marker from must also be
//     a chunk the filter selects. This is the assertion that catches a needle
//     missing its own chunk, at the cost of one unfiltered pass — too slow for
//     the default validate run, which is why it needs the argument.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  inspectRenderer,
  prefilterNeedles,
  rendererPrefilter,
} from "../rootfs/opt/claude-cowork-bridge/renderer-patches.mjs";

// A haystack with none of the needles in it. The old regex matched this.
const noTargets = "const a=1;function b(c){return c+1}";
assert.ok(!rendererPrefilter.test(noTargets),
  "the prefilter matches a chunk carrying no needle, so it is degenerate "
  + "(an empty alternative, e.g. a trailing `|` in prefilterNeedles) and no chunk is being skipped");

assert.ok(prefilterNeedles.length > 0, "the prefilter has no needles");
for (const needle of prefilterNeedles) {
  assert.ok(rendererPrefilter.test(`prefix ${needle} suffix`),
    `the prefilter does not match its own needle ${JSON.stringify(needle)}`);
}

const [directory] = process.argv.slice(2);
if (!directory) {
  console.log("renderer-prefilter-smoke: the regex is not degenerate (pass an ion-dist directory to check coverage)");
  process.exit(0);
}

async function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

const ionRoot = resolve(directory);
const files = await listJavaScriptFiles(ionRoot);
assert.ok(files.length > 0, `no JavaScript chunks under ${ionRoot}`);

const selected = [];
const missed = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  // The unfiltered pass: what the patcher *would* find in this chunk if every
  // chunk were parsed.
  const result = inspectRenderer(source, true, true);
  const carries = result.patches.length > 0
    || Object.values(result.evidence).some(evidence => evidence.length > 0);
  if (!carries) continue;
  (rendererPrefilter.test(source) ? selected : missed).push(file);
}

assert.deepEqual(missed, [],
  `the prefilter skips ${missed.length} chunk(s) that carry a patch or marker, so those patches are never applied`);
console.log(`renderer-prefilter-smoke: ${selected.length} chunks carry a target and all of them pass the filter `
  + `(${files.length} chunks scanned)`);
