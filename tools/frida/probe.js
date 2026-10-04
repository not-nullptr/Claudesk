'use strict';
// On-device probe. It is written to survive either way the gadget is configured
// (see tools/frida/build-instrumented-ipa.mjs, `--interaction`):
//
//   listen mode — the gadget opens a port and a controller attaches with
//     `frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js`. Findings
//     go out over that wire (`send`) and console.log lands in the CLI. This is
//     the loop to iterate in; nothing is baked into the app.
//
//   script mode — no host at all. The gadget runs this file from the bundle and
//     the probe POSTs its JSON to `<reportUrl>/__diag` on the Claudesk server,
//     so findings land in the same log the phone's traffic already reaches.
//
// It reports through both sinks unconditionally, so the same file works
// whichever way it is loaded.
//
// How the gadget runs this file in script mode, which is easy to get wrong:
//   The gadget evaluates the script and then calls rpc.exports.init(stage,
//   parameters) AUTOMATICALLY, and **blocks the app's entrypoint until it
//   returns**. So init must do nothing but stash the parameters and hand off to
//   a timer; any real work (ObjC, NSURLSession, the Swift resolver) happens
//   after the app is actually up. It is NOT a global function called `init`.
//
// The two parameters that matter (from FridaGadget.config):
//   reportUrl — the Claudesk base URL the app already talks to (e.g.
//               https://mobile.example.com), POSTed to `<reportUrl>/__diag`.
//   token     — the shared secret the server's diag route checks
//               (CLAUDE_MOBILE_FRIDA_TOKEN). Without it the route 404s.
//
// What it collects — C is on by default, A and B are opt-in (see CONFIG below):
//   A. the Swift type/conformance inventory (Frida 17.21's Swift ApiResolver),
//      which is how we stop reconstructing DTO shapes from __swift5_fieldmd;
//   B. every Swift error thrown in-process, with a backtrace — the decode
//      failure the app hides behind "Something went wrong". This one is off by
//      default: it hooks the path out of *every* `try` in the process, `try?`
//      included, and a hook that fires often enough to slow the app is a hook
//      that reports nothing. Repetition is additionally capped per call site,
//      keyed on `lr` so the decision costs a register read;
//   C. the DecodingError itself, caught at DecodingError.Context.init: its
//      message and coding path, which name the offending DTO field. A backtrace
//      alone says "something in the JSON decoder threw"; this says what about.
//      This is built once per real decode failure rather than per `try?`, so it
//      is the cheap instrument that answers the question — hence the default.
//
// It is deliberately defensive: nothing here may crash the host app, so every
// step is wrapped and any failure is reported rather than thrown.

const TAG = 'claudesk-probe';

let reportUrl = null;
let token = null;
let seq = 0;
let sent = 0;
let started = false;

// ------------------------------------------------------------------ config
// Frida's Interceptor docs are explicit that a callback "executes
// synchronously and block[s] the target thread", that the base overhead is a
// few microseconds per call *before* any JavaScript runs, and that one should
// not intercept "functions that are called a bazillion times per second". Two
// of the three instruments below break that rule; they stay off unless asked
// for, because an instrument that parks the app on its splash screen reports
// nothing at all, which is worse than reporting less.
//
//   CAPTURE_DECODE_ERRORS — on. `DecodingError.Context.init` is built once per
//     *actual* decode failure, which is a handful per launch (13 in the first
//     30 s of a real run) rather than per `try?`. It is also the instrument
//     that answers the question: the Context carries the message and the
//     coding path, which name the offending field.
//
//   CAPTURE_THROWS — off. `swift_willThrow` is the untyped-throws path out of
//     every `try` in the process, `try?` included, so it fires for every
//     element of every speculative decode. Its value is a backtrace at a site
//     the decode-error hook already names, and the first run showed what it
//     costs: 94 of 120 captures were one decoder walking its `try?` ladder.
//
//   CAPTURE_TYPES — off. The census answers "which Decodable types exist",
//     which was needed once and is now answered (see
//     docs/mobile-code-re-findings.md); each pass is 18k matches and ~150
//     sends of 8 KB, and `send()` is documented as asynchronous but "not
//     optimized for high frequencies". It is kept because a new build or a new
//     Frida version makes it worth re-running, but it is not worth the log
//     every time.
//
// Flip one here and re-run: nothing below needs to change.
const CAPTURE_DECODE_ERRORS = true;
const CAPTURE_THROWS = false;
const CAPTURE_TYPES = false;

