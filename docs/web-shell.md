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
`grantCoworkPermissionGates`). The same call also grants `cowork_auto_permission_mode`, which is not a safety
switch but the thing that gives the picker a list at all: the renderer builds its
set of selectable Cowork modes from those two flags and nothing else, the Cowork
mode list itself is a single entry, and the bypass entry is excluded for a
session-scoped picker — so with bypass alone there is nothing to choose between
and the component returns null instead of drawing. That is why the composer's
permission control was empty. Auto mode is weaker than the bypass mode already
offered here, so enabling it alongside costs nothing.

The same call grants `ccr_mcp_permission_mode_override`, without which the picker
still *disables* the bypass row — present but unclickable, tooltipped "Skip all
approvals only runs locally". Every session here is local, backed over the
Desktop IPC, so the condition that flag encodes is one this deployment satisfies
by construction; the other two grants already say the same thing about the same
row.

This is a real safety switch — Skip all approvals runs
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
  relevant if the merged Cowork-in-chat surface is ever wanted. The folder
  *grant* is separate and does work — see "Folder access" below.

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

### Code sessions stay out of the Chat list

Chat/Cowork and Code are separate stores — `LocalAgentModeSessions` and the
Desktop `LocalSessions` — and the bridge keeps them separate: Code sessions are
served over `/v1/code/sessions` and the Desktop IPC and never enter
`LocalAgentModeSessions.getAll`. The Chat list still showed them because the
renderer's recents read is a request to the *same* `/v1/code/sessions` endpoint:
its remote-cowork leg asks for `tags=cowork-remote&include_trigger_sessions=true`
and folds whatever rows come back into the shared recents list (shared-2's
`SF`/`CF`, which feeds the home task list as well as several dialogs). The
bridge's list honoured `statuses` but ignored `tags`, so every Code session was
returned as a remote-cowork row and the renderer mapped it into Chat; the Code
surface, which calls the list without that tag, kept showing it too. The list
now filters on `tags` — a row must carry every tag the request names — so the
remote-cowork read is empty on an instance whose sessions are all plain Code
sessions. `scripts/code-runners-smoke.mjs` and `code-runners-http-smoke.mjs`
pin both directions: a tagged row is listed for its tag, and the renderer's
exact remote-cowork URL returns none of the untagged Code rows.

The `web-chat-session-list-no-code` renderer patch is a second, narrower guard
for the Code-data merge: the recents builder admits Code rows behind
`activeMode === "code" || codeFoldedIntoHome || requested`, and `requested` is
the product switcher's own store — set when the switcher lands on Code and
never cleared when the user returns to Chat. The patch forces only that operand
false (the Code surface is still admitted by `activeMode === "code"`; this build
compiles `codeFoldedIntoHome` false). It is pinned by the gate function's
destructured parameter names and its single returned disjunction, spliced only
in web-shell mode, and deliberately not required: a bundle that no longer
matches keeps the merge rather than failing renderer preparation.

## Chat and Cowork attachments

The composer's attachment pipeline is claude.ai's, not the Code composer's
`@"path"` mention. With code execution available it uploads each file to
`POST /api/organizations/<org>/conversations/<conversation>/wiggle/upload-file`
(and, for the other routes, `/api/<org>/upload` and
`/api/organizations/<org>/cowork/attachments`), then puts the returned file's
`path` in the message's `<uploaded_files>` block. In the desktop app those
requests are served by the app's own protocol; a browser's go to this bridge.
When the bridge had no such route the upload 404'd, so every attachment showed
"Upload failed" and a send was refused with "N attachments couldn't be
uploaded" — before the message ever reached a session. `bridge/uploads.mjs`
answers the multipart form (streaming the file part to disk), returns the file
document unwrapped, and points `path` at the stored absolute path under
`RemoteUploads`, which the local session can open. `files/prepare-upload` and
`/v1/filestore/fs/createFile` are the same store's >30 MiB lane. No local path
is available to a browser, so there is nothing else for the document to name.

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

## Folder access

Cowork asks for a folder with two different mechanisms, and only one of them is
renderer-side.

The renderer-side ones — Code's project picker, "add a folder to this session",
the Cowork composer's target picker — go through the `FileSystem.browseFolder` /
`browseFolders` IPC, which the preload already answers with the in-page picker
(`__CLAUDE_PICK_SERVER_FOLDERS__`, backed by `GET /api/remote/folders` over the
mounted `/workspace`). Those work with no extra wiring.

The **grant card** — `Claude would like to **Cowork** in a folder`, the
`mcp__cowork__request_cowork_directory` tool — is different. Its handler runs in
the Desktop **main process** and collects the folder with a native
`electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })`
(the shared `pickAndValidateMountFolder` helper, which every folder-grant flow
calls). This container has no display anybody watches, so that dialog never
appears and the card's **Choose folder** button looks dead.

With `CLAUDE_REMOTE_FOLDER_PICKER` on (default: following
`CLAUDE_REMOTE_WEB_SHELL`) the wrapper routes those directory dialogs to the
browser instead. The request is relayed over the event queue as a
`RemoteFolderPicker.onRequest` event (the same `desktop-ipc` path the
notifications use); the preload opens the in-page picker and posts the chosen
paths back to `POST /api/remote/folder-pick`, which the wrapper resolves into the
native dialog result shape (`{ canceled, filePaths }`). The path is still put
through the official validation — a real, permitted directory — so the normal
mount runs. A dialog nobody answers times out as a cancel
(`CLAUDE_REMOTE_FOLDER_PICK_TIMEOUT_MS`, default 5 minutes), so an agent turn
cannot hang forever.

The picker also gains a **New folder** action: `POST /api/remote/folders` creates
a single, validated folder segment under the same workspace confinement as the
listing, and the picker then opens it. Which dialogs offer it is not the native
dialog's `createDirectory` property, though — that property is Electron's macOS
open panel (`canCreateDirectories`, default true there), while the GTK and Win32
choosers this picker replaces always offer making a folder whatever the caller
asked for. So on every host but macOS the action is offered for any directory
dialog, including the folder-grant flows that only ask for `openDirectory`; on
macOS the property still decides, because there the native panel really does
withhold the control.

