import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// A brand-new Code session's first `start` can go out before Desktop knows the
// project folder the picker's permission mode is stored against, so the first
// turn ran Manual. The bridge fills the stored pick in on `start` (see
// fillStoredStartPermissionMode in bridge/server.mjs); this checks that fill,
// including its refusal to override a mode the composer did choose.
const source = await readFile(new URL("../bridge/server.mjs", import.meta.url), "utf8");
const section = source.slice(
  source.indexOf("const folderPermissionModeCache"),
  source.indexOf("\nasync function handleApi"),
);

const account = "f51b5a2b-f1ee-45ee-8184-f6a0f2c18a8e";
const prefs = {
  epitaxyPrefs: {
    [`epitaxy-folder-permission-mode.${account}`]: {
      "/workspace/Claudesk": "bypassPermissions",
      "/workspace/manual-only": "default",
    },
    "epitaxy-perm-mode-acks": [`${account}:bypass`],
    "cc-landing-draft-permission-mode": null,
  },
};
let reads = 0;
const api = vm.runInNewContext(`${section}\n({ fillStoredStartPermissionMode, storedFolderPermissionModes, worktreeRepoRoot })`, {
  desktop: { invokeSettings: async (surface, method, args) => { reads++; assert.equal(surface, "AppPreferences"); assert.equal(method, "getPreferences"); assert.equal(args.length, 0); return prefs; } },
  undefinedSentinelKey: "__claudeRemoteUndefinedV1",
  console: { log() {} },
  Date,
});

async function start(info, options) {
  const args = [info];
  await api.fillStoredStartPermissionMode(args, options);
  return args[0];
}

// The pick stored for the repo root is applied to a session running in a
// worktree of that repo, which is exactly the case that came out Manual.
let info = await start({ cwd: "/workspace/Claudesk/.claude/worktrees/wt-1", message: "hi" });
assert.equal(info.permissionMode, "bypassPermissions", "a worktree start inherits the repo folder pick");

// A direct repo path works too.
info = await start({ cwd: "/workspace/Claudesk", message: "hi" });
assert.equal(info.permissionMode, "bypassPermissions", "a repo-root start inherits the folder pick");

// A mode the composer chose is never overridden.
info = await start({ cwd: "/workspace/Claudesk", message: "hi", permissionMode: "plan" });
assert.equal(info.permissionMode, "plan", "an explicit pick wins");

// The renderer's failsafe while its stored layers have not settled is the
// literal string "default", which is what a brand-new session's first `start`
// actually carried. The browser UI's call passes defaultMeansNoChoice, so the
// stored pick fills in.
info = await start({ cwd: "/workspace/Claudesk/.claude/worktrees/wt-2", message: "hi", permissionMode: "default" }, { defaultMeansNoChoice: true });
assert.equal(info.permissionMode, "bypassPermissions", "the renderer's failsafe default is filled from the folder pick");

// The mobile facade's own Manual pick is the same string and must be left
// alone: it does not set defaultMeansNoChoice.
info = await start({ cwd: "/workspace/Claudesk", message: "hi", permissionMode: "default" });
assert.equal(info.permissionMode, "default", "a facade Manual pick is not overridden");

// An absent mode arrives as the transport's undefined sentinel, not a missing
// key; that still means the composer chose nothing, so the fill applies.
info = await start({ cwd: "/workspace/Claudesk", message: "hi", permissionMode: { __claudeRemoteUndefinedV1: true } });
assert.equal(info.permissionMode, "bypassPermissions", "the undefined sentinel counts as no choice");

// A folder with no stored pick is left alone (Manual stays Manual).
info = await start({ cwd: "/workspace/elsewhere", message: "hi" });
assert.equal(info.permissionMode, undefined, "a folder with no stored pick is untouched");

// Only the stored mode for that folder, never another folder's.
info = await start({ cwd: "/workspace/manual-only", message: "hi" });
assert.equal(info.permissionMode, "default", "the pick stored for that folder is what fills in");

// Odd shapes must not throw.
for (const bad of [undefined, null, "start", 7, [], [{}]]) {
  await api.fillStoredStartPermissionMode(bad === undefined ? undefined : [bad]);
}

assert.equal(api.worktreeRepoRoot("/workspace/repo/.claude/worktrees/wt"), "/workspace/repo");
assert.equal(api.worktreeRepoRoot("/workspace/repo"), "/workspace/repo");

await api.storedFolderPermissionModes();
assert.equal(reads, 1, "the folder picks are read once and cached");
console.log("start-permission-mode-smoke: first-turn permission mode filled from the stored folder pick");
