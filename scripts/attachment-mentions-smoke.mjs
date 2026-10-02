#!/usr/bin/env node
// A browser has no local path for an attached file, so the Code composer can
// send a bare-name mention (@"report.zip"). The preload must upload the file
// and swap in the server path, and must leave every other mention alone.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
const start = preload.indexOf("  // BEGIN browser attachments");
const end = preload.indexOf("  // END browser attachments", start);
assert.ok(start > 0 && end > start, "browser attachment block markers are missing");

let now = 1_000_000;
const uploads = [];
let uploadError = null;
const context = {
  Date: { now: () => now },
  uploadBrowserFiles: async (files) => {
    if (uploadError) throw uploadError;
    uploads.push(Array.from(files, (file) => file.name));
    return { paths: files.map((file) => `/workspace/RemoteUploads/u${uploads.length}/${file.name}`) };
  },
};
vm.runInNewContext(
  `${preload.slice(start, end)}\nthis.remember = rememberAttachments; this.resolve = resolveAttachmentMentions;`,
  context,
);

const zip = { name: "Claude-SSO-Handoff.zip" };
const png = { name: "shot.png" };

// Nothing attached: arguments pass through untouched, with no upload.
const untouched = [{ message: '@"Claude-SSO-Handoff.zip"\nhi' }];
assert.equal(await context.resolve(untouched), untouched);
assert.equal(uploads.length, 0);

// A bare-name mention, including nested values and ./name, becomes a server path.
context.remember([zip, png]);
const sent = await context.resolve([{
  message: '@"Claude-SSO-Handoff.zip"\ncan you see this?',
  queued: ['and @"./shot.png" too'],
  count: 3,
  nothing: null,
}, "other"]);
assert.deepEqual(uploads, [["Claude-SSO-Handoff.zip", "shot.png"]]);
assert.equal(sent[0].message, '@"/workspace/RemoteUploads/u1/Claude-SSO-Handoff.zip"\ncan you see this?');
assert.equal(sent[0].queued[0], 'and @"/workspace/RemoteUploads/u1/shot.png" too');
assert.equal(sent[0].count, 3);
assert.equal(sent[0].nothing, null);
assert.equal(sent[1], "other");

// Consumed files are not uploaded again.
const again = [{ message: '@"Claude-SSO-Handoff.zip"' }];
assert.equal(await context.resolve(again), again);
assert.equal(uploads.length, 1);

// Real paths, project-relative paths and unknown names are left alone, and only
// the files a message actually mentions are uploaded.
context.remember([zip, png]);
const mixed = await context.resolve([{
  message: '@"/workspace/a.txt" @"src/shot.png" @"~/shot.png" @"missing.bin" @"shot.png"',
}]);
assert.equal(
  mixed[0].message,
  '@"/workspace/a.txt" @"src/shot.png" @"~/shot.png" @"missing.bin" @"/workspace/RemoteUploads/u2/shot.png"',
);
assert.deepEqual(uploads.at(-1), ["shot.png"]);

// Non-plain values (Maps, Blobs) are not traversed.
context.remember([png]);
const map = new Map([["message", '@"shot.png"']]);
const withMap = await context.resolve([map]);
assert.equal(withMap[0], map);
assert.equal(uploads.length, 2);

// Remembered files expire.
now += 31 * 60 * 1000;
const expired = [{ message: '@"shot.png"' }];
assert.equal(await context.resolve(expired), expired);
assert.equal(uploads.length, 2);

// A failed upload fails the send instead of sending a name nothing can open.
context.remember([zip]);
uploadError = new Error("The selected files exceed the 50 MiB upload limit");
await assert.rejects(
  context.resolve([{ message: '@"Claude-SSO-Handoff.zip"' }]),
  /Could not upload the attached files.*50 MiB/,
);

console.log("attachment-mentions-smoke: bare-name mentions upload and resolve to server paths");
