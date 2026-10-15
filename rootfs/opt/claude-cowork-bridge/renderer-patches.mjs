import { parse } from "acorn";

// Keep selectors tied to non-mangled properties and behavior, not names of
// chunks, locals, React imports, or textual formatting. Only splice the selected
// expression: regenerating a whole bundle would disturb its module graph.
export const markerIds = ["cowork-native-rewind", "code-native-rewind-v2",
  "ime-keycode-229", "native-message-edit"];
// The file pane's own download writes the reader's UTF-8 contents, which is
// lossy for binary; a header button streams the raw file from the bridge's
// download route instead. The pane header passes paneName "Files" to its
// settings menu, so this is the file pane's trailing actions fragment.
const downloadPatchId = "file-pane-download";
// The first-party provider card ("You're using …" / "Inference configuration")
// advertises the provider switch on the chat and code home surfaces. A Gateway
// deployment fixes the provider, so the card is only noise there. Two i18n
// message ids — content hashes of that copy — pin the component that renders it
// and appear nowhere else in the renderer graph; its body is replaced with an
// unconditional null. The ids are matched only as parsed literals, so a comment
// or string that merely spells them cannot establish the target. This patch is
// required like the download button: a bundle that no longer matches must fail
// candidate preparation rather than silently let the card return.
const inferenceBannerPatchId = "inference-banner";
const inferenceBannerMessageIds = ["+8XhcAcHfK", "1qPkTh9fMa"];
// Desktop validates the Gateway URL as https, or plain http only on a loopback
// host, and refuses anything else. A managed deployment supplies that URL from
// its own environment, so the rule does not describe a choice the user made —
// and the Cowork VM, which makes the model calls, has to dial the gateway on
// whatever address reaches it, which need not be the container's loopback. The
// predicate is pinned by the schema's own error copy, the "must use https (or
// http on loopback)" branch of its message, which appears nowhere else in the
// renderer graph; the hostname it tests is read back from the same parsed graph
// (the `hostname` binding of the URL it destructures), so a renamed minifier
// output still matches. Only the loopback *membership* test in the http branch
// is spliced, so a schema that does not allow http at all still refuses it and
// nothing about the https branch changes. Always applied: the endpoint is a
// Gateway deployment's, whether it is managed or writable.
//
// Deliberately not in `required`, unlike the card removal and the pane patches.
// Those are required because failing to apply them degrades silently — the card
// quietly returns, the pane quietly goes blank. This one fails loudly: an
// unpatched schema refuses the deployment's URL and the gateway stops answering,
// in the same place an operator is already looking.
const gatewayLoopbackHttpPatchId = "gateway-url-any-host-http";
const gatewayLoopbackHttpMessage = "must use https (or http on loopback)";
// The native file preview draws into an Electron view over Desktop's own window,
// which the browser never composites, so an Office or PDF file showed a blank
// pane. This patch swaps the preview component's rendered children for an
// <iframe> at the bridge's own preview route (`/api/remote/files/preview`), which
// serves the file as a PDF — Office converted by the office-preview sidecar, PDF
// passed through. It fires only for those extensions; every other file keeps the
// component's original output. The component is pinned by the one className its
// container renders, which appears nowhere else in the renderer graph.
const filePreviewPatchId = "native-file-preview-bridge";
const filePreviewStaticClassName = "h-full w-full relative overflow-hidden";
// A browser-identified renderer resolves its internal code route to claude.ai's
// cloud Code — which the org reports admin-disabled, so every Code route lands on
// `/code/disabled` — while the Desktop identity resolves the same route to the
// local Code surface this bridge drives over the Desktop IPC. The web shell drops
// the Desktop user-agent token on purpose (to get the browser chrome), and that
// same predicate also flips this alias. This patch forces the resolver's desktop
// branch so the local Code stays reachable. Spliced only in web-shell mode: on a
// desktop-identified client the flag is already true, so there it does nothing.
const routeAliasPatchId = "desktop-code-route-alias";
// The chat/cowork session layout refuses to open a *local* session unless the
// client identifies as the Desktop app: when its user-agent check is false it
// redirects away (reason "not_desktop_app") and renders a download upsell in the
// session's place. The web shell drops the Desktop user-agent token on purpose to
// get the browser chrome, so the check is false and every session bounced back to
// the home composer. This patch forces that check — the identifier read back from
// the `if(!x){…"not_desktop_app"…}` guard itself, so it survives renaming — to
// true, which is exactly how the layout already behaves on a desktop-identified
// client. Spliced only in web-shell mode.
const sessionViewerPatchId = "desktop-session-viewer-gate";
const sessionViewerReason = "not_desktop_app";
// Session placement. The renderer places new sessions remotely — claude.ai's
// cloud Cowork — whenever it does not believe it runs as the Desktop app: its
// placement helper first evaluates the platform check that requires the
// `Claude/<version>` user-agent token (the preload's `claudeAppBindings` is
// present, the token is not, because dropping it is what selects the browser
// chrome). A remote placement makes the composer prime a cloud session with
// POST /api/organizations/<org>/cowork/sessions — an endpoint only claude.ai
// serves, so this bridge answers 404, and a new chat with manual approvals
// dies on that response. The web shell is the local client here — the bridge
// backs every session over the Desktop IPC — so the placement must take the
// branch a desktop-identified client takes, where the account's own
// `dramatic_shrimp_enabled` setting (declared false by the bridge's account
// policy) decides between remote and local. The helper is pinned by its two
// shrimp literals and its account-settings reads; the splice forces the
// platform check that opens that branch — the zero-argument call in the
// declarator directly following the one reading the shrimp gate. Spliced only
// in web-shell mode, like the other chrome patches.
const localSessionPlacementPatchId = "web-local-session-placement";
// The web New page's "home" layout — the compact greeting, the composer's
// controls docked below the card, the below-fold feed — is chosen by an
// assignment the Desktop build compiles out. The chunk that reads the
// `__gb__1085985672` gate returns its assignment object with `eligible`,
// `settled` and `assignment` hardcoded false, so the renderer always settles on
// the classic home layout however the gate evaluates; the layout components
// themselves ship in this bundle. The browser chrome the web shell exists to
// reproduce includes that layout, so the object is spliced to the all-assigned
// shape the web bundle produces for a visitor in the experiment: eligible,
// settled, assigned, strings delivered (the layout's default messages ship in
// the bundle) and nothing left undelivered. The object is pinned by its own six
// property names — not mangled — and the chunk by the gate literal it reads,
// each exactly once, so any other count refuses rather than splice the wrong
// object. Spliced only in web-shell mode, and deliberately not required: a
// bundle that no longer matches leaves the classic home layout rather than
// failing renderer preparation.
const homeLayoutPatchId = "web-new-page-home-layout";
const homeLayoutGate = "__gb__1085985672";
const homeLayoutKeys = ["eligible", "settled", "assignment", "stringsDelivered",
  "stringsVouched", "stringsUndelivered"];
const homeLayoutReplacement = "{eligible:!0,settled:!0,assignment:!0,"
  + "stringsDelivered:!0,stringsVouched:!0,stringsUndelivered:!1}";
