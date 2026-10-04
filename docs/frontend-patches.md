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
`Download`) whose click streams the pane's absolute path from the bridge's
`/api/remote/files/download` route. This replaces the pane's own download, which
writes the reader's UTF-8 contents and is lossy for binary. It is always applied,
independent of the Gateway setting, and must also match exactly once.

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

The code generator splices only the selected comparison. It does not regenerate
the rest of a bundle, rewrite imports, or depend on chunk hashes. Native feature
checks inspect syntax too, so `event.keyCode === 229` and
`229 == event['keyCode']` both establish IME handling. Comments and strings that
merely look like code do not establish a capability.

Each requested patch must have exactly one target across the renderer graph.
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