Note this is the *grant* path; the Cowork-on-web *device model* for browsing a
paired computer's folders (above) is still unwired, and a deployment that
authors `workspace.allowedFolders` restricts which roots the grant can mount —
keep the browsable root (`COWORK_REMOTE_WORKSPACE_ROOT`, `/workspace`) in it.

## File access consent

The Desktop main process asks before it reads a file that is not already covered
by the session's own folders. `checkFileAccessConsent` (main bundle) allows the
session's outputs directory, the folders the session was granted, and any path
the person approved earlier; every other read — `FileSystem.readLocalFile`, which
is what the file pane uses to load a preview's text, and what the memory editor
uses to open `CLAUDE.md` — first opens a native card:

```js
dialog.showMessageBox(window, {
  title: "File Access Request",
  message: "Allow Claude to preview this file?",
  detail: "<path>\n\nThis will allow Claude to preview the file.",
});
```

An agent memory file is one of those paths: it lives under the Desktop's own
userData (`~/.config/Claude-3p/local-agent-mode-sessions/…/memory/`), which no
session is granted, even though the reader's own allowlist (`getAutoMemoryDir`)
covers it. So opening a memory file from the browser — the preview pane, the
memory editor — puts this card up on a display nobody is watching, and the
renderer's `ipcRenderer.invoke` never settles. The failure is a hang, not an
error: `showMessageBox` never resolves, the bridge's `/api/remote/ipc` request
behind it never answers, and the pane spins forever.

With `CLAUDE_REMOTE_FILE_CONSENT` **on (the default)** the wrapper answers that
one card itself, with Allow, and logs the path it answered for
(`[cowork-wrapper] answered File Access Request "preview" for …`). The card is
recognized by its own two literals *and* by its shape — two buttons, with the
allow index read back from `cancelId`, since `checkFileAccessConsent` builds the
list as `["Cancel","Allow"]` and hands Electron only the cancel index — so any
other message box the app opens, and any card whose shape a future build
changes, still reaches the native dialog. Set `CLAUDE_REMOTE_FILE_CONSENT=0` to
put the native card back (nobody will see it in this container).

Allow is the only answer that gets the person the file they asked for; Deny would
only turn the hang into "Unable to read file". The trade is deliberate: the
browser asking for a path is the instance's own authenticated user, and the
approval is recorded per file by the official code, so the second read of the
same file does not reach the wrapper at all.

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

## Restart notice

Every deploy, update or `docker compose restart` recreates the bridge, and a browser
user got no warning: the `/api/events` stream simply dropped, the preload retried it
with backoff, and the only disconnect surface was the server-rendered 503 interstitial
that appears on a document navigation. An in-flight turn died silently.

The bridge now warns the connected pages first, through the app's **own toast**, in
three parts.

- **Publish (`toast-global` renderer patch).** The app's toast manager is not
  reachable from outside React — it lives in a context only its components read — so
  the patch publishes it on `globalThis.__CLAUDESK_TOAST__` from the component that
  renders the app's toast **viewport**: the one whose output is the element carrying
  `data-cds: "Toast"`, which the provider mounts itself whenever toasts are shown at
  all. That is the anchor because it is the one that can be observed from outside. An
  earlier cut published from the card host the provider renders *beside* the viewport,
  and on a live web-shell deployment the viewport was in the page while the global was
  never set, so the notice went nowhere; anchoring on the component whose output is
  actually present is what fixed it. The app's toast hook is read back by shape — a
  parameterless declaration that opens by binding two calls and returns an object
  carrying `add` and `close`, in the same chunk — and the publish is spliced after the
  viewport's own opening declaration rather than at the top of the body, because the
  bindings are `let`. Spliced only in web-shell mode, and required there: a bundle that
  no longer matches fails preparation rather than warn nobody.
- **Display (`bridge/public/remote-preload.js`).** A `notice` event on the existing
  stream is rendered through that manager — sticky (`timeout: 0`), so it outlives the
  SSE drop that follows and the reconnect after. A renderer older than the patch has no
  such global; the preload says so once on the console and drops the notice rather than
  throwing on the event stream.
- **Send (`bridge/server.mjs`, `bridge/realtime.mjs`).** On SIGTERM the bridge
  broadcasts the notice, holds `CLAUDE_REMOTE_SHUTDOWN_NOTICE_MS` (default 5s) so the
  write flushes and the reader has a moment to see it, and only then exits — the stream
  dies right after, so this is the last thing the page hears. A second signal exits at
  once, and the compose service's `stop_grace_period` (20s) keeps the hold from being
  cut short by a SIGKILL. Registering the handler is also what makes it run at all:
  the node process is PID 1 in the container.
- **Survive the restart (`bridge/notices.mjs`).** The bridge serves the browser from
  the *desktop* container's network namespace (`network_mode: service:claude-desktop`),
  so a deploy that recreates both at once takes that route down at the same moment the
  notice goes out — the write lands in a namespace nothing is listening on, and the
  connection is cut before the page can be told anything. The notice is therefore also
  written to the state directory, and the next bridge reads it back at startup and
  replays it to every page that reconnects inside the window, which is exactly the
  population that missed it. It expires on its own, so a window that closed while the
  bridge was down does not come back as a greeting on every later tab. `deploy.sh`
  closes the remaining gap from the other side: it stops the bridge **on its own,
  first**, before recreating anything, so the notice goes out while the route to it is
  still up; the recreate follows once it has exited.

The preload shows a given notice once per page, not once per delivery: a reconnect
replays it, and a reconnect is what follows the outage the notice is about.

The notice is cached while it is live and replayed to a page that connects during the
window (a tab opened mid-restart must still hear it), and expires after five minutes so
a stale "restarting" warning does not greet every tab afterwards.

