#!/usr/bin/env node
// Build an instrumented copy of the Claude IPA that loads FridaGadget. Feather
// only has to sign and install it: the gadget and its config are already inside
// the bundle, so no Mac, no USB and no frida-server are involved.
//
// What it does, in order:
//   1. ensure the FridaGadget dylib for iOS is on disk (download + xz + thin);
//   2. stage the app, drop the gadget / config (/ probe) into Frameworks/;
//   3. add one LC_LOAD_DYLIB to the main binary so dyld loads the gadget;
//   4. repackage Payload/ as an .ipa.
//
// Usage — listen mode (recommended: attach and iterate with no re-signing):
//   node tools/frida/build-instrumented-ipa.mjs \
//     --app /workspace/ipa-work/extracted/Payload/Claude.app \
//     --out /workspace/RemoteUploads/Claude-frida.ipa \
//     --interaction listen
//   then, with the app running:  frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js
//
// Usage — script mode (no host at all; findings POST to the facade):
//   node tools/frida/build-instrumented-ipa.mjs \
//     --app /workspace/ipa-work/extracted/Payload/Claude.app \
//     --out /workspace/RemoteUploads/Claude-frida.ipa \
//     --report-url https://<your-claudesk-host> --token <secret>
//
// The gadget version is pinned: the Swift ApiResolver only grew nominal-type /
// protocol / conformance queries in 17.21.0, which is the whole reason for
// doing this instead of more static RE.
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FRIDA_VERSION = "17.21.0";
const GADGET_NAME = "FridaGadget.dylib";
const LOAD_PATH = `@executable_path/Frameworks/${GADGET_NAME}`;
const LC_LOAD_DYLIB = 0x0c;

function arg(name, fallback = null) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const appDir = arg("app");
const outIpa = arg("out");
const reportUrl = arg("report-url");
const token = arg("token");
const cacheDir = arg("cache", "/tmp/claudesk-frida");
// "script" bakes probe.js into the bundle and has it POST findings to
// --report-url (no host; works from any network). "listen" opens a port on the
// device instead, for a controller on the same network to attach to with
// `frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js` — nothing is
// baked in, so the script can be re-loaded and edited without re-signing.
const interaction = arg("interaction", "script");
const listenAddress = arg("address", "0.0.0.0");
const listenPort = Number(arg("port", "27042"));
if (interaction !== "script" && interaction !== "listen") {
  console.error(`--interaction must be "script" or "listen", not ${interaction}`);
  process.exit(2);
}
if (!appDir || !outIpa || (interaction === "script" && (!reportUrl || !token))) {
  console.error("need --app --out, plus --report-url --token when --interaction script");
  process.exit(2);
}

// --------------------------------------------------------------- gadget fetch
// The released gadget is xz-compressed and universal (arm64 + arm64e); iOS will
// not load a fat image from a sideloaded bundle, so we thin it to the arm64
// slice. There is no xz on this box, so a static busybox supplies the
// decompressor — fetched once into the cache dir.
function ensureBusybox() {
  const path = join(cacheDir, "busybox");
  if (existsSync(path)) return path;
  mkdirSync(cacheDir, { recursive: true });
  const url = "https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox";
  execFileSync("curl", ["-sSL", "-o", path, url], { stdio: "inherit" });
  execFileSync("chmod", ["+x", path]);
  return path;
}

function thinArm64(fat) {
  const magic = fat.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = fat.readUInt32BE(4);
    for (let i = 0; i < count; i += 1) {
      const at = 8 + i * 20;
      const cpuType = fat.readUInt32BE(at);
      const cpuSub = fat.readUInt32BE(at + 4);
      const offset = fat.readUInt32BE(at + 8);
      const size = fat.readUInt32BE(at + 12);
      // arm64 (subtype 0) runs on every device we care about; prefer it over
      // the arm64e slice, which only newer silicon executes.
      if (cpuType === 0x0100000c && (cpuSub & 0xff) === 0) return fat.subarray(offset, offset + size);
    }
    throw new Error("no arm64 slice in the gadget");
  }
  return fat;
}

function ensureGadget() {
  const path = join(cacheDir, GADGET_NAME);
  if (existsSync(path)) return readFileSync(path);
  mkdirSync(cacheDir, { recursive: true });
  const xz = join(cacheDir, `gadget-${FRIDA_VERSION}.dylib.xz`);
  if (!existsSync(xz)) {
    const url = `https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/` +
      `frida-gadget-${FRIDA_VERSION}-ios-universal.dylib.xz`;
    execFileSync("curl", ["-sSL", "-o", xz, url], { stdio: "inherit" });
  }
  const raw = join(cacheDir, "gadget-fat.dylib");
  const out = execFileSync(ensureBusybox(), ["xz", "-dc", xz], { maxBuffer: 1 << 30 });
  writeFileSync(raw, out);
  const thin = thinArm64(readFileSync(raw));
  writeFileSync(path, thin);
  console.log(`gadget thinned to arm64: ${thin.length} bytes`);
  return thin;
}

