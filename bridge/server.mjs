import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { lstat, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  createDownloadHandler,
  readContainedFile,
  resolveContainedPath,
  resolveContainedRealPath,
  sessionFileReadLimit,
} from "./downloads.mjs";
import { createPreviewHandler } from "./preview.mjs";
import { shimOfficialIndex } from "./official-index.mjs";
import { createNotificationController } from "./notifications.mjs";
import { createConnectorStore } from "./connectors.mjs";
import { createProjectBackend } from "./projects.mjs";
import { createRunnerBackend } from "./code-runners.mjs";
import { createRoutineService, RoutineError } from "./routines.mjs";
import { createUploadHandler, parseUploadLimit } from "./uploads.mjs";
import { createRealtimeController } from "./realtime.mjs";
import { loadNotice, saveNotice } from "./notices.mjs";
import {
  createWorkspaceFolder,
  listWorkspaceFolders,
  validFolderName,
} from "./workspace-folders.mjs";

const host = process.env.BRIDGE_HOST || "0.0.0.0";
const port = Number(process.env.BRIDGE_PORT || 8080);
const coworkInternalUrl = (
  process.env.COWORK_INTERNAL_URL || "http://127.0.0.1:9222"
).replace(/\/$/, "");
const gatewaySettingsEnabled = process.env.CLAUDE_REMOTE_GATEWAY_SETTINGS === "1";
const developerActionsEnabled = process.env.CLAUDE_REMOTE_DEVELOPER_ACTIONS === "1";
const infrastructureActionsEnabled =
  process.env.CLAUDE_REMOTE_INFRASTRUCTURE_ACTIONS === "1";
// A tenant instance: one account's own Desktop, provisioned by
// scripts/provision-user.sh, as opposed to the deployment's own instance.
//
// A tenant's Code must never execute in this container. The container is
// privileged (CAP_SYS_ADMIN, userns_mode: host, apparmor=unconfined) and its
// `app` user has passwordless sudo, so an agent shell here sits a short step
// from host root. The Claude Code agent therefore belongs on a self-hosted
// runner inside the account's Cowork guest, not in the container
// (docs/code-in-cowork-vm.md), and the *local* executor is never offered: a
// tenant cannot turn it on, and a deployment that sets both is a
// misconfiguration this reports rather than serves.
const tenantInstance = process.env.CLAUDESK_TENANT === "1";
const codeActionsEnabled =
  process.env.CLAUDE_REMOTE_CODE_ACTIONS === "1" && !tenantInstance;
if (tenantInstance && process.env.CLAUDE_REMOTE_CODE_ACTIONS === "1") {
  console.warn(
    "[bridge] CLAUDESK_TENANT=1 with CLAUDE_REMOTE_CODE_ACTIONS=1: a tenant "
    + "instance never runs Code in its own container, so the local Code "
    + "surface stays withheld (docs/code-in-cowork-vm.md)",
  );
}
// Which instance this bridge belongs to (CLAUDESK_NAME_PREFIX from the .env that
// names the containers). Reported on /api/health so a peer that reaches *a*
// Desktop can tell whether it reached its own: gateway_net is shared, and every
// instance on it registers the compose service names, so `claude-desktop`
// resolves to every instance's container. See docs/eva-mode.md, "Two
// deployments on one box".
const instanceNamePrefix = process.env.CLAUDESK_NAME_PREFIX || "";
// The restart warning. On SIGTERM the bridge tells every connected page the VM
// is going down, holds for this long so the write flushes and the reader has a
// moment to see it, and only then exits — the browser's SSE stream drops right
// after, so this is the last thing the page hears. Overridable for a longer
// heads-up; the compose service's stop_grace_period must stay above it.
//
// Recreating `claude-desktop` takes the network namespace the bridge serves from
// with it, so a deploy that recreates both at once can cut a page's connection
// before this notice lands. That is why the notice is also written to the state
// directory and replayed by the next bridge (bridge/notices.mjs), and why
// deploy.sh stops the bridge on its own first — while the route to it is still
// up — before recreating the stack.
const shutdownNoticeMs = Number(process.env.CLAUDE_REMOTE_SHUTDOWN_NOTICE_MS || 5000);
const restartNotice = Object.freeze({
  title: "Your VM is restarting",
  description: "Your task has been interrupted. Please wait a minute or so before trying again.",
});
const bridgeStateDir = process.env.COWORK_BRIDGE_STATE_DIR || "/data";
// Self-hosted Code runners. A tenant's Code runs on a runner we host — inside
// its Cowork guest — and never in this container, so the runner-facing legs of
// the self-hosted pool API are answered here instead of upstream: the runner is
// pointed at this bridge (`CLAUDE_RUNNER_API_BASE_URL`) with a pool secret.
// The renderer fetches its own `/v1/*` legs with relative URLs, so the same
// origin serves both sides. Only meaningful for a tenant, and off until the
// deployment turns it on. See bridge/code-runners.mjs, docs/code-in-cowork-vm.md.
const codeRunnersEnabled =
  tenantInstance
  && process.env.CLAUDESK_CODE_RUNNERS === "1";
// The read-only git IPC a tenant's web Code composer calls. The renderer uses
// these method names for a session's folder/branch controls, but on a tenant
// they are answered by the guest runner (`tenantGitAnswer`) — never forwarded
// to Desktop, whose main process would otherwise run git over content the
// agent can write. The bridge's allowlist carries them only so
// `validateInvocation` lets the call reach that shim; the wrapper deliberately
// has no such set, so a forwarding bug cannot make them work on the host.
const tenantCodeReadsEnabled =
  process.env.CLAUDESK_TENANT === "1"
  && process.env.CLAUDESK_CODE_RUNNERS === "1";
const tenantGitReadMethods = new Set([
  "checkBranchSwitchConflict",
  "getGitInfo",
  "getLocalBranches",
  "getWorkingTreeDirtyState",
  "isWorkingTreeDirty",
]);
// Whether the Code *surface* exists on this instance — a different question from
// `codeActionsEnabled`, which is about this container's executor. A tenant's
// surface is real (its sessions run on the self-hosted runner) even though the
// executor is withheld, and the browser chrome needs to know: the preload marks
// the document so the titlebar's Claude/Code switcher is not hidden before the
// app's own bootstrap lands, and the app's config flag (written by the container
// init) is what keeps the Code segment enabled.
const codeSurfaceEnabled = codeRunnersEnabled;
const codeRunners = codeRunnersEnabled
  ? createRunnerBackend({
    stateDir: bridgeStateDir,
    log: console,
    poolName: process.env.CLAUDESK_CODE_RUNNER_POOL || "self-hosted",
    // A UI read (folder picker, git info, branches) after the VM idle-stopped
    // is as good a reason to start it as placing a session; the runner backend
    // wakes it and waits for the first poll. Hoisted declaration — see below.
    wakeRunner: () => wakeRunnerVm(),
  })
  : null;
// Experimental: render ion-dist's browser (claude.ai) chrome instead of the
// Desktop chrome. ion-dist picks its shell from the `Claude/<version>` token the
// preload appends to the user agent; dropping it makes the renderer believe it
// is a plain browser and use the web shell, while the local IPC data layer this
// bridge serves is untouched. The web shell gates Cowork behind org
// entitlements, so enabling this also grants them in the bootstrap/access
// documents the app reads. See docs/web-shell.md.
const webShellEnabled = process.env.CLAUDE_REMOTE_WEB_SHELL === "1";
// The Connectors surface (remote MCP servers a user adds under Settings →
// Connectors, and the plugin-connector rows) needs the Desktop's MCP IPC to
// connect and list tools — the same machinery the Developer menu's privileged
// actions use, but a plain account must have it, since the Developer menu is an
// operator's and the connector list is a user's. It therefore rides its own
// flag, and follows the web shell the way `coworkSkipApprovals` does: on with the
// web shell, off without it, and CLAUDE_REMOTE_MCP_CONNECTORS pins either way
// (`=1` on, `=0` off). See bridge/connectors.mjs.
const connectorsEnabled = process.env.CLAUDE_REMOTE_MCP_CONNECTORS === "1"
  || (webShellEnabled && process.env.CLAUDE_REMOTE_MCP_CONNECTORS !== "0");
// The login shell: this instance exists only to put Claude's own sign-in page in
// front of the deployment, before anyone has a session. It serves the renderer
// and nothing else — every API request is refused (see the gate in handleApi),
// so the instance cannot proxy the Desktop, hold a session, or run inference,
// signed in or not. The sign-in page itself needs no API: it renders because the
// bootstrap answers an error, and it posts credentials straight to authd, which
// the proxy already routes there. See docs/eva-mode.md, "The sign-in page".
const loginShellEnabled = process.env.CLAUDE_REMOTE_LOGIN_SHELL === "1";
// The admin dashboard's instance actions (VM restart/status) are called by
// authd over the deployment network. This shared secret is the pass; unset
// leaves the whole `/internal/*` family answering 404.
const internalSecret = process.env.CLAUDESK_INTERNAL_SECRET || "";
// Entitlements the web shell checks before offering Cowork and remote control.
// `dramatic_shrimp` is the (secret) internal flag ion-dist's web-Cowork gate
// reads; `cowork_remote_control` is its productized twin. Both sit beside the
// `cowork`/`claude_code_desktop` entitlements the deployment already carries.
const webShellGrantedFeatures = ["dramatic_shrimp", "cowork_remote_control",
  // The Code permission picker reads these to decide whether the bypass and
  // auto rows exist. A 3p deployment has no backend that would grant them, and
  // the operator asked for bypass in the Code surface, so the web shell says
  // available. Only an absent entry is added — an upstream `blocked_by_*` is
  // left to speak for itself.
  "claude_code_desktop_bypass_permissions", "claude_code_desktop_auto_permissions"];
// GrowthBook gates the web shell reads from the bootstrap's `growthbook.features`
// (ion-dist keys them by a Java-style hash of the name). `bad_moon_rising` is the
// "Claude Code web access" gate: without it the Code pill does not navigate to
// the code surface, it raises the "download the desktop app" upsell instead.
//
// `yukon_silver_dramatic_shrimp_clocks` is the scheduled-tasks term of the same
// kind of web-Cowork capability check. ion-dist computes
// `coworkEnabled = (isDesktopApp && …) || (coworkWebEnabled && thisGate) ||
// hubRoutinesServed`, and `coworkEnabled` is what puts the "Scheduled" entry in
// the hub sidebar — the only route to the Cowork scheduled-task list. A browser
// client fails the first term by construction (it is not the Desktop app, which
// is the identity the chrome patches withhold) and the last is cloud state this
// deployment never serves, so without this gate the entry is filtered out even
// though the surface behind it works: those tasks are the local ones the Desktop
// IPC this bridge backs runs, and the runner mounts in the web shell. A task can
// then be scheduled and executed with no way to reach its list, history or status
// from the product. `coworkWebEnabled` itself already reads true there — it is
// `!isDesktopApp && dramatic_shrimp && the web-Cowork gate` — so this only
// supplies the rollout flag the same way `bad_moon_rising` supplies Code's.
//
// `yukon_silver_folders` is what gives the composer's project selector anything
// to show. The picker builds its pinned, recent and more targets inside
// `if (foldersEnabled)` — with the flag off every list is empty, the trigger's
// "is there anything to draw" test is false, and the component returns null, so
// the slot in the composer renders as an empty element however many of the
// renderer's own gates are opened. That is the whole of the "Projects" surface
// in the composer: the entry points, the routes and the chip all follow from
// it. It is a rollout gate for folders everywhere, not just projects (the same
// reader feeds the folder chip and the selected-folder map), which is what a
// deployment that already exposes the workspace as a folder wants.
//
// `yukon_silver_dramatic_shrimp_atrium` is the second half of that surface, and
// the value the picker's own capability reads. That capability is the feature
// read the composer's folder picker consults to decide whether it is the claude.ai
// project picker or only a folder picker:
//
//     atriumCreate   = remoteProjectsEnabled && projectsAllowance;
//     showProjects   = !locked && atriumCreate && (!controlled || chatProjectsEnabled);
//     showFilterSort = remoteProjectsEnabled && !locked && !foldersOnly;
//
// With it off, `showProjects` is false (the renderer patch that forces the last
// gate open is what draws the chip at all), `showFilterSort` is false so the
// search box never grows its "Filter and sort" button, `onCreateProject` is never
// handed down so there is no "New project" row, and the placeholder falls to its
// last arm — "Search projects" instead of "Search or create a project". The
// allowance is already granted (`grantProjectsLimits`), and the surface behind
// the flag is the same project list the `/projects` routes and the sidebar entry
// were restored for.
//
// `amber_tributary_heron` is what makes a local Cowork session *writable* — the
// last term of `cr("hub", orgAvailable, hubServed) || heron`, whose other two are
// server verdicts this deployment does not serve. Without it session pages come
// out read-only and every session-scoped control is handed the no-op the bundle
// installs for that case, silently: the permission picker opens and does nothing,
// and the model picker does not stick either. Like the atrium gate it is folded
// to a constant in the Desktop build, so the renderer patch
// `web-cowork-hub-writable` puts the read back in charge of the answer — the two
// ship together.
//
// The feature name reaches the page nowhere else, so granting it moves only this
// surface. It is not enough on its own: the Desktop build *folds* the capability
// to a constant — `function remoteProjectsEnabled(){return read(thisFeature),FA}`
// with `var FA=!1` — so the read is discarded and the answer is false whatever
// this table says. The renderer patch `web-projects-atrium` unwraps that comma
// sequence, which is what makes this grant observable; the two ship together.
//
// `__gb__4205082553` — granted by its precomputed id, because the name is not in
// any shipped file — is the picker's *create* flag, read once in the whole
// renderer. It arms two things and nothing else: the second operand of the search
// placeholder's ternary, which is what makes the box read "Search or create a
// project" rather than "Search projects", and the `Create "<what you typed>"` row
// in the picker's footer. claude.ai reads it true; a build that folds it false
// leaves the create affordance to the "New project" row alone. The id form is the
// one `growthbookKey` already accepts for a gate the bundle spells only as a
// literal id.
const webShellGrantedGates = ["bad_moon_rising", "yukon_silver_dramatic_shrimp_clocks",
  "yukon_silver_folders", "yukon_silver_dramatic_shrimp_atrium", "__gb__4205082553",
  "amber_tributary_heron",
  // The cloud Routines page, backed by this instance's scheduled tasks (see
  // bridge/routines.mjs). Its detail view is where the API-trigger card lives,
  // and that card's fire URL is pointed at this deployment by the
  // `routine-fire-origin` renderer patch.
  "routines-chorus",
  // The routines availability read itself: `mh()` is
  // `capabilities.routines.enabled && W("chilling_sloth_clocks", …)`, and the
  // gate reader answers false for an absent feature, so the Code frame's
  // Routines/Scheduled entry needs both halves. The capability comes from the
  // environment-provider capabilities document; this is the rollout half.
  "chilling_sloth_clocks"];
// Cowork's "Skip all approvals" row is hidden twice over: the org's
// `cowork_settings.skip_approvals_enabled` must be true (it defaults false, and
// only an org admin can flip it) and the `cowork_bypass_permissions_mode`
// rollout flag must be on. A self-hosted, single-user deployment has no admin to
// turn the first on, so the bridge answers both as enabled. This is a real
// safety switch — it lets Cowork sessions run with no tool prompts, the same
// posture as the Code surface's bypass mode — so it defaults on only with the
// web shell and `CLAUDE_REMOTE_COWORK_SKIP_APPROVALS=0` restores the upstream
// value.
const coworkSkipApprovals = process.env.CLAUDE_REMOTE_COWORK_SKIP_APPROVALS === "1"
  || (webShellEnabled && process.env.CLAUDE_REMOTE_COWORK_SKIP_APPROVALS !== "0");
// Model the title generator is asked to use (CLAUDE_TITLE_MODEL). Desktop
// otherwise resolves its own small title model, which this gateway does not
// serve, so a title request must carry one; left unset, that is the session's
// model. Set it to a cheap model so titles do not spend the session's model —
// one that is also in CLAUDE_INFERENCE_MODELS_JSON, since Desktop drops a model
// its own list does not know and falls back to the refused one.
const titleModel = (process.env.CLAUDE_TITLE_MODEL || "").trim();
// Name the remote UI shows as the signed-in user. Desktop derives it from the
// OS app user ("app" in this image), which is what the sidebar user menu prints
// next to the provider label; the upstream gateway also sends no
// personalized_greeting, so the home greeting sits on the renderer's bare
// "You're here!" placeholder. Setting this replaces the footer identity and is
// folded into the time-based greeting below. Unset keeps Desktop's own value.
const remoteUserName = String(process.env.CLAUDE_REMOTE_USER_NAME || "").trim().slice(0, 80);
// The composer's model picker, laid out the way claude.ai lays it out: a short
// list of main models at the root, everything else behind the "More models"
// submenu. The renderer decides that split itself — each model entry's `section`
// ("main" | "overflow") picks its group and the array order is the root order —
// and the entries arrive in the bootstrap document this bridge already rewrites,
// so no renderer patch is involved (see applyModelPickerLayout).
//
// The list is the deployment's, and an operator edits it on the admin page, where
// it lives in the auth service; the bridge reads it per request
// (resolveMainModels -> GET /api/auth/deployment). CLAUDE_MODEL_PICKER_MAIN_MODELS
// is the env form, for a deployment without an auth service or as the fallback
// when that read fails. Either way it is a list of exact model ids, most
// convenient as the JSON array CLAUDE_INFERENCE_MODELS_JSON uses, and an empty
// list means the native layout: every model at the root, nothing rewritten.
const MODEL_PICKER_MAX_MODELS = 50;
const envMainModels = parseModelList(process.env.CLAUDE_MODEL_PICKER_MAIN_MODELS);
// The model the Desktop's configuration health check probes, named explicitly.
// Desktop picks one itself — the shortest entry whose name contains haiku,
// sonnet or opus — and reports that as the "configured model" in "Configured
// model not available"; no Desktop setting reaches that choice. The admin
// page's Models setting (authd) is the deployment's value; this env form is for
// a deployment without an auth service and the fallback when that read fails.
// Empty keeps Desktop's own pick.
const MAX_MODEL_ID_LEN = 200;
const envConfiguredModel = String(process.env.CLAUDE_CONFIGURED_MODEL || "")
  .trim()
  .slice(0, MAX_MODEL_ID_LEN);

/** A model-id list from a JSON array, or from a comma/newline-separated string.
 *  A value that opens like JSON but is not an array is a broken list, not a list
 *  of one id, and answers empty — an id that matches nothing is worse than none,
 *  since it silently leaves that model under "More models". */
function parseModelList(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  let items;
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  } else {
    items = text.split(/[\s,]+/);
  }
  return items
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, MODEL_PICKER_MAX_MODELS);
}

// Web-shell account identity. The browser chrome reads the signed-in account
// from the bootstrap `account` document and from GET /api/account(_profile),
// and reads the sidebar footer's provider label from ManagedConfig's
// managedRendererConfigStore (which the bridge otherwise blanks). A gateway
// deployment fills all of those with a synthetic identity — the OS app user and
// an organization named "Gateway" — so the account menu and footer read as a
// gateway config rather than a real account. When the web shell is on and any
// value below is set, the bridge overrides just the identity fields (name,
// email, avatar, organization, plan) on the documents it already rewrites;
// uuids, settings, capabilities and entitlements are left exactly as upstream
// sent them, so Cowork/Code and the time-based greeting keep working — the
// session-placement policy below is the one deliberate exception, flipping a
// single settings flag. A default
// deployment, and the Desktop shell, never reach any of this. This is identity
// only: the session itself belongs to the auth service (see docs/eva-mode.md),
// which is also where the account menu's own "Sign out" is pointed — the preload
// replaces that item's claude.ai logout with one that ends the real session.
function accountEnv(name, max) {
  return String(process.env[name] || "").trim().slice(0, max);
}
const accountIdentity = {
  name: accountEnv("CLAUDE_REMOTE_ACCOUNT_NAME", 80),
  email: accountEnv("CLAUDE_REMOTE_ACCOUNT_EMAIL", 200),
  organization: accountEnv("CLAUDE_REMOTE_ACCOUNT_ORG", 80),
  plan: accountEnv("CLAUDE_REMOTE_ACCOUNT_PLAN", 40),
  avatar: accountEnv("CLAUDE_REMOTE_ACCOUNT_AVATAR", 500),
  deployment: accountEnv("CLAUDE_REMOTE_DEPLOYMENT_NAME", 60),
};
function accountIdentityConfigured(identity) {
  return Boolean(identity && (identity.name || identity.email || identity.organization
    || identity.plan || identity.avatar || identity.deployment));
}
// The env-configured identity: used when no auth service is wired up, and as
// the fallback when a request carries no live session. The request-scoped
// resolver below is what callers use; this stays the single-body seam the
// account smoke pins, and is what a default deployment still resolves.
function resolveAccountIdentity() {
  return accountIdentity;
}
// The auth seam, filled: when AUTH_IDENTITY_URL points at the auth service, the
// bridge resolves the signed-in user from the request's session cookie, so the
// sidebar name, the account menu and the greeting read as that person rather
// than the synthetic gateway identity. Unset keeps the single env-configured
// identity, so a default deployment and the Maddie branch are unchanged.
// Deployment-wide fields (organization, plan, avatar, deployment name) stay
// operator-configured; only the person's name and email come from the account.
const authIdentityUrl = (process.env.AUTH_IDENTITY_URL || "").trim().replace(/\/+$/, "");
const authIdentityCache = new Map();
const AUTH_IDENTITY_TTL_MS = 30 * 1000;
const AUTH_IDENTITY_CACHE_MAX = 512;

// The signed-in person's own photo, served by the auth service at a fixed
// same-origin route (the deployment proxy sends /api/auth/* there). `?v=` is the
// photo's change time, so replacing it busts caches; someone with no photo gets
// "", which leaves avatar_image_url unset and the chrome on its default mark.
function accountAvatarUrl(user) {
  const id = Number(user?.id);
  const version = Number(user?.avatar_updated_at);
  if (!Number.isInteger(id) || id <= 0) return "";
  if (!Number.isInteger(version) || version <= 0) return "";
  return `/api/auth/avatar/${id}?v=${version}`;
}

async function fetchAuthIdentity(request) {
  const cookie = request?.headers?.cookie;
  if (!authIdentityUrl || !cookie) return null;
  const cached = authIdentityCache.get(cookie);
  if (cached && cached.expires > Date.now()) return cached.identity;
  let identity = null;
  try {
    const response = await fetch(`${authIdentityUrl}/api/auth/me`, { headers: { cookie } });
    if (response.ok) {
      const { user } = await response.json();
      if (user && !user.disabled) {
        identity = {
          name: String(user.first_name || user.email || "").trim().slice(0, 80),
          email: String(user.email || "").trim().slice(0, 200),
          avatar: accountAvatarUrl(user),
        };
      }
    }
  } catch { /* fall back to the env identity */ }
  if (authIdentityCache.size >= AUTH_IDENTITY_CACHE_MAX) authIdentityCache.clear();
  authIdentityCache.set(cookie, { identity, expires: Date.now() + AUTH_IDENTITY_TTL_MS });
  return identity;
}

// Application-layer auth for the bridge's own API.
//
// The deployment boundary assumes the reverse proxy is the only way in. That is
// true for the host's published port, but not for a peer container: every
// instance joins the same external `gateway_net`, and the bridge listens on
// 0.0.0.0 there, so one tenant's container (or its Cowork VM, through slirp)
// can reach every other tenant's API directly — no proxy, no session. That is a
// cross-account read/write path, not a hypothetical one.
//
// A tenant therefore always enables this gate; the deployment's own instance
// opts in with CLAUDESK_BRIDGE_AUTH=1 when it shares the network. The cookie is
// the one authd already issued (the proxy's forward_auth uses the same
// session), and it is scoped to this instance's account: a valid cookie for a
// different account on the box is not this instance's session. The mobile
// facade is server-to-server and has no browser cookie, so it carries a
// per-instance token minted by provision-user.sh / deploy.sh instead.
const bridgeAuthEnabled = process.env.CLAUDESK_BRIDGE_AUTH === "0"
  ? false
  : (process.env.CLAUDESK_BRIDGE_AUTH === "1"
    || process.env.CLAUDESK_TENANT === "1");
const bridgeToken = (process.env.CLAUDESK_BRIDGE_TOKEN || "").trim();
const bridgeAccountEmail = (process.env.CLAUDE_REMOTE_ACCOUNT_EMAIL || "")
  .trim().toLowerCase();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest();
}

// Compare through fixed-length digests so a wrong token cannot be recovered by
// timing, and a length difference cannot throw.
function hasBridgeToken(request) {
  if (!bridgeToken) return false;
  const supplied = request?.headers?.["x-claudesk-bridge-token"];
  if (typeof supplied !== "string" || !supplied) return false;
  return timingSafeEqual(sha256(bridgeToken), sha256(supplied.trim()));
}

async function authorizeApiRequest(request) {
  if (!bridgeAuthEnabled) return { ok: true };
  if (hasBridgeToken(request)) return { ok: true, internal: true };
  const identity = await fetchAuthIdentity(request);
  if (!identity) return { ok: false, status: 401, error: "not signed in" };
  if (bridgeAccountEmail
    && String(identity.email || "").trim().toLowerCase() !== bridgeAccountEmail) {
    return { ok: false, status: 403, error: "this instance belongs to a different account" };
  }
  return { ok: true, identity };
}

// The deployment's model settings, as the admin page saved them: the picker's
// layout and the model its health check probes. They live in the auth service
// (authd owns the settings and the admin page that edits them), so this is a
// plain read of a narrow, cookie-free route — the bootstrap it feeds is fetched
// on every page load, and the values change only when an operator edits them, so
// they are cached briefly. The env forms stand in when no auth service is wired
// up or the read fails, and an empty list means the native picker layout.
const deploymentSettingsCache = { models: null, configuredModel: null, expires: 0 };
const DEPLOYMENT_SETTINGS_TTL_MS = 30 * 1000;

/** Both deployment settings `/api/auth/deployment` answers, read in one request
 *  and cached together: the picker's layout list and the health check's
 *  configured model. Either falls back to its env form when the read fails. */
async function readDeploymentSettings() {
  if (!authIdentityUrl) {
    return { models: envMainModels, configuredModel: envConfiguredModel };
  }
  if (deploymentSettingsCache.models && deploymentSettingsCache.expires > Date.now()) {
    return {
      models: deploymentSettingsCache.models,
      configuredModel: deploymentSettingsCache.configuredModel,
    };
  }
  let models = null;
  let configuredModel = envConfiguredModel;
  try {
    const response = await fetch(`${authIdentityUrl}/api/auth/deployment`, {
      // A wedged auth service must not hold a page's first load open; the env
      // list (or none at all) covers the wait.
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const body = await response.json();
      const list = body?.model_picker_main_models;
      if (Array.isArray(list)) {
        models = list
          .filter((id) => typeof id === "string" && id.trim())
          .map((id) => id.trim())
          .slice(0, MODEL_PICKER_MAX_MODELS);
      }
      // A string — including "" — is authd's answer, so clearing the setting on
      // the admin page beats the env value rather than falling back to it.
      if (typeof body?.configured_model === "string") {
        configuredModel = body.configured_model.trim().slice(0, MAX_MODEL_ID_LEN);
      }
    }
  } catch { /* fall back to the env forms */ }
  if (models === null) models = envMainModels;
  deploymentSettingsCache.models = models;
  deploymentSettingsCache.configuredModel = configuredModel;
  deploymentSettingsCache.expires = Date.now() + DEPLOYMENT_SETTINGS_TTL_MS;
  return { models, configuredModel };
}

async function resolveMainModels() {
  return (await readDeploymentSettings()).models;
}

async function resolveConfiguredModel() {
  return (await readDeploymentSettings()).configuredModel;
}

async function resolveRequestAccountIdentity(request) {
  if (!authIdentityUrl) return resolveAccountIdentity();
  const user = await fetchAuthIdentity(request);
  if (!user) return null;
  return {
    name: user.name,
    email: user.email,
    organization: accountIdentity.organization,
    plan: accountIdentity.plan,
    // The person's own photo wins; a deployment-wide avatar stays the fallback.
    avatar: user.avatar || accountIdentity.avatar,
    deployment: accountIdentity.deployment,
  };
}
// The request identity for the store-sanitizing seam, with the env identity as
// the no-session fallback: resolveRequestAccountIdentity answers null when a
// session cookie resolves to nobody (a disabled account, a stale cookie) and the
// env identity when no auth service is wired up at all, so the caller wants one
// object either way.
async function resolveStoreIdentity(request) {
  return (await resolveRequestAccountIdentity(request).catch(() => null)) || accountIdentity;
}
// An avatar value is either a URL the browser loads directly, or a path to an
// image on this container that the bridge serves itself (see accountAvatar).
function avatarValueIsUrl(value) {
  return /^(?:https?:|data:|blob:|\/\/)/i.test(value);
}
// Set a field only when a non-empty override is given and it differs, so an
// unset value keeps the upstream's and a no-op returns the same reference.
function assignIdentityText(target, key, value, max) {
  const text = typeof value === "string" ? value.slice(0, max) : "";
  if (!text || target[key] === text) return false;
  target[key] = text;
  return true;
}
function applyOrganizationIdentity(organization, identity) {
  if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
    return organization;
  }
  if (!accountIdentityConfigured(identity)) return organization;
  const next = { ...organization };
  let changed = false;
  changed = assignIdentityText(next, "name", identity.organization, 80) || changed;
  changed = assignIdentityText(next, "plan_display_name", identity.plan, 40) || changed;
  return changed ? next : organization;
}
// Override the identity fields of an Account document, leaving everything else
// (uuid, settings, memberships' capabilities) untouched. Returns the same
// reference when nothing changed so the caller can detect a rewrite.
function applyAccountIdentity(account, identity) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return account;
  if (!accountIdentityConfigured(identity)) return account;
  const next = { ...account };
  let changed = false;
  changed = assignIdentityText(next, "display_name", identity.name, 80) || changed;
  changed = assignIdentityText(next, "full_name", identity.name, 80) || changed;
  changed = assignIdentityText(next, "email_address", identity.email, 200) || changed;
  // The profile photo. The account document carries two avatar fields: `avatar`
  // is a preset illustration index (1..72, mapped client-side to a built-in
  // SVG), while `avatar_image_url` is the uploaded photo the account menu
  // renders; a pfp is the latter.
  changed = assignIdentityText(next, "avatar_image_url", identity.avatar, 500) || changed;
  const memberships = next.memberships;
  if ((identity.organization || identity.plan) && Array.isArray(memberships)) {
    const index = memberships.findIndex((entry) => entry?.organization
      && typeof entry.organization === "object");
    if (index >= 0) {
      const organization = applyOrganizationIdentity(memberships[index].organization, identity);
      if (organization !== memberships[index].organization) {
        const updated = [...memberships];
        updated[index] = { ...memberships[index], organization };
        next.memberships = updated;
        changed = true;
      }
    }
  }
  return changed ? next : account;
}
// Remote (cloud) Cowork sessions — upstream's "dramatic shrimp" — have no
// backend in this deployment: the renderer primes one by POSTing
// /api/organizations/<org>/cowork/sessions, which only claude.ai serves (the
// bridge answers 404), and a new chat with manual approvals dies on that
// response instead of starting locally. The renderer treats remote as enabled
// unless the account's `settings.dramatic_shrimp_enabled` is exactly false
// (`enabled ?? true`), so declare it disabled on the bootstrap account the web
// shell's account context reads; the composer then takes the local path the
// Desktop client already uses. Merges into the existing settings object;
// unchanged accounts return the same reference.
// The uuid for a synthesised account, derived from the sign-in so it stays the
// same across reloads and bridge restarts (shaped like a name-based UUID v5).
function syntheticAccountUuid(seed) {
  const hex = createHash("sha256").update(String(seed || "")).digest("hex");
  const variant = "89ab"[Number.parseInt(hex[16], 16) & 0b11];
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

// The claude.ai chrome reads the bootstrap's `account` document as "who is
// signed in", and shows its sign-in page when it is absent. The app builds that
// document on first run and keeps it inside its browser profile — so a fresh
// profile (every account of a fresh deployment) answers `account: null` and the
// chrome never gets past sign-in. Build the document from the identity instead,
// matching the shape the app itself produces for a 3P gateway deployment.
function syntheticAccount(identity) {
  const uuid = syntheticAccountUuid(
    String(identity.email || identity.name || "").toLowerCase(),
  );
  const now = new Date().toISOString();
  return {
    tagged_id: `cowork_3p_${uuid}`,
    uuid,
    email_address: identity.email || "",
    full_name: identity.name || "",
    display_name: identity.name || "",
    created_at: now,
    updated_at: now,
    accepted_clickwrap_versions: {},
    is_verified: true,
    age_is_verified: true,
    memberships: [{
      role: "admin",
      seat_tier: "unassigned",
      created_at: now,
      updated_at: now,
      organization: {
        uuid: "00000000-0000-4000-8000-000000000001",
        id: 0,
        name: identity.organization || "Claudesk",
        settings: {},
        parent_organization_uuid: null,
        capabilities: ["chat", "claude_pro"],
        billing_type: "stripe_subscription",
        free_credits_status: null,
        api_disabled_reason: null,
        api_disabled_until: null,
        rate_limit_tier: null,
        data_retention: null,
        raven_type: null,
        claude_ai_bootstrap_models_config: [],
        plan_display_name: identity.plan || "Claudesk",
      },
    }],
    workspace_memberships: [],
    invites: [],
    settings: {
      code_default_transcript_view: "normal",
      paprika_mode: "auto",
      dismissed_claudeai_banners: [],
      enabled_wiggle_egress: true,
      wiggle_egress_hosts_template: "full_egress",
      enabled_geolocation: false,
      // Remote Cowork sessions are not served here; the web-shell account
      // policy sets this too, and making it explicit keeps the two in step.
      // The local upload lane's switch (`enabled_monkeys_in_a_barrel`) is the
      // policy's as well — see applyWebShellAccountPolicy.
      dramatic_shrimp_enabled: false,
    },
    ...(identity.avatar ? { avatar_image_url: identity.avatar } : {}),
  };
}

// The web shell's chat/Cowork attachments ride the renderer's local ("wiggle")
// upload lane: its cloud files API is off in this deployment
// (`session_files.files_api` is false), so the composer has no other way to
// send a file. That lane is gated on the account's
// `settings.enabled_monkeys_in_a_barrel`, and the renderer reads that gate
// before it makes any request: with it off, every attachment is marked
// "Upload failed" and a send is refused with "…couldn't be uploaded. Try
// sending again.", while the network tab stays empty. The app also couples the
// switch to unrelated feature toggles (turning off the "Files" preview clears
// it), so an account can lose attachments without anyone meaning to turn off
// code execution. This bridge serves the lane, so the web shell declares the
// switch on for every account. `CLAUDE_REMOTE_WIGGLE_UPLOADS=0` restores the
// stored value; a chat whose conversation pinned the setting off keeps it.
function applyWebShellAccountPolicy(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return account;
  const settings = account.settings === undefined ? {} : account.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return account;
  const next = {
    ...settings,
    dramatic_shrimp_enabled: false,
    ...(process.env.CLAUDE_REMOTE_WIGGLE_UPLOADS !== "0"
      ? { enabled_monkeys_in_a_barrel: true } : {}),
  };
  if (settings.dramatic_shrimp_enabled === next.dramatic_shrimp_enabled
    && settings.enabled_monkeys_in_a_barrel === next.enabled_monkeys_in_a_barrel) {
    return account;
  }
  return { ...account, settings: next };
}
const workspaceRoot = resolve(process.env.COWORK_REMOTE_WORKSPACE_ROOT || "/workspace");
// Temporary diagnosis channel for the web renderer: it POSTs named traces
// here and the operator reads them back with the same session. Bounded, and
// removed once the sidebar prefill behavior is settled.
const rendererTraces = [];
// The account avatar accepts a browser URL (http(s)/data:) or a path to an image
// on this container. A path is served by the bridge itself, same-origin, at one
// fixed route that returns only this configured file — the route takes no path
// or query, so it is not an arbitrary-file-read primitive. A `?v=` of the file's
// mtime busts caches when the file changes across a restart. An unusable path
// (missing, not a file, unsupported image type, too large) logs and is dropped,
// leaving the default illustration.
const accountAvatarRoute = "/api/remote/account/avatar";
const accountAvatarMaxBytes = 8 * 1024 * 1024;
const accountAvatarImageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
let accountAvatarFile = "";
let accountAvatarType = "";
if (accountIdentity.avatar && !avatarValueIsUrl(accountIdentity.avatar)) {
  const candidate = resolve(accountIdentity.avatar);
  const type = accountAvatarImageTypes[extname(candidate).toLowerCase()];
  try {
    const info = statSync(candidate);
    if (!info.isFile()) throw new Error("not a regular file");
    if (!type) throw new Error("unsupported image extension");
    if (info.size > accountAvatarMaxBytes) throw new Error("larger than the 8 MiB cap");
    accountAvatarFile = candidate;
    accountAvatarType = type;
    accountIdentity.avatar = `${accountAvatarRoute}?v=${Math.floor(info.mtimeMs)}`;
    console.log(`[cowork-bridge] web-shell account avatar served from ${candidate}`);
  } catch (error) {
    console.warn(`[cowork-bridge] CLAUDE_REMOTE_ACCOUNT_AVATAR path unusable (${candidate}): ${error.message}`);
    accountIdentity.avatar = "";
  }
}
// Roots the remote download route may serve from. The workspace is always
// allowed, because the web UI's own file browser reads from it; extra roots
// come from COWORK_REMOTE_READ_ROOTS so an operator can opt into reading other
// paths. These are paths as THIS container sees them, so a host directory needs
// a bind mount to be reachable. Default: workspace only.
const extraDownloadRoots = String(process.env.COWORK_REMOTE_READ_ROOTS || "")
  .split(/[:,]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => resolve(entry));
const downloadRoots = [...new Set([workspaceRoot, ...extraDownloadRoots])];
// Browser preview of Office/PDF session files. The pane's iframe asks this
// route, which serves a PDF: Office bytes are converted by the `office-preview`
// sidecar (LibreOffice, the same engine Desktop's own preview uses) and PDFs are
// passed through. The bridge never runs the converter, so the sidecar's memory
// is what a conversion costs; the cap below only bounds what the bridge buffers.
const officeConverterUrl = (
  process.env.CLAUDE_OFFICE_PREVIEW_URL || "http://127.0.0.1:8090"
).replace(/\/$/, "");
// Largest file the bridge will hand the session reader when Desktop itself
// refuses. Desktop caps its own reader at 10 MiB (SESSION_FILE_MAX_BYTES) and
// returns null above it; matching that by default avoids shipping huge bodies
// through the IPC route. Raise it to open larger text files in the file pane.
// Accepts a plain byte count or a K/M/G suffix, like COWORK_UPLOAD_MAX_BYTES;
// a bare suffix-less parseInt would silently read "100M" as 100 bytes.
const sessionFileCapBytes = parseUploadLimit(
  process.env.COWORK_REMOTE_SESSION_FILE_MAX_BYTES,
  10 * 1024 * 1024,
);
// Handing a file to the session reader means holding it several times over at
// once, so the container's own limit is what actually bounds the size that can
// be served: an 80 MB file under a 256 MB limit killed the process mid response
// and "restart: unless-stopped" looped it. sessionFileReadLimit() also clamps
// COWORK_REMOTE_SESSION_FILE_MAX_BYTES to an eighth of that limit, so raising
// the configured cap asks for a bigger preview but cannot take the bridge down.
function cgroupMemoryLimitBytes() {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw && raw !== "max") {
        const limit = Number(raw);
        if (Number.isFinite(limit) && limit > 0) return limit;
      }
    } catch {
      // Not in a cgroup-scoped container, or unreadable: fall through.
    }
  }
  return null;
}
const sessionFileMemoryLimitBytes = cgroupMemoryLimitBytes();
const sessionFileMaxBytes = sessionFileReadLimit({
  requestedBytes: sessionFileCapBytes,
  memoryLimitBytes: sessionFileMemoryLimitBytes,
});
// A preview buffers the whole source document and the PDF it becomes, so the
// same clamp applies: the configured COWORK_REMOTE_PREVIEW_MAX_BYTES (50 MiB
// default, matching Desktop) is capped to an eighth of the container's memory,
// at most 32 MiB. The document itself is converted in the sidecar, which carries
// its own limit; this only bounds what the bridge holds to stream the result.
const previewMaxBytes = sessionFileReadLimit({
  requestedBytes: parseUploadLimit(
    process.env.COWORK_REMOTE_PREVIEW_MAX_BYTES,
    50 * 1024 * 1024,
  ),
  memoryLimitBytes: sessionFileMemoryLimitBytes,
});
const artifactsRoot = resolve(
  process.env.COWORK_REMOTE_ARTIFACTS_ROOT || "/config/Claude/Artifacts",
);
// A Cowork session's deliverables live under Desktop's userData, not the
// workspace: `<sessionId>/<…>/outputs/…`. Desktop's own file-access consent
// treats that outputs directory as part of the session, so the download and
// preview routes serve it too — the model's file cards link straight to it.
// Everything else in this tree (memory, transcripts, settings) stays outside
// the readable roots; see resolveSessionOutputsPath.
const sessionOutputsRoot = resolve(
  process.env.COWORK_REMOTE_SESSION_OUTPUTS_ROOT
    || "/config/.config/Claude-3p/local-agent-mode-sessions",
);
const internalFailureExitThreshold = Number(
  process.env.COWORK_INTERNAL_FAILURE_EXIT_THRESHOLD || 3,
);
const publicDir = new URL("./public/", import.meta.url).pathname;
const undefinedSentinelKey = "__claudeRemoteUndefinedV1";
const release = JSON.parse(readFileSync(new URL("./release.json", import.meta.url), "utf8"));

