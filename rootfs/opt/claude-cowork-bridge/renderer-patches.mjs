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
// Code sessions and chat sessions are separate stores — Code lives in the local
// Code session store (`LocalSessions`), chat and Cowork in the local-agent-mode
// store (`LocalAgentModeSessions`) — but the renderer merges them into one
// recents list behind a gate that reads
// `activeMode === "code" || codeFoldedIntoHome || requested`. `requested` is the
// product switcher's own store: it is set when the switcher lands on Code and
// nothing clears it when the user goes back to Chat, so in a single-page web
// shell the Code sessions made (or seen) in the Code surface stay in the chat
// list afterwards. (`codeFoldedIntoHome`, the Desktop build's own folded
// branch, is compiled false in this bundle.) The patch forces that operand
// false, leaving the Code surface itself intact — `activeMode === "code"` still
// opens the feed — and the folded branch in place. Pinned by the gate
// function's destructured parameter names, which the minifier leaves alone
// because they are property keys, and by the shape of its single returned
// disjunction; applied only when exactly one such function is in the chunk.
// Spliced only in web-shell mode, and deliberately not required: a bundle that
// no longer matches keeps the merge rather than failing renderer preparation.
const chatListNoCodePatchId = "web-chat-session-list-no-code";
// The Code session view's live transcript transport is a feature read: the
// session-subscription hook receives `subscribeSse: z("ccr_v2_subscribe_sse_web")`
// and, when that reads off, holds the live leg over a WebSocket
// (`/v1/sessions/ws/{id}/subscribe`) this bridge does not speak — history is
// hydrated by one-shot reads and nothing ever streams, however healthy the
// bridge's SSE leg is. The bridge grants the gate in its bootstrap
// (`grantCcrSubscribeSse`), but the renderer's own feature read can still
// answer off — a persisted feature table answers in place of the fresh one,
// the same hazard `web-composer-design-forced` exists for — so the
// subscription's transport property is forced on here as well. `subscribeSse`
// is an object property, not a mangled name; the same-named local binding and
// a shorthand property are not targets, and only a plain expression value is
// spliced. Spliced only in web-shell mode, and deliberately not required: a
// bundle that no longer matches leaves the transport to the flag.
const subscribeSsePatchId = "web-code-subscribe-sse";
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
// The routine detail page and its API-trigger card print a fire URL built on
// the API origin `https://api.anthropic.com` (staging for a staging build).
// This deployment serves the fire route itself, so the origin is the page's own
// — the deployment's HTTPS entry. The expression is pinned behaviourally: the
// only `${…}?api-staging.anthropic.com:api.anthropic.com` conditional in the
// renderer graph, replaced by `window.location.origin`. Spliced only in
// web-shell mode, and deliberately not required: a bundle that no longer
// matches leaves the card pointing at Anthropic's cloud (and visibly not at
// this deployment) rather than failing renderer preparation.
const routineFireOriginPatchId = "routine-fire-origin";
const routineFireCloudOrigin = "https://api.anthropic.com";
const routineFireStagingOrigin = "https://api-staging.anthropic.com";
// The routine form's trigger cards. The Desktop build ships its `availableCards`
// as the schedule-only subset (`O.filter(type === "schedule")`), so a routine
// cannot be created — or edited to add — an API trigger: the form requires at
// least one trigger, and Schedule is the only card. This deployment serves the
// API trigger itself (the bridge's fire endpoint and token store), so the card
// is appended to that list. The existing filter is left in place, so an added
// card disappears from the picker and GitHub stays out (it is not in the list).
const routineApiTriggerPatchId = "routine-api-trigger";
const routineApiTriggerCard = "{type:\"api\",icon:\"Code\","
  + "title:{defaultMessage:\"API\",id:\"xwEc8KM8zK\"},"
  + "desc:{defaultMessage:\"Trigger from your own code by sending a POST request\","
  + "id:\"2eHmKFyJSw\"}}";
