'use strict';
// A one-instrument probe: report every ClaudeApiServices.ModelDecodingError the
// app throws, and nothing else.
//
// Why this exists next to probe.js, which already hooks decode errors:
//
//   probe.js's CAPTURE_DECODE_ERRORS hooks Foundation's
//   `DecodingError.Context.init`. That catches a failure the *JSON decoder*
//   builds. The error this app raises on the Code surface is its own type —
//   `ClaudeApiServices.ModelDecodingError`, a struct in
//   ClaudeApiServices/ModelDecodingError.swift carrying `path: String` — which
//   its decoders construct and throw directly. It never passes through
//   DecodingError.Context, so that hook is blind to it. That is the whole reason
//   a decode failure can be visible in the app ("Something went wrong") and
//   absent from a probe log that is otherwise working.
//
//   probe.js's CAPTURE_THROWS *would* see it — it hooks swift_willThrow — but
//   it reports every throw in the process, `try?` included, so it is off by
//   default and has to be read past thousands of benign launch throws.
//
// This probe keeps that hook's vantage point but drops the noise: it resolves
// the type of each error as it is built and reports only the one asked for.
// Naming a type is a handful of pointer reads, so it is cheap enough to leave
// attached, and the log has one line shape instead of a census.
//
// Same two sinks as probe.js, so it runs either way the gadget is configured:
// `send`/console.log for a host-attached session, POST to <reportUrl>/__diag for
// a standalone script-mode build. Same `rpc.exports.init` contract, and the same
// rule that init must return immediately.

const TAG = 'claudesk-decode-error';

// ------------------------------------------------------------------- config
// The type name to report, matched as a case-insensitive substring so both
// `ModelDecodingError` and the module-qualified spelling hit. Set it to null to
// log the type name of *every* throw instead — that is the calibration mode, and
// it is how to confirm the resolver below reads the type correctly on a given
// build before trusting a quiet log as "no such error was thrown".
// Two spellings of the same failure, because the type the app *builds* is not
// the one it is caught *reporting*. The decoder's `ModelDecodingError` goes into
// `ClaudeTelemetry.ReportedError<T>`; every site that has produced a readable
// record so far turns out to be a bridging site — Swift's error→NSError thunk
// compiled into the app (`_getErrorEmbeddedNSError`, `_swift_getWitnessTable`,
// `_swift_willThrow`) — and a bridged box is an object whose first word is an
// isa, not the struct. The wrapper's own site is where the app builds the error,
// and its payload is the `ModelDecodingError` the `path` lives in.
const TYPE_FILTERS = ['ModelDecodingError', 'ReportedError'];
const TYPE_FILTER = TYPE_FILTERS.join('|');
// How many reports one call site may make before it is capped. A decode failure
// repeats (every refresh of the same broken response), and the first one already
// names the field; the rest only prove it kept happening.
const PER_SITE = 3;
const SITE_LIMIT = 40;

let reportUrl = null;
let token = null;
let seq = 0;
let started = false;

function describe(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Same egress as probe.js: the app's own NSURLSession, so the POST rides the
// device's proxy/DNS/trust exactly as the app's traffic does. Only used in
// script mode; listen mode has no reportUrl and send() is the sink.
function post(message) {
  if (!reportUrl) return;
  try {
    const nsBody = ObjC.classes.NSString.stringWithString_(JSON.stringify(message)).dataUsingEncoding_(4);
    const url = ObjC.classes.NSURL.URLWithString_(`${reportUrl.replace(/\/$/, '')}/__diag`);
    const request = ObjC.classes.NSMutableURLRequest.requestWithURL_(url);
    request.setHTTPMethod_('POST');
    request.setValue_forHTTPHeaderField_('application/json', 'Content-Type');
    if (token) request.setValue_forHTTPHeaderField_(token, 'X-Claudesk-Diag');
    request.setHTTPBody_(nsBody);
    const done = new ObjC.Block({ retType: 'void', argTypes: ['object', 'object', 'object'], implementation() {} });
    ObjC.classes.NSURLSession.sharedSession().dataTaskWithRequest_completionHandler_(request, done).resume();
  } catch (error) {
    console.log(`${TAG}: post failed: ${error.message}`);
  }
}

function report(kind, payload) {
  const message = { kind, seq: ++seq, at: Date.now(), payload };
  console.log(`${TAG}: ${kind} ${describe(payload).slice(0, 600)}`);
  try { send(message); } catch (error) { /* no controller — script mode posts */ }
  post(message);
}

// ------------------------------------------------------- the type of an error
// Naming an error's type means finding its metadata and reading the name out of
// the metadata's descriptor.
//
// The throw entry points are a dead end for that. `swift_willThrow(box)` hands
// over a box whose contents belong to libswiftCore; four live runs showed every
// word of it to be String guts, ObjC data or zero — never a metadata pointer.
// libswiftCore ships in the iOS dyld shared cache and is not in this bundle, so
// that layout cannot be read out here or guessed from this repo. The typed entry
// point, `swift_willThrowTypedImpl(box, metadata, storage)`, does pass metadata
// (disassembly-verified: x1 is a metadata accessor's result) but only covers
// `throws(T)` functions, and this app's decoders throw untyped.
//
// So the probe hooks the call that *builds* the error instead. By ABI,
//
//   swift_allocError(const Metadata *type, const WitnessTable *conformance,
//                    OpaqueValueStorage *typedStorage, bool isTake)
//
// hands the error's type over as its first argument — no box-walking, no
// libswiftCore layout. Every untyped `throw` in a Swift binary goes through it;
// the disassembly of this app's throw sites is `bl _swift_allocError` followed
// immediately by `bl _swift_willThrow`. x1 is kept as a runner-up in case the
// pointer is handed over as the value and the type alongside it.
//
// What x0 *is* — metadata (with the descriptor inside it) or the descriptor
// itself — is left open and searched, since both occur. So each throw is tried
// against a small set of candidates and shapes, and the pair that keeps
// answering is remembered. A pair that yields the *filtered* name is trusted at
// once — that string does not appear by chance — while any other pair must agree
// three times first, so a one-off coincidental read cannot lock the probe onto
// the wrong layout. The search is bounded and stops as soon as it locks.
//
// A runtime accessor (`swift_getTypeName`) would name types authoritatively, but
// it dereferences whatever it is handed; the walk reads defensively instead, so
// a wrong guess yields no name, never a crash.
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const DEREF_MODES = [8, 16, 0, 'direct'];

function ptrOrNull(value) {
  try { return value && !value.isNull() ? value : null; } catch (error) { return null; }
}

// The pointer-sized word at `x0 + offset`. For an allocation x0 is the error's
// type, so this reads its fields; for a throw it is the error box.
function x0Word(context, offset) {
  try { return ptrOrNull(context.x0.add(offset).readPointer()); } catch (error) { return null; }
}

// Where the metadata might be, most likely first.
//
// A pointer value is walked in steps out to 88 bytes: a first run showed the
// untyped error box stack-allocated with its first five words zero and the only
// image-pointer-looking word at +40, so the metadata is not at the front the way
// a `{Storage, Type}` layout would put it. The whole prefix is cheap to try, and
// the search stops as soon as it locks. It stays in the table as a long shot for
// the entry points that carry a box, but nothing has ever been named from one.
const BOX_WORDS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88];
const CANDIDATES = {
  swift_allocError: (context) => [ptrOrNull(context.x0), ptrOrNull(context.x1)],
  swift_willThrowTypedImpl: (context) =>
    [ptrOrNull(context.x1), ...BOX_WORDS.map((offset) => x0Word(context, offset))],
};

