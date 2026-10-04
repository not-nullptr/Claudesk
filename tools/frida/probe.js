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
// What it collects:
//   A. the Swift type/conformance inventory (Frida 17.21's Swift ApiResolver),
//      which is how we stop reconstructing DTO shapes from __swift5_fieldmd;
//   B. every Swift error thrown in-process, with a backtrace — the decode
//      failure the app hides behind "Something went wrong".
//
// It is deliberately defensive: nothing here may crash the host app, so every
// step is wrapped and any failure is reported rather than thrown.

const TAG = 'claudesk-probe';

let reportUrl = null;
let token = null;
let seq = 0;
let sent = 0;
let started = false;

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

function chunked(kind, query, names) {
  const total = Math.ceil(names.length / CHUNK);
  for (let i = 0; i < total; i += 1) {
    post(kind, { query, chunk: i + 1, of: total, names: names.slice(i * CHUNK, (i + 1) * CHUNK) });
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
const THROW_LIMIT = 120;
let thrown = 0;

function frameOf(address) {
  try {
    const symbol = DebugSymbol.fromAddress(address);
    const offset = symbol.moduleBase ? address.sub(symbol.moduleBase) : null;
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

function reportThrow(context, where) {
  if (thrown >= THROW_LIMIT) return;
  thrown += 1;
  report('throw', {
    n: thrown,
    where,
    x0: String(context.x0),
    x1: String(context.x1),
    x2: String(context.x2),
    frames: frames(context),
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
  const done = THROW_EXPORTS.every(([name, where]) => installOne(name, where));
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
      // type census in part A needs no hooking, so it still works.
      note: installed.size === 0
        ? 'no hooks installed — Interceptor unavailable (gadget code_signing "required"?), or libswiftCore not yet mapped'
        : undefined,
    });
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
  });
  hookTimer = setInterval(hookThrows, 250);
  hookThrows();
  // The app's own Swift types register as they load, so a first pass now and a
  // second once the UI is up catch both the pre-registered and the lazy ones.
  dumpTypes('load');
  setTimeout(() => dumpTypes('settled'), 8000);
  // A third pass much later, since the Code tab's DTOs may only be pulled in
  // when that surface is first reached.
  setTimeout(() => dumpTypes('late'), 30000);
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