function encodeIpcValue(value) {
  if (value === undefined) return { [undefinedSentinelKey]: true };
  if (Array.isArray(value)) return value.map(encodeIpcValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]),
    );
  }
  return value;
}

const configuredModels = (() => {
  try {
    const value = JSON.parse(process.env.CLAUDE_INFERENCE_MODELS_JSON || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .map((model) => typeof model?.name === "string" ? model.name : "")
      .filter(Boolean);
  } catch {
    return [];
  }
})();
// The same list with the label each entry displays as: the operator's
// `labelOverride` when they set one, else the id itself. This is what the admin
// page's model-picker card shows beside the id, so a name like "MiniMax M3" is
// recognisable without knowing the route name behind it.
const configuredModelCatalogue = (() => {
  try {
    const value = JSON.parse(process.env.CLAUDE_INFERENCE_MODELS_JSON || "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((model) => {
      if (typeof model === "string") return model ? [{ id: model, name: model }] : [];
      if (typeof model?.name !== "string" || !model.name) return [];
      const label = typeof model.labelOverride === "string" ? model.labelOverride.trim() : "";
      return [{ id: model.name, name: label || model.name }];
    });
  } catch {
    return [];
  }
})();
const allowedModels = new Set(configuredModels);
// The model a routine fire uses when the task itself names none. The operator's
// JSON may mark one entry as the family default; otherwise the first configured
// model is the deployment's default, exactly as the picker treats it.
const defaultInferenceModel = (() => {
  try {
    const value = JSON.parse(process.env.CLAUDE_INFERENCE_MODELS_JSON || "[]");
    const list = Array.isArray(value) ? value : [];
    const named = (entry) => typeof entry === "string"
      ? entry
      : typeof entry?.name === "string" ? entry.name : "";
    const flagged = list.find((entry) =>
      entry && typeof entry === "object" && entry.isFamilyDefault === true && named(entry));
    return named(flagged) || list.map(named).find(Boolean) || "";
  } catch {
    return "";
  }
})();
const allowedDeveloperActions = new Set([
  "record-memory-trace",
  "reload-mcp-configuration",
  "show-all-dev-tools",
  "show-dev-tools",
  "toggle-main-process-debugger",
  "toggle-performance-trace",
  "write-main-process-heap-snapshot",
]);
const allowedDeveloperFileKinds = new Set([
  "app-config",
  "developer-config",
  "mcp-log",
]);

const allowedMethods = new Map([
  ["Account", new Set(["setAccountDetails"])],
  ["WebBuild", new Set(["reportCommitHash"])],
  ["ClaudeVM", new Set([
    "checkVirtualMachinePlatform",
    "download",
    "getDownloadStatus",
    "getRunningStatus",
    "isHostLoopDevOverrideActive",
    "isHostLoopModeEnabled",
    "startVM",
  ])],
  ["LocalAgentModeSessions", new Set([
    "archive",
    "delete",
    "getAll",
    "getDefaultWorkspaceFolders",
    "getSession",
    "getSessionsForScheduledTask",
    "getSupportedCommands",
    "getTranscript",
    "searchSessions",
    "respondToToolPermission",
    "rewind",
    "sendMessage",
    "setFocusedSession",
    "setEffort",
    "setExtendedThinking",
    "setModel",
    "setPermissionMode",
    // Attachments for a session that runs on another host (a tenant's
    // Code/Cowork runner) are staged by Desktop itself: the renderer only asks
    // whether this method exists (`ig()` in the composer) and then calls it with
    // the session id and the file paths. Withholding it made that check false,
    // so the staging plan left every file unstaged and the composer reported
    // "Upload failed" / "…couldn't be uploaded. Try sending again." with no
    // request at all. Its `paths` input is a bounded string array; Desktop's
    // implementation validates the session and refuses oversized lists.
    "stageRemoteSessionAttachmentsViaFilesApi",
    "start",
    "stop",
    "updateSession",
  ])],
  ["CoworkArtifacts", new Set([
    "getAllArtifacts",
    "getArtifactIndexHtmlPath",
    "getArtifactMetadata",
    "getArtifactThumbnail",
    "hideArtifact",
    "importArtifact",
    "isAutoPublishEnabled",
    "isSharingEnabled",
    "parkAndCaptureArtifact",
    "printArtifactToPdf",
    "refreshImportedArtifact",
    "reloadArtifactView",
    "setArtifactAutoPublish",
    "setArtifactLastModifiedSession",
    "setArtifactMcpTools",
    "setArtifactStarred",
    "shareArtifact",
    "showArtifact",
    "unshareArtifact",
  ])],
  ["CoworkFilePreview", new Set([
    "hide",
    "isEnabled",
    "isEpitaxyPreviewEnabled",
    "isOpenInDefaultAppEnabled",
    "isVmReady",
    "parkAndCapture",
    "show",
  ])],
  ["CoworkMemory", new Set(["listAccountMemories", "readAccountMemory", "readGlobalMemory"])],
  // Cowork scheduled tasks ("routines") are the account's own, not an operator
  // surface: they run in the account's own instance, and the renderer gates its
  // "New task" button and its delete on the presence of these very methods
  // (`!!claude.web.CoworkScheduledTasks.createScheduledTask`, an
  // optional-chained `updateScheduledTaskStatus`) — so withholding them does not
  // deny the capability, it only breaks the UI while the same account can still
  // create and delete routines by asking its agent (whose path never crosses
  // this browser allow-list). The reads feed the list; the writes feed creation,
  // enable/disable and delete; the rest are the dispatch handshake the web shell
  // mounts the runner and host for, so a client that can be scheduled must be
  // able to take part. All of them stay unconditional.
  ["CoworkScheduledTasks", new Set([
    "ackEvent",
    "createScheduledTask",
    "getAllScheduledTasks",
    "getScheduledTaskFileContent",
    "getWatcherHistory",
    "markListenerReady",
    "releaseDispatchClaim",
    "setEventAckSupported",
    "setHostRunsSupported",
    "updateScheduledTask",
    "updateScheduledTaskFileContent",
    "updateScheduledTaskStatus",
  ])],
  // The Code store, where routines live. Its surface is the official one,
  // including the dispatch handshake, so the Code scheduled-task page keeps
  // working in the browser; the bridge and the wrapper carry the same methods
  // (bridge-parity-smoke).
  ["CCDScheduledTasks", new Set([
    "ackEvent",
    "createScheduledTask",
    "getAllScheduledTasks",
    "getScheduledTaskFileContent",
    "getWatcherHistory",
    "markListenerReady",
    "releaseDispatchClaim",
    "removeApprovedPermission",
    "setEventAckSupported",
    "setHostRunsSupported",
    "updateScheduledTask",
    "updateScheduledTaskStatus",
  ])],
  ["CoworkSpaces", new Set([
    "classifySessions",
    "getAllSpaces",
    "getAutoMemoryDir",
    "getRemoteSessionSpaces",
    "getSpace",
    "listFolderContents",
    "openFile",
    "readFileContents",
    "readSpaceMemoryIndex",
    "summarizeSpace",
  ])],
  ["CoworkUserFiles", new Set(["getInfo"])],
  ["DocumentFunnel", new Set([
    "ensureScratchRoot",
    "injectDocumentContext",
    "ingestSessionDocument",
    "listScratchWorkingFiles",
    "openDownloadExport",
    "revealDownloadExport",
    "runClarkdownConvert",
    "runClarkdownDownloadExport",
    "writeScratchFile",
  ])],
  ["FileSystem", new Set([
    "appInfoForExtension",
    "browseCodeFolder",
    "browseFiles",
    "browseFolder",
    "browseFolders",
    "getLocalFileThumbnail",
    "getSystemPath",
    "listDirectory",
    "listFilesInFolder",
    "openLocalFile",
    "readLocalFile",
    // Not an operator action: this is how the composer materializes a file the
    // browser has no path for. The renderer calls it when an attachment is
    // staged to a session host ("remote" sessions — a tenant's Code/Cowork
    // runner) and `claudeAppSettings.filePickers.getPathForFile` is absent.
    // Without it the staging plan marks every file `ipc_unavailable`, which the
    // composer reports as "Upload failed" and refuses the send with
    // "…couldn't be uploaded. Try sending again." — before any request is made.
    // It writes the given bytes into the workspace; it takes no path.
    "savePastedFile",
    "showInFolder",
    "whichApplication",
    "writeFileDownload",
    "writeFileDownloadAndOpen",
  ])],
  ["OpenDocuments", new Set(["getOpenDocuments", "readOpenDocumentAsBase64"])],
]);

if (infrastructureActionsEnabled) {
  for (const method of [
    "deleteArtifact",
  ]) allowedMethods.get("CoworkArtifacts").add(method);
  for (const method of [
    "deleteAccountMemory",
    "writeAccountMemory",
    "writeGlobalMemory",
  ]) allowedMethods.get("CoworkMemory").add(method);
  for (const method of [
    "addFolderToSpace",
    "addLinkToSpace",
    "addProjectToSpace",
    "appendRemoteSessionSpaceFolders",
    "copyFilesToSpaceFolder",
    "createSpace",
    "createSpaceFolder",
    "deleteSpace",
    "removeFolderFromSpace",
    "removeLinkFromSpace",
    "removeProjectFromSpace",
    "removeRemoteSessionSpace",
    "setAutoDescription",
    "setRemoteSessionSpace",
    "updateSpace",
  ]) allowedMethods.get("CoworkSpaces").add(method);
  for (const method of ["migrate", "pickTarget", "reveal"]) {
    allowedMethods.get("CoworkUserFiles").add(method);
  }
  // `savePastedFile` deliberately stays out of this group: it is the composer's
  // attachment materialization (see the base FileSystem allowlist), needed by
  // every account. The rest write to a caller-named path or an external store,
  // which is the operator-only part.
  for (const method of [
    "exportLocalFileToGoogleDrive",
    "promoteScratchpadFile",
    "writeLocalFile",
  ]) allowedMethods.get("FileSystem").add(method);
}

if (developerActionsEnabled) {
  for (const method of [
    "deleteLocalSkill",
    "getLocalSkillFiles",
    "listLocalSkills",
    "saveLocalSkill",
    "setLocalSkillEnabled",
    "syncSkills",
  ]) {
    allowedMethods.get("LocalAgentModeSessions").add(method);
  }
  allowedMethods.set("CustomPlugins", new Set([
    "addMarketplace",
    "checkPluginHasLocalChanges",
    "getAndClearMigrationIssues",
    "getCachedCommands",
    "getInstallCounts",
    "installLocalOrgPlugin",
    "installPlugin",
    "listAvailablePlugins",
    "listInstalledPlugins",
    "listLocalOrgPlugins",
    "listMarketplaces",
    "listRemotePluginsPage",
    "refreshMarketplace",
    "removeMarketplace",
    "syncLocalOrgPlugins",
    "uninstallPlugin",
    "updatePlugin",
  ]));
  allowedMethods.set("LocalPlugins", new Set([
    "deletePlugin",
    "getDownloadedRemotePlugins",
    "getPluginCliBatch",
    "getPluginCliStatus",
    "getPluginShimOps",
    "getPlugins",
    "listSkillFiles",
    "revokePluginOAuth",
    "setPluginEnabled",
    "setPluginEnvVars",
    "setPluginOAuthClient",
    "setPluginShimPermission",
    "startPluginOAuthFlow",
    "syncRemotePlugins",
    "uploadPlugin",
  ]));
  allowedMethods.set("PluginBridgeMcp", new Set(["listServers"]));
}

if (connectorsEnabled) {
  for (const method of [
    "authorizeDirectMcpServer",
    "directMcpCallTool",
    "directMcpListResources",
    "directMcpReadResource",
    "disconnectDirectMcpServer",
    "getDirectMcpServerStatuses",
    "getLocalMcpServers",
    "mcpAuthenticate",
    "mcpReconnect",
    "mcpSubmitOAuthCallbackUrl",
    "replaceEnabledMcpTools",
    "replaceRemoteMcpServers",
    "setMcpServers",
  ]) {
    allowedMethods.get("LocalAgentModeSessions").add(method);
  }
}

if (codeActionsEnabled) {
  allowedMethods.set("LocalSessions", new Set([
    "addDirectories",
    "applyFlagSettings",
    "archive",
    "cancelQueuedMessage",
    "changeCwd",
    "checkStoredTrust",
    "checkTrust",
    "cleanupAutoModeProposalFile",
    "clearSession",
    "createAgent",
    "delete",
    "discardPendingTurn",
    "findLocalSessionIdForBridgeId",
    "forkSession",
    "getAgents",
    "getAll",
    "getBusyShellPtyKeys",
    "getCodeStats",
    "getCommitDiff",
    "getContextUsage",
    "getDefaultEffort",
    "getDefaultPermissionMode",
    "getDetectedProjects",
    "getDiffFileContent",
    "getEffort",
    "getGitCommits",
    "getGitDiff",
    "getGitDiffFilePatch",
    "getGitDiffStats",
    "getGitInfo",
    "getInstalledEditors",
    "getLocalBranches",
    "getLocalMcpServers",
    "getPermissionMode",
    "getPlanForSession",
    "getSession",
    "getSessionMediaStreamUrl",
    "getSessionPanelMediaStreamUrl",
    "getSessionsForScheduledTask",
    "getShellPtyBuffer",
    "getSupportedCommands",
    "getTranscript",
    "getTranscriptTail",
    "getUncommittedChanges",
    "interrupt",
    "isVSCodeInstalled",
    "listSessionDirectory",
    "logCliEvent",
    "mcpAuthenticate",
    "mcpCallTool",
    "mcpListResources",
    "mcpReadResource",
    "mcpReconnect",
    "mcpSubmitOAuthCallbackUrl",
    "openInEditor",
    "openInVSCode",
    "openSessionFileInDefaultApp",
    "pickFileAtCwd",
    "pickSessionFile",
    "prewarmAuth",
    "promoteQueuedMessage",
    "readFileAtCwd",
    "readSessionFile",
    "readSessionFileWithStatus",
    "readSessionImageAsDataUrl",
    "readSessionMediaAsDataUrl",
    "readSessionPanelMediaAsDataUrl",
    "reorderQueuedMessage",
    "replaceEnabledMcpTools",
    "replaceRemoteMcpServers",
    "reportComposerInp",
    "reportStreamRender",
    "reportSwitchTiming",
    "resolveSessionFile",
    "respondToRefusalFallbackPrompt",
    "respondToToolPermission",
    "resizePty",
    "resizeShellPty",
    "resumePreClearSession",
    "rewind",
    "rewindV2",
    "runBashCommand",
    "saveTrust",
    "searchSessions",
    "sendMessage",
    "sendSideChatMessage",
    "setAccountBranchPrefix",
    "setAvailableCodeModels",
    "setEffort",
    "setFastMode",
    "setFocusedSession",
    "setMcpServers",
    "setModel",
    "setPermissionMode",
    "showSessionFileInFolder",
    "showSessionFilePreview",
    "start",
    "startPty",
    "startShellPty",
    "startSideChat",
    "stop",
    "stopPty",
    "stopSessionSummary",
    "stopShellPty",
    "stopSideChat",
    "stopTask",
    "submitFeedback",
    "summarizeSession",
    "summarizeTranscript",
    "unarchive",
    "updateSession",
    "warmSession",
    "writeAutoModeProposalFile",
    "writePty",
    "writeSessionFile",
    "writeShellPty",
  ]));
  allowedMethods.set("LocalSessionEnvironment", new Set(["get", "save"]));
}

if (tenantCodeReadsEnabled && !codeActionsEnabled) {
  allowedMethods.set("LocalSessions", new Set(tenantGitReadMethods));
}

const allowedSettingsMethods = gatewaySettingsEnabled
  ? new Map([
      ["AppPreferences", new Set(["getPreferences", "setPreference"])],
      ["Custom3pSetup", new Set([
        "createConfig",
        "deleteConfig",
        "duplicateConfig",
        "exportConfig",
        "getConfigHealth",
        "getLoginDesktop3pStatus",
        "authorizeAndProbeMcpServer",
        "forgetMcpOAuth",
        "listConfigs",
        "probeEgressHosts",
        "probeMcpServer",
        "readConfig",
        "recheckConfigHealth",
        "relaunchApp",
        "renameConfig",
        "revealConfig",
        "scanOrgPlugins",
        "setAppliedConfig",
        "triggerBootstrapAuth",
        "writeConfig",
      ])],
      ["Custom3pHelperRun", new Set([
        "discoverModels",
        "probeInference",
        "runCredentialHelper",
      ])],
    ])
  : new Map();

const remoteListenerMethods = new Map([
  ["ClaudeVM", new Set([
    "onDownloadProgress",
    "onDownloadStatusChanged",
    "onRunningStatusChanged",
    "onStartupError",
  ])],
  ["LocalAgentModeSessions", new Set([
    "onOnBridgePermissionPreflight",
    "onOnCoworkFromMain",
    "onOnEvent",
    "onOnManagedAskToolNamesChanged",
    "onOnToolPermissionRequest",
  ])],
  ["CoworkArtifacts", new Set(["onOnArtifactsChanged"])],
  ["CoworkScheduledTasks", new Set(["onOnScheduledTaskEvent"])],
  ["CCDScheduledTasks", new Set(["onOnScheduledTaskEvent"])],
  ["CoworkSpaces", new Set(["onOnSpaceEvent"])],
  ["DocumentFunnel", new Set(["onWorkingDocumentsChanged"])],
  // Not a `claude.web` surface on the Desktop side: the wrapper publishes the
  // notifications the official app decides to show, for the remote preload to
  // render in the browser (see bridge/notifications.mjs for the push side).
  ["DesktopNotifications", new Set(["onNotification", "onNotificationClosed"])],
  // Also wrapper-published: a directory dialog the Desktop main process opened
  // (Cowork's folder grant), handed to the browser's in-page picker because the
  // native one renders on the container's headless display.
  ["RemoteFolderPicker", new Set(["onRequest"])],
]);

if (codeActionsEnabled) {
  remoteListenerMethods.set("LocalSessions", new Set([
    "onOnEvent",
    "onOnToolPermissionRequest",
  ]));
}

if (developerActionsEnabled) {
  remoteListenerMethods.set("CustomPlugins", new Set(["onInstallProgress"]));
  remoteListenerMethods.set("LocalPlugins", new Set(["onOnCliOpAlwaysAllowed"]));
}

if (connectorsEnabled) {
  remoteListenerMethods.get("LocalAgentModeSessions").add(
    "onOnDirectMcpServerStatusesChanged",
  );
  remoteListenerMethods.set("PluginBridgeMcp", new Set(["onChanged"]));
}

const allowedStores = new Map([
  ["LocalAgentModeSessions", new Set([
    "interactiveAuthStore",
    "sessionsBridgeStatusStore",
  ])],
  ["ManagedConfig", new Set(["managedRendererConfigStore"])],
  ["ClaudeVM", new Set(["apiReachabilityStore"])],
]);

