import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveDownloadTarget } from "./downloads.mjs";

// File types the browser preview route renders. Office documents are converted
// to PDF by the sidecar; PDFs are served as-is. This is Desktop's own preview
// set (`soffice` in the Cowork VM produces the same PDF), minus html/svg, which
// it renders natively and which must not be served inline from this origin.
export const OFFICE_EXTENSIONS = new Set([
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
]);

const PDF_MAGIC = Buffer.from("%PDF-");
const CONVERT_TIMEOUT_MS = 60_000;
// The sidecar runs one LibreOffice profile at a time; a small queue bounds the
// memory the bridge holds in flight without serialising every request.
const MAX_CONCURRENT_CONVERSIONS = 2;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;

function isPdf(buffer) {
  return buffer.length >= PDF_MAGIC.length && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function safeFilename(name) {
  return String(name).replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "preview";
}

function pdfHeaders(filename, length) {
  return {
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${safeFilename(filename)}"`,
    "Content-Length": length,
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
    "Content-Type": "application/pdf",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

// A self-authored page (never user content) shown inside the pane's iframe when
// a file has no browser preview — an unsupported type, a refused conversion, or
// the sidecar being down. It is served instead of an error status so the pane
// shows a reason rather than a blank frame.
function noticePage(message) {
  const body = `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>Preview unavailable</title></head>`
    + `<body style="margin:0;display:flex;align-items:center;justify-content:center;`
    + `height:100vh;font:14px system-ui,'Segoe UI',sans-serif;color:#6b7280;background:#fafafa">`
    + `<p style="max-width:28rem;padding:1rem;text-align:center">${message}</p></body></html>`;
  return Buffer.from(body, "utf8");
}

function serveNotice(response, message) {
  const body = noticePage(message);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

/** A tiny semaphore so conversions queue instead of running unbounded. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active += 1;
    const { run, resolve, reject } = waiting.shift();
    run().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (run) => new Promise((resolve, reject) => {
    waiting.push({ run, resolve, reject });
    next();
  });
}

/**
 * Convert Office bytes to PDF via the sidecar, caching by content hash. The
 * cache is keyed on the bytes and extension, so the same document served twice
 * is converted once; entries live in a temp dir and are pruned by a byte cap.
 */
async function convertOfficeBytes(bytes, extension, { converterUrl, cacheRoot }, limit) {
  const hash = createHash("sha256").update(extension).update("\0").update(bytes).digest("hex");
  const cachePath = join(cacheRoot, `${hash}.pdf`);
  const cached = await readFile(cachePath).catch(() => null);
  if (cached && isPdf(cached)) return cached;

  const pdf = await limit(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${converterUrl}/convert/${extension}`, {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": "application/octet-stream" },
        signal: controller.signal,
      });
      if (!upstream.ok) throw new Error(`converter responded ${upstream.status}`);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (!isPdf(buffer)) throw new Error("converter did not return a PDF");
      return buffer;
    } finally {
      clearTimeout(timer);
    }
  });

  await mkdir(cacheRoot, { recursive: true }).catch(() => undefined);
  await writeFile(cachePath, pdf, { mode: 0o600 }).catch(() => undefined);
  void pruneCache(cacheRoot);
  return pdf;
}

async function pruneCache(cacheRoot) {
  try {
    const entries = [];
    for (const name of await readdir(cacheRoot)) {
      if (!name.endsWith(".pdf")) continue;
      const info = await stat(join(cacheRoot, name)).catch(() => null);
      if (info?.isFile()) entries.push({ name, mtime: info.mtimeMs, size: info.size });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    await Promise.all(entries.map(async (entry) => {
      total += entry.size;
      if (total > CACHE_MAX_BYTES) {
        await rm(join(cacheRoot, entry.name), { force: true }).catch(() => undefined);
      }
    }));
  } catch {
    // A missing or unreadable cache dir is not worth failing a preview over.
  }
}

/**
 * `GET /api/remote/files/preview?path=…` — serves an Office or PDF session file
 * as an inline PDF for the pane's iframe. Paths resolve through the same roots
 * and containment rules as the download route (`resolveDownloadTarget`), so a
 * preview cannot reach a file a download could not. Returns false for other
 * requests so the caller keeps dispatching.
 */
export function createPreviewHandler({
  ApiError,
  downloadRoots,
  maxBytes,
  converterUrl,
  cacheRoot = join(tmpdir(), "claudesk-office-preview"),
}) {
  const limit = createLimiter(MAX_CONCURRENT_CONVERSIONS);
  return async function handleFilePreview(request, response, url) {
    if (request.method !== "GET" || url.pathname !== "/api/remote/files/preview") return false;
    const requestedPath = url.searchParams.get("path");
    if (typeof requestedPath !== "string" || !requestedPath || requestedPath.length > 4096) {
      throw new ApiError(400, "preview path is invalid");
    }
    const filePath = await resolveDownloadTarget(downloadRoots, requestedPath, {
      allowRoot: false,
      missingMessage: "preview file was not found",
      outsideMessage: "preview path is outside the allowed read roots",
    });
    const info = await stat(filePath);
    if (!info.isFile()) throw new ApiError(404, "preview file was not found");

    const extension = extname(filePath).toLowerCase();
    if (extension === ".pdf") {
      response.writeHead(200, pdfHeaders(basename(filePath), info.size));
      createReadStream(filePath).pipe(response);
      return true;
    }
    if (OFFICE_EXTENSIONS.has(extension)) {
      if (info.size > maxBytes) {
        throw new ApiError(413, "file is too large to preview");
      }
      let pdf;
      try {
        pdf = await convertOfficeBytes(
          await readFile(filePath), extension, { converterUrl, cacheRoot }, limit,
        );
      } catch (error) {
        console.log(`[cowork-bridge] preview convert failed for ${extension}: ${error.message}`);
        serveNotice(response, "This file couldn&#39;t be converted for preview. Use Download to open it.");
        return true;
      }
      console.log(`[cowork-bridge] preview served ${extension} (${info.size} bytes)`);
      response.writeHead(200, pdfHeaders(`${basename(filePath)}.pdf`, pdf.length));
      response.end(pdf);
      return true;
    }
    serveNotice(response, "This file type has no in-browser preview. Use Download to open it.");
    return true;
  };
}