// The unified-composer ("marlin") design is an experiment arm, and the renderer
// decides it from that GrowthBook feature by name. The bridge grants the feature
// in every bootstrap it serves, but the renderer's own read can still answer
// "off" for reasons the bridge cannot see: the arm it remembers on the device
// wins whenever the feature is not in the table the client built, the first read
// is frozen for the life of the page, and a feature table persisted from before
// the grant can answer in place of the fresh one. The layout above is gated on
// this arm (the renderer forces the classic layout whenever it is off), so an
// "off" read silently reverts the whole New page. In web-shell mode the
// deployment has already made the choice — the bridge grants the feature — so
// each predicate's own flag operand is forced true, leaving the side-panel guard
// they end with in place. Spliced only in web-shell mode, and deliberately not
// required: a bundle that no longer matches leaves the arm to the flag.
const composerDesignPatchId = "web-composer-design-forced";
const composerDesignFeature = "voyage_composer_marlin";
// Two decisions downstream of that arm, forced for the same reason. The layout
// hook settles on a variant it derives from the gate eligibility, and the
// composer host derives the route's surface kind from the same eligibility; both
// are the deployed choice here, and both were observed settling on the classic
// answer while the arm itself read on. Each is one expression, pinned by its own
// shape rather than by names — the variant object is the one whose `variant` is
// computed rather than a literal (`variant: "none"` is the composer's unrelated
// default), and the surface kind is the only place the three route names appear
// together. Spliced only in web-shell mode, neither required.
const homeVariantPatchId = "web-new-page-home-variant";
const homeVariantReplacement = '"home"';
const homeArrangementPatchId = "web-home-composer-arrangement";
const homeArrangementReplacement = '"outside"';
// "Projects" — the `/projects` and `/project/<id>` routes, and the composer's
// project slot — is decided by one predicate: the GrowthBook feature
// `claude_ai_projects_limits` (its `max_free_projects` field), the plan
// capabilities `claude_pro` / `claude_max` / `raven`, or all three. On claude.ai
// that predicate is live, and the free plan reaches projects through the
// feature's own field. The Desktop build compiles it out: the function still
// calls the three capability readers and the feature reader, but its value is a
// module constant that is never assigned anywhere in the bundle, so it answers
// false however the feature would evaluate and the route guard redirects every
// projects route while the composer renders no project slot. The web shell is
// meant to be claude.ai here, so the predicate's body is rebuilt as the
// disjunction claude.ai ships: the same four reads, in the same order (the
// reads are hooks, so hoisting them into declarators — rather than
// short-circuiting them behind the first truthy one — keeps hook order fixed),
// compared exactly as the bundle's own sibling limit helper already compares
// them (`> 0`). The function is pinned by the feature name and field literals it
// reads, which the bundle spells only there, plus its comma-sequence shape, and
// the whole body is replaced only when exactly one such function is in the
// chunk. Spliced only in web-shell mode, and deliberately not required: a
// bundle that no longer matches leaves projects off rather than failing
// renderer preparation.
const projectsAllowedPatchId = "web-projects-allowed";
const projectsLimitsFeature = "claude_ai_projects_limits";
const projectsLimitsField = "max_free_projects";
// The sidebar's own "Projects" entry. Both builds filter their nav items through
// one negated `||` chain — a mode mismatch, a per-item eligibility call, and two
// clauses about the entry itself — and every clause about the entry is false on
// claude.ai while being true here. One is Desktop-only (`… && surface === "chat"
// && !isChatIn3pSupported`, whose operand is a module constant read once from
// `globalThis.desktopBootFeatures`, the Desktop main process's app-feature table
// that a browser page never has), and the other is in both builds but reads a
// value the Desktop build compiles to a constant (`… && !noProjectScope && !flag`,
// whose second operand the web bundle evaluates `flag || !inNestedFrame` — true
// for any top-level page, which is what this shell is). Rather than reconstruct
// either value, the clauses that name the entry are dropped from the chain: the
// `!` node is spliced to a negation of the same chain with every operand that
// tests `id === "projects"` removed. The chain is pinned by the two literals its
// project clauses compare against — "projects" and "chat", which appear together
// in one conjunction nowhere else in the renderer graph — and only its project
// operands are dropped, so the mode and eligibility filters still apply. Spliced
// only in web-shell mode, and not required: a bundle that no longer matches
// leaves the entry hidden rather than failing renderer preparation.
const projectsNavPatchId = "web-projects-sidebar-entry";
// The composer's project slot — the chip that takes the left seat of the row the
// model and permission pickers share. One function answers it: the chain that
// ends `… ? "disabled" : … ? "pending" : … ? "projects" : "enabled"`, where the
// last two are the shapes that render a slot. Its operands are the projects
// predicate the `web-projects-allowed` patch restores, the caller's own
// `unifiedComposerDesign` — which is the unified-composer arm's predicate, and
// so is already forced by the design-predicate patch — and a store holding the
// pending first send. That store is null until a send is actually being
// prepared, so on a New page, before the user has typed anything, the answer
// short-circuits to "disabled" and no slot is rendered. claude.ai renders one
// there, so the deployed answer is forced, exactly as the layout variant and the
// route surface kind are: only the returned expression is spliced, leaving the
// declarators above it in place, because they are where the feature reads and
// the surface hook calls happen and removing them would change hook order. The
// function is pinned by the four mode literals it answers with, which appear
// together nowhere else in the renderer graph. Spliced only in web-shell mode,
// and not required: a bundle that no longer matches leaves the slot unrendered
// rather than failing renderer preparation.
const projectsComposerPatchId = "web-projects-composer-slot";
const projectsComposerMode = '"enabled"';
const projectsComposerModes = ["disabled", "pending", "projects", "enabled"];
// The unified composer picks its chin in one `if (position === "unified")` block,
// and the branch that draws the project chip is the second one:
//
//   if (collapsed) return <Chin open={false}/>;            // empty, no chip
//   if (kind === "chat" && firstSend !== null && h) return <xP/>;   // the chip
//   if (kind === "chat" && shaped) return <SP/>;           // a different chin
//
// That branch never runs here. It needs the same pending-first-send store the
// slot predicate above reads, plus a second surface value, and both are states a
// browser page does not reach on a New page. The predicate patch cannot help,
// because nothing calls it at all: the chin is drawn with an empty leading seat,
// which is exactly what the temporary probe reported (`chin=yes`, an empty
// collapsing wrapper, `slot=no`).
//
// The whole test is forced rather than just its store operand. Keeping the
// branch's own `kind === "chat"` operand is the narrower splice, and it is the
// one that was tried first — the page did not change, and from the DOM alone the
// two readings of that cannot be separated: the branch is never reached, or this
// shell reports a surface kind that is not `"chat"`. Forcing the test open
// settles the first reading outright and is correct under the second; the only
// cost of being wrong about it is a cowork chin drawn as a chat one. It is the
// same "deployed answer, spliced at the consumer" the rest of this family uses,
// and the block is pinned by the `"unified"` literal its own guard tests, so no
// other conditional in the graph can match. Spliced only in web-shell mode, and
// not required.
const projectsChinPatchId = "web-projects-composer-chin";
const projectsChinForced = "!0";
// The folder/project picker the chip is made of. Once the chin and the slot
// wrapper render, the wrapper still comes out empty, because the picker itself
// refuses to draw:
//
//   { isClaudeApp: n, userDataPending: r, … webPickerEnabled: l,
//     webPickerPending: e && !n && !l && RN, … }
//   function BN(e, t) { return e.isClaudeApp ? !1 : (!e.webPickerEnabled
//     && !e.webPickerPending) || t }
//   …
//   if (BN(H, projectLocked)) return null;
//
// `isClaudeApp` is the same zero-argument platform check the session-viewer and
// session-placement patches force: it asks whether this is the Claude app, and
// the web shell answers no because it drops the Desktop user-agent token to get
// the browser chrome. On the real app the picker renders and opens the *native*
// folder dialog; here it renders nothing, and the alternative it falls back to
// needs a web picker this deployment does not have.
//
// Forcing the flag true in this one object is the same local override the other
// two patches make, and it selects the path this deployment actually supports:
// the native dialog is intercepted by the wrapper and answered by the in-page
// picker. Only that one property's value is spliced — its binding stays, because
// `webPickerPending` in the same object still reads it, and the declarator is
// where the platform read happens. The object is pinned by carrying both
// `isClaudeApp` and `webPickerEnabled`, which together appear there only.
// Spliced only in web-shell mode, and not required.
const projectsPickerPatchId = "web-projects-folder-picker";
// The two properties of that object, and the value each takes in the web bundle.
// `isClaudeApp` is forced so the picker's own gate cannot answer null whatever
// the scope does — on claude.ai the same gate is satisfied by `webPickerEnabled`
// instead, which this shell cannot reach because it needs a remote-projects
// capability the bridge does not report. `noBackend` is a constant the Desktop
// build folds to `!0` and the web bundle ships as `!1`; it switches the
// component's whole return between the trigger it draws the chip with and a
// wrapper that draws nothing here.
const projectsPickerForced = new Map([
  ["isClaudeApp", "!0"],
  ["noBackend", "!1"],
]);
// The composer's project selector — the component the slot wrapper above wraps —
// bails on its own scope guard before it ever reaches the picker:
//
//   let {projectScopeLocked: c, …} = composerContext(), m = isClaudeApp();
//   …
//   return c && !m ? null : <ProjectSelector …/>;
//
// On claude.ai that guard is false because nothing scopes the composer, and the
// selector draws. Forcing it off is correct whenever the composer is being used
// to *choose* a project rather than to show one it is locked to, which is what
// this shell's New page is. The component is pinned by its own destructured prop
// names — `selectionChip` and `plainTrigger`, which the minifier does not touch —
// and by returning `null` from a conditional, so no other component can match.
// Spliced only in web-shell mode, and not required.
const projectsSelectorPatchId = "web-projects-selector-scope";
const projectsSelectorOff = "!1";
// The slot component's *first* branch. It draws the same element with the same
// class as the branch that draws the selector, but its content is a different
// component: the one for a project the composer is already bound to, which reads
// that project's device binding and answers null until it resolves. When the New
// page carries a default project, this branch is taken and the slot comes out as
// the same empty div the selector's own refusals produce — indistinguishable in
// the DOM from either of them, and one branch earlier than both. Forcing the
// test off routes the slot to the selector, which is what a composer that is
// *choosing* a project should draw. Identified as the function whose returned
// conditional contains two `data-home-project-slot` elements, which is what
// separates it from the sibling component that draws one. Spliced only in
// web-shell mode, and not required.
const projectsBoundSlotPatchId = "web-projects-bound-slot";
// The last gate, and the one that actually decides whether anything is drawn.
// The picker's trigger component ends:
//
//   we = showProjects ?? (onCreateProject !== undefined)
//   Te = !hideFolders && onBrowse !== undefined && !!browseConfig?.browseFolder
//   Ee = chatProjects.length || !!defaultTarget || (we && pinned.length)
//        || recents.length || more.length || we || locked || loading
//   …
//   return Ee ? <trigger/> : Te ? <browse/> : null;
//
// Every term but `we`, `locked` and `loading` is project/folder *data* — targets
// the user has actually used, or the projects on the server — and a deployment
// whose accounts have none is left with the two flags. `we` is `showProjects`,
// which the picker is handed from above and which is false here; forcing it true
// is what "show projects in the composer" means, and it is the deployment's
// choice to make. `locked` and `loading` are states, not choices. The property
// is pinned as `showProjects` inside an object literal — the destructuring of
// the same name is a pattern, not an expression, so it cannot match. Spliced
// only in web-shell mode, and not required.
const projectsPickerSectionPatchId = "web-projects-picker-section";
const projectsPickerSectionOn = "!0";
// The permission picker's own binding, which is the same missing store once
// more. The composer picks that control's content from a hook:
//
//   let s = permissionBinding();
//   s === undefined
//     ? (arms ? <iconOnly/> : <PermissionSkeleton/>)
//     : <PermissionPicker binding={s}/>;
//
// and the hook answers only while the pending-first-send store exists:
//
//   let e = pendingFirstSend(), t = e?.newChatAutoArms, …;
//   return memo(() => {
//     if (e !== null && t === true) return { permissionMode: …, … };
//   }, […]);
//
// With that store null — a New page before anything has been typed, in this
// shell as in any other — the hook returns nothing and the slot draws its
// skeleton forever. The guard is forced open rather than the store faked: the
// value it returns is computed from the pending draft's own settings and the
// default mode helper, and none of those branches read the store, so the picker
// is handed the same binding it would have had one render later. The guard is
// identified by the object it returns, which carries `autoPickIsDraftOnly` —
// a name that appears nowhere else in the renderer graph. Spliced only in
// web-shell mode, and not required.
const permissionBindingPatchId = "web-permission-binding";
const permissionBindingOn = "!0";
// The session-scoped permission pickers ask for their mode list with
// `excludeBypass: true`, which drops "Skip all approvals" — the row the
// deployment's own settings and its two rollout gates exist to offer. It used to
// be in the control the composer's picker replaced, so the flag is cleared: these
// pickers are scoped to a session, and a session can hold that mode.
//
// Pinned as the `excludeBypass` property of an object that also carries
// `sessionBinding` — that pair is what marks a session picker, as opposed to the
// callers of the same component that pass `excludeBypass` without a binding. Two
// sites match, deliberately: the composer's picker and the one the session
// surface draws. Both are session-scoped, so both get the row back; scoping the
// splice to the composer alone would mean keying it on a prop (`placement`,
// `triggerSize`) that says nothing about the reason and would silently stop
// matching the day it moved.
const permissionBypassPatchId = "web-permission-bypass-row";
const permissionBypassOff = "!1";
// Making that row clickable was not enough: the New page's picker sets the
// *pending draft's* permission mode, and that pair of mappers knows two modes:
//
//   const aM = "auto", oM = "acceptEdits";
//   function toWire(mode){ if (mode === "auto") return aM; if (mode === defaultMode()) return oM; }
//   function fromWire(value){ if (value === "auto") return "auto"; if (value === "acceptEdits") return defaultMode(); }
//
// The wire vocabulary *is* the mode ids — "auto" and "acceptEdits" are stored
// verbatim, `acceptEdits` being the id of the mode the picker labels "Manual" —
// so `bypassPermissions` carries through the same way, and both maps are widened
// to it. Widening the writer alone would leave the row unclicked: the reader
// turns the stored value back into the mode the picker checks, and an unmapped
// value reads as the default. Each mapper is identified as the one-argument
// function that opens by testing its argument against `"auto"` and then either
// against a call (the writer) or against `"acceptEdits"` (the reader), so no
// other function in the graph can match. Spliced only in web-shell mode, and not
// required.
const draftBypassPatchId = "web-draft-bypass-mode";
const draftBypassWire = '"bypassPermissions"';
// The web shell's bottom-left account chip leads with an avatar slot, but in this
// build that component still reads the account view and then renders the
// deployment mark, discarding the `src` it just read: with a configured
// avatar_image_url the chip never sets an image source, so no request is made and
// the Claude mark stays. In this build the chip takes extra placement props and
// answers through a comma sequence, so the target is the component whose
// destructured props include `size` and `organization`, whose body binds the
// account view (`{name, src}` from a zero-argument hook call — an object literal
// that merely carries a `src` property is not a binding), and whose returned last
// expression renders a call without `src`. This patch makes the slot an account
// avatar when a photo is present — the account Avatar component and its element
// factory are read back from the sibling component that builds the same avatar
// with `src` (the one the user-menu header uses), and the mark remains the
// no-photo fallback. Spliced only in web-shell mode, like the other chrome
// patches.
const accountChipPatchId = "web-account-chip-avatar";
// The account view hook that feeds that slot (and the user-menu header's avatar)
// takes its photo from the account-profile query alone — in this build the view's
// `src` is the profile read resolved through a helper call — while the bootstrap
// account document the same hook already destructures for the name carries the
// very same `avatar_image_url` (the bridge puts it there when it applies the
// operator identity). The profile read is a separate bridge round trip that only
// starts after the bootstrap lands, so the chip painted the deployment mark for
// as long as that read took and only then began the image request. This patch
// makes `src` fall back to the in-hand account value, so the avatar paints on the
// hook's first non-empty frame and the image download runs alongside the profile
// read; the profile value still wins once it arrives. Spliced only in web-shell
// mode, like the other chrome patches.
const accountPhotoPatchId = "web-account-photo-first-frame";
// Cowork tool permissions — the AskUserQuestion and tool-approval cards — are
// fed by the app's pending-permission store, and the only thing that wires that
// store (subscribes to the session event stream and hydrates from
// `getAll().pendingToolPermissions`) is a hook called inside the Desktop app's
// root. The app tree mounts the Desktop-only side-effect hosts — account sync,
// the permission wiring, the Cowork ask pump — through one slot component that
// renders them only when the client identifies as the Desktop app and null
// otherwise. The web shell drops the Desktop user-agent token on purpose (to get
// the browser chrome), so the store is never wired there: the transcript still
// streams ("Asking a question…"), but no question or approval card ever appears
// and the session waits forever. This patch calls the wiring hook from the slot
// component itself — unconditionally, before the identity gate — so the store
// subscribes and hydrates in either shell. The hook is ref-counted and its
// requests are keyed by request id, so the Desktop root's own call (and the
// duplicate events it already receives) are unaffected. The hook's call is read
// back from the Desktop root's body as the first element of the comma sequence
// that also carries the locale-change effect; both the hook and the API binding
// are read back, so a renamed minifier output still matches. Spliced only in
// web-shell mode.
const coworkPermissionWiringPatchId = "web-cowork-permission-wiring";
// Cowork scheduled tasks ("routines"). The feature is reachable in the web shell
// — the bridge allows the task collection and the preload relays the Desktop
// main process's `onOnScheduledTaskEvent` — but every part of it that identifies
// the Desktop runtime is false there, so a task could be created and then never
// run. Two independent gates have to be forced, both keyed off the same platform
// check the chrome patches avoid touching globally.
//
// The runner. `runScheduledCoworkTask` opens with the same zero-argument
// platform check and aborts the whole run when it is false, answering
// "Local scheduled tasks can only run in the Claude desktop app" — which the
// Routines list reports through its generic run failure, with no IPC call ever
// made. The check is read back from its own guard: the `flag || refuse(id, …,
// "…desktop app")` short-circuit, whose third argument is the copy only this
// runner carries. The flag is then resolved to the zero-argument call its
// declaring scope initialises it from, exactly like the session-layout gate, so
// a renamed minifier output still matches. Forced true, which is what the
// runner already is on a desktop-identified client. Spliced only in web-shell
// mode.
const scheduledTaskRunnerPatchId = "web-scheduled-task-runner";
const scheduledTaskRunRefusal = "Local scheduled tasks can only run in the Claude desktop app";
// The hosts the runner and the dispatcher depend on. Firing a local task is the
// Desktop main process's job, but it only checks due tasks once a renderer has
// declared itself ready (`markListenerReady`), and the renderer that starts the
// session is the one whose hook subscribes to `onOnScheduledTaskEvent`. Both the
// starter host — which publishes the session starter the runner waits on — and
// that listener host are mounted from the Desktop-checks slot, behind the slot's
// identity gate, so in the web shell neither is ever rendered: the scheduler
// defers on every check and a run that gets past the gate above still fails
// waiting for a starter nobody published. This patch mounts exactly those two
// hosts from the slot's own absent-identity branch, so a desktop-identified
// client keeps its own mount and nothing is rendered twice. Both hosts are read
// back from the graph by behaviour — the starter host is the declarator whose
// body writes `startSession` through `setState`, the listener host is the
// component that only calls the hook using `onOnScheduledTaskEvent` and
// `markListenerReady` — and the wrapper element, its props and the element
// factory are reused from the slot itself, so a renamed minifier output still
// matches. Spliced only in web-shell mode.
const scheduledTaskHostsPatchId = "web-scheduled-task-hosts";
const desktopChecksLabel = "DesktopChecks";
// The web shell's "enable notifications" actions — the chat card and the
// settings panel's rows — grant the browser permission and then register with
// claude.ai's Firebase Cloud Messaging project, persisting a server-side push
// preference on the way. Neither half can work against this deployment: there
// is no claude.ai backend to hold the preference, and the Firebase registration
// has no project to land in, so the action always failed and the toggles never
// stuck. This bridge delivers notifications itself (the wrapper relays the
// Desktop main process's notifications, the preload shows them and registers a
// Web Push subscription — see bridge/notifications.mjs). The patch gives the
// renderer's enable function a bridge-first branch: when the remote preload's
// `DesktopNotifications` surface exists, asking it for the browser permission
// is the whole operation and the preference write that follows now succeeds
// against the bridge's local document. The function is matched by the exact
// analytics key it tracks, the `browser_or_permissions` result it returns, and
// the `Notification.requestPermission` call it guards, so an unrelated function
// cannot match. Spliced only in web-shell mode, like the other chrome patches.
const notificationEnablePatchId = "web-notifications-enable-bridge";
const notificationPermissionEventKey = "claudeai.notification.permission.result";
const notificationPermissionDeniedSource = "browser_or_permissions";
const notificationEnableBranch = "{const __claudeskNotifications="
  + "globalThis[\"claude.web\"]?.DesktopNotifications;"
  + "if(__claudeskNotifications?.requestAuthorization){"
  + "const __claudeskRequest=arguments[0]||{};"
  + "let __claudeskResult=\"error\";"
  + "try{__claudeskResult=await __claudeskNotifications.requestAuthorization()}catch{}"
  + "const __claudeskPermission=__claudeskResult===\"denied\"?\"denied\":"
  + "__claudeskResult===\"granted\"?\"granted\":\"default\";"
  + "try{__claudeskRequest.track&&__claudeskRequest.track("
  + "{event_key:\"claudeai.notification.permission.result\",permission:__claudeskPermission})}catch{}"
  + "if(__claudeskResult===\"granted\")return{success:!0,permission:\"granted\"};"
  + "return{success:!1,errorSource:\"browser_or_permissions\",permission:__claudeskPermission}}}";
