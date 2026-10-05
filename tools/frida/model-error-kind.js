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

// A Swift small string packs up to 15 UTF-8 bytes as: `_countAndFlagsBits` holds
// the first 7 bytes with the tag `0xE0 | count` in its top byte (byte 7), and
// `_object` holds the remaining up-to-8 (bytes 8..15). The earlier "longest
// printable prefix" guess never reassembled a string that spans the tag byte,
// which is exactly every key name of 8-15 characters — `environment_id`,
// `created_at`, `network_config` — so the field was there and unreadable.
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

// Memory-only: no ObjC runtime calls, so a bad guess is a null, not a crash.
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
let REGION = 96;
let MAX_DEPTH = 3;   // error -> box -> Context -> String
let BUDGET = 600;    // hard cap per call; this is what stops the runaway

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

// Substrings that mark a call as the one we care about: the environment route
// or any of its field names. A hit gets a `*** MATCH ***` line so it stands out
// from the shared-cache noise the harvest also picks up.
const WANT = /environment|cloud-local|7de9bafa|environment_id|environmentId|created_at|createdAt|network_config|networkConfig|spawn|bridge_info|bridgeInfo|machine_name|max_sessions|allow_default_hosts|allowed_hosts|init_script|initScript|git_repo_url|cli_version/i;

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
        const want = found.filter((s) => WANT.test(s));
        if (want.length) log(`*** MATCH *** ${label} #${calls} ${JSON.stringify(want)}`);
        // A cause that reads like a real JSON failure gets a much wider read —
        // the coding path (the field) is a small string a few hops further out
        // than the debugDescription, so only go looking when the call is real.
        if (found.some((s) => /Cannot get value|Expected to decode|No value associated|isn't in the correct format/i.test(s))) {
          const saved = [REGION, MAX_DEPTH, BUDGET];
          [REGION, MAX_DEPTH, BUDGET] = [192, 5, 6000];
          const deep = stringsAround(args[0]);
          [REGION, MAX_DEPTH, BUDGET] = saved;
          log(`DEEP #${calls} ${JSON.stringify(deep.slice(0, 24))}`);
        }
        if (calls <= 3) {
          const raw = safeRead(args[0], 48);
          const hex = raw ? [...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ') : null;
          log(`${label} #${calls} x0 bytes: ${hex}`);
        }
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
