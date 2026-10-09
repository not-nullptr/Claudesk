import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// LibreOffice is the converter Desktop itself uses for Office previews (via the
// Cowork VM), so this sidecar reproduces that rendering rather than approximating
// it. It is deliberately stateless and isolated: it only ever sees bytes on a
// POST body, never a path, so it cannot reach the workspace or /config as a
// server — the bridge enforces the read roots and hands over file contents.
const port = Number(process.env.OFFICE_PREVIEW_PORT || 8090);
const host = process.env.OFFICE_PREVIEW_HOST || "127.0.0.1";
const sofficeBin = process.env.SOFFICE_BIN || "soffice";
const maxBytes = Number(process.env.OFFICE_PREVIEW_MAX_BYTES || 50 * 1024 * 1024);
const convertTimeoutMs = Number(process.env.OFFICE_PREVIEW_TIMEOUT_MS || 60_000);
const extensions = new Set([".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"]);
const PDF_MAGIC = Buffer.from("%PDF-");

// One conversion at a time: each soffice run is a full LibreOffice process, so
// serialising bounds the sidecar's memory instead of letting a burst of previews
// spawn several at once.
let queue = Promise.resolve();
function serialize(run) {
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function convert(bytes, extension) {
  const workDir = await mkdtemp(join(tmpdir(), "office-preview-"));
  const inputName = `input${extension}`;
  // Excel sheets are exported one-per-page, matching the filter Desktop passes,
  // so a workbook keeps its sheet structure instead of paginating arbitrarily.
  const filter = extension === ".xlsx" || extension === ".xls"
    ? 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}'
    : "pdf";
  try {
    await writeFile(join(workDir, inputName), bytes, { mode: 0o600 });
    await runSoffice([
      "--headless", "--norestore", "--nologo", "--nofirststartwizard",
      `-env:UserInstallation=file://${join(workDir, "lo-profile")}`,
      "--convert-to", filter,
      "--outdir", workDir,
      join(workDir, inputName),
    ], workDir);
    const pdf = await readFile(join(workDir, "input.pdf")).catch(() => null);
    if (!pdf || pdf.length < PDF_MAGIC.length || !pdf.subarray(0, 5).equals(PDF_MAGIC)) {
      throw new Error("soffice produced no valid PDF");
    }
    return pdf;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runSoffice(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(sofficeBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => { output = (output + chunk).slice(-2000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("soffice timed out"));
    }, convertTimeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`soffice exited ${code}: ${output.trim().slice(-300)}`));
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("request body is too large");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, "application/json", Buffer.from('{"ok":true}'));
      return;
    }
    const match = request.method === "POST" && request.url?.match(/^\/convert\/(\.[a-z0-9]+)$/);
    if (!match) {
      send(response, 404, "text/plain; charset=utf-8", Buffer.from("not found"));
      return;
    }
    const extension = match[1];
    if (!extensions.has(extension)) {
      send(response, 415, "text/plain; charset=utf-8", Buffer.from("unsupported extension"));
      return;
    }
    const bytes = await readBody(request);
    const pdf = await serialize(() => convert(bytes, extension));
    console.log(`[office-preview] converted ${extension} (${bytes.length}b -> ${pdf.length}b)`);
    send(response, 200, "application/pdf", pdf);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(`[office-preview] ${error.message}`);
    send(response, status, "text/plain; charset=utf-8", Buffer.from(error.message));
  }
});

server.listen(port, host, () => {
  console.log(`[office-preview] listening on ${host}:${port}`);
});
