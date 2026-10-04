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

**Listen mode is the one to iterate in.** Install once, then:

```sh
frida-ps -H <phone-ip>:27042                       # confirm you can reach it
frida -H <phone-ip>:27042 -n Gadget -l tools/frida/probe.js
```

The gadget presents itself as the process **`Gadget`**. `on_load` is set to
`resume` so the app boots normally instead of hanging at its entrypoint until
you connect — the Code tab flow happens on a tap, long after you attach.

## Pieces

| file | role |
| --- | --- |
| `probe.js` | the agent: dumps Swift types/conformances, hooks `swift_willThrow`, reports via `send()` and/or POST |
| `build-instrumented-ipa.mjs` | fetches + thins the gadget, stages the app, patches the Mach-O, writes the IPA |
| `swift-probe.js` | an older host-attach variant kept for reference |

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
unavailable, so part B (the `swift_willThrow` hooks) cannot be installed and
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

- `hello {…}` — the script is alive, with Frida version and bundle id.
- `hook {installed:[…]}` — which throw hooks took.
- `types {…}` — the resolver's answer to each query. If a query spelling is
  wrong for this Frida build, its entry carries an `error` instead of a `sample`,
  which is what tells us the correct syntax.
- `names {query, chunk, of, names:[…]}` — the paged full list for the `Decodable`
  queries, since the summary truncates a multi-thousand-type census.
- `throw {frames:[…]}` — a thrown Swift error with a backtrace. The app's symbols
  are stripped, so a frame reads `Claude+0x…`; decompile that offset in Ghidra
  against the same binary to name the call site. The frames *above* the
  Foundation internals are the app's own `init(from:)`.

## Risks / if it does not work

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