For planned maintenance, `scripts/announce-restart.sh` fires the same notice on demand
(`docker exec` into the container over loopback, since the image has no curl and the
route must not be reachable through the proxy), so people can be told a minute or two
before the stack is stopped. It is gated on `CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS`,
the operator scope, so a provisioned account never inherits it.

Two things to know. One bridge serves one instance, so a notice reaches that tenant's
tabs only; a box-wide restart needs it fired per instance. And the publish half needs
the `claude-desktop` service rebuilt and a `patchRelease` bump (the prepared renderer
is served under an immutable path) — the bridge and preload half alone would
log-and-drop, saying so once on the browser console.

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

**A tenant withholds this patch.** An account's instance is marked
`CLAUDESK_TENANT=1` and never runs Code in its own container, so its `/code` must
resolve to the *self-hosted* surface — which is the cloud branch the alias
replaces — rather than the local one. That makes the tenant flag a third input to
the renderer generation alongside gateway and web shell, and it is why the alias
is not a *required* patch there: the withheld splice is the intent, not a bundle
that stopped matching. See [Code in the Cowork VM](code-in-cowork-vm.md).

The Code *pill* is a second, independent gate. On a non-desktop client, clicking
it raises the "download the desktop app" upsell instead of navigating, unless
`hasClaudeCodeWebAccess` holds — which is `bad_moon_rising` (the "Claude Code web
access" gate) AND the `claude_code` entitlement. With the flag set, the bridge
adds `bad_moon_rising` to the bootstrap's `growthbook.features` (addressed by
ion-dist's Java-style name hash), so the pill navigates to the route above
instead of upselling.

**A tenant is granted the surface itself.** The Code UI also reads
`claude_code_web` out of the access document
(`xe("claude_code_web").status === "available"`), so the bridge adds that entry
for an instance whose Code runs on a self-hosted runner — the same entry the
mobile facade declares for the phone — while leaving the operator's own instance
to whatever upstream said. An entry that is already there is never overridden,
including a `blocked_by_*` one. See [Code in the Cowork VM](code-in-cowork-vm.md).

## Self-hosted Code start options

A tenant's Code places sessions on its self-hosted runner, and that place now
offers the three start options Desktop's local composer has: **folder**,
**branch** and an isolated **worktree**. The renderer's folder/branch/worktree
strip was gated to `local|ssh|wsl`, and the create body dropped the values; six
tenant-only renderer patches (see `docs/frontend-patches.md`) turn the strip on
for `byoc`/`pool` — including past the `noSessionRunsOnThisDevice` policy term —
read git state for the chosen folder, and carry `cwd`, `source_branch` and
`use_worktree` through the start intent into the create body.

Everything that touches the workspace runs **inside the Cowork VM** — the agent,
the branch checkout and the worktree. The UI's *lookups* do too: the folder
picker (through `/api/remote/code-folders`) and the renderer's git hooks
(`getGitInfo`, `getLocalBranches`, the dirty-tree and branch-conflict reads) are
answered by the guest runner over its poll, not by Desktop and not by this
container. The bridge queues the request, the runner's held poll picks it up,
and the runner posts the result back with the pool secret; the request channel
and the host→guest path mapping are in
[docs/code-in-cowork-vm.md](code-in-cowork-vm.md#start-options-folder-branch-and-worktree).

The tenant `LocalSessions` allowlist is exactly those five read-only names —
enough for `validateInvocation`, never forwarded to the wrapper/Desktop. A
crafted call cannot make the privileged container run git over agent-writable
content.

## Cowork scheduled tasks

The Cowork scheduled-task list has one route in — the hub sidebar's **Scheduled**
entry — and its visibility is derived, not a flag. The entry carries
`modes:["cowork","code"]`, and the hub offers it only once `coworkEnabled` (or,
in the Code frame, `codeEnabled`) holds. ion-dist computes

```
coworkEnabled = (isDesktopApp && coworkGate)
             || (coworkWebEnabled && yukon_silver_dramatic_shrimp_clocks)
             || hubRoutinesServed
```

A browser client fails the first term by construction — that is the Desktop
identity the chrome patches withhold, and which the session-gate and placement
patches force only where they must — and the last is cloud state nothing here
serves. The middle term is the web-Cowork path this deployment does back
(`coworkWebEnabled` is `!isDesktopApp && dramatic_shrimp && the web-Cowork
gate`, all true in the web shell), so the only missing piece is the rollout flag.
The bridge grants it exactly as it grants `bad_moon_rising` (`webShellGrantedGates`;
only an absent gate is added, so an upstream value is left alone). Without it the
entry is filtered out of the sidebar even though the surface behind it works:
those tasks are local, they run over the Desktop IPC this bridge backs, and one
can be scheduled and executed with no way to reach its list, next-run time or run
history from the product.

Reaching the list *and* running from it are two more pieces, both renderer
patches (`web-scheduled-task-runner`, `web-scheduled-task-hosts` — see
`docs/frontend-patches.md`): the runner aborts on the Desktop check, and the
listener and session-starter hosts are mounted from the Desktop-checks slot,
behind that slot's identity gate.

Showing a task's runs is a third, and it lives in the IPC allow-list rather than
in a patch. The task page reads its run history from
`claude.web.LocalAgentModeSessions.getSessionsForScheduledTask` — Desktop's
session manager answers it by filtering the sessions that carry the task's
`scheduledTaskId` — while the preload publishes exactly the methods its surface
carries (`config.methods`, which the bridge fills from `allowedMethods`). The
method is a Code-surface method too (`LocalSessions`, under the Code actions
flag), so an allow-list that carries only that copy leaves the browser's facade
without one, the page's loader finds nothing to call, bails silently, and the
task's History column stays empty for a task that has run. Both policies — the
bridge's and the wrapper's — carry it on both surfaces; `bridge-parity-smoke`
holds them to it.

Firing a task is a handshake, and it is the same allow-list that decides whether
a client can take part in it. The main process emits a dispatch, the renderer
acks it, and `ackEvent` answering "no longer pending in main" is what stops the
renderer starting a run it has already started — the renderer's only guard
against appending the same run's prompt to its session twice. A client that
cannot ack does not fail loudly: the call is optional-chained with a `?? true`
fallback, so every re-delivery of the same dispatch (main's retry after an
unacknowledged dispatch, or a relayed event replayed to a reconnecting page)
starts the session again, and the transcript grows another "Ran scheduled task"
card for a run that happened once. `setEventAckSupported` declares the client
into that protocol (its absence leaves main consuming slots before it emits),
`setHostRunsSupported` says the client can start runs itself, and
`releaseDispatchClaim` gives a claim back. All four sit on the
`CoworkScheduledTasks` allow-list beside `markListenerReady` and
`createScheduledTask`, and — like them — are **unconditional**, not part of the
`infrastructureActionsEnabled` group. Routines belong to the account, and the
renderer keys its own "New task" button and delete on `createScheduledTask` /
`updateScheduledTaskStatus` being present, so gating them away does not deny the
capability (the account can still create and delete routines by asking its
agent) — it only takes the controls out of the UI. The client that can be
scheduled must be able to ack, or every re-delivery starts the run again.

Editing a task's file is the one write the Desktop refuses *by design*, and that
refusal is what a routine can get stuck behind. The store publishes a task's
files (`SKILL.md`, and the watcher script beside it) through a writer that stops
with `Not written: this task's file is hard-linked to another file. Replace it
with a plain copy.` when the path carries a second hard link — the redirect a
sandboxed agent can set up through a shared folder, since the write would then
land on the link's other name instead of on the task. The store checks on every
write, so until that file is a plain copy on that machine every edit answers 500,
from every client, and a browser cannot make it one.

Current builds put that refusal behind a rollout gate (`346871663`) and, while
the gate is off, do the repairing themselves: they publish a fresh file into the
task's directory rather than writing through the link — upstream's own answer,
which is what the refusal asks of a person with shell access. The gate arrives in
the feature payload the main process fetches through Electron's `net`, and it
reads on for this deployment's accounts, so the wrapper rewrites that one response
on its way in and drops the key. Only that key goes: every other feature, every
other field and every other response pass through untouched, and a payload that
cannot be re-read is handed on exactly as it arrived. Desktop also keeps the last
good payload on disk (`<userData>/fcache`, a gzip blob behind a magic header) and
reads the gate from there whenever the network does not answer, so the same key is
dropped from that cache at startup. With the gate off, the store repairs a
hard-linked routine file for every writer — the web shell, the Desktop window's own
routines list, the agent's `update_scheduled_task` tool.

Two repairs do what the refusal asks, and both are a **copy at the same path** —
the same bytes in a fresh inode, published by `rename`. It has to stay at that
path rather than move out of the way: the store reads the file back to merge a
prompt-only or description-only update, so a file that is not there fails that
read (ENOENT) before any write happens. The wrapper repairs at a write, off the
task id the call carries, under every root the Desktop's resolver can answer with
(the configured `coworkUserFilesPath` and the fallbacks it resolves for itself),
and once at startup by sweeping those roots — which is what heals a routine that
was already stuck, and what covers a build whose refusal has no gate at all (the
Desktop version pinned here refuses unconditionally, so that layer is the whole
fix for it). The bridge does the same where it can, off the path Desktop's own
task list answers for the task, since a store is free not to name the task's
directory for its id. In the topology that runs the web shell as its own container
with `/config` mounted read-only (`compose.yaml`), that container can only ever
*report* one of these files — the app container owns the writes — so its report
names the path, the link count and the error the repair hit, and appends what the
app process says about its own repairs (`/health` carries `routineFileLinkRepair`).

Neither repair writes through the link, so whatever other name the inode carried
keeps its own bytes (and, once the copy is published, keeps that inode to itself).
When a refusal survives them, the error the client sees carries what the repair
saw — the path Desktop answered, or the reason it answered none, how many links
the file had, and what the app process reports about itself — so a routine stuck
on a machine nobody logs into is diagnosable from the browser that hit it.

### Firing a routine over HTTP

The tasks above also back the routine fire endpoint: a per-routine bearer token
and `POST /v1/claude_code/routines/{id}/fire` start the same session Run now
would, with the body's optional `text` appended to the saved instructions. The
Routines page's cloud data family (`/v1/code/triggers`) is served from the same
store, and the `routine-fire-origin` renderer patch makes its API card print
this deployment's URL. Token minting, edge routing and the exact contract are in
[docs/routines.md](routines.md).

## Home greeting

The home greeting is not local copy: ion-dist reads `personalized_greeting` out
of its **bootstrap response** (an array of per-surface, per-weekday slots) and
only falls back to the built-in "You're here!" when that field is absent. The
bridge fills the official chat/code payload whenever the upstream sends none
(`injectPersonalizedGreeting`). The Chat fallback merges the current server-shaped
schedule with the non-incognito phrases from an older client-side greeting picker.
It selects deterministically from the eligible weekday/time pool using the UTC
ISO week and slot as a seed: reloads within the week retain the same greeting,
and the choice rotates at the next week. “Golden hour thinking” is eligible in
the late-afternoon window (16:00–18:00 local time). The Code fallback
remains the supplied schedule. A non-empty upstream `personalized_greeting` still
wins without modification.

The old picker also carried incognito-only entries. They are intentionally not
included in the normal fallback because the bridge cannot reliably tell whether
incognito mode is enabled:

- Morning: “Let’s chat incognito”
- Afternoon: “Greetings, whoever you are”
- Evening: “You’re incognito”
- Late night: “You’re incognito”

Which URL carries it depends on the shell. The Desktop frame bootstraps under
`/edge-api/bootstrap*`; a plain browser — the web shell — uses the claude.ai
default `/api/bootstrap*`. The bridge matches **both** prefixes (ion-dist's own
detector accepts `(?:edge-)?api`), so the greeting renders in either chrome.
Matching the entitlements document (`/api/bootstrap/<org>/current_user_access`)
is deliberately excluded, so the greeting is never injected into that shape.

## New page layout

The composer card's **marlin** design and the page's **home** layout are two
different things. Marlin (the unified card, the controls docked below it) is the
GrowthBook gate `voyage_composer_marlin` (`2295073874`), which the bridge grants
in web-shell bootstrap responses (`grantWebShellComposerDesign`) — the upstream
table carries it false, and this one is forced even then.

The layout is chosen elsewhere, and the Desktop build compiles the choice out:
the chunk that reads the `__gb__1085985672` new-page gate returns its assignment
object with `eligible`, `settled` and `assignment` hardcoded false, so the
renderer settles on the classic home layout however the gate evaluates — even
though the layout's own components (the compact greeting, the docked controls,
the below-fold feed) ship in the same bundle. The web bundle returns the real
assignment, which is why claude.ai's browser page looks different from a web
shell running the Desktop bundle.

The `web-new-page-home-layout` renderer patch splices that object to the
all-assigned shape the web bundle produces for a visitor in the experiment
(eligible, settled, assigned, strings delivered — the layout's default messages
ship in the bundle — and nothing undelivered). The object is pinned by its own
six property names and the chunk by the gate literal it reads, each exactly
once; a bundle that no longer matches is left alone rather than mis-spliced, so
the failure mode is the classic layout, not a broken page. Spliced only in
web-shell mode, like the other chrome patches. Because the prepared renderer is
served under an immutable `/renderer/<version>/<patchRelease>/…` path, the patch
ships with a `patchRelease` bump and needs the `claude-desktop` service rebuilt
(the preparer runs from its init).

That layout is gated on the **marlin** arm: the renderer forces the classic
layout whenever the arm reads as off, so an off arm silently reverts the whole
New page. The bridge grants the arm in every bootstrap, but the renderer's own
read can still answer "off" for reasons the bridge cannot see — the arm it
remembers on the device wins whenever the feature is not in the table the client
built, the first read is frozen for the life of the page, and a feature table
persisted from before the grant can answer in place of the fresh one. The
`web-composer-design-forced` patch therefore forces each design predicate's own
flag operand true, leaving the side-panel guard they all end with in place.
Spliced only in web-shell mode, and not required: a bundle that no longer
matches leaves the arm to the flag.

Forcing the predicates is not enough on its own, because the design is not read
from the feature alone. The renderer resolves the composer design from a
**device latch** — `composer-card-latch` in localStorage, answering `"classic"`
when nothing wrote it — and from the **static stamp**, which the shell rewrites
to `data-composer-arm="marlin"` on the skeleton composer element. The stamp is
consulted only on the New page: the renderer's reader refuses it unless
`location.pathname === "/new"` and the element is un-hidden, which is true
nowhere else. So the New page gets the marlin card from the stamp while every
other surface — project pages, session pages — falls back to a latch no one
writes, and draws the pre-marlin composer: the model control inside the card,
the project and permission controls in a tray below it, and the pre-merge
Chat/Cowork switch above. The remote preload seeds the latch with `"marlin"`
(nothing is stored, or the stored value is unrecognised), so every surface
resolves the design the New page does; an explicit `"classic"` — the app writes
that key when a person picks a card — is left alone, and a storage that refuses
writes is ignored rather than fatal. `scripts/composer-latch-smoke.mjs` pins all
four.

Two decisions downstream of that arm are forced for the same reason, because a
deployment that grants the arm has already made them:

- `web-new-page-home-variant` splices the layout hook's settled variant to
  `{variant:"home",settled:!0}`. It is the one `{variant, settled}` object whose
  variant is computed — the composer's own `{variant:"none", …}` defaults are
  literals and are left alone.
- `web-home-composer-arrangement` splices the route surface kind to `"outside"`.
  It is the only place the three route names appear together
  (`… ? "hub" : … ? "outside" : "none"`), and only that arm selects the home
  composer arrangement — the flag pair that moves the model and permission
  controls out of the card.

Each is spliced only where its own shape is unambiguous in the chunk, in
web-shell mode only, and neither is required.

**Projects** — the `/projects` and `/project/<id>` routes and the composer's
project slot — are decided by one predicate: the GrowthBook feature
`claude_ai_projects_limits` and its `max_free_projects` field, the plan
capabilities `claude_pro` / `claude_max` / `raven`, or all three. claude.ai
serves the predicate live, and a free account reaches projects through the
feature's own field. The Desktop build compiles it out: the function still calls
the three capability readers and the feature reader, but its answer is a module
constant the bundle never assigns anywhere, so projects stay shut however either
would evaluate and the route guard redirects every projects route.

The `web-projects-allowed` renderer patch rebuilds that body as the disjunction
claude.ai ships. The four reads are hoisted into declarators rather than left
behind `||`: they are hooks, and short-circuiting them would call a prefix of
them on some renders and all of them on others. The feature is compared `> 0`,
exactly as the bundle's own sibling limit helper compares it. The function is
pinned by the feature name and field literals the bundle spells only there, and
its comma-sequence shape; the body is spliced only when exactly one such
function is in the chunk. Spliced only in web-shell mode, and not required: a
bundle that no longer matches leaves projects off rather than failing renderer
preparation. It ships with a `patchRelease` bump (prepared-renderer bytes
change), so it needs the `claude-desktop` service rebuilt, not just the bridge.

The restored predicate still needs the feature or a plan capability to read. The
bridge adds `claude_ai_projects_limits` to the bootstrap's growthbook table as
`{max_free_projects: 5}`. Unlike the other gates, presence is not the test here:
the feature carries a *value*, and an entry the upstream already carries can
still answer an allowance of zero or carry no `max_free_projects` field, which
the renderer reads as no allowance exactly as it reads a missing entry. So the
grant raises anything that is not already above zero and leaves a real allowance
alone. Without it a free account — which is what a self-hosted org resolves to —
has no allowance and projects stay shut.

The **sidebar's own "Projects" entry** and the **composer's project chip** are
two more gates on top of that predicate, and both are the same shape of problem:
a value claude.ai computes and the Desktop build compiles to a constant.

The sidebar. Both builds filter their nav items through one negated `||` chain —
a mode mismatch, a per-item eligibility call, and two clauses about the entry
itself — and both of those clauses are false on claude.ai while being true here.
One is Desktop-only: `… && surface === "chat" && !isChatIn3pSupported`, whose
operand is a module constant read once from `globalThis.desktopBootFeatures`, the
Desktop main process's app-feature table that a browser page never has. The other
is in both builds but reads `… && !projectScope && !atrium`: the web bundle
evaluates that second operand as `flag || !inNestedFrame`, which is true for any
top-level page — this shell included — while the Desktop build folds it to
`false` and leaves the clause standing. Rather than reconstruct either value, the
`web-projects-sidebar-entry` patch drops every operand of that chain that tests
`id === "projects"`, keeping the mode and eligibility filters. The chain is
identified inside the negation it sits in, so a clause that merely mentions
projects elsewhere is out of reach, and it refuses unless exactly one such
negation is in the chunk. Spliced only in web-shell mode, and not required.

The composer. The chip is answered by one function — the chain ending
`… ? "disabled" : … ? "pending" : … ? "projects" : "enabled"`, where only the last
two render a slot. Its operands are the restored projects predicate, the
caller's `unifiedComposerDesign` (which is the unified-composer arm's own
predicate, and so is already forced by the design-predicate patch), and a store
holding the *pending first send* — null until a send is actually being prepared.
On a New page, before anything has been typed, nothing prepares that send, so the
answer short-circuits to `"disabled"` and no slot is rendered, where claude.ai
renders one. The `web-projects-composer-slot` patch forces the answer to
`"enabled"` — the same "deployed answer, spliced at the consumer" the layout
variant and the route surface kind already get. Only the returned expression is
spliced, so the declarators above it stay: they are where the feature reads and
the surface hook calls happen, and removing them would change hook order. The
function is pinned by the four mode literals it answers with, which appear
together nowhere else in the renderer graph. Spliced only in web-shell mode, and
not required.

