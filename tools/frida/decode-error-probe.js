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
// This probe keeps the throw hook and drops the noise: it resolves the type of
// each thrown value and reports only the one asked for. Naming a type is a
// handful of pointer reads, so it is cheap enough to leave attached, and the log
// has one line shape instead of a census.
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
const TYPE_FILTER = 'ModelDecodingError';
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
// A throw reaches the runtime either as `swift_willThrow(box)` or, for typed
// throws, `swift_willThrowTypedImpl(box, metadata, storage)`. Naming the thrown
// type means finding its metadata and reading the name out of the metadata's
// descriptor.
//
// Two things about that cannot be settled from this repo offline, so the probe
// learns them at run time rather than assuming them:
//
//   * where the metadata sits. The typed path's second argument is metadata by
//     ABI (disassembly-verified in this app: x1 is a metadata accessor's
//     result). The untyped path hands over a box built by `swift_allocError`,
//     and *where the metadata word lives inside that box* belongs to
//     libswiftCore — which ships in the iOS dyld shared cache and is not in this
//     bundle, so it cannot be read out here.
//   * whether the word found is the metadata (with the descriptor inside it) or
//     already the descriptor.
//
// So each throw is tried against a small set of candidates and shapes, and the
// pair that keeps answering is remembered. A pair that yields the *filtered*
// name is trusted at once — that string does not appear by chance — while any
// other pair must agree three times first, so a one-off coincidental read cannot
// lock the probe onto the wrong layout. The search is bounded and stops as soon
// as it locks, so a healthy run pays it only for its first few throws.
//
// A runtime accessor (`swift_getTypeName`) would name types authoritatively, but
// it dereferences whatever it is handed, and the untyped box's metadata word is
// exactly what is unknown — so calling it would risk crashing on every throw.
// The walk reads defensively instead: a wrong guess yields no name, never a
// crash, which is what lets it be searched for at run time at all.
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const DEREF_MODES = [8, 16, 0, 'direct'];

function ptrOrNull(value) {
  try { return value && !value.isNull() ? value : null; } catch (error) { return null; }
}

function boxWord(context, offset) {
  try { return ptrOrNull(context.x0.add(offset).readPointer()); } catch (error) { return null; }
}

// Where in a throw's register/box the metadata might be, most likely first.
//
// The box is walked in pointer steps out to 88 bytes: a first run showed the
// error box stack-allocated with its first five words zero and the only
// image-pointer-looking word at +40, so the metadata is not at the front the way
// a `{Storage, Type}` layout would put it. The whole prefix is cheap to try, and
// the search stops as soon as it locks.
const BOX_WORDS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88];
const CANDIDATES = {
  swift_willThrow: (context) => BOX_WORDS.map((offset) => boxWord(context, offset)),
  swift_willThrowTypedImpl: (context) =>
    [ptrOrNull(context.x1), ...BOX_WORDS.map((offset) => boxWord(context, offset))],
};

// A descriptor keeps its name at +8 as a relative pointer. That offset is signed
// and negative as often as positive, and Frida's `add()` is not a safe home for
// a negative number (it throws, which the catch would swallow into a silent "no
// name" — indistinguishable from a wrong layout). So the negative case is
// applied with `sub()`, which only ever sees a positive magnitude.
function relativeName(descriptor) {
  if (!descriptor || descriptor.isNull()) return null;
  try {
    const field = descriptor.add(8);
    const relative = field.readS32();
    const address = relative < 0 ? field.sub(-relative) : field.add(relative);
    const name = address.readUtf8String(128);
    return name && NAME_SHAPE.test(name) ? name : null;
  } catch (error) { return null; }
}

// arm64e pointers are signed: the address lives in bits 0-47 and bits 48-63
// hold the signature. A box word therefore reads as 0x01_000001f6e05c51 where
// the mapped address is 0x1f6e05c51, and a live run showed exactly that — x1 and
// box+0 sharing `0x1f6e05c51` under different top bytes. Dereferencing the signed
// form lands on an unmapped address, throws, and is swallowed as "no name",
// which is indistinguishable from a wrong layout. So every candidate is tried
// both as-read and masked down to its address bits.
const POINTER_MASKS = ['0x0000ffffffffffff', '0x00ffffffffffffff'];

function variants(pointer) {
  if (!pointer) return [];
  const out = [pointer];
  for (const mask of POINTER_MASKS) {
    try {
      const masked = pointer.and(ptr(mask));
      if (!masked.isNull() && !masked.equals(pointer)) out.push(masked);
    } catch (error) { /* keep what we have */ }
  }
  return out;
}

function attemptName(candidates, index, mode) {
  const candidate = candidates[index];
  if (!candidate) return null;
  for (const pointer of variants(candidate)) {
    if (mode === 'direct') {
      const name = relativeName(pointer);
      if (name) return name;
      continue;
    }
    try {
      const name = relativeName(pointer.add(mode).readPointer());
      if (name) return name;
    } catch (error) { /* try the next variant */ }
  }
  return null;
}

const votes = new Map();  // "source|index|mode" -> consecutive agreements
const locks = new Map();  // source -> { index, mode } once trusted
const BRUTE_THROWS = 400;
let bruteThrows = BRUTE_THROWS;
let lockMisses = 0;
let learned = null;       // reported once, so a log shows how the layout was found
let layoutSent = false;

