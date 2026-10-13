// Move the Cowork VM's vsock port off its fixed default.
//
// The guest VM reaches the host over vsock: the guest-side `coworkd` dials
// (host CID 2, port 51234) and the host-side `cowork-linux-helper` listens on
// the same port. Both values are compile-time constants — the helper has no
// port flag, the app passes none, and no env var reaches either. Host-side
// vsock listeners go through the single host `/dev/vhost-vsock`, so the port is
// global per *host*, not per container or network namespace (a fresh netns still
// gets EADDRINUSE), and a listener cannot be scoped to a guest CID
// (EADDRNOTAVAIL). So on one host only one Cowork VM can run — unless each
// instance's pair is moved to a port of its own.
//
// This finds a port loaded as a 32-bit immediate (`mov $imm32,%e?x` / a `41 bb`
// REX form) and rewrites it. Go compiles such a constant straight into the
// instruction, so there is no string to match — the encoding is the target.
//
// Usage:
//   patch-vsock-port.mjs scan  --file F [--port P]        (report sites)
//   patch-vsock-port.mjs check --file F --port P [--default 51234] [--expect N]
//   patch-vsock-port.mjs patch --file F --port P [--default 51234] [--expect N]
//
// `check` and `patch` use --encoding (default `bb`, the helper's). `scan` walks
// every encoding, which is how a new artifact's site is identified.

import { open } from "node:fs/promises";

const defaultPort = 51234;

// x86-64 `mov $imm32,%r32` encodings we treat as a port load. `41 bb` is the
// REX-prefixed form Go emits for %r11d in some switch lowering.
const encodings = {
  bb: [0xbb],
  b8: [0xb8],
  b9: [0xb9],
  ba: [0xba],
  be: [0xbe],
  bf: [0xbf],
  "41bb": [0x41, 0xbb],
};

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const args = { mode, encoding: "bb", default: defaultPort, port: defaultPort };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
    args[key] = value;
    index += 1;
  }
  if (!args.file) throw new Error("--file is required");
  args.port = Number(args.port);
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 0xffffffff) {
    throw new Error("--port must be a port number");
  }
  if (args.expect !== undefined) {
    args.expect = Number(args.expect);
    if (!Number.isInteger(args.expect) || args.expect < 1) {
      throw new Error("--expect must be a positive integer");
    }
  }
  args.default = Number(args.default);
  if (args.encoding !== "all" && !encodings[args.encoding]) {
    throw new Error(`unknown --encoding ${args.encoding} (want ${Object.keys(encodings).join(", ")} or all)`);
  }
  return args;
}

function patternFor(encoding, port) {
  const opcode = Buffer.from(encodings[encoding]);
  const immediate = Buffer.alloc(4);
  immediate.writeUInt32LE(port >>> 0);
  return Buffer.concat([opcode, immediate]);
}

// Stream the file and return every offset where `pattern` begins. The overlap
// carries the tail of one chunk into the next so a match across the boundary is
// not missed.
async function findOffsets(path, pattern, limit = Infinity) {
  const handle = await open(path, "r");
  try {
    const chunkSize = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize + pattern.length);
    const offsets = [];
    let carry = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carry, chunkSize, position);
      if (bytesRead === 0) break;
      const length = carry + bytesRead;
      let from = 0;
      for (;;) {
        const index = buffer.subarray(from, length).indexOf(pattern);
        if (index === -1) break;
        offsets.push(position - carry + from + index);
        if (offsets.length >= limit) return offsets;
        from += index + 1;
      }
      carry = Math.min(pattern.length - 1, length);
      buffer.copy(buffer, 0, length - carry, length);
      position += bytesRead;
    }
    return offsets;
  } finally {
    await handle.close();
  }
}

// One pass over the file for every candidate pattern (encoding x port), since a
// disk image is far too large to re-read per pattern.
async function scan(args) {
  const encodingsToScan = args.encoding === "all" ? Object.keys(encodings) : [args.encoding];
  const patterns = new Map();
  for (const encoding of encodingsToScan) {
    for (const port of new Set([args.default, args.port])) {
      patterns.set(`${encoding}:${port}`, patternFor(encoding, port));
    }
  }
  const widest = Math.max(...[...patterns.values()].map((pattern) => pattern.length));
  const report = {};
  const handle = await open(args.file, "r");
  try {
    const chunkSize = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize + widest);
    let carry = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carry, chunkSize, position);
      if (bytesRead === 0) break;
      const length = carry + bytesRead;
      for (const [key, pattern] of patterns) {
        const offsets = report[key] ?? (report[key] = []);
        if (offsets.length >= 64) continue;
        let from = 0;
        for (;;) {
          const index = buffer.subarray(from, length).indexOf(pattern);
          if (index === -1) break;
          offsets.push(position - carry + from + index);
          if (offsets.length >= 64) break;
          from += index + 1;
        }
      }
      carry = Math.min(widest - 1, length);
      buffer.copy(buffer, 0, length - carry, length);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return report;
}

async function ensure(args, apply) {
  const pattern = patternFor(args.encoding, args.default);
  const target = patternFor(args.encoding, args.port);
  const present = await findOffsets(args.file, pattern);
  const already = await findOffsets(args.file, target);
  if (present.length === 0 && already.length > 0) {
    return { status: "already", sites: already.length };
  }
  if (present.length === 0) {
    return { status: "absent", sites: 0 };
  }
  if (args.expect !== undefined && present.length !== args.expect) {
    throw new Error(
      `expected ${args.expect} site(s) of port ${args.default} (encoding ${args.encoding}), found ${present.length}`,
    );
  }
  if (apply) {
    const immediate = Buffer.alloc(4);
    immediate.writeUInt32LE(args.port >>> 0);
    const handle = await open(args.file, "r+");
    try {
      for (const offset of present) {
        const opcodeLength = encodings[args.encoding].length;
        await handle.write(immediate, 0, 4, offset + opcodeLength);
      }
    } finally {
      await handle.close();
    }
  }
  return { status: apply ? "patched" : "patchable", sites: present.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "scan") {
    const report = await scan(args);
    for (const [key, offsets] of Object.entries(report)) {
      console.log(`${key}\t${offsets.length}\t${offsets.slice(0, 8).join(",")}`);
    }
    if (Object.keys(report).length === 0) console.log("(no sites)");
    return;
  }
  if (args.mode !== "check" && args.mode !== "patch") {
    throw new Error(`unknown mode ${args.mode}`);
  }
  const result = await ensure(args, args.mode === "patch");
  console.log(`${result.status}\t${result.sites}`);
  if (result.status === "absent" || result.status === "already") {
    process.exitCode = result.status === "already" ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(`patch-vsock-port: ${error.message}`);
  process.exit(2);
});