// The account popover's identity line. The popover's content mounts when the
// menu opens, and its title is read from Desktop's interactiveAuthStore through
// a hook that paints a loading state first and only fills from an async
// getState() — in the web shell a POST to the bridge and on to Desktop IPC, so
// the first painted frame showed the deployment label (the hook's fallback
// branch) and flipped to the account name a frame later. The preload already
// seeds the same store synchronously at page load (initialStores ->
// makeStore.getStateSync; see initialRemoteStores in bridge/server.mjs), so the
// splice reads that seeded snapshot while the async value is still missing. The
// reader is pinned by its whole shape — a function whose body is a single return
// of a zero-argument call's `principalDisplayName` — and that property name
// appears nowhere else in the renderer graph. Spliced only in web-shell mode,
// like the other chrome patches.
const accountMenuNamePatchId = "web-account-menu-name";
const accountNameSyncFallback = 'globalThis["claude.web"]?.LocalAgentModeSessions'
  + '?.interactiveAuthStore?.getStateSync?.()?.principalDisplayName';
// The user menu's "Sign out" item. The app renders it only when its login-status
// seam reports a login: the menu's flags object sets `signOut` from
// `!!loginDesktop3pStatus`, and that status comes from the bootstrap's own
// `login` — written by the *writable* 3P configuration — or, absent that, the
// `Custom3pSetup.getLoginDesktop3pStatus` IPC, which the bridge serves only when
// the writable Gateway library is enabled. A managed account has neither, so it
// gets no row at all and the preload has had to clone one from a neighbouring
// item — which never carries the menu's own icon or hover styling. The
// deployment's auth service is what holds an account's session, and the preload
// replaces the row's click wherever it appears, so only the row has to exist:
// force the flag true and the app renders its own item (`icon` "Logout", native
// hover, focus ring and keyboard handling), which the preload intercepts.
//
// Applied unconditionally, not only where the seam is filled: the environment
// variable that fills it has gone missing on a live deployment before, and a row
// that is present but runs the app's own handler is the safer failure — the
// preload leaves that handler alone on a deployment with no auth service, where
// it is the correct behaviour anyway. Required, unlike the mode picker: a bundle
// that no longer matches degrades silently, removing Sign out entirely.
const accountSignOutPatchId = "account-sign-out-row";
// The titlebar's compact mode switcher — the "Claude"/"Code" pills at the top
// right of the navbar. Its only job is to move between the home surface and the
// Code surface, so a deployment with Code turned off (the managed default)
// renders the Code segment disabled and the whole control is a dead switch. The
// component is pinned by the `data-compact-mode-switcher` label it sets on the
// element it renders, which appears nowhere else in the renderer graph, and the
// segments array is read back from the switcher call those props wrap. The
// splice replaces that element with `null` whenever the array carries a disabled
// segment — exactly the shape the Code-off state produces — leaving its siblings
// (the discovery popover) and the rest of the titlebar untouched. Applied in
// either shell, independent of the Gateway setting; a deployment that enables
// Code keeps the picker, because then no segment is disabled. Deliberately not
// in `required`: a bundle that no longer matches leaves the picker in place,
// which is visible rather than silent, so it must not block candidate
// preparation the way the download and preview patches do.
const modePickerPatchId = "titlebar-mode-picker-without-code";
const modePickerMarker = "data-compact-mode-switcher";
// The app's own toast, published for the remote preload. The bridge warns
// connected pages when the VM is about to restart (its SIGTERM handler), but the
// renderer's toast is not reachable from outside React: the manager lives in a
// context only its own components read. So the manager is published on a global
// from a component that is mounted whenever toasts are shown at all, and the
// bridge's `notice` over SSE becomes the app's real toast — its styling, its
// stack position, its dismiss affordance — rather than a bespoke banner. The
// manager's `add` takes the app's own options (title, description, variant,
// action, timeout) and the preload passes timeout 0 (sticky) so the message
// outlives the outage it is about.
//
// The publish goes in the **viewport** — the component that renders the element
// carrying `data-cds: "Toast"`, which the toast provider mounts itself, in the
// chunk that defines the app's toast. That is the anchor precisely because it is
// the one that can be observed: an earlier cut published from the card host the
// provider renders *beside* the viewport, and on a live web-shell deployment the
// viewport was in the DOM while the global was never set — so the anchor has to
// be the component whose output is actually present, not its sibling.
//
// Read back from the graph, never hardcoded: the viewport is identified by that
// marker property, and the manager by shape — a parameterless declaration whose
// body opens by binding two zero-argument calls and closes by returning an object
// carrying `add` and `close` — which is the app's toast hook, in scope beside the
// viewport because both live in the same chunk. The publish is spliced after the
// viewport's own opening declaration (the bindings are `let`, so the top of the
// body would hit the temporal dead zone) and calls the hook unconditionally, so
// hook order is stable across renders. Spliced only in web-shell mode, and
// required there: the restart notice is the point, and a bundle that no longer
// matches must fail preparation rather than warn nobody.
const toastGlobalPatchId = "toast-global";
const toastGlobalName = "__CLAUDESK_TOAST__";
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const unwrap = node => node?.type === "ChainExpression" ? unwrap(node.expression) : node;
// A minified component body may answer through a comma sequence
// (`a?.has_icon,U(gateId,!1),render(...)`); the rendered expression is its last
// element.
function renderedExpression(node) {
  return node?.type === "SequenceExpression" && node.expressions.length
    ? renderedExpression(node.expressions.at(-1)) : node;
}
function property(node, name) {
  node = unwrap(node);
  return node?.type === "MemberExpression"
    && (node.computed ? node.property.type === "Literal" && node.property.value === name
      : node.property.type === "Identifier" && node.property.name === name);
}
function protocol(node) {
  node = unwrap(node);
  return property(node, "protocol") && property(node.object, "location")
    && unwrap(node.object.object)?.type === "Identifier" && node.object.object.name === "window";
}
function literal(node, value) { return node?.type === "Literal" && node.value === value; }
function identifier(node) { node = unwrap(node); return node?.type === "Identifier" ? node.name : undefined; }
function key(node, name) {
  return node?.type === "Property" && (node.key.name === name || node.key.value === name);
}
function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, next, visit);
    else if (value && typeof value === "object") walk(value, next, visit);
  }
}
function contains(node, predicate) {
  let found = false;
  walk(node, [], child => { if (predicate(child)) found = true; });
  return found;
}
function redirectsToNew(node) {
  return contains(node, child => child.type === "CallExpression"
    && property(child.callee, "replace") && literal(child.arguments[0], "/new"));
}
function checksWindow(node) {
  return contains(node, child => child.type === "UnaryExpression" && child.operator === "typeof"
    && child.argument.type === "Identifier" && child.argument.name === "window");
}
function checksFileKind(node) {
  return contains(node, child => child.type === "BinaryExpression"
    && ["==", "==="].includes(child.operator)
    && (literal(child.left, "file") || literal(child.right, "file")));
}
// The Gateway URL schema: `X.refine(predicate, {message: …})`, where the message
// conditional carries the loopback-http copy above. The predicate is the arrow
// that destructures a URL and returns the protocol test.
function gatewayUrlPredicate(node) {
  if (node.type !== "CallExpression" || !property(node.callee, "refine")) return undefined;
  const options = node.arguments[1];
  if (options?.type !== "ObjectExpression") return undefined;
  const message = options.properties.find(entry => key(entry, "message"));
  if (!message || !contains(message.value,
    child => literal(child, gatewayLoopbackHttpMessage))) return undefined;
  const predicate = unwrap(node.arguments[0]);
  return predicate && functionTypes.has(predicate.type) ? predicate : undefined;
}
// The http branch's loopback test: the single `hostSet.has(hostname)` call, with
// the hostname read back from the object pattern the predicate destructures out
// of `new URL(…)`. Any other count refuses the splice rather than guess which
// call is the membership test.
function loopbackMembershipCheck(predicate) {
  let hostname;
  walk(predicate, [], (child) => {
    if (child.type !== "VariableDeclarator" || child.id?.type !== "ObjectPattern") return;
    const entry = child.id.properties.find(member => key(member, "hostname")
      && member.value?.type === "Identifier");
    if (entry) hostname = entry.value.name;
  });
  if (!hostname) return undefined;
  const calls = [];
  walk(predicate, [], (child) => {
    if (child.type !== "CallExpression" || !property(child.callee, "has")) return;
    if (child.arguments.length !== 1 || identifier(child.arguments[0]) !== hostname) return;
    calls.push(child);
  });
  return calls.length === 1 ? calls[0] : undefined;
}
// The route-alias resolver guards each rule with
// `!(X.when==="desktop"&&!Y)`, where Y is the `isDesktop` flag it was called
// with. Read that identifier back from the same graph so the splice names
// whatever the minifier chose; only a function carrying that exact rule matches,
// so a stray `when` comparison cannot establish the target.
function desktopRouteFlagName(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return undefined;
  let name;
  walk(node.body, [], child => {
    if (name || child.type !== "LogicalExpression" || child.operator !== "&&") return;
    const left = unwrap(child.left);
    if (left?.type !== "BinaryExpression" || left.operator !== "===") return;
    if (!property(left.left, "when") || !literal(left.right, "desktop")) return;
    const right = unwrap(child.right);
    if (right?.type !== "UnaryExpression" || right.operator !== "!") return;
    const flag = identifier(right.argument);
    if (flag) name = flag;
  });
  return name;
}
// The push-enablement function (`kK` in the shared chunk) is the one async
// declaration that guards `Notification.requestPermission()`, tracks the
// permission result under its own analytics key, and answers failures with
// `browser_or_permissions`. All three must sit inside the same function body, so
// a helper that merely spells one of the literals cannot establish the target.
// It must be a (non-arrow) declaration: the spliced branch reads the request
// object back from `arguments[0]` instead of naming the minified binding.
function notificationEnableTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.async !== true
    || node.body?.type !== "BlockStatement") return undefined;
  let requestsPermission = false;
  let tracksResult = false;
  let deniedSource = false;
  walk(node.body, [], child => {
    if (child.type === "CallExpression") {
      const callee = unwrap(child.callee);
      if (callee?.type === "MemberExpression" && property(callee, "requestPermission")
        && identifier(callee.object) === "Notification") requestsPermission = true;
    }
    if (literal(child, notificationPermissionEventKey)) tracksResult = true;
    if (literal(child, notificationPermissionDeniedSource)) deniedSource = true;
  });
  return requestsPermission && tracksResult && deniedSource ? node : undefined;
}
// The toast viewport: the component that renders the element carrying the app's
// own `data-cds: "Toast"` marker. The provider mounts it itself whenever toasts
// are shown at all, so it is the component whose rendering can be observed from
// outside — which is what makes it the right place to publish from.
function toastViewportComponent(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  const renders = contains(node.body, (child) => child.type === "Property"
    && (child.key?.name === "data-cds" || child.key?.value === "data-cds")
    && literal(child.value, "Toast"));
  return renders ? node : undefined;
}
// The app's toast hook, read back by shape: a parameterless declaration whose
// body opens by binding two calls — the toast store and the app's toast context,
// the second of which takes that context as its argument — and closes by
// returning an object carrying `add` and `close`. It lives in the same chunk as
// the viewport, so the spliced call can name it.
function toastManagerHook(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || !node.id || node.params.length) return;
    const body = node.body?.body;
    if (!Array.isArray(body) || body.length < 2) return;
    const opening = body[0];
    if (opening.type !== "VariableDeclaration" || opening.declarations.length !== 2) return;
    if (!opening.declarations.every((entry) => unwrap(entry.init)?.type === "CallExpression")) return;
    const returned = body[body.length - 1];
    if (returned.type !== "ReturnStatement") return;
    const object = unwrap(returned.argument);
    if (object?.type !== "ObjectExpression") return;
    const names = object.properties.map((entry) => entry.key?.name ?? entry.key?.value);
    if (!names.includes("add") || !names.includes("close")) return;
    found.push(node.id.name);
  });
  return found.length === 1 ? found[0] : undefined;
}
// The compact mode switcher's rendered element: the sole call whose props carry
// the `data-compact-mode-switcher` label, wrapping a switcher call whose props
// name the segments array. Only parsed props establish it, so a string or
// comment that merely spells the label is not a target; a marker whose children
// are not the switcher call, or a switcher call with no `segments` binding,
// refuses rather than splice over the wrong element. The array's name is read
// back from the same graph, so a renamed minifier output still matches.
function modePickerTarget(node) {
  if (node.type !== "CallExpression") return undefined;
  const props = node.arguments.map(unwrap).find(argument => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  if (!props.properties.some(entry => key(entry, modePickerMarker))) return undefined;
  const children = props.properties.find(entry => key(entry, "children"));
  const switcher = unwrap(children?.value);
  if (switcher?.type !== "CallExpression") return undefined;
  const switcherProps = switcher.arguments.map(unwrap)
    .find(argument => argument?.type === "ObjectExpression");
  const segments = switcherProps?.properties.find(entry => key(entry, "segments"));
  const name = identifier(segments?.value);
  return name ? { segments: name } : undefined;
}

// The session layout's Desktop gate is `if(!x){ …redirect with reason
// "not_desktop_app"… }`. Read the negated identifier back from that exact guard so
// the splice names whatever the minifier chose. The reason literal must sit inside
// the guard's consequent; the Desktop signing gate's own `if(!t.isDesktopApp)
// return …("not_desktop_app")` has a member-expression test, so `identifier`
// yields nothing there and it is not a target.
function sessionViewerFlagName(node) {
  if (node.type !== "IfStatement") return undefined;
  if (!contains(node.consequent, child => child.type === "CallExpression"
    && literal(child.arguments[0], sessionViewerReason))) return undefined;
  const test = unwrap(node.test);
  if (test?.type !== "UnaryExpression" || test.operator !== "!") return undefined;
  return identifier(test.argument);
}
// The flag is initialised once, by a zero-argument call (the user-agent check) in
// the layout component's own body. Only a direct body declaration is a target, so
// a shadowed name inside a nested closure cannot be spliced.
function flagInitializer(scope, flag) {
  if (scope?.body?.type !== "BlockStatement") return undefined;
  for (const statement of scope.body.body || []) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === flag
        && declarator.init?.type === "CallExpression"
        && declarator.init.arguments.length === 0) return declarator.init;
    }
  }
  return undefined;
}