function describe(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// HTTP egress through the app's own Foundation stack. Frida's Socket would need
// a raw TCP sink on the far end; NSURLSession needs only the URL the app
// already reaches, and picks up the device's proxy/DNS/trust like the app does.
function post(message) {
  if (!reportUrl) return;
  let body;
  try {
    body = JSON.stringify(message);
  } catch (error) {
    body = JSON.stringify({ kind: message.kind, seq: message.seq, at: message.at, payload: { error: String(error) } });
  }
  try {
    const nsBody = ObjC.classes.NSString.stringWithString_(message).dataUsingEncoding_(4 /* NSUTF8 */);
    const url = ObjC.classes.NSURL.URLWithString_(`${reportUrl.replace(/\/$/, '')}/__diag`);
    const request = ObjC.classes.NSMutableURLRequest.requestWithURL_(url);
    request.setHTTPMethod_('POST');
    request.setValue_forHTTPHeaderField_('application/json', 'Content-Type');
    if (token) request.setValue_forHTTPHeaderField_(token, 'X-Claudesk-Diag');
    request.setHTTPBody_(nsBody);
    const done = new ObjC.Block({
      retType: 'void',
      argTypes: ['object', 'object', 'object'],
      implementation() { sent += 1; },
    });
    ObjC.classes.NSURLSession.sharedSession().dataTaskWithRequest_completionHandler_(request, done).resume();
  } catch (error) {
    console.log(`${TAG}: post(${kind}) failed: ${error.message}`);
  }
}

// A missing Info.plist key comes back as a nil ObjC object; calling into it
// throws, and a throw here would abort the whole script before it hooks
// anything. Read it defensively — the value is only ever used for the greeting.
function bundleValue(read) {
  try {
    const value = read(ObjC.classes.NSBundle.mainBundle());
    return value && !value.isNull() ? value.toString() : null;
  } catch (error) {
    return `err:${error.message}`;
  }
}

// Two sinks, one message. A host-attached session (`frida -H … -l probe.js`,
// i.e. a gadget in listen mode) reads the findings off the wire; a standalone
// gadget in script mode has no controller, so it POSTs them to the facade
// instead. Sending is harmless with nobody listening, and posting is skipped
// when no reportUrl was configured, so the same file serves both.
function report(kind, payload) {
  const message = { kind, seq: ++seq, at: Date.now(), payload };
  console.log(`${TAG}: ${kind} ${describe(payload).slice(0, 400)}`);
  try {
    send(message);
  } catch (error) {
    // No controller attached — script mode. The POST below is the real sink.
  }
  post(message);
}

// ------------------------------------------------------------------- A: types
// Frida 17.21's Swift resolver takes three query kinds — `types:` (nominal type
// descriptors), `protocols:`, and `conformances:<Type>!<Protocol>` — each with
// `*` globs. `conformances:*!Swift.Decodable` is the money query: it enumerates
// every Decodable type the app registers, which is a superset of the DTOs the
// Code tab has to decode.
// Both the `module!name` and bare-name spellings of the `types:` glob are
// attempted: the resolver answers with an `error` for any spelling it does not
// accept, so one run pins the syntax down instead of another round of guessing.
const QUERIES = [
  'conformances:*!Swift.Decodable',
  'conformances:*!Swift.Encodable',
  'conformances:*!Swift.Codable',
  'types:*Environment*',
  'types:*!*Environment*',
  'types:*CodeProject*',
  'types:*!*CodeProject*',
  'types:*Channel*',
  'types:*Session*',
  'protocols:*Decodable*',
  'protocols:*!*Decodable*',
];

// The server logs each finding as one line, truncated, so a query that matches
// thousands of types has to be paged instead of dumped into a single payload.
const INLINE_CAP = 60; // matches echoed inline in the `types` summary
const CHUNK = 120; // names per follow-up `names` message

// Through report(), not post(): in the mode we actually run in — a host-attached
// session, no gadget config to carry parameters — reportUrl is null, so post()
// is a no-op and these pages would never leave the device. The inline `sample`
// in the `types` summary caps at 60 names, so that is the difference between a
// census and a footnote.
function chunked(kind, query, names) {
  const total = Math.ceil(names.length / CHUNK);
  for (let i = 0; i < total; i += 1) {
    report(kind, { query, chunk: i + 1, of: total, names: names.slice(i * CHUNK, (i + 1) * CHUNK) });
  }
}

function dumpTypes(reason) {
  let resolver;
  try {
    resolver = new ApiResolver('swift');
  } catch (error) {
    report('resolver-unavailable', { reason, error: error.message });
    return;
  }
  const results = [];
  for (const query of QUERIES) {
    try {
      const matches = resolver.enumerateMatches(query);
      const names = matches.map((m) => m.name);
      results.push({ query, count: matches.length, sample: names.slice(0, INLINE_CAP) });
      // Page the full list for the queries whose whole point is the census.
      if (matches.length > INLINE_CAP && /Decodable/.test(query)) {
        chunked('names', query, names);
      }
    } catch (error) {
      results.push({ query, error: error.message });
    }
  }
  report('types', { reason, results });
}

// --------------------------------------------------------- B: thrown errors
// `swift_willThrow` is a libswiftCore export, so it resolves without the app's
// (stripped) symbols. We read the registers and backtrace but deliberately do
// NOT interpret the error value — calling the wrong runtime entry on a bad
// pointer crashes the app, and the backtrace's `Claude+0x…` frame is what names
// the throwing call site when fed to Ghidra against the same binary. The frames
// *above* the Foundation internals are the app's own `init(from:)`.
//
// The cap is generous because app launch throws a great deal that has nothing to
// do with the failure: NSFileManager probes for files that are not there, WebKit
// storage setup, and a polymorphic JSON-value decoder that try?s Int, Double and
// String in turn. At 120 the Code tab's own decode can be pushed out of the
// window entirely — the first run hit the cap inside 0.6 s of launch.
const THROW_LIMIT = 400;
let thrown = 0;

// …and a global cap is not enough, because the noise is *repetitive*: in the
// first full run 94 of 120 captures were five sibling frames — the polymorphic
// JSON-value decoder walking its `try?` ladder — and a handful of others were
// FileManager/WebKit probes, so the budget was gone before the app finished
// launching. Capping per call *site* instead of globally keeps the interesting
// throws (a DTO's `init(from:)` throwing is exotic; the first run saw it once)
// inside the window no matter how loud launch is. Suppressed throws do not
// consume the global budget at all.
const NOISE_PER_SITE = 4;
const siteCounts = new Map();
let suppressed = 0; // capped by the per-site rule
let dropped = 0; // past the global limit even so

// Symbolizing is the expensive half of a backtrace, and the same handful of
// addresses come back throw after throw, so the answer is worth keeping: after
// the first pass over a stack, repeats are a map lookup.
const frameCache = new Map();

function frameOf(address) {
  const key = address.toString();
  const cached = frameCache.get(key);
  if (cached !== undefined) return cached;
  const text = symbolize(address);
  if (frameCache.size < 4096) frameCache.set(key, text);
  return text;
}

function symbolize(address) {
  try {
    const symbol = DebugSymbol.fromAddress(address);
    // DebugSymbol has no moduleBase, so read the load address off the module
    // itself — otherwise every app frame renders as `Claude+null 0x…` and the
    // offset has to be recovered by hand before Ghidra can be asked about it.
    const module = symbol.moduleName ? Process.findModuleByName(symbol.moduleName) : null;
    const offset = module ? address.sub(module.base) : null;
    return `${symbol.moduleName || '?'}+${offset}` + (symbol.name ? ` ${symbol.name}` : '');
  } catch (error) {
    return `?+${address}`;
  }
}

function frames(context) {
  let stack = [];
  try {
    stack = Thread.backtrace(context, Backtracer.ACCURATE);
  } catch (error) {
    // arm64 frame-pointer unwinding can come up short; the fuzzy walker still
    // usually finds the caller chain when the accurate one cannot.
  }
  if (stack.length < 4) {
    try {
      stack = Thread.backtrace(context, Backtracer.FUZZY);
    } catch (error) {
      /* keep the accurate result */
    }
  }
  return stack.slice(0, 24).map(frameOf);
}

// Reading a thrown Swift error's *text* is the difference between a backtrace
// that says "something inside the JSON decoder threw" and one that says which
// field, in which DTO, and why. The value is a Swift `Error` existential, and
// the runtime entry that would stringify it cannot be called safely from here,
// so nothing below calls anything: it takes the raw words of the error box (and
// the argument registers) as candidate pointers and pulls printable ASCII out
// of whatever they land on. Swift's own messages — "Expected to decode Double
// but found a string/data instead." — are in that memory verbatim, so a wrong
// guess about which word is which costs a wasted scan, never a crash.
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
  let run = "";
  for (let i = 0; i < view.length; i += 1) {
    const c = view[i];
    if (c >= 0x20 && c < 0x7f) {
      run += String.fromCharCode(c);
      continue;
    }
    if (run.length >= ASCII_MIN) runs.push(run);
    run = "";
  }
  if (run.length >= ASCII_MIN) runs.push(run);
  return runs;
}

