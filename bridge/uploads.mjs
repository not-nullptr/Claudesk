// Browser file uploads. Each file is one request whose body is the raw file,
// streamed to disk under <workspace>/RemoteUploads/<batch>/ as it arrives, so a
// large file costs no memory in the browser or here. Files that belong together
// (a dropped folder, several attachments of one message) share a client-chosen
// batch id and therefore one directory; the size limit applies to the batch.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readMultipart } from "./multipart.mjs";

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

  // ---- the official renderer's own attachment endpoints -------------------
  // Chat and Cowork do not use the raw-binary route above: their composer posts
  // multipart/form-data to claude.ai's file endpoints and expects a file
  // document back. In the desktop app those requests are answered by the app's
  // own protocol; the browser's go to this bridge, and without these routes the
  // attachment fails ("Upload failed") before the message is ever sent. The
  // `path` handed back is the stored file's absolute path, which the local
  // session can open — a browser has no local path of its own to offer.
  const attachments = new Map(); // file uuid -> absolute path, for delete-file

  function rememberAttachment(fileUuid, path) {
    attachments.set(fileUuid, path);
    while (attachments.size > 2000) {
      attachments.delete(attachments.keys().next().value);
    }
    return fileUuid;
  }

  function formFileName(value) {
    const raw = String(value ?? "").replaceAll("\\", "/");
    const name = raw.slice(raw.lastIndexOf("/") + 1).trim();
    if (
      !name
      || name === "."
      || name === ".."
      || name.length > 255
      || /[\u0000-\u001f]/.test(name)
    ) {
      throw new ApiError(400, "upload file name is invalid");
    }
    return name;
  }

  async function makeBatchRoot(response, directory) {
    const batchRoot = resolve(uploadsRoot, directory);
    try {
      await mkdir(batchRoot, { recursive: true });
    } catch (error) {
      log.error(`[bridge] cannot create ${batchRoot}: ${error.message}`);
      throw reject(
        response,
        500,
        `The server cannot store uploads in ${uploadsRoot} (${error.code || "error"}). `
        + `The bridge runs as uid ${process.getuid?.()}; it must match the owner of /workspace (PUID/PGID).`,
      );
    }
    return batchRoot;
  }

  const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  function attachmentDocument(stored, fileUuid) {
    const mediaType = String(stored.contentType ?? "").split(";")[0].trim().toLowerCase();
    const image = imageTypes.has(mediaType);
    return {
      file_kind: image ? "image" : "blob",
      file_uuid: fileUuid,
      uuid: fileUuid,
      id: fileUuid,
      file_name: stored.fileName,
      file_size: stored.bytes,
      size_bytes: stored.bytes,
      path: stored.path,
      created_at: new Date().toISOString(),
      ...(image && {
        // The composer draws images from their preview asset; the bridge's own
        // download route serves the bytes it just stored.
        preview_asset: {
          url: `/api/remote/files/download?path=${encodeURIComponent(stored.path)}&inline=1`,
        },
      }),
    };
  }

  /**
   * POST /api/organizations/{org}/conversations/{conversation}/wiggle/upload-file
   * POST /api/organizations/{org}/cowork/attachments
   * POST /api/{org}/upload
   *
   * All three carry one `file` part; they differ only in which file store the
   * desktop build would have dropped it into.
   */
  async function receiveAttachment(request, response) {
    const batchRoot = await makeBatchRoot(response, randomUUID());
    let target = null;
    let fileName = "";
    let contentType = "";
    try {
      await readMultipart(request, {
        maxBytes,
        isFile: (part) => part.name === "file",
        onFile: async (part) => {
          fileName = formFileName(part.filename);
          contentType = part.contentType ?? "";
          target = resolve(batchRoot, fileName);
          if (!target.startsWith(`${batchRoot}/`)) {
            throw new ApiError(400, "upload target is invalid");
          }
          return createWriteStream(target, { flags: "wx", mode: 0o600 });
        },
      });
      if (!target) throw new ApiError(400, "the upload contained no file");
      const info = await stat(target);
      const stored = { path: target, root: batchRoot, bytes: info.size, fileName, contentType };
      const fileUuid = rememberAttachment(randomUUID(), target);
      return attachmentDocument(stored, fileUuid);
    } catch (error) {
      if (target) await rm(target, { force: true }).catch(() => {});
      await rm(batchRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** POST /api/organizations/{org}/conversations/{conversation}/files/prepare-upload */
  function prepare(body) {
    const files = Array.isArray(body?.files) ? body.files.slice(0, 64) : [];
    return {
      uploads: files.map((file) => {
        const fileUuid = randomUUID();
        const name = formFileName(file?.name);
        return {
          file_uuid: fileUuid,
          filesystem_id: "self-hosted",
          path: `/${fileUuid}/${name}`,
        };
      }),
    };
  }

  /** POST /v1/filestore/fs/createFile — the direct lane for files over 30 MiB. */
  async function receiveFilestore(request, response) {
    let params = null;
    let target = null;
    let directory = "";
    let fileName = "";
    try {
      await readMultipart(request, {
        maxBytes,
        isFile: (part) => part.name === "file",
        onField(name, value) {
          if (name !== "params") return;
          try {
            params = JSON.parse(value);
          } catch {
            throw new ApiError(400, "upload params are invalid");
          }
        },
        onFile: async (part) => {
          const segments = String(params?.path ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
          directory = segments[0] && batchPattern.test(segments[0]) ? segments[0] : randomUUID();
          fileName = formFileName(part.filename || segments.at(-1));
          const batchRoot = await makeBatchRoot(response, directory);
          target = resolve(batchRoot, fileName);
          if (!target.startsWith(`${batchRoot}/`)) {
            throw new ApiError(400, "upload target is invalid");
          }
          // `overwrite_existing` is part of the request's own params; the
          // renderer retries to the same path after a size mismatch.
          return createWriteStream(target, { flags: "w", mode: 0o600 });
        },
      });
      if (!target) throw new ApiError(400, "the upload contained no file");
      const info = await stat(target);
      const fileUuid = rememberAttachment(
        batchPattern.test(directory) ? directory : randomUUID(),
        target,
      );
      return {
        file: {
          file: {
            uuid: fileUuid,
            file_uuid: fileUuid,
            file_name: fileName,
            name: fileName,
            size: info.size,
            size_bytes: info.size,
            path: target,
          },
        },
      };
    } catch (error) {
      if (target) await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** POST /api/organizations/{org}/conversations/{conversation}/wiggle/delete-file */
  async function removeAttachment(body) {
    const fileUuid = typeof body?.file_uuid === "string" ? body.file_uuid : "";
    const target = attachments.get(fileUuid);
    if (target && target.startsWith(`${uploadsRoot}/`)) {
      attachments.delete(fileUuid);
      await rm(target, { force: true }).catch(() => {});
    }
    return { ok: true };
  }

  return {
    receive,
    receiveAttachment,
    prepare,
    receiveFilestore,
    removeAttachment,
    limits,
  };
}
