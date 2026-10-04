# Frida instrumentation for the Claude iOS app

The Code tab fails on the phone as a single opaque "Something went wrong". The
facade log shows what the app **received**; it cannot show what the app **failed
to make of it**. This directory closes that half: it instruments a copy of the
(app's own, decrypted) IPA so the Swift runtime can be asked directly — which
`Decodable` types exist, and exactly which decode throws and where.

There is no jailbreak anywhere in this: on a stock device the only way in is to
**put the agent in the bundle yourself**, re-sign and install. `FridaGadget` is
that agent. Everything below is about how it talks back.

## Two interaction modes

The gadget's `interaction.type` is the only real choice, and both are built from
the same IPAs, the same dylib and the same `probe.js`:

| mode | who initiates | needs | loop |
| --- | --- | --- | --- |
| **`listen`** | your computer dials the phone | a machine on the phone's network | attach, edit `probe.js`, re-load — **no re-signing** |
| `script` | nobody; the probe POSTs to the facade | the `/__diag` route + token | works from any network; changing the probe means a rebuild |

`probe.js` reports through both sinks unconditionally — `send()` for an attached
controller, POST for standalone — so the same file works either way.

There is a **third path with no gadget in it at all**, and it is worth trying
first. Frida 17's CoreDevice backend spawns a *debuggable* app on a jailed iOS
17+ device over USB, so

```sh
frida -U -f com.anthropic.claude -l tools/frida/probe.js
```

instruments the app with no repackaging, no re-signing and nothing to install —
and because Frida itself is the debugger, arbitrary code runs, so Interceptor
works and the `throw` backtraces come back. It needs Developer Mode on the
phone, a mounted developer disk image, and the phone on USB. When it works it
deletes every moving part below, so reach for it before rebuilding anything.

It needs one file on the *host* too: the jailed spawn injects the gadget into
the app it just started, so Frida looks for a gadget dylib in the user cache dir
(`%LOCALAPPDATA%\Microsoft\Windows\INetCache\frida\gadget-ios.dylib` on Windows,
`~/.cache/frida/gadget-ios.dylib` on macOS) and fails with "need Gadget to
attach on jailed iOS" when it is missing. The release asset ships `.xz`; unpack
the 17.21.0 `ios-universal` one there under the name `gadget-ios.dylib`. And
install the *plain* app for this — a bundle that already carries a gadget would
get two agents in one process.

**Listen mode is the one to iterate in.** Install once, then:

```sh
frida-ps -H <phone-ip>:27042                       # confirm you can reach it
frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js
```

The gadget presents itself as the process **`Gadget`**. `on_load` is set to
`resume` so the app boots normally instead of hanging at its entrypoint until
you connect — the Code tab flow happens on a tap, long after you attach.

## Instruments, and why two of them are off

Frida's Interceptor docs are blunt about the cost: a callback "executes
synchronously and block[s] the target thread", the base overhead is a few
microseconds per call *before* any JavaScript runs, and one should not
"intercept calls to functions that are called a bazillion times per second".
With callbacks from every app thread serialized through one JS runtime, a hook
on a hot function is a convoy, not an observation. So `probe.js` opens with
three switches and only the cheap one is on:

| switch | default | fires | cost |
| --- | --- | --- | --- |
| `CAPTURE_DECODE_ERRORS` | **on** | once per real decode failure | ~13 per launch |
| `CAPTURE_THROWS` | off | once per failed `try`, `try?` included | thousands per launch |
| `CAPTURE_TYPES` | off | twice per run | 18k matches, ~150 sends of 8 KB |

The decode-error hook is the one that answers the question — a `Context` carries
the message and the coding path, which together name the offending field — and
it is built once per actual failure rather than once per speculative attempt.
The throw hook adds a backtrace at a site that hook already names, in exchange
for being in the path of every `try?` in the process. The census was needed once
(its answer is in `docs/mobile-code-re-findings.md`); each pass is 18k matches
and ~150 sends, and `send()` is documented as asynchronous but "not optimized
for high frequencies".

An earlier revision had all three on and drove the app onto its splash screen
for as long as it was attached. `hello` now reports the live set as `capturing`,
so a short log reads as "the quiet instrument was the only one on" rather than
"the probe found nothing". Flip a switch in the file and re-run; nothing else
needs to change.

## Pieces

| file | role |
| --- | --- |
| `probe.js` | the agent: dumps Swift types/conformances, hooks `swift_willThrow`, reports via `send()` and/or POST |
| `decode-error-probe.js` | one instrument: reports only `ClaudeApiServices.ModelDecodingError` (below) |
| `build-instrumented-ipa.mjs` | fetches + thins the gadget, stages the app, patches the Mach-O, writes the IPA |
| `swift-probe.js` | an older host-attach variant kept for reference |

## The one-instrument probe for `ModelDecodingError`

`decode-error-probe.js` exists because neither of `probe.js`'s two error
instruments catches this app's own decode error, and it is the one that matters
on the Code surface.

`CAPTURE_DECODE_ERRORS` hooks Foundation's `DecodingError.Context.init`, so it
sees a failure the **JSON decoder** builds. This app raises its own type instead:
`ClaudeApiServices.ModelDecodingError`, a struct in
`ClaudeApiServices/ModelDecodingError.swift` carrying `path: String`, which its
decoders construct and throw directly. It never passes through
`DecodingError.Context`, so that hook cannot see it — which is how a decode
failure can be visible on the phone and absent from a probe log that is
otherwise working. `CAPTURE_THROWS` *would* see it, but reports every throw in
the process, `try?` included, so it is off by default.

The new probe keeps the throw hook and drops the noise. It resolves the type of
each thrown value — metadata → descriptor → name, the same walk the offline
reader does, from a runtime address instead of a file offset — and reports only
when the name matches `ModelDecodingError`. The filter is a few pointer reads, so
it is cheap enough to leave attached, and the log is one line shape rather than a
census. Run it exactly like `probe.js`:

```sh
frida -H <phone-ip>:27042 -n Gadget -l tools/frida/decode-error-probe.js
```

Each hit reports `model-decoding-error {n, type, site, text:[…], frames:[…]}`.
`frames` is the throwing call site as `Claude+0x…` (feed it to Ghidra against the
same binary); `text` is the printable ASCII in the error box, which holds the
`path` the error was built with — the coding path that names the offending field.
`type` is there so a hit is self-evidently the right type.

**Naming is the one part that could be silently wrong**, so the probe calibrates
itself rather than trusting a quiet log.

The type is read where the error is *built*, not where it is thrown. Hooking the
throw entry points was tried first and failed on hardware: `swift_willThrow(box)`
hands over a box whose contents belong to libswiftCore — which ships in the iOS
dyld shared cache, not this bundle, so its layout cannot be read out here — and
four live runs found every word of that box to be String guts, ObjC data or zero,
never a metadata pointer. The typed entry point `swift_willThrowTypedImpl` does
pass metadata, but only covers `throws(T)` functions, and this app's decoders
throw untyped. So the probe hooks **`swift_allocError`** instead, whose first
argument *is* the error's type by ABI, with no box to walk; every untyped `throw`
in a Swift binary goes through it (this app's throw sites disassemble as
`bl _swift_allocError` then `bl _swift_willThrow`).

Two things still cannot be settled offline, so the probe learns them at run time.
*Whether x0 is the metadata (with the descriptor inside it) or already the
descriptor* — both occur — and so *where in the metadata the descriptor sits*.
Each throw is therefore tried against a small set of candidates and shapes; a
pair that returns the filtered name is trusted immediately (that string does not
appear by chance), any other pair must agree three times first, and the winner is
remembered and used alone from then on. The search is bounded and stops the
moment it locks, so a healthy run pays it only for its first few throws. It
announces the answer once as `calibrated {source, candidate, mode, why}`.

Every candidate is also tried **masked to its address bits**. arm64e pointers are
signed — the address is bits 0-47, bits 48-63 are the signature — so a box word
reads as `0x01_000001f6e05c51` where the mapped address is `0x1f6e05c51`, and
dereferencing the signed form lands on an unmapped page. A live run showed
exactly that: `x1` and `box+0` sharing the low 47 bits under different top bytes.

Alongside that, `throw-types {names:[…], unresolved, calibrated}` goes out 15 s
after boot (or as soon as 12 distinct types have been seen): the first distinct
error types named, how many allocations yielded no name at all, and how the
layout was found (or `null` if it never was). Every allocation resolves its type
even when it is not the one asked for, so that count is free. Setting
`TYPE_FILTER = null` at the top still reports every throw instead of filtering,
for when a full census is wanted.

A one-shot `layout {words:[…], names:[…]}` is emitted on the first allocation:
the argument registers' words, and which of them actually names a type
(`{at, via, name}`, `at` like `x0+8`, `via` `direct` or `deref8`). That report is
the whole answer to "where does the metadata live on this build" — a run that
stays blind carries the evidence instead of only the count.

## How the gadget runs `probe.js` in script mode

Easy to get wrong, so it is worth stating:

- The gadget evaluates the script, then calls **`rpc.exports.init(stage,
  parameters)`** — it is an RPC export, *not* a global function called `init`.
- It **waits for `init` to return before letting the app reach its entrypoint**,
  so `init` must return immediately. `probe.js` only stashes `parameters` there
  and hands off to a timer; the ObjC runtime, Foundation and the app's Swift
  metadata are all still cold at that point.
- In **listen mode none of this happens** — there is no config-supplied script,
  so `init` is never called and the probe boots off a short timer instead.
- The Swift resolver's query kinds are **`types:`**, **`protocols:`** and
  **`conformances:<Type>!<Protocol>`** (Frida 17.21+), each accepting `*` globs.
  Anything else is answered with a per-query `error` rather than a crash, which
  is how one run pins the syntax down.

## Build

Listen mode (nothing to configure server-side):

```sh
node tools/frida/build-instrumented-ipa.mjs \
  --app /workspace/ipa-work/extracted/Payload/Claude.app \
  --out Claude-frida.ipa \
  --interaction listen
```

Script mode:

```sh
node tools/frida/build-instrumented-ipa.mjs \
  --app /workspace/ipa-work/extracted/Payload/Claude.app \
  --out Claude-frida.ipa \
  --report-url https://<your-claudesk-host> --token <shared-secret>
```

No gadget at all — a plain repackage, which is the build to install when an
instrumented one crashes and you need a working app, or when Frida's CoreDevice
backend will spawn the app itself:

```sh
node tools/frida/build-instrumented-ipa.mjs \
  --app /workspace/ipa-work/extracted/Payload/Claude.app \
  --out Claude-plain.ipa \
  --interaction none
```

`--out` may be any path you can fetch the file from; `.gitignore` drops `*.ipa`
so a build never reaches a commit.

Either way it downloads FridaGadget 17.21.0 for iOS (the Swift `ApiResolver`
only gained type / protocol / conformance queries in 17.21.0), thins the
universal gadget to its arm64 slice, drops it plus `FridaGadget.config` into
`Frameworks/` **and** the `.app` root — Frida looks for the config both beside
the dylib and in the parent of a `Frameworks` directory, and resolves a relative
script against whichever it used — adds an `LC_LOAD_DYLIB` for it, and repackages
the IPA. In script mode `probe.js` goes in alongside; `--token` must match
`CLAUDE_MOBILE_FRIDA_TOKEN`.

## Script mode's server side

Set the token in `.env` and recreate the mobile service:

```sh
CLAUDE_MOBILE_FRIDA_TOKEN=<shared-secret>
```

`/__diag` does not exist unless that variable is set, and it checks the token
with a constant-time compare, so an internet-facing box exposes nothing by
default. The route sits *before* the login gate, so the probe needs no session.
Findings are logged verbatim as `[mobile-frida] …`.

## Attaching from Windows

The client and the gadget must be the *same version* — 17.21.0 — or the
handshake fails with an error that does not mention versions at all. With
[uv](https://docs.astral.sh/uv/) this is one command and touches no system
Python:

```sh
uv tool install frida-tools --with "frida==17.21.0"
uv tool update-shell          # only if uv warns the tools dir is not on PATH
frida-ps -H <phone-ip>:27042            # expect exactly one process: Gadget
frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js
```

`uv tool install` builds an isolated environment (frida 17.21.0 has a
`cp37-abi3-win_amd64` wheel, so any Python ≥3.7 works) and puts `frida`,
`frida-ps`, `frida-trace` … on PATH.

### JIT

**Not needed, and the config enforces that.** Frida's default JavaScript runtime
is already QuickJS, and QuickJS is a pure interpreter — no JIT, no RWX pages, no
entitlement. The gadget config pins `"runtime": "qjs"` explicitly so a future
Frida default cannot quietly move us onto V8, which *is* the runtime that wants
JIT. So no StikDebug, no LocalDevVPN, no `dynamic-codesigning`.

The one thing this does not settle is `Interceptor` itself: attaching a hook
writes a trampoline into executable memory, and iOS gates that separately from
the JS engine. The gadget is documented to work in re-signed apps on
non-jailbroken devices without any JIT entitlement, but if hooking turns out to
be what fails, the run says so — the `hook {installed:[…]}` line lists exactly
which throw hooks actually took. Empty there means the JIT entitlement is the
next thing to try.

### `code_signing`, and the launch crash

A jailed app that is not being debugged may not execute unsigned code, but the
gadget's default (`code_signing: "optional"`) assumes it can. Get that wrong and
the kernel kills the process during dyld initialisation — `EXC_BAD_ACCESS`
(`SIGKILL - CODESIGNING`), `CODESIGNING 2 Invalid Page` — before `probe.js` runs
a line. That reads exactly like a bad signature or a broken build. It is
neither, and no amount of re-signing helps.

The builder therefore defaults to `code_signing: "required"`, which is the
documented way to run "on a jailed iOS device without a debugger attached". The
trade-off is in the same sentence of the Frida docs: Interceptor becomes
unavailable, so part B (the `swift_allocError`/`swift_willThrowTypedImpl` hooks) cannot be installed and
`hook {installed:[]}` comes back empty with a `note` saying so. Part A — the type
and conformance census — hooks nothing and still works. Pass
`--code-signing optional` to get the hooks back whenever the app really is
spawned debuggable.

`required` is not a downgrade to live with, just the answer for a launch from
the home screen. When something *is* the debugger — `frida -U -f` over USB, or
an on-device JIT enabler such as StikDebug, which launches the app through a
debugger to flip the flag that permits executable memory — build with
`--code-signing optional` and Interceptor comes back. A `get-task-allow`
entitlement is necessary for either and not sufficient on its own: it makes the
app *debuggable*, and still nothing has attached.

## Install and run

1. Sign the built IPA with Feather and install it. Feather re-signs nested
   binaries, so the gadget is signed along with the app.
2. Launch the app. In listen mode, attach (above) and then open the Code tab —
   the flow that currently fails.
3. Read the findings.

## What to expect

- `hello {…}` — the script is alive, with Frida version and bundle id, and the
  live instrument set as `capturing`. A run whose log is four lines long is a
  run where only the decode-error hook was on.
- `hook {installed:[…], wanted:{…}}` — which hooks took, against which were
  asked for. With `throws` off, `installed` holding only
  `DecodingError.Context.init` is the expected answer.
- `types {…}` — the resolver's answer to each query. If a query spelling is
  wrong for this Frida build, its entry carries an `error` instead of a `sample`,
  which is what tells us the correct syntax.
- `names {query, chunk, of, names:[…]}` — the paged full list for the `Decodable`
  queries, since the summary truncates a multi-thousand-type census.
- `throw-summary {reported, suppressed, dropped, sites:[…]}` — sent at +30 s,
  after the late type pass: every throwing call site in the run with its total
  count, most frequent first. Repetition is capped **per site** (4 reports each),
  not only globally, because the loud sites are launch noise that repeats
  hundreds of times and a global cap alone runs out before the app has finished
  starting. A site doing something interesting throws once or twice, so the cap
  costs nothing real and the summary proves nothing was hidden. `suppressed` is
  what the per-site cap swallowed, `dropped` what the global limit swallowed
  after that; `sites` empty means the cap never engaged.
- `throw {n, seen, site, frames:[…], text:[…]}` — a thrown Swift error with a
  backtrace; `seen` is how often that site had thrown by this point (1 = first
  time) and `site` is the return address the cap keys on. The cap is decided from
  `lr` alone — a register read and a map lookup — because the report itself is
  what it is worth avoiding: symbolizing a stack per throw once parked the app on
  its splash screen. Someone changing this should keep the hot path allocation-
  and symbol-free. The app's
  symbols are stripped, so a frame reads `Claude+0x…`; decompile that offset in
  Ghidra against the same binary to name the call site. The frames *above* the
  Foundation internals are the app's own `init(from:)`. `text` is whatever
  printable ASCII hangs off the error value — Swift writes its own message there
  ("Expected to decode Double but found a string/data instead."), which names
  the failure without any further RE. Most of what launch throws is *not* a
  failure: `NSFileManager` probes for absent files, WebKit storage setup, and a
  polymorphic JSON-value decoder that `try?`s Int, Double and String in turn
  (that one repeats at a single call site dozens of times). A decode failure is
  the throw whose `text` names a type or a key.
- `decoding-error {n, where, text:[…], frames:[…]}` — the same failure seen at
  its source. Every Swift decode error is built by
  `DecodingError.Context.init(codingPath:debugDescription:underlyingError:)`, so
  this hook fires once per decode failure and reads the finished `Context` for
  its message and coding-path keys. `where:"Context.init"` is the call site with
  the arguments; `where:"Context"` is the constructed value, where a missing key
  reads as `No value associated with key CodingKeys(stringValue: "createdAt"…)
  ("createdAt")` — enough to name the DTO field outright.

## Risks / if it does not work

- **The app sits on its splash screen while attached.** The probe is slowing it
  down, not crashing it, and the culprit is always a hook on a hot function —
  see *Instruments* above. Turn the instruments off one at a time; if it still
  hangs with all three off, the probe is not the cause and the next thing to
  check is whether the app gets past splash *without* Frida at all.
- **App will not launch after installing.** Check `code_signing` first: with
  `optional` on a jailed device the kernel kills the app at launch (above), and
  the fix is a rebuild, not a re-sign. If it is already `required`, the gadget's
  own signature is the next suspect — Feather has to re-sign it to the app's
  team, and a stock Claude.app contains no loose `.dylib` at all, so this is the
  first one it has ever been asked to sign. Fallback: hand Feather the gadget
  *as a tweak* (it injects and signs it) and ship only `FridaGadget.config`
  (+ `probe.js`) in the IPA. The crash log says which it is: Settings → Privacy
  & Security → Analytics & Improvements → Analytics Data, look for
  `Claude-….ips`, or stream `pymobiledevice3 syslog live` while launching.
- **Nothing at all in the log.** The gadget did not load: check the load path
  (`@executable_path/Frameworks/FridaGadget.dylib`) and that `FridaGadget.config`
  sits beside the dylib (config discovery matches the gadget's filename with a
  `.config` suffix).
- **Listen mode: `frida-ps -H` cannot reach the phone.** Either the phone is on a
  different network, or iOS's local-network permission is gating the inbound
  connection (the app was never asked for it, so there is no prompt to accept).
  Workaround: build script mode instead — its egress goes to a host the app
  already talks to, so it is immune to this.
- **`hello` arrives but no `types`.** The resolver queries need adjusting; the
  reported per-query errors say how.
- **`decode-error-probe.js`: `throw-types` shows `names:[] unresolved:…`.** The
  probe could not name the type. Read the one-shot `layout` report: if any entry
  in `names` exists, the layout *is* findable and the search simply did not reach
  it — move the winning `at`/`via` to the front of `CANDIDATES`. If `names` is
  empty, `swift_allocError`'s first argument is not the type on this build after
  all, and the next thing to try is `swift_getTypeName` on x0 (safe only once x0
  is known to be a real pointer) or disassembling a known throw site. A
  non-empty `names` with `unresolved` near zero means naming is fine and a quiet
  `model-decoding-error` log is the real answer. (The relative name offset is
  signed and negative as often as positive; it is applied with `sub()` for the
  negative case, because Frida's `add()` throwing on a negative number would be
  caught and read as a wrong layout.)
