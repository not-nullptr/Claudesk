'use strict';
// Response-body capture for the closed-source Claude iOS app, run under Frida.
//
// The Code surface GETs
//   /v1/environment_providers/private/organizations/{id}/environments/<env>
// gets a 200 back, and then dies in ClaudeApiServices.ModelDecodingError with
// `kind: unexpected_schema`. That wrapper keeps only path/isFailure/kind, so the
// offending field never reaches Sentry — the only way to name it is to read the
// bytes the app failed to make sense of.
//
// Two obvious places to grab those bytes miss on this build:
//
//   * `-[NSURLSession dataTaskWithRequest:completionHandler:]` never fires — the
//     app drives URLSession through Swift concurrency, not the block API.
//   * the private `-[NSURLSessionTask _onqueue_didReceive…]` selectors the Frida
//     recipes assume do not exist on this OS.
//
// What is left is the delegate path, which every URLSession flavour funnels
// through: the session's delegate — the app's own object, or Foundation's
// internal one for `async` — implements the `URLSession:dataTask:` methods.
// Rather than guess which class that is, enumerate the loaded classes and hook
// every implementer. Matches print status + body; everything else is dropped.
//
// Run:
//   frida -U -f com.anthropic.claude -l tools/frida/sentry-net.js
// or against a gadget in listen mode:
//   frida -H <phone-ip>:27042 -n Gadget -l tools/frida/sentry-net.js

const log = (...parts) => console.log(parts.join(' '));

// --------------------------------------------------------------------- config
// Substring of the request URL to keep. `null` captures every request.
const MATCH = 'environment_providers';
const MAX_BODY = 200000; // guard against a surprise multi-MB body

// -------------------------------------------------------------------- helpers
function allClasses() {
  const map = ObjC.enumerateLoadedClassesSync();
  const out = new Set();
  for (const image in map) for (const name of map[image]) out.add(name);
  return [...out];
}

function urlOf(task) {
  try {
    return new ObjC.Object(task).originalRequest().URL().absoluteString().toString();
  } catch (error) {
    return '';
  }
}

function matched(url) {
  return MATCH === null || url.indexOf(MATCH) !== -1;
}

function utf8(data) {
  try {
    const nsdata = new ObjC.Object(data);
    const text = nsdata.bytes().readUtf8String(nsdata.length());
    return text.length > MAX_BODY
      ? `${text.slice(0, MAX_BODY)}… (+${text.length - MAX_BODY} bytes)`
      : text;
  } catch (error) {
    return `<unreadable body: ${error.message}>`;
  }
}

// -------------------------------------------------------------------- capture
const pending = new Map(); // task handle -> accumulated body text
const hooked = new Set();  // implementation pointers already attached

function attach(implementation, handlers) {
  const key = implementation.toString();
  if (hooked.has(key)) return false;
  hooked.add(key);
  Interceptor.attach(implementation, handlers);
  return true;
}

function hookImplementers() {
  let classes = 0;
  for (const name of allClasses()) {
    const C = ObjC.classes[name];
    if (!C) continue;
    const receive = C['- URLSession:dataTask:didReceiveData:'];
    const response = C['- URLSession:dataTask:didReceiveResponse:completionHandler:'];
    const complete = C['- URLSession:task:didCompleteWithError:'];
    if (!receive && !response && !complete) continue;

    let any = false;

    if (receive) {
      any = attach(receive.implementation, {
        onEnter(args) {
          const task = args[3];
          const url = urlOf(task);
          if (!matched(url)) return;
          const key = task.toString();
          pending.set(key, (pending.get(key) || '') + utf8(args[4]));
        },
      }) || any;
    }

    if (response) {
      any = attach(response.implementation, {
        onEnter(args) {
          const url = urlOf(args[3]);
          if (!matched(url)) return;
          let status = '?';
          try { status = new ObjC.Object(args[4]).statusCode(); } catch (error) {}
          log(`status ${status}  ${url}`);
        },
      }) || any;
    }

    if (complete) {
      any = attach(complete.implementation, {
        onEnter(args) {
          const key = args[3].toString();
          if (!pending.has(key)) return;
          log(`\n=== body ${urlOf(args[3])} ===\n${pending.get(key)}`);
          pending.delete(key);
        },
      }) || any;
    }

    if (any) {
      log(`hooked ${name}  receive=${!!receive} response=${!!response} complete=${!!complete}`);
      classes += 1;
    }
  }
  return classes;
}

const installed = hookImplementers();
log(`sentry-net: hooked ${installed} URLSession delegate class(es); match=${MATCH === null ? '<all>' : MATCH}`);
