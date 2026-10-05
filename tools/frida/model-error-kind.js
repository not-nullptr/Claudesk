'use strict';
// Catch the Foundation DecodingError the app wraps in ModelDecodingError.
//
// ModelDecodingError stores its cause as `error: any Error` (offset +32) and
// derives its `kind` from it in ClaudeApiServices. That classifier is the one
// place the cause is still alive, and it is app code called once per error — not
// a hot runtime function. It is reached here by address, because the binary is
// stripped: VM 0x101112d54 at image base 0x100000000, so module base + 0x1112d54.
//
// Why the earlier hooks missed it: on this OS Foundation's JSONDecoder lives in
// swift-foundation, where `DecodingError.Context.init` and the case factories
// are `@inlinable` — inlined at every call site, never called as exported
// functions, so `Module.findGlobalExportByName` hooks install and never fire.
// The cause is still a real Foundation DecodingError; it just has to be read out
// of the value, not caught at construction.
//
// The classifier is `FUN_101112d54`; it `swift_dynamicCast`s the cause to
// `DecodingError` and returns 2 (not one), 1 (a DecodingError, or dataCorrupted
// with a non-empty coding path) or 0 (dataCorrupted, empty path) — and arm 1 is
// what prints as `kind: unexpected_schema`.
//
// Run:  frida -U -f com.anthropic.claude -l tools/frida/model-error-kind.js
//       frida -H <phone-ip>:27042 -n Gadget -l tools/frida/model-error-kind.js

const TAG = 'claudesk-kind';
const log = (...parts) => console.log(`${TAG}: ${parts.join(' ')}`);

const CLASSIFIER_OFFSET = 0x1112d54; // FUN_101112d54; image base 0x100000000

function readBytes(address, length) {
  try {
    if (!address || address.isNull() || !Process.findRangeByAddress(address)) return null;
    const raw = address.readByteArray(length);
    return raw ? new Uint8Array(raw) : null;
  } catch (error) { return null; }
}

function u64(bytes, at) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[at + i]);
  return value;
}

function ascii(bytes, count) {
  if (count <= 0 || count > bytes.length) return null;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const byte = bytes[i];
    if (byte < 0x20 || byte > 0x7e) return null;
    out += String.fromCharCode(byte);
  }
  return out || null;
}

// Memory-only: no ObjC runtime calls, so a wrong guess is a null, not a crash.
function readSwiftString(address) {
  const bytes = readBytes(address, 16);
  if (!bytes) return null;
  const last = bytes[15];
  if ((last >> 4) === 0xe || (last & 0xf) === 0xe) {
    let longest = null;
    for (let count = 1; count <= 15; count += 1) {
      const text = ascii(bytes, count);
      if (!text) break;
      longest = text;
    }
    return longest;
  }
  const hi = u64(bytes, 8);
  if ((hi & 0x8000000000000000n) !== 0n) return null;
  const object = ptr(hi.toString());
  if (object.isNull()) return null;
  for (const [countAt, bytesAt] of [[16, 32], [24, 32], [16, 24]]) {
    const header = readBytes(object.add(countAt), 8);
    if (!header) continue;
    const count = Number(u64(header, 0) & 0x0000ffffffffffffn);
    if (!count || count > 8192) continue;
    const storage = readBytes(object.add(bytesAt), count);
    const text = storage ? ascii(storage, count) : null;
    if (text) return text;
  }
  return null;
}

// Walk the value and, one level down, whatever its words point at, collecting
// every Swift String. The cause is a `DecodingError`: its `Context`'s
// `debugDescription` names the key for keyNotFound, and its coding path's
// `CodingKey`s carry the name for the rest — either way it is in these strings.
function harvest(address, depth, seen, out) {
  if (depth < 0 || !address || address.isNull()) return;
  const key = address.toString();
  if (seen.has(key)) return;
  seen.add(key);
  const bytes = readBytes(address, 96);
  if (!bytes) return;
  for (let at = 0; at < 96; at += 8) {
    const text = readSwiftString(address.add(at));
    if (text && text.length > 2) out.add(text);
    if (depth > 0) {
      const target = u64(bytes, at) & 0x0000ffffffffffffn;
      if (target > 0x100000000n && target < 0x2000000000000n) {
        try { harvest(ptr(target.toString()), depth - 1, seen, out); } catch (error) {}
      }
    }
  }
}

function stringsAround() {
  const seen = new Set();
  const out = new Set();
  for (let index = 0; index < arguments.length; index += 1) {
    harvest(arguments[index], 2, seen, out);
  }
  return [...out];
}

const CONSTRUCTOR_OFFSET = 0x11138a8; // FUN_1011138a8, ModelDecodingError.init

let calls = 0;
function hook(base, offset, label) {
  const target = base.add(offset);
  log(`${label} @ ${target}`);
  Interceptor.attach(target, {
    onEnter(args) {
      try {
        calls += 1;
        const found = stringsAround(args[0], args[1], args[2], args[3]);
        if (calls <= 200) {
          log(`${label} call #${calls} x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]} strings=${JSON.stringify(found.slice(0, 10))}`);
        }
      } catch (error) { /* never disturb the app */ }
    },
  });
}

function install() {
  const base = Module.findBaseAddress('Claude');
  if (base === null) { log('Claude module not found'); return; }
  hook(base, CLASSIFIER_OFFSET, 'classifier');
  hook(base, CONSTRUCTOR_OFFSET, 'constructor');
  log('installed');
}

install();
