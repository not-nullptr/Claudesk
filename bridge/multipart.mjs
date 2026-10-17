// A streaming reader for multipart/form-data. Chat and Cowork attachments
// arrive that way, with the file as one part; the file part is handed to a
// writable as the bytes arrive, so a large attachment costs no memory. Only the
// parts this bridge needs (a file and a few small text fields) are supported:
// nested multipart bodies and parts without a Content-Disposition are refused
// rather than guessed at.
import { once } from "node:events";

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const maxHeaderBytes = 16 * 1024;

export function multipartBoundary(contentType) {
  if (typeof contentType !== "string" || !/^multipart\/form-data\b/i.test(contentType)) {
    return null;
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match ? match[1] || match[2] : "";
  return boundary && boundary.length <= 200 ? boundary : null;
}

function multipartError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function parsePartHeaders(header) {
  const disposition = /^content-disposition:[^\r\n]*$/im.exec(header)?.[0] ?? "";
  if (!disposition) throw multipartError("multipart part has no Content-Disposition");
  const name = /\bname="([^"]*)"/i.exec(disposition)?.[1]
    ?? /\bname=([^;\s]+)/i.exec(disposition)?.[1]
    ?? "";
  const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1]
    ?? (/\bfilename=([^;\s]+)/i.exec(disposition)?.[1]);
  const contentType = /^content-type:\s*([^\r\n]+)$/im.exec(header)?.[1]?.trim();
  return { name, filename, contentType };
}

/**
 * Reads a multipart body from an IncomingMessage.
 *
 * - `onFile(part)` is awaited for a part with a filename and must return a
 *   Writable (or any object with write/end/destroy). Bytes are written to it
 *   with backpressure, and it is ended before the next part begins.
 * - `onField(name, value)` is called for each non-file part.
 * - `maxBytes` bounds the whole body.
 */
export async function readMultipart(request, {
  maxBytes = Infinity,
  maxFieldBytes = 64 * 1024,
  // A browser form part carrying a Blob without an explicit filename still
  // grows a `filename="blob"`; callers that know which part is the payload say
  // so instead of inheriting that convention.
  isFile = (part) => part.filename !== undefined,
  onFile,
  onField = () => {},
} = {}) {
  const boundary = multipartBoundary(request.headers["content-type"]);
  if (!boundary) throw multipartError("expected a multipart/form-data body");
  if (typeof onFile !== "function") throw multipartError("multipart file handler is missing");

  const firstBoundary = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  let buffer = Buffer.alloc(0);
  let state = "preamble";
  let part = null;
  let sink = null;
  let fieldChunks = [];
  let fieldBytes = 0;
  let total = 0;
  let done = false;

  async function writeSink(data) {
    if (!data.length) return;
    if (!sink.write(data)) await once(sink, "drain");
  }

  async function endPart() {
    if (sink) {
      const ending = sink;
      sink = null;
      ending.end();
      await once(ending, "finish");
    } else if (part) {
      await onField(part.name, Buffer.concat(fieldChunks).toString("utf8"));
    }
    part = null;
    fieldChunks = [];
    fieldBytes = 0;
  }

  async function bodyData(data) {
    if (sink) {
      await writeSink(data);
      return;
    }
    fieldBytes += data.length;
    if (fieldBytes > maxFieldBytes) throw multipartError("multipart field is too large");
    if (data.length) fieldChunks.push(Buffer.from(data));
  }

  async function consume() {
    while (!done) {
      if (state === "preamble") {
        if (buffer.length < firstBoundary.length + 2) return;
        if (!buffer.subarray(0, firstBoundary.length).equals(firstBoundary)) {
          throw multipartError("invalid multipart preamble");
        }
        buffer = buffer.subarray(firstBoundary.length);
        if (buffer.subarray(0, 2).toString() === "--") {
          done = true;
          return;
        }
        if (!buffer.subarray(0, 2).equals(CRLF)) {
          throw multipartError("invalid multipart boundary");
        }
        buffer = buffer.subarray(2);
        state = "headers";
      } else if (state === "headers") {
        const index = buffer.indexOf(HEADER_END);
        if (index === -1) {
          if (buffer.length > maxHeaderBytes) throw multipartError("multipart headers are too large");
          return;
        }
        part = parsePartHeaders(buffer.subarray(0, index).toString("utf8"));
        buffer = buffer.subarray(index + HEADER_END.length);
        if (isFile(part)) {
          sink = await onFile(part);
        }
        state = "body";
      } else if (state === "body") {
        const index = buffer.indexOf(separator);
        if (index === -1) {
          // Keep enough tail that a delimiter split across chunks is still
          // found; everything before it is content.
          const safe = buffer.length - (separator.length - 1);
          if (safe > 0) {
            const data = buffer.subarray(0, safe);
            buffer = buffer.subarray(safe);
            await bodyData(data);
          }
          return;
        }
        await bodyData(buffer.subarray(0, index));
        buffer = buffer.subarray(index + separator.length);
        await endPart();
        state = "after";
      } else if (state === "after") {
        if (buffer.length < 2) return;
        if (buffer.subarray(0, 2).toString() === "--") {
          done = true;
          buffer = buffer.subarray(2);
          return;
        }
        if (!buffer.subarray(0, 2).equals(CRLF)) {
          throw multipartError("invalid multipart boundary");
        }
        buffer = buffer.subarray(2);
        state = "headers";
      }
    }
  }

  let failure = null;
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxBytes) throw multipartError("the upload is too large", 413);
      buffer = Buffer.concat([buffer, chunk]);
      await consume();
      if (done) break;
    }
    if (!done) {
      // Nothing more will arrive: resolve whatever the last chunk left behind.
      await consume();
    }
    if (!done) throw multipartError("the multipart body ended before its closing boundary");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (sink) {
      const unfinished = sink;
      sink = null;
      if (failure) unfinished.destroy();
    }
  }
}