// The routine form's model picker is a model-only dropdown. The Code composer
// offers the same catalog with a second dropdown for the effort level (the
// existing `ModelSelector`/`EffortControl` pair), so the routine form's wrapper
// is extended to feed that pair: the catalog carries each model's own
// `thinking.effort_options`, the state carries the chosen effort, and the
// composite is told `thinkingStyle: "separate"` — the same shape the composer
// builds. No new controls are introduced; the dropdowns and the slider are the
// renderer's own components.
const routineModelPickerPatchId = "routine-model-effort-picker";
// The routine's own state: the form state hook gains effort, working directory
// and permission mode, seeds them from the stored job config, sends them in the
// create/edit job config, and returns them to the form. A routine is a Code
// scheduled task; the task record already carries `cwd` and `permissionMode`,
// so the bridge's create/update map them straight onto it.
const routineFormStatePatchId = "routine-form-start-options";
// The routine job-config parser: the Code form edits through
// `job_config.ccr.session_context`; the parser is what seeds the form on edit.
const routineJobConfigPatchId = "routine-job-config-start-options";
// The unified routine form's rows: a working-directory picker (the same
// `FileSystem.browseCodeFolder` the Code composer uses) and a permission-mode
// dropdown (the renderer's own combobox), beside the existing environment row.
const routineFormRowsPatchId = "routine-form-start-option-rows";
// The Code surface's own routine page (the "Epitaxy" create page and its edit
// dialog) has a second instructions composer with its own layout, so it does
// not render the unified form's picker or rows. It gets the same model+effort
// pair and start-option rows spliced into its composer. The model picker
// wrapper is published on the global by its own chunk; this page imports that
// chunk for side effects only.
const routineEpitaxyPatchId = "routine-epitaxy-start-options";
const routineModelPickerPublishPatchId = "routine-model-picker-publish";
// A tenant's Code sessions run on `session_host`, whose permission-mode list is
// hardcoded without bypass (the cloud service disallowed it). The deployment's
// VM is the operator's own sandbox, so bypass is offered here; the entitlement
// below makes the renderer's availability check answer on, and this list is
// what the mode picker can actually choose from.
const codeBypassPermissionListPatchId = "code-bypass-permission-list";
const codeBypassAvailabilityPatchId = "code-bypass-availability";
// The Code composer's mode list is built per environment kind. A self-hosted
// place arrives as `byoc`/`pool`, and that branch builds its list without ever
// passing the bypass flag (and falls back to the remote list when the backend
// publishes no modes), so bypass is unreachable there however the availability
// predicate answers. This splice appends it to that branch's result when the
// predicate says available.
const codeBypassSelfHostedModesPatchId = "code-bypass-self-hosted-modes";
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
// `remoteProjectsEnabled` — the capability that makes the picker the claude.ai
// project picker rather than a folder picker. The Desktop build reads the atrium
// feature and then answers a module constant it never assigns, exactly as the
// projects predicate above does:
//
//   function remoteProjectsEnabled(){ return read("yukon_silver_dramatic_shrimp_atrium"), FA }
//   var FA = !1;
//
// The comma sequence is the fold: the read happens and is thrown away, so the
// capability answers false however the deployment's feature table reads. Three
// things in the picker are switched on it — `showProjects` (which the patch above
// has to force instead), `showFilterSort` (the search box's "Filter and sort"
// button), and, through `atriumCreate`, whether `onCreateProject` is handed down
// at all — which is both the "New project" row and the arm of the placeholder
// ternary that reads "Search or create a project". Splicing the sequence down to
// the read itself restores claude.ai's answer without moving the read: it stays
// in the same expression position, so hook order is unchanged. The function is
// pinned by the feature-name literal, which the bundle spells only here, and by
// the two-expression sequence's shape, so an unrelated sequence cannot match.
// Spliced only in web-shell mode, and not required.
const projectsAtriumPatchId = "web-projects-atrium";
const projectsAtriumFeature = "yukon_silver_dramatic_shrimp_atrium";
// The predicate every *server-side* project query is gated on. claude.ai's
// projects are not a surface this deployment has: the routes are
// `GET /api/organizations/<org>/projects_v2` (a creator list, a starred one, an
// overflow page, a `uuids=` batch, a prefetch), the bridge forwards none of them,
// and the platform refuses the family anyway — the Desktop answers
// `custom_3p_not_available` for the org routes it does carry.
//
//   function serverProjectsAvailable() {
//     let { activeOrganization } = useSession(), plan = projectsPredicate(),
//         probe = accountProbe().isAvailable;
//     return !!activeOrganization && plan && probe;
//   }
//
// It is read in two places, and both are the whole of the surface: the projects
// page passes it as the list query's `enabled` (and prefetches behind it), so a
// false stops the request outright, and the composer picker's report component
// passes it to its project queries, so a false makes it report the module's
// `NO_PROJECTS` constant — empty, not loading, not failed. With the queries
// unsent the picker stops skeleton-drawing, the page stops asking, and the
// projects this deployment actually has — the Desktop's **spaces**, which reach
// the composer as folder targets marked `isProject` under the folders gate —
// are what the surfaces draw. Splicing the returned expression keeps the
// declarators, which is where the hooks are, so hook order is unchanged. Pinned
// as a zero-argument function returning an `&&` chain whose last operand is a
// call's `isAvailable` — the account probe — which is the shape no other
// predicate in the graph has. Spliced only in web-shell mode, and not required:
// a bundle that no longer matches leaves the requests to 404 as they do today.
const projectsServerProjectsPatchId = "web-projects-remote-list";
const projectsServerProjectsOff = "!1";
// The flag that makes a local Cowork session *writable*. Every session-scoped
// control — the permission picker, the model picker, stop, retry — is handed its
// setter only when the session reports writable:
//
//   let writable = cr("hub", coworkMode.orgAvailable, hubVerdict.served)
//                  || amberTributaryHeron.enabled;          // ← this one
//   remoteGates = { isWritable: writable && !readOnly, readOnly, … };
//
// and the same two terms decide the session context's own
// `canSetModel`/`setPermissionMode`. `cr` is `t || (surface === "hub" && n)`, so
// the flag is the last term of a disjunction whose other two are server verdicts
// this deployment does not serve: without it, session pages come out read-only,
// the pickers draw (a binding exists) and every click lands in the no-op the
// bundle installs for that case — `setPermissionMode: … ?? bb` with
// `function bb(){}` — silently, which is exactly how a dead permission picker
// looks next to a composer that still sends.
//
// The build folds the flag to a constant, as it does the atrium capability:
//
//   var heron = !1;
//   function amberTributaryHeron(){ return read("amber_tributary_heron"),
//                                         {enabled: heron} }
//
// so the read is discarded and `enabled` answers false however the deployment's
// table reads. The patch rebuilds the returned object around the read itself —
// one read, in the position it already occupied — which is what makes the
// bridge's grant of that gate observable. Both ship together, as with the
// atrium. Pinned by the feature-name literal, which the bundle spells only here,
// and by the object's single `enabled` identifier. Spliced only in web-shell
// mode, and not required.
const coworkHubWritablePatchId = "web-cowork-hub-writable";
const coworkHubWritableFeature = "amber_tributary_heron";
// Turning the predicate off stops the requests, and react-query then answers
// `isPending` for a query nobody enabled — a disabled query is pending in v5
// until it has data. Both consumers that read that state would wait on it
// forever, so each reports the list as settled and empty instead.
//
// The composer picker's report component builds five keys from the queries:
//
//   te = memo(() => r
//     ? { browse: ee, browseLoading: W, all: A, allLoading: !k && !E, failed: V || E }
//     : NO_PROJECTS, […]);
//
// — the three computed terms are what it walks back up to the picker, and with
// `k` (a settled gate over an answer that never settles) false, `allLoading`
// comes out true however the predicate reads. The page's list hook reports the
// same queries beside the spaces it draws:
//
//   return { projects: …, isInitialLoading: m || S || E && ee, hasMore: …,
//            isPending: m, chatProjectsEnabled: d, chatProjectsLoading: v, … };
//
// — `m` is that same pending, and it is what leaves the page on its skeleton
// cards. Both are forced to the settled answer, which is also the true one here:
// this deployment has no server-side projects, and the projects it does have are
// the Desktop's spaces, drawn from a different source entirely.
const projectsRemoteReportKeys = ["browse", "browseLoading", "all", "allLoading", "failed"];
const projectsRemoteReportForced = ["browseLoading", "allLoading", "failed"];
const projectsPageListKeys = ["chatProjectsError", "isInitialLoading", "isPending"];
const projectsPageListForced = ["isInitialLoading", "isPending", "chatProjectsLoading"];
const projectsRemoteSettled = "!1";
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
// The renderer's caught-error handler, made audible.
//
// React 19 creates its root with `{onCaughtError, onRecoverableError}`, and this
// bundle hands `onCaughtError` the app's own reporter — which does not log. So a
// render error caught by an error boundary reaches neither the console nor the
// network: the only thing anyone sees is the crash page, whose error code is a
// **hash** of the error's `name:message` (`shared-21-CGGmSsMS.js`: djb2 over the
// message with uuids/urls/chunk names and every 1–3 character token normalized
// away, printed base-36). That is a dead end in the web shell specifically:
// there is no Electron log to read, the shipped bundle has no React DevTools
// hook, and a `window.onerror` listener never fires because React swallowed the
// error first. Wrapping the handler restores the one thing React's default
// gives — the error and its component stack on the console — before the app's
// own reporting runs.
//
// Pinned by the option's own property names, which the minifier leaves alone:
// React itself only ever *reads* the member (`options.onCaughtError`), so a
// Property of that name is a root's own option wherever it appears, and the
// sibling `onRecoverableError` is required so a like-named field elsewhere
// cannot match. Emitted only when exactly one such option is in the chunk.
// Spliced only in web-shell mode, and not required: a bundle that no longer
// matches leaves the silent handler rather than failing preparation.
const crashLogPatchId = "web-crash-log";
const crashLogOption = "onCaughtError";
const crashLogSiblingOption = "onRecoverableError";
// A tenant's Code runs on its self-hosted runner, but it is still work on a
// *folder*, a branch and (optionally) an isolated worktree — the same three
// start options Desktop's local composer offers. The renderer withholds them
// from a self-hosted place twice over:
//
//   * three identical "place kind" switches (folder-bearing, worktree-capable,
//     draft-owning) answer true only for local/ssh/wsl, so a self-hosted
//     place renders no folder/branch/worktree strip at all;
//   * the branch-read hook only reads git info for `envType === "local"`.
//
// A self-hosted place reaches the composer as `pool` (a pool worker), `byoc`
// (the pool advertised as an environment) or — when the worker names an
// environment id the list has not resolved — the renderer's `anthropic_cloud`
// fallback. A tenant has no hosted cloud place, so all three are treated the
// same by these patches.
//
// `web-code-selfhosted-place-kind` rewrites those three switches so `byoc` and
// `pool` join the true arm (the false arm keeps bridge/cloud/project), and
// `web-code-selfhosted-branch-read` widens the `"local"` test to the two
// self-hosted kinds. Both are pinned by the switches' exact case set and the
// branch hook's returned object keys, and spliced only for a tenant generation:
// on the operator's own instance a self-hosted place is never offered, and on a
// non-web-shell client these paths are not used.
const placeKindPatchId = "web-code-selfhosted-place-kind";
// `needsFolder` is `folderKind(envType) && !noSessionRunsOnThisDevice`: the
// second term is the "this device cannot run sessions" policy, true whenever
// the managed config answers `noSessionRunsOnThisDevice`. For a self-hosted
// place that term is irrelevant — the session does not run on this device at
// all — but the renderer still ANDs it, so the folder/branch/worktree strip
// stays hidden even with the first term patched. This splice keeps the flag's
// effect for local/ssh/wsl and drops it for byoc/pool.
const needsFolderPatchId = "web-code-selfhosted-needs-folder";
// The strip's own gate in the composer:
//   needsFolder && !(rail && (localKind || envType === "ssh")) && <FolderStrip/>
// `needsFolder` is read from the *draft options* here, not from the core, and a
// draft that never received the published options falls back to the static
// defaults (`needsFolder: false`) — which kept the strip unmounted even after
// the core's value was patched. The flag is also sensitive to the env kind,
// and a self-hosted place can arrive under three spellings. The patch is
// tenant-only, where every Code place is the self-hosted runner and no local
// session exists, so the whole condition is forced `!0`: the strip always
// draws. Its data props (folder, branch, worktree) come from the core, which
// the other splices already cover.
const stripPatchId = "web-code-selfhosted-strip";
const placeKindTrueCases = ["local", "ssh", "wsl"];
const placeKindFalseCases = ["bridge", "anthropic_cloud", "byoc", "pool", "project"];
// The kinds a tenant's Code composer can see for its self-hosted runner. A pool
// worker answers `pool`; the pool advertised as a `byoc` environment answers
// `byoc`; and the renderer falls back to `anthropic_cloud` when the worker names
// an environment id the env list has not resolved (its default `e?.kind==="byoc"
// : "anthropic_cloud" tail). A tenant has no hosted cloud place at all, so all
// three mean the same thing here.
const selfHostedKinds = ["anthropic_cloud", "byoc", "pool"];
const branchReadPatchId = "web-code-selfhosted-branch-read";
// The start intent and the create body. `tV` already receives the composer's
// selected folder, worktree toggle and selected branch, but the `byoc`/`pool`
// arms drop them; `VA` builds the create body's `session_context`, which `tO`
// turns into the wire `config` — `tO` forwards `cwd` today, so only
// `source_branch` and `use_worktree` are missing there. The two patches carry
// the three values from the draft through to the wire; the bridge and the guest
// runner do the rest. Pinned by the intent builder's own byoc/pool cases, the
// create serializer's `session_context` return, and the config mapper's
// `cwd: ctx.cwd` return.
const selfHostedIntentPatchId = "web-code-selfhosted-intent";
const selfHostedCreatePatchId = "web-code-selfhosted-create";
// The Code composer's folder picker. `browseFolder` opens the in-page picker,
// which lists the bridge's workspace mount on the host. For a tenant's Code the
// listing must come from inside the Cowork VM (the guest runner answers it), so
// the wrapper prefers `browseCodeFolder` when the preload publishes it and falls
// back to `browseFolder` otherwise. Pinned by the two-statement function whose
// first declaration reads `?.browseFolder` and whose second returns through it.
const selfHostedFolderPickerPatchId = "web-code-selfhosted-folder-picker";
// The chunk loader's URL builder. Vite's preload helper joins dependency names
// with `"/"` — an absolute `/assets/…` URL regardless of the entry module's own
// path. That splits the browser's graph (the entry under a release path, lazy
// chunks at the root), and at the root those URLs are cached immutably across
// releases, so a newly prepared chunk is never re-fetched. The patch prefixes
// the same base the entry document uses (`__CLAUDESK_ASSET_BASE__`, set by the
// remote preload from the bootstrap), keeping one versioned namespace for every
// module. In the Desktop frame the global is absent, so it answers "/"+dep
// exactly as before. There are three copies of this helper in the graph
// (preload-helper and two inlined copies), and every one is spliced.
const assetBasePatchId = "web-shell-asset-base";
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
// A React root's `onCaughtError` option, read back from the graph. The test is
// the two property names plus the shape: the parent must be an object literal
// carrying the sibling `onRecoverableError` beside it (that pair is how a root's
// options are spelled), and the value must be something callable — an identifier
// or a function expression. React's own internals only ever *read* these
// members, so a Property of this name cannot be React's.
function crashLogOptionTarget(node, ancestors) {
  if (node.type !== "Property" || node.computed) return undefined;
  const name = node.key?.name ?? node.key?.value;
  if (name !== crashLogOption) return undefined;
  const owner = ancestors.at(-1);
  if (owner?.type !== "ObjectExpression") return undefined;
  if (!owner.properties.some(entry => entry !== node && key(entry, crashLogSiblingOption))) {
    return undefined;
  }
  const value = unwrap(node.value);
  if (!functionTypes.has(value?.type) && value?.type !== "Identifier") return undefined;
  return node;
}

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

// The session list's Code gate: the function the recents builder calls with
// `{activeMode, codeFoldedIntoHome, requested}` and whose whole body returns
// the disjunction `activeMode === "code" || codeFoldedIntoHome || requested`.
// The identifier bound to `requested` is returned for the caller to force false
// (see chatListNoCodePatchId). Any other name set, a different operand count,
// or a body that is not that single return refuses rather than splice over the
// closest-looking function.
function chatListNoCodeTarget(node) {
  if (!functionTypes.has(node.type) || node.params.length !== 1) return undefined;
  const pattern = node.params[0];
  if (pattern?.type !== "ObjectPattern") return undefined;
  const bindings = new Map();
  for (const entry of pattern.properties) {
    if (entry.type !== "Property" || entry.computed === true) return undefined;
    const name = entry.key?.type === "Identifier" ? entry.key.name
      : entry.key?.type === "Literal" ? entry.key.value : undefined;
    if (typeof name !== "string" || entry.value?.type !== "Identifier") return undefined;
    bindings.set(name, entry.value.name);
  }
  if (bindings.size !== 3) return undefined;
  const activeMode = bindings.get("activeMode");
  const codeFoldedIntoHome = bindings.get("codeFoldedIntoHome");
  const requested = bindings.get("requested");
  if (!activeMode || !codeFoldedIntoHome || !requested) return undefined;
  const body = node.body;
  if (body?.type !== "BlockStatement" || body.body.length !== 1) return undefined;
  const [statement] = body.body;
  if (statement.type !== "ReturnStatement") return undefined;
  const operands = flattenLogical(statement.argument, "||");
  if (operands.length !== 3) return undefined;
  const identifiers = operands.flatMap(operand => {
    const name = identifier(operand);
    return name ? [name] : [];
  });
  if (identifiers.length !== 2 || !identifiers.includes(codeFoldedIntoHome)
    || !identifiers.includes(requested)) return undefined;
  const modeClauses = operands.filter(operand => operand.type === "BinaryExpression"
    && ["===", "=="].includes(operand.operator)
    && (identifier(operand.left) === activeMode && literal(operand.right, "code")
      || identifier(operand.right) === activeMode && literal(operand.left, "code")));
  if (modeClauses.length !== 1) return undefined;
  return operands.find(operand => identifier(operand) === requested);
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

// The Code session subscription's options object: the `subscribeSse` property
// names the live transport. Only a property of an object *expression* whose
// value is a plain expression qualifies — the hook's own signature carries the
// same key as a destructuring binding with a default (`subscribeSse:l=!1`),
// where a splice would not even parse, and a shorthand property carries no
// transport read to replace.
function subscribeSseProperty(node, ancestors) {
  if (node.type !== "Property" || node.computed || node.shorthand) return false;
  const parent = ancestors[ancestors.length - 1];
  if (!parent || parent.type !== "ObjectExpression") return false;
  const name = node.key.type === "Identifier" ? node.key.name
    : node.key.type === "Literal" ? node.key.value : null;
  if (name !== "subscribeSse") return false;
  const value = node.value;
  if (!value) return false;
  if (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression") return false;
  return value;
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

// The atrium capability's folded read: a function whose whole body returns the
// two-expression comma sequence — the feature read, then the identifier the build
// folds the answer to. Returns that sequence, the only part the patch rewrites.
function projectsAtriumTarget(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") return;
    const statements = node.body.body;
    if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return;
    const sequence = unwrap(statements[0].argument);
    if (sequence?.type !== "SequenceExpression" || sequence.expressions.length !== 2) return;
    const [read, folded] = sequence.expressions;
    if (read?.type !== "CallExpression" || read.arguments.length !== 1) return;
    if (!literal(read.arguments[0], projectsAtriumFeature)) return;
    if (folded.type !== "Identifier") return;
    found.push(sequence);
  });
  return found.length === 1 ? found[0] : undefined;
}

// The server-projects predicate. `let first = …, probe = read().isAvailable;
// return a && b && probe` is how this bundle spells *every* capability
// predicate — the search one, the Cowork one, another feature's — so the shape
// alone would match four of them. What separates this one is what it reads: the
// account's active organization (the same `activeOrganization` destructuring the
// rest of the chrome uses) beside the probe, and a three-operand chain ending in
// the probe rather than the two the others have. Exactly one function in the
// bundle matches, which is asserted by the smoke fixture.
function projectsServerProjectsTarget(ast) {
  const isProbe = (node) => {
    const member = unwrap(node);
    return member?.type === "MemberExpression" && identifier(member.property) === "isAvailable"
      && unwrap(member.object)?.type === "CallExpression";
  };
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.params.length !== 0) return;
    const statements = node.body?.body;
    if (statements?.length !== 2) return;
    const [declaration, returned] = statements;
    if (declaration.type !== "VariableDeclaration" || returned.type !== "ReturnStatement") return;
    const [account] = declaration.declarations;
    if (declaration.declarations.length !== 3 || account.id?.type !== "ObjectPattern") return;
    if (!account.id.properties.some(entry =>
      (entry.key?.name ?? entry.key?.value) === "activeOrganization")) return;
    const probe = declaration.declarations
      .filter(entry => entry.id?.type === "Identifier" && isProbe(entry.init))
      .map(entry => entry.id.name);
    if (probe.length !== 1) return;
    const operands = flattenLogical(returned.argument, "&&");
    if (operands.length !== 3 || identifier(operands.at(-1)) !== probe[0]) return;
    found.push(returned.argument);
  });
  return found.length === 1 ? found[0] : undefined;
}

