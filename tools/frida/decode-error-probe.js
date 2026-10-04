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
// A thrown Swift error is described by its metadata, and this probe names that
// metadata with a plain memory walk: metadata -> descriptor -> relative name.
// The type's descriptor holds the name as a relative string, so naming is a few
// pointer reads with no interpretation of the error value itself.
//
// A runtime accessor would be the authoritative namer — `swift_getTypeName` —
// but it dereferences whatever it is handed, and neither metadata pointer here
// is something this repo can confirm offline:
//
//   * the typed path (`swift_willThrowTypedImpl`) is disassembled-verified:
//     x1 is a metadata accessor's result. Safe.
//   * the untyped path (`swift_willThrow`) hands over an error box built by
//     `swift_allocError`, and *where the metadata sits inside that box* is
//     decided by libswiftCore, which ships in the iOS dyld shared cache and is
//     not in this bundle — so it cannot be read out. A wrong guess there is a
//     crash inside `swift_getTypeName`, on every throw, which is not a failure
//     mode worth risking for a nicer name.
//
// So the walk is the only crash-free option, and its cost is that a wrong
// descriptor offset reads as "no name" rather than a crash. That is exactly what
// the `throw-types` census is for: it turns a broken walk into a visible
// `unresolved` count instead of a silently quiet log, so the offset can be
// corrected from evidence. Note the offline reader agrees on the layout and this
// image simply has no statically-initialized value metadata to corroborate it:
// scanning `__constg_swiftt` for `MetadataKind`-tagged records finds none, i.e.
// this app's value metadata is instantiated lazily at run time.
//
// Offsets 8 and 16 are both tried and a candidate is accepted only if it reads
// as a type-name shape, so being off by a word degrades to the census rather
// than to a wrong report.
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_.]{0,120}$/;

function typeNameOf(metadata) {
  if (!metadata || metadata.isNull()) return null;
  for (const offset of [8, 16]) {
    try {
      const descriptor = metadata.add(offset).readPointer();
      if (!descriptor || descriptor.isNull()) continue;
      const relative = descriptor.add(8).readS32();
      const name = descriptor.add(8).add(relative).readUtf8String(128);
      if (name && NAME_SHAPE.test(name)) return name;
    } catch (error) { /* try the next offset */ }
  }
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
  report('throw-types', { names: [...censusNames], unresolved, filter: TYPE_FILTER });
}

function noteType(name) {
  if (name) {
    censusNames.add(name);
    if (censusNames.size >= CENSUS_MAX) census();
  } else {
    unresolved += 1;
  }
}

function onThrow(context, metadata) {
  try {
    const name = typeNameOf(metadata);
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
// Each reaches the metadata differently, and naming only works on the metadata,
// not on the box around it. The signatures are fixed by the runtime:
//
//   swift_willThrow(SwiftError *error)                 // x0 = box; type at +8
//   swift_willThrowTypedImpl(SwiftError *error,        // x0 = box
//                            const Metadata *errorType, // x1 = metadata
//                            TypedErrorInfoStorage *)   // x2
const THROW_EXPORTS = [
  { name: 'swift_willThrow', metadata: (context) => {
    try { return context.x0.add(8).readPointer(); } catch (error) { return null; }
  } },
  { name: 'swift_willThrowTypedImpl', metadata: (context) => {
    try {
      return context.x1 && !context.x1.isNull() ? context.x1 : context.x0.add(8).readPointer();
    } catch (error) { return null; }
  } },
];
const installed = new Set();

function installOne(spec) {
  if (installed.has(spec.name)) return true;
  let target = null;
  try { target = Module.findGlobalExportByName(spec.name); } catch (error) { return false; }
  if (target === null) return false;
  try {
    Interceptor.attach(target, {
      onEnter() { onThrow(this.context, spec.metadata(this.context)); },
    });
  } catch (error) {
    return false;
  }
  installed.add(spec.name);
  return true;
}

// libswiftCore may not be mapped when init() runs (it is called before the app's
// entrypoint), so keep trying briefly instead of installing once and missing
// every throw.
let hookTimer = null;
let hookTries = 0;
function hook() {
  const done = THROW_EXPORTS.every((spec) => installOne(spec));
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
