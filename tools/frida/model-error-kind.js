'use strict';
// Read the Foundation DecodingError the app wraps in ModelDecodingError.
//
// ModelDecodingError stores its cause as `error: any Error` and derives its
// `kind` from it in ClaudeApiServices. That classifier is app code called once
// per decode error — not a hot runtime function — so it is safe to hook from
// launch. It is reached here by address (the binary is stripped): image base
// 0x100000000, so module base + 0x1112d54 (classifier) / + 0x10f39cc (the
// description builder that owns the "unexpected_schema" literal and calls the
// classifier) / + 0x11138a8 (the ModelDecodingError constructor).
//
// The classifier's own logic (disassembled) is the reason this dump names the
// failing field: it dynamic-casts the cause to `DecodingError`, and for the
// `dataCorrupted` case it reads `Context.codingPath` and returns a different
// kind depending on whether that path is EMPTY. `unexpected_schema` is the arm
// reached when the coding path is NON-empty (or the error is a
// typeMismatch/keyNotFound/valueNotFound) — i.e. the error names a key. Those
// key strings (small Swift strings, camelCase) are reachable from the error, so
// harvest them and print the ones that look like a coding path.
//
// Run:
//   frida -U -f com.anthropic.claude -l tools/frida/model-error-kind.js
// Then send a message. Lines to look for: `MATCH` and `DEEP`.

// Wrapped in an IIFE: Frida evaluates every `-l` script in one global scope, so
// a top-level `log` here collides with sentry-hook.js's (or any other script's).
(function () {
const TAG = 'claudesk-kind';
const log = (...parts) => console.log(`${TAG}: ${parts.join(' ')}`);

const CLASSIFIER_OFFSET = 0x1112d54;  // FUN_101112d54 — kind from the cause
const DESCRIPTION_OFFSET = 0x10f39cc; // FUN_1010f39cc — owns "unexpected_schema"
const CONSTRUCTOR_OFFSET = 0x11138a8; // FUN_1011138a8 — builds ModelDecodingError

// A read on an unmapped page throws and is caught; that is far cheaper than
// Process.findRangeByAddress, which this used to call on every read.
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

// A Swift small string packs up to 15 UTF-8 bytes. Field/key names on the
// CodingKeys are 3-15 chars, so this is what makes the coding path readable.
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

let REGION = 128;
let MAX_DEPTH = 4;   // error -> box -> Context -> codingPath array -> element
let BUDGET = 1500;   // hard cap per call: this is what stops the runaway

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

function stringsAround() {
  const seen = new Set();
  const out = new Set();
  const budget = { left: BUDGET };
  for (let index = 0; index < arguments.length; index += 1) {
    harvest(arguments[index], MAX_DEPTH, seen, out, budget);
  }
  return [...out];
}

// Coding-path keys and the environment route. A hit names the failing field.
const WANT = /^(kind|environmentId|name|createdAt|state|config|bridgeInfo|environmentType|cwd|initScript|environment|languages|networkConfig|allowedHosts|allowDefaultHosts|taskSetupScript|machineName|directory|branch|gitRepoUrl|maxSessions|online|spawnMode|cliVersion)$|environment|cloud-local|7de9bafa/i;
// The DecodingError.Context.debugDescription phrasing.
const CAUSE = /Expected to decode|Cannot get value|No value associated|isn't in the correct format|Unparseable|Invalid|invalid|not in the correct format/i;

let calls = 0;
const MAX_CALLS = 400;
const scratch = Memory.alloc(16);
function hook(base, offset, label) {
  const target = base.add(offset);
  log(`${label} @ ${target}`);
  Interceptor.attach(target, {
    onEnter(args) {
      try {
        calls += 1;
        const found = stringsAround(args[0], args[1], args[2], args[3]);
        // A Swift String passed by value arrives as two register words, not a
        // pointer; rebuild it from adjacent arg pairs to recover the route.
        for (let i = 0; i + 1 < args.length && i < 5; i += 1) {
          if (args[i] && args[i + 1] && !args[i].isNull() && !args[i + 1].isNull()) {
            scratch.writePointer(args[i]);
            scratch.add(8).writePointer(args[i + 1]);
            const text = readSwiftString(scratch);
            if (text && text.length > 2) found.push(text);
          }
        }
        // Log EVERY call (bounded) so silence is unambiguous: the hooks fire on
        // any ModelDecodingError. Short identifier-ish strings are the coding
        // path keys; long ones are the debugDescription.
        if (calls <= MAX_CALLS) {
          const short = [...new Set(found.filter((s) => s.length <= 24))].slice(0, 24);
          const long = [...new Set(found.filter((s) => s.length > 24))].slice(0, 4);
          const mark = found.some((s) => WANT.test(s)) ? ' *** MATCH ***' : '';
          log(`${label} #${calls}${mark} keys=${JSON.stringify(short)}` +
              (long.length ? ` msgs=${JSON.stringify(long).slice(0, 400)}` : ''));
        }
      } catch (error) { /* never disturb the app */ }
    },
  });
}

const claudeModule = Process.findModuleByName('Claude');
if (!claudeModule) {
  log('Claude module not found — is the app running?');
} else {
  hook(claudeModule.base, DESCRIPTION_OFFSET, 'desc');
  hook(claudeModule.base, CLASSIFIER_OFFSET, 'classifier');
  hook(claudeModule.base, CONSTRUCTOR_OFFSET, 'constructor');
  log('installed — now send a message');
}
})();
