'use strict';
// Network-side capture for the Claude iOS app, run under Frida.
//
// This is the *indirect* half of the Code-tab hunt. The direct half is
// decode-error-probe.js, which reads the app's own ClaudeApiServices
// .ModelDecodingError off the Swift runtime. This file does something different:
// it records the server bytes the decoder choked on. A schema mismatch usually
// means the response is missing/renamed/retyped a field, so seeing the response
// names the field even though the error object itself never touches the wire.
//
// It exists because two earlier attempts produced nothing:
//
//   * `-[NSURLSession dataTaskWithRequest:completionHandler:]` never fires — the
//     app drives URLSession through Swift concurrency, not the block API.
//   * the private `-[NSURLSessionTask _onqueue_didReceive…]` selectors the Frida
//     recipes assume do not exist on this OS build.
//
// So bodies are read off the delegate path (every class implementing the
// `URLSession:dataTask:` methods is hooked), and — because a silent run is
// useless — every outgoing task is logged at `-resume`. If the request we care
// about is made at all, the `->` line proves it and shows its real URL; if it is
// *not* there, the failing decode is not fed by a live URLSession request and
// the network angle is closed for good.
//
// Run:
//   frida -U -f com.anthropic.claude -l tools/frida/sentry-net.js
// or against a gadget in listen mode:
//   frida -H <phone-ip>:27042 -n Gadget -l tools/frida/sentry-net.js

const log = (...parts) => console.log(parts.join(' '));

// --------------------------------------------------------------------- config
// Substring a URL must contain to have its *body* printed and to be highlighted
// in the outgoing log. `null` captures every request.
const FOCUS = 'environment_providers';
// Log every outgoing NSURLSessionTask at resume (deduped, capped). This is what
// tells a silent run apart from a request that never happened.
const LOG_URLS = true;
const MAX_URLS = 400;
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

function focused(url) {
  return FOCUS === null || url.indexOf(FOCUS) !== -1;
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

// ------------------------------------------------------------------ outgoing
// Hooked first, and on purpose: a `->` line for every task is the one signal
// that survives every delegate/transport difference. A task whose URL contains
// FOCUS is remembered so its body is printed on completion even if the match is
// only on a prefix of the real URL.
const watching = new Set(); // task handle -> print its body

function hookOutgoing() {
  const resume = ObjC.classes.NSURLSessionTask['- resume'];
  if (!resume) {
    log('sentry-net: -[NSURLSessionTask resume] not found; no outgoing log');
    return;
  }
  const seen = new Set();
  Interceptor.attach(resume.implementation, {
    onEnter(args) {
      let method = '?';
      let url = '';
      try {
        const request = new ObjC.Object(args[0]).originalRequest();
        method = request.HTTPMethod().toString();
        url = request.URL().absoluteString().toString();
      } catch (error) {
        return;
      }
      const key = `${method} ${url}`;
      if (focused(url)) watching.add(args[0].toString());
      if (!LOG_URLS || seen.has(key) || seen.size >= MAX_URLS) return;
      seen.add(key);
      log(`-> ${key}${focused(url) ? '   [focus]' : ''}`);
    },
  });
  log('sentry-net: logging outgoing NSURLSessionTask.resume');
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

function hookDelegates() {
  let classes = 0;
  for (const name of allClasses()) {
    const C = ObjC.classes[name];
    if (!C) continue;
    const receive = C['- URLSession:dataTask:didReceiveData:'];
    const response = C['- URLSession:dataTask:didReceiveResponse:completionHandler:'];
    const complete = C['- URLSession:task:didCompleteWithError:'];
    if (!receive && !response && !complete) continue;

    const wants = (task) => {
      const url = urlOf(task);
      return focused(url) || watching.has(task.toString());
    };
    let any = false;

    if (receive) {
      any = attach(receive.implementation, {
        onEnter(args) {
          if (!wants(args[3])) return;
          const key = args[3].toString();
          pending.set(key, (pending.get(key) || '') + utf8(args[4]));
        },
      }) || any;
    }

    if (response) {
      any = attach(response.implementation, {
        onEnter(args) {
          if (!wants(args[3])) return;
          let status = '?';
          try { status = new ObjC.Object(args[4]).statusCode(); } catch (error) {}
          log(`status ${status}  ${urlOf(args[3])}`);
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

hookOutgoing();
const installed = hookDelegates();
log(`sentry-net: hooked ${installed} URLSession delegate class(es); focus=${FOCUS === null ? '<all>' : FOCUS}`);
