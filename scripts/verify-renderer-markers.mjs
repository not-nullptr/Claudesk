import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [directory] = process.argv.slice(2);
assert.ok(directory, "smoke output directory required");
const health = JSON.parse(await readFile(join(directory, "health.json"), "utf8"));
const paths = (await readFile(join(directory, "renderer-assets.txt"), "utf8")).trim().split("\n");
const sources = new Map(await Promise.all(paths.map(async (path, i) =>
  [path, await readFile(join(directory, `renderer-${i + 1}.js`), "utf8")])));
for (const marker of health.renderer.markers) {
  assert.ok(marker.matches.length, `no evidence for ${marker.id}`);
  for (const match of marker.matches) {
    assert.ok(match.evidence?.length, `missing structural evidence for ${marker.id}`);
    for (const evidence of match.evidence) {
      assert.ok(sources.get(match.path)?.includes(evidence), `served renderer differs: ${marker.id}`);
    }
  }
}
console.log("renderer markers match served modules");