// A descriptor keeps its name at +8 as a relative pointer. That offset is signed
// and negative as often as positive, and Frida's `add()` is not a safe home for
// a negative number (it throws, which the catch would swallow into a silent "no
// name" — indistinguishable from a wrong layout). So the negative case is
// applied with `sub()`, which only ever sees a positive magnitude.
// Masking happens at every hop, not only at the caller: on arm64e the descriptor
// is itself a signed pointer (a metadata's `Description` field is a
// `TargetSignedPointer`), so a pointer that arrives looking clean can still
// carry signature bits — and a pointer that arrives signed dereferences to an
// unmapped page. Masking in one place is enough only if it is the place every
// read goes through, which is why `variants` is used for both the pointer and
// the descriptor it yields.
//
// arm64e pointers are signed: the address lives in bits 0-47 and bits 48-63 hold
// the signature. A word therefore reads as 0x01_000001f6e05c51 where the mapped
// address is 0x1f6e05c51, and a live run showed exactly that — x1 and box+0
// sharing `0x1f6e05c51` under different top bytes.
const POINTER_MASKS = ['0x0000ffffffffffff', '0x00ffffffffffffff'];

// A word read out of an image that dyld has not rewritten — a section of a
// binary read from disk, or a `__DATA_CONST` slot whose fixups were not applied
// — is a chained-fixup rebase rather than an address: bit 63 clear, the target
// image-relative in the low 43 bits. Undoing that costs one mask and one add,
// and it is offered as one more candidate so such a word is not lost. The base
// is this app's preferred base, which is the only build this probe is for.
const FIXUP_TARGET_MASK = '0x7ffffffffff';
const FIXUP_BASE = '0x100000000';

function variants(pointer) {
  if (!pointer) return [];
  const out = [pointer];
  const push = (candidate) => {
    try {
      if (candidate && !candidate.isNull() && !out.some((seen) => seen.equals(candidate))) out.push(candidate);
    } catch (error) { /* keep what we have */ }
  };
  for (const mask of POINTER_MASKS) {
    try { push(pointer.and(ptr(mask))); } catch (error) { /* keep what we have */ }
  }
  try {
    if (pointer.and(ptr('0x8000000000000000')).isNull()) push(pointer.and(ptr(FIXUP_TARGET_MASK)).add(ptr(FIXUP_BASE)));
  } catch (error) { /* not a fixup */ }
  return out;
}

// Read the NUL-terminated token at `address`, at most `limit` bytes, and never
// through Frida's *sized* `readUtf8String`.
//
// A sized read treats a NUL before `size` as a decode failure: at the real
// TLVBlockError name — `54 4c 56 42 6c 6f 63 6b 45 72 72 6f 72 00`, i.e.
// "TLVBlockError" — `readUtf8String(128)` throws "can't decode byte 0x00 in
// position 13". Swift type names are all shorter than 128 bytes, so that read
// returned nothing for every name on every run, which is what `names: []` was
// for four builds. Bytes are read in small chunks and the scan stops at the
// first NUL, so a short name costs one short read and a bogus address costs one
// caught exception instead of a huge allocation.
const NAME_CHUNK = 32;
function readName(address, limit) {
  let out = '';
  for (let offset = 0; offset < limit; offset += NAME_CHUNK) {
    const chunk = new Uint8Array(address.add(offset).readByteArray(NAME_CHUNK));
    for (const byte of chunk) {
      if (byte === 0) return out;
      // A type name is ASCII; any high byte means this is not one, and the
      // replacement character fails NAME_SHAPE like any other stray byte.
      out += byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(0xFFFD);
    }
  }
  return out;
}

// Name the type reachable from `pointer` by `mode`: `direct` when the pointer is
// already the descriptor, otherwise the pointer at `pointer + mode` is the
// descriptor, whose name sits at `descriptor + 8` through a signed relative
// offset. Each shape of the base (as-read, masked, fixup) is tried in turn, and
// when `trail` is given every failed hop leaves a note. Attempts used to fail
// into the same silent `null` — which is why several runs could report
// `names: []` without saying where the walk stopped; with a trail a blind run
// carries the reason with it.
function nameStep(pointer, mode, trail) {
  // The base the deref starts from is itself masked: a word read out of a box is
  // a signed pointer too (x1 and box+0 shared `0x1f6e05c51` under different top
  // bytes in the live run), and a signed base reads an unmapped page. This is
  // the bug the previous revision fixed, so it must survive every refactor.
  for (const base of variants(pointer)) {
    const baseTag = base.equals(pointer) ? '' : '+alt';
    let descriptor = null;
    try {
      descriptor = mode === 'direct' ? ptrOrNull(base) : ptrOrNull(base.add(mode).readPointer());
    } catch (error) {
      if (trail) trail.push(`${mode}${baseTag}: deref failed (${error.message})`);
      continue;
    }
    if (!descriptor) { if (trail) trail.push(`${mode}${baseTag}: null`); continue; }
    const name = nameFromDescriptor(descriptor, `${mode}${baseTag}`, trail);
    if (name) return name;
  }
  return null;
}

function nameFromDescriptor(descriptor, at, trail) {
  for (const candidate of variants(descriptor)) {
    const tag = candidate.equals(descriptor) ? '' : '+alt';
    const field = candidate.add(8);
    let relative = null;
    try { relative = field.readS32(); } catch (error) {
      if (trail) trail.push(`${at}@${candidate}${tag}: no s32 (${error.message})`);
      continue;
    }
    let address = null;
    try { address = relative < 0 ? field.sub(-relative) : field.add(relative); } catch (error) {
      if (trail) trail.push(`${at}@${candidate}${tag}: rel ${relative} failed (${error.message})`);
      continue;
    }
    try {
      const name = readName(address, 128);
      if (name && NAME_SHAPE.test(name)) return name;
      if (trail) trail.push(`${at}@${candidate}${tag}: rel ${relative} -> ${address} = ${JSON.stringify(name.slice(0, 32))}`);
    } catch (error) {
      if (trail) trail.push(`${at}@${candidate}${tag}: rel ${relative} -> ${address} unreadable (${error.message})`);
    }
  }
  return null;
}

// Direct walk from a descriptor, with no register/word in front of it. The probe
// itself reaches names through `nameStep`; this is the entry point the offline
// harness (`/tmp/nametest.mjs`) calls to check the walk against the real binary.
function relativeName(descriptor) {
  return nameStep(descriptor, 'direct', null);
}

