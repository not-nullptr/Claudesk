'use strict';
// Swift-runtime recon for the closed-source Claude iOS app, run under Frida
// 17.21+ on a re-signed build (get-task-allow). Two jobs:
//
//   A. Dump ground truth about the Codable DTOs — every `Swift.Decodable`
//      conformance and the nominal types the Code surface decodes into. This
//      replaces reconstructing shapes from `__swift5_fieldmd` (scripts/*.py,
//      /workspace/ipa-work/fields.tsv) with what the runtime actually loaded,
//      including optionality the static dump could only guess at.
//
//   B. Catch the decode failure the facade log can only hint at. The phone
//      shows one opaque "Something went wrong"; the facade sees the app receive
//      a 200 and then send nothing more. Whatever throws, throws through the
//      Swift runtime's `swift_willThrow`, and the backtrace from there names the
//      exact call site (the app's symbols are stripped, so the frame resolves to
//      Claude+offset — feed that offset to Ghidra against the same binary).
//
// Load it against a running app:
//   frida -H 127.0.0.1:27042 Claude -l tools/frida/swift-probe.js -o /tmp/claude-frida.log
// or attach by name from a host that has frida-server:  frida -U -n Claude -l …

const log = (...parts) => console.log(parts.join(' '));

// ---------------------------------------------------------------- A: resolver
// Frida 17.21 added `types:` (nominal type descriptors), `protocols:` and
// `conformances:<Type>!<Protocol>` to the Swift resolver, alongside the
// functions-only queries it started with. `*` is the glob wildcard and `!`
// separates the two halves of a query. The set below is smallest-first so the
// log stays readable; widen the patterns to taste.
const CONFORMANCE_QUERIES = [
  'conformances:*!Swift.Decodable',
];
const TYPE_QUERIES = [
  'types:*!*EnvironmentResource*',
  'types:*!*EnvironmentList*',
  'types:*!*CodeProject*',
  'types:*!*Channel*',
  'types:*!*SessionResource*',
  'types:*!*SessionWatch*',
];
const FUNCTION_QUERIES = [
  // The generic decode entry points, so we can see what a hook would target.
  'functions:*!*JSONDecoder*decode*',
];

function resolver() {
  if (typeof Swift !== 'undefined' && Swift.available === false) {
    log('A: Swift runtime not available in this process');
    return null;
  }
  try {
    return new ApiResolver('swift');
  } catch (error) {
    log('A: swift ApiResolver unavailable:', error.message);
    return null;
  }
}

function dumpMatches(label, api, query) {
  let matches;
  try {
    matches = api.enumerateMatches(query);
  } catch (error) {
    log(`A: ${query} -> error ${error.message}`);
    return;
  }
  log(`A: ${label} ${query} -> ${matches.length} match(es)`);
  for (const match of matches) {
    log(`A:   ${match.address}  ${match.name}`);
  }
}

const api = resolver();
if (api) {
  for (const query of CONFORMANCE_QUERIES) dumpMatches('conformance', api, query);
  for (const query of TYPE_QUERIES) dumpMatches('types', api, query);
  for (const query of FUNCTION_QUERIES) dumpMatches('function', api, query);
}

// ------------------------------------------------------- B: thrown Swift errors
// `swift_willThrow` is a libswiftCore export, so it resolves without app
// symbols. It is called with the error value; for `any Error` (a three-word
// existential) the payload, type metadata and witness table arrive in x0/x1/x2
// on arm64. We deliberately do NOT call swift_getTypeName on those pointers — a
// wrong guess there segfaults the app — we just record where it threw and let
// the facade-side payload plus the decompiled call site name the type.
const THROW_TRACE_DEPTH = 12;
let throwBudget = 200; // a decode storm can throw thousands; cap the noise

function installThrowProbe() {
  const target = Module.findGlobalExportByName('swift_willThrow');
  if (target === null) {
    log('B: swift_willThrow not found — no Swift runtime?');
    return;
  }
  log(`B: hooking swift_willThrow @ ${target}`);
  Interceptor.attach(target, {
    onEnter(args) {
      if (throwBudget-- <= 0) return;
      const frames = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .slice(0, THROW_TRACE_DEPTH)
        .map((address) => {
          const symbol = DebugSymbol.fromAddress(address);
          return `      ${address}  ${symbol.moduleName}+${symbol.address - symbol.moduleBase}` +
            (symbol.name ? `  ${symbol.name}` : '');
        });
      log(`B: throw #${200 - throwBudget} x0=${args[0]} x1=${args[1]} x2=${args[2]}`);
      log(frames.join('\n'));
    },
  });
}

installThrowProbe();
log('probe installed');
