import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The writable-layer upgrade path: a container booting a rebuilt image must
// upgrade the Desktop package into its persistent layer in place — keeping
// every runtime-installed package — before the wrapper's version guard runs.
// The real script is exercised end to end against stub dpkg/apt binaries, so
// its decision table (already current, no variable, packaged copy, repository
// fallback, dependency repair, failed upgrade) is pinned without a container.
const source = await readFile(new URL(
  "../rootfs/etc/cont-init.d/19-claude-package-sync.sh", import.meta.url), "utf8");
const temporary = await mkdtemp(join(tmpdir(), "claudesk-package-sync-"));
try {
  const bin = join(temporary, "bin");
  const stateFile = join(temporary, "installed");
  const callsFile = join(temporary, "calls.log");
  const packagePath = join(temporary, "claude-desktop_2.31226.1_amd64.deb");
  await mkdir(bin);

  // Stubs record every invocation; dpkg/apt "apply" $STUB_NEW to the state
  // file so the script's own verification step sees a real outcome.
  const stub = (name, body) => writeFile(join(bin, name),
    `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_CALLS"\n${body}\n`,
    { mode: 0o755 });
  await stub("dpkg-query", 'cat "$STUB_STATE"');
  await stub("dpkg", `[ "\${1:-}" = "-i" ] || exit 1
[ "\${STUB_DPKG_FAIL:-0}" = "1" ] && exit 1
[ "\${STUB_FLIP:-1}" = "0" ] && exit 0
printf '%s' "\${STUB_NEW:-9.9.9}" > "$STUB_STATE"`);
  await stub("apt-get", `seen=0
for argument in "$@"; do
  case "$argument" in
    claude-desktop=*) printf '%s' "\${argument#claude-desktop=}" > "$STUB_STATE"; seen=1 ;;
  esac
done
[ "$seen" = "1" ] || printf '%s' "\${STUB_NEW:-9.9.9}" > "$STUB_STATE"`);

  const rewritten = source.replace("package=/opt/claude-desktop-package.deb",
    `package=${packagePath}`);
  assert.notEqual(rewritten, source, "the package path line must be present to rewrite");
  const scriptPath = join(temporary, "19-claude-package-sync.sh");
  await writeFile(scriptPath, rewritten, { mode: 0o755 });

  function run(env = {}) {
    return spawnSync("sh", [scriptPath], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, STUB_CALLS: callsFile,
        STUB_STATE: stateFile, ...env },
    });
  }
  async function reset(installed) {
    await writeFile(stateFile, installed);
    await writeFile(callsFile, "");
  }
  const calls = async () => (await readFile(callsFile, "utf8")).trim();

  // Already current: only the version read runs, nothing is installed.
  await reset("2.31226.1");
  let result = run({ CLAUDE_DESKTOP_VERSION: "2.31226.1" });
  assert.equal(result.status, 0, result.stderr);
  const currentCalls = await calls();
  assert.ok(!currentCalls.includes("dpkg -i") && !currentCalls.includes("apt-get"),
    "a current container must not install anything");
  assert.equal(result.stdout, "", "a current container must not log");

  // No requested version: nothing to reconcile.
  await reset("2.31226.1");
  result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await calls(), "");

  // The image's own package copy upgrades the writable layer in place.
  await reset("2.9939.4");
  await writeFile(packagePath, "deb");
  result = run({ CLAUDE_DESKTOP_VERSION: "2.31226.1", STUB_NEW: "2.31226.1" });
  assert.equal(result.status, 0, result.stderr);
  const localCalls = await calls();
  assert.ok(localCalls.includes(`dpkg -i ${packagePath}`),
    "the image's packaged copy must be installed directly");
  assert.ok(!localCalls.includes("apt-get"), "no repository round trip when the copy exists");
  assert.ok(result.stdout.includes("now installed in the writable layer"));

  // Images built before the stash fall back to the signed repository, and a
  // downgrade (rollback) is permitted.
  await rm(packagePath);
  await reset("2.31226.1");
  result = run({ CLAUDE_DESKTOP_VERSION: "2.9939.4", STUB_NEW: "2.9939.4" });
  assert.equal(result.status, 0, result.stderr);
  const remoteCalls = await calls();
  assert.ok(remoteCalls.includes("apt-get update"), "the repository is refreshed");
  assert.ok(remoteCalls.includes("apt-get install -y --allow-downgrades claude-desktop=2.9939.4"),
    "the exact version is installed and downgrades are allowed");

  // A package whose dependencies the old layer lacks is repaired via apt.
  await writeFile(packagePath, "deb");
  await reset("2.9939.4");
  result = run({ CLAUDE_DESKTOP_VERSION: "2.31226.1", STUB_NEW: "2.31226.1", STUB_DPKG_FAIL: "1" });
  assert.equal(result.status, 0, result.stderr);
  const repairCalls = await calls();
  assert.ok(repairCalls.includes(`dpkg -i ${packagePath}`) && repairCalls.includes("apt-get install -y -f"),
    "a failed dpkg run must be repaired through apt, not abandoned");

  // If the layer still does not carry the requested version, boot must stop
  // with the versions named rather than let the wrapper guard report a
  // confusing mismatch.
  await reset("2.9939.4");
  result = run({ CLAUDE_DESKTOP_VERSION: "2.31226.1", STUB_FLIP: "0" });
  assert.equal(result.status, 1, "an ineffective upgrade must fail the boot");
  assert.ok(result.stderr.includes("ERROR: Desktop is 2.9939.4 after the upgrade attempt"),
    `expected the versions in stderr, got: ${result.stderr}`);

  console.log("package-sync-smoke: in-place upgrade, fallback and failure paths passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