The chin. Forcing that predicate was not enough on its own, and the reason is
worth recording: the unified composer picks its chin in one
`if (position === "unified")` block, and the branch that *draws* the project chip
is the second one —

```js
if (collapsed)                     return <Chin open={false}/>;   // empty
if (kind === "chat" && firstSend !== null && h) return <xP/>;      // the chip
if (kind === "chat" && shaped)     return <SP/>;                   // another chin
```

— so with that store null the composer builds an **empty collapsing wrapper** and
never calls the predicate at all. A DOM probe confirms the shape: the chin
exists, its only contents are the collapsing wrapper, and no
`[data-home-project-slot]` element is anywhere in the page.

The `web-projects-composer-chin` patch forces that branch's test outright. It
first kept the branch's own `kind === "chat"` operand, on the reasoning that a
cowork chin should not become a chat one, and the page did not change — which
leaves two possibilities that the DOM cannot separate: the branch is not reached
at all, or the surface this shell reports is not `"chat"`. The test is therefore
forced whole. The block is pinned by the `"unified"` literal its own guard tests,
so no other conditional in the graph can match. Spliced only in web-shell mode,
and not required.

The picker. With the branch open the slot wrapper renders — and comes out empty,
`data-home-project-slot class="… empty:hidden"` with nothing inside — because the
picker itself refuses to draw:

```js
{ isClaudeApp: n, … webPickerEnabled: l, webPickerPending: keepMounted && !n && !l && RN }
function BN(e, t) { return e.isClaudeApp ? !1 : (!e.webPickerEnabled && !e.webPickerPending) || t }
…
if (BN(caps, projectLocked)) return null;
```

`isClaudeApp` is the same zero-argument platform check two other patches already
force: it asks whether this is the Claude app, and the web shell answers no
because it drops the Desktop user-agent token to get the browser chrome. On the
real app the picker draws and opens the *native* folder dialog; here it draws
nothing, and the web-picker alternative it would otherwise fall back to is not
available either. `web-projects-folder-picker` forces that one property's value
true — the same local override the session patches make — which selects the path
this deployment actually supports, because the wrapper intercepts the native
dialog and answers it with the in-page picker. Only the value is spliced: the
binding stays, since `webPickerPending` in the same object still reads it, and
the declarator is where the platform read happens. The object is pinned by
carrying both `isClaudeApp` and `webPickerEnabled`, and both of the flags it
forces are spliced from its own property values.

The seventh is one branch earlier than all of it, and it is the one that was
actually in the way. The component that owns the slot element has two branches
that draw it, with the same tag and the same class:

```js
!isClaudeApp() && hostProjectUuid !== undefined
  ? <div data-home-project-slot …><BoundProject projectUuid={hostProjectUuid}/></div>
  : mode === "enabled" || mode === "projects"
    ? <div data-home-project-slot …><ProjectSelector …/></div>
    : …
```