function attemptName(candidates, index, mode) {
  const candidate = candidates[index];
  if (!candidate) return null;
  return nameStep(candidate, mode, null);
}

const votes = new Map();  // "source|index|mode" -> consecutive agreements
const locks = new Map();  // source -> { index, mode } once trusted
const BRUTE_THROWS = 400;
let bruteThrows = BRUTE_THROWS;
let lockMisses = 0;
let learned = null;       // reported once, so a log shows how the layout was found
let layoutSent = false;

// One-shot, on the first allocation: which argument register, or which word of
// what it points at, names a type — and by which shape. This is the evidence
// that settles the layout, so a run that stays blind is diagnostic instead of
// just quiet.
function reportLayout(context, source) {
  if (layoutSent) return;
  layoutSent = true;
  const words = [];
  const names = [];
  const trail = [];
  // nameStep masks the base itself and reports which shape won, so this only
  // has to hand it each register/word and keep the names and the reasons apart.
  const inspect = (pointer, at) => {
    if (!pointer) return;
    for (const mode of DEREF_MODES) {
      const steps = [];
      const name = nameStep(pointer, mode, steps);
      if (name) names.push({ at, via: String(mode), name, where: describeAddress(pointer) });
      else for (const step of steps) trail.push(`${at} ${step}`);
    }
  };
  // The registers themselves first, then the words they point at: for an
  // allocation x0 is the type (a name via `direct` or `deref8` depending on
  // whether it is a descriptor or metadata), and for a throw x2 is the value.
  for (const at of ['x0', 'x1', 'x2']) inspect(ptrOrNull(context[at]), at);
  for (const offset of BOX_WORDS) {
    const word = x0Word(context, offset);
    words.push(word ? word.toString() : null);
    inspect(word, `x0+${offset}`);
  }
  report('layout', {
    source,
    x0: ptrOrNull(context.x0) ? context.x0.toString() : null,
    x1: ptrOrNull(context.x1) ? context.x1.toString() : null,
    words,
    names,
    // Why the walk stopped where it did, per candidate and shape. Empty when
    // every candidate named a type, which is the case that needs no reading.
    why: names.length ? [] : trail.slice(0, 24),
  });
}

function lock(source, index, mode, why) {
  locks.set(source, { index, mode });
  if (!learned) {
    learned = { source, candidate: index, mode, why };
    report('calibrated', learned);
  }
}

function typeNameOf(source, context) {
  const candidates = CANDIDATES[source](context);
  const locked = locks.get(source);
  if (locked) {
    const name = attemptName(candidates, locked.index, locked.mode);
    if (name) { lockMisses = 0; return name; }
    if ((lockMisses += 1) < 5) return null;
    // The layout stopped answering — drop the lock and search again briefly.
    locks.delete(source);
    lockMisses = 0;
    bruteThrows = Math.max(bruteThrows, 500);
    return null;
  }
  if (bruteThrows <= 0) return null;
  bruteThrows -= 1;
  let matched = null;
  let agreed = null;
  for (let index = 0; index < candidates.length && !matched; index += 1) {
    for (const mode of DEREF_MODES) {
      const name = attemptName(candidates, index, mode);
      if (!name) continue;
      if (matches(name)) { matched = { index, mode, name }; break; }
      const key = `${source}|${index}|${mode}`;
      const count = (votes.get(key) || 0) + 1;
      votes.set(key, count);
      // Preference is by candidate/mode order, not by who got there first.
      if (count >= 3 && !agreed) agreed = { index, mode };
    }
  }
  if (matched) {
    lock(source, matched.index, matched.mode, 'name matched the filter');
    return matched.name;
  }
  if (agreed) lock(source, agreed.index, agreed.mode, 'three throws agreed');
  return null;
}

function matches(name) {
  if (TYPE_FILTERS === null) return true; // calibration: everything
  if (!name) return false; // unknown type is not the type we asked for
  const lower = name.toLowerCase();
  return TYPE_FILTERS.some((want) => lower.includes(want.toLowerCase()));
}

// ------------------------------------------------- ModelDecodingError's fields
// `path` is a Swift `String` and the struct's first field, so it is the first
// sixteen bytes of the typed value: `x1` for `swift_allocError` (whose `x0` is
// the metadata), `x2` for the typed throw entry. Reading it is what `textNear`
// below was standing in for, and the stand-in does not work. `textNear` follows
// the *metadata's* words — one of which is the descriptor pointer — and scans
// 640 bytes from each; the descriptor's neighbourhood is the `__TEXT,__const`
// blob the linker packs this module's type-name strings into, so the scan
// returns whatever is declared *near* the error type rather than anything about
// the value. It is stable (which is why it looks meaningful) and wrong: every
// throw in a run reported the same seven names. The fields are read here
// instead, and no accessor is ever called on the error — reading memory at a
// pointer we already hold cannot run app code.
function readBytesAt(address, length) {
  try {
    if (!address || address.isNull() || !Process.findRangeByAddress(address)) return null;
    const raw = address.readByteArray(length);
    return raw ? new Uint8Array(raw) : null;
  } catch (error) { return null; }
}

function readPointerAt(address) {
  const bytes = readBytesAt(address, 8);
  if (!bytes) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  const masked = value & 0x0000ffffffffffffn; // arm64e pointers carry a signature
  return masked ? ptr(masked.toString()) : null;
}

function u64At(bytes, at) {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[at + i]);
  return value;
}

function textOf(bytes, count) {
  if (count <= 0 || count > bytes.length) return null;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const byte = bytes[i];
    if (byte < 0x20 || byte > 0x7e) return null; // a path is printable ASCII
    out += String.fromCharCode(byte);
  }
  return out || null;
}

// The small-string case is decoded as "the longest printable prefix", not from
// a count field: its tag and count share the last byte and the two nibbles are
// easy to get backwards, while the payload is always the leading bytes and
// Swift zero-fills whatever is left, so a zero ends the run on its own. A long
// small string ends with the tag byte, which is not printable either.
function smallString(bytes) {
  let longest = null;
  for (let count = 1; count <= 15; count += 1) {
    const text = textOf(bytes, count);
    if (!text) break;
    longest = text;
  }
  return longest;
}

// A Swift `String` is two words, `(_countAndFlags, _object)`, in three shapes:
// small (the last byte carries 0xE, up to fifteen bytes inline), bridged (a
// tagged NSString, read back through ObjC), and native (`_object` is a heap
// object holding UTF-8 behind a count word). The native header offset is not
// worth being clever about: a few candidate shapes are tried and the first that
// yields printable text wins. `pathWords` in the report is the raw pair, so a
// null `path` is still readable by hand.
function readSwiftString(address) {
  const bytes = readBytesAt(address, 16);
  if (!bytes) return null;
  const last = bytes[15];
  if ((last >> 4) === 0xe || (last & 0xf) === 0xe) return smallString(bytes);
  const hi = u64At(bytes, 8);
  if (hi & 0x8000000000000000n) {
    if (!ObjC.available) return null;
    try { return new ObjC.Object(ptr(hi.toString())).toString() || null; }
    catch (error) { return null; }
  }
  const object = ptr(hi.toString());
  for (const [countAt, bytesAt] of [[16, 32], [24, 32], [16, 24]]) {
    const header = readBytesAt(object.add(countAt), 8);
    if (!header) continue;
    const count = Number(u64At(header, 0) & 0x0000ffffffffffffn);
    if (!count || count > 4096) continue;
    const storage = readBytesAt(object.add(bytesAt), count);
    const text = storage ? textOf(storage, count) : null;
    if (text) return text;
  }
  return null;
}

