# Desktop extensions (`.mcpb` / MCPB bundles)

Settings → Extensions installs a **desktop extension**: a zip archive with a
`manifest.json` and an MCP server that runs on the machine the Desktop app runs
on (this container). The official Linux build ships the whole feature, but in
three-party mode it is off by default and four separate gates hide it. All four
are now answered for this deployment.

## What was shut, and where it is answered

| Gate | Official behaviour | Here |
| --- | --- | --- |
| `extensions.enabled` | Unset in 3P mode, so `isExtensionsEnabled()` is false | `30-claude-config.sh` writes `"extensions": {"enabled": true}` into `claude_desktop_config.json`, and the flat `isDesktopExtensionEnabled: true` into the environment-seeded managed configuration / applied config-library entry (the source the app actually reads when the writable 3P configuration library is in use) |
| `hasOrgPolicyBackend()` | The 3P deployment mode answers false (the policy service is claude.ai), so `isLocalExtensionInstallAllowed()` is false and every install handler refuses | `patch-main-process.mjs` rewrites the main process's extensions policy so the install flag is the enablement answer alone (the Desktop window); `bridge-wrapper/extensions.cjs` additionally forces that one predicate true for the duration of an Extensions IPC call |
| Settings nav | The "This computer" section is rendered only for a Desktop-identified client, and the Extensions item only when sessions run on this device; the web shell is neither | `settings-extensions-tab` / `settings-extensions-group` renderer patches |
| Settings **page** | Every desktop settings page (Extensions, its advanced and detail pages, Developer) is wrapped by a component that calls `notFound()` unless the client identifies as the Desktop app *and* `onThisDevice` is true | `desktop-settings-page-gate` renderer patch |
| Preview modal's Install control | Rendered only when the client identifies as the Desktop app *and* `isDirectoryEnabled()` is true. The browser keeps its own user agent, and 3P mode has no directory backend, so an uploaded bundle previewed but offered no way to install | `settings-extensions-install` renderer patch replaces that one gate with `true`; the control itself is the official one, and its Install handler still asks the Desktop to install |
| Browser drop target | The Extensions overview requires `claude.settings.FilePickers` and `window.claudeAppSettings.filePickers.getPathForFile`, neither of which a browser has | `remote-preload.js` publishes `FilePickers` and the synchronous path helper; a dropped `.mcpb`/`.dxt` becomes a one-shot token, `handleDxtFile` uploads the remembered File and calls the Desktop with the `/workspace` path |
| Local MCP attach | The chat surface and the extension page connect local servers through `claudeAppBindings` and an Electron `MessagePort`; a browser has neither, so the server ran but never attached | the wrapper's renderer proxy owns the port and multiplexes JSON-RPC over `/api/remote/mcp/*`; the preload publishes the two bindings and hands the page a real `MessageChannel` port |

The policy override in `extensions.cjs` is scoped to Extensions IPC. Unrelated
organization-policy reads (usage, account capabilities, blocklists) that also
consult `hasOrgPolicyBackend()` keep the 3P answer. The main-process splice
changes only the extensions policy's install flag; `isDirectoryEnabled()` still
reads the backend predicate and stays false.

The nav patch appends the official Extensions item to the nav when the desktop
section was not rendered, and leaves a Desktop-identified window's own list
untouched, so the tab appears exactly once. Both halves are required patches
when the bundle carries the `/settings/desktop/extensions` route: a Desktop
update that reshapes the nav fails renderer preparation instead of silently
losing the tab again.

## Installing a bundle

### In the browser

Two ways to hand a bundle to the page:

* **Drag and drop** the `.mcpb` (or `.dxt`) file onto **Settings →
  Extensions**. The overview's own drop target is used; the file is uploaded
  and the preview opens.
* **Settings → Extensions → Advanced settings → Extension developer → Install
  extension**, then pick a local file. The preload publishes
  `showInstallDxtDialog` itself, so the official button opens the browser's
  file picker instead of the native dialog on the container's headless display.

Both paths upload the file through the same streaming route as any other
browser file, into `/workspace/RemoteUploads/…`, and then call the Desktop's
`handleDxtFile` with the uploaded path. The official preview modal opens;
**Install** copies the bundle into
`~/.config/Claude-3p/Claude Extensions/<id>` and enables it when its required
settings have defaults.

If the manifest has required `user_config` fields without defaults (an API
token, for example), the extension is installed but disabled. Open its detail
page and fill the form; the values are stored in
`Claude Extensions Settings/<id>.json` (sensitive fields use Electron
`safeStorage` when available, plaintext otherwise).

The native confirmation/error dialogs that the install path raises are
auto-answered for relayed browser calls (the preview modal already asked); a
Desktop window's own installs keep their visible dialogs. The preview's
"Get Claude for Desktop to use this extension" banner is cosmetic in the
browser and does not replace the Install control, which is rendered above it.

### In the Desktop window (VNC / Xvfb)

