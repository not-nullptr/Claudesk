import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewHandler } from "../bridge/preview.mjs";

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// A minimal HTTP harness around the route handler, so the real response objects
// (piping a PDF, writing an HTML notice) are exercised rather than mocked.
function serve(handler) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (!(await handler(request, response, url))) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found");
      }
    } catch (error) {
      response.writeHead(error.statusCode || 500, { "Content-Type": "text/plain" });
      response.end(error.message);
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const FAKE_PDF = Buffer.from("%PDF-1.4\n% claudesk fake preview\n");

const fakeConverter = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    fakeConverter.requests.push({ url: request.url, bytes: Buffer.concat(chunks).length });
    response.writeHead(200, { "Content-Type": "application/pdf" });
    response.end(FAKE_PDF);
  });
});
fakeConverter.requests = [];
await new Promise((resolve) => fakeConverter.listen(0, "127.0.0.1", resolve));
const converterUrl = `http://127.0.0.1:${fakeConverter.address().port}`;

const fixtureRoot = await mkdtemp(join(tmpdir(), "claudesk-office-preview-smoke-"));
const cacheRoot = await mkdtemp(join(tmpdir(), "claudesk-office-preview-cache-"));
const preview = createPreviewHandler({
  ApiError,
  downloadRoots: [fixtureRoot],
  maxBytes: 4096,
  converterUrl,
  cacheRoot,
});
const server = await serve(preview);
const base = `http://127.0.0.1:${server.address().port}`;
const previewUrl = (path) => `${base}/api/remote/files/preview?path=${encodeURIComponent(path)}`;

try {
  const docx = join(fixtureRoot, "report.docx");
  await writeFile(docx, "PK\u0003\u0004 fake docx bytes one");
  const otherDocx = join(fixtureRoot, "invoice.docx");
  await writeFile(otherDocx, "PK\u0003\u0004 fake docx bytes two");
  const pdf = join(fixtureRoot, "manual.pdf");
  await writeFile(pdf, FAKE_PDF);
  const notes = join(fixtureRoot, "notes.txt");
  await writeFile(notes, "plain text");
  const huge = join(fixtureRoot, "huge.xlsx");
  await writeFile(huge, Buffer.alloc(5000, 0x50));
  const fresh = join(fixtureRoot, "fresh.pptx");
  await writeFile(fresh, "PK\u0003\u0004 fake deck, never converted yet");

  // Office: converted by the sidecar and served as an inline PDF.
  const converted = await fetch(previewUrl(docx));
  assert.equal(converted.status, 200);
  assert.equal(converted.headers.get("content-type"), "application/pdf");
  assert.match(converted.headers.get("content-disposition"), /^inline;/);
  assert.equal(converted.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await converted.arrayBuffer()), FAKE_PDF, "the PDF body is returned");
  assert.equal(fakeConverter.requests.length, 1, "the sidecar was asked once");
  assert.equal(fakeConverter.requests[0].url, "/convert/.docx", "the extension routes the request");

  // Same bytes convert once: the cache answers the second request.
  const again = await fetch(previewUrl(docx));
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  assert.equal(fakeConverter.requests.length, 1, "identical bytes hit the conversion cache");

  // Different bytes convert again.
  const distinct = await fetch(previewUrl(otherDocx));
  assert.equal(distinct.status, 200);
  await distinct.arrayBuffer();
  assert.equal(fakeConverter.requests.length, 2, "different bytes are converted afresh");

  // PDF: passed straight through, never handed to the sidecar.
  const passthrough = await fetch(previewUrl(pdf));
  assert.equal(passthrough.status, 200);
  assert.equal(passthrough.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await passthrough.arrayBuffer()), FAKE_PDF);
  assert.equal(fakeConverter.requests.length, 2, "a PDF is not converted");

  // Unsupported types get the notice page, not an error.
  const unsupported = await fetch(previewUrl(notes));
  assert.equal(unsupported.status, 200);
  assert.match(unsupported.headers.get("content-type"), /^text\/html/);
  assert.match(await unsupported.text(), /no in-browser preview/);

  // Over the cap: refused before any conversion happens.
  const tooLarge = await fetch(previewUrl(huge));
  assert.equal(tooLarge.status, 413);
  assert.equal(fakeConverter.requests.length, 2, "an oversized file is never converted");

  // Containment and validation.
  assert.equal((await fetch(previewUrl(join(tmpdir(), "elsewhere.docx")))).status, 403);
  assert.equal((await fetch(previewUrl(join(fixtureRoot, "absent.docx")))).status, 404);
  assert.equal((await fetch(`${base}/api/remote/files/preview`)).status, 400);

  // Converter down: the pane still gets a reason, and the bridge does not throw.
  await new Promise((resolve) => fakeConverter.close(resolve));
  const down = await fetch(previewUrl(fresh));
  assert.equal(down.status, 200);
  assert.match(down.headers.get("content-type"), /^text\/html/);
  assert.match(await down.text(), /couldn&#39;t be converted/);

  // Non-matching requests are left to the rest of the router.
  assert.equal(await preview({ method: "GET" }, {}, new URL("http://x/other")), false);
  assert.equal(await preview({ method: "POST" }, {}, new URL("http://x/api/remote/files/preview")), false);

  process.stdout.write("office-preview-smoke: route, cache, caps and fallbacks passed\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(fixtureRoot, { force: true, recursive: true });
  await rm(cacheRoot, { force: true, recursive: true });
}
