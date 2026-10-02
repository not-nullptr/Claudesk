#!/usr/bin/env node
// Manual probe (not part of validate.sh): opens one real Claude Code session on
// a live Claudesk bridge and records the two listener payloads the IPC *schema*
// does not describe — `onOnEvent` and `onOnToolPermissionRequest`.
//
// Why only that: Desktop's argument shapes are no longer a mystery. Its IPC
// schema is readable from the installed app's ASAR
// (/usr/lib/claude-desktop/resources/app.asar -> /.vite/build/index.chunk-*.js),
// where each interface registers as [method, [[param, validator], ...], result].
// The earlier version of this script brute-forced argument shapes instead; every
// shape it tried sent no `cwd`, which Desktop's `start` requires, so all of them
// failed identically and told us nothing. The shapes below are transcribed from
// that schema, not guessed.
//
// The listeners are still unknown, though: the types say nothing about the
// payload a relayed record carries, so this stays useful as a live smoke of the
// event framing (and doubles as a check that `start` works end to end).
//
//   CLAUDE_REMOTE_CODE_ACTIONS=1 \
//   CLAUDE_MOBILE_DESKTOP_URL=http://127.0.0.1:15821 \
//     node scripts/code-session-probe.mjs [--tools] [--out code-probe.json]
//
// The URL matters: inside the compose network the bridge is on :8080, but from
// the host it is published on ${COWORK_WEB_PORT:-15821} (compose.yaml). Pointing
// this at :8080 from the box gives "Claudesk bridge unreachable", which reads
// like a down service and is not.
//
// --tools also asks for a shell command, which provokes a tool permission prompt
// so `onOnToolPermissionRequest` is recorded. It spawns a session that is always
// deleted on the way out.
//
// Requires CLAUDE_REMOTE_CODE_ACTIONS=1 on both the Desktop and bridge services,
// otherwise every call fails with "Desktop IPC method is not allowed".
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createDesktopClient } from "../mobile/desktop-client.mjs";

const SURFACE = "LocalSessions";
const args = process.argv.slice(2);
const withTools = args.includes("--tools");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "/tmp/desktop-code-probe.json";
const client = createDesktopClient({
  baseUrl: process.env.CLAUDE_MOBILE_DESKTOP_URL || "http://127.0.0.1:15821",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
const record = { surface: SURFACE, sessionId: null, events: [], errors: [] };
const note = (name, value) => {
  record.steps ??= [];
  record.steps.push({ name, atMs: Date.now() - startedAt, value });
  console.log(`[code-probe] ${name}`);
};

// Both listeners arrive on the same desktop-ipc SSE channel; the surface field
// is what tells Code records from Chat ones.
const subscription = client.subscribe({
  mode: "code",
  onEvent: (event) => {
    record.events.push({ atMs: Date.now() - startedAt, ...event });
    const method = event?.data?.method;
    if (method) console.log(`[code-probe] event: ${method}`);
  },
  onReconnect: () => record.events.push({ atMs: Date.now() - startedAt, event: "__reconnect__" }),
});

const sessionId = `local_${randomUUID()}`;
const probeTitle = "Claudesk code probe (safe to delete)";

async function waitIdle(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await client.ipc(SURFACE, "getSession", [sessionId]).catch(() => null);
    if (current && current.isRunning === false) return current;
    await sleep(1000);
  }
  record.errors.push(`still running after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

try {
  // 1. The workspace folder Desktop wants a session to start in. `start` needs
  //    a `cwd`, and this is where Desktop itself gets one.
  const folders = await client.ipc(SURFACE, "getDefaultWorkspaceFolders", []).catch((error) => {
    record.errors.push(`getDefaultWorkspaceFolders: ${error.message}`);
    return null;
  });
  const cwd = (Array.isArray(folders) && folders.find((folder) => typeof folder === "string")) || "/workspace";
  note("default workspace folder", { folders, using: cwd });

  // 2. Start a real turn. `info` requires `cwd` and `message`; everything else
  //    is optional. The result validator says `{sessionId: string}`.
  const started = await client.ipc(SURFACE, "start", [{
    cwd,
    message: "Reply with exactly one word: pong",
    sessionId,
    title: probeTitle,
  }]);
  record.sessionId = started?.sessionId ?? sessionId;
  note("start", started ?? null);
  note("session after turn", (await waitIdle()) ?? null);

  // 3. `getTranscript` returns the raw entry array the events are built from.
  const transcript = await client.ipc(SURFACE, "getTranscript", [record.sessionId]).catch((error) => {
    record.errors.push(`getTranscript: ${error.message}`);
    return null;
  });
  record.transcript = Array.isArray(transcript)
    ? { count: transcript.length, keys: transcript.length ? Object.keys(transcript[0]) : [], sample: transcript.slice(0, 2) }
    : { value: transcript ?? null };
  note("getTranscript", { count: Array.isArray(transcript) ? transcript.length : null });

  // 4. `sendMessage` — does it return a message id or only an ack?
  const sentUuid = randomUUID();
  const sent = await client.ipc(SURFACE, "sendMessage", [record.sessionId, "Reply with exactly one word: pong", undefined, undefined, sentUuid]).catch((error) => {
    record.errors.push(`sendMessage: ${error.message}`);
    return null;
  });
  record.sendMessageReturned = sent ?? null;
  note("sendMessage returned", sent ?? null);
  note("session after sendMessage", (await waitIdle()) ?? null);

  // 5. Tools: provoke a permission prompt and record its payload + how to answer.
  if (withTools) {
    await client.ipc(SURFACE, "sendMessage", [
      record.sessionId,
      "Run the shell command `echo code-probe-ok` and tell me exactly what it printed.",
      undefined, undefined, randomUUID(),
    ]).catch((error) => record.errors.push(`tools: sendMessage: ${error.message}`));
    for (let waited = 0; waited < 30000; waited += 2000) {
      if (record.events.some((event) => event?.data?.method === "onOnToolPermissionRequest")) break;
      await sleep(2000);
    }
    const prompt = record.events.find((event) => event?.data?.method === "onOnToolPermissionRequest");
    record.permissionPrompt = prompt ?? null;
    const requestId = prompt?.data?.payload?.requestId ?? prompt?.data?.payload?.id ?? null;
    if (requestId) {
      // Desktop's signature is (requestId, decision) with decision in
      // once|always|deny — this is the live check of that contract.
      const answered = await client.ipc(SURFACE, "respondToToolPermission", [requestId, "once"]).catch((error) => {
        record.errors.push(`respondToToolPermission: ${error.message}`);
        return null;
      });
      note("respondToToolPermission", { requestId, answered: answered ?? null });
    } else {
      record.errors.push("no tool permission prompt observed to answer");
    }
    note("session after tools", (await waitIdle()) ?? null);
  }
} catch (error) {
  record.errors.push(error.stack || String(error));
  console.error(`[code-probe] failed: ${error.message}`);
} finally {
  subscription.close();
  try {
    await client.ipc(SURFACE, "delete", [record.sessionId]);
    console.log(`[code-probe] deleted ${record.sessionId}`);
  } catch (error) {
    record.errors.push(`cleanup delete failed: ${error.message}`);
    console.error(`[code-probe] could not delete ${record.sessionId}: ${error.message}`);
  }
  await writeFile(out, JSON.stringify(record, null, 2));
  console.log(`[code-probe] wrote ${out} (${record.events.length} events, ${record.errors.length} errors)`);
}
process.exit(0);