The same page and the same native dialogs work. The main-process policy splice
makes the install controls appear here too (`localExtensionInstallAllowed` no
longer waits on a claude.ai policy backend); the install button opens the
Electron file picker, drag-and-drop uses the real filesystem path, and the
confirmation dialog is visible. Nothing browser-specific is involved.

## Using the extension in the browser

The official renderer attaches local MCP servers (extensions included) through
`window.claudeAppBindings.listMcpServers()` / `connectToMcpServer()`, which the
Electron preload implements by handing the page a `MessagePort` connected to the
server the Desktop process spawned. A browser can receive neither the IPC nor
the port, so without help the extension detail page timed out with "Unable to
connect to extension server" and the chat surface never saw the extension's
tools.

The wrapper now runs a proxy in the official renderer: it owns the real
`MessagePort`, answers each browser client's `initialize` locally (only one
initialize may reach the server), gives every browser connection a disjoint
JSON-RPC id range, and multiplexes requests and responses over the bridge's
authenticated `/api/remote/mcp/*` routes and desktop-ipc event stream. The
remote preload publishes the two `claudeAppBindings` methods and hands the page
a real `MessageChannel` port, so the official attach path runs unchanged. The
extension's tools execute in the Desktop process — not in the browser, the
bridge, or the Cowork guest — and the detail page lists them (and their
permission state) once the client attaches.

Two details keep the attach path from disturbing the Desktop window:

* The attach hook reads `claude.settings.MCP.getMcpServersConfig` to tell a
  server the account never configured (the internal `mcp-registry`) from a real
  local one. The bridge exposes that one method read-only; without it the
  browser tried to connect `mcp-registry` and showed a failure toast.
* The preload installs a main-world listener at startup that remembers every
  port the app receives. When the browser connects a server the Desktop window
  already attached, the proxy reuses that port instead of calling
  `connectToMcpServer` again — a restart can race a `uv` environment lock and
  fail (the Canvas/`uv` case). A server that genuinely fails to start still
  reports the official failure toast.
* The main process accepts `connect-to-mcp-server` only from the app's main
  `WebContentsView`. The setup window and popouts load the same preload, so
  they answer `listMcpServers` but their connects are silently ignored. The
  wrapper evaluates MCP calls in the main renderer specifically (lowest
  webContents id among the binding-capable candidates, excluding the
  `/setup-desktop-3p` window); otherwise every connect times out.

`claudeAppBindings` is what the claude.ai chat surface uses for local
connectors, so the same proxy also makes the browser's chat use local MCP
servers the account configured. The Desktop window keeps its own connection;
the two clients share the server process but use separate id ranges.

## Runtime

The extension's MCP server is spawned by the Desktop main process, not by the
Cowork guest. What a bundle needs must therefore exist in this container:

* `server.type: "node"` — the system Node.js (installed in the image), or the
  Node runtime the app downloads itself (`Use built-in Node.js for MCP` on the
  advanced page).
* `server.type: "python"` — the image's system `python3` (installed explicitly
  so a Python extension and `uv` do not depend on a base-image accident).
* `server.type: "uv"` — the app downloads `uv` into `userData/uv-runtime` and
  runs `uv sync` in the extension directory during install; this needs egress
  to GitHub releases and to the package index. A failed setup fails the
  install with the official error dialog (reported as a toast in the browser).
  `uv` can use the image's `python3`, so a reinstall does not depend on a
  separately downloaded interpreter.

Installed servers are added to the same MCP configuration the local Chat /
Cowork sessions use. Enabling or disabling an extension takes effect for
sessions started afterwards; a running session keeps the tool list it started
with.

## What is still not available

* **The extension directory.** `isDirectoryEnabled()` stays false: it requires
  an organization policy backend and a claude.ai directory service. Only local
  bundles can be installed.
* **The advanced page's auto-update / built-in-Node toggles.** They live on
  `claude.settings.AppConfig`, which this bridge does not expose. Extensions
  still run; only those two checkboxes are inert.
* **Signature enforcement.** `extensions.signatureRequired` is left unset, so
  unsigned bundles install. Set it in `claude_desktop_config.json` if this
  deployment should require signed packages.
* **Updating from the directory.** There is no directory, so updates are a
  reinstall of a newer `.mcpb` from the same page.

## Security

A `.mcpb` is arbitrary local code. It runs as the Desktop's user inside this
container and can read what that user can read (`/config`, the workspace mounts
and the deployment's environment). Every account's instance is a separate
container, and nothing installs without an explicit file pick and an Install
click, but the operator should treat a bundle exactly like a program installed
on the host. The extension's own tool calls still go through Claude's normal
tool-permission UI.

The browser MCP proxy is behind the bridge's session authentication and can
reach exactly the local servers the Desktop's own renderer lists for the
signed-in account — the same set the Desktop window's chat attaches. It does
not create a new network listener; the JSON-RPC rides the authenticated
`/api/remote/mcp/*` routes and the existing event stream.