const protocolRules = [
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap$/ },
  { methods: new Set(["GET"]), path: /^\/edge-api\/bootstrap\/[0-9a-f-]+\/app_start$/i },
  // The Desktop frame bootstraps under /edge-api; a plain browser (the web
  // shell) uses the claude.ai default /api prefix, so allow its bootstrap too.
  { methods: new Set(["GET"]), path: /^\/api\/bootstrap\/[0-9a-f-]+\/app_start$/i },
  { methods: new Set(["GET"]), path: /^\/api\/bootstrap(?:\/[^/?#]+\/(?:current_user_access|system_prompts|cowork_sysprompt_map))?$/ },
  { methods: new Set(["GET", "PUT"]), path: /^\/api\/account_profile$/ },
  { methods: new Set(["PATCH"]), path: /^\/api\/account\/settings$/ },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+$/i },
  { methods: new Set(["GET"]), path: /^\/api\/organizations\/[0-9a-f-]+\/(?:feature_settings|cowork_settings|office_settings)$/i },
  { methods: new Set(["POST"]), path: /^\/api\/organizations\/[0-9a-f-]+\/dust\/(?:generate_title_and_branch|generate_session_title)$/i },
  { methods: new Set(["PATCH"]), path: /^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/[A-Za-z0-9_-]+$/i },
];

// Notification settings endpoints answered by the bridge itself (see the
// notification controller); deliberately outside `protocolRules` so they are
// never forwarded to the upstream API.
const notificationPreferencesPath = /^\/api\/organizations\/[0-9a-f-]+\/notification\/preferences$/i;
const notificationChannelsPath = /^\/api\/organizations\/[0-9a-f-]+\/notification\/channels$/i;

// The connectors surface (Settings → Connectors, the "Add connector" control and
// the plugin-connector rows) talks to claude.ai's connectors API. A self-hosted
// deployment has no such backend, so the bridge answers the family itself (see
// bridge/connectors.mjs). Capture [1] the resource and [2] the raw tail
// (`/{id}/{sub}/{subname}`), which the handler splits.
const connectorsPath = /^\/api\/organizations\/[0-9a-f-]+\/mcp\/(remote_servers(?:_with_connection)?|ema_health)(\/[^?#]*)?\/?$/i;

// Projects. The official bundle's project surfaces speak claude.ai's projects
// API — the `/projects` page and create form, the `/projects_v2` list, the
// `/project/<uuid>` detail route and the composer's project selector — and this
// deployment has no such backend, so the bridge answers the family from the
// Desktop's CoworkSpaces store itself (see bridge/projects.mjs). Capture [1] the
// resource (`projects` or `projects_v2`) and [2] the raw tail
// (`/{id}/{sub}/{subname}`), which the handler splits.
const projectsPath = /^\/api\/organizations\/[0-9a-f-]+\/(projects_v2|projects)(\/[^?#]*)?\/?$/i;

const officialAssetPrefixes = [
  "/_frame-rt/",
  "/assets/",
  "/audio/",
  "/i18n/",
  "/images/",
];

const officialAssetFiles = new Set([
  "/desktop-icon.png",
  "/favicon.ico",
  "/frame-shell.html",
  "/robots.txt",
  "/scc.json",
]);

const allowedSurfaces = new Set(allowedMethods.keys());

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

class DesktopInternalClient {
  async request(pathname, options = {}) {
    const response = await fetch(`${coworkInternalUrl}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || `internal Cowork bridge returned ${response.status}`);
    }
    return body;
  }

  async invoke(surface, method, args, argsEncoding) {
    const serializedArgs = argsEncoding === "json-undefined-v1"
      ? encodeIpcValue(args)
      : args;
    const body = await this.request("/invoke", {
      method: "POST",
      body: JSON.stringify({ surface, method, args: serializedArgs, argsEncoding }),
    });
    return body.value;
  }

  async invokeSettings(surface, method, args, argsEncoding) {
    const body = await this.request("/settings-invoke", {
      method: "POST",
      body: JSON.stringify({ surface, method, args, argsEncoding }),
    });
    return body.value;
  }

  async inspect() {
    const body = await this.request("/health");
    return body.surfaces;
  }

  async fetchRaw(pathname, options = {}) {
    return fetch(`${coworkInternalUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(120000),
    });
  }

  async readStore(surface, store) {
    const body = await this.request("/store", {
      method: "POST",
      body: JSON.stringify({ surface, store }),
    });
    return body.value;
  }

  async bootFeatures() {
    const body = await this.request("/boot-features");
    return body.value;
  }

  async runtime() {
    const body = await this.request("/runtime");
    return body.value;
  }

  async mainMenu() {
    const body = await this.request("/main-menu");
    return Array.isArray(body.value) ? body.value : [];
  }

  async mainMenuAction(action) {
    const body = await this.request("/main-menu-action", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    return body.value;
  }

  async readDeveloperFile(kind) {
    const body = await this.request(`/developer-file?kind=${encodeURIComponent(kind)}`);
    return body.value;
  }

  async writeDeveloperFile(kind, content) {
    const body = await this.request("/developer-file", {
      method: "PUT",
      body: JSON.stringify({ kind, content }),
    });
    return body.value;
  }

  async listDeveloperArtifacts() {
    const body = await this.request("/developer-artifacts");
    return Array.isArray(body.value) ? body.value : [];
  }

  async protocol(value) {
    const body = await this.request("/protocol", {
      method: "POST",
      body: JSON.stringify(value),
    });
    return body.value;
  }

  async pollEvents() {
    const body = await this.request("/events");
    return Array.isArray(body.value) ? body.value : [];
  }

  async generateTitle(message, model) {
    const body = await this.request("/generate-title", {
      method: "POST",
      body: JSON.stringify({ message, model }),
    });
    return body.value;
  }

  async drainNotifications() {
    const body = await this.request("/notifications");
    return Array.isArray(body.value) ? body.value : [];
  }

  async notificationClick(tag, action) {
    const body = await this.request("/notification-click", {
      method: "POST",
      body: JSON.stringify({ tag, action }),
    });
    return body.value;
  }

  async folderPick(id, canceled, paths) {
    const body = await this.request("/folder-pick", {
      method: "POST",
      body: JSON.stringify({ id, canceled, paths }),
    });
    return body.value;
  }
}

const desktop = new DesktopInternalClient();

// A routine fire has no composer to name a model, so it takes the first model
// this instance offers. The operator's env list is the static answer; a
// deployment in gateway-discovery mode leaves that empty, and the picker's
// models — recorded from a served bootstrap, or read from the Desktop when no
// page has loaded yet — are the list the account can actually use.
async function routineModels() {
  if (!pickerModelsSeen.models.length) await refreshPickerModels();
  const seen = pickerModelsSeen.models.map((model) => model.id).filter(Boolean);
  if (seen.length) return seen;
  if (configuredModels.length) return configuredModels;
  // A page has not been served and the Desktop read failed; the admin page's
  // main-model list is still a set of ids this gateway serves.
  return resolveMainModels();
}

// Routine triggers (see bridge/routines.mjs). Instantiated after the Desktop
// client it calls; `wakeRunnerVm` is a hoisted function declaration.
const routines = createRoutineService({
  stateDir: bridgeStateDir,
  desktop,
  codeRunners,
  configuredModels,
  defaultModel: defaultInferenceModel,
  resolveModels: routineModels,
  authIdentityUrl,
  wakeRunner: wakeRunnerVm,
  log: console,
});

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

// A response that stands in for an upstream API the app fetches directly. Those
// routes must put the document on the wire exactly as the real backend would —
// not wrapped in the bridge's own `{ok, value}` envelope, which the app parses
// as the document itself (`data.preferences.feature_preference` would then read
// off the envelope and crash the settings panel).
function sendOfficialDocument(response, document) {
  const body = Buffer.from(JSON.stringify(document), "utf8");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendDesktopReconnectPage(response) {
  const body = Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <title>Claudesk 正在重新连接</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(32rem, calc(100% - 3rem)); text-align: center; }
    h1 { font-size: 1.4rem; font-weight: 600; }
    p { line-height: 1.6; opacity: .72; }
    a { display: inline-block; margin-top: .5rem; padding: .65rem 1rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: .65rem; color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>正在重新连接 Claude Desktop</h1>
    <p>修改 API 配置或重启服务后可能需要一小段时间。页面将在 3 秒后自动重试。</p>
    <a href="/">立即重试</a>
  </main>
</body>
</html>`, "utf8");
  response.writeHead(503, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "text/html; charset=utf-8",
    "Retry-After": "3",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function isDocumentNavigation(request) {
  if (request.method !== "GET") return false;
  if (request.headers["sec-fetch-dest"] === "document") return true;
  return String(request.headers.accept || "").includes("text/html");
}

// Browser notifications: push subscriptions, the local notification-preferences
// document the settings panel reads, and the always-on drain of the wrapper's
// notification queue. Created before the realtime controller because each one
// needs a late-bound view of the other (the push side must know whether a page
// is connected, the event relay must know whether a category is enabled).
const notifications = createNotificationController({
  desktop,
  stateDir: bridgeStateDir,
  hasRecentRealtimeClient: () => realtime.hasRecentClient(),
  pushSubject: process.env.CLAUDE_REMOTE_PUSH_SUBJECT || "mailto:claudesk@localhost",
});

// Connectors (remote MCP servers): the definitions a user adds under Settings →
// Connectors, answered and stored locally because a self-hosted deployment has
// no claude.ai connectors backend (see bridge/connectors.mjs). Per-instance —
// the bridge data directory is already one account's.
const connectors = createConnectorStore({
  stateDir: bridgeStateDir,
});

// Projects: the `/projects` page, its create form, the project detail route and
// the composer's project selector all speak claude.ai's projects API, which this
// deployment answers from the Desktop's CoworkSpaces store over IPC (see
// bridge/projects.mjs). Per-instance, like the connectors above.
const projects = createProjectBackend({
  desktop,
  stateDir: bridgeStateDir,
});

const realtime = createRealtimeController({
  desktop,
  isChatSession,
  ApiError,
  release,
  eventAllowed: (payload) => notifications.notificationAllowed(payload),
});
// A notice from the previous bridge — its restart warning — is read back before
// anything connects, so pages whose stream died mid-restart still learn why when
// they reconnect. Publishing one writes it out (see bridge/notices.mjs).
realtime.restore(loadNotice(bridgeStateDir));
function publishNotice(payload, ttlMs) {
  const record = realtime.notify(payload, ttlMs);
  try {
    saveNotice(bridgeStateDir, record);
  } catch (error) {
    // A read-only state directory only costs the replay to pages that reconnect
    // after this bridge is gone; the live broadcast has already gone out.
    console.error(`[cowork-bridge] could not persist the notice: ${error.message}`);
  }
  return record;
}
const uploads = createUploadHandler({
  ApiError,
  workspaceRoot,
  maxBytes: parseUploadLimit(process.env.COWORK_UPLOAD_MAX_BYTES),
});
const handleDownload = createDownloadHandler({
  ApiError,
  artifactsRoot,
  mimeTypes,
  downloadRoots,
  sessionOutputsRoot,
});
const handleFilePreview = createPreviewHandler({
  ApiError,
  downloadRoots,
  sessionOutputsRoot,
  maxBytes: previewMaxBytes,
  converterUrl: officeConverterUrl,
});

async function readJson(request, maxSize = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new ApiError(413, "request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRequestBuffer(request, maxSize = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new ApiError(413, "request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateStoreRead(surface, store) {
  if (!allowedStores.get(surface)?.has(store)) {
    throw new ApiError(400, "Desktop store is not allowed");
  }
}

function validateProtocolRequest(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!protocolRules.some((rule) =>
    rule.methods.has(normalizedMethod) && rule.path.test(pathname)
  )) {
    throw new ApiError(404, "Desktop protocol path is not allowed");
  }
  return normalizedMethod;
}

function validateAccountProfileUpdate(method, pathname, body) {
  if (method !== "PUT" || pathname !== "/api/account_profile") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Account profile update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Account profile update must be an object");
  }
  const allowedKeys = new Set([
    "avatar",
    "conversation_preferences",
    "cowork_global_instructions",
    "cowork_global_instructions_sha256",
    "cowork_instructions_union",
    "work_function",
  ]);
  const keys = Object.keys(parsed);
  if (!keys.length || keys.some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "Account profile update contains a forbidden field");
  }
  for (const key of ["conversation_preferences", "cowork_global_instructions"]) {
    if (key in parsed && (typeof parsed[key] !== "string" || parsed[key].length > 10000)) {
      throw new ApiError(400, `${key} must be a string of at most 10000 characters`);
    }
  }
  // The profile editor saves the global instructions alongside the hash it has
  // for them and whether they should apply in Cowork; without these two keys an
  // instruction change was rejected as a forbidden field.
  if ("cowork_global_instructions_sha256" in parsed &&
      (typeof parsed.cowork_global_instructions_sha256 !== "string"
        || !/^[0-9a-f]{64}$/i.test(parsed.cowork_global_instructions_sha256))) {
    throw new ApiError(400, "cowork_global_instructions_sha256 must be a SHA-256 hex digest");
  }
  if ("cowork_instructions_union" in parsed &&
      typeof parsed.cowork_instructions_union !== "boolean") {
    throw new ApiError(400, "cowork_instructions_union must be a boolean");
  }
  if ("work_function" in parsed &&
      (typeof parsed.work_function !== "string" || parsed.work_function.length > 128)) {
    throw new ApiError(400, "work_function must be a string of at most 128 characters");
  }
  if ("avatar" in parsed &&
      (!Number.isInteger(parsed.avatar) || parsed.avatar < 0 || parsed.avatar > 72)) {
    throw new ApiError(400, "avatar must be an integer between 0 and 72");
  }
}

// The official renderer persists the account's own UI settings with a PATCH to
// /api/account/settings. That is not one control: the Chat toggles, the Code
// settings (transcript view, branch prefix, auto-archive, model fallback),
// onboarding, banners, voice and egress all write different keys, and the set
// grows with the bundle (the iOS protobuf alone names a dozen-plus, and Desktop
// adds its own). Enumerating them only ever trailed the bundle — each missed key
// rolled back with "Account setting is not allowed", so a picker's change did not
// stick. Validate the body's shape instead: a bounded object of bounded JSON
// values, with `internal_*` kept out (the renderer strips those itself and they
// are not settings). The upstream API still sees only keys it knows.
const accountSettingKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function validateAccountSettingsUpdate(method, pathname, body) {
  if (method !== "PATCH" || pathname !== "/api/account/settings") return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Account setting update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Account setting update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new ApiError(400, "Account setting update is empty");
  if (keys.length > 64) throw new ApiError(400, "Account setting update has too many fields");
  for (const key of keys) {
    if (key.startsWith("internal_") || !accountSettingKeyPattern.test(key)
      || !isBoundedJsonValue(parsed[key])) {
      throw new ApiError(400, "Account setting is not allowed");
    }
  }
}

// The official renderer persists the per-surface model selector (the model, its
// thinking effort/mode, the per-model defaults and the preset) with a PATCH to
// /api/organizations/{org}/model_selector_state/{surface}. The bridge previously
// dropped that path, so the optimistic selection rolled back and every composer
// snapped back to the last saved model on reload.
const modelSelectorFields = new Set([
  "model",
  "thinking",
  "thinking_by_model",
  "preset",
  "selection_source",
]);
// The last model-selector PATCH this bridge accepted, surfaced on /api/health.
// A picker that saves most effort levels but not one of them is otherwise
// invisible from the server (the request simply never arrives), so the record
// carries when and what was sent, not just that a save happened somewhere.
let lastModelSelectorUpdate = null;

// A bound broad enough for every field the selector sends and for the desktop's
// `epitaxyPrefs` bucket (many small UI picks, occasional short lists), strict
// enough that the path cannot carry arbitrary payloads to the upstream API.
// `undefined` is a legitimate value here: the renderer deletes a persisted pref
// by writing the whole bucket back with that key set to `undefined` (its
// `deleteStrict`), and the closed bucket carries it as a JSON-undefined sentinel.
// Rejecting it left the deleted key stuck in the bucket and made *every*
// subsequent pref write fail — including the permission-mode pick, which then
// reverted on the next read (or on send).
function isBoundedJsonValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === undefined) return true;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 8192;
  if (Array.isArray(value)) {
    return value.length <= 512 && value.every((item) => isBoundedJsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= 512
      && entries.every(([key, item]) =>
        key.length <= 128 && isBoundedJsonValue(item, depth + 1));
  }
  return false;
}

function validateModelSelectorUpdate(method, pathname, body) {
  if (
    method !== "PATCH"
    || !/^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/[A-Za-z0-9_-]+$/i.test(pathname)
  ) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "Model selector update must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Model selector update must be an object");
  }
  const keys = Object.keys(parsed);
  if (!keys.length) throw new ApiError(400, "Model selector update is empty");
  for (const key of keys) {
    if (!modelSelectorFields.has(key) || !isBoundedJsonValue(parsed[key])) {
      throw new ApiError(400, "Model selector field is not allowed");
    }
  }
  lastModelSelectorUpdate = {
    at: new Date().toISOString(),
    surface: pathname.split("/").pop() || null,
    body: parsed,
  };
}

// A tenant's Code page resolves its model-selector surface inconsistently in
// this build: the landing composer writes the `cowork` row while the session
// page reads `code` (the renderer's route/context heuristic differs once a
// session exists). The result is a pick that visibly "doesn't save" — the
// create body carries the picked effort, but the next page reads the stale row
// and shows the old level.
//
// The bridge settles the two rows on what the last placed session actually
// used. A pick that reached a created session is the user's latest intent; a
// row that disagrees is stale. In-session PATCHes are mirrored to the other
// row as they arrive (see forwardOfficialProtocol), so after the first
// settlement the two stay equal.
const modelSelectorSurfaces = new Set(["code", "cowork"]);
function modelSelectorSurfaceOf(pathname) {
  const match = pathname.match(/^\/api\/organizations\/[0-9a-f-]+\/model_selector_state\/([A-Za-z0-9_-]+)$/i);
  return match && modelSelectorSurfaces.has(match[1]) ? match[1] : null;
}

function modelSelectorEffort(entry) {
  const effort = entry?.thinking?.effort;
  return typeof effort === "string" && effort ? effort : null;
}

function reconcileModelSelectorState(document, defaults) {
  const states = document?.model_selector_state;
  if (!Array.isArray(states)) return document;
  const code = states.find((entry) => entry?.id === "code");
  const cowork = states.find((entry) => entry?.id === "cowork");
  if (!code || !cowork) return document;
  const codeEffort = modelSelectorEffort(code);
  const coworkEffort = modelSelectorEffort(cowork);
  if (codeEffort === coworkEffort && code.model === cowork.model) return document;
  // First prefer the row that is not sitting on the catalog's recommended
  // "high" default — a user pick is the non-default one. The last session's
  // effort is the tiebreaker when both rows are non-default (or both high).
  const desired = typeof defaults?.effort_level === "string" ? defaults.effort_level : null;
  let source;
  let target;
  // The catalog's recommended "high" is what an untouched row starts at. If
  // one row is non-default and the other is high, the non-default row is a
  // pick; prefer it even when the last session ran high (a session started
  // from the stale row is not evidence against the pick). Equal/non-high
  // pairs fall through to the last session's start settings.
  if ((codeEffort === null || codeEffort === "high")
    && coworkEffort && coworkEffort !== "high") {
    source = cowork; target = code;
  } else if ((coworkEffort === null || coworkEffort === "high")
    && codeEffort && codeEffort !== "high") {
    source = code; target = cowork;
  } else if (desired && coworkEffort === desired && codeEffort !== desired) {
    source = cowork; target = code;
  } else if (desired && codeEffort === desired && coworkEffort !== desired) {
    source = code; target = cowork;
  } else {
    return document;
  }
  const settled = {
    ...target,
    ...(typeof source.model === "string" && source.model ? { model: source.model } : {}),
    ...(source.thinking ? { thinking: source.thinking } : {}),
    ...(Array.isArray(source.thinking_by_model)
      ? { thinking_by_model: source.thinking_by_model } : {}),
    ...(typeof source.selection_source === "string"
      ? { selection_source: source.selection_source } : {}),
    ...(typeof source.preset === "string" && source.preset ? { preset: source.preset } : {}),
  };
  console.log(`[cowork-bridge] model selector: settled ${target.id} on the `
    + `${source.id} row (effort ${modelSelectorEffort(source) ?? "default"})`);
  return {
    ...document,
    model_selector_state: states.map((entry) => entry === target ? settled : entry),
  };
}

function sanitizeStoreValue(surface, store, value, identity) {
  if (surface === "LocalAgentModeSessions" && store === "sessionsBridgeStatusStore") {
    return { remoteToolsDeviceName: value?.remoteToolsDeviceName ?? null };
  }
  if (surface === "LocalAgentModeSessions" && store === "interactiveAuthStore") {
    // Desktop reports the OS app user ("app" in this image) as the renderer's
    // principal display name, which the sidebar user menu prints beside the
    // provider label. The signed-in person's own name replaces it, resolved from
    // the request the way the account document and the greeting already are:
    // `identity` is that name when the request carries a live session (see
    // resolveRequestAccountIdentity), so an account named at invite-accept — or
    // renamed since — reads correctly without the deployment-wide override
    // having to be re-applied by a re-provision. The operator's account name
    // (else the legacy user-name override) is the fallback for a request with no
    // session; unset keeps whatever Desktop reported.
    const name = identity?.name
      || accountIdentity.name
      || remoteUserName
      || value?.principalDisplayName;
    return { principalDisplayName: typeof name === "string" && name ? name : null };
  }
  if (surface === "ClaudeVM" && store === "apiReachabilityStore") {
    return { reachability: value?.reachability ?? "unknown" };
  }
  if (surface === "ManagedConfig" && store === "managedRendererConfigStore") {
    // The web shell reads the sidebar footer's provider label from this store.
    // A gateway deployment leaves the deployment name unset, so the footer falls
    // back to the gateway provider label ("Gateway"); surface the operator's
    // deployment name (and, when it differs, the plan as a subtitle) so the
    // footer reads as the account's. Non-web-shell, or unset, stays blank as
    // before — and the rest of the managed configuration is still withheld.
    if (!webShellEnabled) return {};
    const name = accountIdentity.deployment || accountIdentity.organization || accountIdentity.plan;
    if (!name) return {};
    const subtitle = accountIdentity.plan && accountIdentity.plan !== name ? accountIdentity.plan : null;
    return { deploymentDisplayName: name, deploymentDisplaySubtitle: subtitle };
  }
  return {};
}

// Both bootstrap prefixes ion-dist recognizes: the Desktop frame fetches under
// /edge-api, while the browser (web shell) app uses the claude.ai default /api,
// so the greeting below has to be injected into whichever one the shell asks
// for (its own detector accepts `(?:edge-)?api`).
const bootstrapResponsePath = /^\/(?:edge-)?api\/bootstrap(?:\/[^/?#]+\/app_start)?$/i;
// The renderer also refetches its org entitlements from this path; both carry
// the `current_user_access.features` list the web shell reads for Cowork.
const currentUserAccessPath = /^\/api\/bootstrap\/[^/?#]+\/current_user_access$/i;
// The org document that carries the Cowork approval-mode admin settings. The
// renderer fetches it (react-query key `cowork_settings`) to decide whether to
// offer "Automatically approve" (`auto_mode_enabled`) and "Skip all approvals"
// (`skip_approvals_enabled`).
const coworkSettingsPath = /^\/api\/organizations\/[0-9a-f-]+\/cowork_settings$/i;
// The account documents the web shell reads its identity from: the bootstrap
// carries the account under `account`, while GET /api/account_profile returns
// the profile document (display_name, full_name, email_address, avatar fields)
// the account chip reads its photo from. Desktop serves no GET /api/account —
// that path is PUT-only — so it is deliberately not matched here. Only rewritten
// in web-shell mode (see accountIdentity).
const accountResponsePath = /^\/api\/account_profile$/i;
// The organization document whose `name`/`plan_display_name` the account menu
// and org switcher show; same shape as the organization inside memberships.
const organizationResponsePath = /^\/api\/organizations\/[0-9a-f-]+$/i;

// The official renderer takes its home greeting from the bootstrap response,
// not from local code: personalized_greeting is an array of surface objects,
// each with per-weekday `days` (a `slots` list) and a `default_slots` list of
// {until, text} pairs. The renderer picks the day's slots when the weekday
// matches, else default_slots, then returns the first slot whose exclusive
// `until` hour is still ahead of the visitor's clock. The upstream gateway
// never sends any of it, so the home page sits on the renderer's "You're here!"
// placeholder instead of the time-based greeting the app shows (Desktop and the
// web shell alike, since both bootstrap paths are matched above). Keep that
// renderer payload shape; merge legacy Chat copy into the supplied schedule and
// choose it deterministically by UTC ISO week so reloads are stable and the next
// week rotates. The Code schedule remains unchanged. A non-empty upstream
// greeting is kept. The official backend expands the {{ NAME }} token
// server-side before it ships (its payload carries final text like
// "Back at it, Maddie"); do the same here, addressing the user by the same name
// the rest of the app shows (see resolveGreetingName).
const GREETING_NAME_TOKEN = "{{ NAME }}";

const greetingSurfaces = [
  {
    surface: "chat",
    days: [
      { day: "sun", slots: [
        { until: 5, text: "What shall we think through?" },
        { until: 9, text: "Welcome, {{ NAME }}" },
        { until: 12, text: "Coffee and Claude time?" },
        { until: 18, text: "Good afternoon, {{ NAME }}" },
        { until: 22, text: "{{ NAME }} returns!" },
        { until: 24, text: "What shall we think through?" },
      ] },
      { day: "mon", slots: [
        { until: 5, text: "Moonlit chat?" },
        { until: 9, text: "New week, {{ NAME }}" },
        { until: 12, text: "Coffee and Claude time?" },
        { until: 18, text: "Back at it, {{ NAME }}" },
        { until: 22, text: "Evening thoughts" },
        { until: 24, text: "Moonlit chat?" },
      ] },
      { day: "tue", slots: [
        { until: 5, text: "It’s a late-night jam session." },
        { until: 9, text: "Hey there, {{ NAME }}" },
        { until: 12, text: "Happy Tuesday, {{ NAME }}" },
        { until: 18, text: "Afternoon, {{ NAME }}" },
        { until: 22, text: "Evening, {{ NAME }}" },
        { until: 24, text: "It’s a late-night jam session." },
      ] },
      { day: "wed", slots: [
        { until: 5, text: "Hello, night owl" },
        { until: 9, text: "Happy Wednesday, {{ NAME }}" },
        { until: 12, text: "What’s cooking, {{ NAME }}?" },
        { until: 18, text: "Good afternoon, {{ NAME }}" },
        { until: 22, text: "Evening, how are things?" },
        { until: 24, text: "Hello, night owl" },
      ] },
      { day: "thu", slots: [
        { until: 5, text: "Up late, {{ NAME }}?" },
        { until: 9, text: "What’s cooking, {{ NAME }}?" },
        { until: 12, text: "Hey there, {{ NAME }}" },
        { until: 18, text: "Back at it, {{ NAME }}" },
        { until: 22, text: "Good evening, {{ NAME }}" },
        { until: 24, text: "Up late, {{ NAME }}?" },
      ] },
      { day: "fri", slots: [
        { until: 5, text: "Moonlit chat?" },
        { until: 9, text: "Coffee and Claude time?" },
        { until: 12, text: "Here we go!" },
        { until: 18, text: "Afternoon, {{ NAME }}" },
        { until: 22, text: "Evening thoughts" },
        { until: 24, text: "Moonlit chat?" },
      ] },
      { day: "sat", slots: [
        { until: 5, text: "Hello, night owl" },
        { until: 9, text: "What’s cooking, {{ NAME }}?" },
        { until: 12, text: "Hey there, {{ NAME }}" },
        { until: 18, text: "Let’s noodle" },
        { until: 22, text: "Evening, how are things?" },
        { until: 24, text: "Hello, night owl" },
      ] },
    ],
    default_slots: [
      { until: 5, text: "Up late, {{ NAME }}?" },
      { until: 9, text: "Hey there, {{ NAME }}" },
      { until: 12, text: "Welcome, {{ NAME }}" },
      { until: 18, text: "Back at it, {{ NAME }}" },
      { until: 22, text: "Good evening, {{ NAME }}" },
      { until: 24, text: "Up late, {{ NAME }}?" },
    ],
  },
  {
    surface: "code",
    days: [
      { day: "sun", slots: [
        { until: 12, text: "Ready when you are" },
        { until: 18, text: "What are we building?" },
        { until: 24, text: "Ready when you are" },
      ] },
      { day: "mon", slots: [
        { until: 5, text: "Night build" },
        { until: 12, text: "Morning, {{ NAME }}" },
        { until: 18, text: "Ready when you are" },
        { until: 22, text: "Hello, world" },
        { until: 24, text: "Night build" },
      ] },
      { day: "tue", slots: [
        { until: 18, text: "Hello, world" },
        { until: 22, text: "Hello, {{ NAME }}" },
        { until: 24, text: "Hello, world" },
      ] },
      { day: "wed", slots: [
        { until: 5, text: "Hello, {{ NAME }}" },
        { until: 12, text: "Fresh branch" },
        { until: 22, text: "Clean slate" },
        { until: 24, text: "Hello, {{ NAME }}" },
      ] },
      { day: "fri", slots: [
        { until: 12, text: "Back at it, {{ NAME }}" },
        { until: 18, text: "Afternoon, {{ NAME }}" },
        { until: 24, text: "Back at it, {{ NAME }}" },
      ] },
      { day: "sat", slots: [
        { until: 12, text: "What are we building?" },
        { until: 18, text: "What needs fixing?" },
        { until: 24, text: "What are we building?" },
      ] },
    ],
    default_slots: [
      { until: 12, text: "Clean slate" },
      { until: 18, text: "Back at it, {{ NAME }}" },
      { until: 22, text: "Beep boop time?" },
      { until: 24, text: "Clean slate" },
    ],
  },
];

const GREETING_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// An ISO week is identified by its Thursday. Since the Unix epoch was also a
// Thursday, that date's timestamp divided by seven days is a monotonic week seed.
function greetingWeekIndex(now) {
  const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  return Math.floor(thursday.getTime() / GREETING_WEEK_MS);
}

// The legacy picker offered "Golden hour thinking" in a late-afternoon window;
// keep one fixed window so every slot's candidate pool — and therefore the
// weekly rotation below — is identical from week to week.
const GREETING_GOLDEN_HOUR = { start: 16, end: 18 };

// Split only where a time-sensitive greeting can become eligible, retaining the
// original text for the surrounding portions of each renderer slot.
function splitGreetingSlots(slots, boundaries) {
  const result = [];
  let from = 0;
  for (const { until, text } of slots) {
    const ends = boundaries.filter((hour) => hour > from && hour < until).sort((a, b) => a - b);
    for (const end of ends) {
      result.push({ from, until: end, text });
      from = end;
    }
    result.push({ from, until, text });
    from = until;
  }
  return result;
}

function legacyChatGreetingCandidates(day, from, until, hasName, goldenHour) {
  const candidates = [];
  if (from >= 0 && until <= 5) {
    candidates.push(hasName ? "It's late-night {{ NAME }}" : "It's late-night");
    candidates.push("Moonlit chat?", "Hello, night owl", "What shall we think through?");
  } else if (from >= 5 && until <= 12) {
    if (hasName) {
      candidates.push("Good morning, {{ NAME }}", "Welcome, {{ NAME }}", "Hey there, {{ NAME }}");
    } else {
      candidates.push("Good morning", "Welcome", "Hey there");
    }
    const weekdayCopy = {
      mon: hasName ? ["Happy Monday, {{ NAME }}"] : ["Happy Monday"],
      tue: hasName ? ["Happy Tuesday, {{ NAME }}"] : ["Happy Tuesday"],
      wed: hasName ? ["Happy Wednesday, {{ NAME }}"] : ["Happy Wednesday"],
      thu: hasName ? ["Happy Thursday, {{ NAME }}"] : ["Happy Thursday"],
      fri: hasName ? ["Happy Friday, {{ NAME }}"] : ["Happy Friday"],
      sat: hasName
        ? ["Welcome to the weekend, {{ NAME }}", "Happy Saturday, {{ NAME }}"]
        : ["Welcome to the weekend", "Happy Saturday!"],
      sun: hasName
        ? ["Sunday session, {{ NAME }}?", "Happy Sunday, {{ NAME }}"]
        : ["Sunday session?", "Happy Sunday"],
    };
    candidates.push(...(weekdayCopy[day] ?? []), "Coffee and Claude time?");
  } else if (from >= 12 && until <= 18) {
    if (hasName) {
      candidates.push("Good afternoon, {{ NAME }}", "Afternoon, {{ NAME }}", "Back at it, {{ NAME }}");
    } else {
      candidates.push("Good afternoon", "Afternoon", "Back at it!");
    }
  } else if (from >= 18 && until <= 24) {
    if (hasName) {
      candidates.push("{{ NAME }} returns!", "Good evening, {{ NAME }}", "Evening, {{ NAME }}");
    } else {
      candidates.push("Evening", "Good evening");
    }
  }
  if (from < goldenHour.end && until > goldenHour.start) candidates.push("Golden hour thinking");
  return candidates;
}

// One slot's weekly pick: a stable offset from the slot name, advanced by one
// per ISO week. Week to week the selected index moves by exactly one, so a pool
// of two or more choices never repeats the same greeting on consecutive weeks,
// while every request within a week — and every reload — gets the same text.
function selectWeeklyGreeting(candidates, slot, weekIndex) {
  const unique = [...new Set(candidates)];
  if (unique.length < 2) return unique[0];
  let hash = 0;
  for (let index = 0; index < slot.length; index += 1) {
    hash = ((hash << 5) - hash + slot.charCodeAt(index)) | 0;
  }
  return unique[((hash + weekIndex) % unique.length + unique.length) % unique.length];
}

// Expand the {{ NAME }} token, or, with no name at all, drop it without leaving
// stray punctuation: a trailing ", {{ NAME }}" disappears whole, and a leading
// token is removed with the following word capitalized ("{{ NAME }} returns!"
// becomes "Returns!").
function greetingText(text, name) {
  if (!text.includes(GREETING_NAME_TOKEN)) return text;
  if (name) return text.split(GREETING_NAME_TOKEN).join(name);
  if (text.startsWith(GREETING_NAME_TOKEN)) {
    const rest = text.slice(GREETING_NAME_TOKEN.length).replace(/^\s+/, "");
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return text
    .replace(`, ${GREETING_NAME_TOKEN}`, "")
    .replace(GREETING_NAME_TOKEN, "")
    .replace(/\s+([?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// The address the greeting uses, in one place: the operator override, else the
// name the rest of the app already shows for the signed-in user (the sidebar
// identity the caller reads from Desktop's auth store), else the account the
// bootstrap response itself carries, else no name at all. The caller resolves
// `reported`, so this stays pure and testable.
function resolveGreetingName({ override, reported, account }) {
  const display = typeof account?.display_name === "string" ? account.display_name.trim() : "";
  const full = typeof account?.full_name === "string" ? account.full_name.trim() : "";
  return override || reported || display || full;
}

function injectPersonalizedGreeting(parsed, name, now = new Date()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const existing = parsed.personalized_greeting;
  if (Array.isArray(existing) && existing.length > 0) return parsed;
  const weekIndex = greetingWeekIndex(now);
  const renderSlots = (list, surface, day) => splitGreetingSlots(
    list,
    surface === "chat" ? [16, 18] : [],
  ).map(({ from, until, text }) => {
    const candidates = surface === "chat"
      ? [text, ...legacyChatGreetingCandidates(day, from, until, Boolean(name), GREETING_GOLDEN_HOUR)]
      : [text];
    return {
      until,
      text: selectWeeklyGreeting(
        candidates.map((candidate) => greetingText(candidate, name)),
        `${surface}:${day}:${from}-${until}`,
        weekIndex,
      ),
    };
  });
  return {
    ...parsed,
    personalized_greeting: greetingSurfaces.map(({ surface, days, default_slots }) => ({
      surface,
      ...(days ? {
        days: days.map(({ day, slots }) => ({ day, slots: renderSlots(slots, surface, day) })),
      } : {}),
      default_slots: renderSlots(default_slots, surface, "default"),
    })),
  };
}

// Add the web shell's Cowork entitlements to an access document. The bootstrap
// response and `/api/bootstrap/<org>/current_user_access` both carry a
// `current_user_access.features` list of `{feature, status}`; the renderer's
// feature hook reads `status === "available"`. Only grant a feature that is
// absent — an existing entry (including a `blocked_by_*` one the upstream set)
// is left exactly as it is, so this cannot silently override org policy.
// A tenant's Code is real whether or not the web shell is on — its sessions run
// on its own runner — so its access document says so in either mode. Two entries,
// because the surface reads two:
//
//   claude_code_web                   the composer derives `remoteSessionsAllowed`
//                                     from it, and without it it offers no place
//                                     at all ("Local sessions aren't available on
//                                     this device").
//   claude_code_self_hosted_runners   the *pools* query is enabled on it
//                                     (`MS({enabled: … && IS()})`), the pools make
//                                     up the menu's self-hosted section, and that
//                                     section is one of the terms that decides
//                                     whether the environments submenu is drawn at
//                                     all. Without it the menu is Local-only.
//
// Kept separate from the web shell's own grants, which are about its chrome and
// its Cowork surface.
function grantTenantCodeEntitlements(value) {
  if (!codeRunnersEnabled || !value || typeof value !== "object") return false;
  let changed = false;
  for (const holder of [value.current_user_access, value]) {
    if (!holder || !Array.isArray(holder.features)) continue;
    const present = new Set(
      holder.features.filter((entry) => entry && typeof entry.feature === "string")
        .map((entry) => entry.feature),
    );
    for (const feature of ["claude_code_web", "claude_code_self_hosted_runners",
      // The permission-mode picker's bypass and auto rows are entitlement-gated
      // (`claude_code_desktop_bypass_permissions` / `…_auto_permissions`). This
      // deployment has no Anthropic backend to grant them, and its sessions run
      // in its own VM, where the operator asked for bypass to be available.
      "claude_code_desktop_bypass_permissions",
      "claude_code_desktop_auto_permissions"]) {
      if (present.has(feature)) continue;
      holder.features.push({ feature, status: "available" });
      changed = true;
    }
  }
  return changed;
}

// The GrowthBook gate the self-hosted-runners check falls back to — the same
// kind of rollout flag `bad_moon_rising` is for Code itself, and granted the
// same way (only where absent, so an upstream value is left alone).
const tenantCodeGates = ["claude_ai_tamarind"];

function grantTenantCodeGates(value) {
  if (!codeRunnersEnabled) return false;
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  let changed = false;
  for (const name of tenantCodeGates) {
    const key = growthbookKey(name);
    if (key in features) continue;
    features[key] = { defaultValue: true };
    changed = true;
  }
  return changed;
}

// The live transcript transport. The Code page's subscription hook takes its
// transport straight off this gate — `subscribeSse: z("ccr_v2_subscribe_sse_web")`
// in the session view — and an off read does not mean "no live updates": it
// means a WebSocket (`/v1/sessions/ws/{id}/subscribe`) holding the live leg
// while a one-shot REST read hydrates history. This bridge serves the SSE
// stream (frames, cursors, resume) and no WebSocket at all, so with the gate
// off the page drew the transcript on a reload and never streamed a byte —
// however correct the stream itself was. Forced outright rather than
// added-if-absent: an evaluated false is what the desktop's custom-3p feature
// table (and the upstream growthbook payload behind it) carries.
const ccrSubscribeSseGate = "ccr_v2_subscribe_sse_web";
function grantCcrSubscribeSse(value) {
  if (!codeRunnersEnabled) return false;
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey(ccrSubscribeSseGate);
  const entry = features[key];
  const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
  if (on) return false;
  features[key] = { defaultValue: true };
  return true;
}

// How the transcript hydrates. `ccr_pewter_heron` turns the session view's
// `tailFirstTranscript` on: `fetchTranscript` then reads only the newest
// window (desc, limit 200) and kicks off an unawaited backfill walk for the
// rest, so the page draws with a handful of rows and the older history appears
// whenever that background read resolves — over this bridge that is a separate
// paged HTTP walk, which is exactly the "no history, then it all lands at
// once" behaviour a tenant sees. The desktop's hardcoded custom-3p table
// carries the gate on; this bridge serves the full log from one in-memory read,
// so it is forced off and the view hydrates the whole transcript as part of
// the initial read (the renderer's full walk, whose pages `listEvents` serves
// by cursor).
const ccrTailFirstTranscriptGate = "ccr_pewter_heron";
function disableCcrTailFirstTranscript(value) {
  if (!codeRunnersEnabled) return false;
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey(ccrTailFirstTranscriptGate);
  const entry = features[key];
  const off = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === false;
  if (off) return false;
  features[key] = { defaultValue: false };
  return true;
}

// The renderer's whole remote-place machinery hangs on one flag that comes from
// the page, not from any access document: `shared-50`'s `RM` turns
// `appFeatures.selfHostedSessions.status === "supported"` into the module flag
// `shared-0`'s `yL` — the `remoteSessionsAllowed` every session-target read
// starts from (`k = R() && …`), the first term of the environment-list filter
// (`if (!remoteSessionsAllowed) return { bridges: [], cloud: [] }`) and of the
// pools query's `enabled` (`be = IS() && remoteSessionsAllowed`). With it false
// the composer's places menu is Local-only — no bootstrap entitlement, no
// environments response and no pool grant downstream can change that, because
// the data never passes the filter.
//
// `appFeatures` starts as `window.desktopBootFeatures` — the table relayed into
// the remote preload from here — and in a browser it is never resampled: the
// async refresher calls `claude.settings.AppFeatures.getSupportedFeatures`, a
// native surface the remote preload does not shim (the settings surfaces are
// AppPreferences, Custom3pSetup and Custom3pHelperRun). The Desktop wrapper's
// own relay whitelist (`relayedBootFeatures` in bridge-wrapper/main.cjs —
// chatIn3p, chatTab, desktopHome, yukonSilver) copies nothing else, so
// selfHostedSessions is always absent from the table and the flag is false on
// every page load. A tenant whose Code runners this deployment serves genuinely
// runs its sessions on its own infrastructure, so it declares them; the
// operator's own instance keeps exactly the relayed table.
function withSelfHostedSessions(bootFeatures) {
  const table = bootFeatures && typeof bootFeatures === "object" ? { ...bootFeatures } : {};
  if (codeSurfaceEnabled) {
    table.selfHostedSessions = { status: "supported" };
  }
  return table;
}

function grantWebShellEntitlements(value) {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  for (const holder of [value.current_user_access, value]) {
    if (!holder || !Array.isArray(holder.features)) continue;
    const present = new Set(
      holder.features.filter((entry) => entry && typeof entry.feature === "string")
        .map((entry) => entry.feature),
    );
    for (const feature of webShellGrantedFeatures) {
      if (present.has(feature)) continue;
      holder.features.push({ feature, status: "available" });
      changed = true;
    }
  }
  return changed;
}

// ion-dist addresses a GrowthBook feature by `R(name)`: a Java-style 32-bit
// string hash, or the literal id already carried after a `__gb__` prefix.
function growthbookKey(name) {
  if (name.startsWith("__gb__")) return name.slice(6);
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(index);
    hash &= hash;
  }
  return ((hash & 0xFFFFFFFF) >>> 0).toString();
}

// Add the web shell's gates to the bootstrap's growthbook features. As with the
// entitlements, only a gate the upstream did not already carry is added, so an
// upstream false is left alone.
function grantWebShellGates(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  let changed = false;
  for (const name of webShellGrantedGates) {
    const key = growthbookKey(name);
    if (key in features) continue;
    features[key] = { defaultValue: true };
    changed = true;
  }
  return changed;
}

// The two rollout gates the composer consults before it offers the local
// ("wiggle") upload lane at all — `wiggle.useEnabledForUser()` is
// `read("trials_and_tribulations_of_high_school_football")` and the default
// for the account's own switch is `read("default_wiggle_on")`. A false/absent
// value disables the lane, and with it every chat/Cowork attachment, before
// the account policy above is consulted. Forced true rather than
// added-if-absent because this deployment is the lane's only backend.
// `CLAUDE_REMOTE_WIGGLE_UPLOADS=0` leaves the upstream table exactly as it came.
const wiggleUploadGates = [
  "trials_and_tribulations_of_high_school_football",
  "default_wiggle_on",
];
function grantWiggleUploadGates(value) {
  if (process.env.CLAUDE_REMOTE_WIGGLE_UPLOADS === "0") return false;
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  let changed = false;
  for (const name of wiggleUploadGates) {
    const key = growthbookKey(name);
    const entry = features[key];
    const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
    if (on) continue;
    features[key] = { defaultValue: true };
    changed = true;
  }
  return changed;
}

// The routine feature's own rollout gate. The renderer's `mh()` is
// `capabilities.routines.enabled && W("chilling_sloth_clocks", …)`, and `W`
// answers false for a gate it carries as off — so an upstream false hides the
// Code frame's Routines/Scheduled entry even when the capability document says
// the instance serves routines. The bridge does serve them (the local scheduled
// task store is the routine store), so in the web shell an off value is
// replaced, the same way the SSE transport gate is forced on above.
function grantRoutineGate(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey("chilling_sloth_clocks");
  const entry = features[key];
  const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
  if (on) return false;
  features[key] = { defaultValue: true };
  return true;
}

// The browser New page's Marlin composer redesign is a separate GrowthBook gate
// from shell selection. Enable it for this deployment even when the upstream's
// hardcoded custom3p feature table carries an explicit false value.
function grantWebShellComposerDesign(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey("voyage_composer_marlin");
  const entry = features[key];
  const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
  if (on) return false;
  features[key] = { defaultValue: true };
  return true;
}

// Projects. The renderer decides the whole surface — the `/projects` routes and
// the composer's project slot — from `claude_ai_projects_limits` (a free-plan
// project allowance) or from the org's plan capabilities (`claude_pro`,
// `claude_max`, `raven`). A self-hosted account carries no plan capability, so
// the feature alone decides, and without it a free account has no allowance and
// projects stay shut. The renderer patch `web-projects-allowed` restores the
// predicate the Desktop build compiles out (the constant it folds the
// disjunction to is never assigned); this supplies the feature the restored
// predicate reads. The feature carries a *value*, so the absence test the other
// gates use is not enough: an entry the upstream carries can still answer an
// allowance of zero, or carry no `max_free_projects` field at all, and the
// renderer reads that as no allowance exactly as it reads a missing entry. Only
// an allowance already above zero is left alone, so one Anthropic really granted
// this account survives untouched.
const projectsLimitsGate = "claude_ai_projects_limits";
// The allowance granted when the upstream supplies none, or a zero one. The
// client only tests it for `> 0` to decide whether to consult the account's real
// `create_limit`, which the API enforces; it is also the count a free account is
// shown in the upgrade surfaces, so it is kept at the free tier's own figure.
const projectsFreeAllowance = 5;
function grantProjectsLimits(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey(projectsLimitsGate);
  const entry = features[key];
  const configured = entry && typeof entry === "object"
    ? (entry.value !== undefined ? entry.value : entry.defaultValue) : undefined;
  // The renderer reads `max_free_projects` off the value when it is an object,
  // and the value itself when it is a plain number; both spellings are honoured
  // so an upstream entry in either shape is recognised as a real allowance.
  const allowance = configured !== null && typeof configured === "object"
    ? configured.max_free_projects : configured;
  if (typeof allowance === "number" && allowance > 0) return false;
  features[key] = { defaultValue: { max_free_projects: projectsFreeAllowance } };
  return true;
}

// The connectors surface — the "Add connector" control and the plugin-connector
// rows — decides whether this account may add connectors from the GrowthBook
// feature `papi_mcp` (ion-dist's `canInstall`: `(manageFromPersonal ||
// manageFromOrg) && F("papi_mcp")`). A self-hosted account is not the hosted
// Enterprise ("raven") case, so `manageFromPersonal` is true and this feature
// alone decides; an upstream that leaves it off strands the UI on the "Contact
// an organization owner to add connectors" dead end. Force it on. The sibling
// `papi_disable_mcp_ui` gate, which would hide the whole surface instead, is
// deliberately never granted.
const connectorGrantedGate = "papi_mcp";
function grantConnectorGates(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  const key = growthbookKey(connectorGrantedGate);
  const entry = features[key];
  const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
  if (on) return false;
  features[key] = { defaultValue: true };
  return true;
}

// Flip the org's Cowork approval settings so the picker offers "Skip all
// approvals". The renderer reads `skip_approvals_enabled` off this document to
// build the composer's mode list (ion-dist's `Lv`: the bypass row appears only
// when it — and the growthbook flag below — are on). Only an absent/false value
// is raised; an already-true value is left untouched so the rewrite is a no-op
// once someone flips the real admin setting.
function grantCoworkSkipApprovals(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.skip_approvals_enabled === true) return false;
  value.skip_approvals_enabled = true;
  return true;
}

// Desktop's third-party answer to GET /cowork_settings is a 503
// `custom_3p_not_available` document, and the renderer's query exposes data
// only on success: a grant spliced into that error body was invisible, which
// left both the auto and bypass rows off (the picker fell back to its three
// basic modes). The bridge answers the settings document itself when Desktop
// refuses the read, so the query succeeds and the grants are actually read.
function coworkSettingsDocument(value, status) {
  const usable = value && typeof value === "object" && !Array.isArray(value);
  const failed = typeof status === "number" && (status < 200 || status >= 300);
  if (usable && !failed && value.error === undefined) {
    return { document: value, synthetic: false };
  }
  return { document: {}, synthetic: true };
}

// Force the two Cowork permission-mode rollout gates on in the bootstrap's
// growthbook table. `grantWebShellGates` only adds an absent gate; these may
// already be carried (evaluated false), so they are replaced outright.
//
// `cowork_bypass_permissions_mode` puts the "Skip all approvals" row in the
// picker, alongside the org setting forced above.
//
// `cowork_auto_permission_mode` is what makes the picker exist at all. The
// renderer builds its set of selectable modes from these two flags alone
// (`resolved = []` when both are off, plus `auto` and `bypassPermissions` for
// whichever is on), and the Cowork mode list itself is a single entry — so with
// only bypass on, and bypass excluded for a session-scoped picker, the list has
// nothing to choose between and the component returns null instead of drawing.
// That is why the composer's permission control was an empty slot: a picker with
// one option hides itself. Auto mode is strictly weaker than the bypass mode
// this deployment already offers, so enabling it alongside costs nothing and is
// what gives the control a list.
//
// `ccr_mcp_permission_mode_override` is the third leg: the picker *disables* the
// bypass row whenever it is off (`disabled = mode === "bypassPermissions" &&
// !override`), with the tooltip "Skip all approvals only runs locally". So the
// row can be present and still unclickable, which is the state this deployment
// was in. Whatever the flag means upstream, here every session *is* local — the
// bridge backs them over the Desktop IPC — so the condition it encodes is one
// this deployment satisfies by construction, and the other two grants already
// say the same thing about the same row.
function grantCoworkPermissionGates(value) {
  const features = value?.growthbook?.features;
  if (!features || typeof features !== "object") return false;
  let changed = false;
  for (const name of ["cowork_bypass_permissions_mode", "cowork_auto_permission_mode",
    "ccr_mcp_permission_mode_override"]) {
    const key = growthbookKey(name);
    const entry = features[key];
    const on = entry && (entry.value !== undefined ? entry.value : entry.defaultValue) === true;
    if (on) continue;
    features[key] = { defaultValue: true };
    changed = true;
  }
  return changed;
}

// How a model id in the operator's list is matched against the ids the picker
// data carries: trimmed and case-folded. Literal otherwise — in particular a
// long-context `[1m]` spelling is its own entry with its own id (the Desktop
// lists one row per spelling, both named alike), so it is pinned only if it is
// named. That keeps the root to one row per model the operator chose, while the
// 1M spelling stays selectable under "More models" — or at the root, if that is
// what they list.
function modelPickerKey(id) {
  return String(id ?? "").trim().toLowerCase();
}

// Lay out the composer's model picker the way claude.ai lays it out: the
// deployment's main models at the root, in the order the operator gave, and every
// other configured model under "More models". The renderer decides that split
// from the data — each entry's `section` ("main" | "overflow") chooses its group
// and the array order is the root order — and this data is the bootstrap
// document's `model_selector_config`, one list per surface, which the bridge is
// already rewriting on its way to the page. So this is a data rewrite, not a
// renderer patch: it survives a Desktop update that moves or renames the code.
//
// Models are moved between groups, never hidden — one the operator left off the
// list stays one click away in the submenu — and every entry the operator did not
// name keeps its relative order. `section` is written on every entry rather than
// only on the ones that move: the renderer reads a group off that field in two
// places, one of which treats a missing value as "main" and one of which filters
// on `=== "main"`, so stating it everywhere is the one answer they agree on.
//
// Returns whether the document changed. An empty list is the native layout and
// rewrites nothing, and a list no entry matches (a typo, or ids from another
// deployment) leaves the document alone rather than emptying the picker.
function applyModelPickerLayout(value, mainModels) {
  if (!Array.isArray(mainModels) || mainModels.length === 0) return false;
  const surfaces = value?.model_selector_config;
  if (!Array.isArray(surfaces)) return false;
  const rank = new Map();
  for (const id of mainModels) {
    const key = modelPickerKey(id);
    if (key && !rank.has(key)) rank.set(key, rank.size);
  }
  let changed = false;
  let matched = false;
  for (const surface of surfaces) {
    if (!surface || !Array.isArray(surface.models)) continue;
    const main = [];
    const overflow = [];
    for (const model of surface.models) {
      const listed = rank.has(modelPickerKey(model?.id));
      if (listed) matched = true;
      const section = listed ? "main" : "overflow";
      const next = model?.section === section ? model : { ...model, section };
      if (next !== model) changed = true;
      (listed ? main : overflow).push(next);
    }
    if (main.length === 0) continue;
    // The operator's order. Array#sort is stable, so two entries that answer the
    // same rank (an id listed twice) keep the order they arrived in.
    main.sort((a, b) => rank.get(modelPickerKey(a.id)) - rank.get(modelPickerKey(b.id)));
    const ordered = [...main, ...overflow];
    if (ordered.some((model, index) => model !== surface.models[index])) {
      surface.models = ordered;
      changed = true;
    }
  }
  if (!matched) {
    console.log("[cowork-bridge] model picker: none of the configured main models are in the picker list");
    return false;
  }
  return changed;
}

// The picker's model list as the last bootstrap response carried it — the data
// the admin page's model-picker card offers (GET /api/chat/model-catalog), so the
// card can name the models the way the menu does instead of asking an operator to
// type route names. Reading it from the served document is also the only way to
// see models that came from gateway discovery: when nothing pins the list, the
// endpoint is what knows them and no env value does.
//
// The picker's own surface is the one the unified home renders; the chat surface
// is the fallback for a build without it. Empty until a page has been served, so
// the card asks the Desktop itself once (see refreshPickerModels) and falls back
// to the env list only if that fails (see configuredModelCatalogue).
const pickerModelsSeen = { models: [] };
// When the Desktop was last asked for the list, and the read in flight. A
// deployment in discovery mode has no env list to fall back to, so a failed read
// is retried, but not on every request the card makes.
const pickerModelsRead = { attemptedAt: 0, inFlight: null };
const PICKER_MODELS_READ_TTL_MS = 30 * 1000;

function rememberPickerModels(value) {
  const surfaces = value?.model_selector_config;
  if (!Array.isArray(surfaces)) return;
  const surface = surfaces.find((item) => item?.id === "cowork" && Array.isArray(item.models))
    ?? surfaces.find((item) => item?.id === "chat" && Array.isArray(item.models))
    ?? surfaces.find((item) => Array.isArray(item?.models));
  if (!surface) return;
  const models = [];
  for (const model of surface.models) {
    if (typeof model?.id !== "string" || !model.id) continue;
    const name = typeof model.name === "string" && model.name ? model.name : model.id;
    models.push({ id: model.id, name });
  }
  if (models.length) pickerModelsSeen.models = models;
}

/** Ask the Desktop for the model list itself, for a card opened before any page
 *  has loaded. `/api/bootstrap` is the same document the renderer fetches for its
 *  app_start (one builder, and this path carries no organization), so the card
 *  gets the picker's own list without waiting for a browser. */
async function refreshPickerModels() {
  if (pickerModelsRead.inFlight) return pickerModelsRead.inFlight;
  if (Date.now() - pickerModelsRead.attemptedAt < PICKER_MODELS_READ_TTL_MS) return undefined;
  pickerModelsRead.attemptedAt = Date.now();
  pickerModelsRead.inFlight = (async () => {
    try {
      const result = await desktop.protocol({
        method: "GET",
        pathname: "/api/bootstrap",
        headers: { "anthropic-client-platform": "desktop_app" },
        bodyBase64: "",
      });
      const body = Buffer.from(result.bodyBase64 || "", "base64");
      rememberPickerModels(JSON.parse(body.toString("utf8")));
    } catch { /* the card falls back to the env list, or to nothing */ }
    pickerModelsRead.inFlight = null;
  })();
  return pickerModelsRead.inFlight;
}

/** The models the picker offers: what this instance last served, else the
 *  Desktop's own list, else what the deployment's env names. */
async function modelPickerCatalogue() {
  if (!pickerModelsSeen.models.length) await refreshPickerModels();
  return pickerModelsSeen.models.length ? pickerModelsSeen.models : configuredModelCatalogue;
}

function containsSensitiveCredential(value) {
  if (!value || typeof value !== "object") return false;
  const sensitiveName = /^(?:api_?key|gateway_?api_?key|access_?token|refresh_?token|authorization|password|secret)$/i;
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveName.test(key)) return true;
    if (containsSensitiveCredential(item)) return true;
  }
  return false;
}

async function forwardOfficialProtocol(request, response, url) {
  const method = validateProtocolRequest(request.method, url.pathname);
  if (url.search.length > 4096) throw new ApiError(400, "query string is too long");
  const body = ["GET", "HEAD"].includes(method)
    ? Buffer.alloc(0)
    : await readRequestBuffer(request);
  validateAccountProfileUpdate(method, url.pathname, body);
  validateAccountSettingsUpdate(method, url.pathname, body);
  validateModelSelectorUpdate(method, url.pathname, body);
  const protocolHeaders = {
    accept: request.headers.accept,
    "accept-language": request.headers["accept-language"],
    "anthropic-anonymous-id": request.headers["anthropic-anonymous-id"],
    "anthropic-client-build": request.headers["anthropic-client-build"],
    "anthropic-client-device-id": request.headers["anthropic-client-device-id"],
    "anthropic-client-platform": request.headers["anthropic-client-platform"],
    "anthropic-client-sha": request.headers["anthropic-client-sha"],
    "anthropic-client-version": request.headers["anthropic-client-version"],
    "content-type": request.headers["content-type"],
    "x-activity-session-id": request.headers["x-activity-session-id"],
  };
  const result = await desktop.protocol({
    method,
    pathname: url.pathname,
    search: url.search,
    headers: protocolHeaders,
    bodyBase64: body.toString("base64"),
  });
  // Keep the model selector's `code` and `cowork` rows equal for a tenant.
  // The landing composer and the session page resolve different rows in this
  // build, so a pick written to one would otherwise vanish from the other (see
  // reconcileModelSelectorState). Mirroring is best-effort: the user's own
  // PATCH has already succeeded, and a failed mirror only leaves the two rows
  // disagreeing until the next bootstrap settlement.
  const selectorSurface = tenantInstance ? modelSelectorSurfaceOf(url.pathname) : null;
  if (method === "PATCH" && selectorSurface && (result.status || 0) < 400) {
    const otherSurface = selectorSurface === "code" ? "cowork" : "code";
    const otherPath = url.pathname.replace(
      /\/model_selector_state\/[^/]+$/, `/model_selector_state/${otherSurface}`,
    );
    void desktop.protocol({
      method: "PATCH",
      pathname: otherPath,
      search: "",
      headers: protocolHeaders,
      bodyBase64: body.toString("base64"),
    }).catch((error) => {
      console.log(`[cowork-bridge] model selector mirror to ${otherSurface} failed: ${error.message}`);
    });
  }
  let responseBody = Buffer.from(result.bodyBase64 || "", "base64");
  let status = result.status || 502;
  if ((result.contentType || "").includes("application/json")) {
    // `let`: the greeting is injected by returning a new document (unlike the
    // mutating grant* helpers below), so the rewrite must capture the return.
    let parsed = JSON.parse(responseBody.toString("utf8"));
    let rewrote = false;
    // The signed-in identity for this request (the seam above): the auth
    // service's user when AUTH_IDENTITY_URL is set, else the env identity.
    const requestIdentity = await resolveRequestAccountIdentity(request)
      .catch(() => accountIdentity);
    if (bootstrapResponsePath.test(url.pathname)) {
      // Address the user the way the rest of the app does: the sidebar identity
      // is the name override, else whatever Desktop reports for its OS app user.
      // Read it from the same store the sidebar reads; if that read fails, the
      // account in the bootstrap response is the fallback.
      let reported = "";
      try {
        const auth = await desktop.readStore("LocalAgentModeSessions", "interactiveAuthStore");
        if (typeof auth?.principalDisplayName === "string") reported = auth.principalDisplayName.trim();
      } catch { /* fall back to the account name in the response */ }
      // The operator's account name wins over the legacy user-name override, so
      // the greeting, the sidebar name and the account document agree.
      const name = resolveGreetingName({
        override: (requestIdentity && requestIdentity.name) || accountIdentity.name || remoteUserName,
        reported,
        account: parsed.account,
      });
      const injected = injectPersonalizedGreeting(parsed, name);
      if (injected !== parsed) {
        parsed = injected;
        rewrote = true;
      }
    }
    // Web shell account identity (see accountIdentity): address the account the
    // way the operator configured it on every document the chrome reads it from
    // — the bootstrap's `account`, the profile document GET /api/account_profile
    // returns, and the organization document. Each helper returns the same
    // reference when there is nothing to change.
    if (webShellEnabled && accountIdentityConfigured(requestIdentity)) {
      const identity = requestIdentity;
      if (bootstrapResponsePath.test(url.pathname)) {
        if (parsed.account) {
          const account = applyAccountIdentity(parsed.account, identity);
          if (account !== parsed.account) {
            parsed = { ...parsed, account };
            rewrote = true;
          }
        } else {
          // A fresh profile has no account yet, so the chrome would sit on its
          // sign-in page. Supply the shape the app builds for itself.
          parsed = { ...parsed, account: syntheticAccount(identity) };
          rewrote = true;
          console.info(
            "[cowork-bridge] bootstrap carried no account; supplied one for",
            identity.email || identity.name,
          );
        }
      } else if (method === "GET" && accountResponsePath.test(url.pathname)) {
        const account = applyAccountIdentity(parsed, identity);
        if (account !== parsed) {
          parsed = account;
          rewrote = true;
        }
      } else if (method === "GET" && organizationResponsePath.test(url.pathname)) {
        const organization = applyOrganizationIdentity(parsed, identity);
        if (organization !== parsed) {
          parsed = organization;
          rewrote = true;
        }
      }
    }
    // Remote Cowork sessions are not served here (see
    // applyWebShellAccountPolicy); opt the bootstrap account out of the
    // renderer's remote-by-default placement so a new chat starts locally
    // instead of priming a cloud session this deployment cannot create.
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname) && parsed.account) {
      const account = applyWebShellAccountPolicy(parsed.account);
      if (account !== parsed.account) {
        parsed = { ...parsed, account };
        rewrote = true;
      }
    }
    // The web shell's Cowork surface is gated on org entitlements these
    // documents carry; grant them only in that mode (see webShellEnabled).
    if (webShellEnabled
      && (bootstrapResponsePath.test(url.pathname) || currentUserAccessPath.test(url.pathname))
      && grantWebShellEntitlements(parsed)) {
      rewrote = true;
    }
    // Whether or not the web shell is on: a tenant's Code runs on its runner,
    // and the surface will not offer an environment without these entries.
    if ((bootstrapResponsePath.test(url.pathname) || currentUserAccessPath.test(url.pathname))
      && grantTenantCodeEntitlements(parsed)) {
      rewrote = true;
    }
    // The rollout gate the same check falls back to
    // (`IS()` is `growthbook("claude_ai_tamarind") || the feature above`), so
    // the self-hosted section does not depend on whichever of the two the
    // build happens to read first.
    if (bootstrapResponsePath.test(url.pathname) && grantTenantCodeGates(parsed)) {
      rewrote = true;
    }
    // The Code landing and the Code session page resolve different
    // model-selector rows in this build; settle them on the start settings of
    // the session the user actually created (see reconcileModelSelectorState).
    if (tenantInstance && bootstrapResponsePath.test(url.pathname)) {
      const defaults = codeRunners
        ? await codeRunners.recentSessionConfig().catch(() => null) : null;
      const reconciled = reconcileModelSelectorState(parsed, defaults);
      if (reconciled !== parsed) {
        parsed = reconciled;
        rewrote = true;
      }
    }
    // The live transcript transport the Code surface picks between SSE and a
    // WebSocket (see grantCcrSubscribeSse).
    if (bootstrapResponsePath.test(url.pathname) && grantCcrSubscribeSse(parsed)) {
      rewrote = true;
    }
    // The transcript's hydration strategy (see disableCcrTailFirstTranscript).
    if (bootstrapResponsePath.test(url.pathname) && disableCcrTailFirstTranscript(parsed)) {
      rewrote = true;
    }
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname) && grantWebShellGates(parsed)) {
      rewrote = true;
    }
    // The composer's only upload lane (see grantWiggleUploadGates).
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname)
      && grantWiggleUploadGates(parsed)) {
      rewrote = true;
    }
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname) && grantRoutineGate(parsed)) {
      rewrote = true;
    }
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname)
      && grantWebShellComposerDesign(parsed)) {
      rewrote = true;
    }
    // Projects are gated on a free-plan allowance feature (see
    // grantProjectsLimits); the renderer's own predicate is restored by the
    // `web-projects-allowed` patch.
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname)
      && grantProjectsLimits(parsed)) {
      rewrote = true;
    }
    // Connectors ("Add connector" / plugins) are gated on the `papi_mcp`
    // growthbook feature; make it read true so the control is offered (see
    // grantConnectorGates).
    if (webShellEnabled && bootstrapResponsePath.test(url.pathname)
      && grantConnectorGates(parsed)) {
      rewrote = true;
    }
    // Cowork's "Skip all approvals" needs both the org settings document and
    // the rollout gate; grant whichever the renderer reads off this response
    // (see coworkSkipApprovals).
    if (coworkSkipApprovals && coworkSettingsPath.test(url.pathname)) {
      // A third-party Desktop refuses this read with a 503 error document; the
      // renderer never sees a body on a failed query, so serve the settings
      // document itself. `auto_mode_enabled` is read beside skip approvals by
      // the same query and gates the picker's auto row.
      const normalized = coworkSettingsDocument(parsed, status);
      parsed = normalized.document;
      if (normalized.synthetic) {
        status = 200;
        rewrote = true;
      }
      if (grantCoworkSkipApprovals(parsed)) rewrote = true;
      if (parsed.auto_mode_enabled !== true) {
        parsed.auto_mode_enabled = true;
        rewrote = true;
      }
    }
    if (coworkSkipApprovals && bootstrapResponsePath.test(url.pathname)
      && grantCoworkPermissionGates(parsed)) {
      rewrote = true;
    }
    // The composer's model picker: record the deployment's models for the admin
    // page's card (see modelPickerCatalogue), then lay them out from the
    // deployment's main-model list (see applyModelPickerLayout). Every shell reads
    // the same document, so the picker looks the same in the browser and in the
    // Desktop window; with no operator list, the document is left exactly as
    // upstream wrote it.
    if (bootstrapResponsePath.test(url.pathname)) {
      // Lay the list out against the ids the operator named (their list uses
      // the gateway's own spelling) before resolving a bare alias to the route
      // the gateway lists; the ids themselves are what every surface sends.
      if (applyModelPickerLayout(parsed, await resolveMainModels())) rewrote = true;
      if (await canonicalizePickerModelIds(parsed)) rewrote = true;
      rememberPickerModels(parsed);
    }
    if (rewrote) responseBody = Buffer.from(JSON.stringify(parsed), "utf8");
    if (containsSensitiveCredential(parsed)) {
      throw new ApiError(502, "Desktop protocol response contained a forbidden credential field");
    }
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": responseBody.length,
    "Content-Type": result.contentType || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(responseBody);
}

