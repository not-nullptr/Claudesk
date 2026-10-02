#!/usr/bin/env node
// The mobile facade's image ships an explicit allowlist of modules
// (mobile/Dockerfile COPYs each one), not the whole directory. That list is
// easy to forget when a new module is added: the image then builds fine and
// the container dies on startup with ERR_MODULE_NOT_FOUND before it can serve
// a single request — every Code tab leg fails at once, and the phone shows only
// "Something went wrong". That is exactly what happened when the four
// code-*.mjs modules landed.
//
// This checks the allowlist against reality: every module reachable from
// server.mjs's entry point must be COPYed into the image. It reads the
// imports rather than a hand-kept list, so it cannot drift.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = join(root, "mobile");
const entry = join(mobileDir, "server.mjs");

// Relative ESM specifiers only: a bare specifier is a package (none are used
// by the facade) and an absolute one would not be copied either.
const IMPORT_RE = /(?:^|[\s({])import\s+(?:[^'"]*?\sfrom\s+)?["'](\.[^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["'](\.[^"']+)["']\s*\)/g;

async function localImportsOf(file) {
  const source = await readFile(file, "utf8");
  const found = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) found.add(match[1]);
  }
  return [...found];
}

// Walk the import graph from server.mjs so a module reachable only through
// another (code-engine.mjs -> code-events.mjs) is still required.
const reachable = new Set();
const queue = [entry];
while (queue.length) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const specifier of await localImportsOf(file)) {
    queue.push(join(dirname(file), specifier));
  }
}

const dockerfile = await readFile(join(mobileDir, "Dockerfile"), "utf8");
const copied = new Set(
  [...dockerfile.matchAll(/^\s*COPY\s+mobile\/(\S+)\s/gm)].map((match) => match[1]),
);

const missing = [...reachable]
  .map((file) => relative(mobileDir, file))
  .filter((rel) => !rel.includes("/") && rel.endsWith(".mjs"))
  .filter((rel) => !copied.has(rel))
  .sort();

assert.deepEqual(
  missing,
  [],
  `mobile/Dockerfile does not COPY these modules, which server.mjs reaches: ${missing.join(", ")}`,
);

// The reverse is not an error (a module may be copied for a future entry
// point), but a COPY of a file that does not exist breaks the build, so it is.
const { access } = await import("node:fs/promises");
for (const rel of copied) {
  await access(join(mobileDir, rel)).catch(() => {
    assert.fail(`mobile/Dockerfile COPYs mobile/${rel}, which does not exist`);
  });
}

console.log("mobile-image-smoke: ok");