// The placement helper: one function carrying the force-local shrimp literal
// and reading the account's shrimp settings. Its platform check is the
// zero-argument call in the declarator directly following the declarator whose
// initialiser calls with the shrimp-gate literal; a function without that
// exact sequence refuses rather than splice over the wrong call.
function localSessionPlacementTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  let forceLocal = false;
  let disabledAt = false;
  walk(node.body, [], (child) => {
    if (literal(child, "dramatic_shrimp_force_local")) forceLocal = true;
    if (property(child, "dramatic_shrimp_disabled_at")) disabledAt = true;
  });
  if (!forceLocal || !disabledAt) return undefined;
  let platformCall;
  walk(node.body, [], (child) => {
    if (platformCall || child.type !== "VariableDeclaration") return;
    const declarations = child.declarations;
    for (let index = 0; index < declarations.length - 1; index += 1) {
      const gate = declarations[index].init;
      const platform = declarations[index + 1].init;
      if (gate?.type !== "CallExpression" || gate.arguments.length !== 1) continue;
      if (!literal(gate.arguments[0], "yukon_silver_dramatic_shrimp")) continue;
      if (platform?.type !== "CallExpression" || platform.arguments.length !== 0) continue;
      if (identifier(platform.callee)) platformCall = platform;
    }
  });
  return platformCall;
}

// The home-layout assignment object: an object literal carrying exactly the six
// property names above, so a differently shaped object that merely shares one of
// them is not a target.
function homeLayoutAssignment(node) {
  if (node.type !== "ObjectExpression"
    || node.properties.length !== homeLayoutKeys.length) return false;
  return node.properties.every(entry => entry.type === "Property" && entry.computed !== true
    && homeLayoutKeys.includes(entry.key.name ?? entry.key.value));
}

// The layout variant where the composer host consumes it: the ternary that
// picks between the component's own `layoutVariant` prop and that prop's default
// — `test ? default : prop` — and every greeting, composer-offset and
// control-seat class is read off its result. Either arm may be either side, so
// nothing depends on which the compiler wrote first, and the targeting is
// structural (a `layoutVariant` prop whose default this ternary names, in the
// same component), so a renamed or inlined minifier output still matches.
function homeLayoutVariantTarget(node, ancestors) {
  if (node.type !== "ConditionalExpression") return false;
  const { consequent, alternate } = node;
  if (consequent?.type !== "Identifier" || alternate?.type !== "Identifier") return false;
  const owner = [...ancestors].reverse().find(parent => functionTypes.has(parent.type));
  if (!owner) return false;
  let found = false;
  walk(owner, [], (child) => {
    if (child.type !== "Property" || (child.key.name ?? child.key.value) !== "layoutVariant") return;
    if (child.value?.type === "AssignmentPattern"
      && child.value.right?.type === "Identifier"
      && (child.value.right.name === consequent.name || child.value.right.name === alternate.name)) {
      found = true;
    }
  });
  return found;
}

// The route surface kind the composer host derives: `… ? "hub" : … ? "outside" :
// "none"`, the only place those three names appear together. Only its "outside"
// arm selects the home composer arrangement, which is what moves the model and
// permission controls out of the card.
function homeSurfaceKindTarget(node) {
  if (node.type !== "ConditionalExpression" || !literal(node.consequent, "hub")) return false;
  const alternate = unwrap(node.alternate);
  if (alternate?.type !== "ConditionalExpression") return false;
  return literal(alternate.consequent, "outside") && literal(alternate.alternate, "none");
}

// The projects-allowed predicate: a function whose whole body returns the comma
// sequence the build compiled its disjunction into — three zero-argument plan
// readers, the limits-feature read, and then the identifier the build folds the
// answer to. Pinned by the feature name and field literals, which the bundle
// spells only here, so an unrelated sequence-shaped function cannot match.
function projectsAllowedTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return false;
  const statements = node.body.body;
  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return false;
  const sequence = unwrap(statements[0].argument);
  if (sequence?.type !== "SequenceExpression" || sequence.expressions.length !== 5) return false;
  if (!sequence.expressions.slice(0, 3).every(expression => expression.type === "CallExpression"
    && expression.arguments.length === 0)) return false;
  const limits = sequence.expressions[3];
  if (limits?.type !== "CallExpression") return false;
  if (!literal(limits.arguments[0], projectsLimitsFeature)) return false;
  if (!literal(limits.arguments[1], projectsLimitsField)) return false;
  return sequence.expressions[4].type === "Identifier";
}

// The predicate's body rebuilt as claude.ai's disjunction. The four reads are
// hoisted into declarators so every one of them runs on every call — they are
// hooks, and leaving them behind `||` would call a prefix of them on some
// renders and all of them on others — and the feature read is compared `> 0`
// exactly as the bundle's own sibling limit helper compares it. Only the body is
// replaced, so the declaration keeps its identity for its other callers.
function projectsAllowedReplacement(source, node) {
  const sequence = unwrap(node.body.body[0].argument);
  const [pro, max, raven, limits] = sequence.expressions;
  const part = (expression) => source.slice(expression.start, expression.end);
  return `{const __claudeskPlanPro=${part(pro)},__claudeskPlanMax=${part(max)},`
    + `__claudeskPlanRaven=${part(raven)},__claudeskFreeProjects=${part(limits)};`
    + "return __claudeskFreeProjects>0||__claudeskPlanPro||__claudeskPlanMax"
    + "||__claudeskPlanRaven}";
}

// Split a chain of same-operator logical expressions into its operands, after
// unwrapping the parentheses the minifier leaves behind nested ones.
function flattenLogical(expression, operator, into = []) {
  const inner = unwrap(expression);
  if (inner?.type === "LogicalExpression" && inner.operator === operator) {
    flattenLogical(inner.left, operator, into);
    flattenLogical(inner.right, operator, into);
  } else if (inner) into.push(inner);
  return into;
}

function comparesTo(expression, value) {
  return expression?.type === "BinaryExpression" && ["===", "=="].includes(expression.operator)
    && (literal(expression.left, value) || literal(expression.right, value));
}

// The nav filter's project clauses: a negated `||` chain holding a clause that
// tests `id === "projects"`. Matching inside the negation, rather than on any one
// clause, is what keeps a clause that merely mentions projects elsewhere in the
// graph out of reach. The surface counterpart is deliberately *not* required —
// it is the clause a future bundle is most likely to drop, and requiring it
// would silently stop the patch from applying at all.
function projectsNavClauseTarget(node) {
  if (node.type !== "UnaryExpression" || node.operator !== "!") return false;
  const chain = unwrap(node.argument);
  if (chain?.type !== "LogicalExpression" || chain.operator !== "||") return false;
  return flattenLogical(chain, "||").some(operand =>
    flattenLogical(operand, "&&").some(term => comparesTo(term, "projects")));
}

