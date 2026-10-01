import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  console.log("updater-smoke: requires Linux shell; skipped on Windows");
  process.exit(0);
}
const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(await readFile(join(root, "config/release.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "claudesk-updater-"));
async function executable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}
try {
  for (const scenario of ["unknown", "success", "smoke-failure", "rollback-failure"]) {
    const project = join(temporary, scenario);
    const bin = join(project, "bin");
    for (const name of ["bin", "scripts", "config", "state"]) await mkdir(join(project, name), { recursive: true });
    await copyFile(join(root, "config/release.json"), join(project, "config/release.json"));
    await writeFile(join(project, ".env"), "CLAUDE_DESKTOP_VERSION=1.0.0\nCLAUDE_REMOTE_GATEWAY_SETTINGS=1\n");
    const updater = join(project, "scripts/monthly-update.sh");
    await executable(updater, (await readFile(join(root, "scripts/monthly-update.sh"), "utf8")).replaceAll("\r\n", "\n"));
    await executable(join(project, "scripts/chat-bridge-smoke.sh"),
      `#!/bin/sh\n${scenario.includes("failure") ? "exit 1" : "exit 0"}\n`);
    await executable(join(bin, "docker"), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),s=a.join(' ');
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
if(a[0]==='exec')console.log('1.0.0');
if(a[0]==='inspect')console.log(s.includes('Health')?'healthy':a[1]==='claude-desktop'?'sha256:original-desktop':'sha256:original-bridge');
if(s.includes('apt-cache policy'))console.log(process.env.CANDIDATE);
if(process.env.SCENARIO==='rollback-failure'&&a[0]==='tag'&&a[1].includes(':rollback-'))process.exit(1);
`);
    // Minimal jq mock for the updater's structured status writes; no external tools needed.
    await executable(join(bin, "jq"), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2);
if(a[0]==='-er')console.log(JSON.parse(fs.readFileSync(a[2],'utf8')).desktopVersion);
else{const o={};for(let i=0;i<a.length;i++)if(a[i]==='--arg'){o[a[i+1]]=a[i+2];i+=2;}console.log(JSON.stringify(o));}
`);
    const callsPath = join(project, "calls.jsonl");
    const result = spawnSync("sh", [updater], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: callsPath,
      CLAUDESK_UPDATE_STATE_DIR: join(project, "state"), SCENARIO: scenario,
      CANDIDATE: scenario === "unknown" ? "999.0.0" : release.desktopVersion,
    } });
    const log = await readFile(join(project, "state/monthly-update.log"), "utf8");
    assert.equal(result.status, scenario.includes("failure") ? 1 : 0, log);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    const status = JSON.parse(await readFile(join(project, "state/state.json"), "utf8"));
    if (scenario === "unknown") {
      assert.equal(status.outcome, "awaiting-compatibility-profile");
      assert.ok(!calls.some(a => ["build", "tag", "compose"].includes(a[0])));
    } else {
      assert.ok(calls.some(a => a[0] === "build" && a.includes(join(project, "bridge/Dockerfile"))));
      assert.ok(calls.some(a => a.includes("CLAUDE_REMOTE_GATEWAY_SETTINGS=1")));
      assert.ok(calls.some(a => a[0] === "tag" && a[1] === "sha256:original-desktop"));
      assert.ok(calls.some(a => a[0] === "tag" && a[1] === "sha256:original-bridge"));
      assert.equal(status.outcome, scenario === "success" ? "updated"
        : scenario === "smoke-failure" ? "rolled-back" : "rollback-failed");
      if (scenario === "smoke-failure") {
        assert.ok((await readFile(join(project, ".env"), "utf8")).includes("CLAUDE_DESKTOP_VERSION=1.0.0"));
        assert.ok(calls.some(a => a[0] === "tag" && a[1].startsWith("local/claude-cowork-bridge:rollback-")));
      }
    }
  }
  console.log("updater-smoke: deferral, paired promotion, rollback and recovery failure passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
