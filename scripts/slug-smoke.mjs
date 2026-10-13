import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// An account's resources are keyed by a slug derived from its email: the compose
// project (claudesk-<slug>), the container-name prefix and the data root
// ($CLAUDESK_DATA_ROOT/users/<slug>). provision-user.sh creates them and
// deprovision-user.sh removes them, so the two MUST derive the same slug — this
// pins scripts/lib/slug.sh, which both source, rather than either script's copy.
//
// It also pins the guard that matters for deprovision: a per-user project is
// named claudesk-<slug>, and the box gateway stack is pinned to the project name
// claudesk-gateway, so an account like gateway@… would slug to `gateway` and hand
// a teardown the gateway itself. deprovision-user.sh must refuse that, not plan it.

const here = fileURLToPath(new URL(".", import.meta.url));
const slugLib = join(here, "lib", "slug.sh");
const deprovision = join(here, "deprovision-user.sh");

function sh(script, ...args) {
  const result = spawnSync("/bin/sh", ["-c", script, "sh", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const slugFor = (email) => sh('. "$1"; claudesk_slug "$2"', slugLib, email);
const accepts = (slug) =>
  sh('. "$1"; claudesk_slug_ok "$2" && echo yes || echo no', slugLib, slug);

// --- derivation: ASCII-only, case-folded, edge dashes stripped --------------
assert.equal(slugFor("Ada.Lovelace@Example.COM"), "ada-lovelace-example-com");
assert.equal(slugFor("  spaced  @x "), "spaced-x");
assert.equal(slugFor("j@x"), "j-x");
assert.equal(slugFor("---"), "", "punctuation-only collapses to empty");

// --- the guard fails closed --------------------------------------------------
assert.equal(accepts("ada"), "yes");
assert.equal(accepts(""), "no", "an empty slug is never a valid account");
assert.equal(accepts("gateway"), "no", "the gateway stack's project name is reserved");

// --- end-to-end: the real script plans the matching project and data root ----
// Off a throwaway tree so the repo root's .env is not required or touched.
const root = mkdtempSync(join(tmpdir(), "claudesk-slug-"));
try {
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  writeFileSync(join(root, "scripts", "deprovision-user.sh"), readFileSync(deprovision));
  writeFileSync(join(root, "scripts", "lib", "slug.sh"), readFileSync(slugLib));
  writeFileSync(join(root, ".env"), `CLAUDESK_DATA_ROOT=${root}/data\n`);

  const dryRun = (email) =>
    spawnSync("/bin/sh", [join(root, "scripts", "deprovision-user.sh"), "--dry-run", email], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });

  const good = dryRun("Ada.Lovelace@Example.COM");
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /compose project claudesk-ada-lovelace-example-com/);
  assert.ok(
    good.stdout.includes(`would remove ${root}/data/users/ada-lovelace-example-com`),
    good.stdout,
  );

  // `gateway@` collapses to exactly the reserved slug: the '@' becomes a dash
  // and the trailing dash is stripped. authd's email check is only "contains
  // '@'", so this reaches the guard.
  assert.equal(slugFor("gateway@"), "gateway", "test input must hit the reserved slug");
  const reserved = dryRun("gateway@");
  assert.equal(reserved.status, 1, "a reserved slug must be refused, not planned");
  assert.match(reserved.stderr, /refusing reserved or empty slug/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("slug-smoke: slug derivation, reserved-slug guard and deprovision dry-run agree");