// A Swift reference is not always a bare pointer: object references carry tag
// bits (a bridged String's `_object` has flags in the high and low bits), so
// each word is tried as-is and with the tag masks that leave a real address.
// Everything is inside try/catch — an unmapped guess just yields no runs.
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
  for (const mask of ["0xfffffffffffffff8", "0x0000ffffffffffff", "0x0000fffffffffff8", "0x00000000ffffffff"]) {
    try { add(value.and(ptr(mask))); } catch (error) { /* keep going */ }
  }
  return out;
}

// Everything printable reachable from a set of words.
function textNear(words, length = 512) {
  const found = new Set();
  for (const word of words) {
    for (const candidate of pointerCandidates(word)) {
      for (const run of asciiRuns(candidate, length)) found.add(run);
    }
  }
  return [...found];
}

// The per-site cap has to be decided *cheaply*, because this hook runs inside
// every throw in the process and launch throws benign errors by the thousand.
// Keying it on the symbolized backtrace (which is what the first cut did) means
// a stack walk plus a symbol lookup per frame, per throw — enough to park the
// app on its splash screen for minutes, since the thing being throttled is
// exactly the flood. `lr` is free: it is already in the CpuContext onEnter is
// handed, it is the address the throwing function returns to, and two different
// call sites do not share it. So the hot path is a register read and a map
// lookup; the expensive `frames()` is built only once a site has earned a
// report. (Symbols are stripped, so a reported site is still just `Claude+0x…`
// — the same reason a backtrace has to be fed to Ghidra.)
function reportThrow(context, where) {
  // A CpuContext without `lr` would collapse every throw onto one key and
  // throttle the whole run down to four reports, so the cap only applies when
  // the register is really there; without it this falls back to the plain
  // global limit, which is known to run at full speed. An empty `sites` list
  // next to a non-zero `dropped` is how the summary says that happened.
  const key = context.lr ? String(context.lr) : null;
  let seen = 1;
  if (key) {
    seen = (siteCounts.get(key) || 0) + 1;
    siteCounts.set(key, seen);
    if (seen > NOISE_PER_SITE) {
      suppressed += 1;
      return;
    }
  }
  if (thrown >= THROW_LIMIT) {
    dropped += 1;
    return;
  }
  thrown += 1;
  const stack = frames(context);
  // x0 is the SwiftError box; the error's own payload (a DecodingError's Context
  // and its message String) hangs off it. The neighbours are scanned too, since
  // which register holds what depends on the caller.
  const words = [context.x0, context.x1, context.x2, context.x3];
  try {
    if (context.x0 && !context.x0.isNull()) {
      for (let offset = 0; offset < 24; offset += 8) words.push(context.x0.add(offset).readPointer());
    }
  } catch (error) { /* not a readable box */ }
  report('throw', {
    n: thrown,
    seen,
    site: key,
    where,
    x0: String(context.x0),
    x1: String(context.x1),
    x2: String(context.x2),
    text: textNear(words, 640),
    frames: stack,
  });
}

