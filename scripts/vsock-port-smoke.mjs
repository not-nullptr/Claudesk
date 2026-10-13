import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Cowork VM's vsock port is a compile-time constant in both halves of the
// pair (the host helper listens, the guest dials). This pins the tool that moves
// it: find a port loaded as a `mov $imm32,%e?x` immediate, rewrite it, and refuse
// anything that does not match the expected shape — a half-patched pair is worse
// than none, because the guest would be pointed at whichever helper still holds
// the default port.
const tool = new URL("../rootfs/opt/claude-cowork-bridge/patch-vsock-port.mjs", import.meta.url);

function run(...args) {
  const result = spawnSync(process.execPath, [tool.pathname, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// A synthetic artifact: `mov $51234,%ebx` twice, plus `mov $51234,%eax` once, in
// otherwise inert bytes.
function fixture() {
  const buffer = Buffer.alloc(4096, 0x90);
  buffer.writeUInt8(0xbb, 100); buffer.writeUInt32LE(51234, 101);
  buffer.writeUInt8(0xbb, 2000); buffer.writeUInt32LE(51234, 2001);
  buffer.writeUInt8(0xb8, 3000); buffer.writeUInt32LE(51234, 3001);
  return buffer;
}

const dir = await mkdtemp(join(tmpdir(), "claudesk-vsock-"));
const file = join(dir, "fixture.bin");
await writeFile(file, fixture());

// scan reports every encoding it can see.
const scanned = run("scan", "--file", file, "--encoding", "all");
assert.equal(scanned.status, 0, `scan failed: ${scanned.stderr}`);
assert.match(scanned.stdout, /^bb:51234\t2\t/m, "two %ebx sites");
assert.match(scanned.stdout, /^b8:51234\t1\t/m, "one %eax site");

// check reports the site count without writing.
const checked = run("check", "--file", file, "--port", 52010, "--expect", 2);
assert.equal(checked.status, 0, `check failed: ${checked.stderr}`);
assert.equal(checked.stdout, "patchable\t2");

// patch rewrites exactly the %ebx sites and leaves the %eax one alone.
const patched = run("patch", "--file", file, "--port", 52010, "--expect", 2);
assert.equal(patched.status, 0, `patch failed: ${patched.stderr}`);
assert.equal(patched.stdout, "patched\t2");
const bytes = await readFile(file);
assert.equal(bytes.readUInt8(100), 0xbb);
assert.equal(bytes.readUInt32LE(101), 52010, "first site rewritten");
assert.equal(bytes.readUInt32LE(2001), 52010, "second site rewritten");
assert.equal(bytes.readUInt32LE(3001), 51234, "the other encoding is untouched");

// Re-running is a no-op, not a second rewrite.
const again = run("patch", "--file", file, "--port", 52010, "--expect", 2);
assert.equal(again.stdout, "already\t2");

// A wrong expectation is refused, so a changed layout stops the deploy instead of
// patching part of it.
await writeFile(file, fixture());
const wrong = run("patch", "--file", file, "--port", 52010, "--expect", 3);
assert.equal(wrong.status, 2, "a mismatched site count fails");
assert.match(wrong.stderr, /expected 3 site/);
assert.equal((await readFile(file)).readUInt32LE(101), 51234, "nothing was written");

// An artifact with no such constant is reported, not guessed at.
await writeFile(file, Buffer.alloc(64, 0x90));
const absent = run("patch", "--file", file, "--port", 52010, "--expect", 1);
assert.equal(absent.status, 1);
assert.equal(absent.stdout, "absent\t0");

// If the real helper is on this machine, the same call must move its one site —
// this is the site the app really loads, so it pins the encoding and the count.
const helper = "/usr/lib/claude-desktop/resources/cowork-linux-helper";
if (existsSync(helper)) {
  const copy = join(dir, "helper");
  await writeFile(copy, await readFile(helper));
  const result = run("patch", "--file", copy, "--port", 52010, "--default", 51234, "--expect", 1);
  assert.equal(result.status, 0, `helper patch failed: ${result.stderr}`);
  assert.equal(result.stdout, "patched\t1");
  const handle = await open(copy, "r");
  try {
    const probe = Buffer.alloc(5);
    await handle.read(probe, 0, 5, 1347708);
    assert.equal(probe.readUInt8(0), 0xbb, "the helper's site is a %ebx load");
    assert.equal(probe.readUInt32LE(1), 52010);
  } finally {
    await handle.close();
  }
  const original = await readFile(helper);
  assert.equal(original.readUInt32LE(1347709), 51234, "the installed helper is untouched");
}

// The boot script's orchestration: copy, patch, bind-mount. `mount`/`mountpoint`
// are stubbed on PATH so the run needs no privileges, and the script reports
// through them.
const init = new URL("../rootfs/etc/cont-init.d/22-cowork-vsock-port.sh", import.meta.url);
const bin = join(dir, "bin");
await mkdir(bin, { recursive: true });
const mountLog = join(dir, "mounts");
const stub = (name, body) => writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
await stub("mountpoint", 'echo "$1" >> "$MOUNT_LOG"; exit 1');
await stub("mount", 'echo "mount $*" >> "$MOUNT_LOG"; exit 0');
await stub("umount", 'echo "umount $*" >> "$MOUNT_LOG"; exit 0');

const helperSource = existsSync(helper) ? helper : null;
if (helperSource) {
  const fakeHelper = join(dir, "resources-helper");
  await writeFile(fakeHelper, await readFile(helperSource));
  const scriptRun = spawnSync("/bin/sh", [init.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOUNT_LOG: mountLog,
      CLAUDESK_VM_VSOCK_PORT: "52011",
      CLAUDESK_VM_VSOCK_PATCHER: tool.pathname,
      CLAUDESK_VM_VSOCK_HELPER: fakeHelper,
      CLAUDESK_VM_VSOCK_STATE: join(dir, "state"),
    },
  });
  assert.equal(scriptRun.status, 0, `cont-init failed: ${scriptRun.stderr}`);
  assert.match(scriptRun.stdout, /vsock port set to 52011/);
  const patchedHelper = join(dir, "state", "cowork-linux-helper");
  assert.equal((await readFile(patchedHelper)).readUInt32LE(1347709), 52011,
    "the persistent copy carries the new port");
  assert.equal((await readFile(fakeHelper)).readUInt32LE(1347709), 51234,
    "the installed helper is left as the image shipped it");
  const mounts = await readFile(mountLog, "utf8");
  assert.match(mounts, new RegExp(`^mount --bind ${dir}/state/cowork-linux-helper ${fakeHelper}$`, "m"),
    "the patched copy is bind-mounted over the original path");

  // A port equal to the default changes nothing.
  const noop = spawnSync("/bin/sh", [init.pathname], {
    encoding: "utf8",
    env: { ...process.env, CLAUDESK_VM_VSOCK_PORT: "51234" },
  });
  assert.equal(noop.status, 0);
  assert.match(noop.stdout, /is the default/);
}

// A port that is not a number is refused before anything is touched.
const invalid = spawnSync("/bin/sh", [init.pathname], {
  encoding: "utf8",
  env: { ...process.env, CLAUDESK_VM_VSOCK_PORT: "nope" },
});
assert.equal(invalid.status, 1);
assert.match(invalid.stderr, /must be a port number/);

console.log("vsock-port-smoke: ok");
