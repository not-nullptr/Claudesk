#!/usr/bin/env node
// The browser chat/Cowork composer posts attachments to claude.ai's own
// multipart endpoints and parses the reply as a file document. The bridge must
// store each one, hand back a document whose `path` the local session can open,
// and answer the prepared/direct lane used for files over 30 MiB.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createUploadHandler } from "../bridge/uploads.mjs";

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const workspace = await mkdtemp(join(tmpdir(), "chat-upload-smoke-"));
const handler = createUploadHandler({ ApiError, workspaceRoot: workspace, maxBytes: 2 * 1024 * 1024 });

const send = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (request.method === "POST" && /^\/api\/(organizations\/[0-9a-f-]{36}\/(conversations\/[^/]+\/wiggle\/upload-file|cowork\/attachments)|[0-9a-f-]{36}\/upload)$/i.test(url.pathname)) {
      return send(response, 200, await handler.receiveAttachment(request, response));
    }
    if (request.method === "POST" && /\/files\/prepare-upload$/i.test(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return send(response, 200, handler.prepare(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }
    if (request.method === "POST" && url.pathname === "/v1/filestore/fs/createFile") {
      return send(response, 200, await handler.receiveFilestore(request, response));
    }
    if (request.method === "POST" && /\/wiggle\/delete-file$/i.test(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return send(response, 200, await handler.removeAttachment(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, error.statusCode || 500, { ok: false, error: error.message });
  }
});
server.requestTimeout = 0;
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const org = "00000000-0000-4000-8000-000000000001";
const conversation = "local_00349228-0047-41d8-a22b-a8fd7032ea6b";

const upload = (path, name, body, type = "text/plain") => {
  const form = new FormData();
  form.append("file", new Blob([body], { type }), name);
  return fetch(`${base}${path}`, { method: "POST", body: form });
};

try {
  // ---- wiggle upload: the file document carries an openable absolute path ----
  const text = Buffer.from("héllo wörld ✓\nsecond line");
  const wiggle = await upload(
    `/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    "webhelper.txt",
    text,
  );
  assert.equal(wiggle.status, 200);
  const document = await wiggle.json();
  assert.equal(document.file_kind, "blob");
  assert.match(document.file_uuid, /^[0-9a-f-]{36}$/);
  assert.equal(document.file_name, "webhelper.txt");
  assert.equal(document.size_bytes, text.length);
  assert.ok(document.path.startsWith(`${workspace}/RemoteUploads/`));
  assert.ok((await readFile(document.path)).equals(text), "bytes are stored unchanged");
  assert.equal((await stat(document.path)).mode & 0o777, 0o600);

  // ---- the same document reaches the organization and Cowork endpoints ----
  for (const path of [
    `/api/${org}/upload`,
    `/api/organizations/${org}/cowork/attachments`,
  ]) {
    const response = await upload(path, "1792232362884__cef_log.txt", Buffer.from("log"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.file_kind, "blob");
    assert.equal(body.file_name, "1792232362884__cef_log.txt");
    assert.equal((await stat(body.path)).size, 3);
  }

  // Images keep their image kind and get a preview the composer can draw.
  const png = await upload(
    `/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    "shot.png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "image/png",
  );
  const image = await png.json();
  assert.equal(image.file_kind, "image");
  assert.match(image.preview_asset.url, /^\/api\/remote\/files\/download\?path=/);

  // A path handed by the browser is reduced to its base name.
  const nested = await upload(
    `/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    "../../escape.txt",
    Buffer.from("x"),
  );
  const escaped = await nested.json();
  assert.equal(escaped.file_name, "escape.txt");
  assert.ok(escaped.path.startsWith(`${workspace}/RemoteUploads/`));
  assert.ok(!(await stat(join(workspace, "escape.txt")).catch(() => false)));

  // ---- delete-file removes only a file this bridge stored ----
  const removed = await fetch(
    `${base}/api/organizations/${org}/conversations/${conversation}/wiggle/delete-file`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_uuid: escaped.file_uuid }) },
  );
  assert.equal(removed.status, 200);
  assert.equal(await stat(escaped.path).then(() => false, () => true), true, "the file is gone");

  // ---- prepare-upload + /v1/filestore/fs/createFile (the >30 MiB lane) ----
  const prepared = await (await fetch(
    `${base}/api/organizations/${org}/conversations/${conversation}/files/prepare-upload`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: [{ name: "big.txt" }] }) },
  )).json();
  assert.equal(prepared.uploads.length, 1);
  const grant = prepared.uploads[0];
  assert.equal(grant.filesystem_id, "self-hosted");
  assert.equal(grant.path, `/${grant.file_uuid}/big.txt`);

  const form = new FormData();
  form.append("params", new Blob([JSON.stringify({
    filesystem_id: grant.filesystem_id,
    path: grant.path,
    media_type: "text/plain",
    overwrite_existing: true,
  })], { type: "application/json" }));
  form.append("file", new Blob([Buffer.from("large-ish")], { type: "text/plain" }), "big.txt");
  const created = await (await fetch(`${base}/v1/filestore/fs/createFile`, { method: "POST", body: form })).json();
  assert.equal(created.file.file.uuid, grant.file_uuid);
  assert.equal(created.file.file.size, 9);
  assert.equal((await readFile(created.file.file.path, "utf8")), "large-ish");

  // ---- refusals ----
  const noBoundary = await fetch(
    `${base}/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  assert.equal(noBoundary.status, 400, "a non-multipart body is refused");

  const emptyName = await upload(
    `/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    "",
    Buffer.from("x"),
  );
  assert.equal(emptyName.status, 400, "an empty file name is refused");

  const tooLarge = await upload(
    `/api/organizations/${org}/conversations/${conversation}/wiggle/upload-file`,
    "big.bin",
    Buffer.alloc(2 * 1024 * 1024 + 1),
    "application/octet-stream",
  );
  assert.equal(tooLarge.status, 413, "the upload limit still applies");

  assert.ok(randomUUID());
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}

console.log("chat-attachment-upload-smoke: multipart attachments are stored and answered");
