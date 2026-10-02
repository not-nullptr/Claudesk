// Browser file uploads. Each file is one request whose body is the raw file,
// streamed to disk under <workspace>/RemoteUploads/<batch>/ as it arrives, so a
// large file costs no memory in the browser or here. Files that belong together
// (a dropped folder, several attachments of one message) share a client-chosen
// batch id and therefore one directory; the size limit applies to the batch.
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const defaultUploadLimit = 1024 ** 3;

const units = { "": 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
const batchPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const batchTtlMs = 60 * 60 * 1000;

/** COWORK_UPLOAD_MAX_BYTES: a byte count, optionally with a K, M or G suffix. */
export function parseUploadLimit(value, fallback = defaultUploadLimit) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(value ?? ""));
  const unit = match ? units[match[2].toLowerCase()] : undefined;
  const bytes = match && unit ? Math.floor(Number(match[1]) * unit) : 0;
  return bytes > 0 ? bytes : fallback;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} bytes`;
}

export function validateUploadRelativePath(value, ApiError) {
  if (typeof value !== "string" || !value || value.length > 2048) {
    throw new ApiError(400, "upload relative path is invalid");
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (
    parts.length > 64
    || parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part))
  ) {
    throw new ApiError(400, "upload relative path is invalid");
  }
  return parts;
}

export function createUploadHandler({ ApiError, workspaceRoot, maxBytes = defaultUploadLimit, log = console }) {
  const uploadsRoot = resolve(workspaceRoot, "RemoteUploads");
  const batches = new Map(); // batch id -> { bytes, at }

  function batchEntry(id) {
    const now = Date.now();
    for (const [key, entry] of batches) {
      if (now - entry.at > batchTtlMs) batches.delete(key);
    }
    const entry = batches.get(id) || { bytes: 0, at: now };
    entry.at = now;
    batches.set(id, entry);
    return entry;
  }

  function reject(response, status, message) {
    // The body has not been read; do not keep a connection that is still being sent a file.
    response?.setHeader("Connection", "close");
    return new ApiError(status, message);
  }

  function limits() {
    return { maxBytes };
  }

  /** POST /api/remote/files/upload?batch=<uuid>&path=<relative path> with the file as the body. */
  async function receive(request, response, url) {
    const batch = url.searchParams.get("batch") || "";
    if (!batchPattern.test(batch)) throw reject(response, 400, "upload batch id is invalid");
    const parts = validateUploadRelativePath(url.searchParams.get("path"), ApiError);

    const entry = batchEntry(batch);
    const declared = request.headers["content-length"];
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) throw reject(response, 400, "Content-Length is invalid");
      if (entry.bytes + Number(declared) > maxBytes) {
        throw reject(response, 413, `The files exceed the ${formatBytes(maxBytes)} upload limit`);
      }
    }

    const batchRoot = resolve(uploadsRoot, batch);
    const target = resolve(batchRoot, ...parts);
    if (!target.startsWith(`${batchRoot}/`)) throw reject(response, 400, "upload target is invalid");
    try {
      await mkdir(dirname(target), { recursive: true });
    } catch (error) {
      log.error(`[bridge] cannot create ${dirname(target)}: ${error.message}`);
      throw reject(
        response,
        500,
        `The server cannot store uploads in ${uploadsRoot} (${error.code || "error"}). `
        + `The bridge runs as uid ${process.getuid?.()}; it must match the owner of /workspace (PUID/PGID).`,
      );
    }

    if (await lstat(target).then(() => true, () => false)) {
      throw reject(response, 409, "that file was already uploaded in this batch");
    }

    let written = 0;
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        written += chunk.length;
        entry.bytes += chunk.length;
        if (entry.bytes > maxBytes) {
          done(new ApiError(413, `The files exceed the ${formatBytes(maxBytes)} upload limit`));
        } else {
          done(null, chunk);
        }
      },
    });
    try {
      await pipeline(request, counter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      entry.bytes -= written;
      if (error?.code !== "EEXIST") await rm(target, { force: true }).catch(() => {});
      if (error instanceof ApiError) throw error;
      if (error?.code === "EEXIST") throw new ApiError(409, "that file was already uploaded in this batch");
      log.error(`[bridge] upload of ${target} failed: ${error.message}`);
      throw new ApiError(400, "the upload was interrupted");
    }
    return { path: target, root: batchRoot, bytes: written };
  }

  return { receive, limits };
}
