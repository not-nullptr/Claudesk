#!/usr/bin/env node
// Browser uploads are raw bodies streamed to disk (bridge/uploads.mjs): bytes
// arrive intact, the size limit holds, bad requests are refused, interrupted
// uploads leave nothing behind, and a large file does not pass through memory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createUploadHandler, formatBytes, parseUploadLimit } from "../bridge/uploads.mjs";

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ---- the .env value ----
assert.equal(parseUploadLimit(undefined), 1024 ** 3, "defaults to 1 GiB");
assert.equal(parseUploadLimit(""), 1024 ** 3);
assert.equal(parseUploadLimit("1073741824"), 1024 ** 3);
assert.equal(parseUploadLimit("2G"), 2 * 1024 ** 3);
assert.equal(parseUploadLimit("512m"), 512 * 1024 ** 2);
assert.equal(parseUploadLimit("1.5GB"), 1.5 * 1024 ** 3);
assert.equal(parseUploadLimit("0"), 1024 ** 3, "zero is not a limit");
assert.equal(parseUploadLimit("-5"), 1024 ** 3);
assert.equal(parseUploadLimit("lots"), 1024 ** 3, "garbage falls back to the default");
assert.equal(formatBytes(1024 ** 3), "1 GiB");
assert.equal(formatBytes(52428800), "50 MiB");