The first is for a project the composer is *already bound to*; it reads that
project's device binding and answers null until it resolves, so on a New page that
carries a default project it produces the same empty div the selector's refusals
produce — indistinguishable in the DOM, and one branch earlier than every fix
above. `web-projects-bound-slot` forces that test off, which routes the slot to
the selector — the thing a composer that is *choosing* a project should draw. It
is identified as the function whose returned conditional carries two
`data-home-project-slot` elements, which is what separates it from its sibling.
Spliced only in web-shell mode, and not required.

The second flag is the one that actually decides the chip. The same object
carries `noBackend`, which the Desktop build ships as `!0` and the web bundle as
`!1`, and the component's whole return is switched on it:

```js
return H.noBackend
  ? <>{<DraftRegion>{e => trigger(e && …)}</DraftRegion>}{trust}</>
  : trigger(…);
```

so the branch that draws the trigger is the one this build never takes. Restoring
`noBackend` to `!1` is the web bundle's own value, not a choice made here; the
`isClaudeApp` force is the same local platform override the session patches make,
and it keeps the picker's gate from answering null whatever the scope does — on
claude.ai that gate is satisfied by `webPickerEnabled` instead, which this shell
cannot reach because it needs a remote-projects capability the bridge does not
report. Spliced only in web-shell mode, and not required.