function validateInvocation(surface, method, args) {
  if (!allowedSurfaces.has(surface)) throw new ApiError(400, "Desktop surface is not allowed");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new ApiError(400, "invalid method name");
  if (!allowedMethods.get(surface)?.has(method)) {
    throw new ApiError(400, "Desktop IPC method is not allowed");
  }
  if (!Array.isArray(args)) throw new ApiError(400, "args must be an array");
}

// A tenant's read-only git IPC, answered by the guest runner instead of being
// forwarded to Desktop. The renderer's folder/branch hooks call the same
// methods they call for a local session; the answers must describe the account
// workspace as the VM sees it, and no git command may interpret workspace
// content in this privileged container. The path crossing the wire is the host
// path (`/workspace/…`) the composer picked; the runner maps it onto the shared
// mount and re-checks containment there.
async function tenantGitAnswer(body) {
  const args = body.args ?? [];
  const target = args[0];
  if (typeof target !== "string" || !target) {
    throw new ApiError(400, "workspace path is required");
  }
  // Canonicalise here so a `..`, symlink or missing folder never reaches the
  // guest; the runner validates the mapped path again.
  const path = await resolveContainedRealPath(workspaceRoot, target).catch(() => {
    throw new ApiError(403, "git reads are confined to the workspace");
  });
  const ask = (task) => task().catch((error) => {
    throw new ApiError(Number(error?.statusCode) || 503,
      error?.message || "the guest runner did not answer");
  });
  switch (body.method) {
    case "getGitInfo":
      return ask(() => codeRunners.runnerGitInfo({ root: workspaceRoot, path }));
    case "getLocalBranches":
      return ask(() => codeRunners.runnerBranches({ root: workspaceRoot, path }));
    case "isWorkingTreeDirty":
      return (await ask(() => codeRunners.runnerWorktreeState({
        root: workspaceRoot, path,
      }))) === "dirty";
    case "getWorkingTreeDirtyState":
      return ask(() => codeRunners.runnerWorktreeState({ root: workspaceRoot, path }));
    case "checkBranchSwitchConflict":
      return ask(() => codeRunners.runnerBranchConflict({
        root: workspaceRoot,
        path,
        branch: typeof args[1] === "string" ? args[1] : "",
      }));
    default:
      throw new ApiError(400, "Desktop IPC method is not allowed");
  }
}

// Desktop's session-file reader returns null (never a status) when a path is
// outside the session's granted directories or over 10 MiB, and the official
// file pane then shows a generic "Couldn't read this file". When that happens,
// read the file from the roots this bridge serves and answer the same call, so
// the pane previews it normally. Desktop still owns the happy path: we only
// fill a result it refused, never override one it produced.
// A forwarded file read arrives inline from Desktop. Keep one that fits the
// same bound the root reader uses; a larger one is refused as too large so the
// pane offers the streaming download instead of the bridge holding it.
function sessionFileValueSize(value) {
  const file = value?.file && typeof value.file === "object" ? value.file : value;
  const size = Number(file?.fileSize);
  if (Number.isFinite(size) && size >= 0) return size;
  return typeof file?.contents === "string" ? Buffer.byteLength(file.contents, "utf8") : 0;
}

function capForwardedSessionFile(value) {
  return sessionFileValueSize(value) > sessionFileMaxBytes ? null : value;
}

// Answer a session-file read from the roots this bridge serves before asking
// Desktop. Desktop hands file contents back inline, so a large file made the
// bridge hold the read Buffer, the decoded string, the IPC JSON and the HTTP
// response at once — the 256 MB container OOM-loop that a big download
// triggered. The root reader stats first and refuses past its cap, so an
// oversized file costs nothing; only a path the roots cannot answer falls
// through to Desktop.
async function bridgeLocalSessionFile(body) {
  const requested = body.method === "readFileAtCwd" ? body.args?.[0] : body.args?.[1];
  if (typeof requested !== "string" || !requested) return { handled: false };
  const read = await readContainedFile(downloadRoots, requested, {
    maxBytes: sessionFileMaxBytes,
    allowRoot: false,
    missingMessage: "session file was not found",
    outsideMessage: "session file path is outside the allowed read roots",
    sessionOutputsRoot,
  });
  if (read.file) {
    console.log(
      `[cowork-bridge] session-file ${body.method} served ${requested} (${read.file.fileSize} bytes)`,
    );
    return { handled: true, value: read.file };
  }
  if (read.failure === "too_large") {
    console.log(
      `[cowork-bridge] session-file ${body.method} declined ${requested}: too_large`
        + ` (${read.fileSize} bytes, cap ${sessionFileMaxBytes})`,
    );
    return { handled: true, value: null };
  }
  return { handled: false };
}

async function supplementSessionFileRead(body, value) {
  if (value != null) return value;
  if (body.method === "resolveSessionFile") {
    // Chat renders a path as an openable file only when this resolves. Desktop
    // refuses anything outside the session's folders, which would leave agent
    // paths un-clickable; resolve them against the roots we serve instead.
    const requested = body.args?.[1];
    if (typeof requested !== "string" || !requested) return value;
    const filePath = await resolveContainedPath(downloadRoots, requested, {
      allowRoot: true,
      missingMessage: "session file was not found",
      outsideMessage: "session file path is outside the allowed read roots",
      sessionOutputsRoot,
    });
    if (!filePath) return value;
    console.log(`[cowork-bridge] session-file resolve ${requested} -> ${filePath}`);
    return { path: filePath, aliases: [] };
  }
  const requested = body.method === "readFileAtCwd" ? body.args?.[0] : body.args?.[1];
  if (typeof requested !== "string" || !requested) return value;
  const read = await readContainedFile(downloadRoots, requested, {
    maxBytes: sessionFileMaxBytes,
    allowRoot: false,
    missingMessage: "session file was not found",
    outsideMessage: "session file path is outside the allowed read roots",
    sessionOutputsRoot,
  });
  if (read.file) {
    console.log(
      `[cowork-bridge] session-file ${body.method} served ${requested} (${read.file.fileSize} bytes)`,
    );
    return read.file;
  }
  // Log the refusal, since the pane shows the same generic message for every
  // cause and a wrong root or an undersized cap is otherwise invisible.
  console.log(
    `[cowork-bridge] session-file ${body.method} declined ${requested}: ${read.failure}`
      + (read.fileSize ? ` (${read.fileSize} bytes, cap ${sessionFileMaxBytes})` : ""),
  );
  return value;
}

// Desktop's status-bearing reader (status: ok | notFound | tooLarge | readError,
// plus a file on ok), answered by the bridge rather than forwarded. The official
// file pane prefers this method whenever the surface advertises it, and it is
// the only way a refusal reaches the pane as a reason: readSessionFile's bare
// null becomes a generic "Couldn't read this file", while tooLarge becomes
// "Preview isn't available for this file" with the size. The roots this bridge
// serves answer first so a large local file is refused by stat, never inlined
// through Desktop; a path they cannot resolve still gets Desktop's view.
async function bridgeSessionFileWithStatus(args, argsEncoding) {
  const requested = args?.[1];
  let read;
  if (typeof requested === "string" && requested) {
    read = await readContainedFile(downloadRoots, requested, {
      maxBytes: sessionFileMaxBytes,
      allowRoot: false,
      missingMessage: "session file was not found",
      outsideMessage: "session file path is outside the allowed read roots",
      sessionOutputsRoot,
    });
    if (read.file) {
      console.log(
        `[cowork-bridge] session-file readSessionFileWithStatus served ${requested} (${read.file.fileSize} bytes)`,
      );
      return { status: "ok", file: read.file };
    }
    if (read.failure === "too_large") {
      console.log(
        `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: too_large`
          + ` (${read.fileSize} bytes, cap ${sessionFileMaxBytes})`,
      );
      return { status: "tooLarge" };
    }
  }
  let described = null;
  try {
    described = await desktop.invoke(
      "LocalSessions",
      "readSessionFileWithStatus",
      args,
      argsEncoding,
    );
  } catch {
    // The inner surface may not expose it; the roots above are the fallback.
  }
  if (described?.status === "ok" && described.file) {
    const capped = capForwardedSessionFile(described.file);
    if (capped) return { status: "ok", file: capped };
    console.log(
      `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}:`
        + ` too_large from Desktop (cap ${sessionFileMaxBytes})`,
    );
    return { status: "tooLarge" };
  }
  if (read?.failure === "not_found") {
    console.log(
      `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: not_found`,
    );
    // Desktop saw a file too big to read where we find nothing.
    return described?.status === "tooLarge" ? described : { status: "notFound" };
  }
  if (described) return described;
  try {
    const file = await desktop.invoke("LocalSessions", "readSessionFile", args, argsEncoding);
    if (file) {
      const capped = capForwardedSessionFile(file);
      if (capped) return { status: "ok", file: capped };
      return { status: "tooLarge" };
    }
  } catch {
    // Fall through to readError below.
  }
  if (typeof requested !== "string" || !requested) return { status: "readError" };
  console.log(
    `[cowork-bridge] session-file readSessionFileWithStatus declined ${requested}: ${read?.failure ?? "read_error"}`,
  );
  return { status: "readError" };
}

function validateCodePreference(method, args) {
  if (method === "getPreferences" && args.length === 0) return;
  const [key, value] = args;
  const accountMap = ["bypassPermissionsOptInByAccount", "bypassPermissionsGateByAccount"].includes(key);
  if (method !== "setPreference" || args.length !== 2
    || !(key === "bypassPermissionsModeEnabled" && typeof value === "boolean"
      // The desktop UI funnels its account-scoped UI picks (permission mode,
      // notification levels, sidebar mode, ...) through one `epitaxyPrefs`
      // bucket, so that key is what a permission-mode change actually writes.
      || key === "epitaxyPrefs" && value && typeof value === "object" && !Array.isArray(value)
        && Object.entries(value).every(([entry, item]) =>
          entry.length <= 128 && isBoundedJsonValue(item, 1))
      || accountMap && value && typeof value === "object" && !Array.isArray(value)
        && Object.entries(value).every(([account, enabled]) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)
          && typeof enabled === "boolean"))) {
    throw new ApiError(400, "Code preference is not allowed");
  }
}

function validateSettingsInvocation(surface, method, args) {
  if (!gatewaySettingsEnabled) {
    throw new ApiError(404, "Remote Gateway settings are disabled");
  }
  if (!allowedSettingsMethods.get(surface)?.has(method)) {
    throw new ApiError(400, "Gateway settings method is not allowed");
  }
  if (!Array.isArray(args)) throw new ApiError(400, "args must be an array");
  if (surface === "AppPreferences") {
    // A tenant has no local Code executor (`codeActionsEnabled` is false by
    // construction) but does have a real Code surface on its self-hosted
    // runner. Its draft permission mode, model/effort pick and branch prefix
    // live in `epitaxyPrefs` behind this surface; refusing it made every pick
    // look like it did not save (the renderer could not read or write the
    // preference at all).
    if (!codeActionsEnabled && !codeSurfaceEnabled) throw new ApiError(404, "Code settings are disabled");
    validateCodePreference(method, args);
  }
  if (method === "getLoginDesktop3pStatus" && args.length !== 0) {
    throw new ApiError(400, "getLoginDesktop3pStatus does not accept arguments");
  }
}

function sanitize3pLoginStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.provider === "string" && value.provider.length <= 80) {
    result.provider = value.provider;
  }
  if (typeof value.bootstrapHost === "string" && value.bootstrapHost.length <= 500) {
    result.bootstrapHost = value.bootstrapHost;
  }
  if (typeof value.needsInteractiveAuth === "boolean") {
    result.needsInteractiveAuth = value.needsInteractiveAuth;
  }
  if (value.source && typeof value.source === "object" && !Array.isArray(value.source)) {
    const source = {};
    if (typeof value.source.type === "string" && value.source.type.length <= 80) {
      source.type = value.source.type;
    }
    if (typeof value.source.managedUnusable === "boolean") {
      source.managedUnusable = value.source.managedUnusable;
    }
    result.source = source;
  }
  return result;
}

function requireNonEmptyString(value, name, maxLength = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ApiError(400, `${name} must be a non-empty string`);
  if (normalized.length > maxLength) {
    throw new ApiError(400, `${name} is too long`);
  }
  return normalized;
}

