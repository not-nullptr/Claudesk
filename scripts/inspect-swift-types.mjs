#!/usr/bin/env node
// Name-addressable Swift type reader for the extracted Claude.app executable.
//
// The Code surface's request/response shapes are Swift `Codable` types, and the
// only thing that decides whether a response decodes is which of a type's
// fields are non-Optional: an absent or null non-Optional field throws
// ClaudeApiServices.ModelDecodingError, an absent Optional one is fine. This
// reads those fields and their types straight from the image's metadata, so a
// route's shape can be checked offline instead of probed against the device.
//
//   node scripts/inspect-swift-types.mjs --grep ChannelMessage
//   node scripts/inspect-swift-types.mjs SendChannelMessageResponse CreateSessionRequest
//   node scripts/inspect-swift-types.mjs --sections
//   node scripts/inspect-swift-types.mjs --path /somewhere/Claude SomeType
//
// Default executable: the one this repo's RE scripts extract to. Override with
// --path or CLAUDE_EXECUTABLE.
//
// Field types are Swift *symbolic references* (a NUL-terminated mangling with
// 0x01/0x02 escape bytes), not C strings -- reading them as C strings yields
// garbage, which is how the older swifttypes.mjs in /workspace/ipa-work/ loses
// every non-trivial field type. The `render` below resolves them instead:
// 0x02 + chained-rebase goes through the pointer to a type descriptor, whose
// `+8` is its name; the mangling tail still tells Optional (`Sg`) from not.
import { readFileSync } from "node:fs";

let BINARY = process.env.CLAUDE_EXECUTABLE
  || "/workspace/ipa-work/extracted/Payload/Claude.app/Claude";
const args = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--path=")) BINARY = a.slice("--path=".length);
  else if (a.startsWith("--binary=")) BINARY = a.slice("--binary=".length);
  else args.push(a);
}
const DATA = readFileSync(BINARY);
const BASE = 0x100000000;

const sects = [];
{
  let off = 32;
  for (let i = 0; i < DATA.readUInt32LE(16); i++) {
    const cmd = DATA.readUInt32LE(off);
    const size = DATA.readUInt32LE(off + 4);
    if (cmd === 0x19) { // LC_SEGMENT_64
      const seg = DATA.subarray(off + 8, off + 24).toString("latin1").split("\0")[0];
      for (let j = 0; j < DATA.readUInt32LE(off + 64); j++) {
        const s = off + 72 + j * 80;
        sects.push({
          seg,
          name: DATA.subarray(s, s + 16).toString("latin1").split("\0")[0],
          addr: Number(DATA.readBigUInt64LE(s + 32)),
          length: Number(DATA.readBigUInt64LE(s + 40)),
          fo: DATA.readUInt32LE(s + 48),
        });
      }
    }
    off += size;
  }
}

function fileOffset(a) {
  for (const s of sects) if (a >= s.addr && a < s.addr + s.length) return s.fo + a - s.addr;
  throw new Error("unmapped " + a.toString(16));
}
const i32 = (a) => DATA.readInt32LE(fileOffset(a));
const u16 = (a) => DATA.readUInt16LE(fileOffset(a));
const u32 = (a) => DATA.readUInt32LE(fileOffset(a));
const rel = (a) => a + i32(a);
const u64 = (a) => DATA.readBigUInt64LE(fileOffset(a));
function cstr(a) {
  const s = fileOffset(a);
  return DATA.subarray(s, DATA.indexOf(0, s)).toString("utf8");
}
const printable = (s) => s.length > 0 && /^[\x20-\x7e]+$/.test(s);

// One symbolic reference -> a list of literal mangling chunks and ref markers.
function symref(address) {
  const out = [];
  let text = [];
  for (let guard = 0; guard < 4096; guard++) {
    const b = DATA[fileOffset(address)];
    if (b === 0) break;
    if (b === 1 || b === 2) {
      if (text.length) { out.push(Buffer.from(text).toString("utf8")); text = []; }
      const target = rel(address + 1);
      if (b === 2) {
        const ptr = u64(target);
        if (ptr >> 63n) { out.push("IMPORT:" + ptr.toString(16)); address += 5; continue; }
        out.push("REF:" + (Number(ptr & 0xffffffffn) + BASE).toString(16));
      } else {
        out.push("REF:" + target.toString(16));
      }
      address += 5;
    } else { text.push(b); address += 1; }
  }
  if (text.length) out.push(Buffer.from(text).toString("utf8"));
  return out;
}

