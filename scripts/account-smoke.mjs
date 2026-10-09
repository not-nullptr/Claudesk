import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// A gateway deployment shows a synthetic account (the OS app user and an
// organization named "Gateway"). With the web shell on and the account env vars
// set, the bridge overrides just the identity fields on the Account and
// Organization documents the chrome reads, leaving uuids, settings and
// entitlements untouched. These checks pin the override-only semantics, the
// no-op reference stability, the membership/organization rewrite and the
// future-facing resolve seam, so a refactor cannot quietly clobber the rest of
// the account.
const serverSource = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

// The identity + override helpers, from the user-name line to the workspace root.
const identitySection = section(serverSource, "const remoteUserName =", "const workspaceRoot =");

function load(env = {}) {
  const sandbox = { process: { env } };
  vm.runInNewContext(`${identitySection}
    result = {
      identity: accountIdentity,
      configured: accountIdentityConfigured,
      resolve: resolveAccountIdentity,
      applyAccount: applyAccountIdentity,
      applyOrg: applyOrganizationIdentity,
    };`, sandbox);
  const r = sandbox.result;
  // Round-trip through this realm's JSON so strict deepEqual sees main-realm
  // objects; keep the raw functions for the reference-stability checks.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    identity: plain(r.identity),
    configured: (identity) => r.configured(identity),
    resolve: () => plain(r.resolve()),
    applyAccount: (account, identity) => plain(r.applyAccount(account, identity)),
    applyOrg: (organization, identity) => plain(r.applyOrg(organization, identity)),
    // Raw (unserialized) result for identity checks.
    applyAccountRaw: (account, identity) => r.applyAccount(account, identity),
    applyOrgRaw: (organization, identity) => r.applyOrg(organization, identity),
  };
}

const upstreamAccount = {
  uuid: "11111111-1111-1111-1111-111111111111",
  display_name: "app",
  full_name: "app",
  email_address: "",
  is_verified: true,
  settings: { enabled_web_search: false },
  memberships: [
    {
      role: "owner",
      organization: {
        uuid: "22222222-2222-2222-2222-222222222222",
        name: "Gateway",
        capabilities: ["chat", "cowork"],
        analytics_subscription_plan: "free",
        plan_display_name: "Gateway",
        settings: {},
      },
    },
  ],
};

// --- env parsing and configuration detection ---------------------------------
{
  const configured = load({
    CLAUDE_REMOTE_ACCOUNT_NAME: "  Ada Lovelace  ",
    CLAUDE_REMOTE_ACCOUNT_EMAIL: "ada@example.com",
    CLAUDE_REMOTE_ACCOUNT_ORG: "Home Lab",
    CLAUDE_REMOTE_ACCOUNT_PLAN: "Pro",
    CLAUDE_REMOTE_ACCOUNT_AVATAR: "https://example.com/a.png",
    CLAUDE_REMOTE_DEPLOYMENT_NAME: "Home Lab",
  });
  assert.deepEqual(configured.identity, {
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: "Home Lab",
    plan: "Pro",
    avatar: "https://example.com/a.png",
    deployment: "Home Lab",
  }, "env values are trimmed");
  assert.equal(configured.configured(configured.identity), true);
  assert.deepEqual(configured.resolve(), configured.identity,
    "resolveAccountIdentity returns the env identity");
}
{
  const bare = load({});
  assert.deepEqual(bare.identity, {
    name: "", email: "", organization: "", plan: "", avatar: "", deployment: "",
  });
  assert.equal(bare.configured(bare.identity), false, "an unset identity is not configured");
}

// --- override-only semantics -------------------------------------------------
{
  const configured = load({ CLAUDE_REMOTE_ACCOUNT_NAME: "Ada", CLAUDE_REMOTE_ACCOUNT_EMAIL: "ada@example.com" });
  const account = configured.applyAccount(upstreamAccount, configured.identity);
  assert.equal(account.display_name, "Ada");
  assert.equal(account.full_name, "Ada");
  assert.equal(account.email_address, "ada@example.com");
  assert.equal(account.uuid, upstreamAccount.uuid, "uuid is preserved");
  assert.deepEqual(account.settings, upstreamAccount.settings, "settings are preserved");
  assert.deepEqual(account.memberships[0].organization.capabilities, ["chat", "cowork"],
    "membership capabilities are preserved");
  assert.equal(account.memberships[0].organization.name, "Gateway",
    "the organization is left alone when only name/email are set");
}
{
  // Organization and plan override the membership's organization in place.
  const configured = load({ CLAUDE_REMOTE_ACCOUNT_ORG: "Home Lab", CLAUDE_REMOTE_ACCOUNT_PLAN: "Pro" });
  const account = configured.applyAccount(upstreamAccount, configured.identity);
  const organization = account.memberships[0].organization;
  assert.equal(organization.name, "Home Lab");
  assert.equal(organization.plan_display_name, "Pro");
  assert.equal(organization.uuid, "22222222-2222-2222-2222-222222222222", "org uuid is preserved");
  assert.deepEqual(organization.capabilities, ["chat", "cowork"], "org capabilities are preserved");
  assert.equal(account.display_name, "app", "name is left alone when only org/plan are set");
}
{
  // A pfp is the photo field (`avatar_image_url`), not the preset `avatar`
  // illustration index the client maps to a built-in SVG.
  const configured = load({ CLAUDE_REMOTE_ACCOUNT_AVATAR: "https://example.com/a.png" });
  const account = configured.applyAccount(upstreamAccount, configured.identity);
  assert.equal(account.avatar_image_url, "https://example.com/a.png");
  assert.equal(account.avatar, undefined, "the preset illustration index is not written");
}
{
  // Nothing to change: an unconfigured identity returns the same reference.
  const bare = load({});
  assert.equal(bare.applyAccountRaw(upstreamAccount, bare.identity), upstreamAccount,
    "an unconfigured identity is a no-op");
  // And a configured identity that already matches also returns the same object.
  const match = load({ CLAUDE_REMOTE_ACCOUNT_NAME: "app" });
  assert.equal(match.applyAccountRaw(upstreamAccount, match.identity), upstreamAccount,
    "an already-matching value is a no-op");
}

// --- organization document --------------------------------------------------
{
  const configured = load({ CLAUDE_REMOTE_ACCOUNT_ORG: "Home Lab", CLAUDE_REMOTE_ACCOUNT_PLAN: "Pro" });
  const upstreamOrg = {
    uuid: "22222222-2222-2222-2222-222222222222",
    name: "Gateway",
    capabilities: ["chat"],
    plan_display_name: "Gateway",
    settings: {},
  };
  const organization = configured.applyOrg(upstreamOrg, configured.identity);
  assert.equal(organization.name, "Home Lab");
  assert.equal(organization.plan_display_name, "Pro");
  assert.equal(organization.uuid, upstreamOrg.uuid);
  assert.deepEqual(organization.capabilities, ["chat"]);
  const bare = load({});
  assert.equal(bare.applyOrgRaw(upstreamOrg, bare.identity), upstreamOrg,
    "an unconfigured identity leaves the organization untouched");
}

// --- malformed input is ignored ---------------------------------------------
{
  const configured = load({ CLAUDE_REMOTE_ACCOUNT_NAME: "Ada" });
  assert.equal(configured.applyAccountRaw(null, configured.identity), null);
  assert.equal(configured.applyAccountRaw("nope", configured.identity), "nope");
  assert.equal(configured.applyOrgRaw(undefined, configured.identity), undefined);
}

console.log("account-smoke: ok");
