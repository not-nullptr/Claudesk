// Offline check for the Swift `String` reader in decode-error-probe.js.
//
// The reader is the part of the probe that cannot be validated by reading it:
// `(_countAndFlags, _object)` has three shapes, the small one packs its tag and
// its count into the same nibble, and getting it wrong yields a plausible short
// string rather than an error. So the functions are lifted out of the probe and
// run against synthetic memory here, with Frida's `ptr`/`Process` stubbed.
//
//   node tools/frida/swift-string-harness.mjs
//
// It is deliberately wired to the real source text, not a copy: an edit to the
// probe that the harness does not follow is a change that stops being checked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "decode-error-probe.js"), "utf8");

// The block under test runs from the field reader to the error-name walk, and
// is contiguous in the probe. It ends where the code that needs Frida's symbol
// and mapping tables begins, so the boundary is a function name and not a
// comment — the reader is exercised here, the reporting around it is not.
const start = source.indexOf("function readBytesAt");
const end = source.indexOf("function underlyingError(");
assert.ok(start > 0 && end > start, "the field-reader block is still in the probe");
const block = source.slice(start, end);

// ------------------------------------------------------------ Frida stubs
const memory = new Map(); // bigint address -> Uint8Array
let nextAddress = 0x100000000n;

function put(bytes) {
  const address = nextAddress;
  nextAddress += 0x10000n; // keep allocations a page apart
  memory.set(address, Uint8Array.from(bytes));
  return address;
}

function rangeAt(address) {
  for (const [base, bytes] of memory) {
    if (address >= base && address < base + BigInt(bytes.length)) return { base, bytes };
  }
  return null;
}

const Process = { findRangeByAddress: (address) => rangeAt(BigInt(address)) };

function makePointer(address) {
  const value = BigInt(address);
  return {
    isNull: () => value === 0n,
    toString: () => `0x${value.toString(16)}`,
    add: (delta) => makePointer(value + BigInt(delta)),
    readByteArray: (length) => {
      const range = rangeAt(value);
      if (!range) throw new Error("unreadable");
      const offset = Number(value - range.base);
      const slice = range.bytes.subarray(offset, offset + length);
      if (slice.length < length) throw new Error("short read");
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length);
    },
  };
}

const ptr = (address) => makePointer(address);
const ObjC = { available: false };

const build = new Function(
  "Process", "ptr", "ObjC",
  `${block}\nreturn { readSwiftString, smallString, textOf, u64At, readBytesAt, readPointerAt };`,
);
const { readSwiftString } = build(Process, ptr, ObjC);

// ------------------------------------------------------- string encodings
// A small string: `_object`'s high nibble is 0xE and the count rides under it.
// Which nibble holds which is exactly the thing that is easy to get backwards,
// so both spellings are exercised.
function smallString(text, tagLowNibble) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  bytes[15] = tagLowNibble
    ? (0x0e | (text.length << 4))
    : (0xe0 | text.length);
  return bytes;
}

// A native string: a heap object whose UTF-8 sits behind a count word.
function nativeString(text, countAt = 16, bytesAt = 32) {
  const object = new Uint8Array(bytesAt + text.length);
  const write = (at, value) => {
    let v = BigInt(value);
    for (let i = 0; i < 8; i += 1) { object[at + i] = Number(v & 0xffn); v >>= 8n; }
  };
  write(countAt, text.length);
  for (let i = 0; i < text.length; i += 1) object[bytesAt + i] = text.charCodeAt(i);
  const objectAddress = put(object);

  const value = new Uint8Array(16);
  let hi = BigInt(objectAddress);
  for (let i = 0; i < 8; i += 1) { value[8 + i] = Number(hi & 0xffn); hi >>= 8n; }
  return value;
}

const read = (bytes) => readSwiftString(makePointer(put(bytes)));

// ------------------------------------------------------------------ checks
assert.equal(read(smallString("ChannelMessage", false)), "ChannelMessage");
assert.equal(read(smallString("ChannelMessage", true)), "ChannelMessage");
assert.equal(read(smallString("path", false)), "path");
assert.equal(read(smallString("a", false)), "a");
// The longest small string: fifteen bytes, tag in the sixteenth.
assert.equal(read(smallString("bound_sessions!", false)), "bound_sessions!");
assert.equal(read(nativeString("ChannelMessage.bound_sessions")), "ChannelMessage.bound_sessions");
assert.equal(read(nativeString("bound_sessions", 24, 32)), "bound_sessions");
assert.equal(read(nativeString("bound_sessions", 16, 24)), "bound_sessions");
// Garbage must not be dressed up as a string.
assert.equal(read(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
assert.equal(read(new Uint8Array(16)), null);
// An unreadable address is null, not a throw.
assert.equal(readSwiftString(makePointer(0xdead0000n)), null);

console.log("swift-string-harness: ok");
