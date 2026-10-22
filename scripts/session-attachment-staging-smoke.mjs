#!/usr/bin/env node
// Desktop's own staging handler refuses every path with `disabled` when the app
// is in gateway (three-party) mode and has no self-hosted session-host URL —
// the shape that made a Code session's attachment fail as "Couldn't attach …
// to this session on your organization's session host. Try again." The wrapper's
// fallback copies the materialized files into the workspace the guest runner
// mounts, and only replaces Desktop's answer when it actually rescued something.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  maxFileBytes,
  maxFiles,
  maxTotalBytes,
  rescueDisabledStaging,
  stageName,
  stageSessionAttachments,
  stagingChannelSuffix,
  stagingFolder,
  wrapStagingIpc,
} from "../bridge-wrapper/session-attachments.cjs";

const fixtureRoot = await mkdtemp(join(tmpdir(), "claudesk-session-staging-smoke-"));
const pendingUploadsRoot = join(fixtureRoot, "pending-uploads");
const workspaceDirectory = join(fixtureRoot, "workspace");
const sessionId = "cse_0123456789ab_01ABCdefGHIjklMNOpqrSTUvwx";
const destinationDirectory = join(workspaceDirectory, stagingFolder, sessionId);
const uuidPrefix = "0f8fad5b-d9cb-469f-a165-70867728950e-";

const materialize = async (name, contents = name) => {
  await mkdir(pendingUploadsRoot, { recursive: true });
  const path = join(pendingUploadsRoot, `${uuidPrefix}${name}`);
  await writeFile(path, contents);
  return path;
};

