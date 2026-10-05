'use strict';
// Print the coding path of the Foundation DecodingError behind a
// ClaudeApiServices.ModelDecodingError.
//
// The `kind` classifier is inlined into the description builder, so hooking it
// (or the description builder by address) never fires — but the
// `ModelDecodingError: CustomStringConvertible` description witness is NOT
// inlined, and Sentry calls it to serialise the event. Its `self` is the
// ModelDecodingError struct, whose `error` field holds the boxed DecodingError,
// whose `Context.codingPath` names the failing key. So: hook the witness thunk,
// harvest strings out of `self`, and the coding-path keys fall out.
//
// Address: image base 0x100000000, so module base + 0x1113880.
//
// Run:
//   frida -U -f com.anthropic.claude -l tools/frida/decode-error-path.js
// then send. Lines to look for: `claudesk-dec`.

(function () {
const TAG = 'claudesk-dec';
const log = (...parts) => console.log(`${TAG}: ${parts.join(' ')}`);

const DESCRIPTION_THUNK = 0x1113880;  // FUN_101113880 — CustomStringConvertible witness
const CONSTRUCTOR = 0x11138a8;        // FUN_1011138a8 — ModelDecodingError.init

function safeRead(address, length) {
  try {
    if (!address || address.isNull()) return null;
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
function smallString(bytes) {
  for (const [tagAt, order] of [
    [7, [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]],
    [15, [8, 9, 10, 11, 12, 13, 14, 0, 1, 2, 3, 4, 5, 6]],
  ]) {
    const tag = bytes[tagAt];
    if ((tag >> 4) !== 0xe) continue;
    const count = tag & 0x0f;
    if (count === 0 || count > 15) continue;
    let out = '';
    let ok = true;
    for (let i = 0; i < count; i += 1) {
      const byte = bytes[order[i]];
      if (byte < 0x20 || byte > 0x7e) { ok = false; break; }
      out += String.fromCharCode(byte);
    }
    if (ok && out.length === count) return out;
  }
  return null;
}
function readSwiftString(address) {
  const bytes = safeRead(address, 16);
  if (!bytes) return null;
  const small = smallString(bytes);
  if (small) return small;
  const hi = u64(bytes, 8);
  if ((hi & 0x8000000000000000n) !== 0n) return null;
  const object = ptr(hi.toString());
  if (object.isNull()) return null;
  for (const [countAt, bytesAt] of [[16, 32], [24, 32], [16, 24]]) {
    const header = safeRead(object.add(countAt), 8);
    if (!header) continue;
    const count = Number(u64(header, 0) & 0x0000ffffffffffffn);
    if (!count || count > 4096) continue;
    const storage = safeRead(object.add(bytesAt), count);
    const text = storage ? ascii(storage, count) : null;
    if (text) return text;
  }
  return null;
}

const REGION = 160, MAX_DEPTH = 6, BUDGET = 4000;
function harvest(address, depth, seen, out, budget) {
  if (depth < 0 || budget.left <= 0 || !address || address.isNull()) return;
  const key = address.toString();
  if (seen.has(key)) return;
  seen.add(key);
  const bytes = safeRead(address, REGION);
  budget.left -= 1;
  if (!bytes) return;
  for (let at = 0; at < REGION; at += 8) {
    if (budget.left <= 0) return;
    const text = readSwiftString(address.add(at));
    if (text && text.length > 1) out.add(text);
    if (depth > 0) {
      const target = u64(bytes, at) & 0x0000ffffffffffffn;
      if (target > 0x100000000n && target < 0x2000000000000n) {
        harvest(ptr(target.toString()), depth - 1, seen, out, budget);
      }
    }
  }
}
function stringsAround(a, b, c, d) {
  const seen = new Set(), out = new Set(), budget = { left: BUDGET };
  for (const arg of [a, b, c, d]) harvest(arg, MAX_DEPTH, seen, out, budget);
  return [...out];
}

let calls = 0;
function hook(base, offset, label) {
  const target = base.add(offset);
  log(`${label} @ ${target}`);
  Interceptor.attach(target, {
    onEnter(args) {
      try {
        calls += 1;
        if (calls > 400) return;
        // Swift's method convention passes `self` in x20 — NOT x0 (which here is
        // the reused sret buffer). Harvest x20 first, then the arg registers.
        const ctx = this.context;
        const self = ctx.x20;
        const found = stringsAround(
          ctx.x20, ctx.x19, ctx.x21, ctx.x22, ctx.x23, ctx.x8,
          args[0], args[1], args[2], args[3]);
        const keys = [...new Set(found.filter((s) => s.length <= 32 &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)))].slice(0, 25);
        const msgs = [...new Set(found.filter((s) => s.length > 32))].slice(0, 4);
        log(`${label} #${calls} self=${self} x0=${args[0]}`);
        log(`   keys=${JSON.stringify(keys)}`);
        if (msgs.length) log(`   msgs=${JSON.stringify(msgs)}`);
      } catch (error) { /* never disturb the app */ }
    },
  });
}

const mod = Process.findModuleByName('Claude');
if (!mod) {
  log('Claude module not found');
} else {
  hook(mod.base, DESCRIPTION_THUNK, 'description');
  hook(mod.base, CONSTRUCTOR, 'ctor');
  log('installed — now send a message');
}
})();
