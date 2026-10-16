import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The renderer picks its composer design from the device latch —
// `composer-card-latch` in localStorage — and, on the New page only, from the
// static stamp the shell rewrites to `data-composer-arm="marlin"`. Every other
// surface (the project pages among them) therefore falls back to a latch nothing
// ever writes and draws the pre-marlin composer, so the remote preload seeds it.
// These checks pin that seeding: a fresh browser gets the deployed design, an
// explicit "classic" is left alone, and a storage that refuses writes (private
// mode, or none at all) does not fail the page.
const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
const start = preload.indexOf("  // The renderer picks its composer design");
const end = preload.indexOf("  const listenerCallbacks", start);
assert.ok(start >= 0 && end > start, "the composer-latch block must exist in the preload");
const block = preload.slice(start, end);

function run(initial, storage = true) {
  const store = new Map(initial === undefined ? [] : [["composer-card-latch", initial]]);
  const context = {};
  if (storage) {
    context.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    };
  }
  vm.runInNewContext(block, context);
  return store;
}

assert.equal(run(undefined).get("composer-card-latch"), "marlin",
  "a browser with no latch is seeded with the deployed design");
assert.equal(run("classic").get("composer-card-latch"), "classic",
  "an explicit choice of the classic card is left alone");
assert.equal(run("marlin").get("composer-card-latch"), "marlin",
  "an already-seeded latch is left as it is");
assert.equal(run("banana").get("composer-card-latch"), "marlin",
  "an unrecognised value is replaced rather than trusted");

// A storage that refuses writes — private mode — must not take the page down.
const refusing = {
  getItem: () => null,
  setItem: () => { throw new Error("QuotaExceededError"); },
};
vm.runInNewContext(block, { localStorage: refusing });
// And a context with no storage at all.
vm.runInNewContext(block, {});

console.log("composer-latch-smoke: the composer design latch is seeded, and never at a person's expense");