// The composer's project-slot answer: a function whose *last* statement returns
// one conditional carrying all four mode literals. Pinned by those literals, so
// no other conditional in the graph can match; the declarators above the return
// are left in place, so neither is the shape required beyond that last statement.
function composerSlotTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return false;
  const statements = node.body.body;
  const last = statements.at(-1);
  if (statements.length < 1 || last.type !== "ReturnStatement") return false;
  const argument = unwrap(last.argument);
  if (argument?.type !== "ConditionalExpression") return false;
  const literals = new Set();
  walk(argument, [], (child) => {
    if (child.type === "Literal" && typeof child.value === "string") literals.add(child.value);
  });
  return projectsComposerModes.every(mode => literals.has(mode));
}

// The unified composer's chin chooser: the `if (position === "unified")` block,
// and within it the branch whose test also asks for the pending-first-send store.
function composerChinBranchTarget(node) {
  if (node.type !== "IfStatement") return false;
  const test = unwrap(node.test);
  if (test?.type !== "BinaryExpression" || !["===", "=="].includes(test.operator)) return false;
  if (!literal(test.left, "unified") && !literal(test.right, "unified")) return false;
  if (node.consequent?.type !== "BlockStatement") return false;
  return composerChinBranch(node) !== undefined;
}

// The branch that draws the project chip: the one in that block that both asks
// for the pending-first-send store and returns an element on its own — a bare
// `return`, not a block, which is how the chooser is written and what separates
// it from the other `"unified"` guard in the renderer graph.
function composerChinBranch(node) {
  if (node.type !== "IfStatement" || node.consequent?.type !== "BlockStatement") return undefined;
  return node.consequent.body.filter(entry => entry.type === "IfStatement"
    && entry.consequent?.type === "ReturnStatement")
    .find(entry => flattenLogical(entry.test, "&&").some(term => term.type === "BinaryExpression"
      && ["!==", "=="].includes(term.operator)
      && (literal(term.left, null) || literal(term.right, null))));
}

// The folder/project picker's capability object: the one carrying both
// `isClaudeApp` and `webPickerEnabled`. Returns the properties of it this module
// forces. Only the property *value* is ever replaced, never its binding, so the
// other fields that still read that binding are unaffected — and a value that is
// already the forced literal is simply spliced to itself.
function projectsPickerTarget(ast) {
  const objects = [];
  walk(ast, [], (node) => {
    if (node.type !== "ObjectExpression") return;
    const names = new Set(node.properties.filter(entry => entry.type === "Property")
      .map(entry => entry.key.name ?? entry.key.value));
    if (names.has("isClaudeApp") && names.has("webPickerEnabled")) objects.push(node);
  });
  if (objects.length !== 1) return undefined;
  return objects[0].properties.filter(entry => entry.type === "Property"
    && projectsPickerForced.has(entry.key.name ?? entry.key.value));
}

// The composer's project selector: the component that destructures both
// `selectionChip` and `plainTrigger` and answers `null` from a conditional —
// its scope guard. Returns that conditional's test, the only thing spliced.
function projectsSelectorTarget(ast) {
  const candidates = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionExpression") return;
    const pattern = node.params?.[0];
    if (pattern?.type !== "ObjectPattern") return;
    const names = new Set(pattern.properties.filter(entry => entry.type === "Property")
      .map(entry => entry.key.name ?? entry.key.value));
    if (!names.has("selectionChip") || !names.has("plainTrigger")) return;
    walk(node.body, [], (child) => {
      if (child.type !== "ConditionalExpression" || !literal(child.consequent, null)) return;
      candidates.push(child.test);
    });
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

// The bound-project branch of the slot component: the test of the conditional
// that returns two `data-home-project-slot` elements. Returns that test, the only
// thing spliced.
function projectsBoundSlotTarget(ast) {
  const tests = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return;
    const last = node.body.body.at(-1);
    if (last?.type !== "ReturnStatement") return;
    const argument = unwrap(last.argument);
    if (argument?.type !== "ConditionalExpression") return;
    let slots = 0;
    walk(argument, [], (child) => {
      if (child.type === "Property" && (child.key.name ?? child.key.value) === "data-home-project-slot") {
        slots += 1;
      }
    });
    if (slots === 2) tests.push(argument.test);
  });
  return tests.length === 1 ? tests[0] : undefined;
}

// The `showProjects` property of the picker trigger's props object. Only an
// object *literal* is considered, so the same name destructured as a pattern
// cannot match, and its value must be a plain binding.
function projectsPickerSectionTarget(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const entry of node.properties) {
      if (entry.type !== "Property" || (entry.key.name ?? entry.key.value) !== "showProjects") continue;
      if (entry.value?.type === "Identifier") found.push(entry.value);
    }
  });
  return found.length === 1 ? found[0] : undefined;
}

// The permission binding hook's guard: the `if` whose body hands back the object
// carrying `autoPickIsDraftOnly`, which appears nowhere else in the graph.
function permissionBindingTarget(ast) {
  const tests = [];
  walk(ast, [], (node) => {
    if (node.type !== "IfStatement" || !node.consequent) return;
    if (!contains(node.consequent, child => child.type === "Property"
      && (child.key.name ?? child.key.value) === "autoPickIsDraftOnly")) return;
    tests.push(node.test);
  });
  return tests.length === 1 ? tests[0] : undefined;
}

// The `excludeBypass` value of the picker props that also carry `sessionBinding`
// — the composer's own picker, and exactly one such object per chunk.
function permissionBypassTarget(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "ObjectExpression") return;
    const names = new Set(node.properties.filter(entry => entry.type === "Property")
      .map(entry => entry.key.name ?? entry.key.value));
    if (!names.has("excludeBypass") || !names.has("sessionBinding")) return;
    for (const entry of node.properties) {
      if (entry.type === "Property" && (entry.key.name ?? entry.key.value) === "excludeBypass") {
        found.push(entry.value);
      }
    }
  });
  return found.length === 1 ? found[0] : undefined;
}

// The draft's two permission-mode mappers. Both take one argument, and both open
// by testing it against `"auto"`; the writer's second test is a call, the
// reader's is the `"acceptEdits"` literal. Returns each one's body so the caller
// can widen it, keyed by role.
function draftModeMapper(ast) {
  const found = new Map();
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return;
    if (node.params.length !== 1 || node.params[0].type !== "Identifier") return;
    const statements = node.body.body;
    if (statements.length !== 2 || statements.some(entry => entry.type !== "IfStatement")) return;
    const test = unwrap(statements[0].test);
    const parameter = node.params[0].name;
    if (test?.type !== "BinaryExpression" || !["===", "=="].includes(test.operator)) return;
    const subject = literal(test.left, "auto") ? test.right : test.left;
    if (identifier(subject) !== parameter) return;
    const second = unwrap(statements[1].test);
    if (second?.type !== "BinaryExpression") return;
    // The operand that is not the parameter is what distinguishes the two: a call
    // is the writer's default-mode getter, the literal is the reader's wire value.
    const left = unwrap(second.left);
    const right = unwrap(second.right);
    const other = identifier(left) === parameter ? right : left;
    const role = other?.type === "CallExpression" ? "writer"
      : literal(other, "acceptEdits") ? "reader" : undefined;
    if (role === undefined || found.has(role)) return;
    found.set(role, node);
  });
  return found;
}

// The flag operand of every unified-composer design predicate: a declaration
// whose body reads the feature — through the binding that holds its name, or as
// the literal itself — and ends its answer with `… && !isSidePanel()`. Only that
// left operand is spliced, so the side-panel guard still applies. Reading the
// feature by name is what separates these from the other guards in the chunk,
// which mention it nowhere.
function composerDesignOperands(ast) {
  const names = new Set();
  walk(ast, [], (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    if (literal(unwrap(node.init), composerDesignFeature)) names.add(node.id.name);
  });
  const operands = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return;
    if (!contains(node.body, child => (child.type === "Identifier" && names.has(child.name))
      || literal(child, composerDesignFeature))) return;
    walk(node.body, [], (child) => {
      if (child.type !== "LogicalExpression" || child.operator !== "&&") return;
      const right = unwrap(child.right);
      if (right?.type !== "UnaryExpression" || right.operator !== "!"
        || right.argument.type !== "CallExpression") return;
      operands.push(child.left);
    });
  });
  return operands;
}

// The account view a component reads from the profile hook:
// `let{name:i,src:a}=iQ()`. Only a destructuring of a zero-argument call
// establishes it — an object literal that merely carries a `src` property (the
// hook itself) is not a binding.
function accountViewBindings(scope) {
  let bindings;
  walk(scope.body ?? scope, [], (node) => {
    if (bindings || node.type !== "VariableDeclarator" || node.id?.type !== "ObjectPattern") return;
    if (node.init?.type !== "CallExpression" || node.init.arguments.length !== 0) return;
    const entries = new Map();
    for (const property of node.id.properties) {
      if (property.type !== "Property" || property.value?.type !== "Identifier") continue;
      const name = property.key.name ?? property.key.value;
      if (typeof name === "string") entries.set(name, property.value.name);
    }
    if (!entries.has("src") || !entries.has("name")) return;
    bindings = { photo: entries.get("src"), name: entries.get("name") };
  });
  return bindings;
}
// The account Avatar component, read back from the sibling components that build
// an avatar from the same account view with an explicit `src` (the user-menu
// header's avatar). They pass it as the first argument of the element factory, so
// this reads the argument, not the factory, and refuses on more than one name.
// The rendered component is the last element of the returned expression, so a
// comma sequence cannot hide it.
function accountAvatarComponent(ast) {
  const names = new Set();
  walk(ast, [], (node) => {
    if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return;
    if (!accountViewBindings(node)) return;
    const returned = renderedExpression(node.body.body
      .find((statement) => statement.type === "ReturnStatement")?.argument);
    if (returned?.type !== "CallExpression") return;
    const props = returned.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
    if (!props?.properties.some((entry) => key(entry, "src"))) return;
    const name = identifier(returned.arguments[0]);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
// The chip's avatar slot: a component whose destructured props include `size`
// and `organization` (this build adds placement props beside them), that reads
// the account view and then renders a call whose props carry no `src` — the one
// shape that reads the photo and drops it.
function accountChipTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  const params = node.params?.[0];
  if (params?.type !== "ObjectPattern") return undefined;
  const paramKeys = params.properties.filter((property) => property.type === "Property")
    .map((property) => property.key.name ?? property.key.value);
  if (!paramKeys.includes("size") || !paramKeys.includes("organization")) return undefined;
  const bindings = accountViewBindings(node);
  if (!bindings) return undefined;
  const returned = renderedExpression(node.body.body
    .find((statement) => statement.type === "ReturnStatement")?.argument);
  if (returned?.type !== "CallExpression") return undefined;
  const props = returned.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  if (props.properties.some((entry) => key(entry, "src"))) return undefined;
  const size = props.properties.find((entry) => key(entry, "size"));
  if (!size) return undefined;
  return { call: returned, bindings, sizeValue: size.value };
}
// The account view hook: a zero-parameter function that destructures `account`
// from a zero-argument context call, reads the profile document (`{data,
// isLoading}` from one call) and returns the view object holding `name`, `src`
// and `isLoading` — the photo a call resolved from that profile read, which must
// name the data binding it read. Minified names, extra declarations and the
// profile call's arguments are tolerated; a function that merely returns an
// object with a `src` property, binds no account, or answers `src` outside a
// call over the profile document is not a target. The splice reads the account
// binding's own name back from the destructuring.
function accountPhotoRead(node) {
  if (!functionTypes.has(node.type) || node.params?.length) return undefined;
  if (node.body?.type !== "BlockStatement") return undefined;
  const statements = node.body.body;
  const returned = statements.at(-1);
  if (returned?.type !== "ReturnStatement"
    || returned.argument?.type !== "ObjectExpression") return undefined;
  const properties = returned.argument.properties;
  const entry = name => properties.find(candidate => key(candidate, name));
  const photo = entry("src");
  if (!photo || !entry("name") || !entry("isLoading")) return undefined;
  if (photo.value?.type !== "CallExpression") return undefined;
  let account;
  let profileData;
  for (const statement of statements.slice(0, -1)) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== "ObjectPattern") continue;
      const bindings = new Map();
      for (const binding of declarator.id.properties) {
        if (binding.type === "Property" && binding.value?.type === "Identifier") {
          const name = binding.key.name ?? binding.key.value;
          if (typeof name === "string") bindings.set(name, binding.value.name);
        }
      }
      if (declarator.init?.type === "CallExpression"
        && declarator.init.arguments.length === 0
        && bindings.has("account")) account = bindings.get("account");
      if (bindings.has("data") && bindings.has("isLoading")) profileData = bindings.get("data");
    }
  }
  if (!account || !profileData) return undefined;
  // The photo call must consume the profile document it resolved from, so a
  // helper that merely spells a call is not a target.
  if (!photo.value.arguments.some(argument => identifier(argument) === profileData)) {
    return undefined;
  }
  return { start: photo.value.start, end: photo.value.end, account };
}
// The mark is drawn at an explicit pixel size (`size:r?20:16`); the Avatar reads
// its `size` as a design token of its own scale, so passing the token made the
// photo larger than the slot the row reserves and ate the row's padding. Pin the
// avatar to the mark's own size expression instead, read back from this call.
function accountChipPatch({ call, bindings, sizeValue }, source, avatar) {
  const factory = identifier(call.callee);
  if (!factory || !avatar || !bindings.photo || !bindings.name) return undefined;
  const pixels = `(${source.slice(sizeValue.start, sizeValue.end)})+"px"`;
  const original = source.slice(call.start, call.end);
  return { original,
    replacement: `(${bindings.photo}?${factory}(${avatar},{name:${bindings.name}`
      + `,src:${bindings.photo},className:"shrink-0"`
      + `,style:{width:${pixels},height:${pixels}}}):${original})` };
}
// The identity reader's whole body is `return X()?.principalDisplayName` with a
// zero-argument call. Any other property, a call carrying arguments, a member
// expression or additional statements refuses, so a lookalike helper cannot
// establish the target.
function accountMenuNameRead(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  const statements = node.body.body;
  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return undefined;
  const argument = unwrap(statements[0].argument);
  if (argument?.type !== "MemberExpression" || !property(argument, "principalDisplayName")) {
    return undefined;
  }
  const call = unwrap(argument.object);
  if (call?.type !== "CallExpression" || call.arguments.length !== 0) return undefined;
  return identifier(call.callee) ? statements[0].argument : undefined;
}