// Which sites were loud enough to be capped away, so a censored log still says
// what it censored instead of looking like the app went quiet.
function reportThrowSummary() {
  report('throw-summary', {
    reported: thrown,
    suppressed,
    dropped,
    // The keys are `lr` values, so give them back as the same `Claude+0x…`
    // frames the reports carry — there are only ever a handful of distinct
    // sites, so symbolizing them here is cheap, and it is what makes a capped
    // log answer "did I lose the interesting one?" without a second run.
    sites: [...siteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        let name = key;
        try {
          name = frameOf(ptr(key));
        } catch (error) { /* keep the raw key */ }
        return `${name}×${count}`;
      }),
  });
}

// swift_willThrow is the untyped-throws path; swift_willThrowTypedImpl is its
// typed-throws sibling (Swift 6). Hook whichever exists, whichever way the app
// was compiled.
const THROW_EXPORTS = [
  ['swift_willThrow', 'willThrow'],
  ['swift_willThrowTypedImpl', 'willThrowTypedImpl'],
];
const installed = new Set();

function installOne(name, where) {
  if (installed.has(name)) return true;
  let target = null;
  try {
    target = Module.findGlobalExportByName(name);
  } catch (error) {
    return false;
  }
  if (target === null) return false;
  try {
    Interceptor.attach(target, {
      onEnter() {
        reportThrow(this.context, where);
      },
    });
  } catch (error) {
    return false;
  }
  installed.add(name);
  return true;
}

