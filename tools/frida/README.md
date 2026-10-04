# Frida instrumentation for the Claude iOS app

The Code tab fails on the phone as a single opaque "Something went wrong". The
facade log shows what the app **received**; it cannot show what the app **failed
to make of it**. This directory closes that half: it instruments a copy of the
(app's own, decrypted) IPA so the Swift runtime can be asked directly — which
`Decodable` types exist, what their real fields are, and exactly which decode
throws and where.

It is built for a device with **no jailbreak**, a **get-task-allow** cert, and
**no computer to attach from** — so there is no `frida -U`, no `iproxy`, no
`frida-server`. Instead the gadget runs in **script interaction mode** and
reports over the network to the Claudesk server, which is a host the phone can
already reach.

## Pieces

| file | role |
| --- | --- |
| `probe.js` | the on-device script: dumps Swift types/conformances, hooks `swift_willThrow`, POSTs findings to `/__diag` |
| `build-instrumented-ipa.mjs` | fetches + thins the gadget, stages the app, patches the Mach-O, writes the IPA |
| `swift-probe.js` | the same idea for a *host-attached* session (`frida -H … -l`), for when a computer is available |

## Build

```sh
node tools/frida/build-instrumented-ipa.mjs \
  --app  /workspace/ipa-work/extracted/Payload/Claude.app \
  --out  /workspace/RemoteUploads/Claude-frida.ipa \
  --report-url https://<your-claudesk-host> \
  --token <shared-secret>
```

It downloads FridaGadget 17.21.0 for iOS (the Swift `ApiResolver` only gained
nominal-type / protocol / conformance queries in 17.21.0), thins the universal
gadget to its arm64 slice, drops it plus `probe.js` and `FridaGadget.config`
into `Frameworks/`, adds an `LC_LOAD_DYLIB` for it, and repackages the IPA. The
`--token` must match `CLAUDE_MOBILE_FRIDA_TOKEN` below.

## Server

Set the token and restart the mobile service:

```sh
CLAUDE_MOBILE_FRIDA_TOKEN=<shared-secret>
```

`/__diag` does not exist unless that variable is set, and it checks the token
with a constant-time compare, so an internet-facing box exposes nothing by
default. Findings are logged verbatim as `[mobile-frida] …`.

## Install and run

1. Sign the built IPA with Feather and install it. Feather re-signs nested
   binaries, so the gadget is signed along with the app.
2. Launch the app and open the Code tab — the flow that currently fails.
3. Read the findings: `grep mobile-frida` on the mobile service log.

Nothing needs to be attached or connected; the script runs at launch and reports
on its own.

## What to expect in the log

- `[mobile-frida] #n hello {…}` — the script is alive, with Frida version and bundle id.
- `[mobile-frida] #n types {…}` — the resolver's answer to each query. If a query
  spelling is wrong for this Frida build, its entry carries an `error` instead of
  `matches`, which is how the correct syntax gets pinned down in one run.
- `[mobile-frida] #n throw {frames:[…]}` — a thrown Swift error with a backtrace.
  The app's symbols are stripped, so a frame reads `Claude+0x…`; decompile that
  offset in Ghidra against the same binary to name the call site.

## Risks / if it does not work

- **App will not launch after installing.** Most likely the gadget dylib was not
  signed (Feather only signing frameworks, not loose dylibs) or the app detects
  the change. Fallback: hand Feather the gadget *as a tweak* (it injects and
  signs it) and ship only `FridaGadget.config` + `probe.js` in the IPA.
- **Nothing at all in the log.** The gadget did not load: check the load path
  (`@executable_path/Frameworks/FridaGadget.dylib`) and that `FridaGadget.config`
  sits beside the dylib. Config discovery matches the gadget's filename with a
  `.config` suffix.
- **`hello` arrives but no `types`.** The resolver queries need adjusting; the
  reported per-query errors say how.
