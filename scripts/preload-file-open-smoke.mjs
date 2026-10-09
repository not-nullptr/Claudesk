import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Desktop's FileSystem surface is not path-first: its session-scoped calls read
// `openLocalFile(sessionId, encodeURIComponent(path), reveal?)` (and
// `readLocalFile(sessionId, encodedPath)`), while `showInFolder(path)` takes a
// plain host path. The remote preload used to treat openLocalFile's first
// argument as the path, so a Cowork file opened as
// `?path=local_<uuid>&inline=1` — the session id, not a file. This pins the
// argument handling and the single encode/decode layer.

const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
const helperStart = preload.indexOf("  function workspaceFileUrl(");
const helperEnd = preload.indexOf("  let lastArtifactDownload", helperStart);
const methodStart = preload.indexOf("  function browserMethod(");
const methodEnd = preload.indexOf("  const root = Object.create(null);", methodStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "workspaceFileUrl helper must exist");
assert.ok(methodStart >= 0 && methodEnd > methodStart, "browserMethod must exist");

const opened = [];
const context = {
  openBrowserUrl: url => { opened.push(url); },
  browseBrowserFiles: () => { throw new Error("no browser file picker in this test"); },
  invoke: () => { throw new Error("no Desktop IPC in this test"); },
};
vm.runInNewContext(
  `${preload.slice(helperStart, helperEnd)}\n${preload.slice(methodStart, methodEnd)}\nthis.method=browserMethod;`,
  context,
);

const open = async (surface, method, ...args) => {
  opened.length = 0;
  await context.method(surface, method)(...args);
  return parse(opened.at(-1));
};

function parse(url) {
  assert.ok(typeof url === "string" && url.startsWith("/api/remote/files/download?"), `unexpected URL ${url}`);
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  return { path: query.get("path"), inline: query.get("inline") === "1" };
}

const sessionId = "local_6cc3e91c-d31f-42c0-b61d-67313b2266b1";

// Open (reveal absent): the session id must never be the path; the file path is
// the second argument, still URI-encoded by Desktop, and previews inline.
let result = await open("FileSystem", "openLocalFile", sessionId, encodeURIComponent("/workspace/report.md"));
assert.equal(result.path, "/workspace/report.md", "openLocalFile must use the path argument, not the session id");
assert.equal(result.inline, true, "open must preview inline");

// A path with a space must survive exactly one decode; double-encoding would
// miss the file on the server.
result = await open("FileSystem", "openLocalFile", sessionId, encodeURIComponent("/workspace/My Report.md"));
assert.equal(result.path, "/workspace/My Report.md", "Desktop's encoding must be undone exactly once");
assert.equal(result.inline, true);

// Reveal (third argument true) is the "show in folder" variant: a download,
// not an inline preview.
result = await open("FileSystem", "openLocalFile", sessionId, encodeURIComponent("/workspace/out.csv"), true);
assert.equal(result.path, "/workspace/out.csv");
assert.equal(result.inline, false, "reveal must serve as a download");

// A `computer://`-derived path arrives pre-encoded and is decoded the same way.
result = await open("FileSystem", "openLocalFile", sessionId, "/workspace/notes%20draft.txt");
assert.equal(result.path, "/workspace/notes draft.txt");

// showInFolder stays path-first and hosts the raw path, with no decode layer.
result = await open("FileSystem", "showInFolder", "/workspace/a b%2Fc.txt");
assert.equal(result.path, "/workspace/a b%2Fc.txt", "showInFolder paths are used verbatim");
assert.equal(result.inline, false);

// A space file opens by its raw path (Desktop passes it unencoded there).
result = await open("CoworkSpaces", "openFile", "space-1", "/workspace/diagram.svg");
assert.equal(result.path, "/workspace/diagram.svg");
assert.equal(result.inline, true);

console.log("preload-file-open-smoke: session-scoped open path and reveal/download handling passed");
