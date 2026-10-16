# Claude Desktop 2.31226.1 → 2.42304.0: a bundle-level changelog

What is available upstream, what changed between it and what we pin, and what
the shipped bundles say that the published notes do not. Written from a diff of
the three pristine `.deb`s, not from release notes.

## What is available

The signed APT repository at `downloads.claude.ai/claude-desktop/apt/stable`
carries 54 published versions. Ours is the newest three:

| Version | Published | `.deb` bytes | SHA-256 (first 16) | Bundled Claude Code |
| --- | --- | --- | --- | --- |
| 2.31226.1 | 2026-10-09 | 181 377 680 | `5a9bebdfcb1df6ce` | 2.1.295 |
| 2.37337.1 | 2026-10-13 | 182 483 892 | `41745b0914f0ff51` | — |
| **2.42304.0** | **2026-10-15** | 183 117 920 | `74cd2ccc29d24165` | 2.1.299 |

Full digests, both of which we verified against the repository's own
`Packages` index before extracting:

```
5a9bebdfcb1df6ce38767b373f3a7fabf77156a2ddd8a3f5d04961da5bde305e  claude-desktop_2.31226.1_amd64.deb
41745b0914f0ff51631a1ff1bb403b836bf5c995845cca6742dd39bca3a2da14  claude-desktop_2.37337.1_amd64.deb
74cd2ccc29d24165144e455cbc872c6cc2a24a263b83e73420e95f89166d4aa4  claude-desktop_2.42304.0_amd64.deb
```

`2.42304.0` is therefore the current latest, and updating from our pin crosses
two releases, not one.

## How this was produced

Everything below is observed, not inferred, and is reproducible:

```
curl -O https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_<v>_amd64.deb
dpkg-deb -x claude-desktop_<v>_amd64.deb install-<v>/
```

`resources/app.asar` is read by parsing its header in place — the data section
begins at `16 + align4(headerJsonLength)`, not at `16 + headerJsonLength`. The
two-byte slack that alignment leaves at the front of the first chunk is what
makes an off-by-one version of this reader report 261 of 399 files as
unparseable instead of zero, so it is worth getting right. `renderer-patches.mjs`
is then run unmodified over each `resources/ion-dist` tree with `acorn` from
`/opt/claude-cowork-bridge/node_modules`.

## Engine and packaging deltas

| | 2.31226.1 | 2.37337.1 | 2.42304.0 |
| --- | --- | --- | --- |
| Electron | 44.4.3 | 44.7.0 | 44.7.2 |
| Chromium | 152.0.7977.130 | 152.0.7977.130 | 152.0.7977.149 |
| `app.asar` | 44 486 303 | 49 024 278 | 49 218 697 |
| JS entries in asar | 399 | 417 | 427 |
| `.js` files in ion-dist | 3 372 | 3 465 | 3 588 |
| ion-dist, all files | 3 768 | 3 847 | 4 224 |
| ion-dist chunks / edges (`scc.json`) | 3 333 / 40 868 | — | 3 548 / 44 988 |
| Renderer strings | 33 388 | 34 046 | 34 502 |
| Main-process strings | 801 | 807 | 837 |

Chromium only moves a patch within 152; Electron is a minor bump. The bulk of
the growth is content, not engine.