try {
  // A browser file materializes as `<uuid>-<name>`; staging keeps the name the
  // person attached, not savePastedFile's bookkeeping prefix.
  const zip = await materialize("fig-file.zip", "zip bytes");
  const staged = await stageSessionAttachments({
    sessionId,
    paths: [zip],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.ok(staged, "a materialized attachment must stage");
  assert.deepEqual(staged.failed, []);
  assert.equal(staged.staged.length, 1);
  assert.equal(
    staged.staged[0].mountPath,
    join(destinationDirectory, "fig-file.zip"),
    "the mount path is the workspace path the guest sees",
  );
  assert.equal(basename(staged.staged[0].mountPath), "fig-file.zip");

  // Attaching the same name again keeps both files rather than overwriting the
  // first turn's copy.
  const second = await stageSessionAttachments({
    sessionId,
    paths: [await materialize("fig-file.zip", "second revision")],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.equal(second.staged[0].mountPath, join(destinationDirectory, "fig-file (2).zip"));

  // Paths outside the composer's materialization root are refused: this handler
  // must not become a way to copy arbitrary container files into the workspace.
  const outside = await stageSessionAttachments({
    sessionId,
    paths: ["/etc/passwd", join(pendingUploadsRoot, "..", "escape.txt")],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.deepEqual(outside, {
    staged: [],
    failed: [{ index: 0, reason: "invalid" }, { index: 1, reason: "invalid" }],
  });

  // Symlinks and directories are not attachments.
  const link = join(pendingUploadsRoot, `${uuidPrefix}link.txt`);
  await symlink(zip, link);
  const directory = join(pendingUploadsRoot, `${uuidPrefix}dir`);
  await mkdir(directory, { recursive: true });
  const notFiles = await stageSessionAttachments({
    sessionId,
    paths: [link, directory],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.deepEqual(notFiles.failed, [
    { index: 0, reason: "read" },
    { index: 1, reason: "read" },
  ]);

  // The composer's own bounds are re-checked here.
  const huge = join(pendingUploadsRoot, `${uuidPrefix}huge.bin`);
  await truncate(huge, maxFileBytes + 1).catch(async () => {
    await writeFile(huge, "");
    await truncate(huge, maxFileBytes + 1);
  });
  const tooLarge = await stageSessionAttachments({
    sessionId,
    paths: [huge],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.deepEqual(tooLarge.failed, [{ index: 0, reason: "too_large" }]);

  const many = [];
  for (let index = 0; index <= maxFiles; index += 1) {
    many.push(await materialize(`many-${index}.txt`));
  }
  assert.equal(
    await stageSessionAttachments({
      sessionId,
      paths: many,
      pendingUploadsRoot,
      workspaceDirectory,
    }),
    null,
    "more files than the composer sends are refused outright",
  );

  const total = [];
  for (let index = 0; index < 3; index += 1) {
    total.push(await materialize(`total-${index}.txt`, "0123456789"));
  }
  const overTotal = await stageSessionAttachments({
    sessionId,
    paths: total,
    pendingUploadsRoot,
    workspaceDirectory,
    limits: { maxTotalBytes: 25 },
  });
  assert.deepEqual(
    overTotal.failed,
    [{ index: 2, reason: "too_many" }],
    "the total-bytes cap refuses the file that would cross it",
  );
  assert.equal(overTotal.staged.length, 2);
  assert.equal(
    maxTotalBytes,
    500 * 1024 * 1024,
    "the production total cap is the composer's own",
  );

  // Session ids name a directory; malformed ones never reach the filesystem.
  for (const bad of ["", "../escape", "cse_../../etc", "local_0f8fad5b", "cse_"]) {
    assert.equal(
      await stageSessionAttachments({
        sessionId: bad,
        paths: [zip],
        pendingUploadsRoot,
        workspaceDirectory,
      }),
      null,
      `session id ${JSON.stringify(bad)} must be refused`,
    );
  }
  assert.equal(stageName(`/x/${uuidPrefix}a"b\nc.zip`), "a_b_c.zip");

  // --- Desktop's answer ---
  // Everything `disabled`: the paths are rescued, and the mount paths point
  // into the session's staging directory.
  const officialDisabled = {
    staged: [],
    failed: [
      { index: 0, reason: "disabled" },
      { index: 1, reason: "disabled" },
    ],
  };
  const rescueA = await materialize("rescue-a.txt", "a");
  const rescueB = await materialize("rescue-b.txt", "b");
  const rescued = await rescueDisabledStaging({
    official: officialDisabled,
    sessionId,
    paths: [rescueA, rescueB],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.ok(rescued, "an all-disabled answer must be replaced when staging succeeds");
  assert.deepEqual(rescued.staged.map((entry) => entry.index), [0, 1]);
  assert.equal(basename(rescued.staged[0].mountPath), "rescue-a.txt");
  assert.deepEqual(rescued.failed, []);

  // A real refusal (too large, unreadable) is never second-guessed.
  const partially = await rescueDisabledStaging({
    official: {
      staged: [],
      failed: [{ index: 0, reason: "too_large" }, { index: 1, reason: "disabled" }],
    },
    sessionId,
    paths: [rescueA, rescueB],
    pendingUploadsRoot,
    workspaceDirectory,
  });
  assert.deepEqual(partially.failed, [{ index: 0, reason: "too_large" }]);
  assert.deepEqual(partially.staged.map((entry) => entry.index), [1]);

  // Nothing to rescue: leave Desktop's own answer in place.
  assert.equal(await rescueDisabledStaging({
    official: { staged: [{ index: 0, mountPath: "/cloud/a" }], failed: [] },
    sessionId,
    paths: [rescueA],
    pendingUploadsRoot,
    workspaceDirectory,
  }), null);
  assert.equal(await rescueDisabledStaging({
    official: { staged: [], failed: [{ index: 0, reason: "invalid" }] },
    sessionId,
    paths: [rescueA],
    pendingUploadsRoot,
    workspaceDirectory,
  }), null);
  // A source that cannot be copied leaves the original refusal untouched.
  assert.equal(await rescueDisabledStaging({
    official: officialDisabled,
    sessionId,
    paths: ["/etc/passwd", "/etc/hosts"],
    pendingUploadsRoot,
    workspaceDirectory,
  }), null);

  // --- the IPC hook ---
  // Desktop registers the handler on the window's own endpoint; the wrapper's
  // replacement must pass every other channel and every working answer through.
  const handlers = new Map();
  const fakeIpc = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
  assert.equal(
    wrapStagingIpc(fakeIpc, { enabled: true, pendingUploadsRoot, workspaceDirectory }),
    true,
  );
  assert.equal(
    wrapStagingIpc(fakeIpc, { enabled: true, pendingUploadsRoot, workspaceDirectory }),
    false,
    "an endpoint is wrapped once",
  );
  let passthroughCalls = 0;
  fakeIpc.handle("probe_$_claude.web_$_Other_$_method", async () => {
    passthroughCalls += 1;
    return "untouched";
  });
  assert.equal(await handlers.get("probe_$_claude.web_$_Other_$_method")({}), "untouched");
  assert.equal(passthroughCalls, 1);

  const ipcChannel = `probe_$_claude.web_$_${stagingChannelSuffix}`;
  const hookedFile = await materialize("hooked.txt", "hooked bytes");
  fakeIpc.handle(ipcChannel, async () => ({
    staged: [],
    failed: [{ index: 0, reason: "disabled" }],
  }));
  const hooked = await handlers.get(ipcChannel)({}, sessionId, [hookedFile]);
  assert.deepEqual(hooked.failed, []);
  assert.equal(basename(hooked.staged[0].mountPath), "hooked.txt");

  fakeIpc.handle(ipcChannel, async () => ({
    staged: [{ index: 0, mountPath: "/cloud/hooked.txt" }],
    failed: [],
  }));
  assert.deepEqual(await handlers.get(ipcChannel)({}, sessionId, [hookedFile]), {
    staged: [{ index: 0, mountPath: "/cloud/hooked.txt" }],
    failed: [],
  });

  const unwrapped = {
    handle(channel, listener) {
      this.registered = listener;
    },
  };
  assert.equal(
    wrapStagingIpc(unwrapped, { enabled: false, pendingUploadsRoot, workspaceDirectory }),
    false,
    "the fallback does not exist where there is no runner",
  );

  console.log("session attachment staging smoke: ok");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