// libswiftCore may not be mapped at the instant init() runs (it is called
// before the app's entrypoint), so keep trying for a few seconds rather than
// installing the hook once and silently missing every throw.
const HOOK_TRIES = 40;
let hookTimer = null;
let hookTries = 0;
function hookThrows() {
  const done =
    (CAPTURE_THROWS ? THROW_EXPORTS.every(([name, where]) => installOne(name, where)) : true) &&
    (CAPTURE_DECODE_ERRORS ? installContextHook() : true);
  hookTries += 1;
  if (done || hookTries > HOOK_TRIES) {
    if (hookTimer) clearInterval(hookTimer);
    hookTimer = null;
    report('hook', {
      installed: [...installed],
      tries: hookTries,
      // An empty list is not necessarily a failure: a gadget built with
      // code_signing "required" (the default here, the only way a jailed app
      // survives launch without a debugger) cannot patch code at all, so
      // Interceptor is unavailable and there are no backtraces to be had. The
      // type census needs no hooking, so it still works. And an empty list is
      // not a failure at all when nothing was asked for.
      note: installed.size === 0 && (CAPTURE_DECODE_ERRORS || CAPTURE_THROWS)
        ? 'no hooks installed — Interceptor unavailable (gadget code_signing "required"?), or libswiftCore not yet mapped'
        : undefined,
      wanted: { decodeErrors: CAPTURE_DECODE_ERRORS, throws: CAPTURE_THROWS },
    });
  }
}

// ------------------------------------------------- C: the DecodingError itself
// The throw hook above answers "which function threw"; this one answers "about
// what". Every Swift decode failure — the app's own and Foundation's — is built
// by `DecodingError.Context.init(codingPath:debugDescription:underlyingError:)`,
// and its second argument is the human-readable reason. The arguments are Swift
// values (a String is two words, an Array one), so rather than interpret them
// they are handed to the same printable-ASCII scan the throw hook uses: the
// finished Context sits in the buffer the callee was given, and the message and
// the coding-path keys are readable in it (or one hop from it). A decode failure
// shows up here as a `decoding-error` finding whose `text` names the type and,
// for a missing key, the field.
const CONTEXT_INIT =
  '$ss13DecodingErrorO7ContextV10codingPath16debugDescription010underlyingB0ADSays9CodingKey_pG_SSs0B0_pSgtcfC';
const CONTEXT_LIMIT = 48;
let contextHookInstalled = false;
let contexts = 0;

