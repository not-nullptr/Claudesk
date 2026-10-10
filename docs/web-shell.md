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
- Cowork — the `Chat | Cowork` toggle appears and drives the local Cowork VM,
  and its tool permissions (the question and approval cards) surface in the
  browser via the permission-wiring patch below;
- Code — the full local surface (usage dashboard, projects, sessions) with
  folder browsing, via the route-alias patch below;
- the time-based home greeting ("Evening, {{ NAME }}") — the browser app
  bootstraps under `/api`, so the bridge now fills the greeting there as well as
  under the Desktop frame's `/edge-api` (see "Home greeting" below);
- browser notifications for everything the Desktop app would notify about —
  finished turns, "needs your input", tool permission cards, AskUserQuestion —
  including while every tab is closed, via Web Push (see "Notifications"
  below).

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

*Placement* is a second, independent gate in the same area. New sessions are
placed remotely — claude.ai's cloud Cowork — whenever the renderer does not
believe it runs as the Desktop app: its placement helper evaluates the platform
check that requires the `Claude/<version>` user-agent token (the preload's
`claudeAppBindings` is present, the token is not) before it ever consults the
account, and a remote placement makes the composer prime a cloud session with
`POST /api/organizations/<org>/cowork/sessions` — an endpoint only claude.ai
serves, so the bridge answers 404 and a new chat with manual approvals died on
that response. The `web-local-session-placement` renderer patch forces the
platform check (`let i=…()` → `let i=!0`), read back as the zero-argument call
in the declarator directly after the one carrying the
`yukon_silver_dramatic_shrimp` literal, so placement follows the account's own
`dramatic_shrimp_enabled` setting. The bridge declares that setting `false` on
the bootstrap account document (see Account identity) — the same document the
app's current-account context reads — so the composer takes the local path this
bridge backs over the Desktop IPC. Spliced and required only when
`CLAUDE_REMOTE_WEB_SHELL=1`.

## Cowork tool permissions