// The hub-writable flag's folded reads. The bundle spells the same fold twice —
// `amberTributaryHeron()` and its `_`-prefixed twin, both `read(feature),
// {enabled: heron}` off the same constant — so every function of that shape is
// spliced, and a chunk carrying none is left alone.
function coworkHubWritableTargets(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "FunctionDeclaration" || node.params.length !== 0) return;
    const statements = node.body?.body;
    if (statements?.length !== 1 || statements[0].type !== "ReturnStatement") return;
    const sequence = unwrap(statements[0].argument);
    if (sequence?.type !== "SequenceExpression" || sequence.expressions.length !== 2) return;
    const [read, answered] = sequence.expressions;
    if (read?.type !== "CallExpression" || read.arguments.length !== 1) return;
    if (!literal(read.arguments[0], coworkHubWritableFeature)) return;
    const object = unwrap(answered);
    if (object?.type !== "ObjectExpression" || object.properties.length !== 1) return;
    if (!key(object.properties[0], "enabled")) return;
    if (object.properties[0].value?.type !== "Identifier") return;
    found.push({ sequence, read });
  });
  return found;
}

// The picker's server-projects report, and the keys of it the patch forces. The
// module's own "no projects" constant carries the same five keys, so the report
// is the one whose `allLoading` is computed — `!k && !E`, where the constant
// answers the minified `!1` the same key holds there.
function projectsRemoteReportTarget(ast) {
  const reports = [];
  walk(ast, [], (node) => {
    if (node.type !== "ObjectExpression") return;
    const keys = node.properties.filter(entry => entry.type === "Property")
      .map(entry => entry.key.name ?? entry.key.value);
    if (keys.length !== projectsRemoteReportKeys.length) return;
    if (!projectsRemoteReportKeys.every(name => keys.includes(name))) return;
    if (!node.properties.some(entry => key(entry, "allLoading")
      && unwrap(entry.value)?.type === "LogicalExpression")) return;
    reports.push(node);
  });
  return reports.length === 1 ? reports[0] : undefined;
}

// The projects page's list hook, pinned by the three `chatProjects*` keys only it
// reports. Returns the returned object; its loading terms are what the patch
// forces.
function projectsPageListTarget(ast) {
  const found = [];
  walk(ast, [], (node) => {
    if (node.type !== "ObjectExpression") return;
    const keys = node.properties.filter(entry => entry.type === "Property")
      .map(entry => entry.key.name ?? entry.key.value);
    if (!projectsPageListKeys.every(name => keys.includes(name))) return;
    found.push(node);
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

// Which chunks of ion-dist are worth parsing at all.
//
// This is an optimization, and a pure one: every acceptance below is decided on
// parsed nodes, so the only thing a needle can do is decide whether a chunk is
// looked at. It is the difference between parsing the handful of chunks that
// carry a target and parsing all 3372 chunks of ion-dist (113 MB, tens of
// seconds of acorn on every container start). Each needle is therefore anchored
// on a literal its own detector *requires*, so a chunk that would produce the
// patch necessarily contains it.
//
// It is deliberately NOT applied inside `inspectRenderer`, which stays a pure
// function of one chunk. The preparer is the only caller that has a real file
// list to narrow, and the smoke suites drive the patcher with small synthetic
// fixtures that no needle could describe — a filter in here would silently skip
// them and turn every one of those assertions into a no-op.
//
// Two ways this goes wrong, and both are silent:
//
//   * A trailing `|` is an empty alternative, which matches every string and
//     disables the filter entirely — putting the whole ion-dist back through
//     acorn while every test still passes. It has happened: a commit appended
//     `voyage_composer_marlin|` to a line that already ended in `|`.
//     scripts/renderer-prefilter-smoke.mjs fails on a degenerate regex.
//   * A generic word pulls in every vendor chunk that merely mentions it.
//     `protocol` alone matched 206 files and 37 MB, `onEdit` 85 and 25 MB,
//     `sessionRef` 59 and 9.5 MB, bare `rewind` 54 and 18 MB — and those chunks
//     parse to nothing. All four are now anchored on their detector's own
//     literal (`must use https (or http on loopback)`, `"onEdit"`, `"app:"`,
//     `rewindV2`/`rewindSession unavailable`).
//
// `keyCode` is the one deliberately broad needle, and it is the floor: the IME
// capability marker is a `keyCode === 229` comparison, which input-handling
// chunks legitimately contain all over the renderer, so every one of the 47
// must be parsed for the marker's evidence to be recorded. It costs ~19 MB of
// the ~25 MB this filter lets through; the other 19 needles together account
// for the rest.
export const prefilterNeedles = [
  // Capability markers.
  "rewindSession unavailable", // cowork-native-rewind
  "rewindV2", // code-native-rewind-v2
  "keyCode", // ime-keycode-229 (broad by nature; see above)
  '"onEdit"', // native-message-edit
  // Required patches.
  "fileView", // file-pane download: the pane's own file-kind selector
  "native-file-preview-error", // file-pane preview: the DeclineReason test id
  'when==="desktop"', // route alias
  "not_desktop_app", // session viewer gate
  "avatar_image_url", // account chip avatar
  'must use https (or http on loopback)', // gateway URL host rule
  '"app:"', // the two gateway-setup guards
  // Web-shell patches.
  "principalDisplayName", // account menu name
  "signOut", // account sign-out row
  "DesktopChecks", // scheduled task hosts
  "dramatic_shrimp_force_local", // local session placement
  "claudeai.notification.permission.result", // notification enable
  "data-compact-mode-switcher", // titlebar mode picker
  "Local scheduled tasks can only run", // scheduled task runner
  "stringsVouched", // home layout assignment
  "subscribeSse", // Code session live transport (web-code-subscribe-sse)
  "codeFoldedIntoHome", // the session list's Code gate (web-chat-session-list-no-code)
  "voyage_composer_marlin", // unified-composer design predicates
  "claude_ai_projects_limits", // projects-allowed predicate
  "yukon_silver_dramatic_shrimp_atrium", // composer picker's atrium capability
  "chatProjectsError", // the projects page's list hook, which the report patch forces
  "onCaughtError", // the crash-log root option (two chunks: the entry and react-dom)
  "api-staging.anthropic.com", // routine API card fire origin (routine-fire-origin)
  'case"local":case"ssh":case"wsl":return!0', // the three place-kind switches
  "gitRepoUrls:e.gitRepoUrls.slice()", // start intent + create args (self-hosted options)
  "session_context:{sources:w,outcomes:T", // create serializer + wire mapper
  "browseFolder;if(n)return", // the Code composer's folder-pick helper
  'return"/"+', // the Vite chunk loader's URL builder (web-shell asset base)
  // Routine form: model/effort picker, start options (cwd, permission mode)
  // and the job-config parser that carries them through an edit.
  "Describe what Claude should do in each session",
  "routine-composer-status",
  "autofixOnPrCreate:void 0",
  // Bypass permissions availability and the session-host mode list.
  "bypassPermissionsPrefEnabled",
  "permission_modes:{available:",
  '_R=["default","acceptEdits","plan","auto"]',
];

// Every needle is a literal substring, so it is escaped before it reaches the
// alternation. Joining them raw makes a needle's own punctuation regex syntax:
// `must use https (or http on loopback)` then matches `must use https or http
// on loopback`, its parentheses read as a group, and the chunk it was added for
// is filtered out — losing the patch with nothing to show for it.
const escapeLiteral = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A needle that spells a quoted string is also matched with the other quote
// character. Which one a chunk uses is the minifier's choice, not ours, so a
// needle carrying only `"` filters out the chunk it exists for the day the
// compiler switches to `'` — silently, since the patch simply stops being
// applied. On the official build every quoted needle happens to be
// double-quoted, so the twin matches nothing today and costs nothing; the
// minified fixtures in renderer-patches-smoke.mjs exercise both styles.
const quoteVariants = (needle) => (needle.includes('"') ? [needle, needle.replaceAll('"', "'")] : [needle]);

const prefilter = new RegExp(
  prefilterNeedles.flatMap(quoteVariants).map(escapeLiteral).join("|"),
);

// Exported so the preparer can pick the chunks a worker pool has to look at
// without re-deriving the predicate — one definition, so a worker can never be
// handed a different candidate set than the preparer itself would choose.
export const rendererPrefilter = prefilter;

// `tenantEnabled` marks one account's own instance (CLAUDESK_TENANT). It takes
// the same renderer as the deployment's own instance: the browser must resolve
// `/code` to the surface this bridge drives, so the route alias is spliced
// there too. What keeps an account's Code off its container is not the route
// name but the environment list (only the self-hosted pool is advertised) and
// the LocalSessions guard. Withholding the alias sent the browser to ion-dist's
// cloud branch, a second Code implementation whose loading state the bridge
// does not fill — the page sat on its skeleton. The tenant flag remains a
// generation input so an account never adopts a generation prepared before the
// start-option patches. See docs/code-in-cowork-vm.md.
// The conditional that picks the cloud routine fire origin. Both arms are the
// literal origins, and it is the only such conditional in the bundle — the
// caller replaces the whole expression with this deployment's origin.
function routineFireOriginTarget(node) {
  if (node.type !== "ReturnStatement" || !node.argument) return null;
  const argument = unwrap(node.argument);
  if (!argument || argument.type !== "ConditionalExpression") return null;
  const arms = [argument.consequent, argument.alternate]
    .filter(arm => arm?.type === "Literal" && typeof arm.value === "string")
    .map(arm => arm.value);
  if (!arms.includes(routineFireCloudOrigin)) return null;
  if (!arms.includes(routineFireStagingOrigin)) return null;
  return argument;
}

// --- Self-hosted Code start options (tenant web shell) -----------------------
//
// The three selectors below find the pieces the `web-code-selfhosted-*` patches
// splice. They are structural: the minifier's names are read back from the same
// graph, so only the shipping shapes match.

// The first parameter's destructured bindings: property name -> local name.
function firstParamBindings(node) {
  const param = node?.params?.[0];
  if (param?.type !== "ObjectPattern") return undefined;
  const bindings = new Map();
  for (const entry of param.properties) {
    if (entry.type !== "Property") continue;
    const name = entry.key.name ?? entry.key.value;
    if (typeof name === "string" && entry.value?.type === "Identifier") {
      bindings.set(name, entry.value.name);
    }
  }
  return { param, bindings };
}

function objectMember(node, name) {
  return node?.type === "ObjectExpression"
    ? node.properties.find(entry => key(entry, name)) : undefined;
}

// The minifier writes booleans as `!0` / `!1`; both that and a plain literal
// answer the same value.
function booleanLiteral(node) {
  node = unwrap(node);
  if (node?.type === "Literal" && typeof node.value === "boolean") return node.value;
  if (node?.type === "UnaryExpression" && node.operator === "!") {
    const argument = unwrap(node.argument);
    if (literal(argument, 0)) return true;
    if (literal(argument, 1)) return false;
  }
  return undefined;
}

// Group a switch's cases back into one entry per returned arm: the minifier
// emits `case"local":case"ssh":case"wsl":return!0` as three SwitchCases, only
// the last of which carries the consequent.
function switchArms(statement) {
  const arms = [];
  let tests = [];
  for (const entry of statement.cases) {
    if (entry.test !== null) tests.push(entry.test.value);
    if (entry.consequent.length) {
      arms.push({ tests, consequent: entry.consequent });
      tests = [];
    }
  }
  if (tests.length) arms.push({ tests, consequent: [] });
  return arms;
}

// The three "place kind" switches. Each is a one-parameter function whose whole
// body is `switch (param)`, true for local/ssh/wsl and false for
// bridge/anthropic_cloud/byoc/pool/project. Pinned by that exact case set, so
// the lookalike predicates in the same chunk (which answer different sets, or
// carry a default) cannot match.
function placeKindSwitchTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  if (node.params.length !== 1 || node.params[0].type !== "Identifier") return undefined;
  const statements = node.body.body;
  if (statements.length !== 1 || statements[0].type !== "SwitchStatement") return undefined;
  const statement = statements[0];
  if (identifier(statement.discriminant) !== node.params[0].name) return undefined;
  if (statement.cases.some(entry => entry.test === null)) return undefined;
  const arms = switchArms(statement);
  if (arms.length !== 2) return undefined;
  const same = (left, right) => left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
  const [truthy, falsy] = arms;
  if (!same(truthy.tests, placeKindTrueCases) || !same(falsy.tests, placeKindFalseCases)) {
    return undefined;
  }
  const returns = (arm, expected) => {
    const [statement] = arm.consequent;
    return arm.consequent.length === 1 && statement.type === "ReturnStatement"
      && booleanLiteral(statement.argument) === expected;
  };
  if (!returns(truthy, true) || !returns(falsy, false)) return undefined;
  return { statement, name: node.id?.name };
}

// The `needsFolder` composition beside those switches:
// `return folderKind(envType) && !noSessionRunsOnThisDevice`. The callee must
// resolve to one of the place-kind switches found in this chunk, so an
// unrelated `a && !b` cannot match; the returned clause is the flag negation
// the caller widens.
function needsFolderClauseTarget(node, switchNames) {
  if (node.type !== "FunctionDeclaration" || !node.id) return undefined;
  if (node.params.length !== 2) return undefined;
  const [env, flag] = node.params;
  if (env?.type !== "Identifier" || flag?.type !== "Identifier") return undefined;
  const statements = node.body?.body;
  if (statements?.length !== 1 || statements[0].type !== "ReturnStatement") {
    return undefined;
  }
  const expression = unwrap(statements[0].argument);
  if (expression?.type !== "LogicalExpression" || expression.operator !== "&&") {
    return undefined;
  }
  const call = unwrap(expression.left);
  if (call?.type !== "CallExpression" || call.arguments.length !== 1) return undefined;
  if (!switchNames.includes(identifier(call.callee))) return undefined;
  if (identifier(call.arguments[0]) !== env.name) return undefined;
  const clause = unwrap(expression.right);
  if (clause?.type !== "UnaryExpression" || clause.operator !== "!"
    || identifier(clause.argument) !== flag.name) {
    return undefined;
  }
  return { clause, env: env.name, flag: flag.name };
}

function placeKindReplacement(source, statement) {
  const labels = tests => tests.map(value => `case${JSON.stringify(value)}:`).join("");
  const consequent = (arm) => {
    const text = source.slice(arm.consequent[0].start, arm.consequent.at(-1).end);
    return text.endsWith(";") ? text : `${text};`;
  };
  const [truthy, falsy] = switchArms(statement);
  const discriminant = source.slice(statement.discriminant.start,
    statement.discriminant.end);
  const truthyCases = [...placeKindTrueCases, ...selfHostedKinds];
  const falsyCases = falsy.tests.filter(value => !selfHostedKinds.includes(value));
  return `switch(${discriminant}){${labels(truthyCases)}${consequent(truthy)}`
    + `${labels(falsyCases)}${consequent(falsy)}}`;
}

// The branch-read hook (`xK`): its returned object carries the branch/worktree
// API, and it picks the folder whose git state it reads with one conditional
// `envType === "local" ? folder : null`. Returns that test, so the caller can
// widen it to the self-hosted kinds.
function selfHostedBranchReadTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  if (node.params.length !== 1 || node.params[0].type !== "ObjectPattern") {
    return undefined;
  }
  const last = node.body.body.at(-1);
  if (last?.type !== "ReturnStatement") return undefined;
  const returned = unwrap(last.argument);
  if (returned?.type !== "ObjectExpression") return undefined;
  const required = ["worktree", "worktreeSupported", "isGitRepo", "displayBranch",
    "sourceBranch", "handleSelectSourceBranch"];
  if (!required.every(name => objectMember(returned, name))) return undefined;
  const params = firstParamBindings(node);
  const env = params?.bindings.get("envType");
  if (!env) return undefined;
  // The only `envType === "local" ? folder : null` in the hook selects the
  // folder whose git state is read.
  const tests = [];
  walk(node.body, [], (child) => {
    if (child.type !== "ConditionalExpression") return;
    if (!literal(child.alternate, null) || !comparesTo(child.test, "local")) return;
    if (!contains(child.test, term => identifier(term) === env)) return;
    tests.push(child.test);
  });
  return tests.length === 1 ? tests[0] : undefined;
}

// The start-intent builder (`tV`): its byoc and pool arms return an object with
// `kind: "cloud"` / `kind: "pool"` (the blocked answer is `kind: "blocked"`),
// and the function already receives selectedFolder/useWorktree/displayBranch/
// sourceBranch. Returns those two objects plus the bindings to splice.
function selfHostedIntentTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  const params = firstParamBindings(node);
  if (!params) return undefined;
  const env = params.bindings.get("envType");
  const required = ["selectedFolder", "useWorktree", "displayBranch", "sourceBranch"];
  if (!env || required.some(name => !params.bindings.has(name))) return undefined;
  let switchStatement;
  walk(node, [], (child) => {
    if (!switchStatement && child.type === "SwitchStatement"
      && identifier(child.discriminant) === env) {
      switchStatement = child;
    }
  });
  if (!switchStatement) return undefined;
  const objects = [];
  for (const entry of switchStatement.cases) {
    const kind = typeof entry.test?.value === "string" ? entry.test.value : "";
    if (!selfHostedKinds.includes(kind)) continue;
    const expected = kind === "pool" ? "pool" : "cloud";
    const matches = [];
    for (const statement of entry.consequent) {
      walk(statement, [], (child) => {
        if (child.type !== "ObjectExpression") return;
        const member = objectMember(child, "kind");
        if (member && literal(member.value, expected)) matches.push(child);
      });
    }
    if (matches.length !== 1) return undefined;
    objects.push(matches[0]);
  }
  return objects.length === selfHostedKinds.length
    ? { objects, bindings: params.bindings } : undefined;
}

