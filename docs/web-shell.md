# Web shell (experiment)

`CLAUDE_REMOTE_WEB_SHELL=1` renders ion-dist's **browser** (claude.ai) chrome —
the `Claude` wordmark, the pill `Home`/`Code` tabs, the taller `New`/`Customize`
rows — instead of the Desktop chrome, while keeping this bridge's local IPC data
layer. It is off by default and experimental.

## How the shell is chosen

ion-dist ships one bundle for claude.ai and Claude Desktop and picks its shell
from the user agent: a `Claude/<version>` token means "Desktop app". The remote
preload appends that token so the official route selector exposes the Desktop
surfaces. With `CLAUDE_REMOTE_WEB_SHELL=1` the preload keeps the browser user
agent (`config.webShell`), so ion-dist renders the web shell — but it still talks
to the same `/api/remote/*` IPC and `/edge-api/bootstrap` this bridge serves, so
sessions, models and the account identity are unchanged.

## Cowork

The web shell gates Cowork behind org entitlements rather than a separate
product: its web-Cowork predicate reads `dramatic_shrimp` (the secret internal
flag) plus the `cowork` gate. Cowork-on-web is the "Remote Control" entitlement
— "Lets members control Cowork on their computers from claude.ai or the Claude
mobile app" — which is exactly this topology, since the computer running Cowork
is this container.

The deployment's `current_user_access.features` list carries `chat`, `cowork`,
`claude_code`, `claude_code_desktop`, … but not `dramatic_shrimp`. When the flag
is set, the bridge adds the missing Cowork entitlements to that list in the
bootstrap response and in `/api/bootstrap/<org>/current_user_access` (see
`grantWebShellEntitlements`). It only adds a feature that is **absent** — an
existing entry, including a `blocked_by_*` one, is left exactly as upstream set
it, so this cannot silently override an org policy.

## Status

Working with the flag on:

- the web chrome (wordmark, pill tabs, tall nav rows);
- Chat, with the real local sessions, model selector and account identity;
- Cowork — the `Chat | Cowork` toggle appears and drives the local Cowork VM.

Not wired up yet (tracked here so it is not mistaken for done):

- **Code.** The web shell's Code surface is claude.ai's *cloud* Code, which the
  org reports admin-disabled here, so `/code` lands on `/code/disabled`. The
  working Code is the Desktop's local `epitaxy` surface, which the web shell
  remaps away. Reaching it needs either a route rewire or an entitlement that
  makes the web Code remote into this device.
- **Device / folder browsing.** Cowork-on-web expects a paired "computer"
  device (the `DeviceRegistry` / `RemoteControlServing` surfaces) to browse that
  machine's folders. The bridge does not publish those surfaces yet.
- **Home greeting.** The web home reads a greeting surface the bridge does not
  populate, so it shows the renderer's "You're here!" fallback instead of the
  time-based greeting the Desktop chrome shows.

## Why it is fenced

The chrome and the surface set are the same switch in ion-dist (`isClaudeApp`),
so this flag deliberately changes both. Keeping it opt-in means the default
deployment stays on the Desktop shell with its full Code + Cowork surface set
until the web shell's remaining surfaces are wired up.
