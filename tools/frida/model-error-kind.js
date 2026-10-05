'use strict';
// Catch the Foundation DecodingError the app wraps in ModelDecodingError.
//
// ModelDecodingError stores its cause as `error: any Error` (offset +32) and
// derives its `kind` from it in ClaudeApiServices. That classifier is the one
// place the cause is still alive, and it is app code called once per error — not
// a hot runtime function. It is reached here by address, because the binary is
// stripped: VM 0x101112d54 / 0x1011138a8 at image base 0x100000000, so module
// base + 0x1112d54 / + 0x11138a8.
//
// Why the earlier hooks missed it: on this OS Foundation's JSONDecoder lives in
// swift-foundation, where `DecodingError.Context.init` and the case factories
// are `@inlinable` — inlined at every call site, never called as exported
// functions, so `Module.findGlobalExportByName` hooks install and never fire.
// The cause is still a real Foundation DecodingError, it just has to be read out
// of the value, not caught at construction.
//
// `arm()` is deliberately NOT called at load. These hooks fire on every decode
// error in the process, and probing each one stalls launch on the splash; call
// `arm()` from the Frida prompt once the app is on the new-session screen, where
// the cost is irrelevant and the environment error is a few calls away.
//
// Run:  frida -U -f com.anthropic.claude -l tools/frida/model-error-kind.js
//       ... navigate ... then type `arm()` at the prompt ... then send.

const TAG = 'claudesk-kind';
const log = (...parts) => console.log(`${TAG}: ${parts.join(' ')}`);

const CLASSIFIER_OFFSET = 0x1112d54;  // FUN_101112d54
const CONSTRUCTOR_OFFSET = 0x11138a8; // FUN_1011138a8

// A read on an unmapped page throws and is caught; that is far cheaper than
// Process.findRangeByAddress, which this used to call on every single read and
// which is what made a hundred bytes cost a visible stall.
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

// Memory-only: no ObjC runtime calls, so a bad guess is a null, not a crash.
function readSwiftString(address) {
  const bytes = safeRead(address, 16);
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
    const header = safeRead(object.add(countAt), 8);
    if (!header) continue;
    const count = Number(u64(header, 0) & 0x0000ffffffffffffn);
    if (!count || count > 8192) continue;
    const storage = safeRead(object.add(bytesAt), count);
    const text = storage ? ascii(storage, count) : null;
    if (text) return text;
  }
  return null;
}

// Bounded so one call can never run away: 48 bytes at the value and one level of
// pointers, under a hard read budget. Enough for a DecodingError's Context
// (debugDescription) and its coding path, and cheap enough to leave running.
const REGION = 48;
const MAX_DEPTH = 2;   // error -> box -> Context: the message is ~2 hops in
const BUDGET = 200;    // hard cap per call; this is what stops the runaway

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
    if (text && text.length > 2) out.add(text);
    if (depth > 0) {
      const target = u64(bytes, at) & 0x0000ffffffffffffn;
      if (target > 0x100000000n && target < 0x2000000000000n) {
        harvest(ptr(target.toString()), depth - 1, seen, out, budget);
      }
    }
  }
}

function stringsAround() {
  const seen = new Set();
  const out = new Set();
  const budget = { left: BUDGET };
  for (let index = 0; index < arguments.length; index += 1) {
    harvest(arguments[index], MAX_DEPTH, seen, out, budget);
  }
  return [...out];
}

let calls = 0;
const MAX_CALLS = 300;
function hook(base, offset, label) {
  const target = base.add(offset);
  log(`${label} @ ${target}`);
  Interceptor.attach(target, {
    onEnter(args) {
      try {
        if (calls >= MAX_CALLS) return;
        calls += 1;
        const found = stringsAround(args[0], args[1], args[2], args[3]);
        log(`${label} #${calls} x0=${args[0]} x1=${args[1]} x2=${args[2]} x3=${args[3]} strings=${JSON.stringify(found.slice(0, 10))}`);
      } catch (error) { /* never disturb the app */ }
    },
  });
}

let armed = false;
function install() {
  if (armed) { log('already armed'); return; }
  armed = true;
  const module = Process.findModuleByName('Claude');
  if (!module) { log('Claude module not found'); return; }
  hook(module.base, CLASSIFIER_OFFSET, 'classifier');
  hook(module.base, CONSTRUCTOR_OFFSET, 'constructor');
  log('installed — now press send');
}

globalThis.arm = install;
rpc.exports = { arm: install };
log('loaded — navigate to the new-session screen, then type arm() here');