// A `String` whose `_countAndFlags` is zero: an empty string, whose `_object` is
// the shared empty-string singleton. Readable and non-null, so this is
// deliberately narrower than "both words are zero" — that is an uninitialised
// slot, not an empty string, and the two lead to opposite conclusions about an
// error whose `path` would be there.
function emptyStringAt(address) {
  const bytes = readBytesAt(address, 16);
  if (!bytes) return false;
  if (u64At(bytes, 0) !== 0n) return false;
  const object = u64At(bytes, 8);
  if (object === 0n) return false;
  return Boolean(readBytesAt(ptr(object.toString()), 8));
}

// A `ModelDecodingError`'s value, recognised by its shape rather than by being
// handed to us: a `String` at +0 and exactly 1.0 as a Double at +24, which is
// the `sampleRate` this app's decoders always set. That pair is what the heap
// scan looks for, so it lives here beside the readers it uses and the offline
// harness holds it to it.
const ONE_POINT_ZERO = 0x3ff0000000000000n;

function errorValueAt(address) {
  const sample = readBytesAt(address.add(24), 8);
  if (!sample || u64At(sample, 0) !== ONE_POINT_ZERO) return null;
  const path = readSwiftString(address);
  if (path === null && !emptyStringAt(address)) return null;
  return { path, box: readPointerAt(address.add(32)) };
}

// `error: Error` sits at value+32, not +24. The field order is path, isFailure,
// sampleRate, error, recoveredCount, and `sampleRate` is a *Double*, so the one
// byte of `isFailure` is padded out to the eight that `sampleRate` needs:
// path (0..15), isFailure (16), pad, sampleRate (24..31), error (32..39). A
// recorded value shows exactly that — the third word is `0x3ff0000000000000`,
// which is 1.0, so a read at +24 landed inside the sample rate and returned
// nothing, every time.
//
// An `any Error` is a box whose payload starts at box+0. A `DecodingError` puts
// the `CodingKey` it failed on in that payload, and a `CodingKey` carries its
// name as a Swift `String` — so the box's own words can name the offending
// field even when the missing value itself was a number.
function underlyingError(valuePointer) {
  if (!valuePointer) return null;
  const box = readPointerAt(valuePointer.add(32));
  if (!box) return null;
  const metadata = readPointerAt(box);
  const name = metadata
    ? (nameStep(metadata, 8, null) || nameStep(metadata, 'direct', null))
    : null;
  const text = [];
  for (let at = 0; at < 64; at += 8) {
    const found = readSwiftString(box.add(at));
    if (found && found.length > 1) text.push({ at, text: found });
  }
  // When the box's first word is not a Swift metadata and holds no `String`, it
  // is an object — which is what a bridged `NSError` looks like from here — and
  // the words are reported so the class is readable from its `isa`'s symbol.
  //
  // They are *reported*, not interrogated. An earlier version called
  // `-[NSObject description]` on the pointer to get the domain and the failing
  // key in one line, and it crashed the app on the Code tab: `objc_msgSend` on
  // a word that only looked like an object is an `EXC_BAD_ACCESS`, and a JS
  // `try`/`catch` cannot catch a native fault. Nothing here may move the app
  // toward a crash, so nothing here calls into a runtime on a pointer it cannot
  // prove — a memory read and a symbol lookup are all this gets.
  const boxWords = [];
  {
    const raw = readBytesAt(box, 32);
    if (raw) boxWords.push(...describedWords(raw));
  }
  return {
    name: name || null,
    box: describeAddress(box),
    boxWords: boxWords.length ? boxWords : null,
    text: text.length ? text.slice(0, 6) : null,
  };
}

// ------------------------------------------------------------- reading text
// Kept as the fallback it has always really been, and now labelled as such: the
// raw words around the arguments are taken as candidate pointers and printable
// ASCII is pulled out of whatever they land on. A wrong guess costs a wasted
// scan, but the answer is whatever happens to be mapped nearby — see the note
// above. `path` is the field to read; this is a smoke trail when it is null.
const ASCII_MIN = 8;

function asciiRuns(address, length = 512) {
  const runs = [];
  let bytes;
  try {
    if (!Process.findRangeByAddress(address)) return runs;
    bytes = address.readByteArray(length);
  } catch (error) {
    return runs;
  }
  if (!bytes) return runs;
  const view = new Uint8Array(bytes);
  let run = '';
  for (let i = 0; i < view.length; i += 1) {
    const c = view[i];
    if (c >= 0x20 && c < 0x7f) { run += String.fromCharCode(c); continue; }
    if (run.length >= ASCII_MIN) runs.push(run);
    run = '';
  }
  if (run.length >= ASCII_MIN) runs.push(run);
  return runs;
}

function pointerCandidates(value) {
  const out = [];
  const seen = new Set();
  const add = (candidate) => {
    try {
      if (!candidate || candidate.isNull()) return;
      const key = candidate.toString();
      if (!seen.has(key)) { seen.add(key); out.push(candidate); }
    } catch (error) { /* not a pointer */ }
  };
  add(value);
  for (const mask of ['0xfffffffffffffff8', '0x0000ffffffffffff', '0x0000fffffffffff8', '0x00000000ffffffff']) {
    try { add(value.and(ptr(mask))); } catch (error) { /* keep going */ }
  }
  return out;
}

function textNear(words, length = 512) {
  const found = new Set();
  for (const word of words) {
    for (const candidate of pointerCandidates(word)) {
      for (const run of asciiRuns(candidate, length)) found.add(run);
    }
  }
  return [...found];
}