function selfHostedIntentReplacement(source, target) {
  const { bindings } = target;
  const folder = bindings.get("selectedFolder");
  const worktree = bindings.get("useWorktree");
  const display = bindings.get("displayBranch");
  const sourceBranch = bindings.get("sourceBranch");
  const selected = `${worktree}?${display}:${sourceBranch}`;
  return `,...(${folder}&&{cwd:${folder}})`
    + `,...(${folder}&&${worktree}&&{useWorktree:!0})`
    + `,...(${folder}&&(${selected})&&{sourceBranch:${selected}})`;
}

// The create serializer (`VA` in shared-100): the function whose first
// parameter destructures `worker`/`gitRepoUrls`/`sourceBranch` and whose return
// carries a `session_context` object with `sources` and `outcomes`. The return
// value is the `session_context` body plus the param pattern, so the caller can
// bind the two new values and spread them in.
function selfHostedCreateTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  const params = firstParamBindings(node);
  if (!params) return undefined;
  const required = ["worker", "gitRepoUrls", "sourceBranch"];
  if (required.some(name => !params.bindings.has(name))) return undefined;
  let context;
  walk(node, [], (child) => {
    if (child.type !== "ReturnStatement") return;
    const returned = unwrap(child.argument);
    const member = objectMember(returned, "session_context");
    if (member?.value?.type === "ObjectExpression") context = member.value;
  });
  if (!context) return undefined;
  if (!objectMember(context, "sources") || !objectMember(context, "outcomes")) {
    return undefined;
  }
  return { param: params.param, context, bindings: params.bindings };
}

// The wire mapper (`tO` in shared-100): its body reads `session_context` off
// the argument and returns `config` with `sources` and `cwd`. Pinned by the
// `cwd` member, which is the one this patch extends.
function selfHostedWireConfigTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  if (node.params.length !== 1) return undefined;
  const param = identifier(node.params[0]);
  if (!param) return undefined;
  let context;
  walk(node.body, [], (child) => {
    if (child.type !== "VariableDeclarator" || child.id?.type !== "Identifier") return;
    if (!property(child.init, "session_context")) return;
    if (identifier(child.init.object) === param) context = child.id.name;
  });
  if (!context) return undefined;
  let config;
  walk(node, [], (child) => {
    if (child.type !== "ReturnStatement") return;
    const returned = unwrap(child.argument);
    const member = objectMember(returned, "config");
    if (member?.value?.type === "ObjectExpression") config = member.value;
  });
  if (!config) return undefined;
  if (!objectMember(config, "sources") || !objectMember(config, "cwd")) return undefined;
  return { config, context };
}

// The strip's mount site: `<needsFolder> && !(rail && (localKind || envType ===
// "ssh")) && <FolderStrip …/>`. The element call is pinned by the three props
// only the strip takes (`onWorktreeChange`, `worktreeSupported`,
// `onSelectBranch`), its parent `&&` chain by the negation beside it; the
// returned flag is the draft's `needsFolder` operand, and `envType` is read
// back from the composer's own destructured parameter.
function selfHostedStripTarget(node, ancestors) {
  if (node.type !== "CallExpression") return undefined;
  const props = node.arguments?.find(argument => argument?.type === "ObjectExpression");
  if (!props) return undefined;
  for (const name of ["onWorktreeChange", "worktreeSupported", "onSelectBranch"]) {
    if (!props.properties.some(entry => key(entry, name))) return undefined;
  }
  const parent = ancestors?.at(-1);
  if (parent?.type !== "LogicalExpression" || parent.operator !== "&&"
    || unwrap(parent.right) !== node) {
    return undefined;
  }
  const condition = unwrap(parent.left);
  if (condition?.type !== "LogicalExpression" || condition.operator !== "&&") {
    return undefined;
  }
  const flag = unwrap(condition.left);
  if (flag?.type !== "Identifier") return undefined;
  const scope = [...(ancestors ?? [])].reverse()
    .find(candidate => functionTypes.has(candidate.type));
  const bindings = scope ? firstParamBindings(scope) : undefined;
  const env = bindings?.bindings.get("envType");
  if (!env) return undefined;
  return { condition, env, flag };
}