// -------------------------------------------------------------- Mach-O patch
// The main binary has ~1KB of zero padding between the load commands and the
// first section, so the extra command fits without shifting anything. The
// existing code signature covers the old header and is invalid from here on —
// Feather re-signs the bundle, which is the point of handing it the finished
// IPA rather than a tweak.
function addLoadCommand(binary) {
  const ncmds = binary.readUInt32LE(16);
  const sizeofcmds = binary.readUInt32LE(20);
  const end = 32 + sizeofcmds;
  const path = Buffer.from(`${LOAD_PATH}\0`, "utf8");
  const size = (24 + path.length + 7) & ~7;
  let firstSection = Infinity;
  for (let at = 32, i = 0; i < ncmds; i += 1) {
    const command = binary.readUInt32LE(at);
    if (command === LC_LOAD_DYLIB) {
      const nameAt = at + binary.readUInt32LE(at + 16);
      if (binary.subarray(nameAt, nameAt + LOAD_PATH.length).toString("utf8") === LOAD_PATH) {
        return binary; // already instrumented
      }
    }
    if (command === 0x19 /* LC_SEGMENT_64 */) {
      const sections = binary.readUInt32LE(at + 64);
      for (let s = 0; s < sections; s += 1) {
        const offset = binary.readUInt32LE(at + 72 + s * 80 + 48);
        if (offset > 0 && offset < firstSection) firstSection = offset;
      }
    }
    at += binary.readUInt32LE(at + 4);
  }
  if (firstSection - end < size) throw new Error(`no room for the load command (${firstSection - end} bytes)`);
  const command = Buffer.alloc(size);
  command.writeUInt32LE(LC_LOAD_DYLIB, 0);
  command.writeUInt32LE(size, 4);
  command.writeUInt32LE(24, 8); // dylib.name.offset
  command.writeUInt32LE(0, 12); // timestamp
  command.writeUInt32LE(0, 16); // current_version
  command.writeUInt32LE(0, 20); // compatibility_version
  path.copy(command, 24);
  command.copy(binary, end);
  binary.writeUInt32LE(ncmds + 1, 16);
  binary.writeUInt32LE(sizeofcmds + size, 20);
  return binary;
}

// ------------------------------------------------------------------ zip (IPA)
// Node has no zip writer and this box has no `zip`, but raw deflate is exactly
// ZIP method 8, so the archive is assembled directly. Stored mode would also
// work; deflating keeps the ~120MB IPA to something the phone can download.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function walk(root, dir = root, files = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(root, full, files);
    else files.push({ path: relative(root, full).split("\\").join("/"), full, mode: info.mode });
  }
  return files;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const raw = readFileSync(entry.full);
    const data = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date: fixed, not meaningful here
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    central.push({ name, crc, compressed: data.length, uncompressed: raw.length, offset, mode: entry.mode });
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  for (const entry of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4); // made by: UNIX
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(0, 12);
    head.writeUInt32LE(entry.crc, 16);
    head.writeUInt32LE(entry.compressed, 20);
    head.writeUInt32LE(entry.uncompressed, 24);
    head.writeUInt16LE(entry.name.length, 28);
    // External attributes hold the unix mode in the high half; `>>> 0` keeps the
    // sign bit from making this negative once the file-type bits are in play.
    head.writeUInt32LE((((entry.mode & 0xffff) << 16) >>> 0), 38);
    head.writeUInt32LE(entry.offset, 42);
    chunks.push(head, entry.name);
    offset += head.length + entry.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------- main
const gadget = ensureGadget();
// Stage under its own root so the archive walk sees exactly `Payload/…` and not
// the gadget/cache files sitting beside it.
const stageRoot = join(cacheDir, "build");
const stage = join(stageRoot, "Payload");
const stagedApp = join(stage, "Claude.app");
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(appDir, stagedApp, { recursive: true });

const frameworks = join(stagedApp, "Frameworks");
mkdirSync(frameworks, { recursive: true });
writeFileSync(join(frameworks, GADGET_NAME), gadget);
const probe = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "probe.js"));
// The config is discovered by matching the gadget's filename with a `.config`
// suffix; the script path stays relative so it resolves beside the gadget
// wherever the bundle lands (we cannot know the on-device UUID path). On iOS
// Frida additionally looks for the config in the *parent* of a `Frameworks`
// directory, and resolves a relative script against whichever directory it
// found the config in — so both files go in both places rather than betting on
// one resolution order.
//
// on_load: the default ("wait") holds the app at its entrypoint until a
// controller connects, which risks the launch watchdog if we are slow to
// attach. "resume" lets it boot normally; the Code tab flow happens on a tap,
// long after attach.
const config = JSON.stringify(interaction === "script" ? {
  interaction: { type: "script", path: "probe.js", on_change: "ignore", parameters: { reportUrl, token } },
  teardown: "minimal",
} : {
  interaction: {
    type: "listen",
    address: listenAddress,
    port: listenPort,
    on_port_conflict: "fail",
    on_load: "resume",
  },
  teardown: "minimal",
}, null, 2);
for (const dir of [frameworks, stagedApp]) {
  // In listen mode nothing is baked in: the controller supplies the script, and
  // shipping a stale copy next to the config would only invite confusion about
  // which one ran.
  if (interaction === "script") writeFileSync(join(dir, "probe.js"), probe);
  writeFileSync(join(dir, "FridaGadget.config"), config);
}

const binaryPath = join(stagedApp, "Claude");
writeFileSync(binaryPath, addLoadCommand(readFileSync(binaryPath)));

const entries = walk(stageRoot);
const zip = makeZip(entries);
writeFileSync(outIpa, zip);
console.log(`wrote ${outIpa} (${zip.length} bytes, ${entries.length} entries)`);
console.log(`gadget load path: ${LOAD_PATH}`);
console.log(interaction === "script"
  ? `interaction: script, reporting to ${reportUrl}/__diag (token ${token.slice(0, 4)}…)`
  : `interaction: listen on ${listenAddress}:${listenPort}, attach with ` +
    `frida -H <phone-ip>:${listenPort} -n Gadget -l tools/frida/probe.js`);