const workspace = await mkdtemp(join(tmpdir(), "upload-smoke-"));
const limit = 1024 * 1024; // 1 MiB for the limit tests
const logged = [];
const handler = createUploadHandler({
  ApiError,
  workspaceRoot: workspace,
  maxBytes: limit,
  log: { error: (line) => logged.push(line) },
});
const bigHandler = createUploadHandler({ ApiError, workspaceRoot: workspace, maxBytes: 1024 ** 3, log: { error() {} } });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const active = url.searchParams.get("big") ? bigHandler : handler;
  try {
    if (request.method === "GET" && url.pathname === "/limits") return send(200, { ok: true, value: active.limits() });
    send(200, { ok: true, value: await active.receive(request, response, url) });
  } catch (error) {
    send(error.statusCode || 500, { ok: false, error: error.message });
  }
});
server.requestTimeout = 0;
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// The server drops a connection whose upload it refused mid-stream; like a
// browser, retry once if the next request lands on such a pooled socket.
const upload = async (batch, path, body, extra = "") => {
  const send = () => fetch(
    `${base}/upload?batch=${batch}&path=${encodeURIComponent(path)}${extra}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body },
  );
  return send().catch(() => send());
};
const exists = (path) => stat(path).then(() => true, () => false);

try {
  assert.deepEqual(await (await fetch(`${base}/limits`)).json(), { ok: true, value: { maxBytes: limit } });

  // ---- bytes arrive intact, folders keep their structure ----
  const batch = randomUUID();
  const everyByte = Buffer.from(Array.from({ length: 256 * 40 }, (_, index) => index % 256));
  const first = await upload(batch, "folder/sub/all-bytes.bin", everyByte);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.value.path, join(workspace, "RemoteUploads", batch, "folder/sub/all-bytes.bin"));
  assert.equal(firstBody.value.root, join(workspace, "RemoteUploads", batch));
  assert.equal(firstBody.value.bytes, everyByte.length);
  assert.ok((await readFile(firstBody.value.path)).equals(everyByte), "a binary file is stored byte for byte");
  assert.equal((await stat(firstBody.value.path)).mode & 0o777, 0o600);
  assert.equal((await upload(batch, "empty.txt", Buffer.alloc(0))).status, 200, "an empty file is fine");
  assert.equal((await stat(join(workspace, "RemoteUploads", batch, "empty.txt"))).size, 0);
  const text = Buffer.from("héllo wörld ✓");
  const second = await (await upload(batch, "notes.txt", text)).json();
  assert.equal(second.value.root, firstBody.value.root, "files of one batch share a directory");
  assert.ok((await readFile(second.value.path)).equals(text), "text is not re-encoded");

  // ---- refusals ----
  const refuse = async (response, status, pattern) => {
    assert.equal(response.status, status, await response.clone().text());
    assert.match((await response.json()).error, pattern);
  };
  await refuse(await upload("not-a-uuid", "a.txt", "x"), 400, /batch id/);
  await refuse(await upload(randomUUID(), "../escape.txt", "x"), 400, /relative path/);
  await refuse(await upload(randomUUID(), "a/../../escape.txt", "x"), 400, /relative path/);
  await refuse(await upload(randomUUID(), "", "x"), 400, /relative path/);
  await refuse(await upload(batch, "notes.txt", "again"), 409, /already uploaded/);
  assert.ok((await readFile(second.value.path)).equals(text), "a refused duplicate leaves the first file alone");
  assert.ok(!(await exists(join(workspace, "escape.txt"))));
  assert.ok(!(await exists(join(workspace, "RemoteUploads", "escape.txt"))));

  // ---- the limit applies to the batch, from the declared length first ----
  const limited = randomUUID();
  const chunk = Buffer.alloc(600 * 1024, 7);
  assert.equal((await upload(limited, "one.bin", chunk)).status, 200);
  const over = await upload(limited, "two.bin", chunk);
  await refuse(over, 413, /1 MiB upload limit/);
  assert.ok(!(await exists(join(workspace, "RemoteUploads", limited, "two.bin"))), "a refused file is not created");
  await refuse(await upload(randomUUID(), "huge.bin", Buffer.alloc(limit + 1)), 413, /upload limit/);

  // ---- no Content-Length: the limit is enforced while streaming and the partial file is removed ----
  const chunked = randomUUID();
  const endless = Readable.from((async function* () {
    for (let index = 0; index < 64; index += 1) yield Buffer.alloc(64 * 1024, 1);
  })());
  await assert.rejects(
    fetch(`${base}/upload?batch=${chunked}&path=stream.bin`, { method: "POST", body: endless, duplex: "half" }).then(async (response) => {
      assert.equal(response.status, 413);
      throw new Error("refused");
    }),
    /refused|fetch failed/,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!(await exists(join(workspace, "RemoteUploads", chunked, "stream.bin"))), "an over-limit stream leaves no partial file");
  assert.equal((await upload(chunked, "after.bin", Buffer.alloc(100 * 1024))).status, 200, "the failed upload's bytes are released from the batch");

  // ---- a dropped connection leaves nothing behind ----
  const dropped = randomUUID();
  await new Promise((resolve) => {
    const clientRequest = http.request(`${base}/upload?batch=${dropped}&path=cut.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(512 * 1024) },
    });
    clientRequest.on("error", () => {});
    clientRequest.write(Buffer.alloc(64 * 1024, 3), () => {
      setTimeout(() => { clientRequest.destroy(); resolve(); }, 30);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!(await exists(join(workspace, "RemoteUploads", dropped, "cut.bin"))), "an interrupted upload leaves no partial file");

  // ---- a large file is streamed, not held in memory ----
  const total = 300 * 1024 * 1024;
  const bigBatch = randomUUID();
  const rssBefore = process.memoryUsage().rss;
  let peak = rssBefore;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  await new Promise((resolve, reject) => {
    const clientRequest = http.request(`${base}/upload?batch=${bigBatch}&path=big.bin&big=1`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(total) },
    }, async (response) => {
      try {
        const body = JSON.parse(await new Promise((done) => {
          let data = "";
          response.on("data", (part) => { data += part; });
          response.on("end", () => done(data));
        }));
        assert.equal(body.value.bytes, total);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    clientRequest.on("error", reject);
    const piece = Buffer.alloc(1024 * 1024, 9);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += piece.length;
        if (!clientRequest.write(piece)) {
          clientRequest.once("drain", pump);
          return;
        }
      }
      clientRequest.end();
    };
    pump();
  });
  clearInterval(sampler);
  assert.equal((await stat(join(workspace, "RemoteUploads", bigBatch, "big.bin"))).size, total);
  const growthMiB = (peak - rssBefore) / 1024 / 1024;
  assert.ok(growthMiB < 120, `a ${total / 1024 / 1024} MiB upload grew memory by ${growthMiB.toFixed(0)} MiB`);

  // ---- the browser side sends the File itself, never base64 ----
  const preload = await readFile(new URL("../bridge/public/remote-preload.js", import.meta.url), "utf8");
  const begin = preload.indexOf("  let uploadLimitBytes = 0;");
  const finish = preload.indexOf("  async function browseBrowserFiles(", begin);
  assert.ok(begin > 0 && finish > begin, "the browser upload block is missing");
  assert.ok(!/fileAsBase64|readAsDataURL/.test(preload), "the preload no longer base64-encodes files");
  const requests = [];
  const context = {
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url === "/api/remote/files/limits") return { ok: true, json: async () => ({ ok: true, value: { maxBytes: 1000 } }) };
      const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path"));
      return { ok: true, json: async () => ({ ok: true, value: { path: `/workspace/RemoteUploads/B/${path}`, root: "/workspace/RemoteUploads/B" } }) };
    },
  };
  const vm = await import("node:vm");
  vm.runInNewContext(`${preload.slice(begin, finish)}\nthis.upload = uploadBrowserFiles;`, context);
  const fileA = { name: "a b.bin", size: 300 };
  const fileB = { name: "c.txt", size: 400, webkitRelativePath: "dir/c.txt" };
  const result = await context.upload([fileA, fileB]);
  const posts = requests.filter((request) => request.init?.method === "POST");
  assert.equal(posts.length, 2, "one request per file");
  assert.equal(posts[0].init.body, fileA, "the File object itself is the body");
  assert.equal(posts[1].init.body, fileB);
  assert.equal(posts[0].init.headers["Content-Type"], "application/octet-stream");
  assert.match(posts[0].url, /\?batch=11111111-2222-4333-8444-555555555555&path=a%20b\.bin$/);
  assert.match(posts[1].url, /path=dir%2Fc\.txt$/);
  assert.deepEqual(Array.from(result.paths), ["/workspace/RemoteUploads/B/a b.bin", "/workspace/RemoteUploads/B/dir/c.txt"]);
  assert.equal(result.root, "/workspace/RemoteUploads/B", "a first file at the top level keeps the batch root");
  const folderResult = await context.upload([fileB]);
  assert.equal(folderResult.root, "/workspace/RemoteUploads/B/dir", "a dropped folder's root is the folder");
  await assert.rejects(context.upload([{ name: "big.bin", size: 1001 }]), /exceed the .* upload limit/);
  assert.equal(requests.filter((request) => request.init?.method === "POST").length, 3, "an over-limit selection sends nothing");
  assert.equal(await context.upload([]), null);

  assert.deepEqual(logged.filter((line) => /cannot create/.test(line)), []);
  console.log("upload-stream-smoke: raw uploads stream to disk, enforce the limit and clean up");
} finally {
  server.closeAllConnections?.();
  server.close();
  await rm(workspace, { recursive: true, force: true });
}