// The Code composer's folder-pick helper (`Sm` / `Cle`):
// `let n = fileSystem?.browseFolder; if (n) return wrap(() => n(...))`.
// Returns the initialiser and its receiver, so the caller can prefer
// `browseCodeFolder` on that same surface.
function selfHostedFolderPickerTarget(node) {
  if (!functionTypes.has(node.type) || node.body?.type !== "BlockStatement") {
    return undefined;
  }
  if (node.params.length !== 2) return undefined;
  const [first, second] = node.body.body;
  if (first?.type !== "VariableDeclaration" || first.declarations.length !== 1) {
    return undefined;
  }
  const init = first.declarations[0].init;
  const member = unwrap(init);
  if (!member || member.type !== "MemberExpression" || !property(member, "browseFolder")) {
    return undefined;
  }
  if (member.object?.type !== "Identifier") return undefined;
  if (second?.type !== "IfStatement"
    || !contains(second, (child) => child.type === "ReturnStatement")) {
    return undefined;
  }
  return { init, receiver: member.object };
}

// The Vite chunk loader's URL builder: `function (name) { return "/" + name }`.
// The whole function is pinned by that exact body, so a like-named helper that
// does anything else is not a target.
function assetBaseTarget(node) {
  if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") {
    return undefined;
  }
  const fn = node.init;
  if (!functionTypes.has(fn?.type) || fn.params.length !== 1) return undefined;
  const param = fn.params[0];
  if (param.type !== "Identifier") return undefined;
  const body = fn.body.type === "BlockStatement"
    ? (fn.body.body.length === 1 && fn.body.body[0].type === "ReturnStatement"
      ? fn.body.body[0].argument : undefined)
    : fn.body;
  if (body?.type !== "BinaryExpression" || body.operator !== "+") return undefined;
  if (!literal(body.left, "/") || identifier(body.right) !== param.name) {
    return undefined;
  }
  return { expression: body, param: param.name };
}

// The routine form's `availableCards` memo: `availableCards: useMemo(() =>
// cards.filter(e => e.type === "github" ? … : …), […])`. The returned node is
// the array the filter runs on; the caller appends the API card to it.
function routineApiTriggerTarget(node) {
  if (!key(node, "availableCards")) return undefined;
  const value = node.value;
  if (value?.type !== "CallExpression" || !value.arguments.length) return undefined;
  const arrow = unwrap(value.arguments[0]);
  if (arrow?.type !== "ArrowFunctionExpression") return undefined;
  const body = unwrap(arrow.body);
  if (body?.type !== "CallExpression") return undefined;
  if (!property(body.callee, "filter")) return undefined;
  const cards = body.callee.object;
  if (cards?.type !== "Identifier") return undefined;
  // Pin by the filter callback's own shape: a conditional whose test compares
  // to `"github"` (the routine card filter). A different `availableCards` memo
  // with a plain predicate is not a target.
  const callback = unwrap(body.arguments[0]);
  if (callback?.type !== "ArrowFunctionExpression") return undefined;
  const conditional = unwrap(callback.body);
  if (conditional?.type !== "ConditionalExpression") return undefined;
  if (!contains(conditional.test, child => literal(child, "github"))) return undefined;
  return cards;
}

// --- Routine form: model/effort picker and start options --------------------
//
// The routine form's model dropdown is the renderer's own `ModelSelector`
// wrapper, but it was built with `thinking:{type:"none"}` and no effort state.
// These selectors find the wrapper and the form-state hook by their shape, and
// the replacements extend them with the same pieces the Code composer feeds:
// each model's `thinking.effort_options`, a separate effort dropdown (which is
// `EffortControl`, the slider popup), and the routine's `cwd` / permission mode,
// which a Code scheduled task already stores.

// A one-parameter function whose destructured parameter carries every key.
function functionWithParamKeys(node, keys) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return undefined;
  const param = node.params[0];
  if (param.type !== "ObjectPattern") return undefined;
  const names = new Set(param.properties
    .filter(entry => entry.type === "Property")
    .map(entry => entry.key.name ?? entry.key.value));
  return keys.every(name => names.has(name)) ? node : undefined;
}

// The wrapper is the function that builds a catalog from `options` and returns
// a single call whose props include `catalog`, `state` and `onStateChange`.
function routineModelPickerTarget(node) {
  const fn = functionWithParamKeys(node, ["options", "selectedLabel", "qualifier",
    "internalCatalog"]);
  if (!fn || fn.body?.type !== "BlockStatement") return undefined;
  const returns = fn.body.body.filter(statement => statement.type === "ReturnStatement");
  if (returns.length !== 1) return undefined;
  const call = renderedExpression(returns[0].argument);
  if (call?.type !== "CallExpression" || call.arguments[1]?.type !== "ObjectExpression") {
    return undefined;
  }
  const props = new Set(call.arguments[1].properties
    .filter(entry => entry.type === "Property")
    .map(entry => entry.key.name ?? entry.key.value));
  return ["catalog", "state", "onStateChange", "triggerName"].every(name => props.has(name))
    ? fn : undefined;
}

function replaceExactlyOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) return null;
  return text.slice(0, at) + to + text.slice(at + from.length);
}

function applyReplacements(text, pairs) {
  for (const [from, to] of pairs) {
    text = replaceExactlyOnce(text, from, to);
    if (text === null) return null;
  }
  return text;
}

function routineModelPickerReplacement(source, node) {
  return applyReplacements(source.slice(node.start, node.end), [
    ["internalCatalog:c=!1}",
      "internalCatalog:c=!1,effort:__claudeskEffort=null,"
        + "onEffortChange:__claudeskOnEffortChange,"
        + "fallbackModel:__claudeskFallbackModel=null}"],
    ["let l=t||Z,u=", "let l=t||__claudeskFallbackModel||Z,u="],
    ['thinking:{type:"none"}}))',
      'thinking:e.thinking&&e.thinking.effort_options'
        + '&&e.thinking.effort_options.length?e.thinking:{type:"none"}}))'],
    ["f=d(()=>({model:l}),[l]),m=s(e=>{n(e.model===Z?void 0:e.model)},[n])",
      "f=d(()=>__claudeskEffort?{model:l,thinking:{type:\"effort\","
        + "effort:__claudeskEffort}}:{model:l,thinking:{type:\"none\"}},"
        + "[l,__claudeskEffort]),m=s(e=>{e.kind===\"effort\"?"
        + "(__claudeskOnEffortChange&&__claudeskOnEffortChange(e.effort))"
        + ":e.kind===\"model\"&&n(e.model===Z?void 0:e.model)},"
        + "[n,__claudeskOnEffortChange])"],
    ["config:c?me:void 0", 'config:{...me,thinkingStyle:"separate"}'],
  ]);
}

// The routine form's state hook returns the object the form components read;
// `submitNeedsGithubConnect` is one of its return properties, which pins it
// without relying on the minifier's name.
function routineFormStateTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 3) return undefined;
  return contains(node.body, child => child.type === "Property"
    && key(child, "submitNeedsGithubConnect")) ? node : undefined;
}

function routineFormStateReplacement(source, node) {
  return applyReplacements(source.slice(node.start, node.end), [
    ["[Ke,qe]=t(j.model),",
      "[Ke,qe]=t(j.model),[__claudeskEffort,__claudeskSetEffort]=t(j.effort??null),"
        + "[__claudeskCwd,__claudeskSetCwd]=t(j.cwd??\"\"),"
        + "[__claudeskPermission,__claudeskSetPermission]=t(j.permissionMode??\"\"),"],
    // Empty strings are written, not dropped: an edit that clears the working
    // directory or permission mode must clear the stored task field, and the
    // bridge reads a present-but-empty value as "remove it".
    ["model:Kt,autofix_on_pr_create:",
      "model:Kt,cwd:__claudeskCwd,permission_mode:__claudeskPermission,"
        + "effort_level:__claudeskEffort,autofix_on_pr_create:"],
    ["minted:Pr,clearMinted:",
      "effort:__claudeskEffort,setEffort:__claudeskSetEffort,"
        + "cwd:__claudeskCwd,setCwd:__claudeskSetCwd,"
        + "permissionMode:__claudeskPermission,"
        + "setPermissionMode:__claudeskSetPermission,minted:Pr,clearMinted:"],
    ["Ke!==t.model||U!==t.workerId",
      "__claudeskEffort!==t.effort||__claudeskCwd!==t.cwd"
        + "||__claudeskPermission!==t.permissionMode||Ke!==t.model||U!==t.workerId"],
    ["prompt:j.prompt,model:j.model,workerId:j.workerId",
      "prompt:j.prompt,model:j.model,effort:j.effort??null,"
        + "cwd:j.cwd??\"\",permissionMode:j.permissionMode??\"\",workerId:j.workerId"],
  ]);
}

// The job-config parser: returns `{prompt, workerId, repos, repoUrls,
// autofixOnPrCreate, model}` from `ccr.session_context`/events.
function routineJobConfigTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return undefined;
  const body = node.body;
  if (!body || body.type !== "BlockStatement") return undefined;
  if (!contains(body, child => child.type === "Property" && key(child, "workerId"))) {
    return undefined;
  }
  return contains(body, child => child.type === "Property" && key(child, "autofixOnPrCreate"))
    ? node : undefined;
}

// The instructions composer's model picker call: the wrapper receives the
// form's effort and the model the form resolves for an unset ("Default")
// choice, so the effort dropdown has the selected model's options.
function routinePickerUsagePatch(source) {
  const from = "{options:o,value:e.model??void 0,onChange:t=>e.setModel(t??null),"
    + "selectedLabel:l,";
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) return null;
  return {
    start: at,
    end: at + from.length,
    original: from,
    replacement: "{options:o,value:e.model??void 0,onChange:t=>e.setModel(t??null),"
      + "effort:e.effort??null,onEffortChange:e.setEffort,fallbackModel:c,selectedLabel:l,",
  };
}

// The form's model-options hook strips every catalog field but id/name. The
// picker needs each model's own `thinking` (its effort options), description
// and section to draw the second dropdown and the overflow group.
function routineModelOptionsPatch(source) {
  const from = "r.map(e=>({model:e.id,name:e.name,disabledReason:o(e.id)}))";
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) return null;
  return {
    start: at,
    end: at + from.length,
    original: from,
    replacement: "r.map(e=>({model:e.id,name:e.name,description:e.description,"
      + "section:e.section,thinking:e.thinking,disabledReason:o(e.id)}))",
  };
}

function routineJobConfigReplacement(source, node) {
  return applyReplacements(source.slice(node.start, node.end), [
    ["let p=l?.model??null,m=l?.autofix_on_pr_create;",
      "let p=l?.model??null,m=l?.autofix_on_pr_create,"
        + "cw=l?.cwd??\"\",pm=l?.permission_mode??\"\",ef=l?.effort_level??null;"],
    ["return{prompt:c,workerId:a,repos:d,repoUrls:f,autofixOnPrCreate:m,model:p}",
      "return{prompt:c,workerId:a,repos:d,repoUrls:f,autofixOnPrCreate:m,model:p,"
        + "cwd:cw,permissionMode:pm,effort:ef}"],
  ]);
}

// The unified form's repository/environment row component. Its return's
// children array is where the working-directory and permission-mode rows are
// inserted, so both the create page and the edit dialog (which render the same
// form) get them.
function routineFormRowsTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return undefined;
  const param = node.params[0];
  if (param.type !== "ObjectPattern") return undefined;
  const names = new Set(param.properties
    .filter(entry => entry.type === "Property")
    .map(entry => entry.key.name ?? entry.key.value));
  // Exactly the row component's three props: the sibling form components carry
  // extra parameters and would otherwise match too.
  if (names.size !== 3
    || !["state", "needsGithubConnect", "onGithubConnect"].every(name => names.has(name))) {
    return undefined;
  }
  const returns = node.body.body.filter(statement => statement.type === "ReturnStatement");
  if (returns.length !== 1) return undefined;
  const call = renderedExpression(returns[0].argument);
  if (call?.type !== "CallExpression" || call.arguments[1]?.type !== "ObjectExpression") {
    return undefined;
  }
  const children = call.arguments[1].properties
    .find(entry => entry.type === "Property" && key(entry, "children"))?.value;
  if (children?.type !== "ArrayExpression") return undefined;
  return { node, children };
}

