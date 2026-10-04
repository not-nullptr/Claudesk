import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

export async function resolveContainedRealPath(
  root,
  target,
  {
    allowRoot = true,
    missingMessage = "path was not found",
    outsideMessage = "path is outside the allowed root",
  } = {},
) {
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(target);
  if (
    lexicalTarget !== lexicalRoot
    && !lexicalTarget.startsWith(`${lexicalRoot}/`)
  ) {
    const error = new Error(outsideMessage);
    error.statusCode = 403;
    throw error;
  }

  let canonicalRoot;
  let canonicalTarget;
  try {
    [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalTarget),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missingError = new Error(missingMessage);
      missingError.statusCode = 404;
      throw missingError;
    }
    throw error;
  }

  if (
    (!allowRoot && canonicalTarget === canonicalRoot)
    || (
      canonicalTarget !== canonicalRoot
      && !canonicalTarget.startsWith(`${canonicalRoot}/`)
    )
  ) {
    const error = new Error(outsideMessage);
    error.statusCode = 403;
    throw error;
  }
  return canonicalTarget;
}

/**
 * Resolve `target` to its real path, requiring it to live inside one of
 * `roots`. Each root is canonicalized before the check, so a symlink planted
 * inside a root cannot be used to escape it. A target the root list does not
 * cover fails with the first root's 403; a target that is lexically inside a
 * root but absent reports its 404 rather than falling through to the next root.
 */
export async function resolveWithinRoots(roots, target, options = {}) {
  let outside;
  for (const root of roots) {
    try {
      return await resolveContainedRealPath(root, target, options);
    } catch (error) {
      if (error.statusCode !== 403) throw error;
      outside = error;
    }
  }
  throw outside ?? Object.assign(
    new Error(options.outsideMessage || "path is outside the allowed read roots"),
    { statusCode: 403 },
  );
}

export function createDownloadHandler({
  ApiError,
  artifactsRoot,
  mimeTypes,
  downloadRoots,
}) {
  return async function handleDownload(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/remote/files/download") {
      const requestedPath = url.searchParams.get("path");
      if (typeof requestedPath !== "string" || !requestedPath || requestedPath.length > 4096) {
        throw new ApiError(400, "download path is invalid");
      }
      const filePath = await resolveWithinRoots(downloadRoots, requestedPath, {
        allowRoot: false,
        missingMessage: "download file was not found",
        outsideMessage: "path is outside the allowed read roots",
      });
      const info = await stat(filePath);
      if (!info.isFile()) throw new ApiError(404, "download file was not found");
      const originalName = basename(filePath);
      const safeName = originalName.replace(/[\r\n"]/g, "_");
      const disposition = url.searchParams.get("inline") === "1" ? "inline" : "attachment";
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
        "Content-Length": info.size,
        "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(filePath).pipe(response);
      return true;
    }

    if (request.method !== "GET" || url.pathname !== "/api/remote/artifacts/download") {
      return false;
    }
    const artifactId = url.searchParams.get("id");
    if (
      typeof artifactId !== "string"
      || !artifactId
      || artifactId.length > 200
      || /[\\/\u0000-\u001f]/.test(artifactId)
    ) throw new ApiError(400, "artifact id is invalid");

    const canonicalIndex = await resolveContainedRealPath(
      artifactsRoot,
      resolve(artifactsRoot, artifactId, "index.html"),
      {
        missingMessage: "artifact was not found",
        outsideMessage: "artifact path is outside the artifact store",
      },
    );
    const info = await stat(canonicalIndex);
    if (!info.isFile() || extname(canonicalIndex).toLowerCase() !== ".html") {
      throw new ApiError(404, "artifact HTML was not found");
    }
    const downloadName = `${artifactId}.html`;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="artifact.html"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      "Content-Length": info.size,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(canonicalIndex).pipe(response);
    return true;
  };
}
