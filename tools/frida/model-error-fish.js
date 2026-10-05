'use strict';
// Fish the native error underneath ClaudeApiServices.ModelDecodingError.
//
// The app collapses the real failure into ModelDecodingError(path:isFailure:kind:),
// which describes only itself. Its NSError bridge has an empty userInfo, so Sentry
// and every capture hook see nothing useful. But two live values still carry the
// field, and this script reads both:
//
//   A. The DecodingError the app built before wrapping. If the response is
//      decoded with Foundation's JSONDecoder, every failure constructs a
//      DecodingError via `Context.init` and one of the four factory functions —
//      and a Context holds `debugDescription` ("No value associated with key
//      CodingKeys(stringValue: \"X\" …)") plus the coding path. Read there.
//
//   B. ModelDecodingError's retained `error` field (offset +32). The struct
//      keeps it whenever it is copied — including the copy Foundation makes to
//      render `localizedDescription` — so even if the original throw is long
//      gone, the boxed copy still names the cause. The value's shape is a
//      Swift String at +0 and exactly 1.0 as a Double at +24, so it is found by
//      shape rather than by type name (no symbols on a stripped binary).
//
// Run:  frida -U -f com.anthropic.claude -l tools/frida/model-error-fish.js
//       frida -H <phone-ip>:27042 -n Gadget -l tools/frida/model-error-fish.js

const TAG = 'claudesk-fish';
const log = (...parts) => console.log(`${TAG}: ${parts.join(' ')}`);

// ------------------------------------------------------------ memory helpers
function readBytes(address, length) {
  try {
    if (!address || address.isNull() || !Process.findRangeByAddress(address)) return null;
    const raw = address.readByteArray(length);
    return raw ? new Uint8Array(raw) : null;
  } catch (error) { return null; }
}

function readPointerAt(address) {
  const bytes = readBytes(address, 8);
  if (!bytes) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  const masked = value & 0x0000ffffffffffffn; // arm64e pointers carry a signature
  return masked ? ptr(masked.toString()) : null;
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
  let longest = null;
  for (let count = 1; count <= 15; count += 1) {
    const text = ascii(bytes, count);
    if (!text) break;
    longest = text;
  }
  return longest;
}