function routineFormRowsReplacement(source, target) {
  const { node, children } = target;
  let jsx;          // multi-child factory (`jsxs`)
  let jsxSingle;    // single-child factory (`jsx`)
  let classNames;   // clsx-style helper
  let rowClass;     // the row's shared className
  let labelClass;   // the row label's className
  let message;      // FormattedMessage component
  let styles;       // the shared trigger-class object (`En`)
  walk(node, [], (child) => {
    if (child.type === "CallExpression") {
      if (literal(child.arguments[0], "span") && !jsxSingle) {
        jsxSingle = identifier(child.callee);
      }
      if (!classNames && child.arguments[0]?.type === "Identifier"
        && literal(child.arguments[1], "flex-wrap")) {
        rowClass = child.arguments[0].name;
        classNames = identifier(child.callee);
      }
      const props = child.arguments[1];
      if (props?.type === "ObjectExpression" && !message) {
        const spread = props.properties.find(entry => entry.type === "SpreadElement");
        if (spread && property(spread.argument, "environment")) {
          message = identifier(child.arguments[0]);
        }
      }
    }
    if (child.type === "Property" && key(child, "className")
      && child.value?.type === "Identifier" && !labelClass) {
      labelClass = child.value.name;
    }
    if (!styles && property(child, "secondary")
      && unwrap(child.object)?.type === "Identifier") {
      styles = identifier(child.object);
    }
  });
  // The combobox the environment row uses lives one component further down
  // (`aa`), so its binding is read from the whole chunk rather than this
  // component's body.
  let combobox;
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }),
    [], (child) => {
      if (combobox || child.type !== "CallExpression") return;
      const props = child.arguments[1];
      if (props?.type !== "ObjectExpression") return;
      if (props.properties.some(entry => entry.type === "Property" && key(entry, "itemToLabel"))
        && props.properties.some(entry => entry.type === "Property" && key(entry, "onSelect"))) {
        combobox = identifier(child.arguments[0]);
      }
    });
  const outer = renderedExpression(node.body.body
    .find(statement => statement.type === "ReturnStatement").argument);
  jsx = identifier(outer.callee);
  if (!jsx || !jsxSingle || !classNames || !rowClass || !labelClass || !message
    || !combobox || !styles) {
    return null;
  }
  const row = (children) => `${jsx}("div",{className:${classNames}(${rowClass},"flex-wrap"),`
    + `children:[${children}]})`;
  const cwdRow = row(
    `${jsxSingle}("span",{className:${labelClass},children:${jsxSingle}(${message},`
      + `{defaultMessage:"Working directory",id:"claudesk-routine-cwd"})}),`
      + `${jsx}("button",{type:"button",onClick:async()=>{`
      + `let t=globalThis["claude.web"]?.FileSystem,`
      + `p=await t?.browseCodeFolder?.(`
      + `"Choose the routine's working folder",!0,!0,e.cwd||void 0);`
      + `typeof p==="string"&&p&&e.setCwd(p)},`
      + `className:"inline-flex min-w-0 items-center gap-1.5 text-body text-secondary hover:text-primary",`
      + `children:[${jsxSingle}("span",{className:"max-w-[240px] truncate",`
      + `children:e.cwd||"Workspace default"}),`
      + `${jsxSingle}("span",{className:"text-footnote text-muted",children:"Change"})]}),`
      + `e.cwd?${jsx}("button",{type:"button",onClick:()=>e.setCwd(""),`
      + `className:"text-footnote text-muted hover:text-primary",children:"Clear"}):null`,
  );
  const permissionRow = row(
    `${jsxSingle}("span",{className:${labelClass},children:${jsxSingle}(${message},`
      + `{defaultMessage:"Permission mode",id:"claudesk-routine-permission-mode"})}),`
      + `${jsxSingle}(${combobox},{items:[{id:"default",name:"Default"},`
      + `{id:"acceptEdits",name:"Accept edits"},{id:"plan",name:"Plan"},`
      + `{id:"auto",name:"Auto"},{id:"bypassPermissions",name:"Bypass permissions"}],`
      + `itemToLabel:e=>e.name,value:null,onSelect:t=>e.setPermissionMode(t.id),`
      + `icon:"Lock",triggerLabel:({default:"Default",acceptEdits:"Accept edits",`
      + `plan:"Plan",auto:"Auto",bypassPermissions:"Bypass permissions"})`
      + `[e.permissionMode]??"Default",triggerAriaLabel:"Permission mode",`
      + `triggerClassName:${styles}.secondary})`,
  );
  return `,${cwdRow},${permissionRow}`;
}

// The Code surface's routine page is a second implementation of the same
// create/edit form, with its own instructions composer. Its footer renders a
// plain model combobox, and its layout has no start-option rows. The component
// is pinned by its exact four props and by the model-options hook bound inside
// it (`hideModelPicker`, `modelOptions`, `selectedModelId`,
// `selectedModelLabel`), plus the one combobox carrying `icon:"CaretDown"`.
function epitaxyRoutineComposerTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return undefined;
  const param = node.params[0];
  if (param.type !== "ObjectPattern") return undefined;
  const names = new Set(param.properties
    .filter(entry => entry.type === "Property")
    .map(entry => entry.key.name ?? entry.key.value));
  if (names.size !== 4
    || !["state", "needsGithubConnect", "onGithubConnect", "dormant"].every(name => names.has(name))) {
    return undefined;
  }
  const returns = node.body.body.filter(statement => statement.type === "ReturnStatement");
  if (returns.length !== 1) return undefined;
  const outer = renderedExpression(returns[0].argument);
  if (outer?.type !== "CallExpression" || outer.arguments[1]?.type !== "ObjectExpression") {
    return undefined;
  }
  const children = outer.arguments[1].properties
    .find(entry => entry.type === "Property" && key(entry, "children"))?.value;
  if (children?.type !== "ArrayExpression") return undefined;
  let hook;
  const modelCalls = [];
  walk(node.body, [], (child) => {
    if (child.type === "VariableDeclarator" && child.id?.type === "ObjectPattern") {
      const keys = new Set(child.id.properties
        .filter(entry => entry.type === "Property")
        .map(entry => entry.key.name ?? entry.key.value));
      if (["hideModelPicker", "modelOptions", "selectedModelId", "selectedModelLabel"]
        .every(name => keys.has(name))) hook = child;
    }
    if (child.type === "CallExpression" && child.arguments.length === 2
      && child.arguments[1]?.type === "ObjectExpression") {
      const props = child.arguments[1].properties;
      const has = name => props.some(entry => entry.type === "Property" && key(entry, name));
      const icon = props.find(entry => entry.type === "Property" && key(entry, "icon"));
      if (has("items") && has("itemToLabel") && has("onSelect")
        && literal(icon?.value, "CaretDown")) modelCalls.push(child);
    }
  });
  if (!hook || modelCalls.length !== 1) return undefined;
  return { node, param, outer, children, hook, modelCall: modelCalls[0] };
}

function epitaxyRoutineReplacement(source, target) {
  const { param, outer, children, hook, modelCall } = target;
  const local = (pattern, name) => identifier(pattern.properties
    .find(entry => entry.type === "Property"
      && (entry.key.name ?? entry.key.value) === name)?.value);
  const state = local(param, "state");
  const modelOptions = local(hook.id, "modelOptions");
  const selectedModelId = local(hook.id, "selectedModelId");
  const selectedModelLabel = local(hook.id, "selectedModelLabel");
  const jsx = identifier(modelCall.callee);
  const multi = identifier(outer.callee);
  const combobox = identifier(modelCall.arguments[0]);
  if (!state || !modelOptions || !selectedModelId || !selectedModelLabel
    || !jsx || !multi || !combobox) return null;

  // The wrapper is published by its own chunk (see the tenant block): the page
  // imports that chunk for side effects only and has no binding to call.
  const original = source.slice(modelCall.start, modelCall.end);
  const picker = `(globalThis.__CLAUDESK_MODEL_PICKER__?`
    + `${jsx}(globalThis.__CLAUDESK_MODEL_PICKER__,`
    + `{options:${modelOptions},value:${state}.model??void 0,`
    + `onChange:t=>${state}.setModel(t??null),effort:${state}.effort??null,`
    + `onEffortChange:${state}.setEffort,fallbackModel:${selectedModelId},`
    + `selectedLabel:${selectedModelLabel}}):${original})`;
  const rowClass = '"flex flex-wrap items-center gap-2 py-1.5"';
  const labelClass = '"text-body text-secondary"';
  const triggerClass = '"inline-flex items-center gap-1.5 rounded-md px-2 py-1 '
    + 'text-body text-secondary hover:text-primary"';
  // The state hook (`routine-form-start-options`) supplies cwd, permission and
  // effort. A bundle where that splice did not land leaves the rows inert
  // rather than throwing: setters are tested before use.
  const cwdRow = `${multi}("div",{className:${rowClass},children:[`
    + `${jsx}("span",{className:${labelClass},children:"Working directory"}),`
    + `${multi}("button",{type:"button",onClick:async()=>{`
    + `let t=globalThis["claude.web"]?.FileSystem,`
    + `p=await t?.browseCodeFolder?.("Choose the routine's working folder",!0,!0,`
    + `${state}.cwd||void 0);`
    + `typeof p==="string"&&p&&${state}.setCwd&&${state}.setCwd(p)},`
    + `className:"inline-flex min-w-0 items-center gap-1.5 text-body text-secondary hover:text-primary",`
    + `children:[${jsx}("span",{className:"max-w-[240px] truncate",`
    + `children:${state}.cwd||"Workspace default"}),`
    + `${jsx}("span",{className:"text-footnote text-muted",children:"Change"})]}),`
    + `${state}.cwd?${multi}("button",{type:"button",`
    + `onClick:()=>${state}.setCwd&&${state}.setCwd(""),`
    + `className:"text-footnote text-muted hover:text-primary",children:"Clear"}):null`
    + `]})`;
  const permissionRow = `${multi}("div",{className:${rowClass},children:[`
    + `${jsx}("span",{className:${labelClass},children:"Permission mode"}),`
    + `${jsx}(${combobox},{items:[{id:"default",name:"Default"},`
    + `{id:"acceptEdits",name:"Accept edits"},{id:"plan",name:"Plan"},`
    + `{id:"auto",name:"Auto"},{id:"bypassPermissions",name:"Bypass permissions"}],`
    + `itemToLabel:e=>e.name,itemDisabledReason:()=>void 0,value:null,`
    + `onSelect:t=>${state}.setPermissionMode&&${state}.setPermissionMode(t.id),`
    + `icon:"Lock",triggerLabel:({default:"Default",acceptEdits:"Accept edits",`
    + `plan:"Plan",auto:"Auto",bypassPermissions:"Bypass permissions"})`
    + `[${state}.permissionMode]??"Default",triggerAriaLabel:"Permission mode",`
    + `triggerClassName:${triggerClass}})`
    + `]})`;
  return [
    { id: routineEpitaxyPatchId, start: modelCall.start, end: modelCall.end,
      original, replacement: picker },
    { id: routineEpitaxyPatchId, start: children.end - 1, end: children.end - 1,
      original: "", replacement: `,${cwdRow},${permissionRow}` },
  ];
}