The selector's own guard. One step earlier in the same path, the component that
wraps the picker decides whether to draw at all:

```js
let { projectScopeLocked: c, … } = composerContext(), m = isClaudeApp();
return c && !m ? null : <ProjectSelector …/>;
```

On claude.ai that guard is false because nothing scopes the composer and the
selector draws; here it answers null and the slot wrapper above comes out empty —
the same empty `data-home-project-slot` div, one level earlier than the picker's
own refusal. `web-projects-selector-scope` forces the guard off, which is correct
whenever the composer is being used to *choose* a project rather than to show one
it is locked to — which is what this shell's New page is. The component is pinned
by the two prop names it destructures, `selectionChip` and `plainTrigger`, which
the minifier leaves alone, and by returning `null` from a conditional. Spliced
only in web-shell mode, and not required.

**The picker's shape** is the last of these, and it is the one the page shows most
plainly: with the chip drawing and the popup open, the popup is a bare search box
— the placeholder reads "Search projects", there is no "Filter and sort" button
on the search, no "New project" row and no "No projects yet." empty state. All
four are switched on one capability:

```js
atriumCreate   = remoteProjectsEnabled && projectsAllowance;
showProjects   = !locked && atriumCreate && (!controlled || chatProjectsEnabled);
showFilterSort = remoteProjectsEnabled && !locked && !foldersOnly;
```

and `remoteProjectsEnabled` is the same fold as the projects predicate: the reads
the atrium feature and then answers a module constant it never assigns,
`function remoteProjectsEnabled(){return read("yukon_silver_dramatic_shrimp_atrium"),FA}`
with `var FA=!1`. `web-projects-atrium` splices that comma sequence down to the
read, so the capability answers what the deployment's growthbook table says —
which is why the bridge also grants the gate, the way it grants
`yukon_silver_folders`. The read keeps its expression position, so hook order is
unchanged. The function is pinned by the feature-name literal, which the bundle
spells only there, and by the two-expression sequence's shape. Spliced only in
web-shell mode, and not required.

**The server-side project list** is a different surface again, and the one that
keeps asking. Its queries are `GET /api/organizations/<org>/projects_v2` — a
creator list, a starred one, an overflow page, a `uuids=` batch, and a prefetch
the projects page runs — all armed by one predicate:

```js
function serverProjectsAvailable() {
  let { activeOrganization } = useSession(), plan = projectsPredicate(),
      probe = accountProbe().isAvailable;
  return !!activeOrganization && plan && probe;
}
```