Cowork's question and tool-approval cards are fed by the app's pending-permission
store, and the only thing that wires that store — the session event subscription
plus the `getAll().pendingToolPermissions` hydration — is a hook called inside the
Desktop app's root. The app tree mounts the Desktop-only side-effect hosts through
one slot component that renders them only when the client identifies as the
Desktop app and `null` otherwise; the web shell drops that identity on purpose, so
the store was never wired there. The transcript still streamed ("Asking a
question…"), but no card ever appeared and the session waited forever on its
first ask — `Tool permission stream closed before response received` once the
turn was stopped.

The `web-cowork-permission-wiring` renderer patch calls that wiring hook from the
slot itself, before the identity gate, so the store subscribes and hydrates in
either shell. The hook is ref-counted and its requests are keyed by request id, so
the Desktop root's own call — and the duplicate events it already receives — are
unaffected. The slot is selected by its own `componentName:"DesktopChecks"` label
and the hook's call is read back from the Desktop root's body (the first element
of the comma sequence carrying the locale-change effect), so renamed minifier
output still matches; a second slot, or one that no longer matches, refuses rather
than splicing the call into the wrong component. Like the other chrome patches it
is spliced and required only when `CLAUDE_REMOTE_WEB_SHELL=1`, so a default
deployment prepares a byte-identical renderer.

## Notifications

Claude notifies: a finished turn ("Claude finished a task"), a session waiting
on input, a tool permission card, an AskUserQuestion card, a Cowork VM that
became ready, scheduled-task outcomes. In the official Desktop app those are
native notifications from the main process; here the container has no
notification daemon and nobody at its Xvfb display, so they were invisible —
and the web shell's own "enable notifications" actions could not help, because
they register with claude.ai's server-side push (Firebase Cloud Messaging) and
persist a preference on a backend this deployment does not have.

The bridge now delivers them itself, in three parts.

- **Capture (`bridge-wrapper/main.cjs`).** The wrapper finds the official
  main-process notification service by shape (its chunk name and export aliases
  change with every Desktop build) and wraps its show/close methods. The final
  title and body are not re-derived — the official code computes them inside its
  own methods — so the native `Notification.prototype.show` is observed and the
  record it carries is matched back to the in-flight call; a capture that never
  saw a display record was suppressed by the official side (level off,
  unsupported platform) and is not relayed. Each shown notification becomes a
  `DesktopNotifications` event carrying the official tag, title, body, kind,
  session and route; the official "user is viewing this session" suppression is
  neutralized host-side (nobody is at the container display) and applied by each
  browser against its own focused route instead. The wrapper also tracks the
  captures so a click relayed from a browser notification re-runs the official
  click handler (opening the session on the host, clearing its pending-prompt
  bookkeeping) and reports the route it navigated to. Permission notifications
  keep their "Allow once" action, answered through the official response path.
- **Display (`bridge/public/remote-preload.js` and `bridge/public/sw.js`).**
  The preload publishes `claude.web.DesktopNotifications` (status and permission
  request mapped to the browser's `Notification` permission; `showNotification`
  creating a real browser notification, clicks focusing the tab and opening the
  session route) and renders the relayed events itself — so the renderer-driven
  notifications (VM ready, hub awaiting, ...) work in either shell, and the
  official "enable notifications" affordances have a working permission path.
  While the permission is granted the page also registers a push subscription
  (its service worker shows pushes when no tab is open; clicking one focuses an
  existing window or opens the route). Permission cards are shown through that
  same registration (`registration.showNotification`) rather than the page's
  constructor whenever one exists — only the worker's persistent notifications
  can carry action buttons — so "Allow once" and "Deny" are offered whether the
  card arrives as a push or over the event stream, and answering from the button
  goes through the official permission-response path (`once | deny`, the same
  vocabulary the app's own cards use). A page-shown card without a worker
  registration (plain-HTTP origin) stays click-to-open only. A record older than a minute is dropped
  (the event relay can replay after a reconnect) and nothing is shown while the
  user is looking at that very session. Notifications carry the official Desktop
  icon (rendered on Windows and Linux; macOS shows the browser icon instead),
  a same-tag replacement re-alerts rather than swapping silently, and
  permission/question cards use `requireInteraction` so they stay on screen
  until answered. Nothing else is customizable by the web platform: the origin
  line, the browser attribution and the alert sound are the browser's own
  (the Notifications API has no sound option, and a service worker cannot play
  audio — a custom sound would only be possible from an open page).
- **Delivery (`bridge/notifications.mjs`, `bridge/push.mjs`).** The bridge
  drains the wrapper's notification queue even when no page is connected, and
  sends each notification as an RFC 8291 Web Push message (VAPID-signed,
  aes128gcm — implemented on `node:crypto`, no new dependency) to every browser
  subscription whose page is not currently connected. Subscriptions, the VAPID
  key and the notification preferences live in the bridge state directory
  (`COWORK_BRIDGE_STATE_DIR`, the compose `bridge-data` volume) so a restart
  neither drops subscriptions nor rotates the key. Push needs a secure context:
  the HTTPS entry works, a plain-HTTP LAN origin falls back to in-page
  notifications only.

The settings panel's notification rows ("Response completions", "Code
notifications", "Code permission requests", "Scheduled tasks") talk to
`/api/organizations/{org}/notification/preferences` and the channel
registration route; the bridge answers both locally with the same document
shape (defaults on — the desktop app notifies by default — persisted when
toggled) and uses the per-feature `enable_push` flags to gate what is delivered.
The renderer patch below routes the "enable" action through the bridge's
`DesktopNotifications` surface instead of Firebase. The notification level
preferences inside the Desktop app itself are honored as before, because the
official code decides whether to show at all.

Known limits: a notification whose category the settings disabled is dropped
everywhere; push delivery needs the bridge-data volume writable (otherwise it
degrades to in-page notifications until a tab is opened, as before), the bridge
container to reach the browsers' push services (FCM, Mozilla, ...) outbound,
and the browser to have a push service at all — Helium ships none, so there the
push path is unavailable and everything arrives in-page; the in-page path
requires an open Claudesk tab; and action buttons on a card need a
service-worker registration, so on a plain-HTTP origin (or before the worker is
installed) a permission card is click-to-open only. Firefox does not render
notification action buttons at all; macOS drops them for its own notification
center. When a card falls back to a button-less notification, or push is
unavailable, the page says so once on the browser console.

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
reads that identity from the bootstrap `account`, from the profile document
`GET /api/account_profile` (which is also what the account chip reads its photo
from; Desktop serves no `GET /api/account` — that path is PUT-only), from the
organization document at `/api/organizations/{uuid}`, and (for the footer's
provider label) from `ManagedConfig.managedRendererConfigStore`, which the
bridge otherwise blanks.

With the web shell on and any account value set, the bridge overrides **just the
identity fields** — name, email, avatar, organization, plan — on those documents
(`applyAccountIdentity` / `applyOrganizationIdentity`), and surfaces the
deployment name through the renderer-config store so the footer stops reading
"Gateway". That last one is the official `deploymentDisplayName`, which the
bundle itself documents as "Overrides the provider label shown in the sidebar
footer, user-menu header, and connection-error banner" — no renderer patch is
needed, only the store value the bridge already controls. Only the fields set are
overridden: uuids, capabilities and entitlements are left exactly as upstream
sent them, so Cowork, Code and the time-based greeting keep working. Settings
are only touched by the session-placement policy (one flag, see Chat and Cowork
sessions), never by the identity overrides. A
default deployment, and the Desktop shell, never reach any of this — the whole
path is gated on `webShellEnabled`.

The sidebar's bottom-left chip reads its name and label from those documents,
but its avatar slot is a second, independent gate: the shipped component behind
it still reads the account profile and then renders the deployment mark,
discarding the photo it just read — so a configured `…_AVATAR` produced no image
request and the Claude mark stayed. The `web-account-chip-avatar` renderer patch
makes that slot the account avatar when a photo is present (mark otherwise),
reading the Avatar component, its factory and the mark's own pixel size back from
the same renderer graph — the Avatar's `size` is a design token of a different
scale, so the photo is pinned to the mark's exact size instead of the token, or
it overflows the slot the row reserves and eats the chip's padding. Like the
other chrome patches it is spliced only in web-shell mode. The account menu's
own identity line reads from a different source — Desktop's interactive auth
store (`principalDisplayName`, which the bridge rewrites the same way as the
account name) — through a hook that paints a loading state on the popover's
first frame and only fills from an async store read. In the web shell that read
is a bridge round trip, so the menu's name line showed the deployment label for
one frame and then flipped to the account name. The `web-account-menu-name`
renderer patch makes that reader fall back to the preload's synchronously
seeded store snapshot (`getStateSync`, already filled from `initialStores` —
the same mechanism the managed-config store's label uses) while the async value
is in flight, so the first frame already reads as the account. The chip's photo
has the same shape of wait: the account view hook takes it only from the
profile document (`GET /api/account_profile`, a second bridge round trip that
starts after the bootstrap; the view's `src` is that read resolved through a
helper call), while the bootstrap account the hook already holds
carries the same `avatar_image_url` the bridge put there. The
`web-account-photo-first-frame` renderer patch makes the hook's `src` fall
back to that in-hand value, so the avatar — and the image request behind it —
starts on the hook's first non-empty frame instead of after the profile read;
the profile value still wins once it lands. Because the prepared renderer is served under an immutable
`/renderer/<version>/<patchRelease>/…` path, these patches ship with a
`patchRelease` bump and need the `claude-desktop` service rebuilt (the preparer
runs from its init), not just the bridge.

This is **identity only**. There is no login/logout session and no per-user
separation yet: the account is operator-defined via `CLAUDE_REMOTE_ACCOUNT_NAME`,
`…_EMAIL`, `…_ORG`, `…_PLAN`, `…_AVATAR` and `CLAUDE_REMOTE_DEPLOYMENT_NAME`, and
there is no real account, billing or usage upstream to show. The account carries
two avatar fields — the uploaded photo (`avatar_image_url`, which the account
menu renders) and a preset illustration index (`avatar`, 1..72); `…_AVATAR` sets
the former, as a URL the browser can load (https, or a `data:` URI) **or** a path
to an image inside the container. A path is served by the bridge at
`/api/remote/account/avatar`, same-origin; that route returns only the one file
resolved at startup, so it is not an arbitrary-file-read primitive.
`resolveAccountIdentity()` is the seam a future auth layer fills with a
per-session identity; the signed-in account, the sidebar name and the greeting
all resolve the operator's account name first (`CLAUDE_REMOTE_ACCOUNT_NAME`, else
the legacy `CLAUDE_REMOTE_USER_NAME`).

## Why it is fenced

The chrome and the surface set are the same switch in ion-dist (`isClaudeApp`),
so this flag deliberately changes both. Keeping it opt-in means the default
deployment stays on the Desktop shell with its full Code + Cowork surface set
until the web shell's remaining surfaces are wired up.