// A Swift String is two words, `(_countAndFlags, _object)`: small (up to 15
// bytes inline, tagged 0xE), bridged (a tagged NSString), or native (`_object`
// is a heap object holding UTF-8 behind a count word). The native header offset
// is tried a few ways and the first printable read wins.
function readSwiftString(address) {
  const bytes = readBytes(address, 16);
  if (!bytes) return null;
  const last = bytes[15];
  if ((last >> 4) === 0xe || (last & 0xf) === 0xe) return smallString(bytes);
  const hi = u64(bytes, 8);
  if ((hi & 0x8000000000000000n) !== 0n) {
    if (!ObjC.available) return null;
    try { return new ObjC.Object(ptr(hi.toString())).toString() || null; }
    catch (error) { return null; }
  }
  const object = ptr(hi.toString());
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

// Every word offset that reads as a Swift String — the blunt instrument that
// finds a coding key or a debug description wherever Swift actually put it.
function stringsIn(pointer, limit = 192) {
  const found = [];
  if (!pointer) return found;
  for (let at = 0; at < limit; at += 8) {
    const text = readSwiftString(pointer.add(at));
    if (text && text.length > 1) found.push({ at, text });
  }
  return found;
}

function scan(label, address) {
  if (!address || address.isNull()) return;
  for (const { at, text } of stringsIn(address)) log(`   ${label}+${at}: ${JSON.stringify(text)}`);
}

function where(context) {
  return Thread.backtrace(context, Backtracer.ACCURATE)
    .slice(0, 6)
    .map((address) => {
      const symbol = DebugSymbol.fromAddress(address);
      return symbol.name || `${symbol.moduleName}+${address.sub(symbol.moduleBase)}`;
    })
    .join(' <- ');
}

// ---------------------------------------------------- A: the DecodingError
// `Context.init(codingPath:debugDescription:underlyingError:)`. On arm64 the
// struct-returned enum's buffer is x0, the codingPath Array is x1, and the
// 16-byte `debugDescription` String arrives whole in x2/x3.
function hookContextInit() {
  const name = '$ss13DecodingErrorO7ContextV10codingPath16debugDescription010underlyingB0ADSays9CodingKey_pG_SSs0B0_pSgtcfC';
  const address = Module.findGlobalExportByName(name);
  if (address === null) { log('A: Context.init not exported; skipping'); return; }
  Interceptor.attach(address, {
    onEnter(args) {
      try {
        const scratch = Memory.alloc(16);
        for (const [first, second] of [[args[2], args[3]], [args[3], args[2]]]) {
          scratch.writePointer(first);
          scratch.add(8).writePointer(second);
          const text = readSwiftString(scratch);
          if (text && text.length > 3) { log(`A: Context.init debugDescription=${JSON.stringify(text)}`); break; }
        }
        scan('codingPath', readPointerAt(args[1])); // Array -> buffer
      } catch (error) { /* never disturb the app */ }
    },
  });
  log('A: hooked DecodingError.Context.init');
}

// The four cases, in case Context.init is inlined away. Their arguments differ
// in shape, so each argument pointer is probed for readable Strings rather than
// trusting one layout.
const FACTORIES = {
  keyNotFound: '$ss13DecodingErrorO11keyNotFoundyABs9CodingKey_p_AB7ContextVtcABmFWC',
  typeMismatch: '$ss13DecodingErrorO12typeMismatchyABypXp_AB7ContextVtcABmFWC',
  valueNotFound: '$ss13DecodingErrorO13valueNotFoundyABypXp_AB7ContextVtcABmFWC',
  dataCorrupted: '$ss13DecodingErrorO13dataCorruptedyA2B7ContextVcABmFWC',
};

function hookFactories() {
  for (const [label, name] of Object.entries(FACTORIES)) {
    const address = Module.findGlobalExportByName(name);
    if (address === null) continue;
    Interceptor.attach(address, {
      onEnter(args) {
        try {
          log(`A: DecodingError.${label}  ${where(this.context)}`);
          for (const [index, arg] of args.slice(1, 5).entries()) {
            if (arg && !arg.isNull()) scan(`  arg${index + 1}`, arg);
          }
        } catch (error) { /* never disturb the app */ }
      },
    });
    log(`A: hooked DecodingError.${label}`);
  }
}

// --------------------------------------------- B: ModelDecodingError's field
// Recognised by shape, not by symbol: a Swift String at +0 and 1.0 at +24. Read
// deferred, because the caller writes the payload after swift_allocError returns.
const ONE_POINT_ZERO = 0x3ff0000000000000n;
const seen = new Set();

function looksLikeError(value) {
  const sample = readBytes(value.add(24), 8);
  if (!sample || u64(sample, 0) !== ONE_POINT_ZERO) return false;
  if (readSwiftString(value)) return true;
  const head = readBytes(value, 16);
  return Boolean(head && u64(head, 0) === 0n);
}

function dump(value) {
  const key = value.toString();
  if (seen.has(key) || seen.size > 200) return;
  seen.add(key);
  const path = readSwiftString(value);
  const error = readPointerAt(value.add(32));
  log(`B: ModelDecodingError path=${JSON.stringify(path)} error=${error}`);
  if (error) scan('   error', error);
  for (const { at, text } of stringsIn(value, 64)) {
    if (text !== path) log(`   value+${at}: ${JSON.stringify(text)}`);
  }
}

function hookAllocError() {
  const address = Module.findGlobalExportByName('swift_allocError');
  if (address === null) { log('B: swift_allocError not found'); return; }
  Interceptor.attach(address, {
    onEnter(args) { this.storage = args[1]; },
    onLeave(retval) {
      const candidates = [];
      if (retval && !retval.isNull()) candidates.push(retval);
      if (this.storage && !this.storage.isNull()) candidates.push(this.storage);
      for (const candidate of candidates) {
        if (!looksLikeError(candidate)) continue;
        for (const delay of [2, 12, 50]) setTimeout(() => {
          try { if (looksLikeError(candidate)) dump(candidate); } catch (error) {}
        }, delay);
      }
    },
  });
  log('B: hooked swift_allocError');
}

hookContextInit();
hookFactories();
hookAllocError();
log('installed');