**Three journal-sized files.** `app.asar` grows 4.73 MB (+10.6 %) across the
range. Almost all of that is one layer: 2.37337.1 introduces
`resources/artifact-libs/` inside the asar, holding chart.js 4.5.0, Grid.js
5.0.2 and Mermaid 11.17.2. Upstream mentions this once, as a Cowork fix
("charts, tables, and diagrams in artifacts staying blank when offline … the
libraries now come with the app"), and in the same release changes
`disableNonessentialServices` so it no longer turns those three off. Vendored
Mermaid alone contributes the largest share of new identifiers in the whole main
bundle, which is worth knowing before reading any diff of it: the noise floor
is not the app.

**New helper binary.** 2.42304.0 adds `resources/claude-ssh-askpass`, 2 519 224
bytes, alongside the existing `chrome-native-host`, `cowork-linux-helper` and
`disclaimer`. Nothing leaves; `app.asar.unpacked` is byte-identical across all
three versions, so `node-pty`, `@ant` and `resources/github-mcp` are unchanged.

**New dependency, not installed by us.** 2.37337.1 adds `openssh-client` to the
deb's `Recommends`. Our Dockerfile installs the app with
`--no-install-recommends`, so we do not pull it, and the binary the app actually
needs for SSH sign-in ships inside the deb. Flagged only because the new SSH
session host is inert without a usable `ssh`.

**The Cowork VM image is rebuilt every release.** `smol-bin.x64.img` is
28 311 552 bytes in all three versions and has a different SHA-256 in each
(`5daa0e3e…` → `e03447b1…` → `6f62b7aa…`). Same for `virtiofsd`, which holds
its 2 675 512-byte size. A version bump is therefore also a per-tenant VM bundle
change, not just a renderer change.

**Two new front-end entry points.** `resources/ion-dist/client-shell-v1.html`
is new in 2.42304.0 and is referenced twice from the main-process bundle. It is
2 529 bytes: a CSP-locked page (`default-src 'none'`, `script-src
'unsafe-inline' blob:`) that takes a handshake out of `window.name`, waits for a
`{type:'boot', handshake, document}` message, builds that document string into an
`iframe` with `sandbox="allow-scripts"` and `allow=""`, and then hands the inner
frame a `MessagePort` and reports `ready` upward. `index.html` grows 45 944 →
46 664 bytes and `frame-shell.html` 24 634 → 26 317. If the web shell work ever
depends on how a shell document reaches its frame, this is the mechanism that
moved.

## What upstream publishes, and what the bundles show

Upstream does keep a per-build changelog, at
<https://claude.com/docs/cowork/changelog>, with `General`, `Code`, `Cowork` and
`3P` sections and a bundled Claude Code version per entry. The Help Center
release notes are feature-level and carry no build numbers. So "deeper than
published" here means: the things in the bundle that no published entry
mentions.

### 2.37337.1

Published, in summary: Auto save in the Code Files pane; SSH on Windows
restricted to an `ssh.exe` on `PATH`; a `developerModeEnabled` admin switch; a
"Not set"/"Allow none" choice for empty `coworkEgressAllowedHosts` and
`sshHostAllowlist`; a warning for `disabledBuiltinTools` entries spelled
`web_fetch`; `disableNonessentialServices` no longer disabling chart/Grid/Mermaid;
`sshTransport` unreadable values counting as `builtin`; the Setup window's `.reg`
export moving from `HKEY_CURRENT_USER` to `HKEY_LOCAL_MACHINE`; several
`(breaking)` removals of deprecated key spellings; and a long tail of fixes
(FSLogix profiles, PAC-file proxy changes, proxy auto-config, Windows `npx`
paths, MCP OAuth re-auth, `prefer1m`).

Not published, and visible only in the bundle:

- **Endpoint-security integration for the Cowork VM.** A whole subsystem named
  `edrIntegration`, gated by a `coworkEDRIntegration` flag, that pushes a
  `install.args` payload from `Program Files\Claude\edr-integration\` into the
  guest and reports back — with distinct refusal paths for the Windows VM
  service and for the desktop's own pre-check, an attempt counter and size
  readout, and a Settings surface described as "the endpoint-security
  integration's setup, its last runs, and a failed install script's last
  output". It is a second host-to-guest payload path, separate from the VSOCK
  and virtiofsd plumbing we already patch around, and no published entry
  acknowledges that it exists.
- **SSH remote sessions as a first-class host.** The published note covers the
  Windows `ssh.exe` restriction and `sshTransport` defaults. The bundle also
  carries the askpass helper's own protocol — `[OpenSSHAskpass] pipe frame
  rejected (token/proof/shape/identity)` — plus jump-host handling
  (`ProxyJump` → `User` migration advice), `~/.ssh/config` aliases, an SSH host
  allowlist, host-key review prompts, and "OpenSSH discrete mode: the primary's
  command met the end of its input at once".
- **Browser data import.** `browser_data_import_enabled`, "Import cookies from
  other browsers", and the org-policy copy that governs it.
- **Dispatch.** A sessions bridge that stands down when the claude.ai page
  reports Dispatch off for the account, and persists that report
  (`[Dispatch] failed to persist the page's Dispatch-off report`).
- **Claude Code Security / Code Review approvals.** `code_review_organization_approvals`,
  `code_review_repository_approvals`, `code_review_repo_admin_required`,
  `code_review_repo_admin_not_confirmed`, `claude_code_security_all_projects_manage_enabled`.
- **A directory portal for access requests.** `admin_directory_portal_access_requests`,
  `directory_portal_access_requests`.
- **The Remote Control → "Computer access" rename.** "Computer access (formerly
  Remote Control) and Require trusted devices have moved to Remote sessions in
  Capabilities." No published entry uses the new name.
