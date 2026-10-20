import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainedFile, resolveDownloadTarget, sessionFileReadLimit } from "../bridge/downloads.mjs";

const MiB = 1024 * 1024;

// The cap the session reader will honour. A configured value above what the
// container can hold must be clamped, not obeyed: the DTO is assembled in
// memory several times over and an unclamped request OOM-looped the bridge.
assert.equal(
  sessionFileReadLimit({ requestedBytes: 1024 * MiB, memoryLimitBytes: 1024 * MiB }),
  32 * MiB,
  "a huge request is clamped to the absolute ceiling",
);
assert.equal(
  sessionFileReadLimit({ requestedBytes: 1024 * MiB, memoryLimitBytes: 256 * MiB }),
  16 * MiB,
  "a 256 MB container keeps enough heap for the DTO's several copies",
);
assert.equal(
  sessionFileReadLimit({ requestedBytes: 1024 * MiB, memoryLimitBytes: 64 * MiB }),
  4 * MiB,
  "a small container clamps below the absolute ceiling",
);
assert.equal(
  sessionFileReadLimit({ requestedBytes: 1024 * MiB, memoryLimitBytes: 4 * MiB }),
  2 * MiB,
  "the clamp has a floor so a tiny container can still open small files",
);
assert.equal(
  sessionFileReadLimit({ requestedBytes: 1 * MiB, memoryLimitBytes: 1024 * MiB }),
  1 * MiB,
  "a request under the clamp is honoured as written",
);
assert.equal(
  sessionFileReadLimit({}),
  10 * MiB,
  "with no cgroup limit and no request it matches Desktop's 10 MiB",
);
assert.equal(
  sessionFileReadLimit({ requestedBytes: 0, memoryLimitBytes: 0 }),
  10 * MiB,
  "unusable values fall back to the default rather than to zero",
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "claudesk-session-file-smoke-"));
try {
  const small = join(fixtureRoot, "small.txt");
  const big = join(fixtureRoot, "big.bin");
  await Promise.all([
    writeFile(small, "hello pane\n"),
    writeFile(big, Buffer.alloc(64)),
  ]);
  const roots = [fixtureRoot];
  const read = (target, maxBytes) => readContainedFile(roots, target, {
    maxBytes,
    allowRoot: false,
  });

  const ok = await read(small, MiB);
  assert.equal(ok.file.contents, "hello pane\n");
  assert.equal(ok.file.fileSize, 11);
  assert.match(ok.file.hash, /^[0-9a-f]{64}$/, "the DTO carries a sha256 of the text");

  // The size check runs on stat() alone, so an oversized file is never read
  // into memory at all -- that is what keeps the bridge off the OOM killer.
  const tooLarge = await read(big, 16);
  assert.equal(tooLarge.failure, "too_large");
  assert.equal(tooLarge.fileSize, 64);

  assert.equal((await read(join(fixtureRoot, "absent"), MiB)).failure, "not_found");
  assert.equal((await read(tmpdir(), MiB)).failure, "outside");
  assert.equal((await read(fixtureRoot, MiB)).failure, "outside");

  // The download route also serves agent paths that are relative to the
  // workspace ("folder/file.zip"): those must resolve inside a root, while an
  // absolute path and containment are unchanged.
  const nested = join(fixtureRoot, "folder");
  await mkdir(nested);
  await writeFile(join(nested, "file.zip"), "zip bytes");
  const download = (target) => resolveDownloadTarget([fixtureRoot], target, {
    allowRoot: false,
    missingMessage: "download file was not found",
    outsideMessage: "path is outside the allowed read roots",
  });
  assert.ok((await download("folder/file.zip")).endsWith(join("folder", "file.zip")),
    "a relative download path resolves against the read root");
  assert.ok((await download(small)).endsWith("small.txt"),
    "an absolute download path is unchanged");
  await assert.rejects(download("absent.txt"), /download file was not found/);
  await assert.rejects(download("../../etc/passwd"), /outside the allowed read roots/,
    "a relative path that climbs out of the root is refused");

  // A Cowork session's deliverables live under Desktop's userData rather than
  // a configured root (`<sessionId>/<…>/outputs/…`), and a model's file card
  // links straight to them. The outputs directory is part of the session by
  // Desktop's own consent rule, so it is readable here too; the memory tree
  // beside it, and a symlink aiming at it, are not.
  const sessionsRoot = await mkdtemp(join(tmpdir(), "claudesk-sessions-smoke-"));
  try {
    const sessionJob = join(sessionsRoot, "23bfc495", "00000000", "d42a0257");
    const outputsDir = join(sessionJob, "outputs");
    const memoryDir = join(sessionJob, "memory");
    await Promise.all([
      mkdir(outputsDir, { recursive: true }),
      mkdir(memoryDir, { recursive: true }),
    ]);
    const report = join(outputsDir, "Unit16_Assignment_A1_Report_Template.docx");
    const memoryFile = join(memoryDir, "feedback.md");
    await Promise.all([
      writeFile(report, "docx bytes"),
      writeFile(memoryFile, "remember"),
    ]);
    const outputsOptions = {
      allowRoot: false,
      sessionOutputsRoot: sessionsRoot,
      missingMessage: "download file was not found",
      outsideMessage: "path is outside the allowed read roots",
    };
    assert.equal(
      await resolveDownloadTarget(roots, report, outputsOptions),
      await realpath(report),
      "a file card under the session's outputs directory is downloadable",
    );
    const outputRead = await readContainedFile(roots, report, {
      maxBytes: MiB,
      ...outputsOptions,
    });
    assert.equal(outputRead.file.contents, "docx bytes",
      "the session-file reader serves an outputs file too");
    await assert.rejects(
      resolveDownloadTarget(roots, memoryFile, outputsOptions),
      /outside the allowed read roots/,
      "the memory tree beside outputs stays outside the readable roots",
    );
    await assert.rejects(
      resolveDownloadTarget(roots, report, { allowRoot: false }),
      /outside the allowed root/,
      "outputs are not readable unless the sessions root is configured",
    );
    await symlink(memoryFile, join(outputsDir, "alias.md"));
    await assert.rejects(
      resolveDownloadTarget(roots, join(outputsDir, "alias.md"), outputsOptions),
      /outside the allowed read roots/,
      "a symlink in outputs cannot reach the memory tree",
    );

    process.stdout.write("session-file-smoke: read limit, guard, download-path and outputs checks passed\n");
  } finally {
    await rm(sessionsRoot, { force: true, recursive: true });
  }
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
}
