import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The persistent-root overlay and pivot_root need CAP_SYS_ADMIN, but nothing
// after them does. The entrypoint must drop it from the bounding set before the
// image command starts: otherwise a tenant that reaches the container (or an
// agent through its IPC) holds mount/pivot_root/setns, the classic host-escape
// primitive. Persistence is unaffected — the overlay is already the root.
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = readFileSync(`${root}persistent-root-entrypoint.sh`, "utf8");
const compose = readFileSync(`${root}compose.yaml`, "utf8");

const pivot = entry.indexOf("pivot_root . .oldroot");
const drop = entry.indexOf("exec setpriv");
assert.ok(pivot > 0, "the entrypoint pivots into the persistent root");
assert.ok(drop > pivot, "SYS_ADMIN is dropped after the pivot");
assert.ok(entry.trimEnd().endsWith('-- "$@"'),
  "the setpriv drop is the last thing the entrypoint does");
assert.match(entry, /--bounding-set=-sys_admin/,
  "the drop removes SYS_ADMIN from the bounding set");
assert.match(entry, /--inh-caps=-sys_admin/,
  "and from the inheritable set");
assert.match(entry, /command -v setpriv/,
  "a missing setpriv fails closed instead of launching privileged");
assert.match(entry, /CLAUDESK_KEEP_SYS_ADMIN/,
  "the debug override exists");

assert.match(compose, /cap_add:\n      - SYS_ADMIN/,
  "the container still receives SYS_ADMIN for the setup");
assert.match(compose, /CLAUDESK_KEEP_SYS_ADMIN: "\$\{CLAUDESK_KEEP_SYS_ADMIN:-0\}"/,
  "the override is passed to the container");

process.stdout.write("container-cap-smoke: SYS_ADMIN is setup-only\n");