- **Code worktrees as a configured feature.** A "Where to store Git worktrees
  for isolated coding sessions on this computer" setting, worktree safety
  checks, and a family of rejection reasons about worktree folders reached
  through links or recorded for another repository.
- **A concurrent-session cap.** `{activeCount} of {maxSessions}` with arrow
  navigation between sessions.
- **Third-party import shipping before it was announced.** The renderer already
  carries the skills/plugins/MCP/extensions import copy at 2.37337.1 — the
  "From Claude (third-party)" strings, the "See it in Customize › Skills"
  notices, the tool on/off sync to the account. Upstream's first published
  mention of the import is in the 2.42304.0 entry.
- **A scheduled notice, already in the bundle.** One string in 2.37337.1's
  renderer announces that Docs, Slides and Design go on by default "starting
  October 15" — two days after that build shipped.

### 2.42304.0

Published, in summary: the Windows signed helper's certificate swap; third-party
import widened (local MCP servers, extensions, plugins, skills, with an
unconfirmed path when device management allows it, and nothing under HIPAA);
import improvements; Git operations no longer running repository hooks; the
"Get started with Claude Code" checklist removed; SSH sessions surviving an app
restart on macOS/Linux; `mcpPersistentAlwaysAllowEnabled` extended to Code
sessions; `claudeAiImport.automatic3pImport`; Chat's file-analysis sandbox
reaching `coworkEgressAllowedHosts`; session export covering everything by
default; and fixes across all four sections.

Not published, and visible only in the bundle:

- **WSL as a session host.** "A task's place needs an SSH host or a WSL
  distribution, and a folder on it"; "No WSL 2 distribution with that name is
  installed"; "Blocked: not available in WSL"; "Blocked: outside the WSL session
  folder"; "Launch cwd is a WSL session's folder, not on this computer"; "Could
  not reach the WSL distribution"; and an MSIX path-rewriting note about giving
  Claude Code the original path. The published note for this build says nothing
  about WSL.
- **Update channels.** `'nest' | 'production' | 'staggered'` from
  `getUpdateChannel` in `updater.ts`, surfaced as "Which releases auto-update
  installs. Stable: each release as it rolls out. Staggered: a release only
  after it has been on stable for a while." Nothing published describes a
  channel setting.
- **A certificate parser, and a signed proxy cache.** A full DER/X.509 reader
  ships in the main bundle — `DER: duplicate basicConstraints extension`, `DER:
  non-minimal length encoding`, `DER: [3] must wrap exactly one Extensions
  sequence`, `pathLenConstraint` handling — next to a "Claude Code Signed Cache
  Issuing CA" and work on "the verifier". Upstream's published note mentions
  only a certificate swap for the Windows helper binary. A bundled DER parser
  plus a cache-signing CA is a different and larger claim, and we are asserting
  it only as far as the strings go.
- **A Cowork deletion outbox.** Batched deletion-event POSTs with their own
  retry and failure vocabulary, an org-routing step that tolerates
  `getLastActiveOrg` failing, and drain-on-sign-in.
- **A device-simulator bridge.** Hinge control for a Duo (`duo_hinge`,
  `duo_pose`, `'angle' goes only with pose 'half_open'`), an Android
  recording/finalize path, emulator liveness checks, and a DeviceHub-driven
  macOS path.
- **Recording finalisation.** "Desktop finished its recordings for an update",
  "couldn't write the recording to disk fast enough", and finalize timeouts.
- **A new artifacts pane.** The pane enumeration gains an entry — "terminal, PR,
  tasks, plan, browser or artifacts pane" where the previous list stopped at
  "browser pane".
- **Managed-config capability plumbing.** "Managed config served capabilities
  set", "managed config rebuild failed; served capabilities wait", and
  `[self-hosted] capabilities answer enforces a default model that is not its
  first; not applied` — plus an explicit "served configuration not in force".
- **Third-party plugin and marketplace resync.** `[custom-3p] marketplace
  resync failed`, `[custom-3p] org plugin resync failed`, and a `plugins wait:`
  family of deferred states for members whose access data has not loaded.

## Managed-configuration keys

Diffed by literal across the three main bundles, with vendored Mermaid
separated out. These are the key names an administrator writes.

**Added** (all in the app bundle, none in Mermaid):

```
chatAdvancedFileAnalysisNetworkEnabled
developerModeEnabled
sshConfigs
trustedFolderSettingsConsent
disableThirdPartyAppSettingsImport
disableThirdPartyDeclaringSkillsImport
disableThirdPartyExtensionsImport
disableThirdPartyFolderImport
disableThirdPartyImportWithoutClicks
disableThirdPartyInstructionsImport
disableThirdPartyMcpToolSwitches
disableThirdPartyPluginsImport
disableThirdPartyTaskApprovalsImport
```