// The composer's per-environment mode-list builder: `switch (envType)` with a
// `byoc`/`pool` arm that consults `backendModes` and otherwise falls back to
// the remote list. Pinned by those case literals plus the `backendModes`
// property; the bypass append goes on that arm's own result.
function codeBypassSelfHostedModesTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 2) return undefined;
  const body = node.body;
  if (body?.type !== "BlockStatement") return undefined;
  const statement = body.body.find(entry => entry.type === "SwitchStatement");
  if (!statement) return undefined;
  const tests = statement.cases
    .map(entry => entry.test).filter(entry => entry?.type === "Literal")
    .map(entry => entry.value);
  if (!["byoc", "pool", "anthropic_cloud", "project"].every(name => tests.includes(name))) {
    return undefined;
  }
  const group = statement.cases.filter(entry => entry.test?.type === "Literal"
    && ["anthropic_cloud", "byoc", "pool", "project"].includes(entry.test.value));
  const consequent = group.map(entry => entry.consequent).find(entries => entries.length > 0);
  if (!consequent) return undefined;
  let helper;
  let backendModes = false;
  for (const entry of consequent) {
    walk(entry, [], (child) => {
      if (child.type === "CallExpression" && literal(child.arguments[0], "local")) {
        helper = helper ?? identifier(child.callee);
      }
      if ((child.type === "Property" && key(child, "backendModes"))
        || property(child, "backendModes")) backendModes = true;
    });
  }
  if (!helper || !backendModes) return undefined;
  return { node, consequent, helper };
}

function codeBypassSelfHostedModesReplacement(target) {
  const { consequent, helper } = target;
  const start = consequent[0].start;
  const end = consequent.at(-1).end;
  // The locals are the builder's own: `n` auto availability, `r` auto-first,
  // `t` the options object. The nested `e` shadows the environment parameter
  // exactly as the original arm does.
  // The availability predicate is deliberately not consulted here: the
  // Desktop's "running as root" gate reads the agent's user, and this
  // deployment's agent is root inside its own VM by design (the guest runner
  // sets IS_SANDBOX=1, which is what lets bypass work there). Only the
  // self-hosted place kinds get the append — a cloud or project place does not.
  const replacement = `{let __claudeskModes;`
    + `if(t.backendModes!==void 0){let e=t.backendModes;`
    + `__claudeskModes=${helper}("local",{auto:n,autoFirst:r}).filter(t=>e.includes(t))}`
    + `else{__claudeskModes=t.remotePlanModeEnabled?`
    + `${helper}("remote",{auto:n,autoFirst:r}):["acceptEdits"]}`
    + `if((e==="byoc"||e==="pool")&&!__claudeskModes.includes("bypassPermissions"))`
    + `__claudeskModes=[...__claudeskModes,"bypassPermissions"];return __claudeskModes}`;
  return { start, end, replacement };
}

// The session-host mode list. It is a literal in the renderer's surface
// capabilities (`["default","acceptEdits","plan","auto"]`), and the composer's
// mode picker filters against it, so bypass is unreachable however the
// entitlement reads. The deployment's sessions run in its own VM, so the list
// carries bypass. Only an exact, unique literal is spliced.
function codeBypassPermissionListPatch(source) {
  const from = '_R=["default","acceptEdits","plan","auto"]';
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) return null;
  return {
    start: at,
    end: at + from.length,
    original: from,
    replacement: '_R=["default","acceptEdits","plan","auto","bypassPermissions"]',
  };
}

// The availability predicate behind both the settings row and the composer's
// bypass mode. It begins by refusing internal/ant accounts; prepending
// `return!0` makes the deployment's own VM count as available without touching
// any of the conditions it reads.
function codeBypassAvailabilityTarget(node) {
  if (node.type !== "FunctionDeclaration" || node.params.length !== 1) return undefined;
  const body = node.body;
  if (body?.type !== "BlockStatement" || !body.body.length) return undefined;
  const first = body.body[0];
  if (first.type !== "IfStatement") return undefined;
  if (!contains(first.test, child => property(child, "isNestBuild"))) return undefined;
  if (!contains(first.test, child => property(child, "isAntAccount"))) return undefined;
  // The sibling predicate starts with the same two account checks but also
  // reads the rollout gate; this one is the pure availability answer.
  if (contains(first.test, child => property(child, "isChillingSlothEnabled"))) {
    return undefined;
  }
  return body;
}