// ------------------------------------------------------------- backtraces
// The app's symbols are stripped, so a frame reads `Claude+0x…`; feeding that
// offset to Ghidra against the same binary names the call site. Frames are
// cached because the same addresses recur throw after throw.
const frameCache = new Map();
function symbolize(address) {
  try {
    const symbol = DebugSymbol.fromAddress(address);
    const module = symbol.moduleName ? Process.findModuleByName(symbol.moduleName) : null;
    const offset = module ? address.sub(module.base) : null;
    return `${symbol.moduleName || '?'}+${offset}` + (symbol.name ? ` ${symbol.name}` : '');
  } catch (error) {
    return `?+${address}`;
  }
}
// A bare pointer in a record should say what it is without a second, offline
// lookup against the binary: which module and offset it lands in, and what the
// mapping there permits. That is the whole difference between a `path` word and
// a red herring — a `String` word can only point at a writable object or at a
// `__TEXT,__const` literal, so a word resolving to executable code, or to an
// anonymous heap page, is visibly not a string.
function describeAddress(value) {
  if (!value || value.isNull()) return null;
  const raw = value.toString();
  let where = raw;
  try {
    const symbol = DebugSymbol.fromAddress(value);
    if (symbol.name) {
      where = `${symbol.name} in ${symbol.moduleName || '?'}`;
    } else if (symbol.moduleName) {
      const module = Process.findModuleByName(symbol.moduleName);
      if (module) where = `${symbol.moduleName}+0x${value.sub(module.base).toString(16)}`;
    }
  } catch (error) { /* the raw address is still worth printing */ }
  let memory = 'unmapped';
  try {
    const range = Process.findRangeByAddress(value);
    if (range) memory = `${range.protection} ${range.file ? 'file' : 'anon'}`;
  } catch (error) { /* leave it as unmapped */ }
  return `${raw}${where === raw ? '' : ` = ${where}`} [${memory}]`;
}

// The words of a two-word `String`/`Error` slot, each named. Sixteen bytes at a
// time, so `pathWords` reads as `["0x… [rw- anon]", "Claude+0x… [r-x file]"]` —
// a null `path` with words like these is self-evidently a wrong pointer, not a
// string the reader failed on.
function describedWords(bytes) {
  const words = [];
  for (let at = 0; at + 8 <= bytes.length; at += 8) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[at + i]);
    words.push(describeAddress(ptr(value.toString())) || `0x${value.toString(16)}`);
  }
  return words;
}

function frameOf(address) {
  const key = address.toString();
  const cached = frameCache.get(key);
  if (cached !== undefined) return cached;
  const text = symbolize(address);
  if (frameCache.size < 4096) frameCache.set(key, text);
  return text;
}
function frames(context) {
  let stack = [];
  try { stack = Thread.backtrace(context, Backtracer.ACCURATE); } catch (error) { /* fall through */ }
  if (stack.length < 4) {
    try { stack = Thread.backtrace(context, Backtracer.FUZZY); } catch (error) { /* keep the short one */ }
  }
  return stack.slice(0, 24).map(frameOf);
}

// ------------------------------------------------------------------ the hook
// Keyed on `lr` — the address the throwing function returns to — because that
// decision has to be free: it runs inside every throw in the process, and the
// expensive part (the backtrace) must happen only once a report is earned.
const siteCounts = new Map();
let reported = 0;
let capped = 0;

// Automatic calibration. Naming a type is the one thing here that could be
// silently wrong on a build nobody has probed, and a filter that never matches
// is indistinguishable from a filter that never fired. So the first few
// *distinct* error type names are reported once, with a count of allocations
// that yielded no name at all: `names:[] unresolved:12000` is a broken namer — a
// different log line from a quiet `names:[…]`.
const CENSUS_MAX = 12;
const censusNames = new Set();
let unresolved = 0;
let censusSent = false;

function census() {
  if (censusSent) return;
  censusSent = true;
  report('throw-types', {
    names: [...censusNames],
    unresolved,
    // Throws that arrived while a record was armed and read as no `String` at
    // all. A run with several of these and no `model-decoding-error` record is
    // saying the storage never held the payload, which is a different problem
    // from the error never being built.
    unread: unreadThrows,
    filter: TYPE_FILTER,
    // How the layout was learned, if it was; the one-shot `layout` report above
    // carries the evidence when it was not.
    calibrated: learned,
  });
}

// Every distinct error type this app allocates is named the moment it is first
// seen, not saved for the census. The census is a launch-time story — it goes
// out once, early — so a name that only appears later is a name the log would
// never mention, and "no record" would then be unreadable as "not this type"
// when it actually meant "not yet".
function noteType(name, source, context) {
  if (name) {
    if (!censusNames.has(name)) {
      report('first-throw', {
        name,
        source,
        site: context && context.lr ? String(context.lr) : null,
        filter: TYPE_FILTER,
        wanted: matches(name),
      });
    }
    censusNames.add(name);
    if (censusNames.size >= CENSUS_MAX) census();
  } else {
    unresolved += 1;
  }
}

// An allocation names the error; it does not yet hold it. The two are separate
// calls in the runtime's error ABI, and the value only exists at the second one:
//
//   mov x1,x0          ; x1 = the storage the runtime just returned
//   mov x0,x23         ; metadata
//   mov x2,#0x0        ; isTake      = false
//   mov w3,#0x0        ; isFromThrow = false
//   bl  _swift_allocError
//   ldur q0,[sp,#0x78] ; <- and only here does the *caller* write the payload
//   stp q0,q1,[x1]
//   str x8,[x1,#0x20]
//
// Reading x1 at hook entry therefore reads uninitialised storage, which is what
// the words in the log were: a heap pointer, four code addresses, a runtime
// witness symbol, `0x303`. So the allocation is used for what it is good for —
// naming the type and remembering *which* storage holds the error — and the
// record is emitted at a throw that follows, by which time the caller has
// written the payload.
//
// The throw is only a trigger, and `swift_willThrow` cannot be filtered by type:
// it is handed an error value and nothing that says which. So it must not be
// allowed to *claim* the pending name — an unrelated throw in the same window
// (a `__SwiftNativeNSError` in a SwiftUI gesture stack, in a live run) reads the
// storage, finds no `String` where a `path` would be, and is dropped. Only a
// read that yields a `String` consumes the pending record, and `paired` says
// whether that throw was the error's own or merely the occasion for it.
let pending = null;
let unreadThrows = 0;
const unreadSites = new Set();
const PENDING_MS = 50;

function cleanPointer(value) {
  const pointer = ptrOrNull(value);
  if (!pointer) return null;
  try { return pointer.and(ptr('0x0000ffffffffffff')); } catch (error) { return pointer; }
}

// Only the app's own image arms a record. A `ModelDecodingError` is built by
// this app's decoder; the allocations Foundation makes while *rendering* an
// error for the log name the same type and never hold the struct — they are the
// records whose value words were uninitialised. With no main module to compare
// against, nothing is filtered.
// Which module a site lives in is reported, never used to filter. It was a
// filter for a while, to shed the records Foundation produced while rendering an
// error for the log — and those records were only junk because their value was
// read before the caller had written it. With the read deferred they are the
// *only* live signal at the moment a failure is reported rather than made: the
// app re-boxes nothing at send time, Foundation re-boxes the error it was
// handed, and that copy carries the same `path`. Filtering it away is what made
// a live run look like the send was failing for some other reason.
function moduleNameOf(address) {
  try {
    if (!address) return null;
    const pointer = typeof address === 'string' ? ptr(address) : address;
    const module = Process.findModuleByAddress(pointer);
    return module ? module.name : 'unmapped';
  } catch (error) {
    return null;
  }
}

