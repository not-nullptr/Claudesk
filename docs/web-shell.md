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
to the same `/api/remote/*` IPC this bridge serves, so sessions, models and the
account identity are unchanged. It *bootstraps* under the claude.ai default
`/api/bootstrap*` rather than the Desktop frame's `/edge-api/bootstrap*`; the
bridge recognizes both (see the greeting note below).

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

The Cowork approval-mode picker lists **Manual** and **Automatically approve**,
and offers **Skip all approvals** (`bypassPermissions`) only when two further
gates hold: the org's `cowork_settings.skip_approvals_enabled` (default false,
admin-only) and the `cowork_bypass_permissions_mode` growthbook flag. A
self-hosted, single-user deployment has no org admin to flip the first, so with
`CLAUDE_REMOTE_COWORK_SKIP_APPROVALS` on (default with the web shell) the bridge
rewrites the org's `cowork_settings` document and the bootstrap's growthbook
table to answer both as enabled (`grantCoworkSkipApprovals`,
`grantCoworkBypassGate`). This is a real safety switch — Skip all approvals runs
Cowork with no tool prompts — so it is off without the web shell and `…=0`
restores the upstream value.

## Status

Working with the flag on:

- the web chrome (wordmark, pill tabs, tall nav rows);
- Chat and Cowork, with the real local sessions: the list, opening a session,
  the model selector and the account identity (opening needs the session-viewer
  patch below);
- Cowork — the `Chat | Cowork` toggle appears and drives the local Cowork VM;
- Code — the full local surface (usage dashboard, projects, sessions) with
  folder browsing, via the route-alias patch below;
- the time-based home greeting ("Evening, {{ NAME }}") — the browser app
  bootstraps under `/api`, so the bridge now fills the greeting there as well as
  under the Desktop frame's `/edge-api` (see "Home greeting" below).

Not wired up yet (tracked here so it is not mistaken for done):

- **Cowork-on-web device model.** Cowork's *web* product also expects a paired
  "computer" device for browsing that machine's folders. Not needed for Code
  (folder browsing there goes through the Code file picker), so it is only
  relevant if the merged Cowork-in-chat surface is ever wanted.

## Chat and Cowork sessions

Opening a session is gated separately from listing it. ion-dist's chat/cowork
session *layout* refuses to open a local session unless the client identifies as
the Desktop app: when its user-agent check is false it redirects back to the home
composer (analytics reason `not_desktop_app`) and renders a download upsell in the
session's place. The web shell drops the Desktop token on purpose, so every
session — chat and Cowork alike, both listed under `/cowork/<id>` — bounced to the
home composer on click.

The `desktop-session-viewer-gate` renderer patch forces that check's value to
`true`. It reads the flag back from the layout's own `if(!x){ …"not_desktop_app"… }`
guard and rewrites the zero-argument user-agent call it is initialised from
(`let x=…()` → `let x=!0`), so it survives minification and changes nothing the
layout does not already do on a desktop-identified client. Like the route alias,
it is spliced and required only when `CLAUDE_REMOTE_WEB_SHELL=1`, so a default
deployment prepares a byte-identical renderer.

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

## Home greeting

The home greeting is not local copy: ion-dist reads `personalized_greeting` out
of its **bootstrap response** (an array of per-surface, per-weekday slots) and
only falls back to the built-in "You're here!" when that field is absent. The
bridge fills the official chat/code payload whenever the upstream sends none
(`injectPersonalizedGreeting`).

Which URL carries it depends on the shell. The Desktop frame bootstraps under
`/edge-api/bootstrap*`; a plain browser — the web shell — uses the claude.ai
default `/api/bootstrap*`. The bridge matches **both** prefixes (ion-dist's own
detector accepts `(?:edge-)?api`), so the greeting renders in either chrome.
Matching the entitlements document (`/api/bootstrap/<org>/current_user_access`)
is deliberately excluded, so the greeting is never injected into that shape.

## Account identity

The account menu and sidebar footer would otherwise read as a gateway config: a
gateway deployment fills the Account document with a synthetic identity — the OS
app user ("app" in this image) and an organization named "Gateway" — because a
third-party gateway has no real Anthropic account behind it. The claude.ai chrome
reads that identity from the bootstrap `account`, from `GET /api/account` and
`/api/account_profile`, from the organization document at
`/api/organizations/{uuid}`, and (for the footer's provider label) from
`ManagedConfig.managedRendererConfigStore`, which the bridge otherwise blanks.

With the web shell on and any account value set, the bridge overrides **just the
identity fields** — name, email, avatar, organization, plan — on those documents
(`applyAccountIdentity` / `applyOrganizationIdentity`), and surfaces the
deployment name through the renderer-config store so the footer stops reading
"Gateway". That last one is the official `deploymentDisplayName`, which the
bundle itself documents as "Overrides the provider label shown in the sidebar
footer, user-menu header, and connection-error banner" — no renderer patch is
needed, only the store value the bridge already controls. Only the fields set are
overridden: uuids, settings, capabilities and entitlements are left exactly as
upstream sent them, so Cowork, Code and the time-based greeting keep working. A
default deployment, and the Desktop shell, never reach any of this — the whole
path is gated on `webShellEnabled`.

This is **identity only**. There is no login/logout session and no per-user
separation yet: the account is operator-defined via `CLAUDE_REMOTE_ACCOUNT_NAME`,
`…_EMAIL`, `…_ORG`, `…_PLAN`, `…_AVATAR` and `CLAUDE_REMOTE_DEPLOYMENT_NAME`, and
there is no real account, billing or usage upstream to show.
`resolveAccountIdentity()` is the seam a future auth layer fills with a
per-session identity; the signed-in account, the sidebar name and the greeting
all resolve the operator's account name first (`CLAUDE_REMOTE_ACCOUNT_NAME`, else
the legacy `CLAUDE_REMOTE_USER_NAME`).

## Why it is fenced

The chrome and the surface set are the same switch in ion-dist (`isClaudeApp`),
so this flag deliberately changes both. Keeping it opt-in means the default
deployment stays on the Desktop shell with its full Code + Cowork surface set
until the web shell's remaining surfaces are wired up.