// The user menu's flags object: the one object literal carrying `signOut`
// beside `inferenceConfig` and `internalTools`. All three are non-mangled
// property names, and no other literal in the graph carries that trio, so the
// object is pinned without reading a single minified local. Returns the
// `signOut` property's value — the expression to splice to `true`; an object
// missing a sibling name, or whose `signOut` is a shorthand or method, is not a
// target.
function accountSignOutFlag(node) {
  if (node.type !== "ObjectExpression") return undefined;
  const properties = node.properties.filter(entry => entry.type === "Property");
  const names = properties.map(entry => entry.key.name ?? entry.key.value);
  if (!["signOut", "inferenceConfig", "internalTools"].every(name => names.includes(name))) {
    return undefined;
  }
  const entry = properties.find(candidate => key(candidate, "signOut"));
  // A shorthand or method shares (or owns) the key's own extent, so replacing
  // its value would corrupt the literal; only a genuine `signOut: <expr>` pair.
  if (!entry || entry.shorthand || entry.method) return undefined;
  return entry.value && unwrap(entry.value) ? entry.value : undefined;
}

// The provider card is the sole component passed to a wrapper call whose body
// carries both of its message ids; declarations and unrelated helper functions
// are not arguments, so they are not targets.
function inferenceBannerTarget(node, ancestors) {
  if (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") return false;
  if (node.body?.type !== "BlockStatement") return false;
  const parent = ancestors[ancestors.length - 1];
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return false;
  return inferenceBannerMessageIds.every(id =>
    contains(node.body, child => literal(child, id)));
}
// The file pane's trailing actions, gated by the pane kind (an `==="file"`
// check on the enclosing logical expression), are a two-element children array
// holding a session-scoped search button and a session-scoped anchor control.
// Selecting the array itself keeps the splice to the single insertion point and
// leaves the surrounding header untouched.
function filePaneDownloadTarget({ type, elements }, ancestors) {
  if (type !== "ArrayExpression" || elements.length !== 2) return false;
  if (!key(ancestors.at(-1), "children")) return false;
  const object = ancestors.at(-2);
  if (object?.type !== "ObjectExpression") return false;
  const call = ancestors.at(-3);
  if (call?.type !== "CallExpression" || !call.arguments.includes(object)) return false;
  const guard = ancestors.at(-4);
  return guard?.type === "LogicalExpression" && guard.operator === "&&"
    && guard.right === call && checksFileKind(guard.left);
}
// The injected button references only names that would otherwise be mangled, so
// each is read back from the same parsed graph rather than hard-coded: the file
// pane's absolute path (`x=$(t=>e==="file"?t.fileView:…:void 0)`), the element
// factory the pane already calls, and the ghost icon-only Button component.
// Ambiguous or missing anchors return undefined, and the caller then refuses to
// emit a patch instead of producing code that breaks under a future minifier.
function fileViewVariable(scope) {
  const names = new Set();
  walk(scope, [], node => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return;
    const selector = node.init?.type === "CallExpression" ? node.init.arguments[0] : undefined;
    if (selector?.type !== "ArrowFunctionExpression") return;
    if (!contains(selector, child => property(child, "fileView"))) return;
    if (!checksFileKind(selector)) return;
    names.add(node.id.name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function ghostIconButton(ast) {
  const names = new Set();
  walk(ast, [], node => {
    if (node.type !== "CallExpression") return;
    const props = node.arguments.map(unwrap).find(argument => argument?.type === "ObjectExpression");
    if (!props) return;
    if (!props.properties.some(entry => key(entry, "variant") && literal(entry.value, "ghost"))
      || !props.properties.some(entry => key(entry, "icon"))
      || !props.properties.some(entry => key(entry, "iconOnly"))) return;
    const name = identifier(node.arguments[0]);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function filePaneDownloadPatch(node, ancestors, source, button) {
  const element = node.elements[0];
  const factory = element?.type === "CallExpression" ? identifier(element.callee) : undefined;
  const scope = [...ancestors].reverse().find(parent => functionTypes.has(parent.type));
  const fileView = scope ? fileViewVariable(scope) : undefined;
  if (!factory || !fileView || !button) return;
  // A new tab keeps a refused download (or a JSON error) from replacing the
  // app, and gives the browser's own download manager a real navigation target.
  const handler = `()=>{const filePath=${fileView}&&${fileView}.path;`
    + 'if(typeof filePath!="string"||filePath==="")return;'
    + 'const link=document.createElement("a");'
    + 'link.href="/api/remote/files/download?path="+encodeURIComponent(filePath);'
    + 'link.target="_blank";link.rel="noopener noreferrer";'
    + 'document.body.append(link);link.click();link.remove();}';
  const injected = `${fileView}&&${fileView}.path?${factory}(${button},`
    + `{variant:"ghost",iconOnly:!0,icon:"Download","aria-label":"Download file",onClick:${handler}}):null`;
  const original = source.slice(node.start, node.end);
  return { original, replacement: `[${original.slice(1, -1)},${injected}]` };
}

// The native preview component renders a container div with this exact className
// and a children array holding the loading spinner, the decline UI and the parked
// capture image. Selecting the array keeps the splice to the single render point
// and leaves the component's effects (which the preload stubs) untouched.
function filePreviewChildrenArray(call) {
  if (call.type !== "CallExpression") return undefined;
  const props = call.arguments.map(unwrap).find(argument => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  if (!props.properties.some(entry => key(entry, "className")
    && literal(entry.value, filePreviewStaticClassName))) return undefined;
  const children = props.properties.find(entry => key(entry, "children"));
  return children?.value?.type === "ArrayExpression" ? children.value : undefined;
}
// A component prop destructured by name, e.g. {filePath:v,cacheBuster:y} -> "v".
function destructuredPropName(scope, name) {
  const params = scope?.params?.[0];
  if (params?.type !== "ObjectPattern") return undefined;
  const entry = params.properties.find(property => property.type === "Property"
    && key(property, name));
  return entry?.value?.type === "Identifier" ? entry.value.name : undefined;
}
// The element factory the array's own calls use (a type string as the first
// argument), read back rather than assumed, so a renamed factory cannot break the
// emitted iframe.
function arrayElementFactory(array) {
  const names = new Set();
  walk(array, [], node => {
    if (node.type !== "CallExpression") return;
    const first = node.arguments[0];
    if (first?.type !== "Literal" || typeof first.value !== "string") return;
    const name = identifier(node.callee);
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
function filePreviewPatch(node, ancestors, source, array) {
  const scope = [...ancestors].reverse().find(parent => functionTypes.has(parent.type));
  const path = destructuredPropName(scope, "filePath");
  const cacheBuster = destructuredPropName(scope, "cacheBuster");
  const factory = arrayElementFactory(array);
  if (!path || !factory) return;
  // The bridge route answers with a PDF; cacheBuster re-requests when the file's
  // content changes. Office and PDF only — any other file keeps the original
  // children, so html/svg stay on their existing path. The `#toolbar=0` fragment
  // is a PDF open parameter Chrome's viewer reads off the URL: it hides the
  // viewer's own toolbar, leaving the pane to show only the document instead of
  // a second set of controls (its Download would save the converted `.docx.pdf`).
  const url = `"/api/remote/files/preview?path="+encodeURIComponent(${path})`
    + (cacheBuster ? `+"&v="+encodeURIComponent(String(${cacheBuster}??""))` : "")
    + '+"#toolbar=0"';
  const iframe = `${factory}("iframe",{src:${url},className:"h-full w-full border-0",`
    + 'title:"File preview"})';
  const original = source.slice(array.start, array.end);
  const condition = `/(?:pdf|docx?|pptx?|xlsx?)$/i.test(${path})`;
  return { original,
    replacement: `(${condition}?[${iframe}]:[${original.slice(1, -1)}])` };
}

// The Desktop-only checks slot: the one component rendering a call whose props
// carry the `componentName:"DesktopChecks"` label. That label is the bundle's own
// copy and appears nowhere else, and only parsed props are inspected, so a string
// or comment that merely spells it is not a target.
function desktopChecksComponent(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") return undefined;
  let found = false;
  walk(node.body, [], (child) => {
    if (found || child.type !== "CallExpression") return;
    const props = child.arguments.map(unwrap).find((argument) => argument?.type === "ObjectExpression");
    if (props?.properties.some((entry) => key(entry, "componentName")
      && literal(entry.value, desktopChecksLabel))) found = true;
  });
  return found ? node : undefined;
}
// The pending-permission store's wiring call (`wiring(api)`), read back from the
// Desktop root's own body: the call is the first element of the comma sequence
// that also carries the locale-change effect — a stable property name — so a
// renamed hook or API binding is tolerated. A lone one-argument identifier call
// is too common to pin anywhere else; any other sequence carrying the same
// effect refuses the patch instead of guessing which call wires the store.
function coworkWiringCall(ast) {
  const calls = [];
  walk(ast, [], (node) => {
    if (node.type !== "SequenceExpression" || !node.expressions.length) return;
    if (!node.expressions.some((expression) => contains(expression,
      (child) => property(child, "requestLocaleChange")))) return;
    const first = unwrap(node.expressions[0]);
    if (first?.type !== "CallExpression" || first.arguments.length !== 1) return;
    const callee = identifier(first.callee);
    const api = identifier(first.arguments[0]);
    if (callee && api) calls.push({ callee, api });
  });
  return calls.length === 1 ? calls[0] : undefined;
}
// The scheduled-task runner's identity gate: `flag || refuse(id, log, copy)`,
// where `copy` is the run refusal only this runner carries. Read the flag back
// from the short-circuit so the splice names whatever the minifier chose; the
// copy is matched only as a parsed third argument, so the runner's own
// `.catch(… "…unavailable …")` (whose third argument is a conditional) and a
// string or comment that merely spells the copy are not targets.
function scheduledTaskRunnerGate(node) {
  if (node.type !== "LogicalExpression" || node.operator !== "||") return undefined;
  const call = unwrap(node.right);
  if (call?.type !== "CallExpression" || call.arguments.length !== 3) return undefined;
  if (!literal(unwrap(call.arguments[2]), scheduledTaskRunRefusal)) return undefined;
  return identifier(node.left);
}
// The Desktop-checks slot's shape: a single `return gate() ? wrapper(element,
// {…children:[…]}) : null`. The alternate is where this patch mounts the
// scheduled-task hosts, so a client the gate already admits keeps its own mount
// and nothing renders twice. Everything the replacement needs — the wrapper
// component, the element factory, the props except `children` — is read back
// from the consequent, so only the two hoisted hosts are new text.
function desktopChecksGate(slot) {
  const statements = slot.body?.type === "BlockStatement" ? slot.body.body : [];
  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return undefined;
  const argument = unwrap(statements[0].argument);
  if (argument?.type !== "ConditionalExpression") return undefined;
  if (!literal(unwrap(argument.alternate), null)) return undefined;
  const consequent = unwrap(argument.consequent);
  if (consequent?.type !== "CallExpression" || consequent.arguments.length !== 2) return undefined;
  const wrapper = identifier(consequent.arguments[0]);
  const elementFactory = identifier(consequent.callee);
  const props = unwrap(consequent.arguments[1]);
  if (!wrapper || !elementFactory || props?.type !== "ObjectExpression") return undefined;
  const children = props.properties.find(entry => key(entry, "children"));
  const array = unwrap(children?.value);
  if (array?.type !== "ArrayExpression" || !array.elements.length) return undefined;
  const hostFactory = identifier(unwrap(array.elements[0])?.callee);
  if (!hostFactory) return undefined;
  return { alternate: unwrap(argument.alternate), wrapper, elementFactory, hostFactory, props, children };
}
function scheduledTaskHostsReplacement(gate, source, starter, listener) {
  const head = source.slice(gate.props.start + 1, gate.children.start);
  // `props.end` is one past the closing brace; the brace is kept explicitly
  // because the children property is removed and re-emitted here.
  const tail = source.slice(gate.children.end, gate.props.end - 1);
  return `(${gate.elementFactory}(${gate.wrapper},{${head}children:[`
    + `${gate.hostFactory}(${starter},{}),${gate.hostFactory}(${listener},{})]${tail}}))`;
}
// The Cowork session-starter host: the component that publishes the session
// starter into the app's own store — the declarator whose initialiser writes an
// object literal with a `startSession` key through `setState`. The scheduled-task
// runner waits on that store, so the host has to mount in either shell. Any
// other count refuses the splice rather than guess which binding publishes it.
function scheduledTaskStarterHost(ast) {
  const names = new Set();
  walk(ast, [], (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    if (!contains(node.init, child => child.type === "CallExpression"
      && property(child.callee, "setState")
      && child.arguments.some(argument => unwrap(argument)?.type === "ObjectExpression"
        && unwrap(argument).properties.some(entry => key(entry, "startSession"))))) return;
    names.add(node.id.name);
  });
  return names.size === 1 ? [...names][0] : undefined;
}
// The Cowork scheduled-task listener host: the component whose whole body calls
// the hook that subscribes to the main process's dispatches and declares the
// listener ready. The hook is read back as the nearest enclosing *declaration*
// of the `onOnScheduledTaskEvent` subscription itself — the subscription sits in
// an effect callback, so the nearest function is not the hook — and must carry
// `markListenerReady` in the same body; the host is the component whose whole
// body calls it and renders null. A second candidate on either count refuses
// rather than mount the wrong one.
function scheduledTaskListenerHost(ast) {
  const hooks = new Set();
  walk(ast, [], (node, ancestors) => {
    if (node.type !== "CallExpression" || !property(node.callee, "onOnScheduledTaskEvent")) return;
    const scope = [...ancestors].reverse().find(parent => parent.type === "FunctionDeclaration");
    if (scope?.body?.type !== "BlockStatement" || !scope.id) return;
    if (!contains(scope.body, child => child.type === "MemberExpression"
      && property(child, "markListenerReady"))) return;
    hooks.add(scope.id.name);
  });
  if (hooks.size !== 1) return undefined;
  const hook = [...hooks][0];
  const hosts = new Set();
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || !node.id || node.body?.type !== "BlockStatement") return;
    const statements = node.body.body;
    if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return;
    const sequence = unwrap(statements[0].argument);
    if (sequence?.type !== "SequenceExpression" || sequence.expressions.length !== 2) return;
    const call = unwrap(sequence.expressions[0]);
    if (call?.type !== "CallExpression" || call.arguments.length) return;
    if (identifier(call.callee) !== hook || !literal(sequence.expressions[1], null)) return;
    hosts.add(node.id.name);
  });
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

export function inspectRenderer(source, gatewayEnabled, webShellEnabled = false) {
  const evidence = Object.fromEntries(markerIds.map(id => [id, []]));
  const patches = [];
  // String prefilter is only an optimization; all acceptance uses parsed nodes.
  // `native-file-preview-error` is the DeclineReason UI's test id; the preview
  // component's own chunk matches none of the other tokens, so without it the
  // patch below would never be attempted on the file it targets. The route-alias
  // chunk likewise carries none of them, so its own `when==="desktop"` rule is
  // listed too. The session layout carries its own `not_desktop_app` reason. The
  // account chip's chunk is reached by the API field it reads (`avatar_image_url`),
  // and the user-menu identity reader in the same chunk by `principalDisplayName`;
  // the Desktop-checks slot by its own component label; the session-placement
  // helper by the force-local shrimp literal only it carries; the compact mode
  // switcher by its own `data-compact-mode-switcher` label; the scheduled-task
  // runner by the run refusal only it carries (its chunk is also reached by
  // `keyCode`, and the two scheduled-task hosts live in the Desktop-checks
  // chunk); the home-layout assignment by its own `stringsVouched` property,
  // which appears nowhere else in the renderer graph; the projects-allowed
  // predicate by its own limits-feature name, likewise unique.
  if (!/rewind|keyCode|onEdit|protocol|sessionRef|native-file-preview-error|when==="desktop"|not_desktop_app|avatar_image_url|principalDisplayName|signOut|DesktopChecks|dramatic_shrimp_force_local|claudeai\.notification\.permission\.result|data-compact-mode-switcher|Local scheduled tasks can only run|stringsVouched|voyage_composer_marlin|claude_ai_projects_limits|/.test(source)) {
    return { evidence, patches };
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const redirectScopes = new Map();
  let button;
  let avatarComponent;
  let starterHost;
  let listenerHost;
  let toastBinding;
  let toastPublished = false;
  if (webShellEnabled) {
    // The unified-composer design predicates are forced to their flag operand.
    for (const operand of composerDesignOperands(ast)) {
      patches.push({ id: composerDesignPatchId, start: operand.start, end: operand.end,
        original: source.slice(operand.start, operand.end), replacement: "!0" });
    }
    // The layout variant and the surface kind that selects the home composer
    // arrangement are forced to the deployed answer, each from its own shape and
    // only when that shape is unambiguous in the chunk.
    const variants = [];
    const surfaces = [];
    walk(ast, [], (node, ancestors) => {
      if (homeLayoutVariantTarget(node, ancestors)) variants.push(node);
      if (homeSurfaceKindTarget(node)) surfaces.push(node);
    });
    for (const [targets, id, forced] of [
      [variants, homeVariantPatchId, homeVariantReplacement],
      [surfaces, homeArrangementPatchId, homeArrangementReplacement],
    ]) {
      if (targets.length !== 1) continue;
      const [target] = targets;
      patches.push({ id, start: target.start, end: target.end,
        original: source.slice(target.start, target.end), replacement: forced });
    }
    // Projects: the predicate the build folded to a constant. Accepted only
    // when exactly one function of that shape is in the chunk, so a second
    // candidate refuses rather than splice the wrong body.
    const projectsAllowed = [];
    walk(ast, [], (node) => { if (projectsAllowedTarget(node)) projectsAllowed.push(node); });
    if (projectsAllowed.length === 1) {
      const target = projectsAllowed[0];
      patches.push({ id: projectsAllowedPatchId, start: target.body.start,
        end: target.body.end,
        original: source.slice(target.body.start, target.body.end),
        replacement: projectsAllowedReplacement(source, target) });
    }
    // The sidebar's Projects entry: the nav filter's project clauses are dropped
    // from the `||` chain it negates. Exactly one such negation is required, so a
    // chunk with a second filter of the same shape refuses rather than splice.
    const navClauses = [];
    walk(ast, [], (node) => { if (projectsNavClauseTarget(node)) navClauses.push(node); });
    if (navClauses.length === 1) {
      const target = navClauses[0];
      const chain = unwrap(target.argument);
      const kept = flattenLogical(chain, "||")
        .filter(operand => !flattenLogical(operand, "&&").some(term => comparesTo(term, "projects")))
        .map(operand => source.slice(operand.start, operand.end));
      if (kept.length) {
        patches.push({ id: projectsNavPatchId, start: target.start, end: target.end,
          original: source.slice(target.start, target.end),
          replacement: `!(${kept.join("||")})` });
      }
    }
    // The composer's project slot: the answer the deployed arm settles on.
    const composerSlots = [];
    walk(ast, [], (node) => { if (composerSlotTarget(node)) composerSlots.push(node); });
    if (composerSlots.length === 1) {
      const argument = unwrap(composerSlots[0].body.body.at(-1).argument);
      patches.push({ id: projectsComposerPatchId, start: argument.start, end: argument.end,
        original: source.slice(argument.start, argument.end),
        replacement: projectsComposerMode });
    }
    // The unified composer's chin: the branch that draws the project chip is
    // forced on, keeping that branch's own surface comparison. Accepted only when
    // exactly one `"unified"` block is in the chunk.
    const chinBlocks = [];
    walk(ast, [], (node) => { if (composerChinBranchTarget(node)) chinBlocks.push(node); });
    if (chinBlocks.length === 1) {
      const branch = composerChinBranch(chinBlocks[0]);
      if (branch) {
        patches.push({ id: projectsChinPatchId, start: branch.test.start, end: branch.test.end,
          original: source.slice(branch.test.start, branch.test.end),
          replacement: projectsChinForced });
      }
    }
    // The folder picker's capability flags, so the chip it draws is not the empty
    // one the platform check and the folded backend flag would leave behind.
    for (const picker of projectsPickerTarget(ast) ?? []) {
      patches.push({ id: projectsPickerPatchId, start: picker.value.start,
        end: picker.value.end, original: source.slice(picker.value.start, picker.value.end),
        replacement: projectsPickerForced.get(picker.key.name ?? picker.key.value) });
    }
    // The draft's mode mappers, widened so the bypass row's setting survives the
    // round trip through the pending draft rather than reading back as default.
    const mappers = draftModeMapper(ast);
    for (const node of mappers.values()) {
      const inner = source.slice(node.body.start + 1, node.body.end - 1);
      const parameter = node.params[0].name;
      patches.push({ id: draftBypassPatchId, start: node.body.start, end: node.body.end,
        original: source.slice(node.body.start, node.body.end),
        replacement: `{${inner};if(${parameter}===${draftBypassWire})return ${draftBypassWire};}` });
    }
    // The composer's picker asks for its mode list without the bypass row; the
    // deployment offers that row deliberately, so the flag is cleared.
    const permissionBypass = permissionBypassTarget(ast);
    if (permissionBypass) {
      patches.push({ id: permissionBypassPatchId, start: permissionBypass.start,
        end: permissionBypass.end, original: source.slice(permissionBypass.start, permissionBypass.end),
        replacement: permissionBypassOff });
    }
    // The permission binding's guard, so the composer's permission control is
    // handed a binding instead of drawing its skeleton indefinitely.
    const permissionBinding = permissionBindingTarget(ast);
    if (permissionBinding) {
      patches.push({ id: permissionBindingPatchId, start: permissionBinding.start,
        end: permissionBinding.end, original: source.slice(permissionBinding.start, permissionBinding.end),
        replacement: permissionBindingOn });
    }
    // The picker's `showProjects`, so the trigger has something to draw even on
    // a deployment whose accounts have no project targets yet.
    const pickerSection = projectsPickerSectionTarget(ast);
    if (pickerSection) {
      patches.push({ id: projectsPickerSectionPatchId, start: pickerSection.start,
        end: pickerSection.end, original: source.slice(pickerSection.start, pickerSection.end),
        replacement: projectsPickerSectionOn });
    }
    // The slot's bound-project branch, so the slot draws the selector instead of
    // the component that answers null without a resolved device binding.
    const boundSlot = projectsBoundSlotTarget(ast);
    if (boundSlot) {
      patches.push({ id: projectsBoundSlotPatchId, start: boundSlot.start, end: boundSlot.end,
        original: source.slice(boundSlot.start, boundSlot.end),
        replacement: projectsSelectorOff });
    }
    // The project selector's scope guard, so it draws rather than answering null.
    const selector = projectsSelectorTarget(ast);
    if (selector) {
      patches.push({ id: projectsSelectorPatchId, start: selector.start, end: selector.end,
        original: source.slice(selector.start, selector.end),
        replacement: projectsSelectorOff });
    }
    // The home-layout assignment is accepted from its own chunk: exactly one
    // object of that shape and one gate literal, both parsed, or nothing.
    const assignments = [];
    let gates = 0;
    walk(ast, [], (node) => {
      if (homeLayoutAssignment(node)) assignments.push(node);
      if (literal(node, homeLayoutGate)) gates += 1;
    });
    if (assignments.length === 1 && gates === 1) {
      const target = assignments[0];
      patches.push({ id: homeLayoutPatchId, start: target.start, end: target.end,
        original: source.slice(target.start, target.end), replacement: homeLayoutReplacement });
    }
  }
  walk(ast, [], (node, ancestors) => {
    if (filePaneDownloadTarget(node, ancestors)) {
      button ??= ghostIconButton(ast);
      const patch = filePaneDownloadPatch(node, ancestors, source, button);
      if (patch) patches.push({ id: downloadPatchId, start: node.start, end: node.end, ...patch });
    }
    if (inferenceBannerTarget(node, ancestors)) {
      patches.push({ id: inferenceBannerPatchId, start: node.body.start, end: node.body.end,
        original: source.slice(node.body.start, node.body.end), replacement: "{return null;}" });
    }
    const modePicker = modePickerTarget(node);
    if (modePicker) {
      const original = source.slice(node.start, node.end);
      patches.push({ id: modePickerPatchId, start: node.start, end: node.end, original,
        replacement: `(${modePicker.segments}.some(__claudeskMode=>__claudeskMode.disabled)`
          + `?null:${original})` });
    }
    const signOutFlag = accountSignOutFlag(node);
    if (signOutFlag) {
      const original = source.slice(signOutFlag.start, signOutFlag.end);
      patches.push({ id: accountSignOutPatchId, start: signOutFlag.start, end: signOutFlag.end,
        original, replacement: "!0" });
    }
    if (webShellEnabled) {
      // The manager name is read from the whole chunk, so it is resolved once
      // and cached; `toastPublished` keeps the splice from being emitted twice
      // if the marker property were ever rendered by more than one component.
      if (!toastPublished) {
        const viewport = toastViewportComponent(node);
        if (viewport) {
          toastBinding ??= toastManagerHook(ast);
          const opening = viewport.body.body[0];
          if (toastBinding && opening?.type === "VariableDeclaration") {
            toastPublished = true;
            patches.push({ id: toastGlobalPatchId,
              start: opening.end, end: opening.end, original: "",
              replacement: `;globalThis.${toastGlobalName}=${toastBinding}();` });
          }
        }
      }
      const chip = accountChipTarget(node);
      if (chip) {
        avatarComponent ??= accountAvatarComponent(ast);
        const patch = accountChipPatch(chip, source, avatarComponent);
        if (patch) patches.push({ id: accountChipPatchId, start: chip.call.start, end: chip.call.end, ...patch });
      }
      const menuName = accountMenuNameRead(node);
      if (menuName) {
        const original = source.slice(menuName.start, menuName.end);
        patches.push({ id: accountMenuNamePatchId, start: menuName.start, end: menuName.end,
          original, replacement: `(${original}??${accountNameSyncFallback})` });
      }
      const accountPhoto = accountPhotoRead(node);
      if (accountPhoto) {
        const original = source.slice(accountPhoto.start, accountPhoto.end);
        patches.push({ id: accountPhotoPatchId, start: accountPhoto.start, end: accountPhoto.end,
          original, replacement: `(${original}||${accountPhoto.account}?.avatar_image_url)` });
      }
      const routeFlag = desktopRouteFlagName(node);
      if (routeFlag) {
        patches.push({ id: routeAliasPatchId, start: node.body.start + 1, end: node.body.start + 1,
          original: "", replacement: `${routeFlag}=!0;` });
      }
      const placement = localSessionPlacementTarget(node);
      if (placement) {
        const original = source.slice(placement.start, placement.end);
        patches.push({ id: localSessionPlacementPatchId, start: placement.start,
          end: placement.end, original, replacement: "!0" });
      }
      const sessionFlag = sessionViewerFlagName(node);
      if (sessionFlag) {
        // The guard lives in the layout component's effect closure, so walk out
        // to the nearest enclosing scope that actually declares the flag.
        const init = [...ancestors].reverse()
          .filter(parent => functionTypes.has(parent.type))
          .map(scope => flagInitializer(scope, sessionFlag))
          .find(Boolean);
        if (init) {
          patches.push({ id: sessionViewerPatchId, start: init.start, end: init.end,
            original: source.slice(init.start, init.end), replacement: "!0" });
        }
      }
      const wiringHost = desktopChecksComponent(node);
      if (wiringHost) {
        const wiring = coworkWiringCall(ast);
        if (wiring) {
          patches.push({ id: coworkPermissionWiringPatchId,
            start: wiringHost.body.start + 1, end: wiringHost.body.start + 1,
            original: "", replacement: `${wiring.callee}(${wiring.api});` });
        }
        const gate = desktopChecksGate(wiringHost);
        if (gate) {
          starterHost ??= scheduledTaskStarterHost(ast);
          listenerHost ??= scheduledTaskListenerHost(ast);
          if (starterHost && listenerHost) {
            patches.push({ id: scheduledTaskHostsPatchId,
              start: gate.alternate.start, end: gate.alternate.end,
              original: source.slice(gate.alternate.start, gate.alternate.end),
              replacement: scheduledTaskHostsReplacement(gate, source, starterHost, listenerHost) });
          }
        }
      }
      const runnerGate = scheduledTaskRunnerGate(node);
      if (runnerGate) {
        // The guard sits in the runner's returned closure, so walk out to the
        // nearest enclosing scope that actually declares the flag, as the
        // session-layout gate does.
        const init = [...ancestors].reverse()
          .filter(parent => functionTypes.has(parent.type))
          .map(scope => flagInitializer(scope, runnerGate))
          .find(Boolean);
        if (init) {
          patches.push({ id: scheduledTaskRunnerPatchId, start: init.start, end: init.end,
            original: source.slice(init.start, init.end), replacement: "!0" });
        }
      }
      const enableTarget = notificationEnableTarget(node);
      if (enableTarget) {
        patches.push({ id: notificationEnablePatchId, start: enableTarget.body.start + 1,
          end: enableTarget.body.start + 1, original: "", replacement: notificationEnableBranch });
      }
    }
    const gatewayPredicate = gatewayUrlPredicate(node);
    if (gatewayPredicate) {
      const membership = loopbackMembershipCheck(gatewayPredicate);
      if (membership) {
        patches.push({ id: gatewayLoopbackHttpPatchId, start: membership.start,
          end: membership.end, original: source.slice(membership.start, membership.end),
          replacement: "!0" });
      }
    }
    const previewArray = filePreviewChildrenArray(node);
    if (previewArray) {
      const patch = filePreviewPatch(node, ancestors, source, previewArray);
      if (patch) {
        patches.push({ id: filePreviewPatchId, start: previewArray.start, end: previewArray.end,
          ...patch });
      }
    }
    let marker;
    if (literal(node, "rewindSession unavailable")) marker = markerIds[0];
    if (property(node, "rewindV2") || key(node, "rewindV2")) marker = markerIds[1];
    if (node.type === "BinaryExpression" && ["==", "==="].includes(node.operator)
      && ((property(node.left, "keyCode") && literal(node.right, 229))
        || (property(node.right, "keyCode") && literal(node.left, 229)))) marker = markerIds[2];
    if (key(node, "edit") && literal(node.value, "onEdit")) marker = markerIds[3];
    if (marker) evidence[marker].push(source.slice(node.start, node.end));

    if (!gatewayEnabled || node.type !== "BinaryExpression"
      || !["==", "===", "!=", "!=="].includes(node.operator)
      || !((protocol(node.left) && literal(node.right, "app:"))
        || (protocol(node.right) && literal(node.left, "app:")))) return;
    // Both setup routes redirect to /new when unavailable. An app: check in an
    // unrelated feature, a string, a comment or a nested helper is not a target.
    const scopeIndex = ancestors.findLastIndex(parent => functionTypes.has(parent.type));
    if (scopeIndex < 0) return;
    const scope = ancestors[scopeIndex];
    if (!redirectScopes.has(scope)) redirectScopes.set(scope, redirectsToNew(scope));
    if (!redirectScopes.get(scope)) return;
    const guard = ancestors.slice(scopeIndex + 1).findLast(parent =>
      parent.type === "LogicalExpression" && parent.operator === "&&");
    if (!guard) return;
    const id = checksWindow(guard.left)
      ? "gateway-setup-route-web-guard" : "gateway-setup-signin-web-guard";
    if (id === "gateway-setup-signin-web-guard"
      && !contains(scope, child => property(child, "pendingUserCode"))) return;
    const original = source.slice(node.start, node.end);
    const remote = "globalThis.__CLAUDE_REMOTE_BOOTSTRAP__?.gatewaySettingsEnabled===true";
    patches.push({ id, start: node.start, end: node.end, original,
      replacement: node.operator.includes("!") ? `(${original}&&!(${remote}))` : `(${original}||${remote})` });
  });
  return { evidence, patches };
}

// The Desktop main process bundles its own copy of the same URL schema, and the
// Gateway connection test (Custom3pHelperRun.probeInference) and its model
// discovery run *there*, not in the renderer. So the renderer splice only gets a
// deployment's endpoint as far as the settings field: the main process validates
// it again on the way out and refuses an http URL off the loopback, which is
// what a "Connection test failed. The endpoint URL was rejected." is. This
// applies only the Gateway URL splice, to the app archive the wrapper already
// extracts and repacks — the renderer's own required patches have no meaning
// there.
export function patchEmbeddedSources(sources) {
  const output = new Map(sources);
  const patches = [];
  for (const [path, source] of sources) {
    const applied = inspectRenderer(source, false, false).patches
      .filter(patch => patch.id === gatewayLoopbackHttpPatchId);
    if (!applied.length) continue;
    let text = source;
    for (const patch of [...applied].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, patch.start) + patch.replacement + text.slice(patch.end);
    }
    // Parse the result before it is written back, as the renderer path does.
    parse(text, { ecmaVersion: "latest", sourceType: "module" });
    output.set(path, text);
    for (const patch of applied) patches.push({ path, ...patch });
  }
  return { sources: output, patches };
}

export function patchRendererSources(sources, gatewayEnabled, webShellEnabled = false) {
  const matches = new Map();
  const markers = new Map(markerIds.map(id => [id, []]));
  for (const [path, source] of sources) {
    const result = inspectRenderer(source, gatewayEnabled, webShellEnabled);
    for (const patch of result.patches) {
      if (!matches.has(patch.id)) matches.set(patch.id, []);
      matches.get(patch.id).push({ path, ...patch });
    }
    for (const [id, evidence] of Object.entries(result.evidence)) {
      if (evidence.length) markers.get(id).push({ path, count: evidence.length, evidence });
    }
  }
  const required = [downloadPatchId, inferenceBannerPatchId, filePreviewPatchId,
    accountSignOutPatchId,
    ...(webShellEnabled
      ? [routeAliasPatchId, sessionViewerPatchId, localSessionPlacementPatchId,
          accountChipPatchId, accountPhotoPatchId,
          coworkPermissionWiringPatchId, notificationEnablePatchId, accountMenuNamePatchId,
          scheduledTaskRunnerPatchId, scheduledTaskHostsPatchId, toastGlobalPatchId]
      : []),
    ...(gatewayEnabled
      ? ["gateway-setup-signin-web-guard", "gateway-setup-route-web-guard"] : [])];
  for (const id of required) {
    const count = matches.get(id)?.length || 0;
    if (count !== 1) throw new Error(`renderer patch ${id} expected once, found ${count}`);
  }
  for (const [id, found] of markers) {
    if (!found.length) throw new Error(`required renderer capability ${id} is missing`);
  }
  const output = new Map(sources);
  const patches = [...matches.values()].flat();
  for (const path of new Set(patches.map(patch => patch.path))) {
    let source = output.get(path);
    for (const patch of patches.filter(patch => patch.path === path).sort((a, b) => b.start - a.start)) {
      source = source.slice(0, patch.start) + patch.replacement + source.slice(patch.end);
    }
    // Parse the final code even if the caller is only doing a dry run.
    parse(source, { ecmaVersion: "latest", sourceType: "module" });
    output.set(path, source);
  }
  return { sources: output, patches,
    markers: [...markers].map(([id, found]) => ({ id, matches: found })) };
}