function onThrow(context, source) {
  try {
    // A plain throw has no registers worth laying out, and the layout report is
    // a one-shot: it must land on an allocation to be the evidence it is meant
    // to be.
    if (source === 'swift_willThrow') { reportThrow(context); return; }
    reportLayout(context, source);
    const name = typeNameOf(source, context);
    noteType(name, source, context);
    if (!matches(name)) return;
    // The site is the key the caps are counted against and the address the
    // module is read from, so a throw with no return address has nothing to
    // report and is the one thing still dropped without a record.
    const key = context.lr ? String(context.lr) : null;
    if (key) {
      const seen = (siteCounts.get(key) || 0) + 1;
      siteCounts.set(key, seen);
      if (seen > PER_SITE) { capped += 1; return; }
    }
    if (reported >= SITE_LIMIT) { capped += 1; return; }
    reported += 1;
    pending = null;
    const typed = source === 'swift_willThrowTypedImpl';
    if (typed) {
      // The typed entry is namer and thrower in one, so it reports at once:
      // x1 named the type (already read) and the error is its first argument.
      emit(source, name, key, context, ptrOrNull(context.x0) || ptrOrNull(context.x2));
      return;
    }
    // The counters are spent here rather than at the throw: the per-site cap is
    // there to bound the expensive part, and that is the backtrace.
    const record = {
      name,
      site: key,
      storage: cleanPointer(context.x1),
      thread: Process.getCurrentThreadId(),
      at: Date.now(),
      done: false,
    };
    pending = record;
    // The carrying throw may never arrive, or may arrive on a thread this record
    // does not belong to, so the construction is reported as well — cheap, no
    // backtrace — because the one record that must not go missing is the one
    // saying this type was built here.
    // `frames` here is not decoration: the raw site is a runtime address, and
    // its module-relative offset is what Ghidra wants. The backtracer is the
    // rendering that has matched the binary before (`Claude+0x2033ec` for the
    // bridging thunk at `0x100203274`+), so it is the one to trust for turning
    // a site into a function. Cheap next to the throw's record, and capped with
    // everything else at PER_SITE.
    report('built', {
      n: reported,
      source,
      type: name,
      site: key,
      module: moduleNameOf(key),
      frames: frames(context),
    });
    deferRead(record, source);
  } catch (error) {
    // Never let the probe disturb the app.
    console.log(`${TAG}: hook error: ${error.message}`);
  }
}

// Errors the app built earlier and is throwing again. A decode failure is not
// always freshly made at the moment it is used: the app keeps the `any Error`
// and re-throws it — at the next send, say — and then there is no allocation to
// arm from and the probe saw nothing, which is exactly how a live run showed one
// record and silence afterwards. Boxing is the app's, not the runtime's, so the
// address is stable and the same failure is recognisable when it comes back.
const knownBoxes = new Map();

function rememberBox(pointer, name, site, path) {
  const key = pointer ? pointer.toString() : null;
  if (!key || knownBoxes.size >= 64 || knownBoxes.has(key)) return;
  knownBoxes.set(key, { name, site, path, reported: false });
}

// Some allocations are never thrown. Foundation re-boxes an error it has been
// handed while rendering it for the log — `_getErrorDefaultUserInfo`, reached
// from `Error.localizedDescription` — and that box is written and then dropped.
// A live run showed exactly this as the only `ModelDecodingError` allocation at
// send time, on the Foundation side of the app-image test, with no throw after
// it, so the read never happened and the failure looked like nothing at all.
//
// The box is the app's own allocation — the caller writes the payload into the
// pointer the runtime handed it — so the address outlives the call, and reading
// it a moment later reads it correctly. Deferred rather than immediate because
// the store sequence is *after* the call, which is the whole reason the value
// was never there. Three attempts, then the record is left to expire.
const DEFER_MS = [2, 12, 50];

function deferRead(record, source) {
  const attempt = (index) => {
    // Guarded on the record, not on `pending`. A live run showed four
    // allocations inside the same millisecond — the app reporting one failure
    // several ways — and a single pending slot means each one replaces the
    // last. Guarding on the slot skipped every deferred read in that burst,
    // which is the silence this was written to end.
    if (record.done) return;                 // a throw, or an attempt, reported it
    const hit = readableValue(record, null);
    if (hit) {
      record.done = true;
      if (pending === record) pending = null;
      emit(source, record.name, record.site, null, hit.pointer,
        { paired: false, readFrom: hit.from, path: hit.text });
      return;
    }
    if (index + 1 < DEFER_MS.length) setTimeout(() => attempt(index + 1), DEFER_MS[index]);
  };
  setTimeout(() => attempt(0), DEFER_MS[0]);
}

// Where an error's value can be, most likely first. Two of the three are
// runtime bookkeeping and one is the app's:
//
//   box      — what `swift_allocError` returned, where the runtime copies the
//              value when the caller hands it a buffer instead
//   storage  — the buffer the caller passed, which an app call site writes into
//              itself right after the call
//   throw    — the argument `swift_willThrow` was given, when there is one
//
// The order is not cosmetic: a live record showed a Foundation allocation whose
// storage held nothing readable and whose throw carried no argument at all, and
// only the box had the value.
function readableValue(record, thrown) {
  const candidates = [
    ['box', record && record.box],
    ['storage', record && record.storage],
    ['throw', thrown],
  ];
  for (const [from, candidate] of candidates) {
    if (!candidate) continue;
    const text = readSwiftString(candidate);
    if (text) return { text, pointer: candidate, from };
    // An empty `String` is an answer, not an absence: `_countAndFlags` is zero
    // and `_object` is the shared empty-string singleton, so every shape the
    // reader knows fails and a `path` of "" used to be indistinguishable from a
    // word that holds no String at all. Those are different findings — "this
    // error names no route" against "this is not the error".
    if (emptyStringAt(candidate)) return { text: '', pointer: candidate, from, empty: true };
  }
  return null;
}

// Every word offset of `pointer` that reads as a Swift `String`, for a record
// where the single offset the layout predicts held nothing.
function stringsIn(pointer, limit = 64) {
  const found = [];
  if (!pointer) return found;
  for (let at = 0; at < limit; at += 8) {
    const text = readSwiftString(pointer.add(at));
    if (text) found.push({ at, text });
    else if (emptyStringAt(pointer.add(at))) found.push({ at, text: '' });
  }
  return found;
}

