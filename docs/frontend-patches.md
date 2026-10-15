# Frontend patch maintenance

The renderer patcher uses stable properties and JavaScript structure rather than
exact snippets of compiled code. This follows the principle described in
[Vencord's patch documentation](https://docs.vencord.dev/plugins/patches/): locate
the intended behavior with stable anchors and keep the replacement small.
Claudesk uses Acorn AST selectors instead of regular expressions for the current
Gateway guards.

## Current selectors

`rootfs/opt/claude-cowork-bridge/renderer-patches.mjs` owns discovery, validation,
and replacements. The two Gateway setup guards are selected by:

- A comparison of `window.location.protocol` with `app:`.
- An enclosing function that redirects through `replace('/new')`.
- A window existence check for the setup route, or `pendingUserCode` for the
  sign-in route.

The Gateway URL schema's host guard is selected by the schema's own error copy —
the `must use https (or http on loopback)` branch of its `refine` message, which
appears nowhere else in the renderer graph — together with the message property
that carries it. Desktop accepts an http endpoint only when its host is in the
loopback set, which a provisioned Cowork VM cannot use: the VM makes the model
calls, and `127.0.0.1` inside the guest is the guest. The splice replaces the
http branch's single `hostSet.has(hostname)` membership test with `true`, reading
the hostname back from the object pattern the predicate destructures out of
`new URL(…)`. Only that membership test changes, so a schema that does not allow
http at all still refuses it and the https branch is untouched. It is applied
independent of the Gateway setting, and — unlike the card removal and the pane
patches, whose absence degrades silently — it is not a required patch: if the
copy changes upstream the schema keeps its guard, Desktop refuses the
deployment's URL, and the gateway visibly stops answering.

The same schema is bundled a second time into the Desktop **main process**, and
the Gateway connection test (`Custom3pHelperRun.probeInference`) and its model
discovery run there rather than in the renderer. Patching only the renderer
therefore gets a deployment's endpoint as far as the settings field and no
further: the process that actually dials it validates the URL again and refuses
an http host off the loopback. `patch-main-process.mjs` applies the same splice
to the already-extracted app archive in `25-cowork-bridge-wrapper.sh`, against
`.vite/build/**/*.js`, and drops the V8 code cache for any entry it rewrites so
the patched source cannot be served from a stale cache. It is deliberately
unforgiving — the archive it ships with builds the schema into two entries and
each must match exactly once, so drift fails container start rather than
producing a deployment whose gateway silently cannot be dialled.

The file pane's streaming download button is selected by the file pane's
trailing actions fragment: a two-element `children` array holding a
session-scoped search button and a session-scoped anchor control, on the right
side of a logical expression that gates on the pane kind (`"file"`). The patch
splices one addition into that array — an official ghost icon button (`icon`
`Download`) whose click opens the pane's path in a new tab against the bridge's
`/api/remote/files/download` route. This replaces the pane's own download, which
writes the reader's UTF-8 contents and is lossy for binary. The path is used
verbatim: absolute paths are served as-is, and a relative path (an agent's
`folder/file.zip`) is resolved inside the allowed read roots by the route, not
against the bridge process's cwd. Opening a new tab keeps a refused download from
replacing the app. It is always applied, independent of the Gateway setting, and
must also match exactly once.

The inserted code must name three mangled locals — the pane's `fileView`
selector, the element factory the array already calls, and the ghost icon-only
Button component. None is hard-coded: each is read back from the same parsed
graph (the factory from the array's own element calls, the `fileView` selector
from the variable whose arrow returns `…fileView…` under a `"file"` kind check,
the Button from the unique ghost icon-only component call). If any anchor is
missing or ambiguous the patch is refused rather than spliced, so a future
minifier or rename cannot emit code that only fails at runtime.

This tolerates renamed locals and React imports, moved chunks, whitespace,
single/double quotes, reversed equality operands, computed properties and
optional chaining. Positive and negative protocol comparisons retain their
polarity. The patch extends desktop eligibility when the existing remote
Gateway setting is enabled; it preserves surrounding feature conditions.

The native file preview — the component that draws Office and PDF previews into an
Electron view over Desktop's own window — is selected by the one className its
container renders (`h-full w-full relative overflow-hidden`) together with a
`children` array; that className appears nowhere else in the renderer graph. The
splice rewrites only that children array: for a `.pdf`/`.docx`/`.doc`/`.pptx`/`.ppt`/
`.xlsx`/`.xls` file it renders an `<iframe>` at the bridge's
`/api/remote/files/preview` route with a `#toolbar=0` fragment — the PDF open
parameter Chrome's built-in viewer reads off the URL to hide its own toolbar, so
the pane shows only the document rather than a second set of controls and
download buttons (that viewer Download would save the converted `….docx.pdf`);
Firefox and Safari ignore the parameter and keep their viewer chrome. Every other
file keeps the original output, so html/svg stay on their existing native path. The component's chunk carries none
of the other selectors' tokens, so the string prefilter also accepts its own
DeclineReason test id (`native-file-preview-error`) to reach it. Like the download
button, the injected `iframe` names three mangled locals read back from the same
parsed graph — the element factory the children array's own calls use, and the
`filePath` and `cacheBuster` props from the component's destructured parameter —
and the patch is refused if any is missing, ambiguous, or matches more than once.

The first-party provider card — the "You're using …" / "Inference configuration"
banner that advertises the provider switch on the chat and code home surfaces —
is selected by the two i18n message ids of its copy. Both are content hashes of
that text and appear nowhere else in the renderer graph, so the only match is the
component passed to a wrapper call whose body carries them. The patch replaces
that component's body with `{return null;}`, which removes the card from every
surface at once without touching its siblings (the unhealthy-inference warning,
the `Open` action, the setup routes). The ids are matched as parsed literals, so
a comment or a string that merely spells them is not a target. It is applied
independent of the Gateway setting — the card renders only for a non-first-party
provider, so the patch is inert when the provider is official, and gating it on a
separate flag would leave the card in place whenever that flag is off. It is a
required patch (see below): if an upstream rewording changes the message ids, or
the component is otherwise restructured, candidate preparation fails and the
selector must be updated before the new Desktop is promoted, rather than the card
returning silently.

The titlebar's compact mode switcher — the `Claude`/`Code` pills at the top right
of the navbar — exists only to move between the home surface and the Code
surface, so a deployment with Code turned off (the managed default,
`isClaudeCodeForDesktopEnabled: false`) renders its Code segment disabled and the
whole control is a dead switch. The `titlebar-mode-picker-without-code` patch
replaces the element the switcher renders with `null` whenever its segments array
carries a disabled segment — the exact shape the Code-off state produces — so the
control disappears while the rest of the titlebar, including the switcher's
discovery popover sibling, is untouched; a deployment that enables Code keeps the
picker, because then no segment is disabled. It is selected by the
`data-compact-mode-switcher` label the component sets on that element (which
appears nowhere else in the renderer graph), wrapping a switcher call whose props
name the segments array; the array's binding is read back from the same parsed
graph, so a renamed minifier output still matches. A marker whose children are
not the switcher call, or a switcher call with no `segments` binding, refuses
rather than splice over the wrong element. Like the provider card it is applied
independent of the Gateway setting and in either shell, but — deliberately, and
unlike the card — it is **not** a required patch: a bundle that no longer matches
leaves a useless picker in place, which is visible rather than silent, so it must
not block candidate preparation the way the download and preview patches do.

The renderer only learns Code is off after the bootstrap lands — its surface list
starts from an optimistic default, so the pills paint for a frame before the
splice removes them. The browser client is covered ahead of that round trip by a
`remote-shell.css` rule that hides `[data-compact-mode-switcher]` whenever the
document lacks `claude-remote-code-enabled`, the class the preload adds
synchronously from the bootstrap config (`CLAUDE_REMOTE_CODE_ACTIONS`) before the
app mounts. That class is the same switch as the managed
`isClaudeCodeForDesktopEnabled`, so the two mechanisms agree on a provisioned
deployment; the CSS is what keeps the control from painting at all, and the
renderer splice keeps it out of the DOM for the Desktop frame the browser never
sees.

The sidebar's account chip — the bottom-left identity row — leads with an avatar
slot, but in this build the component behind that slot still reads the account
view and then renders the deployment mark, discarding the `src` it just read:
with a configured `avatar_image_url` the chip never sets an image source, no
request is made and the Claude mark stays. The
`web-account-chip-avatar` patch makes that slot an account avatar when a photo is
present and keeps the mark otherwise. It is selected structurally: a component
whose destructured props include `size` and `organization` (this build adds
placement props beside them), that destructures the account view
(`{name, src}` from a zero-argument hook call — an object literal that
merely carries a `src` property is not a binding) and whose returned expression
— the last element of a comma sequence, like the shipping chip's — renders a call
whose props carry no `src`. The account Avatar component and its element factory
are read back from the sibling components that build an avatar with an explicit
`src` (the user-menu header's avatar). The mark is drawn at an explicit pixel size
(`size:r?20:16`) while the Avatar reads its `size` as a design token of a different
scale, so the mark's own size expression is read back from the call being replaced
and the avatar is pinned to it with an inline style — otherwise the photo renders
larger than the slot the row reserves and eats its padding. A
second photo-less account-view component, or a chip that no longer matches,
refuses rather than splicing the avatar into the wrong slot. Spliced only in
web-shell mode.

The account view hook behind that slot (and the user-menu header's avatar) takes
its photo only from the account-profile query — in this build the view's `src`
is the profile read resolved through a helper call — but the bootstrap account
document it already destructures for the name carries the same
`avatar_image_url` — the bridge puts it there when it applies the operator
identity. The profile read is a separate bridge round trip that only starts
after the bootstrap lands, so the chip painted the deployment mark for as long
as that read took and only then began the image request. The
`web-account-photo-first-frame` patch makes the hook's `src` fall back to
the in-hand account value, so the avatar paints on its first non-empty frame and
the image download runs alongside the profile read; the profile value still
wins when it arrives. It is selected structurally: a zero-parameter function
that destructures `account` from a zero-argument context call, reads the
profile document (`{data, isLoading}` from one call) and returns the
view object carrying `name`, `src` and `isLoading`, with the photo a call that
consumes the profile data binding it resolved from. The account binding's name
is read back from the destructuring and spliced into the fallback, so renaming
tolerates minification; a function that merely returns an object with a
`src` property, binds no account, or answers `src` outside a call over the
profile document, refuses rather than splicing the fallback onto the wrong
reader. A required patch (see below), like the chip avatar it feeds. Spliced
only in web-shell mode.

The user menu's identity line is read from Desktop's interactive auth store
through a hook that paints a loading state on the popover's first frame (the
menu content mounts on open) and only fills from an async `getState()`. In the
web shell that read is a bridge round trip, so the menu's title showed the
deployment label (the hook's fallback branch) for one frame and flipped to the
account name a frame later. The `web-account-menu-name` patch falls back to the
preload's synchronously seeded store snapshot (`getStateSync`, filled from the
bridge's `initialStores`) while the async value is in flight. It is selected
structurally: a function whose whole body is a single return of a zero-argument
call's `principalDisplayName` — a different property, a call carrying arguments,
a member expression or additional statements refuses — and that property name
appears nowhere else in the renderer graph, so a lookalike helper cannot
establish the target. Spliced only in web-shell mode.

The user menu's "Sign out" row exists only when the app believes it holds a
login. The menu builds its flags from `signOut: !!loginDesktop3pStatus`, and
that status is the bootstrap's own `login` — written by the *writable* 3P
configuration — or, absent that, the `Custom3pSetup.getLoginDesktop3pStatus`
IPC, which the bridge serves only with the writable Gateway library enabled. A
managed account has neither, so the app draws no row and the browser-side
preload had to clone a neighbouring menu item, which never carried the menu's
own icon, hover styling or keyboard handling. The deployment's auth service is
what holds an account's session, and the preload replaces the row's click
wherever it appears, so the row only has to exist: the `account-sign-out-row`
patch forces the flag's value to `true`, and the app renders its genuine item
(`icon` `Logout`). It is selected structurally: the single object literal
carrying `signOut` beside `inferenceConfig` and `internalTools` — all
non-mangled property names, and no other literal in the graph carries that trio
— and only the `signOut` value is spliced, so `inferenceConfig` and every other
flag are untouched. Applied independent of the Gateway setting and in either
shell, and **required**: a managed account has no other sign-out, so a bundle
that no longer matches must fail candidate preparation rather than silently drop
it.

Cowork tool permissions — the AskUserQuestion and tool-approval cards — are fed
by the app's pending-permission store, and the only thing that wires that store
(its subscription to the session event stream plus the
`getAll().pendingToolPermissions` hydration) is a hook called inside the Desktop
app's root. The app tree mounts the Desktop-only side-effect hosts (account sync,
that wiring, the Cowork ask pump) through one slot component that renders them
only when the client identifies as the Desktop app and `null` otherwise; the web
shell drops that identity on purpose to get the browser chrome, so the store is
never wired there — the transcript still streams ("Asking a question…") but no
card ever appears and the session waits forever. The
`web-cowork-permission-wiring` patch calls the wiring hook from the slot itself,
unconditionally and before the identity gate, so the store subscribes in either
shell; the hook is ref-counted and its requests are keyed by request id, so the
Desktop root's own call is unaffected. The slot is selected by the
`componentName:"DesktopChecks"` label its own call carries — a string or comment
that merely spells it is not a target — and the hook's call is read back from the
Desktop root's body as the first element of the comma sequence that also carries
the locale-change effect, so a renamed hook or API binding is tolerated. A second
slot, or one that no longer matches, refuses rather than splicing the call into
the wrong component. Spliced only in web-shell mode.

The web shell's "enable notifications" actions — the chat card and the settings
panel's rows — grant the browser permission and then register with claude.ai's
Firebase Cloud Messaging project, persisting a server-side push preference on
the way; neither half can work against this deployment (no claude.ai backend
holds the preference, and the Firebase registration has no project to land in),
so the action always failed and the toggles never stuck. The
`web-notifications-enable-bridge` patch gives the renderer's push-enablement
function a bridge-first branch: when the remote preload's `DesktopNotifications`
surface exists, asking it for the browser permission is the whole operation, and
the preference write that follows succeeds against the bridge's local document
(see `bridge/notifications.mjs`). The function is selected as the one async
declaration whose body guards `Notification.requestPermission()`, tracks the
result under the `claudeai.notification.permission.result` analytics key, and
answers failures with `browser_or_permissions` — all three must sit in the same
function, so a helper that merely spells one of them is not a target, and the
splice reads the request object back from `arguments[0]` rather than naming the
minified binding. A missing or duplicated target refuses. Spliced only in
web-shell mode.

Cowork scheduled tasks ("routines") are reachable in the web shell — the bridge
allows the task collection and the preload relays the Desktop main process's
`onOnScheduledTaskEvent` — but every part of the feature that identifies the
Desktop runtime is false there, so a task could be added and then never run. Two
`web-*` patches close that, both keyed off the same platform check the chrome
patches deliberately avoid forcing globally.

`web-scheduled-task-runner` forces the runner's own gate.
`runScheduledCoworkTask` opens with the zero-argument platform check and aborts
when it is false, answering "Local scheduled tasks can only run in the Claude
desktop app" — which the Routines list reports through its generic run failure,
with no IPC call ever made. The check is read back from the `flag || refuse(id,
log, copy)` short-circuit, whose third argument is the copy only this runner
carries, and then resolved to the zero-argument call its declaring scope
initialises it from — the same read-back the session-layout gate uses, so a
renamed minifier output still matches. The runner's own starter-timeout refusal
passes a conditional rather than the copy, so it is not a target.

`web-scheduled-task-hosts` mounts the two hosts the runner and the dispatcher
depend on. Firing a local task is the main process's job, but it only checks due
tasks once a renderer has declared itself ready (`markListenerReady`), and the
hook that does so — and that receives the dispatches — is mounted from the
Desktop-checks slot behind that slot's identity gate, as is the starter host
that publishes the session starter the runner waits on. In the web shell neither
is rendered, so the scheduler defers on every check and a run that gets past the
gate above still fails waiting for a starter nobody published. The patch mounts
exactly those two hosts from the slot's own absent-identity branch, reusing the
slot's wrapper element, element factory and props, so the hosts render into the
same boundary the app uses; the branch renders only when the gate is false, and
the app's own mount only when it is true, so nothing is ever mounted twice. Both
hosts are read back by behaviour — the starter host is the declarator whose body
writes `startSession` through `setState`, the listener host is the component
whose whole body calls the hook that subscribes to `onOnScheduledTaskEvent` and
declares `markListenerReady` — and either one missing, ambiguous, or landing in a
different chunk refuses rather than mount the wrong component. Spliced only in
web-shell mode. Both patches are **required**, like the rest of the web-shell
set: without them the Routines list still offers creation and the failure is
silent, which is exactly the shape a required patch exists to refuse.

`web-new-page-home-layout` turns on the New page's **home** layout — the compact
greeting, the composer's controls docked below the card, the below-fold feed —
which the Desktop build compiles out: the chunk that reads the new-page gate
(`__gb__1085985672`) returns its assignment object with `eligible`, `settled`
and `assignment` hardcoded false, so the renderer settles on the classic layout
however the gate evaluates, even though the layout's components ship in the same
bundle. The patch splices that object to the all-assigned shape the web bundle
produces for a visitor in the experiment. It is pinned by the object's own six
property names and the chunk by the gate literal it reads, each exactly once.
Unlike the rest of the web-shell set this one is deliberately **not required**:
if a future bundle stops matching, the classic layout comes back rather than
renderer preparation failing.

`web-composer-design-forced` forces the **marlin** arm itself. The home layout
above is gated on it — the renderer forces the classic layout whenever the arm
reads as off — so an off arm silently reverts the whole New page even though the
bridge grants the feature in every bootstrap it serves. The renderer's own read
can still answer off: the arm it remembers on the device wins whenever the
feature is absent from the table the client built, the first read is frozen for
the life of the page, and a feature table persisted from before the grant can
answer in place of the fresh one. The patch selects the predicates by reading the
feature *by name* — through the binding that holds the name or as the literal —
among the declarations that end their answer with `… && !isSidePanel()`, and
splices only the left operand of that guard, so the side-panel check still
applies. Spliced only in web-shell mode, and not required.

`web-new-page-home-variant` and `web-home-composer-arrangement` force the two
decisions downstream of that arm, because a deployment that grants the arm has
already made them. The first splices the layout hook's settled variant to the
`home` arm — selected as the one `{variant, settled}` object whose variant is
computed, since the composer's own `{variant: "none", …}` defaults are literals.
The second splices the route surface kind to `"outside"` — selected as the only
place the three route names appear together (`… ? "hub" : … ? "outside" :
"none"`), whose `"outside"` arm is what selects the home composer arrangement and
so moves the model and permission controls out of the card. Each is spliced only
where its shape is unambiguous in the chunk, only in web-shell mode, and neither
is required.

`web-projects-allowed` restores the **Projects** predicate — the `/projects`
routes and the composer's project slot — which the Desktop build also compiles
out. The bundle's predicate calls three plan-capability readers and then reads
`claude_ai_projects_limits`, but answers a module constant that is never
assigned, so it is false however either would evaluate. The patch rebuilds the
body as the disjunction claude.ai ships: the same four reads hoisted into
declarators (they are hooks, so short-circuiting them behind `||` would change
hook order between renders) and the feature compared `> 0`, as the bundle's own
sibling limit helper already compares it. It is pinned by the feature name and
field literals, which the bundle spells only there, and by the function's comma
sequence, and the body is replaced only when exactly one such function is in the
chunk. Spliced only in web-shell mode, and not required. The bridge supplies the
feature the restored predicate reads (`grantProjectsLimits`), because a
self-hosted org carries no plan capability.

`web-projects-sidebar-entry` and `web-projects-composer-slot` carry the same
feature into the two surfaces that still hid it, each blocked by a value
claude.ai computes and the Desktop build compiles to a constant.

The first drops the two clauses about the Projects entry from the nav filter's
negated `||` chain: one is Desktop-only (`… && surface === "chat" &&
!isLocalChatSupported`, read once from `globalThis.desktopBootFeatures`, the
Desktop main process's table that a browser page never has) and the other reads
an atrium flag the web bundle evaluates `flag || !inNestedFrame` — true for any
top-level page — while Desktop folds it to `false`. Only operands testing
`id === "projects"` are removed, so the mode and eligibility filters still apply.

The second forces the composer's project-slot answer to `"enabled"`. That chain's
remaining operand is a store holding the pending first send, which is null until
a send is being prepared, so on a New page it short-circuits to `"disabled"` and
renders nothing; claude.ai renders the slot there. Only the returned expression
is spliced, leaving the declarators — the feature reads and surface hook calls —
in place so hook order is unchanged, and the function is pinned by the four mode
literals it answers with. Both are spliced only in web-shell mode, and neither is
required.


The code generator splices only the selected node. It does not regenerate
the rest of a bundle, rewrite imports, or depend on chunk hashes. Native feature
checks inspect syntax too, so `event.keyCode === 229` and
`229 == event['keyCode']` both establish IME handling. Comments and strings that
merely look like code do not establish a capability.

Each required patch must have exactly one target across the renderer graph.
Missing or ambiguous targets remain errors: no feature is silently disabled and
no broad replacement is applied to unrelated code. Diagnostics include the
patch ID and match count. The generated manifest records original expressions,
file hashes and the actual source snippets establishing native capabilities.
The HTTP smoke test verifies those snippets against the served modules.

## Testing

```bash
npm ci --prefix rootfs/opt/claude-cowork-bridge --ignore-scripts
./scripts/validate.sh
node scripts/desktop-compatibility-smoke.mjs /path/to/extracted/resources/ion-dist
```

The source tests run syntax variations and evaluate the patched guards with all
combinations of native/HTTPS protocol, Gateway toggle and upstream feature flag.
They also check unrelated code, duplicate targets, missing capabilities and
preservation of the last working renderer on rejection.

The official-package test checks both Gateway modes, then runs the actual
Gateway modules through Terser with mangling, alternate quotes, moved filenames
and a compression pass. The patcher must still find every target. Terser is a
test-only dependency; the container installs only Acorn with a locked version.

Actual upstream changes to the route's behavior or stable properties can still
require a selector update. Passing these tests does not substitute for running
Chat/Cowork and Gateway setup on an Electron/Linux host. Version pins and the
updater's compatibility gate are independent of frontend selector tolerance.