export function inspectRenderer(source, gatewayEnabled, webShellEnabled = false,
  tenantEnabled = false) {
  const evidence = Object.fromEntries(markerIds.map(id => [id, []]));
  const patches = [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const redirectScopes = new Map();
  let button;
  let avatarComponent;
  let starterHost;
  let listenerHost;
  let toastBinding;
  let toastPublished = false;
  const crashLogOptions = [];
  // A tenant's web Code places sessions on its self-hosted runner, so the
  // folder/branch/worktree start options Desktop's local composer has must be
  // offered for a `byoc`/`pool` place too. Each splice is accepted only when
  // its own shape is unambiguous in the chunk, and none is required: a bundle
  // that no longer matches leaves the options off rather than failing renderer
  // preparation.
  if (webShellEnabled && tenantEnabled) {
    const placeKinds = [];
    const branchReads = [];
    const intents = [];
    const creates = [];
    const wireConfigs = [];
    const folderPickers = [];
    const strips = [];
    walk(ast, [], (node, ancestors) => {
      const placeKind = placeKindSwitchTarget(node);
      if (placeKind) placeKinds.push(placeKind);
      const branchRead = selfHostedBranchReadTarget(node);
      if (branchRead) branchReads.push(branchRead);
      const intent = selfHostedIntentTarget(node);
      if (intent) intents.push(intent);
      const create = selfHostedCreateTarget(node);
      if (create) creates.push(create);
      const wireConfig = selfHostedWireConfigTarget(node);
      if (wireConfig) wireConfigs.push(wireConfig);
      const folderPicker = selfHostedFolderPickerTarget(node);
      if (folderPicker) folderPickers.push(folderPicker);
      const strip = selfHostedStripTarget(node, ancestors);
      if (strip) strips.push(strip);
    });
    for (const { statement } of placeKinds) {
      const replacement = placeKindReplacement(source, statement);
      patches.push({ id: placeKindPatchId, start: statement.start, end: statement.end,
        original: source.slice(statement.start, statement.end), replacement });
    }
    const switchNames = placeKinds.map((entry) => entry.name).filter(Boolean);
    if (switchNames.length) {
      const needsFolders = [];
      walk(ast, [], (node) => {
        const target = needsFolderClauseTarget(node, switchNames);
        if (target) needsFolders.push(target);
      });
      if (needsFolders.length === 1) {
        const { clause, env, flag } = needsFolders[0];
        const kinds = selfHostedKinds.map(kind => `${env}===${JSON.stringify(kind)}`);
        patches.push({ id: needsFolderPatchId, start: clause.start, end: clause.end,
          original: source.slice(clause.start, clause.end),
          replacement: `(!${flag}||${kinds.join("||")})` });
      }
    }
    if (branchReads.length === 1) {
      const test = branchReads[0];
      const env = test.left?.type === "Identifier" && !literal(test.left, "local")
        ? identifier(test.left) : identifier(test.right);
      const kinds = selfHostedKinds.map(kind => `${env}===${JSON.stringify(kind)}`);
      const replacement = `(${env}==="local"||${kinds.join("||")})`;
      patches.push({ id: branchReadPatchId, start: test.start, end: test.end,
        original: source.slice(test.start, test.end), replacement });
    }
    if (intents.length === 1) {
      for (const object of intents[0].objects) {
        if (!object.properties.length) continue;
        const at = object.end - 1;
        patches.push({ id: selfHostedIntentPatchId, start: at, end: at, original: "",
          replacement: selfHostedIntentReplacement(source, intents[0]) });
      }
    }
    if (creates.length === 1) {
      const { param, context, bindings } = creates[0];
      const cwd = bindings.get("cwd") || "__claudeskCwd";
      const worktree = bindings.get("useWorktree") || "__claudeskWorktree";
      const additions = [];
      if (!bindings.has("cwd")) additions.push(`cwd:${cwd}`);
      if (!bindings.has("useWorktree")) additions.push(`useWorktree:${worktree}`);
      if (additions.length && param.properties.length) {
        const at = param.end - 1;
        patches.push({ id: selfHostedCreatePatchId, start: at, end: at, original: "",
          replacement: `,${additions.join(",")}` });
      }
      if (context.properties.length) {
        const at = context.end - 1;
        const sourceBranch = bindings.get("sourceBranch");
        patches.push({ id: selfHostedCreatePatchId, start: at, end: at, original: "",
          replacement: `,...(${cwd}&&{cwd:${cwd}})`
            + `,...(${sourceBranch}&&{source_branch:${sourceBranch}})`
            + `,...(${worktree}&&{use_worktree:!0})` });
      }
    }
    if (wireConfigs.length === 1) {
      const { config, context } = wireConfigs[0];
      if (config.properties.length) {
        const at = config.end - 1;
        patches.push({ id: selfHostedCreatePatchId, start: at, end: at, original: "",
          replacement: `,...(${context}.source_branch&&{source_branch:${context}.source_branch})`
            + `,...(${context}.use_worktree&&{use_worktree:${context}.use_worktree})` });
      }
    }
    if (folderPickers.length === 1) {
      const { init, receiver } = folderPickers[0];
      const surface = source.slice(receiver.start, receiver.end);
      patches.push({ id: selfHostedFolderPickerPatchId, start: init.start, end: init.end,
        original: source.slice(init.start, init.end),
        replacement: `(${surface}?.browseCodeFolder??${source.slice(init.start, init.end)})` });
    }
    if (strips.length === 1) {
      const { condition, env, flag } = strips[0];
      // Drop the desktop-rail negation beside the draft's `needsFolder`, but do
      // not mount the strip on every composer: outside a folder-bearing draft
      // the row is rendered against state the composer never prepared for (the
      // chat composer has no folder props). A self-hosted place is the surface
      // this patch exists for, and its kind is read from the composer's own
      // parameter — so it mounts there even when the draft never published its
      // options, and nowhere else.
      const needed = source.slice(flag.start, flag.end);
      const kinds = selfHostedKinds.map(kind => `${env}===${JSON.stringify(kind)}`);
      patches.push({ id: stripPatchId, start: condition.start, end: condition.end,
        original: source.slice(condition.start, condition.end),
        // The assignment is the preload fallback's cue that the renderer drew
        // the strip, so it does not inject a second copy.
        replacement: `((${needed}||${kinds.join("||")})`
          + `&&(globalThis.__CLAUDESK_STRIP_MOUNTED__=!0))` });
    }
  }
  if (webShellEnabled) {
    // Every copy of the chunk loader gets the deployment's asset base, so lazy
    // chunks resolve under the same release path as the entry document.
    walk(ast, [], (node) => {
      const target = assetBaseTarget(node);
      if (!target) return;
      patches.push({ id: assetBasePatchId, start: target.expression.start,
        end: target.expression.end,
        original: source.slice(target.expression.start, target.expression.end),
        replacement: `(globalThis.__CLAUDESK_ASSET_BASE__||"")+"/"+${target.param}` });
    });
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
    // The atrium capability's folded read. The sequence is spliced down to the
    // feature read itself, so the capability answers what the deployment's table
    // says instead of the constant the Desktop build folded it to.
    const atrium = projectsAtriumTarget(ast);
    if (atrium) {
      const read = atrium.expressions[0];
      patches.push({ id: projectsAtriumPatchId, start: atrium.start, end: atrium.end,
        original: source.slice(atrium.start, atrium.end),
        replacement: source.slice(read.start, read.end) });
    }
    // The server-projects predicate: this deployment has no such backend, so the
    // queries it gates are never asked and every consumer is told the list is
    // settled and empty rather than pending.
    const serverProjects = projectsServerProjectsTarget(ast);
    if (serverProjects) {
      patches.push({ id: projectsServerProjectsPatchId, start: serverProjects.start,
        end: serverProjects.end, original: source.slice(serverProjects.start, serverProjects.end),
        replacement: projectsServerProjectsOff });
    }
    // The hub-writable flag, in every function that folds it: the read is put
    // back in charge of the answer, so the bridge's grant of the gate reaches it.
    for (const hubWritable of coworkHubWritableTargets(ast)) {
      const read = source.slice(hubWritable.read.start, hubWritable.read.end);
      patches.push({ id: coworkHubWritablePatchId, start: hubWritable.sequence.start,
        end: hubWritable.sequence.end,
        original: source.slice(hubWritable.sequence.start, hubWritable.sequence.end),
        replacement: `{enabled:${read}}` });
    }
    const report = projectsRemoteReportTarget(ast);
    if (report) {
      for (const entry of report.properties) {
        if (!projectsRemoteReportForced.includes(entry.key.name ?? entry.key.value)) continue;
        patches.push({ id: projectsServerProjectsPatchId, start: entry.value.start,
          end: entry.value.end, original: source.slice(entry.value.start, entry.value.end),
          replacement: projectsRemoteSettled });
      }
    }
    const pageList = projectsPageListTarget(ast);
    if (pageList) {
      for (const entry of pageList.properties) {
        if (!projectsPageListForced.includes(entry.key.name ?? entry.key.value)) continue;
        patches.push({ id: projectsServerProjectsPatchId, start: entry.value.start,
          end: entry.value.end, original: source.slice(entry.value.start, entry.value.end),
          replacement: projectsRemoteSettled });
      }
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
    // The session list's Code gate: the product switcher's sticky intent is
    // forced false so only the Code surface merges Code sessions (see
    // chatListNoCodePatchId). Exactly one gate function per chunk, or nothing.
    const chatGates = [];
    walk(ast, [], (node) => {
      const target = chatListNoCodeTarget(node);
      if (target) chatGates.push(target);
    });
    if (chatGates.length === 1) {
      const [target] = chatGates;
      patches.push({ id: chatListNoCodePatchId, start: target.start, end: target.end,
        original: source.slice(target.start, target.end), replacement: "!1" });
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
      const crashOption = crashLogOptionTarget(node, ancestors);
      if (crashOption) crashLogOptions.push(crashOption);
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
      // The Code session view's live leg: hold its transport to SSE (see
      // subscribeSsePatchId).
      const subscribeValue = subscribeSseProperty(node, ancestors);
      if (subscribeValue) {
        patches.push({ id: subscribeSsePatchId, start: subscribeValue.start,
          end: subscribeValue.end,
          original: source.slice(subscribeValue.start, subscribeValue.end),
          replacement: "!0" });
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
  // The caught-error handler takes the error and React's error info and returns
  // nothing; the wrapper logs both (the raw error prints its stack) and then
  // delegates, so the app's own reporting still runs. A throw from the log line
  // or from the original handler must not replace the crash the boundary is
  // already rendering, hence the two `try`s.
  // The routine surface's two web-shell patches (see their ids). Each target is
  // accepted only when exactly one candidate is in the chunk, so a second
  // refuses rather than splice the wrong expression.
  if (webShellEnabled) {
    const origins = [];
    const apiCards = [];
    walk(ast, [], (node) => {
      const origin = routineFireOriginTarget(node);
      if (origin) origins.push(origin);
      const cards = routineApiTriggerTarget(node);
      if (cards) apiCards.push(cards);
    });
    if (origins.length === 1) {
      const target = origins[0];
      patches.push({ id: routineFireOriginPatchId, start: target.start, end: target.end,
        original: source.slice(target.start, target.end),
        // The original argument follows `return` with no space (`return"…"`);
        // keep one so the keyword and the identifier stay separate tokens.
        replacement: " window.location.origin" });
    }
    if (apiCards.length === 1) {
      const target = apiCards[0];
      const original = source.slice(target.start, target.end);
      patches.push({ id: routineApiTriggerPatchId, start: target.start, end: target.end,
        original, replacement: `[...${original},${routineApiTriggerCard}]` });
    }
  }
  // The routine form's create page and edit dialog share one unified form. A
  // routine here is a Code scheduled task — on the operator's own instance as
  // much as on a tenant's — so the form gains the model+effort picker (the
  // composer's own two dropdowns), a working-directory picker and a
  // permission-mode picker. This is gated on the web shell (which includes a
  // tenant's), not on tenant alone: the operator's instance runs the same Code
  // routines and must get the same form. Each splice is accepted only when
  // exactly one candidate is in the chunk; none is required, so a bundle that
  // no longer matches leaves the old form rather than failing renderer
  // preparation.
  if (webShellEnabled || tenantEnabled) {
    const modelPickers = [];
    const formStates = [];
    const jobConfigs = [];
    const formRows = [];
    walk(ast, [], (node) => {
      const picker = routineModelPickerTarget(node);
      if (picker) modelPickers.push(picker);
      const state = routineFormStateTarget(node);
      if (state) formStates.push(state);
      const job = routineJobConfigTarget(node);
      if (job) jobConfigs.push(job);
      const rows = routineFormRowsTarget(node);
      if (rows) formRows.push(rows);
    });
    if (modelPickers.length === 1) {
      const replacement = routineModelPickerReplacement(source, modelPickers[0]);
      if (replacement !== null) {
        patches.push({ id: routineModelPickerPatchId, start: modelPickers[0].start,
          end: modelPickers[0].end,
          original: source.slice(modelPickers[0].start, modelPickers[0].end), replacement });
      }
      // The Code surface's routine page imports this chunk for side effects
      // only, so it has no binding for the wrapper. Publish it here; the page's
      // own splice calls through the global (see routine-epitaxy-start-options).
      if (modelPickers[0].id?.type === "Identifier") {
        patches.push({ id: routineModelPickerPublishPatchId, start: modelPickers[0].end,
          end: modelPickers[0].end, original: "",
          replacement: `;globalThis.__CLAUDESK_MODEL_PICKER__=${modelPickers[0].id.name};` });
      }
    }
    if (formStates.length === 1) {
      const replacement = routineFormStateReplacement(source, formStates[0]);
      if (replacement !== null) {
        patches.push({ id: routineFormStatePatchId, start: formStates[0].start,
          end: formStates[0].end,
          original: source.slice(formStates[0].start, formStates[0].end), replacement });
      }
    }
    const pickerUsage = routinePickerUsagePatch(source);
    if (pickerUsage) {
      patches.push({ id: routineModelPickerPatchId, ...pickerUsage });
    }
    const modelOptions = routineModelOptionsPatch(source);
    if (modelOptions) {
      patches.push({ id: routineModelPickerPatchId, ...modelOptions });
    }
    if (jobConfigs.length === 1) {
      const replacement = routineJobConfigReplacement(source, jobConfigs[0]);
      if (replacement !== null) {
        patches.push({ id: routineJobConfigPatchId, start: jobConfigs[0].start,
          end: jobConfigs[0].end,
          original: source.slice(jobConfigs[0].start, jobConfigs[0].end), replacement });
      }
    }
    if (formRows.length === 1) {
      const replacement = routineFormRowsReplacement(source, formRows[0]);
      if (replacement !== null) {
        const at = formRows[0].children.end - 1;
        patches.push({ id: routineFormRowsPatchId, start: at, end: at,
          original: "", replacement });
      }
    }
    // The Code surface's routine page and edit dialog render a second
    // instructions composer (their own layout), not the unified form above.
    const epitaxyComposers = [];
    walk(ast, [], (node) => {
      const target = epitaxyRoutineComposerTarget(node);
      if (target) epitaxyComposers.push(target);
    });
    if (epitaxyComposers.length === 1) {
      const replacements = epitaxyRoutineReplacement(source, epitaxyComposers[0]);
      if (replacements) patches.push(...replacements);
    }
  }
  // Bypass permissions in the Code surface: the web shell and a tenant's own
  // surface both run the operator's Code, and the operator asked for the mode
  // to be selectable. The settings row and the composer's mode picker read the
  // same availability predicate and the same session-host list.
  if (webShellEnabled || tenantEnabled) {
    const bypassList = codeBypassPermissionListPatch(source);
    if (bypassList) patches.push({ id: codeBypassPermissionListPatchId, ...bypassList });
    const availability = [];
    walk(ast, [], (node) => {
      const body = codeBypassAvailabilityTarget(node);
      if (body) availability.push(body);
    });
    if (availability.length === 1) {
      const at = availability[0].start + 1;
      patches.push({ id: codeBypassAvailabilityPatchId, start: at, end: at,
        original: "", replacement: "return!0;" });
    }
    const selfHostedModes = [];
    walk(ast, [], (node) => {
      const target = codeBypassSelfHostedModesTarget(node);
      if (target) selfHostedModes.push(target);
    });
    if (selfHostedModes.length === 1) {
      const splice = codeBypassSelfHostedModesReplacement(selfHostedModes[0]);
      patches.push({ id: codeBypassSelfHostedModesPatchId, ...splice,
        original: source.slice(splice.start, splice.end) });
    }
  }
  if (webShellEnabled && crashLogOptions.length === 1) {
    const option = crashLogOptions[0];
    const original = source.slice(option.value.start, option.value.end);
    patches.push({ id: crashLogPatchId, start: option.value.start, end: option.value.end, original,
      replacement: `(...__claudeskCaught)=>{try{console.error("[claudesk] render error",`
        + `...__claudeskCaught)}catch{};try{return (${original})(...__claudeskCaught)}catch{}}` });
  }
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

// The per-file half of the analysis, split out from the assembly so it can run
// across worker threads: every chunk is inspected independently and the results
// are only combined afterwards. What the prefilter lets through (see
// prefilterNeedles) is ~25 MB of the official chunks — a minute of acorn on one
// core, a few seconds spread over the box's cores.
export function inspectAll(sources, gatewayEnabled, webShellEnabled = false,
  tenantEnabled = false) {
  const analyses = new Map();
  for (const [path, source] of sources) {
    analyses.set(path, inspectRenderer(source, gatewayEnabled, webShellEnabled, tenantEnabled));
  }
  return analyses;
}

// The assembly half: union whatever `inspectAll` (or a pool of workers running
// it) produced, hold it to the required-patch and marker invariants, and splice.
// `analyses` is a Map of path -> { patches, evidence }, keyed the same way as
// `sources`.
export function assembleRenderer(sources, analyses, gatewayEnabled, webShellEnabled = false,
  tenantEnabled = false) {
  const matches = new Map();
  const markers = new Map(markerIds.map(id => [id, []]));
  for (const [path, result] of analyses) {
    for (const patch of result.patches) {
      if (!matches.has(patch.id)) matches.set(patch.id, []);
      matches.get(patch.id).push({ path, ...patch });
    }
    for (const [id, evidence] of Object.entries(result.evidence)) {
      if (evidence.length) markers.get(id).push({ path, count: evidence.length, evidence });
    }
  }
  // The route alias is required on a tenant too: `/code` must resolve to the
  // surface this bridge drives, exactly as on the deployment's own instance.
  // What keeps a tenant's Code off its container is the environment list and
  // the IPC guard, not the route name.
  const required = [downloadPatchId, inferenceBannerPatchId, filePreviewPatchId,
    accountSignOutPatchId,
    ...(webShellEnabled
      ? [routeAliasPatchId,
          sessionViewerPatchId, localSessionPlacementPatchId,
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
  // The chunk loader exists in several copies; at least one must carry the
  // asset base, or the browser's module graph would split between release paths
  // and root-relative ones (and the root-relative chunks are cached across
  // releases). Not "exactly one": the number of copies is the bundle's business.
  if (webShellEnabled && (matches.get(assetBasePatchId)?.length || 0) < 1) {
    throw new Error(`renderer patch ${assetBasePatchId} expected at least once, found 0`);
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

export function patchRendererSources(sources, gatewayEnabled, webShellEnabled = false,
  tenantEnabled = false) {
  return assembleRenderer(
    sources,
    inspectAll(sources, gatewayEnabled, webShellEnabled, tenantEnabled),
    gatewayEnabled, webShellEnabled, tenantEnabled,
  );
}