The nine `disableThirdParty*` keys are a granular opt-out set for the import
feature: each import surface can be withheld separately, and
`disableThirdPartyImportWithoutClicks` is the switch behind "skills uploaded
without confirmation when device management enables it".

**Removed** — these are the published `(breaking)` removals, and the bundle
agrees. All three are gone from the 2.42304.0 main bundle and present in ours:

```
inferenceGatewayHeaders
trustBootstrapLocalExec
webSocketOptions
```

**Semantics changed**, from the published 3P notes and consistent with the
bundle: `coworkEgressAllowedHosts` no longer auto-includes the organisation's own
inference provider, gateway, OTLP collector or `api.anthropic.com`;
`disableNonessentialServices` no longer disables chart.js, Grid.js or Mermaid;
an unreadable `sshTransport` value now reads as `builtin` rather than the default
engine; and a malformed `managedMcpServers` `toolPolicy` is kept-and-blocked
rather than dropped.

## Effect on this deployment

**The renderer patcher survives both releases, unchanged.** Running
`patchRendererSources` from `rootfs/opt/claude-cowork-bridge/renderer-patches.mjs`
over each pristine `ion-dist`:

| | gateway on | gateway off |
| --- | --- | --- |
| 2.31226.1 | 4 patches | 2 patches |
| 2.37337.1 | 4 patches | 2 patches |
| 2.42304.0 | 4 patches | 2 patches |

The four required patches (`file-pane-download`, `inference-banner`,
`gateway-setup-route-web-guard`, `gateway-setup-signin-web-guard`) each resolve
exactly once, and all four markers (`cowork-native-rewind`,
`code-native-rewind-v2`, `ime-keycode-229`, `native-message-edit`) are present,
on every version. The chunk *bases* the anchors land in are stable enough to
re-check in seconds: the file pane is `assets/v1/cccc2cf0a-*` and the inference
banner `assets/v1/shared-19-*` in all three; the two gateway guards are
`assets/v1/c71860c77-*` in all three. Two things do move — the chunk carrying
the two `code-native-rewind-v2` matches changes base, `caec4a2d4-*` →
`cc8941b7b-*`, and a new chunk `c227f4d5e-*` picks up `ime-keycode-229` — but
neither is selected by name.

So the update is a compatibility-profile bump, not a patch rewrite. It needs
`config/release.json` moved (`desktopVersion` → `2.42304.0`, plus a new
`patchRelease`), which is also what `scripts/monthly-update.sh` is waiting for:
it discovers the new candidate from the APT repository, finds no reviewed
profile, and defers, exactly as designed.

**Nothing moves for the fork's own gates.** `yukon_silver_dramatic_shrimp`,
`…_clocks`, `…_internal`, `yukon_silver_folders`, `_thinking`, `_project`,
`_settings`, `_seadragon`, `_octopus_prompt`, `_tool_perms`,
`_minimum_nest_version` and `desktopHome` are all present in all three versions
with unchanged reference counts, and no new `yukon_silver_*` key appears. The
folded-capability trap described in the renderer-patches notes is neither fixed
nor widened. `resources/ion-dist/custom-3p-gated-imports.json` is byte-identical
across all three (35 bytes), so third-party gating is untouched.

**The changes that could bite us are all in managed configuration, not the
renderer.** Three of the removed keys are exactly the kind this deployment
would be expected to set, and removal makes them unrecognised rather than
deprecated — the setting silently stops applying. `enduserAttribution` survives
`trustBootstrapLocalExec`'s removal as the name to use; `inferenceCustomHeaders`
replaces `inferenceGatewayHeaders`; a `bootstrapUrl` set by device management is
now trusted without asking (whereas `trustBootstrapLocalExec` is gone). Before
bumping, the managed config this box serves should be checked for those three
names, and for whether anything relies on provider/gateway/OTLP hosts being
auto-added to `coworkEgressAllowedHosts`.

**Cost.** The deb grows 1.7 MB (183 117 920 − 181 377 680 bytes) and the
installed tree about 11 MiB by `Installed-Size` (590 997 → 602 444 KiB, against
597 746 KiB at the intermediate release), but a bump also changes
`smol-bin.x64.img`, so per-tenant VM bundles are rebuilt — which matters more
than the renderer for both disk and first-start time.