function installContextHook() {
  if (contextHookInstalled) return true;
  let target = null;
  try {
    target = Module.findGlobalExportByName(CONTEXT_INIT);
  } catch (error) {
    return false;
  }
  if (target === null) return false;
  try {
    Interceptor.attach(target, {
      onEnter() {
        this.bases = [this.context.x0, this.context.x8];
        this.index = contexts;
        contexts += 1;
        if (this.index >= CONTEXT_LIMIT) return;
        report('decoding-error', {
          n: this.index + 1,
          where: 'Context.init',
          text: textNear([this.context.x1, this.context.x2, this.context.x3, this.context.x4], 384),
          frames: frames(this.context),
        });
      },
      onLeave() {
        // { codingPath: [CodingKey], debugDescription: String, underlyingError:
        // Error? } — a four-word struct, so whether it comes back in x0–x3 or
        // through an indirect buffer in x8 depends on how the caller allocated
        // the result, and the args it was called with fill every return
        // register besides. Rather than bet on one ABI, take both entry pointers
        // plus whatever register holds the first word on return and scan the lot;
        // an unreadable guess yields no runs, never a crash.
        if (this.index >= CONTEXT_LIMIT) return;
        const words = [this.retval];
        for (const base of this.bases) {
          try {
            if (!base || base.isNull()) continue;
            for (let offset = 0; offset < 64; offset += 8) words.push(base.add(offset).readPointer());
          } catch (error) { /* not a readable buffer */ }
        }
        try {
          const text = textNear(words, 384);
          if (text.length) report('decoding-error', { n: this.index + 1, where: 'Context', text });
        } catch (error) { /* nothing readable */ }
      },
    });
    contextHookInstalled = true;
    installed.add('DecodingError.Context.init');
    return true;
  } catch (error) {
    return false;
  }
}

// -------------------------------------------------------------------- wiring
// Everything real is deferred: init() runs before the app's entrypoint, so the
// ObjC runtime, Foundation and the app's Swift metadata are all still cold.
function boot() {
  if (started) return;
  started = true;
  report('hello', {
    reportUrl,
    hasToken: Boolean(token),
    frida: Frida.version,
    process: Process.arch + ' ' + Process.platform,
    bundle: bundleValue((bundle) => bundle.bundleIdentifier()),
    version: bundleValue((bundle) => bundle.objectForInfoDictionaryKey_('CFBundleShortVersionString')),
    // Which instruments are live, so a short log is legible as "only the quiet
    // one was on" rather than "the probe found nothing".
    capturing: { decodeErrors: CAPTURE_DECODE_ERRORS, throws: CAPTURE_THROWS, types: CAPTURE_TYPES },
  });
  if (CAPTURE_DECODE_ERRORS || CAPTURE_THROWS) {
    hookTimer = setInterval(hookThrows, 250);
    hookThrows();
  }
  if (CAPTURE_TYPES) {
    // The app's own Swift types register as they load, so a first pass now and a
    // second once the UI is up catch both the pre-registered and the lazy ones.
    dumpTypes('load');
    setTimeout(() => dumpTypes('settled'), 8000);
    // A third pass much later, since the Code tab's DTOs may only be pulled in
    // when that surface is first reached.
    setTimeout(() => dumpTypes('late'), 30000);
  }
  if (CAPTURE_THROWS) {
    // Last, so it counts everything the run saw — a log that hit a cap should
    // say which site was loudest rather than just stop mid-stream.
    setTimeout(reportThrowSummary, 30000);
  }
}

let sawInit = false;

rpc.exports = {
  // Called by the gadget (and awaited — it gates the app's entrypoint), so this
  // must return immediately. Never throw out of here: a throwing init would
  // leave the app half-started.
  init(stage, parameters) {
    sawInit = true;
    try {
      reportUrl = parameters && parameters.reportUrl ? String(parameters.reportUrl) : null;
      token = parameters && parameters.token ? String(parameters.token) : null;
    } catch (error) {
      console.log(`${TAG}: init failed: ${error.message}`);
    }
    console.log(`${TAG}: init stage=${stage} reportUrl=${reportUrl}`);
    setTimeout(boot, 500);
    return { ok: true, reportUrl };
  },
};

// A host-attached session (a gadget in listen mode, driven by `frida -H … -l`)
// evaluates this file and never calls init — there is no gadget config to carry
// parameters — so boot on a short timer instead of waiting for a call that will
// not come. In script mode init has already run by then, and this no-ops.
setTimeout(() => {
  if (!started && !sawInit) boot();
}, 1000);