// One-shot, on the first throw: which word of the box, if any, names a type —
// and by which shape. This is the evidence that settles the layout, so a run
// that stays blind is diagnostic instead of just quiet.
function reportLayout(context, source) {
  if (layoutSent) return;
  layoutSent = true;
  const words = [];
  const names = [];
  const inspect = (pointer, at) => {
    if (!pointer) return;
    for (const candidate of variants(pointer)) {
      const tag = candidate.equals(pointer) ? '' : '+masked';
      for (const mode of DEREF_MODES) {
        let name = null;
        if (mode === 'direct') name = relativeName(candidate);
        else {
          try { name = relativeName(candidate.add(mode).readPointer()); } catch (error) { /* not a pointer */ }
        }
        if (name) names.push({ at: at + tag, via: String(mode), name });
      }
    }
  };
  for (const offset of BOX_WORDS) {
    const word = boxWord(context, offset);
    words.push(word ? word.toString() : null);
    inspect(word, `box+${offset}`);
  }
  inspect(ptrOrNull(context.x1), 'x1');
  report('layout', {
    source,
    x0: ptrOrNull(context.x0) ? context.x0.toString() : null,
    x1: ptrOrNull(context.x1) ? context.x1.toString() : null,
    words,
    names,
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
  if (TYPE_FILTER === null) return true; // calibration: everything
  if (!name) return false; // unknown type is not the type we asked for
  return name.toLowerCase().includes(TYPE_FILTER.toLowerCase());
}

// ------------------------------------------------------------- reading text
// The thrown value's *fields* are never interpreted — no accessor is called on
// the error, because calling the wrong entry on a bad pointer crashes the app.
// Instead the raw words of the box are taken as candidate pointers and printable
// ASCII is pulled out of whatever they land on. `ModelDecodingError(path: …)` is the
// error's own description format, and its `path` String's bytes are either
// inline in the box or one hop away, so the coding path is readable in that
// memory verbatim. A wrong guess costs a wasted scan.
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
// *distinct* thrown type names are reported once, with a count of thrown values
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
    filter: TYPE_FILTER,
    // How the layout was learned, if it was; the one-shot `layout` report above
    // carries the evidence when it was not.
    calibrated: learned,
  });
}

function noteType(name) {
  if (name) {
    censusNames.add(name);
    if (censusNames.size >= CENSUS_MAX) census();
  } else {
    unresolved += 1;
  }
}

function onThrow(context, source) {
  try {
    reportLayout(context, source);
    const name = typeNameOf(source, context);
    noteType(name);
    if (!matches(name)) return;
    const key = context.lr ? String(context.lr) : null;
    if (key) {
      const seen = (siteCounts.get(key) || 0) + 1;
      siteCounts.set(key, seen);
      if (seen > PER_SITE) { capped += 1; return; }
    }
    if (reported >= SITE_LIMIT) { capped += 1; return; }
    reported += 1;
    // x0 is the error box; its first words are the ModelDecodingError struct
    // (path, isFailure, sampleRate, error, recoveredCount), so the path String
    // is in there. The argument registers are scanned too, since which one holds
    // what depends on the caller.
    const words = [context.x0, context.x1, context.x2, context.x3];
    try {
      if (context.x0 && !context.x0.isNull()) {
        for (let offset = 0; offset < 64; offset += 8) words.push(context.x0.add(offset).readPointer());
      }
    } catch (error) { /* not a readable box */ }
    report('model-decoding-error', {
      n: reported,
      type: name,
      site: key,
      text: textNear(words, 640),
      frames: frames(context),
    });
  } catch (error) {
    // Never let the probe disturb the app.
    console.log(`${TAG}: hook error: ${error.message}`);
  }
}

// swift_willThrow is the untyped path, swift_willThrowTypedImpl its Swift 6
// sibling; a throw takes one or the other, so installing both does not double-
// report, and hooking both means the probe does not depend on how the throwing
// site was compiled.
//
// Each reaches the metadata differently; the probe knows only that the typed
// path's second argument *is* metadata (see CANDIDATES, which searches the rest).
// The signatures are fixed by the runtime:
//
//   swift_willThrow(SwiftError *error)                 // x0 = box
//   swift_willThrowTypedImpl(SwiftError *error,        // x0 = box
//                            const Metadata *errorType, // x1 = metadata
//                            TypedErrorInfoStorage *)   // x2
const THROW_EXPORTS = ['swift_willThrow', 'swift_willThrowTypedImpl'];
const installed = new Set();

function installOne(name) {
  if (installed.has(name)) return true;
  let target = null;
  try { target = Module.findGlobalExportByName(name); } catch (error) { return false; }
  if (target === null) return false;
  try {
    Interceptor.attach(target, {
      onEnter() { onThrow(this.context, name); },
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
function hook() {
  const done = THROW_EXPORTS.every((name) => installOne(name));
  hookTries += 1;
  if (done || hookTries > 40) {
    if (hookTimer) clearInterval(hookTimer);
    hookTimer = null;
    report('hook', {
      installed: [...installed],
      tries: hookTries,
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

function boot() {
  if (started) return;
  started = true;
  report('hello', {
    reportUrl,
    filter: TYPE_FILTER,
    frida: Frida.version,
    process: `${Process.arch} ${Process.platform}`,
  });
  hookTimer = setInterval(hook, 250);
  hook();
  // The census is a launch-time story, so it goes out even if fewer than
  // CENSUS_MAX distinct types were thrown — `names:[NSFileManager, …]` with
  // `unresolved:0` is the line that proves the namer works on this build.
  setTimeout(census, 15000);
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
    setTimeout(boot, 500);
    return { ok: true, reportUrl };
  },
};

// Listen mode evaluates the file and never calls init (there is no gadget config
// to carry parameters), so boot on a timer; script mode has already run init by
// then and this no-ops.
setTimeout(() => { if (!started) boot(); }, 1000);