function requireConfiguredModel(value) {
  const model = requireNonEmptyString(value, "model", 200);
  if (!allowedModels.size) {
    throw new ApiError(503, "no inference models are configured for the bridge");
  }
  if (!allowedModels.has(model)) {
    throw new ApiError(400, `unsupported model: ${model}`);
  }
  return model;
}

function isChatSession(session) {
  return session?.sessionType === "chat";
}

async function getSession(sessionId) {
  const session = await desktop.invoke("LocalAgentModeSessions", "getSession", [sessionId]);
  if (!session) throw new ApiError(404, "session not found");
  return session;
}

async function requireSessionKind(sessionId, kind) {
  const session = await getSession(sessionId);
  const matches = kind === "chat" ? isChatSession(session) : !isChatSession(session);
  if (!matches) throw new ApiError(409, `session is not a ${kind} session`);
  return session;
}

async function sendSessionMessage(sessionId, message) {
  const messageUuid = randomUUID();
  // Claude Desktop validates absent attachment arguments as undefined. Preserve
  // that value across JSON instead of converting it to null or an empty array.
  const value = await desktop.invoke("LocalAgentModeSessions", "sendMessage", [
    sessionId,
    message,
    undefined,
    undefined,
    messageUuid,
    undefined,
  ], "json-undefined-v1");
  return { value, messageUuid };
}

// Desktop's Code UI resolves a session's permission mode from the layer stored
// for its *project folder* — `epitaxyPrefs["epitaxy-folder-permission-mode.<account>"]`,
// keyed by the session's `originCwd` (a worktree session strips back to the repo
// root). Those layers only count once the selected folder is in the renderer's
// trust store (`st`/`ct` in its mode hook); for a brand-new session — especially
// one whose worktree was just created — that is still false when the first
// message goes out, so the renderer sends its failsafe `permissionMode:
// "default"` rather than the stored pick. The first turn then runs Manual and
// the session keeps `default` until the user re-picks or rewinds and resends.
//
// Fill the stored pick in on `start` when the composer expressed no real choice
// (mode absent, or the renderer's failsafe "default"), so the first turn runs
// with the mode the picker shows. An explicit non-default pick always wins, and
// a folder with no stored pick is left alone.
const folderPermissionModeCache = { at: 0, map: null };

function worktreeRepoRoot(path) {
  return String(path).replace(/\/\.claude\/worktrees\/[^/]+$/, "");
}

async function storedFolderPermissionModes() {
  if (folderPermissionModeCache.map && Date.now() - folderPermissionModeCache.at < 5000) {
    return folderPermissionModeCache.map;
  }
  const map = {};
  try {
    const prefs = await desktop.invokeSettings("AppPreferences", "getPreferences", [], "json-undefined-v1");
    const bucket = prefs?.epitaxyPrefs;
    for (const [key, value] of Object.entries(bucket || {})) {
      if (!key.startsWith("epitaxy-folder-permission-mode.")) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [folder, mode] of Object.entries(value)) {
        if (typeof mode === "string" && mode) map[folder] = mode;
      }
    }
  } catch (error) {
    console.log(`[cowork-bridge] stored folder permission modes unavailable: ${error.message}`);
  }
  folderPermissionModeCache.at = Date.now();
  folderPermissionModeCache.map = map;
  return map;
}

// The permission mode a browser draft should start with when its create body
// carries no real choice. The web composer's spawn mode falls back to the
// failsafe "default" until its folder/preference layers settle, so a quick
// send used to create a Manual session while the picker showed Bypass (and the
// send-path control request then wrote "default" into the session). The
// renderer's own persisted pick is the first answer; the mode of the last
// placed session is the seed the preload uses for the same draft, so it is the
// fallback when the renderer has not written one.
async function storedDefaultPermissionMode() {
  try {
    const prefs = await desktop.invokeSettings(
      "AppPreferences", "getPreferences", [], "json-undefined-v1",
    );
    const bucket = prefs?.epitaxyPrefs ?? {};
    let accountPick = null;
    let globalPick = null;
    for (const [key, value] of Object.entries(bucket)) {
      if (typeof value !== "string" || !value) continue;
      if (key === "cc-landing-draft-permission-mode") globalPick = value;
      else if (key.startsWith("cc-landing-draft-permission-mode.")) accountPick = value;
    }
    const mode = accountPick ?? globalPick;
    if (mode && mode !== "plan" && mode !== "default") return mode;
  } catch { /* the preference read is best-effort */ }
  const recent = codeRunners
    ? await codeRunners.recentSessionConfig().catch(() => null) : null;
  const mode = recent?.permission_mode;
  return mode && mode !== "plan" ? mode : null;
}

async function fillStoredStartPermissionMode(args, { defaultMeansNoChoice = false } = {}) {
  const info = args?.[0];
  if (!info || typeof info !== "object" || Array.isArray(info)) return;
  const passed = info.permissionMode;
  // No real choice arrives three ways: a missing key, the transport's undefined
  // sentinel, or the Code UI's failsafe "default" (what it sends while the
  // folder's stored layers have not settled). That last one is only read as "no
  // choice" for the browser UI: the mobile facade's own Manual pick travels as
  // the same string and must be left alone.
  const noChoice = passed === undefined
    || (passed && typeof passed === "object" && passed[undefinedSentinelKey] === true)
    || (defaultMeansNoChoice && passed === "default");
  if (!noChoice) return;
  const cwd = typeof info.cwd === "string" ? info.cwd : null;
  if (!cwd) return;
  const modes = await storedFolderPermissionModes();
  const mode = modes[cwd] ?? modes[worktreeRepoRoot(cwd)];
  if (!mode) return;
  info.permissionMode = mode;
  console.log(`[cowork-bridge] start ${cwd}: filled permissionMode=${mode} from the stored folder pick`);
}

// A routine's own file is the one write the Desktop refuses *by design*. Its
// store will not publish a SKILL.md that carries a second hard link, because
// writing "through" the link would land on the link's other name rather than on
// the task — the redirect a sandboxed agent can set up through a shared folder —
// so the update stops with "Not written: this task's file is hard-linked to
// another file. Replace it with a plain copy." The refusal is right, and on its
// own it strands the routine: the store checks on every write, so every later
// edit, from every client, fails the same way until that file on that machine is
// a plain copy, which is exactly what a browser cannot make it. (Recent Desktop
// builds gate the refusal behind a rollout flag and repair the link themselves
// while it is off; it reads on here.)
//
// Do what the refusal asks, in the bridge, where the call already passes: ask
// Desktop for the task's own `filePath` — its task list carries it, and that is
// the store's own answer, so the repair does not have to guess a directory that a
// store is free not to name for the task id — and replace that file with a plain
// copy of the same bytes. Nothing is ever written through the link, so the other
// name keeps its own bytes, and a refusal that survives says what the repair saw.
const routineTaskFileWriteMethods = new Set([
  "updateScheduledTask",
  "updateScheduledTaskFileContent",
]);
const routineFileLinkSuffix = ".hardlinked";

function routineTaskIdFromInvocation(method, args) {
  if (!routineTaskFileWriteMethods.has(method)) return null;
  const params = (args ?? []).find(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  const id = params?.scheduledTaskId ?? params?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

// Desktop's own answer for where a task keeps its files. A task whose files live
// on another machine answers a path that is not here, which the repair reports
// rather than guesses at.
async function routineTaskFilePath(scheduledTaskId) {
  const tasks = await desktop.invoke("CoworkScheduledTasks", "getAllScheduledTasks", []);
  if (!Array.isArray(tasks)) return { state: "the Desktop listed no tasks" };
  const task = tasks.find((entry) => (entry?.id ?? entry?.scheduledTaskId) === scheduledTaskId);
  if (!task) {
    return { state: `the Desktop's list has no task "${scheduledTaskId}" (${tasks.length} listed)` };
  }
  const filePath = task.filePath;
  if (typeof filePath !== "string" || filePath === "") {
    return { state: `the Desktop listed "${scheduledTaskId}" without a file path` };
  }
  return { state: "path", filePath };
}

// Replaces one linked file with a plain copy of the same bytes, in a fresh inode,
// published by `rename` so the path is never missing — the store reads the file
// back to merge a prompt-only or description-only update, so a file moved out of
// the way would fail that read. Nothing is written through the link, so whatever
// other name the inode carries keeps its own bytes. Answers with what it saw: the
// note travels back to the client when the write is refused anyway.
async function repairLinkedRoutineFile(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    return `${filePath}: ${error?.code ?? "unreadable"}`;
  }
  if (!info.isFile()) return `${filePath}: not a file`;
  if (info.nlink <= 1) return `${filePath}: plain (nlink ${info.nlink})`;
  try {
    const content = await readFile(filePath);
    const temporary = `${filePath}${routineFileLinkSuffix}${Date.now()}`;
    await writeFile(temporary, content, { mode: info.mode & 0o777 });
    await rename(temporary, filePath);
  } catch (error) {
    return `${filePath}: hard-linked (nlink ${info.nlink}), could not be replaced with a copy (${error?.message || error})`;
  }
  console.log(
    `[cowork-bridge] routine file repair: ${filePath} was hard-linked to another name`
      + ` (nlink ${info.nlink}, inode ${info.ino}); replaced it with a plain copy`
      + " so the Desktop can write it",
  );
  return `${filePath}: replaced with a plain copy (was nlink ${info.nlink})`;
}

async function repairRoutineTaskFileForWrite(method, args) {
  const scheduledTaskId = routineTaskIdFromInvocation(method, args);
  if (scheduledTaskId === null) return `the call names no task`;
  let located;
  try {
    located = await routineTaskFilePath(scheduledTaskId);
  } catch (error) {
    return `could not ask the Desktop where "${scheduledTaskId}" keeps its file: ${error?.message || error}`;
  }
  if (located.state !== "path") return located.state;
  const seen = [await repairLinkedRoutineFile(located.filePath)];
  // The watcher script sits in the same directory and is published by the same
  // writer, so a link on it blocks the update exactly as SKILL.md's does. Only
  // linked files are touched, and only inside the task's own directory.
  const directory = dirname(located.filePath);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes(routineFileLinkSuffix)) continue;
    const sibling = join(directory, entry.name);
    if (sibling === located.filePath) continue;
    const note = await repairLinkedRoutineFile(sibling);
    if (!note.endsWith("plain (nlink 1)")) seen.push(note);
  }
  return seen.join("; ");
}

function isLinkedRoutineFileRefusal(error) {
  return /hard-linked to another file/.test(String(error?.message ?? error));
}

// What the app process reports about its own routine file repairs. This bridge is
// a separate container whose /config is mounted read-only (compose.yaml), so its
// repair can only ever *describe* one of these files — the app container owns the
// write. When a refusal survives here, saying whether the app side even has a
// repair is the difference between two very different problems.
async function desktopRoutineFileRepairState() {
  try {
    const response = await fetch(`${coworkInternalUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => null);
    if (!body?.routineFileLinkRepair) return "the app reports no routine file repair";
    return `the app reports ${JSON.stringify(body.routineFileLinkRepair)}`;
  } catch (error) {
    return `the app could not be asked (${error?.message || error})`;
  }
}

// Every routine write the browser makes goes through here: the repair asks
// Desktop for the path itself, and a refusal that survives one repair and one
// retry comes back with what the repair saw, so a routine stuck on a machine
// nobody logs into is diagnosable from the browser that hit it.
async function invokeWithRoutineFileRepair(surface, method, args, argsEncoding) {
  if (surface !== "CoworkScheduledTasks" || !routineTaskFileWriteMethods.has(method)) {
    return desktop.invoke(surface, method, args, argsEncoding);
  }
  const seen = [await repairRoutineTaskFileForWrite(method, args)];
  try {
    return await desktop.invoke(surface, method, args, argsEncoding);
  } catch (error) {
    if (!isLinkedRoutineFileRefusal(error)) throw error;
    // The path can also turn up linked between the repair and the write, and the
    // list is read again so a task whose file moved is still found.
    seen.push(await repairRoutineTaskFileForWrite(method, args));
    try {
      return await desktop.invoke(surface, method, args, argsEncoding);
    } catch (retryError) {
      if (!isLinkedRoutineFileRefusal(retryError)) throw retryError;
      const appState = await desktopRoutineFileRepairState();
      throw new Error(
        `${String(retryError?.message ?? retryError)}`
        + ` [cowork-bridge: routine file repair saw ${seen.join(" | ")}; ${appState}]`,
      );
    }
  }
}

// The settled-empty claude.ai document for each project sub-resource this
// deployment has no data for. A space keeps none of these — the knowledge base,
// its syncs, the share roster and the project's conversation list are claude.ai
// features, and a space's files are the folders the project is bound to — so the
// renderer is told the true answer: nothing, not loading, nothing failed.
//
// The shapes are pinned by their readers, not invented: the share roster
// (`/roles`) is destructured by the migration client's `qr`, which throws on
// anything that is not `{account_assignments, group_assignments,
// org_role_assignments, org_assignment}`; the accounts list (`/accounts`) is
// walked with `?.find(...)` by the permissions hook, so it must be an array; the
// permission list (`/permissions`) is read as `.permissions`.
function emptyProjectResource(sub, accountUuid) {
  const page = { data: [], pagination: { has_more: false, limit: 30, offset: 0, total: 0 } };
  switch (sub) {
    case "roles":
      return {
        account_assignments: accountUuid ? [{ uuid: accountUuid }] : [],
        group_assignments: [],
        org_role_assignments: {},
        org_assignment: null,
      };
    case "accounts":
      return accountUuid ? [{ account: { uuid: accountUuid }, role: "creator" }] : [];
    case "permissions":
      return { permissions: [] };
    case "groups":
    case "files":
    case "docs":
    case "syncs":
      return [];
    case "kb":
      return { files: [], documents: [], syncs: [] };
    case "kb/stats":
      return { file_count: 0, document_count: 0, sync_count: 0 };
    case "report":
      return { report: null, status: "unavailable" };
    case "activity_v2":
    case "conversations_v2":
      return page;
    default:
      return { ok: true };
  }
}

// The self-hosted pool API, runner side. A runner — Claude Code running inside
// the tenant's Cowork guest — registers here and polls for work, authenticated
// by the pool secret alone. Served only on a tenant instance with the feature
// on, so the operator's own instance and the account's own container are both
// untouched by it. Wire shapes: bridge/code-runners.mjs.
const selfHostedPoolsBase = "/v1/code/runners/self-hosted/pools/";

// Fields the staged Claude Code sends that the account's gateway chain does
// not carry to the provider intact: the chain drops (or never forwards) the
// `anthropic-beta` headers that would make the provider accept them, so the
// provider validates strictly and answers 400 ("thinking: Unrecognized key:
// \"display\"; Unrecognized key: \"context_management\""). The bridge is the
// account's API surface for the VM, so it normalizes here — and says so, one
// log line per request that needed it — rather than pinning the CLI to
// whichever version the chain happens to understand today.
const gatewayDroppedFields = ["context_management", "thinking.display"];

function stripGatewayUnsupported(payload) {
  const dropped = [];
  for (const path of gatewayDroppedFields) {
    const [head, tail] = path.split(".");
    if (tail === undefined) {
      if (head in payload) {
        delete payload[head];
        dropped.push(path);
      }
      continue;
    }
    const parent = payload[head];
    if (parent && typeof parent === "object" && !Array.isArray(parent) && tail in parent) {
      delete parent[tail];
      dropped.push(path);
    }
  }
  return dropped;
}

// Claude Code's long-context spelling: a model id may carry a trailing `[1m]`
// (Desktop lists the spelling as its own picker row). It is a context marker,
// not a route the account's gateway serves — the CLI splits it off before a
// normal turn. The one call that does not is Auto permission mode's safety
// classifier: it builds its fallback id from ANTHROPIC_DEFAULT_OPUS_MODEL and
// re-appends the suffix to match a 1M session model, so the gateway answers
// "Claude discovery model alias is invalid" and auto mode decides it cannot
// determine the safety of the tool it was reviewing. Resolve it here, at the
// boundary that speaks to the gateway, the way the CLI already does for every
// other model call.
const longContextSuffix = /\[1m\]\s*$/i;

function stripLongContextModel(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.model !== "string") return;
  const requested = payload.model;
  const bare = requested.replace(longContextSuffix, "").trim();
  if (!bare || bare === requested) return;
  payload.model = bare;
  return requested;
}

// A gateway may list Anthropic-family models under both a bare alias and the
// provider-prefixed route it actually serves. This deployment's chain is one:
// `GET /v1/models` (with the desktop's own paging parameters) advertises
// `claude-opus-5-5`, while `/v1/messages` only routes
// `anthropic/claude-opus-5-5` and answers the bare alias with
// "Upstream /v1/responses ... only does openai/, grok/, deepseek/, opencode/,
// and compatible aliases". The app's health probe and a model pick can both
// carry the bare spelling, so resolve it to the one route the gateway lists
// when exactly one prefixed id ends in that alias. The lookup is cached: a
// model call must not pay a discovery round trip each time.
const gatewayModelCache = {
  ids: null, expires: 0, inFlight: null, failedAt: 0,
};
// The desktop's discovery pages with `limit=1000`; that view is the gateway's
// route aliases (the ids the app actually places sessions with), while the
// plain view lists the provider-prefixed ids. Both are useful when looking for
// a model that can answer a health probe.
const gatewayAliasCache = {
  ids: null, expires: 0, inFlight: null, failedAt: 0,
};
const gatewayModelTtlMs = 5 * 60 * 1000;
const gatewayModelFailureTtlMs = 30 * 1000;

function gatewayAuthHeaders(scheme, key) {
  return scheme === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
}

async function gatewayModelIds(base, key, scheme) {
  const now = Date.now();
  if (gatewayModelCache.ids && gatewayModelCache.expires > now) {
    return gatewayModelCache.ids;
  }
  if (gatewayModelCache.failedAt && now - gatewayModelCache.failedAt < gatewayModelFailureTtlMs) {
    return null;
  }
  if (gatewayModelCache.inFlight) return gatewayModelCache.inFlight;
  gatewayModelCache.inFlight = (async () => {
    try {
      const response = await fetch(`${String(base).replace(/\/+$/, "")}/v1/models`, {
        headers: { ...gatewayAuthHeaders(scheme, key), "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const ids = Array.isArray(body?.data)
        ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string" && id)
        : [];
      if (!ids.length) throw new Error("no models listed");
      gatewayModelCache.ids = ids;
      gatewayModelCache.expires = Date.now() + gatewayModelTtlMs;
      gatewayModelCache.failedAt = 0;
      return ids;
    } catch (error) {
      gatewayModelCache.failedAt = Date.now();
      console.warn(`[inference] could not read the gateway's model list: ${error.message}`);
      return null;
    } finally {
      gatewayModelCache.inFlight = null;
    }
  })();
  return gatewayModelCache.inFlight;
}

async function gatewayAliasIds(base, key, scheme) {
  const now = Date.now();
  if (gatewayAliasCache.ids && gatewayAliasCache.expires > now) {
    return gatewayAliasCache.ids;
  }
  if (gatewayAliasCache.failedAt
    && now - gatewayAliasCache.failedAt < gatewayModelFailureTtlMs) {
    return null;
  }
  if (gatewayAliasCache.inFlight) return gatewayAliasCache.inFlight;
  gatewayAliasCache.inFlight = (async () => {
    try {
      const response = await fetch(
        `${String(base).replace(/\/+$/, "")}/v1/models?limit=1000`, {
          headers: { ...gatewayAuthHeaders(scheme, key), "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(5000),
        });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const ids = Array.isArray(body?.data)
        ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string" && id)
        : [];
      if (!ids.length) throw new Error("no models listed");
      gatewayAliasCache.ids = ids;
      gatewayAliasCache.expires = Date.now() + gatewayModelTtlMs;
      gatewayAliasCache.failedAt = 0;
      return ids;
    } catch (error) {
      gatewayAliasCache.failedAt = Date.now();
      console.warn(`[inference] could not read the gateway's alias list: ${error.message}`);
      return null;
    } finally {
      gatewayAliasCache.inFlight = null;
    }
  })();
  return gatewayAliasCache.inFlight;
}

/** The gateway's own id for a bare Anthropic alias, when it lists exactly one
 *  route ending in `/alias`; otherwise the requested id, unchanged. */
async function resolveGatewayModelAlias(model, base, key, scheme) {
  if (typeof model !== "string" || !/^claude-[a-z0-9.-]+$/i.test(model)) return model;
  const ids = await gatewayModelIds(base, key, scheme);
  if (!ids) return model;
  const candidates = ids.filter((id) => id.endsWith(`/${model}`));
  return candidates.length === 1 ? candidates[0] : model;
}

/** Rewrite the model ids in a bootstrap's picker documents to the gateway's
 *  own prefixed routes, when an alias resolves. The picker sends these ids in
 *  every Chat/Cowork/Code request; a gateway whose `/v1/messages` routes only
 *  the prefixed id would reject the bare alias the discovery listed. Returns
 *  whether anything changed. */
async function canonicalizePickerModelIds(document) {
  const base = process.env.CLAUDE_GATEWAY_BASE_URL || "";
  const key = process.env.CLAUDE_GATEWAY_API_KEY || "";
  const scheme = process.env.CLAUDE_GATEWAY_AUTH_SCHEME || "bearer";
  if (!base || !key) return false;
  const ids = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      if (/^claude-[a-z0-9.-]+$/i.test(value)) ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, entry] of Object.entries(value)) {
      if (name === "id" && typeof entry === "string") collect(entry);
      else if (name === "model" && typeof entry === "string") collect(entry);
      else collect(entry);
    }
  };
  collect(document?.model_selector_config);
  collect(document?.model_selector_state);
  if (!ids.size) return false;
  const resolved = new Map();
  await Promise.all([...ids].map(async (id) => {
    resolved.set(id, await resolveGatewayModelAlias(id, base, key, scheme));
  }));
  if (![...resolved].some(([id, canonical]) => canonical !== id)) return false;
  const rewrite = (value) => {
    if (typeof value === "string") return resolved.get(value) ?? value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    for (const [name, entry] of Object.entries(value)) {
      if (name === "id" || name === "model") value[name] = rewrite(entry);
      else rewrite(entry);
    }
    return value;
  };
  rewrite(document.model_selector_config);
  rewrite(document.model_selector_state);
  const changed = [...resolved].filter(([id, canonical]) => canonical !== id);
  console.log(`[model-picker] resolved ${changed.length} alias(es) to the gateway's routes: `
    + changed.map(([id, canonical]) => `${id} -> ${canonical}`).join(", "));
  return true;
}

// The corrected-health probe is a real inference request (`max_tokens: 1`), and
// the surface asks for config health on every page load. A `config_model_rejected`
// answer would otherwise reach the gateway again each time, so a fresh answer is
// reused briefly; a rejected route does not start working between two page loads.
const gatewayProbeCache = new Map();
const gatewayProbeTtlMs = 60 * 1000;
const gatewayProbeCacheMax = 64;

/** Probe one model over the Messages API, the same `max_tokens: 1` request the
 *  Desktop's config-health check sends. Returns `{status, ok, requestUrl,
 *  body}` or null when the gateway cannot be asked. */
async function probeGatewayModel(model, base, key, scheme, timeoutMs = 8000) {
  const cacheKey = `${String(base).replace(/\/+$/, "")}\u0000${model}`;
  const cached = gatewayProbeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.probed;
  const requestUrl = `${String(base).replace(/\/+$/, "")}/v1/messages`;
  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        ...gatewayAuthHeaders(scheme, key),
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(8000, timeoutMs))),
    });
    const body = await response.text().catch(() => "");
    const probed = { status: response.status, ok: response.ok, requestUrl, body: body.slice(0, 500) };
    gatewayProbeCache.set(cacheKey, { probed, expires: Date.now() + gatewayProbeTtlMs });
    while (gatewayProbeCache.size > gatewayProbeCacheMax) {
      gatewayProbeCache.delete(gatewayProbeCache.keys().next().value);
    }
    return probed;
  } catch (error) {
    console.warn(`[config-health] could not probe ${model}: ${error.message}`);
    return null;
  }
}

// How many alternate routes one health check may try, and the wall-clock budget
// for all of them. This runs when the page asks for config health, so it must
// not become a fan-out: the chain needs one route that answers, not a report on
// every seeded model. Probing all of them in parallel put a burst of
// `max_tokens: 1` requests on the gateway on every page load (and multiplied
// the load exactly when the upstreams were rate limited).
const workingProbeLimit = 4;
const workingProbeBudgetMs = 10000;

/** The first gateway-listed model that answers a probe, for a health check
 *  whose preferred model is rate limited rather than missing. The chain names
 *  the upstreams that can serve `/v1/messages` in its own error; prefer them
 *  and skip the Anthropic-prefixed route a quota may have exhausted. */
async function workingGatewayModel(base, key, scheme, excluded) {
  const [ids, aliases] = await Promise.all([
    gatewayModelIds(base, key, scheme),
    gatewayAliasIds(base, key, scheme),
  ]);
  if (!ids && !aliases) return null;
  const skip = new Set([excluded, ...(process.env.CLAUDE_TITLE_MODEL
    ? [process.env.CLAUDE_TITLE_MODEL] : [])]);
  // Cheap routes first: the chain's own error copy says `/v1/responses` serves
  // the openai/grok/deepseek/opencode families, and the fable aliases are the
  // ones this deployment's sessions actually run on. Skip the prefixed
  // Anthropic route, which is the one a quota usually exhausts, and the
  // self-hosted/tw02 entries that are not Messages routes at all.
  const cheap = /fable|deepseek-flash|grok\/|glm-|haiku|minimax|beam|longcat/i;
  const candidates = [...new Set([...(aliases ?? []), ...(ids ?? [])])]
    .filter((id) => !skip.has(id)
      && !id.startsWith("anthropic/")
      && !id.startsWith("selfhosted/")
      && !id.startsWith("tw02/"))
    .sort((left, right) => Number(!cheap.test(left)) - Number(!cheap.test(right)))
    .slice(0, workingProbeLimit);
  // Sequential, first success wins: a healthy chain costs one request, and the
  // per-model probe cache makes a page reload inside its TTL cost none.
  const deadline = Date.now() + workingProbeBudgetMs;
  for (const model of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const probed = await probeGatewayModel(model, base, key, scheme, remaining);
    if (probed?.ok) return { model, ...probed };
  }
  return null;
}

/** Health judged against the operator's configured model, when the admin page
 *  names one. Unlike Desktop's own pick this is a deliberate choice, so its
 *  answer is taken at face value: a success clears the rejection, a 400/404
 *  keeps it (naming the chosen id), and any other status is a provider error.
 *  No alternate-route fan-out here — a model the operator chose and this
 *  deployment cannot serve should be reported, not papered over with another
 *  model's success. */
async function probeConfiguredModelHealth(health, configuredModel, base, key, scheme) {
  const canonical = await resolveGatewayModelAlias(configuredModel, base, key, scheme);
  const probed = await probeGatewayModel(canonical, base, key, scheme);
  if (!probed) return health;
  const checkedAt = new Date().toISOString();
  if (probed.ok) {
    console.log(`[config-health] configured model ${canonical} answered;`
      + ` clearing the rejection of ${health.probedModel}`);
    return {
      ...health,
      state: "healthy",
      message: undefined,
      checkedAt,
      httpStatus: probed.status,
      requestUrl: probed.requestUrl,
      probedModel: canonical,
      responseBody: undefined,
    };
  }
  const modelRejected = probed.status === 400 || probed.status === 404;
  console.log(`[config-health] configured model ${canonical} answered HTTP ${probed.status}`
    + (modelRejected ? "; the gateway does not serve it" : ""));
  return {
    ...health,
    state: modelRejected ? "config_model_rejected" : "provider_error",
    message: modelRejected
      ? `Gateway rejected model "${canonical}" (HTTP ${probed.status})`
      : `Gateway returned HTTP ${probed.status}`,
    checkedAt,
    httpStatus: probed.status,
    requestUrl: probed.requestUrl,
    probedModel: canonical,
    responseBody: probed.body || undefined,
  };
}

/**
 * The Desktop's config-health probe runs in its main process, against the bare
 * model alias its discovery picked. A gateway that lists `claude-opus-5-5`
 * under `/v1/models?limit=1000` but only routes `anthropic/claude-opus-5-5` on
 * `/v1/messages` then shows "Configured model not available" on every page,
 * although the route exists. Resolve the alias and re-probe the route the
 * gateway does serve: a success clears the false rejection; a rejection of the
 * canonical id is kept (and a rate limit/5xx is retried against another seeded
 * model, so one exhausted route is not reported as a broken configuration).
 * When the admin page names a configured model, that id is probed instead — see
 * probeConfiguredModelHealth.
 * Only a browser's settings call reaches this — the native window talks to its
 * main process directly.
 */
async function correctedGatewayHealth(health) {
  if (!health || typeof health !== "object" || health.state !== "config_model_rejected"
    || typeof health.probedModel !== "string" || !health.probedModel) return health;
  const base = process.env.CLAUDE_GATEWAY_BASE_URL || "";
  const key = process.env.CLAUDE_GATEWAY_API_KEY || "";
  const scheme = process.env.CLAUDE_GATEWAY_AUTH_SCHEME || "bearer";
  if (!base || !key) return health;
  // An operator-picked configured model wins over Desktop's own pick. That pick
  // is the shortest haiku/sonnet/opus entry, which no Desktop setting reaches —
  // exactly the model the banner names when the gateway does not serve it. The
  // admin page's choice is the deployment's answer to that, so probe it instead
  // of trying to rescue Desktop's pick.
  const configuredModel = await resolveConfiguredModel();
  if (configuredModel) {
    return probeConfiguredModelHealth(health, configuredModel, base, key, scheme);
  }
  const canonical = await resolveGatewayModelAlias(health.probedModel, base, key, scheme);
  if (canonical === health.probedModel) return health;
  const probed = await probeGatewayModel(canonical, base, key, scheme);
  if (!probed) return health;
  const checkedAt = new Date().toISOString();
  if (probed.ok) {
    console.log(`[config-health] model ${health.probedModel} is ${canonical} on this gateway;`
      + " the rejection was the alias, not the route");
    return {
      ...health,
      state: "healthy",
      message: undefined,
      checkedAt,
      httpStatus: probed.status,
      requestUrl: probed.requestUrl,
      probedModel: canonical,
      responseBody: undefined,
    };
  }
  const modelRejected = probed.status === 400 || probed.status === 404;
  if (!modelRejected) {
    // The route exists but this model cannot answer right now (an exhausted
    // upstream quota, typically). One model's quota is not the deployment's
    // configuration: if another seeded model answers, the chain is healthy.
    const fallback = await workingGatewayModel(base, key, scheme, canonical);
    if (fallback) {
      console.log(`[config-health] ${canonical} answered HTTP ${probed.status};`
        + ` ${fallback.model} answered ${fallback.status}, so the chain is healthy`);
      return {
        ...health,
        state: "healthy",
        message: undefined,
        checkedAt,
        httpStatus: fallback.status,
        requestUrl: fallback.requestUrl,
        probedModel: fallback.model,
        responseBody: undefined,
      };
    }
    console.log(`[config-health] ${canonical} answered HTTP ${probed.status};`
      + " no other seeded model answered, reporting a provider error");
  }
  return {
    ...health,
    state: modelRejected ? "config_model_rejected" : "provider_error",
    message: modelRejected
      ? `Gateway rejected model "${canonical}" (HTTP ${probed.status})`
      : `Gateway returned HTTP ${probed.status}`,
    checkedAt,
    httpStatus: probed.status,
    requestUrl: probed.requestUrl,
    probedModel: canonical,
    responseBody: probed.body || undefined,
  };
}

// The model calls of the runner inside the VM, forwarded through the one
// address the guest provably reaches: the guest dials the bridge on slirp's
// host address for its own polling, and its egress is filtered by an allowlist
// of its own, so the account's gateway is not something it can be assumed to
// reach directly (the call hangs rather than failing when it cannot). The
// runner authenticates with its pool secret — the same one it polls with — and
// the bridge attaches the account's own gateway credentials, the pair the
// Desktop itself uses, then streams the answer back untouched: Claude Code
// speaks the Anthropic wire and so does the account's gateway chain.
async function handleInferencePassthrough(request, response, url) {
  if (!(await codeRunners.verifyInferenceAuth({ headers: request.headers }))) {
    throw new ApiError(401, "unknown inference credential");
  }
  const gatewayBase = process.env.CLAUDE_GATEWAY_BASE_URL || "";
  const gatewayKey = process.env.CLAUDE_GATEWAY_API_KEY || "";
  const gatewayScheme = process.env.CLAUDE_GATEWAY_AUTH_SCHEME || "bearer";
  if (!gatewayBase || !gatewayKey) {
    throw new ApiError(502, "this instance has no inference gateway configured");
  }
  const body = await readRequestBuffer(request, 32 * 1024 * 1024);
  let forwardBody = body;
  if (String(request.headers["content-type"] || "").includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      const dropped = stripGatewayUnsupported(payload);
      const longContextModel = stripLongContextModel(payload);
      const requestedModel = payload.model;
      const aliasModel = await resolveGatewayModelAlias(
        payload.model, gatewayBase, gatewayKey, gatewayScheme);
      if (aliasModel !== requestedModel) payload.model = aliasModel;
      if (dropped.length > 0 || longContextModel !== undefined || aliasModel !== requestedModel) {
        forwardBody = Buffer.from(JSON.stringify(payload));
        if (dropped.length > 0) {
          console.log(`[inference] dropped gateway-unsupported field(s): ${dropped.join(", ")}`);
        }
        if (longContextModel !== undefined) {
          console.log(`[inference] model ${longContextModel} -> ${payload.model} for the gateway`);
        }
        if (aliasModel !== requestedModel) {
          console.log(`[inference] model ${requestedModel} -> ${aliasModel} for the gateway`);
        }
      }
    } catch {
      // Not JSON this bridge recognizes: forward it untouched.
    }
  }
  const headers = {
    "content-type": request.headers["content-type"] || "application/json",
  };
  for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
    if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
  }
  if (gatewayScheme === "x-api-key") headers["x-api-key"] = gatewayKey;
  else headers.authorization = `Bearer ${gatewayKey}`;
  const controller = new AbortController();
  // The client going away is the *response's* early close — a request's own
  // `close` fires as soon as its body has been read, which would abort this
  // forward the moment it starts.
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const upstream = await fetch(`${String(gatewayBase).replace(/\/+$/, "")}${url.pathname}`, {
    method: "POST",
    headers,
    body: forwardBody,
    signal: controller.signal,
  });
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    ...(upstream.headers.get("cache-control")
      ? { "cache-control": upstream.headers.get("cache-control") } : {}),
  });
  if (upstream.body) {
    try {
      for await (const chunk of upstream.body) response.write(Buffer.from(chunk));
    } catch {
      // The client went away, or the gateway's stream broke mid-answer: end
      // what is still open rather than compounding the error.
    }
  }
  if (!response.writableEnded) response.end();
}

// The routine API's error envelope is the one Anthropic's product surface uses:
// a top-level `type` and a typed error object. The renderer's own trigger
// client reads the same fields (`reason`, `subReason`, `error.type`), so one
// shape serves the public fire endpoint and the in-app routines pages.
function sendRoutineJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendRoutineError(response, error) {
  const status = Number(error?.statusCode) || (error instanceof SyntaxError ? 400 : 500);
  const type = error?.type || (status === 400 ? "invalid_request_error"
    : status === 401 ? "authentication_error"
      : status === 404 ? "not_found_error"
        : status === 429 ? "rate_limit_error"
          : status === 503 ? "overloaded_error"
            : "api_error");
  const message = error?.message || "unexpected error";
  const headers = {};
  if (error?.retryAfter !== undefined) headers["Retry-After"] = String(error.retryAfter);
  sendRoutineJson(response, status, { type: "error", error: { type, message } }, headers);
}

