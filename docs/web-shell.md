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
- Cowork — the `Chat | Cowork` toggle appears and drives the local Cowork VM;
- Code — the full local surface (usage dashboard, projects, sessions) with
  folder browsing, via the route-alias patch below.

Not wired up yet (tracked here so it is not mistaken for done):

- **Home greeting.** The web home reads a greeting surface the bridge does not
  populate, so it shows the renderer's "You're here!" fallback instead of the
  time-based greeting the Desktop chrome shows.
- **Cowork-on-web device model.** Cowork's *web* product also expects a paired
  "computer" device for browsing that machine's folders. Not needed for Code
  (folder browsing there goes through the Code file picker), so it is only
  relevant if the merged Cowork-in-chat surface is ever wanted.

## Code routes

ion-dist resolves its internal code route to the local Code surface (`/code` →
`/epitaxy`) only when the user agent carries the Desktop token, and to
claude.ai's *cloud* Code otherwise. The web shell drops that token on purpose, so
without a change every Code route went to the cloud surface — which the org
reports admin-disabled, hence `/code/disabled`. The chrome and this alias read
the *same* predicate, so no user agent satisfies one and not the other.

The `desktop-code-route-alias` renderer patch forces the alias resolver's
desktop branch (`function za(e,t,n){t=!0;…}`), so the local Code stays reachable
under the web chrome. It is spliced and required only when
`CLAUDE_REMOTE_WEB_SHELL=1`, so a default deployment prepares a byte-identical
renderer; on a desktop-identified client the flag is already true, so the splice
is a no-op. The flag must be set on the `claude-desktop` service as well as the
bridge, because the renderer preparer (cont-init) reads it.

The Code *pill* is a second, independent gate. On a non-desktop client, clicking
it raises the "download the desktop app" upsell instead of navigating, unless
`hasClaudeCodeWebAccess` holds — which is `bad_moon_rising` (the "Claude Code web
access" gate) AND the `claude_code` entitlement. With the flag set, the bridge
adds `bad_moon_rising` to the bootstrap's `growthbook.features` (addressed by
ion-dist's Java-style name hash), so the pill navigates to the route above
instead of upselling.

## Why it is fenced

The chrome and the surface set are the same switch in ion-dist (`isClaudeApp`),
so this flag deliberately changes both. Keeping it opt-in means the default
deployment stays on the Desktop shell with its full Code + Cowork surface set
until the web shell's remaining surfaces are wired up.
