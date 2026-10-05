'use strict';
// Sentry capture reader for the Claude iOS app, run under Frida.
//
// The app's own error funnel is Sentry: whatever matters lands in a
// `captureEvent:`/`captureError:` call. Reading it here gets the value *before*
// the SDK serialises and ships it.
//
// The reason this is worth a separate instrument from decode-error-probe.js:
// for an error, this sees the `NSError` bridge — and it sees its **`userInfo`**.
// `ClaudeApiServices.ModelDecodingError` is built from a Swift `DecodingError`
// and retains it (decode-error-probe.js reads it off the value at +32), but only
// `path`/`isFailure`/`kind` make it into the description. If the type bridges
// through `CustomNSError`, the original error sits in `userInfo` under
// `NSUnderlyingErrorKey` — and Sentry keeps only `code`/`domain` of an NSError
// (see `SentryNSError`), so this is the only place it is still legible.
//
// Run:
//   frida -U -f com.anthropic.claude -l tools/frida/sentry-hook.js

const log = (...parts) => console.log(parts.join(' '));
const DROP = ['debug_meta', 'threads']; // bulky and unreadable; breadcrumbs kept

function allClasses() {
  const map = ObjC.enumerateLoadedClassesSync();
  const out = new Set();
  for (const image in map) for (const name of map[image]) out.add(name);
  return [...out];
}

function objJson(obj, pretty) {
  if (obj === null || obj.isNull()) return null;
  try {
    const data = ObjC.classes.NSJSONSerialization
      .dataWithJSONObject_options_error_(obj, 0, NULL);
    if (data.isNull()) return null;
    const text = new ObjC.Object(data).bytes().readUtf8String();
    if (!pretty) return text;
    try {
      const value = JSON.parse(text);
      for (const key of DROP) delete value[key];
      return JSON.stringify(value, null, 2);
    } catch (error) {
      // Still print it — the exception `value` (the route) is what we grep for,
      // and losing it because pretty-printing choked hid it before.
      return text;
    }
  } catch (error) {
    return null;
  }
}

function describe(cls, sel, arg) {
  let value;
  try { value = new ObjC.Object(arg); } catch (error) { return; }
  const tag = `[${cls} ${sel}] ${value.$className}`;

  // A built SentryEvent (and friends) serialises to the full report.
  try {
    if (value.respondsToSelector_(ObjC.selector('serialize'))) {
      const out = objJson(value.serialize(), true);
      if (out) { log(`\n=== ${tag} ===\n${out}`); return; }
    }
  } catch (error) { /* not an event */ }

  // An NSError: dump the userInfo Sentry is about to discard.
  try {
    if (value.respondsToSelector_(ObjC.selector('domain')) &&
        value.respondsToSelector_(ObjC.selector('userInfo'))) {
      log(`\n=== ${tag} ===`);
      log(`domain=${value.domain()}  code=${value.code()}`);
      // The bridged Swift error's localizedDescription is the only place its
      // `path` shows up here — the NSError userInfo is empty — so print it to
      // tell one ModelDecodingError from another.
      try {
        const description = value.localizedDescription();
        if (description && !description.isNull()) log(`desc=${description.toString()}`);
      } catch (error) { /* no localized description */ }
      const info = value.userInfo();
      log(objJson(info, true) || new ObjC.Object(info).toString());
      return;
    }
  } catch (error) { /* not an error */ }

  log(`\n=== ${tag} ===\n${value.toString()}`);
}

const CAPTURE =
  /(^|\s)(capture(Event|Error|Exception|Message)|captureEventIncrementingSessionErrorCount)/;

let installed = 0;
for (const cls of allClasses()) {
  if (!/sentry/i.test(cls)) continue;
  const C = ObjC.classes[cls];
  if (!C) continue;
  for (const sig of C.$ownMethods) {
    if (sig[0] !== '-') continue; // instance methods only
    const sel = sig.slice(2).trim();
    if (!CAPTURE.test(sel) || /Envelope/.test(sel)) continue;
    let implementation;
    try { implementation = C[sig].implementation; } catch (error) { continue; }
    Interceptor.attach(implementation, {
      onEnter(args) {
        try { describe(cls, sel, args[2]); } catch (error) { log(`dump err: ${error}`); }
      },
    });
    log(`[+] ${cls}  -${sel}`);
    installed += 1;
  }
}
log(`sentry-hook: installed ${installed} capture hook(s)`);