function reportThrow(context) {
  const armed = pending;
  try {
    if (!armed) { reportRepeat(context); return; }
    if (armed.thread !== Process.getCurrentThreadId()) { reportRepeat(context); return; }
    if (Date.now() - armed.at > PENDING_MS) pending = null;
    if (!pending) { reportRepeat(context); return; }
    const thrown = cleanPointer(context.x0);
    const hit = readableValue(armed, thrown);
    if (!hit) {
      // Not this error — leave the record armed for the one that is. Counted and
      // named, because "armed but nothing readable" is a different failure from
      // "never armed", and until now the two looked identical in the log.
      unreadThrows += 1;
      const site = armed.site || 'unknown';
      if (!unreadSites.has(site) && unreadSites.size < 8) {
        unreadSites.add(site);
        report('unread-throw', {
          n: unreadThrows,
          type: armed.name,
          site,
          throwSite: context.lr ? String(context.lr) : null,
          box: describeAddress(armed.box),
          storage: describeAddress(armed.storage),
          thrown: describeAddress(thrown),
          paired: Boolean(thrown && armed.storage && thrown.equals(armed.storage)),
          // What is actually there, so that "no String" is a reading rather
          // than a shrug: the box's own words, named, and every word offset in
          // it and in the storage that does read as a `String`.
          boxWords: describedWords(readBytesAt(armed.box, 32) || new Uint8Array(0)),
          candidates: [
            ...stringsIn(armed.box).map((hit) => ({ at: 'box', ...hit })),
            ...stringsIn(armed.storage).map((hit) => ({ at: 'storage', ...hit })),
          ].slice(0, 8),
          // Same reason as `built`: the offset is what names the function.
          frames: frames(context),
          why: 'no String at box, storage or throw; the value may not be this error',
        });
      }
      return;
    }
    const paired = Boolean(thrown && armed.storage && thrown.equals(armed.storage));
    armed.done = true;
    pending = null;
    emit('swift_willThrow', armed.name, armed.site, context, hit.pointer,
      { paired, readFrom: hit.from, path: hit.text });
  } catch (error) {
    console.log(`${TAG}: hook error: ${error.message}`);
  }
}

// A throw with no allocation behind it, of an error this probe has already
// named. Reported once per box: the point is the *moment* — this is the failure
// being used, not merely built — and that is the record whose absence made a
// live run look like the send was failing for some other reason entirely.
function reportRepeat(context) {
  const thrown = cleanPointer(context.x0);
  const known = thrown ? knownBoxes.get(thrown.toString()) : null;
  if (!known || known.reported) return;
  known.reported = true;
  report('repeat-throw', {
    type: known.name,
    site: known.site,
    path: known.path,
    throwSite: context.lr ? String(context.lr) : null,
    valuePointer: describeAddress(thrown),
    why: 'built earlier and thrown again; this throw decodes nothing new',
  });
}

// `name`/`site` come from the allocation that built the error, `valuePointer`
// comes from wherever the payload turned out to be readable, and `frames` from
// the throw that carried it. `context` is null when there was no throw — a
// deferred read of a box nothing throws — and then there are no registers to
// quote and no live stack to walk, so both are left out rather than faked.
// `extra` carries what only the throw can say: whether its argument was the
// error's own storage, and which of the two the value was read from.
function emit(source, name, site, context, valuePointer, extra = {}) {
  const path = readSwiftString(valuePointer);
  if (context) rememberBox(cleanPointer(context.x0) || valuePointer, name, site, path);
  const pathRaw = readBytesAt(valuePointer, 64);
  // The thrown value is not always the type whose fields are known. The app's
  // reporting layer re-throws through `ClaudeTelemetry.ReportedError<T>`, a
  // one-field generic wrapper — `underlying: T` — so the decoder's error sits
  // at whatever offset that field has in the wrapper rather than at zero. So
  // do not trust a single offset: try every word of the value for a String and
  // report each hit with the offset it came from. The coding path is one of
  // them, and where it sits names the wrapper's shape in the same record.
  const pathCandidates = [];
  if (valuePointer) {
    for (let at = 0; at < 64; at += 8) {
      const text = readSwiftString(valuePointer.add(at));
      if (text && text.length > 1 && text !== path) pathCandidates.push({ at, text });
    }
    pathCandidates.sort((a, b) => b.text.length - a.text.length);
  }
  // The incidental words, only so a null `path` still carries a trail.
  const words = context ? [context.x0, context.x1, context.x2, context.x3] : [];
  for (const base of (context ? [context.x0, context.x2] : [])) {
    try {
      if (base && !base.isNull()) {
        for (let offset = 0; offset < 64; offset += 8) words.push(base.add(offset).readPointer());
      }
    } catch (error) { /* not a readable value */ }
  }
  report('model-decoding-error', {
    n: reported,
    source,
    type: name,
    site,
    // Where the error was built. Foundation means this is a copy of an error
    // the app was already holding — the app is reporting a failure, not making
    // one — and the path is the app's own, carried through the copy.
    module: moduleNameOf(site),
    // Where the throw happened, next to where the error was built. Absent when
    // nothing threw, which is itself the useful part of a deferred read.
    throwSite: context && context.lr ? String(context.lr) : null,
    path,
    valuePointer: describeAddress(valuePointer),
    pathWords: pathRaw ? describedWords(pathRaw) : null,
    pathCandidates: pathCandidates.length ? pathCandidates.slice(0, 6) : null,
    underlying: underlyingError(valuePointer),
    scanNear: textNear(words, 640),
    frames: context ? frames(context) : null,
    ...extra,
  });
}

// The call that builds an error carries its type; the call that throws it
// carries the value. Neither has both, so both are hooked and the pair is
// matched up. The typed entry point carries both itself, and is kept for the
// `throws(T)` functions that use it.
//
// The signatures, as the runtime declares them and as this app's call sites
// confirm:
//
//   swift_allocError(const Metadata *type,             // x0 = the error's type
//                    OpaqueValue *value,               // x1 = its storage
//                    bool isTake,                      // x2
//                    bool isFromThrow)                 // x3
//
//   swift_willThrowTypedImpl(SwiftError *error,        // x0 = box
//                            const Metadata *errorType, // x1 = metadata
//                            TypedErrorInfoStorage *)   // x2
//
//   swift_willThrow(SwiftError *error)                 // x0 = box
//
// `swift_willThrow` is hooked for the value only: its argument holds no
// metadata, so it names nothing and would inflate `unresolved` if it were fed
// to the namer. It is not fed to it.
const THROW_EXPORTS = ['swift_allocError', 'swift_willThrowTypedImpl', 'swift_willThrow'];
const installed = new Set();

function installOne(name) {
  if (installed.has(name)) return true;
  let target = null;
  try { target = Module.findGlobalExportByName(name); } catch (error) { return false; }
  if (target === null) return false;
  try {
    Interceptor.attach(target, {
      onEnter() { onThrow(this.context, name); },
      // The box `swift_allocError` returns is where a *caller that does not
      // write the payload itself* leaves it: the runtime copies the value in,
      // and the pointer it was handed stays untouched. That is the Foundation
      // case — an allocation with no throw after it, whose storage read as
      // nothing — so the returned box is captured and read as well. The thread
      // is checked because `pending` belongs to one allocation, and an
      // unrelated allocation on another thread must not overwrite its box.
      onLeave(retval) {
        try {
          if (pending && pending.thread === Process.getCurrentThreadId()) {
            pending.box = cleanPointer(retval);
          }
        } catch (error) { /* never disturb the app */ }
      },
    });
  } catch (error) {
    return false;
  }
  installed.add(name);
  return true;
}

