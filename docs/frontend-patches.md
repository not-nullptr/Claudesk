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

The sidebar's account chip — the bottom-left identity row — leads with an avatar
slot, but in this build the component behind that slot (`{size, organization}`)
still reads the account profile and then renders the deployment mark, discarding
the `photoUrl` it just read: with a configured `avatar_image_url` the chip never
sets an image source, no request is made and the Claude mark stays. The
`web-account-chip-avatar` patch makes that slot an account avatar when a photo is
present and keeps the mark otherwise. It is selected structurally: a component
taking `{size, organization}` that destructures the account view
(`{name, photoUrl, …}` from a zero-argument hook call — an object literal that
merely carries a `photoUrl` property is not a binding) and returns a call whose
props carry no `src`. The account Avatar component and its element factory are
read back from the sibling components that build an avatar with an explicit
`src` (the user-menu header's avatar). The mark is drawn at an explicit pixel size
(`size:r?20:16`) while the Avatar reads its `size` as a design token of a different
scale, so the mark's own size expression is read back from the call being replaced
and the avatar is pinned to it with an inline style — otherwise the photo renders
larger than the slot the row reserves and eats its padding. A
second photo-less account-view component, or a chip that no longer matches,
refuses rather than splicing the avatar into the wrong slot. Spliced only in
web-shell mode.

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
