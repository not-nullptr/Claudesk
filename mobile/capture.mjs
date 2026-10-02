// Optional request capture (CLAUDE_MOBILE_CAPTURE=1) for reverse engineering the
// parts of the iOS app this service does not implement yet (Cowork and Claude
// Code). It appends one JSON line per request to <data dir>/capture.jsonl:
// method, path, query parameter names, status, and, for requests the service
// does not handle, a redacted body. Turn it off again afterwards; the file lists
// everything the phone asked for.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const sensitiveKey = /token|cookie|authorization|password|secret|code|credential|email|signature|nonce|attestation/i;

export function redact(value, depth = 0) {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}…(${value.length})` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 60).map(
    ([key, item]) => [key, sensitiveKey.test(key) ? "<redacted>" : redact(item, depth + 1)],
  ));
}

// Reads up to maxBytes of a request body and describes it without keeping
// secrets: JSON is redacted, anything else is a length plus a short hex prefix.
export async function describeBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const contentType = String(request.headers["content-type"] || "");
  if (/json/i.test(contentType) && !/connect\+/i.test(contentType)) {
    try {
      return { json: redact(JSON.parse(bytes.toString("utf8"))), bytes: size };
    } catch {
      // fall through to the hex description
    }
  }
  return { bytes: size, hexPrefix: bytes.subarray(0, 96).toString("hex") };
}

export function createCapture({ dataDir, enabled = process.env.CLAUDE_MOBILE_CAPTURE === "1" }) {
  if (!enabled) return { enabled: false, record: async () => {} };
  const file = join(dataDir, "capture.jsonl");
  let ready = null;
  return {
    enabled: true,
    file,
    async record(entry) {
      ready ||= mkdir(dataDir, { recursive: true, mode: 0o700 });
      await ready;
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    },
  };
}