function requestBearerToken(headers = {}) {
  const raw = headers.authorization;
  if (typeof raw !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : "";
}

function routinePublicOrigin(request, url) {
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (request.socket?.encrypted ? "https" : "http");
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "")
    .split(",")[0].trim() || url.host;
  return host ? `${proto}://${host}` : "";
}

// The token console: a small same-origin page for the routines this instance
// serves. The native API card lives on the cloud routine detail, which this
// build's local scheduled-task list does not open; this page is the UI route
// for minting a token for any local task. It is served behind the same proxy
// session gate as `/api/routines`, and its fetches carry the session cookie.
async function serveRoutineTokensPage(response) {
  const body = await readFile(join(publicDir, "routine-tokens.html"));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

// A fire may carry images (a Claudesk extension), so its body is larger than
// the trigger metadata routes'. Twenty images at 5 MiB each, base64-expanded,
// fits comfortably; the service enforces the per-image limits.
const routineFireBodyLimit = 32 * 1024 * 1024;

// The Code surface names a session by its display generation (`session_…`);
// the store's wire id is `cse_…`. Its routes and the session list use the
// former, so a routine fire's id and link do too.
function codeSessionDisplayId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("cse_")
    ? `session_${sessionId.slice("cse_".length)}`
    : sessionId;
}

function routineSessionUrl(origin, kind, sessionId) {
  // The local Code surface's route is `/epitaxy/<session>`; `/code` is only
  // ion-dist's alias for it.
  const path = kind === "code"
    ? `/epitaxy/${encodeURIComponent(codeSessionDisplayId(sessionId))}`
    : `/cowork/${encodeURIComponent(sessionId)}`;
  return `${origin}${path}`;
}

async function handleRoutineApi(request, response, url) {
  const method = String(request.method || "GET").toUpperCase();
  const pathname = url.pathname;

  // The login shell serves the sign-in page and nothing else; a routine fire is
  // still an API call that starts a session, so it is refused like the rest.
  if (loginShellEnabled) {
    sendRoutineJson(response, 403, {
      type: "error",
      error: { type: "permission_error", message: "not signed in" },
    });
    return;
  }

  // The routines UI is this account's own data, so it follows the bridge's
  // session gate. The public fire leg verifies its own per-routine bearer token
  // below and stays reachable without a browser session.
  const routineFire = method === "POST"
    && /^\/v1\/claude_code\/routines\/[^/]+\/fire\/?$/.test(pathname);
  if (!routineFire) {
    const authorization = await authorizeApiRequest(request)
      .catch(() => ({ ok: false, status: 401, error: "not signed in" }));
    if (!authorization.ok) {
      sendRoutineJson(response, authorization.status || 401, {
        type: "error",
        error: {
          type: "permission_error",
          message: authorization.error || "not signed in",
        },
      });
      return;
    }
  }

  try {
    const fire = /^\/v1\/claude_code\/routines\/([^/]+)\/fire\/?$/.exec(pathname);
    if (fire) {
      if (method !== "POST") {
        throw new RoutineError(405, "invalid_request_error", "method not allowed");
      }
      if (request.headers["anthropic-version"] !== "2023-06-01") {
        throw new RoutineError(400, "invalid_request_error",
          "anthropic-version: 2023-06-01 is required");
      }
      const presented = requestBearerToken(request.headers);
      if (!presented) {
        throw new RoutineError(401, "authentication_error",
          "a per-routine bearer token is required");
      }
      const verified = await routines.verifyToken(presented);
      const routineId = decodeURIComponent(fire[1]);
      if (!verified || verified.routineId !== routineId) {
        throw new RoutineError(401, "authentication_error",
          "the bearer token is not valid for this routine");
      }
      const body = await readJson(request, routineFireBodyLimit).catch((error) => {
        if (error instanceof SyntaxError) {
          throw new RoutineError(400, "invalid_request_error", "the request body is not valid JSON");
        }
        throw error;
      });
      if (body?.text !== undefined && typeof body.text !== "string") {
        throw new RoutineError(400, "invalid_request_error", "text must be a string");
      }
      // `connectors` is the Claudesk extension that scopes MCP servers to this
      // fire (see docs/routines.md); `mcp_servers` is accepted as its alias,
      // the spelling the session create config uses.
      const fired = await routines.fireRoutine(routineId, {
        text: body?.text,
        images: body?.images,
        connectors: body?.connectors ?? body?.mcp_servers,
      });
      const origin = routinePublicOrigin(request, url);
      sendRoutineJson(response, 200, {
        type: "routine_fire",
        claude_code_session_id: fired.kind === "code"
          ? codeSessionDisplayId(fired.sessionId) : fired.sessionId,
        claude_code_session_url: routineSessionUrl(origin, fired.kind, fired.sessionId),
      });
      return;
    }

    // The organization trigger list the routines sidebar asks for beside the
    // account's own. Organisations are not a thing this deployment serves, so
    // the honest answer is an empty page (not a 404, which errors the surface).
    if (/^\/v1\/code\/organization\/triggers\/?$/.test(pathname) && method === "GET") {
      sendRoutineJson(response, 200, { data: [], next_cursor: null, has_more: false });
      return;
    }
    // The routines pages ask for the account's agents beside the routine list.
    // This deployment has none; an empty page keeps the selector quiet.
    if (/^\/v1\/code\/agents\/?$/.test(pathname) && method === "GET") {
      sendRoutineJson(response, 200, { data: [], next_cursor: null, has_more: false });
      return;
    }

    if (pathname === "/v1/code/triggers" || pathname === "/v1/code/triggers/") {
      if (method === "GET") {
        sendRoutineJson(response, 200, await routines.listTriggers());
        return;
      }
      if (method === "POST") {
        const body = await readJson(request, 1024 * 1024);
        sendRoutineJson(response, 201, await routines.createTrigger(body));
        return;
      }
      throw new RoutineError(405, "invalid_request_error", "method not allowed");
    }

    const triggerPath = /^\/v1\/code\/triggers\/([^/]+)\/?(.*)$/.exec(pathname);
    if (triggerPath) {
      const routineId = decodeURIComponent(triggerPath[1]);
      const rest = triggerPath[2].replace(/\/+$/, "");
      if (rest === "run" && method === "POST") {
        const body = await readJson(request, routineFireBodyLimit).catch(() => ({}));
        sendRoutineJson(response, 200,
          await routines.runTrigger(routineId, body?.text, body?.images,
            body?.connectors ?? body?.mcp_servers));
        return;
      }
      if (rest === "runs" && method === "GET") {
        sendRoutineJson(response, 200, await routines.listRuns(routineId));
        return;
      }
      // The routine detail's Stop on a running run.
      const runCancel = /^runs\/([^/]+)\/cancel$/.exec(rest);
      if (runCancel) {
        if (method !== "POST") {
          throw new RoutineError(405, "invalid_request_error", "method not allowed");
        }
        sendRoutineJson(response, 200,
          await routines.cancelRun(routineId, decodeURIComponent(runCancel[1])));
        return;
      }
      if (rest === "api-token") {
        if (method === "POST") {
          sendRoutineJson(response, 200,
            await routines.mintToken(routineId, { cookie: request.headers.cookie }));
          return;
        }
        if (method === "DELETE") {
          sendRoutineJson(response, 200,
            await routines.revokeToken(routineId, { cookie: request.headers.cookie }));
          return;
        }
      }
      if (!rest) {
        if (method === "GET") {
          sendRoutineJson(response, 200, await routines.getTrigger(routineId));
          return;
        }
        if (method === "POST" || method === "PATCH") {
          const body = await readJson(request, 1024 * 1024);
          sendRoutineJson(response, 200, await routines.updateTrigger(routineId, body));
          return;
        }
        if (method === "DELETE") {
          sendRoutineJson(response, 200, await routines.deleteTrigger(routineId));
          return;
        }
      }
    }

    throw new RoutineError(404, "not_found_error", "not found");
  } catch (error) {
    sendRoutineError(response, error);
  }
}

/**
 * The authenticated token administration route. It sits behind the deployment's
 * proxy session gate like every other `/api/` leg, so the caller is the
 * instance's own signed-in account; the token is scoped to one routine and its
 * hash is all that is stored.
 */
async function handleRoutineAdminApi(request, response, url) {
  const method = String(request.method || "GET").toUpperCase();
  const pathname = url.pathname;
  try {
    if (pathname === "/api/routines" || pathname === "/api/routines/") {
      if (method !== "GET") throw new RoutineError(405, "invalid_request_error", "method not allowed");
      sendJson(response, 200, { ok: true, value: (await routines.listTriggers()).data });
      return;
    }
    const tokenPath = /^\/api\/routines\/([^/]+)\/token\/?$/.exec(pathname);
    if (tokenPath) {
      const routineId = decodeURIComponent(tokenPath[1]);
      const cookie = request.headers.cookie;
      if (method === "POST") {
        sendJson(response, 200, {
          ok: true,
          value: await routines.mintToken(routineId, { cookie }),
        });
        return;
      }
      if (method === "DELETE") {
        sendJson(response, 200, {
          ok: true,
          value: await routines.revokeToken(routineId, { cookie }),
        });
        return;
      }
    }
    throw new RoutineError(404, "not_found_error", "not found");
  } catch (error) {
    if (error instanceof RoutineError) {
      sendJson(response, error.statusCode, { ok: false, error: error.message });
      return;
    }
    sendJson(response, 500, { ok: false, error: error?.message || "unexpected error" });
  }
}

// A placed session waits for the runner inside the account's Cowork VM, and
// that runner lives only while the VM does — the VM idle-stops on its own, and
// a Code session is not otherwise a thing that wakes it (the Cowork surfaces
// start it for themselves). So placement asks the Desktop to start it the same
// way the renderer's own computer flow does: `ClaudeVM.startVM` with no config
// — the main resolves the bundle and the wrapper pins the memory. Best-effort:
// a Desktop that refuses leaves the session waiting, exactly as before.
async function wakeRunnerVm() {
  try {
    const started = await desktop.invoke("ClaudeVM", "startVM", []);
    // The IPC reports a refused start as `{success:false, error}` rather than
    // throwing (a VM mid-shutdown, a missing bundle, a platform check). Calling
    // that a wake left the caller, and its one-shot retry, believing a runner
    // was on the way.
    if (started && typeof started === "object" && started.success === false) {
      console.warn("[code-runners] the Desktop could not start the Cowork VM: "
        + (started.error || "startup failed"));
      return false;
    }
    console.log("[code-runners] asked the Desktop to start the Cowork VM for the placed session");
    return true;
  } catch (error) {
    console.warn(`[code-runners] could not start the Cowork VM: ${error.message}`);
    return false;
  }
}

async function handleCodeRunnerApi(request, response, url) {
  const method = String(request.method || "GET").toUpperCase();
  const pathname = url.pathname;
  const headers = request.headers;
  // Browser/admin legs are this account's API and follow the bridge's session
  // gate. The runner's own legs carry a pool/runner/session secret and verify it
  // inside the handler; leave those to that check. The session event legs are
  // shared — the browser reads them with a cookie, the guest reads and streams
  // them with the session token — so a runner credential there is also a pass.
  const runnerLeg = pathname.startsWith("/v1/code/runners/self-hosted/runners/")
    || pathname.startsWith("/v1/code/runners/self-hosted/spawn-hints/")
    || pathname.startsWith("/v1/code/runners/self-hosted/requests/")
    || pathname.startsWith("/v1/code/runners/self-hosted/sessions/")
    || pathname === "/v1/code/auth/refresh";
  const sessionLeg = /^\/v1\/code\/sessions(?:\/|$)/.test(pathname);
  const runnerCredential = sessionLeg
    && await codeRunners.acceptsRunnerCredential({ headers }).catch(() => false);
  if (!runnerLeg && !runnerCredential) {
    const authorization = await authorizeApiRequest(request)
      .catch(() => ({ ok: false, status: 401, error: "not signed in" }));
    if (!authorization.ok) {
      sendJson(response, authorization.status || 401, {
        ok: false,
        error: authorization.error || "not signed in",
      });
      return;
    }
  }
  // The runner's streaming leg must be read as it arrives, not buffered like a
  // JSON body: one chunked request carries the whole turn's events.
  const eventStream = pathname.match(/^\/v1\/code\/sessions\/([^/]+)\/events\/stream$/);
  if (eventStream && method === "POST") {
    const result = await codeRunners.appendEventStream({
      sessionId: decodeURIComponent(eventStream[1]),
      headers,
      request,
    });
    if (result && result.unauthorized) {
      return sendJson(response, 401, { error: "unknown session credential" });
    }
    if (result === null) throw new ApiError(404, "session not found");
    return sendJson(response, 200, result);
  }
  const body = method === "GET" || method === "DELETE" ? {} : await readJson(request);

  // Anything the secret does not name is refused here rather than served empty,
  // so a mis-pointed runner is visible in its own logs.
  const answer = (result, ok = 200) => {
    // A held poll whose guest went away is answered into a closed socket; that
    // is expected (see pollSpawnHints), not an error to write through.
    if (response.destroyed || response.writableEnded) return;
    if (result && result.unauthorized) return sendJson(response, 401, { error: "unknown pool secret" });
    if (result === null) throw new ApiError(404, "not found");
    return sendJson(response, ok, result);
  };
  // A session leg for an id the store does not know is worth saying out loud:
  // the renderer turns such a 404 into its "This session couldn't be found"
  // page, and the request carried whatever spelling of the id the client had.
  const missingSession = () => {
    console.warn(`[code-runners] no such session: ${method} ${pathname}`);
    throw new ApiError(404, "session not found");
  };

  // The environment list the Code surface reads. A tenant's list is its pools
  // and nothing else — the local (this-computer) place is deliberately never
  // advertised, so the renderer cannot offer one to place a session on. That is
  // the guarantee stated where the choice is actually made, alongside the IPC
  // one in `codeActionsEnabled`.
  // Two environments legs, because the product has two: the org's provider list
  // (`…/environment_providers/private/organizations/{org}/environments`, the
  // Cloud-environments page) and the workspace-scoped one the *new session*
  // sheet reads its places from (`/v1/environments`, `{environments: […]}`
  // beside the pools query). Answering only the first is what left the sheet
  // saying it had no local sessions and nothing else to offer.
  const environmentsMatch = pathname.match(
    /^\/v1\/environment_providers\/private\/organizations\/[0-9a-f-]{36}\/environments(?:\/([^/]+))?\/?$/i,
  );
  const workspaceEnvironmentsMatch = pathname.match(/^\/v1\/environments(?:\/([^/]+))?\/?$/);
  const environmentId = environmentsMatch?.[1] ?? workspaceEnvironmentsMatch?.[1];
  if ((environmentsMatch || workspaceEnvironmentsMatch) && method === "GET") {
    if (environmentId) {
      const environment = await codeRunners.environment(decodeURIComponent(environmentId));
      if (!environment) throw new ApiError(404, "environment not found");
      return sendJson(response, 200, environment);
    }
    return sendJson(response, 200, await codeRunners.environmentList());
  }

  // The org's environment-provider capabilities: what a session host can do —
  // repositories, file transports, push/PRs, web fetch, stores. The composer
  // reads it wherever a Code session can be placed, and its reader parses
  // strictly: `version` and `repositories` are required and `absent`/
  // `unreadable` are read unconditionally, while the fields left out are the
  // ones this deployment makes no claim about (the reader treats absence as
  // unknown, not as "no"). What is claimed here is what is true: no GitHub
  // wiring, so no repositories; the session's files do move both ways; the
  // runner hosts clone and push nothing by themselves.
  const capabilitiesPath =
    /^\/v1\/environment_providers\/private\/organizations\/[0-9a-f-]{36}\/capabilities$/i;
  if (capabilitiesPath.test(pathname) && method === "GET") {
    return sendJson(response, 200, {
      version: 1,
      repositories: [],
      mcp_servers: [],
      plugin_marketplaces: [],
      session_files: { upload: true, download: true },
      vcs: { push: false, create_pr: false },
      // The modes a session may start in. The renderer builds the start
      // intent's `permissionMode` only from this list; leaving it out made
      // every non-default pick vanish before the create body was built, so a
      // session always started in "default" (shown as Accept edits). The
      // session host is this deployment's own VM, where bypass is offered.
      permission_modes: {
        available: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
      },
      device_tools_enabled: false,
      device_tools: { file_tools_bound_to_connected_folders: false },
      // The routine capability the renderer's Code frame reads before it will
      // show the Routines/Scheduled entry and mount `/code/routines`. With the
      // self-hosted-session flag true, the renderer takes its `session_host`
      // branch and takes `routines.enabled` from exactly this document; absent,
      // the entry is filtered out of the nav however the bridge grants gates.
      routines: {
        enabled: true,
        delete_removes_runs: true,
        persist_session: false,
        reviewed_save: false,
      },
      absent: [],
      unreadable: [],
    });
  }

  // Placing a session. A tenant has no local executor, so the only environment
  // this answers for is one of its own pools; anything else is refused rather
  // than quietly run here.
  if (pathname === "/v1/code/sessions" && method === "GET") {
    return sendJson(response, 200, await codeRunners.listSessions({ searchParams: url.searchParams }));
  }
  if (pathname === "/v1/code/sessions" && method === "POST") {
    // The start options a tenant's guest runner honours. `cwd` names a folder
    // the guest maps into its shared root, so it must be a real directory the
    // account can already browse; the branch and worktree flag are the runner's
    // to act on, but a malformed value is refused here rather than stored.
    if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      const { cwd, source_branch: sourceBranch, use_worktree: useWorktree } = body.config;
      if (cwd !== undefined) {
        if (typeof cwd !== "string" || !cwd) throw new ApiError(400, "session folder is invalid");
        try {
          await resolveContainedRealPath(workspaceRoot, cwd);
        } catch {
          throw new ApiError(400, "session folder is outside the workspace");
        }
      }
      if (sourceBranch !== undefined && (typeof sourceBranch !== "string"
        || !sourceBranch || sourceBranch.length > 255
        || /[\u0000-\u001f\u007f]/.test(sourceBranch))) {
        throw new ApiError(400, "session branch is invalid");
      }
      if (useWorktree !== undefined && typeof useWorktree !== "boolean") {
        throw new ApiError(400, "session worktree flag is invalid");
      }
      // The composer's spawn permission mode is the failsafe "default" until
      // its stored picks settle; fill in the person's actual pick (or the mode
      // the last session ran) rather than creating a Manual session behind a
      // Bypass picker. See storedDefaultPermissionMode.
      if (body.config.permission_mode === undefined
        || body.config.permission_mode === "default") {
        const stored = await storedDefaultPermissionMode().catch(() => null);
        if (stored) body.config.permission_mode = stored;
      }
    }
    const created = await codeRunners.createSession({ body });
    if (created?.unsupported) {
      throw new ApiError(400, "only a self-hosted environment of this instance can run a session");
    }
    void wakeRunnerVm();
    return sendJson(response, 201, created);
  }
  // The session list's liveness probe. Its reader posts the sessions it is
  // showing and reads back per-session heartbeats; a deployment whose runners
  // are the session's own workers has nothing to probe, and `checks_enabled:
  // false` is the protocol's own way to say so — the client then stops asking
  // rather than treating silence as a broken session.
  if (pathname === "/v1/code/sessions/heartbeat_check" && method === "POST") {
    return sendJson(response, 200, { results: [], checks_enabled: false });
  }
  // The session list's own stream (`…/sessions/watch?…`). Its reader treats a
  // 400 or 404 as fatal for the whole surface and requires a
  // `text/event-stream` body, so it is held open and quiet: the list already
  // answers over HTTP, and a stream with no frames is a valid stream.
  if (pathname === "/v1/code/sessions/watch" && method === "GET") {
    return sendSessionsWatchStream(request, response);
  }
  // A session's events: the history (paged), the append the renderer and the
  // runner both use, and the SSE stream the Desktop main process reads. Replayed
  // as `client_event` frames and resumed with `from_sequence_num`, which is that
  // reader's own contract (see scripts/lib/code-wire-contract.mjs).
  //
  // Answered under both generations of the path. The same client posts its
  // first message under `/v1/code/sessions/{id}/events` only while its
  // `ccr_v2_send_events_web` GrowthBook gate reads true; when it reads false —
  // which is what the Desktop build's hardcoded feature table carries — the
  // send goes to the original `/v1/sessions/{id}/events` instead. Before that
  // leg was answered, the POST landed on the app's HTML catch-all: a **200 of
  // HTML**, which the client's API layer classifies as an edge/upstream
  // failure — the composer's "Service temporarily unreachable".
  const eventsPath = pathname.match(/^\/v1\/(?:code\/sessions|sessions)\/([^/]+)\/events(\/stream)?$/);
  if (eventsPath) {
    const sessionId = decodeURIComponent(eventsPath[1]);
    if (eventsPath[2]) {
      if (method !== "GET") throw new ApiError(405, "method not allowed");
      return sendCodeEventStream(request, response, sessionId, url);
    }
    if (method === "GET") {
      const document = await codeRunners.listEvents({ sessionId, searchParams: url.searchParams });
      if (!document) missingSession();
      return sendJson(response, 200, document);
    }
    if (method === "POST") {
      const appended = await codeRunners.appendEvents({ sessionId, body, headers: request.headers });
      if (!appended) missingSession();
      return sendJson(response, 200, appended);
    }
    throw new ApiError(405, "method not allowed");
  }

  // Stop. The Code surface posts an `interrupt` control request through the
  // events leg above; these two REST spellings serve the callers that stop a
  // session directly (the mobile facade's shape, and routine run-cancel). A
  // stop is idempotent — an already-finished turn is still a 200 — because the
  // button is pressed exactly when the client believes a turn is in flight.
  const interruptSessionPath = pathname.match(
    /^\/v1\/code\/sessions\/([^/]+)\/(?:interrupt|stop)$/,
  );
  if (interruptSessionPath) {
    if (method !== "POST") throw new ApiError(405, "method not allowed");
    const sessionId = decodeURIComponent(interruptSessionPath[1]);
    const interrupted = await codeRunners.interruptSession({ sessionId });
    if (!interrupted) missingSession();
    return sendJson(response, 200, {});
  }

  // The session's edit legs: rename/tags/metadata arrive as one PUT, then the
  // per-session actions the page has buttons for. Each answers the app's
  // `{session}` document; an unknown session is a 404 (the archive reader
  // treats that as "already archived").
  const sessionSub = pathname.match(/^\/v1\/code\/sessions\/([^/]+)\/(archive|mark_read|mcp-servers)$/);
  if (sessionSub) {
    const sessionId = decodeURIComponent(sessionSub[1]);
    if (sessionSub[2] === "archive" && method === "POST") {
      return answer(await codeRunners.archiveSession({ sessionId }));
    }
    if (sessionSub[2] === "mark_read" && method === "POST") {
      return answer(await codeRunners.markSessionRead({ sessionId }));
    }
    if (sessionSub[2] === "mcp-servers" && method === "PUT") {
      return answer(await codeRunners.setSessionMcpServers({ sessionId, body }));
    }
    throw new ApiError(405, "method not allowed");
  }

  // The legs the product's own runner uses to start and work a session — see
  // sessionRemote / registerWorker in code-runners.mjs. They authenticate with
  // the runner_token the register leg handed out, or the pool secret.
  const runnerSessionLeg = pathname.match(
    /^\/v1\/code\/sessions\/([^/]+)\/(remote|worker|worker\/register|worker\/events|worker\/heartbeat|worker\/diagnostics)$/,
  );
  if (runnerSessionLeg) {
    const sessionId = decodeURIComponent(runnerSessionLeg[1]);
    const leg = runnerSessionLeg[2];
    if (leg === "worker" && method === "PUT") {
      return answer(await codeRunners.updateSessionWorker({ headers, sessionId, body }));
    }
    if (leg === "worker/heartbeat" && method === "POST") {
      return answer(await codeRunners.workerHeartbeat({ headers, sessionId }));
    }
    if (leg === "worker/diagnostics" && method === "POST") {
      return answer(await codeRunners.forwardWorkerDiagnostics({ headers, sessionId, body }));
    }
    if (leg === "remote" && method === "GET") {
      // The child's API origin, as the runner itself reached us — the runner's
      // setup parses this, not the host it configured.
      const baseUrl = `${request.headers["x-forwarded-proto"] || "http"}://${
        request.headers.host || "localhost"}`;
      return answer(await codeRunners.sessionRemote({ headers, sessionId, baseUrl }));
    }
    if (leg === "worker/register" && method === "POST") {
      return answer(await codeRunners.registerWorker({ headers, sessionId }));
    }
    if (leg === "worker/events" && method === "POST") {
      return answer(await codeRunners.appendWorkerEvents({ headers, sessionId, body }));
    }
    throw new ApiError(405, "method not allowed");
  }

  // The runner's token rotation — its own path family, outside the sessions.
  if (pathname === "/v1/code/auth/refresh" && method === "POST") {
    return answer(await codeRunners.refreshRunnerToken({ headers }));
  }

  const sessionDetail = pathname.match(/^\/v1\/code\/sessions\/([^/]+)$/);
  if (sessionDetail) {
    const sessionId = decodeURIComponent(sessionDetail[1]);
    if (method === "GET") {
      const document = await codeRunners.session(sessionId);
      if (!document) missingSession();
      return sendJson(response, 200, document);
    }
    if (method === "PUT") {
      return answer(await codeRunners.updateSession({ sessionId, body }));
    }
    if (method === "DELETE") {
      return answer(await codeRunners.deleteSession({ sessionId }));
    }
    throw new ApiError(405, "method not allowed");
  }

  // The runner's session-scoped calls: exchange an assignment for the session
  // token, then report on the run. Every one is authenticated by that token (or
  // by the pool secret of the pool the session belongs to).
  // The runner's own poll (PollWork) — the shipped CLI's poll, scoped to the
  // runner rather than the pool. See pollWork in code-runners.mjs.
  const runnerPollMatch = pathname.match(
    /^\/v1\/code\/runners\/self-hosted\/runners\/([^/]+)\/poll$/,
  );
  if (runnerPollMatch && method === "POST") {
    return answer(await codeRunners.pollWork({ headers, body }));
  }

  const runnerSessionsBase = "/v1/code/runners/self-hosted/sessions/";
  if (method === "POST" && pathname.startsWith(runnerSessionsBase)) {
    const rest = pathname.slice(runnerSessionsBase.length);
    const slash = rest.indexOf("/");
    const sessionId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const sub = slash === -1 ? "" : rest.slice(slash + 1);
    if (!sessionId) throw new ApiError(404, "not found");
    const call = { headers, sessionId, body };
    if (sub === "token") return answer(await codeRunners.issueSessionToken(call));
    if (sub === "claim") return answer(await codeRunners.recordClaim(call));
    if (sub === "report-failure") return answer(await codeRunners.reportSessionFailure(call));
    if (sub === "release") return answer(await codeRunners.releaseSession(call));
    if (sub === "retry-spawn") return answer(await codeRunners.retrySpawn(call));
  }

  switch (`${method} ${pathname}`) {
    case "POST /v1/code/runners/self-hosted/runners/register":
      return answer(await codeRunners.registerRunner({ headers, body }));
    case "POST /v1/code/runners/self-hosted/deregister":
      return answer(await codeRunners.deregisterRunner({ headers, body }));
    case "POST /v1/code/runners/self-hosted/spawn-hints/poll":
      // The request itself rides along: a held poll whose guest went away
      // must not claim the session (or the UI request) it was woken for. The
      // body carries the sessions that runner still holds, which the reaper
      // reconciles an `active` session against.
      return answer(await codeRunners.pollSpawnHints({ headers, request, body }));
    case "POST /v1/code/runners/self-hosted/spawn-hints/nack":
      return answer(await codeRunners.nackSpawnHint({ headers, body }));
    case "POST /v1/code/runners/self-hosted/requests/result":
      return answer(await codeRunners.respondRunnerRequest({ headers, body }));
    case `GET ${selfHostedPoolsBase.slice(0, -1)}`:
      return answer(await codeRunners.listPools());
    case `POST ${selfHostedPoolsBase.slice(0, -1)}`:
      return answer(await codeRunners.createPool({ body }));
    default:
      break;
  }

  if (pathname.startsWith(selfHostedPoolsBase)) {
    const rest = pathname.slice(selfHostedPoolsBase.length);
    const [poolId, sub] = rest.split("/");
    if (!poolId || rest.includes("//")) throw new ApiError(404, "not found");
    if (sub === undefined) {
      if (method === "GET") return answer(await codeRunners.getPool({ poolId }));
      if (method === "PATCH") return answer(await codeRunners.updatePool({ poolId, body }));
      if (method === "DELETE") return answer(await codeRunners.removePool({ poolId }));
    } else if (sub === "secrets" && method === "GET") {
      return answer(await codeRunners.poolSecrets({ poolId }));
    } else if (sub === "sessions" && method === "GET") {
      return answer(await codeRunners.poolSessions({ poolId, searchParams: url.searchParams }));
    }
  }
  // Which legs the Code surface asks for and this bridge does not answer. There
  // is no way to know from the surface alone — it reports a state ("local
  // sessions aren't available"), not the request behind it — and the set is not
  // documented anywhere, so a miss is logged where an operator can read it.
  console.warn(`[code-runners] unhandled Code request: ${method} ${pathname}`);
  throw new ApiError(404, "not found");
}

// The admin dashboard's instance actions. authd calls these over the
// deployment network with `CLAUDESK_INTERNAL_SECRET`; the reverse proxy never
// forwards `/internal/*`, and an unset secret makes the family 404 rather than
// leaving VM control open to any container on the shared network.
async function handleInternalAction(request, response, url) {
  const supplied = request.headers["x-claudesk-internal-secret"];
  if (!internalSecret || supplied !== internalSecret) {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  if (loginShellEnabled) {
    sendJson(response, 403, { ok: false, error: "not signed in" });
    return;
  }
  const method = String(request.method || "GET").toUpperCase();
  const action = url.pathname === "/internal/vm/restart"
    ? { method: "POST", path: "/vm/restart" }
    : url.pathname === "/internal/vm/status"
      ? { method: "GET", path: "/vm/status" }
      : null;
  if (!action || method !== action.method) {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  const upstream = await fetch(`${coworkInternalUrl}${action.path}`, {
    method: action.method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120000),
  });
  const body = await upstream.json().catch(() => null);
  if (!upstream.ok || body?.ok === false) {
    throw new ApiError(
      upstream.status >= 400 ? upstream.status : 502,
      body?.error || `the Desktop wrapper answered ${upstream.status}`,
    );
  }
  sendJson(response, 200, { ok: true, value: body?.value ?? body });
}

// A session's event stream, in the shape the Desktop's own SSE readers expect:
// frames named `client_event` whose data is the envelope, the history replayed
// first, and `Last-Event-ID` / `from_sequence_num` resuming from a sequence the
// reader already has. Every frame carries `id:` — the reader parses it into the
// sequence it resumes from, so a frame without one cannot advance the reader's
// cursor. `session_update` frames carry the session's connection state (the
// page's "Connecting…" clears on them). The tail polls the store rather than
// holding a subscription, so an event written by another process — the runner
// — is seen even though this is one bridge process.
async function sendCodeEventStream(request, response, sessionId, url) {
  // The Desktop's own transport reconnects with the header; the web subscriber
  // resumes with the query. Either names the sequence to continue after.
  const headerFrom = Number(request.headers["last-event-id"] ?? 0) || 0;
  const fromSequence = Number(url.searchParams.get("from_sequence_num") ?? 0) || headerFrom || 0;
  // An unknown session is not a 404: the app opens this stream to receive the
  // turn it is about to send, and 404ing it is the "Connecting" loop (the
  // phone's facade captured the same rule) — open empty, and the tail starts
  // delivering the moment the session exists.
  const backlog = (await codeRunners.eventsAfter(sessionId, fromSequence)) ?? [];
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // Buffering proxies in front of the bridge (the deployment's reverse proxy)
    // must pass frames straight through or the stream looks dead.
    "X-Accel-Buffering": "no",
  });
  let sequence = fromSequence;
  let connectionStatus;
  let frames = 0;
  let deliveryUpdates = 0;
  const openedAt = Date.now();
  console.log(`[cowork-bridge] session ${sessionId}: events stream opened `
    + `(from_sequence_num=${fromSequence}, last-event-id=${request.headers["last-event-id"] ?? "none"}, `
    + `backlog=${backlog.length})`);
  const write = (event) => {
    const id = event.sequence_num != null ? `id: ${event.sequence_num}\n` : "";
    const accepted = response.write(
      `${id}event: client_event\ndata: ${JSON.stringify(event)}\n\n`);
    frames += 1;
    sequence = Math.max(sequence, Number(event.sequence_num) || 0);
    return accepted;
  };
  // "This client event was processed" — a control frame (no id/sequence) that
  // names the event. The page holds its own unacknowledged echo out of the
  // transcript and shows "Sending…" until one names it (see issueSessionToken).
  const flushDeliveries = async () => {
    const updates = await codeRunners.deliveryUpdates({ sessionId, after: deliveryUpdates });
    for (const update of updates ?? []) {
      response.write(`event: delivery_update\ndata: ${JSON.stringify(update)}\n\n`);
      deliveryUpdates += 1;
    }
  };
  const writeConnection = (status) => {
    if (!status || status === connectionStatus) return;
    connectionStatus = status;
    response.write(`event: session_update\ndata: ${JSON.stringify({ connection_status: status })}\n\n`);
  };
  // A session that does not exist yet still opens as connected (the phone's
  // facade settled the same way): the first message is what creates it.
  writeConnection((await codeRunners.connectionState({ sessionId })) ?? "connected");
  // Subscribe before replaying the backlog and buffer until it is done: an
  // event appended between the history read and the tail would otherwise fall
  // through the gap. The replay advances `sequence`, which dedupes the buffer.
  let replaying = true;
  const buffered = [];
  const unsubscribe = codeRunners.subscribeEvents(sessionId, (event) => {
    if (replaying) {
      buffered.push(event);
      return;
    }
    const numeric = Number(event.sequence_num) || 0;
    if (numeric && numeric <= sequence) return;
    write(event);
  });
  for (const event of backlog) {
    // A long transcript can outpace the socket; wait for the client rather
    // than buffering the whole replay in the bridge's heap.
    if (!write(event)) {
      await new Promise((resolve) => {
        response.once("drain", resolve);
        response.once("close", resolve);
      });
    }
  }
  replaying = false;
  for (const event of buffered) {
    if ((Number(event.sequence_num) || 0) > sequence) write(event);
  }
  await flushDeliveries();
  // A safety net, not the live path: appended events are pushed by the
  // emitter above. This catches anything written before the subscription (or
  // by a writer that bypassed the backend).
  const timer = setInterval(async () => {
    try {
      const next = await codeRunners.eventsAfter(sessionId, sequence);
      if (next) {
        for (const event of next) write(event);
      }
      await flushDeliveries();
      writeConnection(await codeRunners.connectionState({ sessionId }));
    } catch {
      // Keep the stream up; the next tick retries and the reader resumes from
      // the sequence it already holds if the connection does drop.
    }
  }, 1000);
  // The phone's facade keeps a 15-second comment cadence on this stream, and
  // it matters here too: a stream that goes silent through a thinking pause is
  // exactly what an idle timeout in the chain (the Desktop's relay, the
  // reverse proxy, the fetch client's liveness check) kills — which reads as
  // "connected but nothing ever arrives until a reload".
  const keepalive = setInterval(() => {
    if (!response.writableEnded) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);
  const close = () => {
    unsubscribe();
    clearInterval(timer);
    clearInterval(keepalive);
    response.end();
    console.log(`[cowork-bridge] session ${sessionId}: events stream closed after `
      + `${Math.round((Date.now() - openedAt) / 1000)}s, ${frames} frames`);
  };
  request.on("close", close);
  response.on("error", close);
}