// __swift5_types / __swift5_types2: 4-byte relative pointers to context
// descriptors. Name is at descriptor+8, the field descriptor at +16.
const TYPE_SECTIONS = ["__swift5_types", "__swift5_types2"];
function typeIndex() {
  const byName = new Map();
  const byAddr = new Map();
  for (const sn of TYPE_SECTIONS) {
    const s = sects.find((x) => x.name === sn);
    if (!s) continue;
    for (let a = s.addr; a < s.addr + s.length; a += 4) {
      const d = i32(a);
      if (!d) continue;
      const desc = a + d;
      let name;
      try { name = cstr(rel(desc + 8)); } catch { continue; }
      if (!printable(name) || !/^[A-Za-z_][\w.]*$/.test(name)) continue;
      // Nominal kind sits at 0x10/0x11/0x12 for class/struct/enum in this image.
      const kind = u32(desc) & 0x1f;
      if (!byName.has(name)) byName.set(name, { desc, kind });
      byAddr.set(desc, name);
    }
  }
  return { byName, byAddr };
}

const KIND = { 16: "class", 17: "struct", 18: "enum" };

// Chained-rebase imports are ordinals into the shared cache; only the ones this
// surface actually uses are worth naming. Date is the one that matters for the
// Code DTOs (every timestamp is Foundation.Date, Optional or not).
const IMPORTS = { [0x8010000000000733n.toString(16)]: "Date" };
const nameOfImport = (hex) => IMPORTS[hex] || `<import:${hex}>`;

// Render one field's type tokens the way Swift renders a symbol graph: symbolic
// references become `{TypeName}`, the remaining literal chunks stay as the
// mangling. Only the Optional wrapper is spelled out, because it is the one bit
// that decides whether an absent value decodes -- and translating mangling
// wholesale corrupts names (`Sd` inside `PermissionMode` becoming `Double`), so
// only whole-token codes are translated.
const WHOLE = {
  SS: "String", Sb: "Bool", Si: "Int", Sd: "Double", Sf: "Float",
  Sg: "?", SSSg: "String?", SbSg: "Bool?",
};
function renderField(tokens, byAddr) {
  const text = tokens
    .map((t) => (t.startsWith("REF:")
      ? `{${byAddr.get(parseInt(t.slice(4), 16)) || t.slice(4)}}`
      : t.startsWith("IMPORT:") ? `{${nameOfImport(t.slice(7))}}` : t))
    .join("");
  let display = WHOLE[text];
  if (!display) {
    const array = text.match(/^Say(.*)G(Sg)?$/);
    display = array ? `[${array[1]}]${array[2] ? "?" : ""}` : text;
  }
  const optional = text.endsWith("Sg");
  return { display, optional };
}

function dumpFields(desc, byAddr) {
  const fd = rel(desc + 16);
  const rsize = u16(fd + 10);
  const n = u32(fd + 12);
  if (![0, 8, 12].includes(rsize) || n > 5000) return { fd, rsize, n: 0, rows: [] };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const rec = fd + 16 + i * rsize;
    const name = cstr(rel(rec + 8));
    const { display, optional } = u32(rec + 4)
      ? renderField(symref(rel(rec + 4)), byAddr)
      : { display: "", optional: false };
    rows.push({ name, type: display, optional });
  }
  return { fd, rsize, n, rows };
}

const { byName, byAddr } = typeIndex();

if (args[0] === "--sections") {
  for (const s of sects) console.log(`${s.seg.padEnd(12)} ${s.name.padEnd(18)} ${s.addr.toString(16)} len=${s.length}`);
  process.exit(0);
}
if (args[0] === "--grep") {
  const re = new RegExp(args[1], "i");
  for (const [name, meta] of [...byName].sort()) {
    if (!re.test(name)) continue;
    console.log(`${(KIND[meta.kind] ?? meta.kind).padEnd(6)} ${name}\t${meta.desc.toString(16)}`);
  }
  console.log(`# ${byName.size} types indexed`);
  process.exit(0);
}
if (!args.length) {
  console.error("usage: inspect-swift-types.mjs [--path EXE] [--grep RE | --sections | TypeName ...]");
  process.exit(2);
}

for (const name of args) {
  const meta = byName.get(name);
  if (!meta) { console.log(`\n${name}: not found in __swift5_types`); continue; }
  const { fd, n, rows } = dumpFields(meta.desc, byAddr);
  const required = rows.filter((r) => !r.optional);
  console.log(`\n${name}  (${KIND[meta.kind] ?? meta.kind}, fd=${fd.toString(16)}) fields=${n} required=${required.length}`);
  for (const r of rows) console.log(`  ${r.optional ? " " : "!"} ${r.name.padEnd(28)} ${r.type}`);
  if (required.length) console.log(`  required: ${required.map((r) => `${r.name}:${r.type}`).join(", ")}`);
}