The bridge forwards none of those routes and the platform refuses the family, so
they never settle: the projects page waits on them and shows its skeleton cards,
and the composer picker is told its projects are still loading, which is what
leaves it skeleton-drawing (its empty state is defined as "not loading, and no
projects", and nothing reaches that while the loading term is true). The projects
this deployment *does* have are the Desktop's **spaces**, and they reach this
same picker by another route — as folder targets marked `isProject`, through the
folders gate, drawn by the same rows. So `web-projects-remote-list` splices that
predicate to false, and forces the two consumers that read `isPending` off those
queries — the picker's report object and the page's list hook — to the settled,
empty answer. Requests stop, both surfaces draw what exists here, and the
declarators stay, so the hooks in them still run.

The rest of the family is no longer left to 404. `GET /projects` and
`/projects_v2`, the create `POST /projects`, the project detail (`GET`
`/projects/{uuid}`), the update/delete and the project's sub-resources are
answered by the bridge itself, backed by the Desktop's CoworkSpaces store over
IPC — a project *is* a space. That is what makes the create form (whose POST this
patch does not touch) work without claude.ai; see "Projects" in
docs/eva-mode.md and bridge/projects.mjs. This patch stays as it is: the
surfaces it silences are already drawn from spaces, and the bridge routes cover
the ones that bypass it.

**Session pages are read-only without one flag.** Everything a session scoped
control writes through — the permission picker's setter, the model picker's,
stop, retry — is handed over only when the session reports writable:

```js
let writable = cr("hub", coworkMode.orgAvailable, hubVerdict.served)
               || amberTributaryHeron.enabled;
```

`cr` is `t || (surface === "hub" && n)`, so the flag is the last term of a
disjunction whose other two are server verdicts this deployment does not serve.
Without it the session is read-only, and every control that would write is handed
the no-op the bundle keeps for that case (`function bb(){}`), silently — which
looks like a permission picker that opens and does nothing, and a model picker
that does not stick. The Desktop build folds the flag to a constant, as it folds
the atrium capability, so `web-cowork-hub-writable` rebuilds the folded object
around the feature read and the bridge grants that gate. The two ship together.

The permission control is the same missing store showing up once more. The
composer chooses that slot's content from a hook:

```js
let s = permissionBinding();
s === undefined
  ? (arms ? <iconOnly/> : <PermissionSkeleton/>)   // the skeleton
  : <PermissionPicker binding={s}/>;
```

and the hook answers only while the pending-first-send store exists:

```js
let e = pendingFirstSend(), t = e?.newChatAutoArms, …;
return memo(() => { if (e !== null && t === true) return {permissionMode: …, …}; }, […]);
```

With that store null — a New page before anything has been typed — the hook
returns nothing and the slot draws its skeleton indefinitely.
`web-permission-binding` forces that guard open rather than faking the store:
everything the returned object reads is the pending draft's own settings and the
default-mode helper, none of which touch the store, so the picker is handed the
binding it would have had one render later. The guard is identified by the object
it returns, which carries `autoPickIsDraftOnly` — a name that appears nowhere
else in the renderer graph. Spliced only in web-shell mode, and not required.

The picker also asks for its mode list with `excludeBypass: true`, which drops the
"Skip all approvals" row — the row the deployment's own settings and rollout gate
exist to offer, and which the control this replaced used to show.
`web-permission-bypass-row` clears that flag: these pickers are scoped to a
session, and a session can hold that mode. It is pinned as the `excludeBypass`
property of an object that also carries `sessionBinding`, which is what marks a
session picker; two sites match — the composer's and the one the session surface
draws — and both get the row back. Callers that pass `excludeBypass` without a
binding are untouched. Spliced only in web-shell mode, and not required.

Making that row *selectable* was not enough either: a click on it did nothing.
The New page's picker sets the **pending draft's** permission mode, and the pair
of mappers that carry a mode in and out of that draft know two modes:

```js
const aM = "auto", oM = "acceptEdits";
function toWire(mode){ if (mode === "auto") return aM; if (mode === defaultMode()) return oM; }
function fromWire(value){ if (value === "auto") return "auto"; if (value === "acceptEdits") return defaultMode(); }
```

so the writer drops the click and, even stored, the reader would read it back as
the default — the row would look unpicked again. The wire vocabulary is the mode
ids themselves (`acceptEdits` being the id of the mode the picker labels
"Manual"), so `web-draft-bypass-mode` widens both maps to `bypassPermissions`.
Both, not one: either alone leaves the click with no visible effect. Each mapper
is identified as the one-argument function that opens by testing its argument
against `"auto"` and then either against a call (the writer) or against
`"acceptEdits"` (the reader). Spliced only in web-shell mode, and not required —
which matters here, because a build that folded those two-liners into a
conditional expression would stop matching, and the click would go quiet rather
than loud.

All fifteen change prepared-renderer bytes, so they ship with a `patchRelease` bump
and need the `claude-desktop` service rebuilt. Finding the chin also settled the
order they have to be reasoned about in: a slot predicate that is never called is
indistinguishable, from the page, from one that answers "disabled", and only
looking at the DOM tells the two apart.

Finally, the entry **document** carries two attributes claude.ai's *server*
fills in and the Desktop package ships with neither — `data-new-page-layout="home"`
on `<html>` and `data-composer-arm="marlin"` on the static composer skeleton.
They are what the first paint reads: the skeleton's own CSS keys the smaller home
greeting off `html[data-new-page-layout=home]`, and every `data-composer-arm=marlin`
rule in the shell keys the marlin card off the attribute, so without them the
painted-before-hydration skeleton is always the classic one — including the
greeting the skeleton keeps visible, whose size *is* that CSS variable. The app's
own window loads its document from the desktop container (`serveIon` in the
bridge wrapper), so that is where they are filled in; the bridge's own entry
route shims the same document for a plain browser client and marks it too, and
skips an entry that is already marked so the attribute is never written twice.
An entry that no longer carries the markup is served unchanged rather than
refused. Only in web-shell mode, and only `index.html`.

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
store (`principalDisplayName`, which the bridge rewrites to the same name it
puts on the account document, resolved from the request in Eva Mode and from
`CLAUDE_REMOTE_ACCOUNT_NAME` otherwise) — through a hook that paints a loading state on the popover's
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
per-session identity; the signed-in account document, the sidebar name (the
`interactiveAuthStore` the preload seeds and the account-menu reader falls back
to) and the greeting all resolve that identity first when the request carries a
session, and the operator's account name otherwise (`CLAUDE_REMOTE_ACCOUNT_NAME`,
else the legacy `CLAUDE_REMOTE_USER_NAME`).

**In Eva Mode the photo is per account.** With `AUTH_IDENTITY_URL` set the bridge
also reads the signed-in account's `avatar_updated_at` and puts a same-origin
`/api/auth/avatar/<id>?v=<n>` (served by authd) into `avatar_image_url`; a person
with no photo leaves that field unset, so the chip and menu keep the default mark
and no image is requested. This overrides the deployment-wide `…_AVATAR` for that
request, which stays the fallback. **The name is per account the same way:** the
bridge resolves the signed-in user's `first_name` (else email) and uses it for
the account document, the greeting and the sidebar identity, so an account whose
name is set at invite-accept — or renamed later — reads correctly without the
deployment-wide `CLAUDE_REMOTE_ACCOUNT_NAME` being re-applied by a re-provision.
See [Eva Mode](eva-mode.md).

## Rollout cost

Every container start runs the renderer preparer (`prepare-renderer.mjs`), and the
work — acorn over ~195 MB of JavaScript — costs about a minute. Container
initialization runs it on *every* start, including the "already patched" fast
path, and `/var/lib/claude-cowork-bridge` is not a volume, so a `--force-recreate`
throws the result away and the next start pays it again. A full `deploy.sh`
recreates this deployment's desktop plus every account's, so that minute is paid
once per instance for byte-identical output.

The preparer now stamps each generation with a key over its actual inputs — the
renderer sources, the two flags and the release — and keeps the existing
generation when that key matches, which turns an unchanged start from a minute
into about a second. `scripts/deploy-bridge-only.sh` closes the other half: a
change that lives in the bridge needs the bridge containers recycled and nothing
else, so it rebuilds only that image and recreates only the bridges, leaving
every desktop (and every renderer) alone. It refuses when `config/release.json`
has moved, because then the desktop image needs rebuilding too and the honest
path is `deploy.sh`.

## Why it is fenced

The chrome and the surface set are the same switch in ion-dist (`isClaudeApp`),
so this flag deliberately changes both. Keeping it opt-in means the default
deployment stays on the Desktop shell with its full Code + Cowork surface set
until the web shell's remaining surfaces are wired up.
