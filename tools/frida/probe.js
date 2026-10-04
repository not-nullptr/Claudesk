'use strict';
// On-device probe, loaded by FridaGadget in **script interaction mode** (see
// tools/frida/build-instrumented-ipa.mjs). It runs with no host attached: it
// reports by POSTing JSON to the Claudesk server, so the findings land in the
// same log the phone's traffic already reaches. That is the whole point of the
// no-host setup — there is no Mac, no USB and no frida-server in this loop.
//
// The gadget hands us its `parameters` object from FridaGadget.config via the
// `init()` entry point below. Two of them matter:
//   reportUrl — the Claudesk base URL the app already talks to (e.g.
//               https://claude.ai), POSTed to `<reportUrl>/__diag`.
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
function post(kind, payload) {
  if (!reportUrl) return;
  let message;
  try {
    message = JSON.stringify({ kind, seq: ++seq, at: Date.now(), payload });
  } catch (error) {
    message = JSON.stringify({ kind, seq: ++seq, at: Date.now(), payload: { error: String(error) } });
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

function report(kind, payload) {
  console.log(`${TAG}: ${kind} ${describe(payload).slice(0, 400)}`);
  post(kind, payload);
}

// ------------------------------------------------------------------- A: types
// The query kinds Frida 17.21 added are guessed at here — `conformances` is
// taken straight from the release example, the singular forms may or may not
// exist. Every query is attempted and its outcome reported, so a single run
// tells us which spellings the resolver in *this* build actually accepts
// instead of us guessing again.
const QUERIES = [
  'conformances:*!Swift.Decodable',
  'conformance:*!Swift.Decodable',
  'nominal:*!*EnvironmentResource*',
  'nominal:*!*EnvironmentList*',
  'nominal:*!*CodeProject*',
  'nominal:*!*Channel*',
  'nominal:*!*SessionResource*',
  'nominal:*!*SessionWatch*',
];

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
      results.push({
        query,
        count: matches.length,
        matches: matches.slice(0, 400).map((m) => `${m.address} ${m.name}`),
      });
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
// the throwing call site when fed to Ghidra against the same binary.
const THROW_LIMIT = 120;
let thrown = 0;

function hookThrows() {
  const target = Module.findGlobalExportByName('swift_willThrow');
  if (target === null) {
    report('throw-hook-missing', { note: 'swift_willThrow not exported' });
    return;
  }
  Interceptor.attach(target, {
    onEnter(args) {
      if (thrown >= THROW_LIMIT) return;
      thrown += 1;
      const frames = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .slice(0, 14)
        .map((address) => {
          const symbol = DebugSymbol.fromAddress(address);
          const offset = symbol.moduleBase ? address.sub(symbol.moduleBase) : null;
          return `${symbol.moduleName || '?'}+${offset}` + (symbol.name ? ` ${symbol.name}` : '');
        });
      report('throw', {
        n: thrown,
        x0: String(args[0]),
        x1: String(args[1]),
        x2: String(args[2]),
        frames,
      });
    },
  });
}

// -------------------------------------------------------------------- wiring
function init(parameters) {
  reportUrl = parameters && parameters.reportUrl ? String(parameters.reportUrl) : null;
  token = parameters && parameters.token ? String(parameters.token) : null;
  report('hello', {
    reportUrl,
    hasToken: Boolean(token),
    frida: Frida.version,
    process: Process.arch + ' ' + Process.platform,
    bundle: bundleValue((bundle) => bundle.bundleIdentifier()),
    version: bundleValue((bundle) => bundle.objectForInfoDictionaryKey_('CFBundleShortVersionString')),
  });
  hookThrows();
  // The app's own Swift types register as they load, so a first pass now and a
  // second once the UI is up catch both the pre-registered and the lazy ones.
  dumpTypes('load');
  setTimeout(() => dumpTypes('settled'), 8000);
}

// In script mode Frida calls init() with the config's `parameters`. If a loader
// runs this without them, still do the half that needs no destination: the
// throw hook and the type dump (which will simply have nowhere to report, and
// say so in the app's own console).
setTimeout(() => {
  if (reportUrl) return;
  hookThrows();
  dumpTypes('no-parameters');
}, 3000);