// libswiftCore may not be mapped when init() runs (it is called before the app's
// entrypoint), so keep trying briefly instead of installing once and missing
// every throw.
let hookTimer = null;
let hookTries = 0;
// How long the app ran before the hooks were in place. It cannot be zero: the
// exports live in libswiftCore, so dyld has to have mapped it first, and at
// `init` time it has not. What *can* be avoided is adding to that: this used to
// start from `boot()` on a 500 ms delay, so the app ran for most of a second
// with nothing intercepted — and a spawn run showed exactly that gap from the
// other side, with every `built` record on a bridge site and none on the
// decoder. So hook first, and report the wait rather than hide it.
const HOOK_POLL_MS = 20;
const HOOK_MAX_TRIES = 400;               // ~8 s of dyld taking its time
const STARTED_AT = Date.now();

function hook() {
  const done = THROW_EXPORTS.every((name) => installOne(name));
  hookTries += 1;
  if (done || hookTries > HOOK_MAX_TRIES) {
    if (hookTimer) clearInterval(hookTimer);
    hookTimer = null;
    report('hook', {
      installed: [...installed],
      tries: hookTries,
      elapsedMs: Date.now() - STARTED_AT,
      filter: TYPE_FILTER,
      // Empty is not necessarily failure: a gadget built with code_signing
      // "required" cannot patch code at all, so Interceptor is unavailable and
      // there is nothing to be had without a rebuild.
      note: installed.size === 0
        ? 'no hooks installed — Interceptor unavailable (gadget code_signing "required"?), or libswiftCore not yet mapped'
        : undefined,
    });
  }
}

// Called from `init` and from the listen-mode load, before anything else runs.
function startHooking() {
  if (hookTimer) return;
  hookTimer = setInterval(hook, HOOK_POLL_MS);
  hook();
}

// Every live `ModelDecodingError` in the heap, found by its *shape* instead of
// by watching one be thrown. This is the one thing here that does not need
// Interceptor — no code is patched, memory is only read — so it works in script
// mode and works even when the error was built before the probe attached, which
// is the case that has beaten every other approach.
//
// The field layout makes it findable: `path` is a native `String` at +0, the
// `sampleRate` Double is at +24 and this app's decoders always set it to 1.0,
// and the boxed `error` is at +32. So scan for the 1.0, step back to the value,
// and keep it if the first two words really are a `String`. Then report the
// *distinct paths*: one path repeated is a store of one error, several paths are
// several failures, and that is the question `path` alone could not answer.
const SAMPLE_RATE_ONES = '00 00 00 00 00 00 f0 3f';
// How much address space one scan is allowed to walk, and why there is a limit
// at all: `Memory.scanSync` over every writable range *blocked this thread*, and
// with hooks installed every allocation and throw in the app waits behind the
// callback that cannot be delivered while it runs — a live spawn froze on the
// Code tab. So the scan is asynchronous (one chunk of one range per turn, the
// thread yields between them), it is bounded, it runs only when asked for, and
// the largest ranges are walked first because the app's heap is the largest.
const SCAN_BUDGET = 192 * 1024 * 1024;

function scanForErrors() {
  const seen = new Map();
  let examined = 0;
  let scanned = 0;
  let ranges = [];
  try {
    ranges = Process.enumerateRanges('rw-').sort((a, b) => b.size - a.size);
  } catch (error) {
    report('live-errors', { count: 0, why: `cannot enumerate ranges: ${error.message}` });
    return;
  }

  const finish = (why) => {
    const errors = [...seen.values()];
    report('live-errors', {
      count: errors.length,
      onesMatched: examined,
      scannedBytes: scanned,
      rangesConsidered: ranges.length,
      stoppedBecause: why,
      // The headline: every distinct `path` a live ModelDecodingError carries.
      // One entry means one stored error; several mean several real failures.
      paths: [...new Set(errors.map((hit) => hit.path))],
      errors: errors.slice(0, 24),
    });
  };

  let index = 0;
  const nextRange = () => {
    if (index >= ranges.length) { finish('ranges-exhausted'); return; }
    if (scanned >= SCAN_BUDGET) { finish('budget-reached'); return; }
    const range = ranges[index];
    index += 1;
    const size = Math.min(range.size, SCAN_BUDGET - scanned);
    scanned += size;
    let advanced = false;
    const advance = () => { if (!advanced) { advanced = true; nextRange(); } };
    try {
      Memory.scan(range.base, size, SAMPLE_RATE_ONES, {
        onMatch(address) {
          examined += 1;
          const at = address.sub(24);
          const value = errorValueAt(at);
          if (!value) return;
          const key = `${value.path}\u0000${at.toString()}`;
          if (seen.has(key)) return;
          seen.set(key, { at: at.toString(), path: value.path, box: describeAddress(value.box) });
        },
        onError() { advance(); },
        onComplete() { advance(); },
      });
    } catch (error) {
      advance();
    }
  };
  nextRange();
}

function boot() {
  if (started) return;
  started = true;
  report('hello', {
    reportUrl,
    filter: TYPE_FILTER,
    frida: Frida.version,
    process: `${Process.arch} ${Process.platform}`,
  });
  startHooking();
  // The census is a launch-time story, so it goes out even if fewer than
  // CENSUS_MAX distinct types were thrown — `names:[NSFileManager, …]` with
  // `unresolved:0` is the line that proves the namer works on this build.
  setTimeout(census, 15000);
  // The heap scan is deliberately *not* scheduled. It is the one thing here
  // that costs real work, and a probe that spends the app's CPU on its own
  // initiative is a probe that changes what it is trying to observe. Ask for it:
  // `rpc.exports.scan()` at the attach-mode prompt, or the same call from a
  // script-mode build, after the failure has been produced.
}

rpc.exports = {
  // Called by the gadget and awaited — it gates the app's entrypoint — so this
  // must return immediately and must not throw.
  init(stage, parameters) {
    try {
      reportUrl = parameters && parameters.reportUrl ? String(parameters.reportUrl) : null;
      token = parameters && parameters.token ? String(parameters.token) : null;
    } catch (error) {
      console.log(`${TAG}: init failed: ${error.message}`);
    }
    // Before returning, and therefore before the app's entrypoint — the gadget
    // awaits this call. The hooks still cannot land until dyld has mapped
    // libswiftCore, but the poll starts here rather than three quarters of a
    // second later.
    startHooking();
    setTimeout(boot, 500);
    return { ok: true, reportUrl };
  },
  // The heap scan on demand, so a reproduction does not have to wait out the
  // timers. In the attach-mode CLI that is typing `rpc.exports.scan()`; a
  // script-mode build has no host to call it, which is why it is scheduled too.
  scan() {
    scanForErrors();
    return { ok: true };
  },
};

// Listen mode evaluates the file and never calls init (there is no gadget config
// to carry parameters), so boot on a timer; script mode has already run init by
// then and this no-ops.
//
// Hooking starts at load either way. In listen mode the app is already running
// and there is no window to lose, but starting late would mean the poll's first
// attempt happens after `boot()`, and that is the delay this file just removed.
startHooking();
setTimeout(() => { if (!started) boot(); }, 1000);
