import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, posix, resolve } from "node:path";

// Every service image builds from the repository root but copies only part of
// it, and all three run a Node entry that imports its siblings. An explicit
// line-per-module COPY list rots the moment a module is added: the image builds
// fine and only the running container fails with ERR_MODULE_NOT_FOUND — which
// is how a browser-notification module once shipped without its source, and
// how the Code surface modules once shipped uncopied in the mobile facade. The
// Dockerfiles now copy their runtime modules with a wildcard; this test walks
// each entry point's local reference graph (imports and `new URL("./…",
// import.meta.url)` reads) and proves every file the container will load is
// actually produced by some COPY rule. A module in a new subdirectory, or a
// wildcard turned back into a list, fails here instead of in production.

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function listContextFiles(prefix = "") {
  const entries = await readdir(join(repoRoot, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listContextFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Docker COPY wildcards follow Go's filepath.Match, where `*` does not cross a
// `/`; the sources in these Dockerfiles are single-segment globs.
function wildcardMatcher(pattern) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`);
}

function parseCopyInstructions(source) {
  const instructions = [];
  for (const rawLine of source.replaceAll("\\\n", " ").split("\n")) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith("COPY ")) continue;
    const tokens = line.split(/\s+/).slice(1).filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) continue;
    instructions.push({
      sources: tokens.slice(0, -1),
      destination: tokens.at(-1),
    });
  }
  return instructions;
}

function containerPath(destination, rest) {
  const base = destination.startsWith("/")
    ? destination
    : posix.join("/app", destination);
  const root = destination.endsWith("/") ? base.replace(/\/+$/, "") : base;
  return rest ? `${root}/${rest}` : root;
}

// The container file paths a Dockerfile produces, mapped back to the repository
// files they are copied from, so the reference walk can read the right source.
async function producedFiles(dockerfile, contextFiles) {
  const instructions = parseCopyInstructions(await readFile(join(repoRoot, dockerfile), "utf8"));
  const produced = new Map();
  for (const { sources, destination } of instructions) {
    for (const pattern of sources) {
      if (pattern.includes("*")) {
        const matches = wildcardMatcher(pattern);
        for (const file of contextFiles) {
          if (matches.test(file)) produced.set(containerPath(destination, posix.basename(file)), file);
        }
        continue;
      }
      if ((await stat(join(repoRoot, pattern))).isDirectory()) {
        const prefix = pattern.replace(/\/+$/, "");
        for (const file of contextFiles) {
          if (!file.startsWith(`${prefix}/`)) continue;
          produced.set(
            containerPath(destination, file.slice(prefix.length + 1)),
            file,
          );
        }
      } else {
        produced.set(
          containerPath(destination, destination.endsWith("/") ? posix.basename(pattern) : ""),
          pattern,
        );
      }
    }
  }
  return produced;
}

const localReferencePatterns = [
  /from\s*["']\.\/([^"']+)["']/g,
  /import\(\s*["']\.\/([^"']+)["']/g,
  /new URL\(\s*["']\.\/([^"']+)["']/g,
];

function localReferences(source) {
  const references = new Set();
  for (const pattern of localReferencePatterns) {
    for (const match of source.matchAll(pattern)) references.add(match[1]);
  }
  return references;
}

async function checkService({ name, dockerfile, entry }) {
  const contextFiles = await listContextFiles();
  const produced = await producedFiles(dockerfile, contextFiles);
  // The entry is relative to WORKDIR (/app in every one of these images).
  const pending = [containerPath("./", entry)];
  const visited = new Set();
  while (pending.length) {
    const target = pending.pop();
    if (visited.has(target)) continue;
    visited.add(target);
    const sourcePath = produced.get(target);
    if (!sourcePath) {
      throw new Error(
        `${name}: ${dockerfile} copies nothing to ${target}, which the container loads `
        + "(an image built from this Dockerfile fails at startup with ERR_MODULE_NOT_FOUND)",
      );
    }
    if (!target.endsWith(".mjs") && !target.endsWith(".js")) continue;
    const source = await readFile(join(repoRoot, sourcePath), "utf8");
    for (const reference of localReferences(source)) {
      const resolved = posix.normalize(posix.join(posix.dirname(target), reference))
        .replace(/\/+$/, "");
      const isDirectory = reference.endsWith("/");
      if (isDirectory) {
        const hasContents = [...produced.keys()].some((file) => file.startsWith(`${resolved}/`));
        assert.ok(
          hasContents,
          `${name}: ${dockerfile} copies nothing into ${resolved}/, read by ${target}`,
        );
        continue;
      }
      pending.push(resolved);
    }
  }
  return visited.size;
}

const services = [
  { name: "cowork-bridge", dockerfile: "bridge/Dockerfile", entry: "server.mjs" },
  { name: "mobile-api", dockerfile: "mobile/Dockerfile", entry: "server.mjs" },
  { name: "office-preview", dockerfile: "bridge/office/Dockerfile", entry: "server.mjs" },
];

// The bridge serves these to the browser, so they must ship with the image even
// though no import names them.
const producedBridge = await producedFiles("bridge/Dockerfile", await listContextFiles());
for (const required of [
  "public/remote-preload.js",
  "public/sw.js",
  "public/remote-main-menu.js",
  "release.json",
]) {
  assert.ok(
    producedBridge.has(`/app/${required}`),
    `bridge/Dockerfile must copy ${required} into the image`,
  );
}

for (const service of services) {
  const count = await checkService(service);
  console.log(`docker-copy-smoke: ${service.name} loads ${count} copied file(s), all produced by its Dockerfile`);
}
console.log("docker-copy-smoke: every service's startup module graph is copied by its Dockerfile");