// GET /v1/code/sessions/watch — the session list's own SSE stream. The reader
// refuses anything without a `text/event-stream` body and treats 400/404 as
// fatal for the whole surface (`SessionsWatchFatalError`; it will not retry),
// so the bridge holds the stream open and quiet rather than 404ing it: the
// list it would stream is the one `GET /v1/code/sessions` already answers, and
// a stream with no frames is a valid stream. Keepalives keep intermediaries
// from timing it out.
function sendSessionsWatchStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const timer = setInterval(() => {
    try {
      response.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      // The close handler tears the timer down; a failed write just means the
      // reader went away between ticks.
    }
  }, 20000);
  const close = () => {
    clearInterval(timer);
    response.end();
  };
  request.on("close", close);
  response.on("error", close);
}

// The title (and branch) the app asks its backend for when something is named:
// the Code composer asks before a session's first send, and chapter renaming
// asks again later. The Desktop main answers these in-process (a custom-3p
// stub that runs one small model request); a browser page fetches its own
// origin, so the bridge is the only place that can answer them for the web
// shell — and it does that by relaying the request to the same stub over the
// internal bridge (see desktopGeneratedTitle). The first-meaningful-line title
// below is only the fallback for a Desktop that cannot answer: returning it as
// the primary answer would make every new chat look untitled, because the app
// shows the same first line as the title's placeholder until the generated one
// lands.
function suggestedTitle(message) {
  const first = String(message ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const text = first
    .replace(/^[#>*\-•\s]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary >= 30 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function suggestedBranch(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

// Ask the Desktop main for the generated title (and branch) exactly as the app
// would in-process: the same `/dust/...` stub, whose handler runs one small
// model request. A browser page fetches its own origin and never passes
// through that handler, so without this relay the web shell would only ever
// get the derived first line — the same text the app uses as its placeholder,
// which is why both Chat and Code sessions stopped looking titled when the
// deployment moved to this shape. The relay goes over the internal bridge
// (`/protocol`), the same channel `titleCodeSessions` uses for its generator.
//
// The request must carry a model: with none, Desktop resolves its own small
// title model, which this stack's gateway refuses (HTTP 403), so no title is
// produced. The composer normally sends the model it is about to use;
// CLAUDE_TITLE_MODEL covers the requests that do not, and a Desktop-side
// failure of any kind returns null so the caller can fall back.
async function desktopGeneratedTitle(pathname, body) {
  // The login shell has no account behind it and refuses the API; never spend
  // a model call on a request it would not have served anyway.
  if (loginShellEnabled) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = typeof body.first_session_message === "string"
    ? body.first_session_message.trim() : "";
  if (!message) return null;
  const payload = { first_session_message: message };
  if (typeof body.title_style === "string" && body.title_style) {
    payload.title_style = body.title_style;
  }
  if (typeof body.model === "string" && body.model.trim()) {
    payload.model = body.model.trim();
  } else if (titleModel) {
    payload.model = titleModel;
  }
  try {
    const result = await desktop.protocol({
      method: "POST",
      pathname,
      search: "",
      headers: { "content-type": "application/json", accept: "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
    });
    if ((result?.status || 0) >= 400) return null;
    const parsed = JSON.parse(
      Buffer.from(result?.bodyBase64 || "", "base64").toString("utf8"),
    );
    const title = typeof parsed?.title === "string"
      ? parsed.title.replace(/\s+/g, " ").trim() : "";
    if (!title) return null;
    return {
      title,
      branch: typeof parsed?.branch_name === "string" ? parsed.branch_name.trim() : "",
    };
  } catch {
    // Desktop not reachable yet, the stub refused, or the model call failed —
    // the derived title below is what the app would show before generation
    // lands, so the session still gets named rather than left blank.
    return null;
  }
}

async function handleDustApi(request, response, kind, pathname) {
  // The login shell refuses the whole API, and this bridge-answered corner is
  // no exception. It is answered before handleApi's own gate (a browser fetches
  // these paths from the shell itself), so the refusal is repeated here.
  if (loginShellEnabled) {
    sendJson(response, 403, { ok: false, error: "not signed in" });
    return;
  }
  // These routes reach this account's Desktop and spend its inference (the
  // title relay), and a peer container on the shared network can reach this
  // port without the proxy, so they follow the same session gate as handleApi.
  const authorization = await authorizeApiRequest(request)
    .catch(() => ({ ok: false, status: 401, error: "not signed in" }));
  if (!authorization.ok) {
    sendJson(response, authorization.status || 401, {
      ok: false,
      error: authorization.error || "not signed in",
    });
    return;
  }
  let body = {};
  try {
    body = await readJson(request);
  } catch {
    body = {};
  }
  if (kind === "command_display_names") {
    // The slash-command palette's display labels; the Desktop main stubs this
    // empty (the commands it would name are the runner's own), so the bridge
    // answers the same shape rather than 404 while the palette opens.
    sendJson(response, 200, { results: [] });
    return;
  }
  const generated = await desktopGeneratedTitle(pathname, body);
  const message = typeof body?.first_session_message === "string"
    ? body.first_session_message : "";
  const title = generated?.title || suggestedTitle(message);
  if (kind === "generate_session_title") {
    sendJson(response, 200, { title });
    return;
  }
  const branch = generated?.branch || suggestedBranch(title);
  sendJson(response, 200, { title, ...(branch ? { branch_name: branch } : {}) });
}

// The prepared-renderer manifest, reduced to what tells a stale instance from a
// missing feature at a glance. `/api/health` carries the whole manifest for a
// peer that needs it, but its patch records hold entire source splices — too
// much to read in a browser. These two booleans are the features most often
// reported missing after a deploy, so the answer is one line, and the release
// beside it says whether the instance is serving the generation that should
// carry them.
function rendererSummary(renderer) {
  if (!renderer || typeof renderer !== "object") return null;
  const ids = new Set((Array.isArray(renderer.patches) ? renderer.patches : [])
    .map((patch) => patch?.id).filter((id) => typeof id === "string"));
  return {
    basePath: renderer.basePath ?? null,
    desktopVersion: renderer.desktopVersion ?? null,
    patchRelease: renderer.patchRelease ?? null,
    patchCount: ids.size,
    // A tenant's routine form and the operator's own: model+effort picker,
    // cwd/permission state and the two rows — on both the unified form and the
    // Code surface's own routine page.
    routineStartOptions: ["routine-model-effort-picker", "routine-form-start-options",
      "routine-form-start-option-rows", "routine-epitaxy-start-options"]
      .every((id) => ids.has(id)),
    // The Code surface's bypass mode: the mode list and the availability
    // predicate.
    codeBypass: ["code-bypass-permission-list", "code-bypass-availability"]
      .every((id) => ids.has(id)),
  };
}

async function handleApi(request, response, url) {
  // The login shell refuses the entire API surface, with or without a session.
  // It exists to serve the sign-in page and nothing else, so there is no route
  // here that could reach the Desktop, a store or inference. The page reads
  // exactly one API answer — an error status on the bootstrap, which is how the
  // renderer concludes it is signed out and routes itself to its own /login —
  // and it sends credentials straight to authd, which the proxy routes there
  // rather than here. 403 rather than 401: the proxy rewrites a 401 into a
  // redirect to the login page, which would hand that fetch an HTML document
  // instead of an error status.
  if (loginShellEnabled) {
    // The container healthcheck probes this path, and a liveness answer is all
    // it needs — the real one reports the Desktop's surface list, which is
    // exactly what a public instance must not hand out. Everything else is
    // refused, including the routes this bridge synthesises itself.
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 403, { ok: false, error: "not signed in" });
    return;
  }
  // Every route below reads this account's Desktop, files or sessions. The
  // reverse proxy authenticates the browser, but a peer container on the shared
  // network reaches this port directly, so the session is checked here too.
  // Health stays reachable for liveness (the container healthcheck has no
  // session) but answers only `{ok:true}` without one.
  const healthRequest = request.method === "GET" && url.pathname === "/api/health";
  const authorization = await authorizeApiRequest(request)
    .catch(() => ({ ok: false, status: 401, error: "not signed in" }));
  if (!authorization.ok && !healthRequest) {
    sendJson(response, authorization.status || 401, {
      ok: false,
      error: authorization.error || "not signed in",
    });
    return;
  }
  // Routine token administration, behind the same session gate as the rest of
  // the account's own API.
  if (url.pathname === "/api/routines" || url.pathname.startsWith("/api/routines/")) {
    await handleRoutineAdminApi(request, response, url);
    return;
  }
  // The web-shell account avatar, when CLAUDE_REMOTE_ACCOUNT_AVATAR is a local
  // image path. Serves only the file resolved at startup; any `?v=` is ignored
  // (it is only a cache-buster), so this is not a path the caller can steer.
  if (request.method === "GET" && url.pathname === accountAvatarRoute) {
    if (!accountAvatarFile) {
      sendJson(response, 404, { ok: false, error: "no account avatar configured" });
      return;
    }
    let image;
    try {
      image = readFileSync(accountAvatarFile);
    } catch {
      sendJson(response, 500, { ok: false, error: "account avatar unreadable" });
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "public, max-age=3600",
      "Content-Length": image.length,
      "Content-Type": accountAvatarType,
      // An operator SVG is still an untrusted-active document if opened
      // directly; neutralize scripts and keep it inline-only.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(image);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/remote/folders") {
    const value = await listWorkspaceFolders(workspaceRoot, url.searchParams.get("path") || workspaceRoot);
    sendJson(response, 200, { ok: true, value });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/folders") {
    const body = await readJson(request);
    const value = await createWorkspaceFolder(workspaceRoot, body.path, body.name);
    sendJson(response, 200, { ok: true, value });
    return;
  }
  // The web Code composer's folder picker. A tenant's Code runs in its Cowork
  // VM, and the person asked for the *listing* to come from there too, so this
  // route never reads the container's filesystem: it hands the request to the
  // guest runner's poll and answers the runner's reply (`list_folders` /
  // `create_folder` in guest/runner.py). The paths crossing this route are host
  // paths — `/workspace/...` — because that is what the guest maps onto its
  // shared mount; the bridge still confines them to the workspace before
  // queueing.
  if (tenantCodeReadsEnabled && request.method === "GET"
    && url.pathname === "/api/remote/code-folders") {
    const requested = url.searchParams.get("path") || workspaceRoot;
    const path = await resolveContainedRealPath(workspaceRoot, requested).catch(() => {
      throw new ApiError(403, "code folders are confined to the workspace");
    });
    // Guest-only by design: the tenant container is privileged, so a Code
    // folder read must happen inside the VM. A cold VM answers 503 quickly
    // (the wake is bounded in code-runners.mjs) and the in-page picker retries
    // while the VM boots; the bridge never lists its own mount for Code.
    const value = await codeRunners.listRunnerFolders({ root: workspaceRoot, path })
      .catch((error) => {
        throw new ApiError(Number(error?.statusCode) || 503,
          error?.message || "the guest runner did not answer");
      });
    sendJson(response, 200, { ok: true, value });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/renderer-trace") {
    const body = await readJson(request);
    if (typeof body?.name === "string" && body.name.length <= 80) {
      rendererTraces.push({ at: new Date().toISOString(), name: body.name, data: body.data });
      while (rendererTraces.length > 60) rendererTraces.shift();
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/remote/renderer-trace") {
    sendJson(response, 200, { ok: true, value: rendererTraces });
    return;
  }
  if (tenantCodeReadsEnabled && request.method === "POST"
    && url.pathname === "/api/remote/code-folders") {
    const body = await readJson(request);
    const path = await resolveContainedRealPath(workspaceRoot, body.path || workspaceRoot)
      .catch(() => {
        throw new ApiError(403, "code folders are confined to the workspace");
      });
    if (!validFolderName(body.name)) throw new ApiError(400, "folder name is invalid");
    const value = await codeRunners.createRunnerFolder({
      root: workspaceRoot, path, name: body.name,
    }).catch((error) => {
      throw new ApiError(Number(error?.statusCode) || 503,
        error?.message || "the guest runner did not answer");
    });
    sendJson(response, 200, { ok: true, value });
    return;
  }
  // The draft defaults behind the preload's AppPreferences shim. The
  // renderer's own draft permission pick is not persisted anywhere by the
  // renderer (it lives in a per-opening in-memory store), so a new Code draft
  // fell back to "Accept edits" after every session. The last session's start
  // settings are the user's last real pick; the preload seeds them into
  // `cc-landing-draft-permission-mode` when the bucket has no pick of its own.
  if (tenantCodeReadsEnabled && request.method === "GET"
    && url.pathname === "/api/remote/code-defaults") {
    const value = await codeRunners.recentSessionConfig();
    sendJson(response, 200, { ok: true, value });
    return;
  }
  // The notification settings panel talks to claude.ai's server-side push
  // preferences (per-feature `enable_push`) and registers its push channel
  // there. This deployment has no such backend — the toggles would never stick
  // and an "enable" would fall through to a Firebase registration that cannot
  // succeed. Answer both locally so the settings are real: they persist in the
  // bridge state and gate which notifications are delivered. Never forwarded
  // upstream.
  if (notificationPreferencesPath.test(url.pathname)) {
    if (request.method === "GET") {
      sendOfficialDocument(response, notifications.preferencesDocument());
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJson(request);
      sendOfficialDocument(response, await notifications.applyPreferencesPatch(body));
      return;
    }
  }
  if (
    request.method === "POST"
    && notificationChannelsPath.test(url.pathname)
  ) {
    sendOfficialDocument(response, {
      channel_type: "FCM",
      client_platform: "web",
      status: "ACTIVE",
    });
    return;
  }

  // Connectors (remote MCP servers). The official bundle's Connectors surface
  // speaks claude.ai's connectors API — the list/create/edit/delete family under
  // /api/organizations/{org}/mcp/remote_servers — and this deployment has no such
  // backend, so the bridge answers it from its own store (bridge/connectors.mjs).
  // Responses are bare claude.ai documents (the renderer parses the body with its
  // own schema), never the bridge envelope. Never forwarded upstream: the org id
  // is the bridge's synthetic one, which no upstream org would recognize. The
  // renderer still drives connection and tool listing over the Desktop IPC
  // itself, so the connection fields here are deliberately null and the client's
  // own hydration fills them.
  const connectorsMatch = connectorsPath.exec(url.pathname);
  if (connectorsMatch) {
    const resource = connectorsMatch[1].toLowerCase();
    const segments = (connectorsMatch[2] || "").split("/").filter(Boolean).map(decodeURIComponent);
    const id = segments[0];
    const sub = segments[1];
    const subName = segments[2];
    if (resource === "ema_health") {
      // Per-connector EMA health analytics claude.ai computes; nothing to report.
      sendOfficialDocument(response, { results: [], as_of: new Date().toISOString() });
      return;
    }
    if (resource === "remote_servers_with_connection" && !id) {
      if (request.method !== "GET") throw new ApiError(405, "method not allowed");
      sendOfficialDocument(response, await connectors.listWithConnection());
      return;
    }
    if (!id) {
      if (request.method === "GET") {
        sendOfficialDocument(response, await connectors.list());
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        sendOfficialDocument(response, (await connectors.create(body)).document);
        return;
      }
      throw new ApiError(405, "method not allowed");
    }
    if (!sub) {
      if (request.method === "GET") {
        const document = await connectors.get(id);
        if (!document) throw new ApiError(404, "connector not found");
        sendOfficialDocument(response, document);
        return;
      }
      if (request.method === "PUT" || request.method === "PATCH") {
        const body = await readJson(request);
        const document = await connectors.update(id, body);
        if (!document) throw new ApiError(404, "connector not found");
        sendOfficialDocument(response, document);
        return;
      }
      if (request.method === "DELETE") {
        await connectors.remove(id);
        sendOfficialDocument(response, { ok: true });
        return;
      }
      throw new ApiError(405, "method not allowed");
    }
    if (sub === "tools" && request.method === "GET") {
      // The renderer lists a connector's tools from the Desktop runtime over IPC;
      // this admin-shaped view is not driven here, so report none.
      sendOfficialDocument(response, { tools: [] });
      return;
    }
    if (sub === "reenable" && request.method === "POST") {
      const body = await readJson(request);
      const document = await connectors.setEnabled(id, body?.enabled !== false);
      if (!document) throw new ApiError(404, "connector not found");
      sendOfficialDocument(response, await connectors.toolPolicies(id));
      return;
    }
    if (sub === "tool_policies") {
      if (request.method === "GET") {
        const policies = await connectors.toolPolicies(id);
        if (!policies) throw new ApiError(404, "connector not found");
        sendOfficialDocument(response, policies);
        return;
      }
      if (request.method === "PUT" && subName) {
        const body = await readJson(request);
        const policies = await connectors.setToolPolicy(id, subName, body?.max_permission ?? null);
        if (!policies) throw new ApiError(404, "connector not found");
        sendOfficialDocument(response, policies);
        return;
      }
    }
    if (sub === "ema_health" && request.method === "GET") {
      sendOfficialDocument(response, { results: [], as_of: new Date().toISOString() });
      return;
    }
    if (sub === "admin_tools" && request.method === "GET") {
      sendOfficialDocument(response, { tools: [], scopes: [] });
      return;
    }
    throw new ApiError(404, "not found");
  }

  // Projects. The official bundle's project surfaces — the `/projects` page and
  // its create form, the `/project/<uuid>` detail route, the composer's project
  // selector — speak claude.ai's projects API, which this deployment answers
  // from the Desktop's CoworkSpaces store (see bridge/projects.mjs). Same shape
  // as the connectors block above: bodies go on the wire as plain claude.ai
  // documents (the renderer parses them itself, never the bridge envelope) and
  // nothing is forwarded upstream — the org id is the bridge's synthetic one,
  // which no upstream org would recognize.
  const projectsMatch = projectsPath.exec(url.pathname);
  if (projectsMatch) {
    // Reads go through unconditionally; the writes that create or change a space
    // are on the IPC allow-list only when the deployment enables infrastructure
    // actions. Refuse them with the reason rather than letting the wrapper's own
    // refusal surface as an opaque 500.
    if (!infrastructureActionsEnabled
      && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      throw new ApiError(403, "projects are read-only: infrastructure actions are disabled");
    }
    const resource = projectsMatch[1].toLowerCase();
    const segments = (projectsMatch[2] || "").split("/").filter(Boolean).map(decodeURIComponent);
    const identity = await resolveStoreIdentity(request);
    const accountUuid = syntheticAccountUuid(
      String(identity.email || identity.name || "").toLowerCase(),
    );
    const projectUuid = segments[0];
    const sub = segments[1];
    // `GET /projects_v2` — the paged list. The v1 list and the two writes share
    // the bare `/projects` path, so they are split by method below.
    if (resource === "projects_v2" && !projectUuid) {
      if (request.method !== "GET") throw new ApiError(405, "method not allowed");
      sendOfficialDocument(response, await projects.page({
        accountUuid,
        searchParams: url.searchParams,
      }));
      return;
    }
    if (!projectUuid) {
      if (request.method === "GET") {
        sendOfficialDocument(response, await projects.list({
          accountUuid,
          searchParams: url.searchParams,
        }));
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        sendOfficialDocument(response, await projects.create({ accountUuid, body }));
        return;
      }
      throw new ApiError(405, "method not allowed");
    }
    // `/projects/count` and `/projects/request_haystack` are collection actions,
    // not project ids (a project uuid is a hex uuid and never these words).
    if (projectUuid === "count" && request.method === "GET") {
      sendOfficialDocument(response, { count: await projects.count() });
      return;
    }
    if (projectUuid === "request_haystack" && request.method === "POST") {
      await readJson(request);
      sendOfficialDocument(response, { ok: true });
      return;
    }
    if (!sub) {
      if (request.method === "GET") {
        const document = await projects.get(projectUuid, { accountUuid });
        if (!document) throw new ApiError(404, "project not found");
        sendOfficialDocument(response, document);
        return;
      }
      if (request.method === "PUT" || request.method === "PATCH") {
        const body = await readJson(request);
        const document = await projects.update({ accountUuid, projectUuid, body });
        if (!document) throw new ApiError(404, "project not found");
        sendOfficialDocument(response, document);
        return;
      }
      if (request.method === "DELETE") {
        await projects.remove({ projectUuid });
        sendOfficialDocument(response, { ok: true });
        return;
      }
      throw new ApiError(405, "method not allowed");
    }
    if (sub === "star") {
      if (!["POST", "PUT", "DELETE"].includes(request.method)) {
        throw new ApiError(405, "method not allowed");
      }
      await projects.setStar({ projectUuid, starred: request.method !== "DELETE" });
      const document = await projects.get(projectUuid, { accountUuid });
      if (!document) throw new ApiError(404, "project not found");
      sendOfficialDocument(response, document);
      return;
    }
    // The device binding. A project here *is* its local space, so there is
    // nothing to bind — accept the write and answer the current document, whose
    // `cowork_bound_device` already names the space.
    if (sub === "settings" && (request.method === "PUT" || request.method === "PATCH")) {
      await readJson(request);
      const document = await projects.get(projectUuid, { accountUuid });
      if (!document) throw new ApiError(404, "project not found");
      sendOfficialDocument(response, document);
      return;
    }
    // Knowledge-base shapes claude.ai computes for a project: none of it exists
    // here (a space's files are its folders), so every read answers the settled
    // empty document and every write is a no-op.
    if (request.method === "GET") {
      sendOfficialDocument(response, emptyProjectResource(sub, accountUuid));
      return;
    }
    if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
      // The body is deliberately not read: these writes have nothing to record,
      // and an upload's body may not even be JSON. Answering without consuming
      // it is what the notification-channel route above already does.
      sendOfficialDocument(response, { ok: true });
      return;
    }
    throw new ApiError(405, "method not allowed");
  }

  if (protocolRules.some((rule) => rule.path.test(url.pathname))) {
    await forwardOfficialProtocol(request, response, url);
    return;
  }

  // Browser notifications (see bridge/notifications.mjs and the "Desktop
  // notifications → browser relay" section of bridge-wrapper/main.cjs).
  if (request.method === "GET" && url.pathname === "/api/remote/notifications/config") {
    sendJson(response, 200, { ok: true, value: await notifications.config() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/notifications/subscribe") {
    const body = await readJson(request);
    sendJson(response, 200, { ok: true, value: await notifications.registerSubscription(body.subscription) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/notifications/unsubscribe") {
    const body = await readJson(request);
    sendJson(response, 200, { ok: true, value: await notifications.removeSubscription(body) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/notifications/click") {
    const body = await readJson(request);
    const tag = typeof body.tag === "string" ? body.tag.slice(0, 200) : "";
    if (!tag) throw new ApiError(400, "notification tag is required");
    // "allow_once" and "deny" answer a permission card; anything else is
    // a plain click.
    const action = body.action === "allow_once" || body.action === "deny"
      ? body.action
      : "default";
    sendJson(response, 200, { ok: true, value: await desktop.notificationClick(tag, action) });
    return;
  }

  // Operator notice: warn the connected pages that the VM is about to restart,
  // ahead of a planned deploy (the SIGTERM handler below sends the same notice
  // automatically). Gated like the other privileged bridge actions — it reaches
  // every tab on the instance — and driven from the host, not the browser.
  if (request.method === "POST" && url.pathname === "/api/remote/notice") {
    if (!infrastructureActionsEnabled) throw new ApiError(404, "Remote infrastructure actions are disabled");
    const body = await readJson(request);
    const notice = {
      title: typeof body.title === "string" && body.title ? body.title.slice(0, 200) : restartNotice.title,
      description: typeof body.description === "string"
        ? body.description.slice(0, 500)
        : restartNotice.description,
    };
    const ttlMs = Number.isFinite(body.ttlMs) && body.ttlMs > 0
      ? Math.min(body.ttlMs, 60 * 60 * 1000)
      : undefined;
    sendJson(response, 200, { ok: true, value: publishNotice(notice, ttlMs) });
    return;
  }

  // The Desktop main process opens an OS folder dialog for Cowork's folder
  // grant (`mcp__cowork__request_cowork_directory`) and the other folder flows;
  // in this container that dialog renders on a headless display nobody sees, so
  // the wrapper routes it to the browser's in-page picker and awaits the answer
  // here (see the "Remote folder picker" section of bridge-wrapper/main.cjs).
  if (request.method === "POST" && url.pathname === "/api/remote/folder-pick") {
    const body = await readJson(request);
    const id = typeof body.id === "string" ? body.id.slice(0, 200) : "";
    if (!id) throw new ApiError(400, "folder pick id is required");
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((path) => typeof path === "string" && path).slice(0, 64)
      : [];
    sendJson(response, 200, {
      ok: true,
      value: await desktop.folderPick(id, body.canceled === true, paths),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/files/limits") {
    sendJson(response, 200, { ok: true, value: uploads.limits() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/remote/files/upload") {
    const value = await uploads.receive(request, response, url);
    sendJson(response, 200, { ok: true, value });
    return;
  }
  // The official chat/Cowork composer uploads attachments to claude.ai's file
  // endpoints, not the raw-binary route above, and parses the reply as the file
  // document itself (no bridge envelope). Its own protocol handler answers
  // these inside the desktop app; in the browser they land here. A missing
  // route is what made every chat attachment fail with "Upload failed" before
  // the message could be sent.
  const attachmentUploadPath =
    /^\/api\/(?:organizations\/[0-9a-f-]{36}\/(?:conversations\/[^/]+\/wiggle\/upload-file|cowork\/attachments)|[0-9a-f-]{36}\/upload)$/i;
  if (request.method === "POST" && attachmentUploadPath.test(url.pathname)) {
    sendJson(response, 200, await uploads.receiveAttachment(request, response));
    return;
  }
  const prepareUploadPath =
    /^\/api\/organizations\/[0-9a-f-]{36}\/conversations\/[^/]+\/files\/prepare-upload$/i;
  if (request.method === "POST" && prepareUploadPath.test(url.pathname)) {
    sendJson(response, 200, uploads.prepare(await readJson(request)));
    return;
  }
  const deleteUploadPath =
    /^\/api\/organizations\/[0-9a-f-]{36}\/conversations\/[^/]+\/wiggle\/delete-file$/i;
  if (request.method === "POST" && deleteUploadPath.test(url.pathname)) {
    sendJson(response, 200, await uploads.removeAttachment(await readJson(request)));
    return;
  }
  if (await handleDownload(request, response, url)) return;
  if (await handleFilePreview(request, response, url)) return;

  if (request.method === "POST" && url.pathname === "/api/remote/ipc") {
    // Official Desktop carries image attachments as base64 in send/start IPC,
    // so this route needs a larger bounded allowance than other JSON routes.
    // Files go through the streaming upload route instead.
    const body = await readJson(request, 72 * 1024 * 1024);
    validateInvocation(body.surface, body.method, body.args ?? []);
    // A tenant's read-only git IPC is answered from inside the Cowork VM, not
    // forwarded to Desktop: the folder and branch controls must describe the
    // workspace the guest actually works in, and neither path listing nor git
    // metadata should be read by this privileged container (see
    // tenantGitAnswer and docs/code-in-cowork-vm.md).
    // A new Code session's first turn must carry the picker's permission mode or
    // it runs Manual (see fillStoredStartPermissionMode). The browser UI's
    // failsafe "default" is read as "no choice" only when the call came from the
    // browser: the mobile facade's own Manual pick arrives as the same string
    // and must be left alone. A browser fetch carries Sec-Fetch-* (and Origin /
    // Referer); the facade's server-side fetch carries none of them.
    const fromBrowserCodeUi = Boolean(
      request.headers["sec-fetch-mode"] || request.headers.origin || request.headers.referer,
    );
    if (codeActionsEnabled
      && body.surface === "LocalSessions" && body.method === "start") {
      await fillStoredStartPermissionMode(body.args, {
        defaultMeansNoChoice: fromBrowserCodeUi,
      }).catch((error) => {
        console.log(`[cowork-bridge] start permission-mode fill failed: ${error.message}`);
      });
    }
    const startedAt = Date.now();
    try {
      let value;
      if (tenantCodeReadsEnabled
        && body.surface === "LocalSessions" && tenantGitReadMethods.has(body.method)) {
        value = await tenantGitAnswer(body);
      } else if (
        body.surface === "LocalSessions"
        && body.method === "readSessionFileWithStatus"
      ) {
        // Answered in the bridge: it needs to merge Desktop's view with the
        // roots this container serves, and it must never hand the pane a bare
        // null where a reason is available.
        value = await bridgeSessionFileWithStatus(
          body.args ?? [],
          body.argsEncoding,
        );
      } else if (
        body.surface === "LocalSessions"
        && (body.method === "readSessionFile" || body.method === "readFileAtCwd")
      ) {
        // Read from the served roots first: Desktop's inline answer for a large
        // file is what exhausted the bridge heap (see bridgeLocalSessionFile).
        const local = await bridgeLocalSessionFile(body);
        if (local.handled) {
          value = local.value;
        } else {
          value = await invokeWithRoutineFileRepair(
            body.surface,
            body.method,
            body.args ?? [],
            body.argsEncoding,
          );
          value = await supplementSessionFileRead(body, value);
        }
      } else {
        value = await invokeWithRoutineFileRepair(
          body.surface,
          body.method,
          body.args ?? [],
          body.argsEncoding,
        );
        if (body.surface === "LocalSessions" && body.method === "resolveSessionFile") {
          value = await supplementSessionFileRead(body, value);
        }
      }
      if (
        body.surface === "LocalAgentModeSessions"
        && body.method === "getSession"
        && value
        && typeof value === "object"
        && typeof value.sessionType !== "string"
      ) {
        const sessionId = body.args?.[0];
        const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
        const listedSession = Array.isArray(sessions)
          ? sessions.find((session) => (session?.sessionId ?? session?.id) === sessionId)
          : undefined;
        if (typeof listedSession?.sessionType === "string") {
          value = { ...value, sessionType: listedSession.sessionType };
        }
      }
      if (body.surface === "FileSystem") {
        console.log(
          `[cowork-bridge] ipc ${body.surface}.${body.method} ok ${Date.now() - startedAt}ms`,
        );
      }
      sendJson(response, 200, { ok: true, value });
    } catch (error) {
      console.error(
        `[cowork-bridge] ipc ${body.surface}.${body.method} failed ${Date.now() - startedAt}ms: ${error.message}`,
      );
      throw error;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/main-menu") {
    const value = await desktop.mainMenu();
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/main-menu-action") {
    const body = await readJson(request);
    if (!allowedDeveloperActions.has(body.action)) {
      throw new ApiError(400, "Remote Developer action is not allowed");
    }
    if (body.action === "reload-mcp-configuration") {
      if (!gatewaySettingsEnabled && !developerActionsEnabled) {
        throw new ApiError(404, "Remote MCP reload is disabled");
      }
    } else if (!developerActionsEnabled) {
      throw new ApiError(404, "Remote Developer actions are disabled");
    }
    const value = await desktop.mainMenuAction(body.action);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/file") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer files are disabled");
    const kind = url.searchParams.get("kind");
    if (!allowedDeveloperFileKinds.has(kind)) {
      throw new ApiError(400, "Remote Developer file kind is not allowed");
    }
    const value = await desktop.readDeveloperFile(kind);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/remote/developer/file") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer files are disabled");
    const body = await readJson(request);
    if (!allowedDeveloperFileKinds.has(body.kind) || body.kind === "mcp-log") {
      throw new ApiError(400, "Remote Developer file is not writable");
    }
    if (typeof body.content !== "string" || body.content.length > 1024 * 1024) {
      throw new ApiError(400, "Remote Developer file content is invalid");
    }
    const value = await desktop.writeDeveloperFile(body.kind, body.content);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/artifacts") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer artifacts are disabled");
    const value = await desktop.listDeveloperArtifacts();
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/remote/developer/artifact") {
    if (!developerActionsEnabled) throw new ApiError(404, "Remote Developer artifacts are disabled");
    const name = url.searchParams.get("name") || "";
    if (!/^(?:desktop-trace|memory-trace)-[A-Za-z0-9_.:-]+\.json$|^main-heap-[A-Za-z0-9_.:-]+\.heapsnapshot$/.test(name)) {
      throw new ApiError(400, "Remote Developer artifact name is not allowed");
    }
    const upstream = await desktop.fetchRaw(
      `/developer-artifact?name=${encodeURIComponent(name)}`,
    );
    if (!upstream.ok || !upstream.body) {
      throw new ApiError(upstream.status || 502, "Remote Developer artifact is unavailable");
    }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Disposition": upstream.headers.get("content-disposition") || "attachment",
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;
    response.writeHead(200, headers);
    Readable.fromWeb(upstream.body).pipe(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/settings") {
    const body = await readJson(request);
    validateSettingsInvocation(body.surface, body.method, body.args ?? []);
    let value = await desktop.invokeSettings(
      body.surface,
      body.method,
      body.args ?? [],
      body.argsEncoding,
    );
    if (body.surface === "Custom3pSetup" && body.method === "getLoginDesktop3pStatus") {
      value = sanitize3pLoginStatus(value);
    }
    if (body.surface === "Custom3pSetup"
      && (body.method === "getConfigHealth" || body.method === "recheckConfigHealth")) {
      value = await correctedGatewayHealth(value);
    }
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/crypto/digest") {
    const body = await readJson(request);
    const algorithm = String(body.algorithm || "").toUpperCase();
    const nodeAlgorithm = {
      "SHA-256": "sha256",
      "SHA-384": "sha384",
      "SHA-512": "sha512",
    }[algorithm];
    if (!nodeAlgorithm) throw new ApiError(400, "digest algorithm is not allowed");
    if (
      typeof body.dataBase64 !== "string"
      || body.dataBase64.length > 1024 * 1024
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)
    ) {
      throw new ApiError(400, "invalid digest input");
    }
    const input = Buffer.from(body.dataBase64, "base64");
    const value = createHash(nodeAlgorithm).update(input).digest("base64");
    sendJson(response, 200, { ok: true, value: { dataBase64: value } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/remote/store") {
    const body = await readJson(request);
    validateStoreRead(body.surface, body.store);
    const value = sanitizeStoreValue(
      body.surface,
      body.store,
      await desktop.readStore(body.surface, body.store),
      await resolveStoreIdentity(request),
    );
    sendJson(response, 200, { ok: true, value });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    realtime.open(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    // A peer with no session gets liveness only: the full document names the
    // instance (its account-derived prefix) and the surfaces it exposes.
    if (!authorization.ok) {
      sendJson(response, 200, { ok: true });
      return;
    }
    try {
      const [surfaces, desktopRuntime] = await Promise.all([
        desktop.inspect(),
        desktop.runtime(),
      ]);
      const runtimeControlReady = Boolean(
        surfaces?.ClaudeVM?.includes("isHostLoopModeEnabled")
        && surfaces?.ClaudeVM?.includes("getDownloadStatus")
        && surfaces?.ClaudeVM?.includes("getRunningStatus")
        && surfaces?.ClaudeVM?.includes("startVM")
      );
      sendJson(response, 200, {
        ok: true,
        release,
        renderer: desktopRuntime.renderer,
        rendererSummary: rendererSummary(desktopRuntime.renderer),
        // Connected web-shell pages and the release each booted (see
        // realtime.status): distinguishes a stale page from a stale server.
        realtime: realtime.status(),
        // The last accepted model-selector save (see lastModelSelectorUpdate).
        lastModelSelectorUpdate,
        transport: "official-renderer-ipc",
        // This container's instance, for a peer checking that the Desktop it
        // reached is the one it meant to. A single-instance host answers "",
        // which is what a peer with an empty prefix expects too.
        instance: { namePrefix: instanceNamePrefix },
        runtimeControlReady,
        coworkReady: Boolean(
          surfaces?.LocalAgentModeSessions?.includes("getAll")
          && runtimeControlReady
        ),
        chatReady: Boolean(
          surfaces?.LocalAgentModeSessions?.includes("start")
          && surfaces?.LocalAgentModeSessions?.includes("sendMessage")
        ),
        // The Claude Code (LocalSessions) surface is only present when the
        // Desktop build exposes it and CLAUDE_REMOTE_CODE_ACTIONS allows it.
        // The mobile facade's Code tab needs all four of these.
        codeReady: Boolean(
          codeActionsEnabled
          && surfaces?.LocalSessions?.includes("getAll")
          && surfaces?.LocalSessions?.includes("getSession")
          && surfaces?.LocalSessions?.includes("sendMessage")
        ),
        configuredModels,
        codeActionsEnabled,
        // Whether this is one account's own instance. A tenant reports
        // `codeReady: false` by construction (see `tenantInstance`), so a peer
        // reading this can tell "Code is off here" from "this instance is a
        // tenant, whose Code belongs on its self-hosted runner".
        tenant: tenantInstance,
        // Which self-hosted pool this tenant's runner registers against, so a
        // runner that is polling the wrong instance is visible. The pool id
        // only — never the secret, which is read by pool id.
        codeRunnerPool: codeRunnersEnabled
          ? (await codeRunners.primaryPool())?.pool_id ?? null
          : null,
        // The runner itself: version(s), when it last polled, and whether it
        // speaks the UI-request lane. An old runner makes every folder/branch
        // lookup fail while sessions still work, which this makes visible.
        ...(codeRunnersEnabled
          ? { codeRunner: await codeRunners.runnerStatus().catch(() => null) }
          : {}),
        infrastructureActionsEnabled,
        // The actual methods the renderer exposes on each surface, filtered by
        // what this bridge allows. `codeReady` only checks request/response
        // methods, so the live listener (`LocalSessions.onOnEvent`) can be
        // absent while Code still works — this is where that shows.
        surfaces,
      });
    } catch (error) {
      sendJson(response, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/cowork/sessions") {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    sendJson(response, 200, { ok: true, value: sessions.filter((session) => !isChatSession(session)) });
    return;
  }

  const transcriptMatch = url.pathname.match(/^\/api\/cowork\/sessions\/([^/]+)\/transcript$/);
  if (request.method === "GET" && transcriptMatch) {
    const sessionId = decodeURIComponent(transcriptMatch[1]);
    await requireSessionKind(sessionId, "cowork");
    const transcript = await desktop.invoke("LocalAgentModeSessions", "getTranscript", [sessionId]);
    sendJson(response, 200, { ok: true, value: transcript });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/cowork\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && messageMatch) {
    const sessionId = decodeURIComponent(messageMatch[1]);
    await requireSessionKind(sessionId, "cowork");
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const { value, messageUuid } = await sendSessionMessage(sessionId, message);
    sendJson(response, 200, { ok: true, value, messageUuid });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/models") {
    sendJson(response, 200, { ok: true, value: configuredModels });
    return;
  }

  // The same models with the label each one displays as, for the admin page's
  // model-picker card (see modelPickerCatalogue). Not an admin route: like
  // /api/chat/models it answers whoever the proxy let through to this instance,
  // and it names only models the picker already offers that person.
  if (request.method === "GET" && url.pathname === "/api/chat/model-catalog") {
    sendJson(response, 200, { ok: true, value: await modelPickerCatalogue() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/sessions") {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    sendJson(response, 200, { ok: true, value: sessions.filter(isChatSession) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat/sessions") {
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const model = requireConfiguredModel(body.model);
    let title;
    try {
      title = requireNonEmptyString(
        await desktop.generateTitle(message, titleModel || model),
        "generated title",
        200,
      );
    } catch {
      // A title is presentation metadata. Do not prevent a short new session
      // from starting when the optional title-generation request is unavailable.
      title = message.replace(/\s+/g, " ").slice(0, 200);
    }
    const sessionId = `local_${randomUUID()}`;
    const messageUuid = randomUUID();
    const value = await desktop.invoke("LocalAgentModeSessions", "start", [{
      sessionId,
      message,
      messageUuid,
      model,
      title,
      sessionType: "chat",
      images: [],
      userSelectedFiles: [],
      userSelectedFolders: [],
      syntheticMessage: false,
      documentFunnelEnabled: false,
    }]);
    sendJson(response, 201, { ok: true, value, sessionId, messageUuid, title });
    return;
  }

  const chatSessionMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (request.method === "GET" && chatSessionMatch) {
    const sessionId = decodeURIComponent(chatSessionMatch[1]);
    const session = await requireSessionKind(sessionId, "chat");
    sendJson(response, 200, { ok: true, value: session });
    return;
  }

  const chatTranscriptMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/transcript$/);
  if (request.method === "GET" && chatTranscriptMatch) {
    const sessionId = decodeURIComponent(chatTranscriptMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const transcript = await desktop.invoke("LocalAgentModeSessions", "getTranscript", [sessionId]);
    sendJson(response, 200, { ok: true, value: transcript });
    return;
  }

  const chatMessageMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
  if (request.method === "POST" && chatMessageMatch) {
    const sessionId = decodeURIComponent(chatMessageMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const message = requireNonEmptyString(body.message, "message");
    const { value, messageUuid } = await sendSessionMessage(sessionId, message);
    sendJson(response, 200, { ok: true, value, messageUuid });
    return;
  }

  const chatStopMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/stop$/);
  if (request.method === "POST" && chatStopMatch) {
    const sessionId = decodeURIComponent(chatStopMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const value = await desktop.invoke("LocalAgentModeSessions", "stop", [sessionId]);
    sendJson(response, 200, { ok: true, value });
    return;
  }

  const chatModelMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/model$/);
  if (request.method === "PATCH" && chatModelMatch) {
    const sessionId = decodeURIComponent(chatModelMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const model = requireConfiguredModel(body.model);
    await desktop.invoke("LocalAgentModeSessions", "setModel", [sessionId, model]);
    sendJson(response, 200, { ok: true, value: await getSession(sessionId) });
    return;
  }

  const chatTitleMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/title$/);
  if (request.method === "PATCH" && chatTitleMatch) {
    const sessionId = decodeURIComponent(chatTitleMatch[1]);
    await requireSessionKind(sessionId, "chat");
    const body = await readJson(request);
    const title = requireNonEmptyString(body.title, "title", 200);
    await desktop.invoke("LocalAgentModeSessions", "updateSession", [
      sessionId,
      { title, titleSource: "manual" },
    ]);
    sendJson(response, 200, { ok: true, value: await getSession(sessionId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const publicRoot = resolve(publicDir);
  const filePath = resolve(publicRoot, safePath);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}/`)) {
    throw new Error("not found");
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("not found");
  let body = await readFile(filePath);
  if ([".css", ".html", ".js"].includes(extname(filePath))) {
    const source = body.toString("utf8");
    const marker = "__CLAUDESK_RELEASE__";
    body = Buffer.from(source.replaceAll(marker, release.patchRelease), "utf8");
  }
  const fileExtension = extname(filePath);
  response.writeHead(200, {
    "Cache-Control": fileExtension === ".otf"
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "Content-Type": mimeTypes[fileExtension] || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  response.end(body);
}

async function servePreparedRendererAsset(response, pathname) {
  const upstream = await desktop.fetchRaw(pathname);
  if (!upstream.ok) throw new ApiError(upstream.status, "prepared renderer asset not found");
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Cache-Control": pathname.endsWith("/index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "Content-Length": body.length,
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function initialRemoteStores(request) {
  // The page-load snapshot feeds the preload's synchronous store reads (the
  // account menu paints its identity from it before any async fetch lands), so
  // it resolves the same request identity the async store route does; otherwise
  // the first paint would show the env fallback and only the later refresh the
  // signed-in name.
  const identity = await resolveStoreIdentity(request);
  const specs = [
    ["LocalAgentModeSessions", "sessionsBridgeStatusStore"],
    ["LocalAgentModeSessions", "interactiveAuthStore"],
    ["ManagedConfig", "managedRendererConfigStore"],
    ["ClaudeVM", "apiReachabilityStore"],
  ];
  const entries = await Promise.all(specs.map(async ([surface, store]) => {
    try {
      const value = await desktop.readStore(surface, store);
      return [`${surface}.${store}`, sanitizeStoreValue(surface, store, value, identity)];
    } catch {
      return [`${surface}.${store}`, {}];
    }
  }));
  return Object.fromEntries(entries);
}

async function initialChatSessionIds() {
  try {
    const sessions = await desktop.invoke("LocalAgentModeSessions", "getAll", []);
    return Array.isArray(sessions)
      ? sessions
        .filter(isChatSession)
        .map((session) => session.sessionId)
        .filter((sessionId) => typeof sessionId === "string")
      : [];
  } catch {
    return [];
  }
}

function htmlSafeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

async function serveOfficialIndex(request, response) {
  const desktopRuntime = await desktop.runtime();
  const rendererBase = desktopRuntime?.renderer?.basePath;
  if (
    desktopRuntime?.renderer?.desktopVersion !== release.desktopVersion
    || desktopRuntime?.renderer?.patchRelease !== release.patchRelease
    || typeof rendererBase !== "string"
  ) {
    throw new ApiError(503, "prepared renderer does not match the active Claudesk release");
  }
  const upstream = await desktop.fetchRaw(`${rendererBase}/index.html`);
  if (!upstream.ok) throw new ApiError(502, "official ion-dist entry is unavailable");
  // The URL namespace for every module chunk. A login shell has no session, so
  // its assets must stay under the proxy's unauthenticated `/renderer/*` route.
  // Everyone else uses a release-versioned `/app-renderer/…` namespace this
  // bridge serves from that instance's *own* prepared generation: the proxy's
  // login matcher does not claim it, and the release in the path is what keeps
  // a newly prepared chunk from being served out of the browser's cache.
  const assetBase = loginShellEnabled
    ? rendererBase
    : `/app-renderer${rendererBase.slice("/renderer".length)}`;
  const config = {
    configuredModels,
    loginShell: loginShellEnabled,
    assetBase,
    // The deployment's own auth service holds the session, so the account menu's
    // own "Sign out" — which ends a claude.ai session — is replaced by the
    // preload with one that ends that. Only meaningful where the identity seam
    // is filled.
    authdSessions: Boolean(authIdentityUrl),
    // A login shell is a public page, so it seeds none of the instance's own
    // state: the interactive-auth store carries the operator's display name and
    // the chat session list is theirs. The sign-in page reads neither.
    chatSessionIds: loginShellEnabled ? [] : await initialChatSessionIds(),
    // The preload table the renderer's app features come from — see
    // withSelfHostedSessions for why a tenant's entry must be in it.
    desktopBootFeatures: withSelfHostedSessions(await desktop.bootFeatures()),
    desktopRuntime,
    release,
    codeActionsEnabled,
    codeSurfaceEnabled,
    // The renderer's preference surface (`claude.settings.AppPreferences`) is
    // how the Code form persists its draft permission mode, model and effort.
    // A tenant has no local executor but does have a Code surface on its
    // runner, so it needs this shim even though `codeActionsEnabled` is false.
    codeSettingsEnabled: codeActionsEnabled || codeSurfaceEnabled,
    developerActionsEnabled,
    gatewaySettingsEnabled,
    webShell: webShellEnabled,
    // A tenant's Code start options are normally drawn by the prepared
    // renderer; the preload keeps a fallback for a bundle that does not render
    // them (see remote-preload.js, "code start options").
    tenantCodeReads: tenantCodeReadsEnabled,
    initialStores: loginShellEnabled ? {} : await initialRemoteStores(request),
    listeners: Object.fromEntries(
      [...remoteListenerMethods].map(([surface, methods]) => [surface, [...methods]]),
    ),
    methods: Object.fromEntries(
      [...allowedMethods].map(([surface, methods]) => [surface, [...methods]]),
    ),
    settingsMethods: Object.fromEntries(
      [...allowedSettingsMethods].map(([surface, methods]) => [
        surface,
        surface === "Custom3pSetup"
          ? [...methods, "openSetupWindow", "setDeploymentMode"]
          : [...methods],
      ]),
    ),
    stores: Object.fromEntries(
      [...allowedStores].map(([surface, stores]) => [surface, [...stores]]),
    ),
    transport: "official-ion-dist-remote-ipc",
  };
  // Built once and reused: the exact bytes must survive the splice (see
  // shimOfficialIndex), so the injection and the post-splice check share it.
  const bootstrapJson = htmlSafeJson(config);
  const bootstrapInjection = [
    `<link rel="manifest" href="/manifest.webmanifest?v=${release.patchRelease}">`,
    `<link rel="preload" href="/fonts/AnthropicSerif-Text-Regular-CJK.otf?v=${release.patchRelease}" as="font" type="font/otf" crossorigin>`,
    '<meta name="theme-color" content="#f7f6f2">',
    `<script>globalThis.__CLAUDE_REMOTE_BOOTSTRAP__=${bootstrapJson}</script>`,
    `<script src="/remote-main-menu.js?v=${release.patchRelease}"></script>`,
    `<script src="/remote-preload.js?v=${release.patchRelease}"></script>`,
    `<script src="/remote-folder-picker.js?v=${release.patchRelease}"></script>`,
  ].join("");
  // The official entry lists its CSS after the module script. Put our narrow
  // remote overrides at the very end of <head>, otherwise the official button
  // sizing rules win in the mobile composer.
  const overrideStyles = [
    `<link rel="stylesheet" href="/remote-shell.css?v=${release.patchRelease}">`,
    `<link rel="stylesheet" href="/remote-main-menu.css?v=${release.patchRelease}">`,
  ].join("");
  let html = await upstream.text();
  try {
    html = shimOfficialIndex(html, {
      injection: bootstrapInjection,
      overrideStyles,
      // Both the document's refs and the chunk loader (see the
      // web-shell-asset-base renderer patch, which reads `assetBase` from the
      // bootstrap) use this one base, so the entry, its static imports and
      // every lazy chunk resolve into the same release-versioned namespace.
      rendererBase: assetBase,
      bootstrapJson,
      webShell: webShellEnabled,
    });
  } catch (error) {
    throw new ApiError(502, error.message);
  }
  const body = Buffer.from(html, "utf8");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  response.end(body);
}

const localStaticFiles = new Set([
  "/fonts/AnthropicSerif-Text-Regular-CJK.otf",
  "/manifest.webmanifest",
  "/remote-developer.css",
  "/remote-developer.html",
  "/remote-developer.js",
  "/remote-main-menu.css",
  "/remote-main-menu.js",
  "/remote-preload.js",
  "/remote-folder-picker.js",
  "/remote-shell.css",
  // The notification service worker must be served from the root scope so it
  // can control the app page and its notifications.
  "/sw.js",
]);

// One line per API request, so a surface that will not update live is
// diagnosable from this log alone: which transport the client chose (the SSE
// stream, a WebSocket upgrade, a plain fetch), what a stream resumed from, and
// how long each connection lived. Static assets and the shell's own pages are
// skipped — this is the API conversation, not every byte served.
function logApiRequest(request, response, url) {
  const upgrade = request.headers.upgrade;
  if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/api/")
    && !url.pathname.startsWith("/edge-api/") && !upgrade) {
    return;
  }
  const startedAt = Date.now();
  const query = url.search ? `?${String(request.url).split("?")[1].slice(0, 240)}` : "";
  const sse = String(request.headers.accept ?? "").includes("text/event-stream") ? " accept=sse" : "";
  const lastEventId = request.headers["last-event-id"];
  const bits = [
    `[cowork-bridge] req ${request.method} ${url.pathname}${query}${sse}`,
    ...(upgrade ? [`UPGRADE=${upgrade}`] : []),
    ...(lastEventId !== undefined ? [`last-event-id=${String(lastEventId).slice(0, 24)}`] : []),
  ];
  let logged = false;
  const done = (how) => {
    if (logged) return;
    logged = true;
    console.log(`${bits.join(" ")} -> ${how} (${Date.now() - startedAt}ms)`);
  };
  response.on("finish", () => done(String(response.statusCode)));
  response.on("close", () => done(`${response.statusCode ?? 0} closed`));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  logApiRequest(request, response, url);
  try {
    // The title/branch the app asks for when it names something — see
    // handleDustApi. Answered before the generic API legs so a browser page
    // gets the same custom-3p stubs the Desktop main serves in-process.
    const dustMatch =
      /^\/api\/organizations\/[0-9a-f-]{36}\/dust\/(generate_title_and_branch|generate_session_title|command_display_names)$/
        .exec(url.pathname);
    if (dustMatch && request.method === "POST") {
      await handleDustApi(request, response, dustMatch[1], url.pathname);
    } else if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/edge-api/")) {
      await handleApi(request, response, url);
    }
    // The admin dashboard's VM control, reached by authd on the deployment
    // network — deliberately outside `/api/*`, like authd's own internal legs.
    else if (url.pathname.startsWith("/internal/")) {
      await handleInternalAction(request, response, url);
    }
    // The >30 MiB lane of the browser chat/Cowork composer: prepare-upload
    // names a path under this bridge's file store, then the file itself is
    // posted here with the file's metadata. The renderer parses the bare
    // document, so this does not use the bridge envelope. The login shell
    // refuses it like every other API path.
    else if ((request.method === "GET" || request.method === "HEAD")
      && (url.pathname === "/routine-tokens" || url.pathname === "/routine-tokens/")) {
      // The login shell serves the sign-in page and nothing else.
      if (loginShellEnabled) {
        sendJson(response, 403, { ok: false, error: "not signed in" });
      } else {
        await serveRoutineTokensPage(response);
      }
    }
    else if (request.method === "POST" && url.pathname === "/v1/filestore/fs/createFile") {
      // The login shell refuses everything first, as it does in every branch.
      if (loginShellEnabled) {
        sendJson(response, 403, { ok: false, error: "not signed in" });
      } else {
        const authorization = await authorizeApiRequest(request)
          .catch(() => ({ ok: false, status: 401, error: "not signed in" }));
        if (!authorization.ok) {
          sendJson(response, authorization.status || 401, {
            ok: false,
            error: authorization.error || "not signed in",
          });
        } else {
          sendJson(response, 200, await uploads.receiveFilestore(request, response));
        }
      }
    }
    // Routine triggers: the public fire entry point (a bearer token, no session
    // cookie), and the `/v1/code/triggers` family the routines pages read. The
    // trigger collections are answered here for every deployment — the local
    // scheduled-task store is the only routine store this fork has.
    else if (url.pathname.startsWith("/v1/claude_code/routines/")
      || url.pathname.startsWith("/v1/code/triggers")
      || url.pathname === "/v1/code/organization/triggers"
      || url.pathname === "/v1/code/agents") {
      await handleRoutineApi(request, response, url);
    }
    // A tenant's Code runners, and the self-hosted pool API they speak — plus
    // the environment list that offers them as the only place a Code session can
    // run, and the whole session surface the Code page calls (the list, one
    // session's document and its edits, events and their stream, the list's
    // heartbeat probe and watch stream). Only on a tenant with the feature on
    // (see `codeRunners`); every other instance falls through to the app,
    // exactly as before. Anything under the session base this handler does not
    // answer is logged and 404s there, rather than being forwarded to an
    // upstream that has never heard of this session.
    else if (
      codeRunners
      && request.method === "POST"
      && (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")
    ) {
      // The runner's model calls — see handleInferencePassthrough. Ahead of the
      // session handler because the body must be forwarded verbatim, before
      // anything tries to parse it as JSON.
      await handleInferencePassthrough(request, response, url);
    }
    else if (
      codeRunners
      && (url.pathname.startsWith("/v1/code/runners/")
        || url.pathname.startsWith("/v1/code/sessions")
        || url.pathname.startsWith("/v1/code/auth/")
        || url.pathname.startsWith("/v1/sessions/")
        || url.pathname.startsWith("/v1/environment_providers/")
        || url.pathname === "/v1/environments"
        || /^\/v1\/environments\/[^/]+$/.test(url.pathname))
    ) {
      await handleCodeRunnerApi(request, response, url);
    }
    else if (url.pathname === "/manifest.json") {
      await serveStatic(response, "/manifest.webmanifest");
    } else if (localStaticFiles.has(url.pathname)) {
      await serveStatic(response, url.pathname);
    } else if (url.pathname.startsWith("/app-renderer/")) {
      // The browser's release-versioned module namespace. It follows the
      // session gate (unlike `/renderer/*`, which a login-shell proxy leaves
      // unauthenticated), so it reaches this account's own prepared renderer.
      await servePreparedRendererAsset(response,
        `/renderer/${url.pathname.slice("/app-renderer/".length)}`);
    } else if (url.pathname.startsWith("/renderer/")) {
      await servePreparedRendererAsset(response, url.pathname);
    } else if (
      officialAssetFiles.has(url.pathname)
      || officialAssetPrefixes.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      const upstream = await desktop.fetchRaw(
        url.pathname === "/desktop-icon.png" ? url.pathname : `/ion${url.pathname}`,
      );
      if (!upstream.ok) throw new ApiError(upstream.status, "official ion-dist asset not found");
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(200, {
        // `/assets/…` is the browser's whole module graph, and its URLs do not
        // change between patch releases. The bytes behind them do (the account
        // generation's patched chunks), so it must revalidate rather than be
        // cached immutably.
        "Cache-Control": "no-cache",
        "Content-Length": body.length,
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    } else if (url.pathname.startsWith("/v1/")) {
      // An API-shaped path this instance does not answer must never be handed
      // the app's HTML: a client reading the response as JSON classifies a
      // 200-of-HTML as an edge/upstream failure ("Service temporarily
      // unreachable"), which is exactly how a missing route disguised itself.
      // Answer in the API's own envelope, and say so in the log — an
      // unhandled request is a gap, not a page.
      console.warn(`[cowork-bridge] unhandled API request: ${request.method} ${url.pathname}`);
      sendJson(response, 404, { ok: false, error: `no route for ${request.method} ${url.pathname}` });
    } else {
      await serveOfficialIndex(request, response);
    }
  } catch (error) {
    const status = error.statusCode || (error.message === "not found" ? 404 : 500);
    if (isDocumentNavigation(request) && status >= 500) {
      sendDesktopReconnectPage(response);
    } else {
      sendJson(response, status, { ok: false, error: error.message });
    }
  }
});

// Node ends any request that takes longer than five minutes to arrive, which a
// large upload over a slow link can exceed. Headers must still arrive in time.
server.requestTimeout = 0;

server.listen(port, host, () => {
  console.log(`[cowork-bridge] listening on ${host}:${port}; internal=${coworkInternalUrl}`);
  console.log(`[cowork-bridge] download roots: ${downloadRoots.join(", ")}`);
  if (bridgeAuthEnabled) {
    if (!authIdentityUrl && !bridgeToken) {
      console.warn("[cowork-bridge] API auth is on but neither AUTH_IDENTITY_URL nor "
        + "CLAUDESK_BRIDGE_TOKEN is set; the API will refuse every request");
    } else if (!bridgeToken) {
      console.warn("[cowork-bridge] API auth is on without CLAUDESK_BRIDGE_TOKEN; "
        + "the mobile facade will be refused");
    }
    if (authIdentityUrl && !bridgeAccountEmail) {
      console.warn("[cowork-bridge] API auth is on without CLAUDE_REMOTE_ACCOUNT_EMAIL; "
        + "any account the shared authd knows can use this instance's API");
    }
  }
  // Only the env-configured list is known this early; with an auth service the
  // operator's list is read (and re-read) per request, so it is logged then.
  if (envMainModels.length) {
    console.log(`[cowork-bridge] model picker: ${envMainModels.length} main model(s) at the root: `
      + envMainModels.join(", "));
  }
  if (envConfiguredModel) {
    console.log(`[cowork-bridge] config health check probes ${envConfiguredModel}`
      + " (CLAUDE_CONFIGURED_MODEL; the admin page's setting wins when authd answers)");
  }
  console.log(
    `[cowork-bridge] session-file fallback on, cap ${sessionFileMaxBytes} bytes`
      + ` (requested ${sessionFileCapBytes}, memory limit ${sessionFileMemoryLimitBytes ?? "unknown"})`,
  );
  // Say it out loud, because this one is refused-silently-when-absent: a login
  // shell that is not actually in that mode looks like an ordinary instance, and
  // anything routed to it would be served the workspace instead of refused.
  if (loginShellEnabled) {
    console.log("[cowork-bridge] login shell: the whole API is refused; "
      + "only the renderer shell and its assets are served");
  }
});

// The node process is PID 1 in the container, so registering these is also what
// gets them run at all — and it buys the window this feature exists for. A
// browser's SSE subscription dies with the bridge, so the restart warning has to
// go out *before* we exit: broadcast it, hold while it flushes, then stop. A
// second signal (an impatient `docker kill`, or the grace period running out)
// exits at once.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    console.log(`[cowork-bridge] ${signal} again; exiting now`);
    process.exit(0);
  }
  shuttingDown = true;
  console.log(`[cowork-bridge] ${signal}: warning connected pages, exiting in ${shutdownNoticeMs}ms`);
  try {
    publishNotice(restartNotice, shutdownNoticeMs + 60 * 1000);
  } catch (error) {
    console.error(`[cowork-bridge] could not send the restart notice: ${error.message}`);
  }
  // A turn's last stream events are written to the store on a short debounce;
  // do not let the restart drop them.
  void codeRunners?.flush?.();
  setTimeout(() => process.exit(0), shutdownNoticeMs);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));

const realtimePoller = setInterval(() => void realtime.pollState(), 1000);
realtimePoller.unref();
const desktopEventPoller = setInterval(() => void realtime.pollDesktopEvents(), 500);
desktopEventPoller.unref();
const realtimeHeartbeat = setInterval(() => realtime.heartbeat(), 15000);
realtimeHeartbeat.unref();
notifications.start();

// --- Code session titles -----------------------------------------------------
// Desktop names its own Code sessions through a "stale-name check" that runs
// the CLI's `generate_session_title` control request — and that whole path is
// behind a feature gate which is OFF in self-hosted ("custom3p") mode, where
// Desktop ships empty statsig values and a hardcoded growthbook table without
// the gate. So a session started in the Desktop/browser UI keeps its first
// message as the title forever, silently (the check returns before it can log).
//
// The facade titles sessions the *phone* creates, via Desktop's own
// `/dust/generate_session_title` stub — Anthropic's title prompt and Desktop's
// default session model. This does the same for every other Code session: no
// custom prompt, no pinned model, just Desktop's generator invoked at the point
// Desktop's gate would have. Only sessions started after the bridge came up are
// considered, so a restart does not backfill (and pay for) the entire history.
//
// A session is a candidate while its title still reads as Desktop's copy of the
// first message — the injected `<system-reminder>` block stripped and a trailing
// truncation ellipsis ignored, both of which the first cut of this poller missed
// (so it named nothing). Once anything but that (or a user/agent rename) is
// there, the session is left alone.
const codeTitleSessionIds = new Set(); // desktop session ids already handled
const codeTitleStartedAt = Date.now();
let codeTitlePollInFlight = false;
const TITLE_DEVICE_ORG = "00000000-0000-4000-8000-000000000001";

// A user entry's own text, with Claude Code's injected context blocks removed.
// The first user message of a Code session is not just what the user typed:
// it opens with a `<system-reminder>` block (worktree, environment, skills).
// Desktop builds the title from the human part only, so leaving the reminder in
// made every such title look unrelated to "the first message" and the poller
// skipped the session it exists to name.
function userEntryText(content) {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block?.type === "text").map((block) => block.text || "").join("")
      : "";
  let text = raw;
  for (;;) {
    const leading = text.match(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/);
    if (!leading) break;
    text = text.slice(leading[0].length);
  }
  return text.replace(/\s+/g, " ").trim();
}

// Every non-empty user-message text in a transcript, in order; the first is the
// session's opening message, which is what Desktop's title is cut from.
function userMessageTexts(entries) {
  const texts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || entry.isMeta || entry.isSynthetic) continue;
    if (entry.type !== "user" && entry.message?.role !== "user") continue;
    const normalized = userEntryText(entry.message?.content);
    if (normalized) texts.push(normalized);
  }
  return texts;
}

// Desktop cuts the code title to fit and, when the cut lands mid-token (usually
// a URL), ends it with an ellipsis — "can you clone … into…". Strip that before
// the prefix test, or such a session never looks untitled. A title the user or
// the agent chose does not start the first message, which is the only thing
// this needs to tell apart.
function titleLooksLikeFirstMessage(title, firstMessage) {
  const current = String(title || "").replace(/\s+/g, " ").trim();
  if (!current) return true;
  const first = String(firstMessage || "").replace(/\s+/g, " ").trim();
  if (!first) return false;
  const cut = current.replace(/\s*(?:…|\.\.\.)\s*$/, "").trim() || current;
  return current === first || first.startsWith(current) || first.startsWith(cut);
}

async function generateCodeTitle(firstMessage, model) {
  const result = await desktop.protocol({
    method: "POST",
    pathname: `/api/organizations/${TITLE_DEVICE_ORG}/dust/generate_session_title`,
    search: "",
    headers: { "content-type": "application/json", accept: "application/json" },
    bodyBase64: Buffer.from(JSON.stringify({
      first_session_message: firstMessage,
      // Desktop's generator otherwise picks its own small "title" model, which
      // this gateway does not serve: the direct call comes back HTTP 403
      // ("Gateway rejected the configured credential") and the CLI fallback
      // exits 1, so no title is ever produced. Handing it a model the session
      // already runs on gives its retry a model that works. Chat titles have
      // always done this (the facade passes the conversation's model); the Code
      // path did not, which is why only Code sessions went untitled.
      ...(typeof model === "string" && model ? { model } : {}),
    })).toString("base64"),
  });
  const body = JSON.parse(Buffer.from(result?.bodyBase64 || "", "base64").toString("utf8"));
  return typeof body?.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
}

// The session as Desktop reports it RIGHT NOW, not a row from the list read
// that started this poll. The rename is applied only against this fresh read, so
// a stale row (or a transcript that read out of step with its id) can never
// rename a session that no longer looks like an untitled first turn — which is
// how an already-active chat got renamed with another chat's title.
async function freshSession(id) {
  try {
    return await desktop.invoke("LocalSessions", "getSession", [id]);
  } catch {
    return null;
  }
}

async function titleCodeSessions() {
  if (!codeActionsEnabled || codeTitlePollInFlight) return;
  codeTitlePollInFlight = true;
  try {
    const sessions = await desktop.invoke("LocalSessions", "getAll", []);
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const id = session?.sessionId;
      if (!id || session.isArchived || session.isRunning) continue;
      if (codeTitleSessionIds.has(id)) continue;
      // Existing-at-startup sessions are left as they are; only new ones are
      // titled, so a restart does not spawn a model call per historical session.
      const createdAt = Number(session.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < codeTitleStartedAt) {
        codeTitleSessionIds.add(id);
        continue;
      }
      if (session.titleSource === "user" || session.titleSource === "tool") {
        codeTitleSessionIds.add(id);
        continue;
      }
      let entries;
      try {
        entries = await desktop.invoke("LocalSessions", "getTranscript", [id]);
      } catch {
        continue; // not ready yet — look again next tick
      }
      const userTexts = userMessageTexts(entries);
      if (userTexts.length === 0) continue; // no first turn yet — look again
      const firstMessage = userTexts[0];
      // Fresh read before deciding: a session still running (or gone) is left
      // for the next tick rather than marked handled.
      const before = await freshSession(id);
      if (!before || before.isRunning || before.isArchived) continue;
      // Decided: from here the session is either renamed or left alone as-is.
      codeTitleSessionIds.add(id);
      // A title that no longer starts the first message was chosen by the user
      // or the agent; keep it. Everything else — empty, or Desktop's truncated
      // copy of the first message — is what this poller exists to replace, for
      // however many turns the session has run since. (The old rule "exactly one
      // user turn" threw away every session whose first turn had already been
      // followed up, which is most of them.)
      if (!titleLooksLikeFirstMessage(before.title, firstMessage)) continue;
      try {
        const title = await generateCodeTitle(firstMessage, titleModel || before.model || session.model);
        if (!title) {
          console.log(`[cowork-bridge] no title generated for code session ${id}`);
          continue;
        }
        // Re-read after the model call: if the session moved on (another turn,
        // a rename), leave it alone.
        const after = await freshSession(id);
        if (!after || after.isRunning || after.title === title) continue;
        if (!titleLooksLikeFirstMessage(after.title, firstMessage)) continue;
        await desktop.invoke("LocalSessions", "updateSession", [id, { title }]);
        console.log(`[cowork-bridge] titled code session ${id}: ${JSON.stringify(title)}`);
      } catch (error) {
        console.warn(`[cowork-bridge] could not title code session ${id}: ${error.message}`);
      }
    }
  } catch {
    // Desktop not reachable yet; the next tick retries.
  } finally {
    codeTitlePollInFlight = false;
  }
}
const codeTitlePoller = setInterval(() => void titleCodeSessions(), 5000);
codeTitlePoller.unref();

// `network_mode: service:claude-desktop` pins this container to the Desktop
// container's current network namespace. If Desktop restarts, Docker can leave
// an already-running dependent in the retired namespace. Exiting after
// repeated transport failures lets the existing restart policy reattach this
// process to the new namespace. HTTP errors still prove the namespace is
// reachable, so only connection-level fetch failures count.
let consecutiveInternalTransportFailures = 0;
const internalTransportMonitor = setInterval(async () => {
  try {
    await fetch(`${coworkInternalUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    consecutiveInternalTransportFailures = 0;
  } catch (error) {
    if (
      error?.name === "TimeoutError"
      || error?.name === "AbortError"
      || /aborted due to timeout/i.test(String(error?.message || ""))
    ) {
      // A responsive namespace can still have a temporarily busy Desktop
      // renderer. Restarting the bridge on request timeout tears down every
      // browser SSE subscription and turns a transient stall into a visible
      // realtime outage. Only transport failures such as ECONNREFUSED count
      // toward namespace reattachment.
      consecutiveInternalTransportFailures = 0;
      console.warn(`[cowork-bridge] internal health check timed out; keeping realtime clients connected: ${error.message}`);
      return;
    }
    consecutiveInternalTransportFailures += 1;
    console.error(
      `[cowork-bridge] internal transport unavailable (${consecutiveInternalTransportFailures}/${internalFailureExitThreshold}): ${error.message}`,
    );
    if (consecutiveInternalTransportFailures >= internalFailureExitThreshold) {
      console.error("[cowork-bridge] exiting to reattach to Claude Desktop network namespace");
      process.exit(1);
    }
  }
}, 10000);
internalTransportMonitor.unref();
