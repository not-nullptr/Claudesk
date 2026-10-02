#!/usr/bin/env node
// Manual probe (not part of validate.sh): drives the Desktop Claude Code
// (LocalSessions) IPC surface on a live Claudesk bridge and records what it
// actually returns, so the mobile facade's Code translators can be written
// against real shapes rather than guesses from the binary.
//
// The LocalSessions argument orders are NOT recoverable from the app binary
// (they are Electron IPC, not HTTP), so every call here tries a ladder of
// candidate argument arrays and records the first that passes Desktop's
// validation — the same "try until valid" trick the Chat probe uses for image
// shapes. It spends a few inference calls on the configured gateway and always
// deletes the session it created.
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
// --tools also asks for a shell command, which provokes a tool permission
// prompt so `respondToToolPermission` can be recorded.
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
  baseUrl: process.env.CLAUDE_MOBILE_DESKTOP_URL || "http://127.0.0.1:8080",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
const record = { surface: SURFACE, sessionId: null, steps: [], events: [], argShapes: {}, rejections: [], errors: [] };
const note = (name, value) => {
  record.steps.push({ name, atMs: Date.now() - startedAt, value });
  console.log(`[code-probe] ${name}`);
};

// Desktop rejects a wrong argument shape before doing any work, so a thrown
// validation error means "try the next candidate". Anything else propagates.
function isValidationError(error) {
  return /failed to pass validation|does not accept|invalid|must be/i.test(error?.message || "");
}

async function tryShapes(label, method, candidates) {
  for (const [index, candidate] of candidates.entries()) {
    try {
      const value = await client.ipc(SURFACE, method, candidate);
      record.argShapes[method] = {
        index,
        args: candidate,
        argCount: candidate.length,
        argTypes: candidate.map((item) => (Array.isArray(item) ? "array" : typeof item)),
        returned: value === undefined ? "__undefined__" : value,
      };
      note(`${label}: ${method} accepted shape ${index}`, { argCount: candidate.length });
      return value;
    } catch (error) {
      // The validation message names the argument Desktop wanted, so it is the
      // most useful thing this probe ever prints — keep it, do not swallow it.
      record.rejections.push({ label, method, index, args: candidate, message: error.message });
      if (!isValidationError(error)) {
        record.errors.push(`${label}: ${method} shape ${index} failed: ${error.message}`);
        throw error;
      }
      console.error(`[code-probe]   shape ${index} rejected: ${error.message}`);
      note(`${label}: ${method} shape ${index} rejected`, candidate.map((item) => typeof item));
    }
  }
  record.errors.push(`${label}: no ${method} shape passed validation`);
  return undefined;
}

// LocalSessions.onOnEvent and onOnToolPermissionRequest arrive on the same
// desktop-ipc SSE channel as Chat; filter by surface when reading `record.events`.
const subscription = client.subscribe({
  mode: "code",
  onEvent: (event) => record.events.push({ atMs: Date.now() - startedAt, ...event }),
  onReconnect: () => record.events.push({ atMs: Date.now() - startedAt, event: "__reconnect__" }),
});

// Real Code sessions use `local_<uuid>` — the prefix the Chat surface uses too,
// because the two are told apart by surface, not by id. The probe follows the
// real scheme so a create path that validates the id shape is not spuriously
// rejected. Cleanup is the `delete` in the finally block either way; the title
// only helps a person who has to tidy up by hand.
const sessionId = `local_${randomUUID()}`;
const probeTitle = "Claudesk code probe (safe to delete)";
let desktopSessionId = sessionId;

async function session() {
  return client.ipc(SURFACE, "getSession", [desktopSessionId]);
}

async function waitIdle(label, timeoutMs = 180000) {
  await sleep(1500);
  const deadline = Date.now() + timeoutMs;
  let sawSession = false;
  while (Date.now() < deadline) {
    const current = await session().catch(() => null);
    if (current) sawSession = true;
    if (current && (current.isRunning === false || current.status === "idle")) {
      await sleep(1500);
      return current;
    }
    await sleep(1000);
  }
  // A session that never appeared means the turn was never dispatched (a
  // rejected `start`), not that it is slow — say so rather than making the
  // reader guess why the probe paused for three minutes.
  record.errors.push(sawSession
    ? `${label}: still running after ${Math.round(timeoutMs / 1000)}s`
    : `${label}: no session was ever created, so nothing ran (check the start rejections above)`);
  return null;
}

try {
  // 1. getAll — what a Desktop Code session row looks like, and how Code rows
  //    are told apart from Chat/Cowork ones.
  const all = await tryShapes("getAll", "getAll", [[]]);
  record.getAll = Array.isArray(all)
    ? { count: all.length, keys: all.length ? Object.keys(all[0]) : [], sample: all.slice(0, 3) }
    : { value: all ?? null };
  note("getAll", { count: Array.isArray(all) ? all.length : null });

  // 2. start — the create shape. The phone's CreateSessionRequest maps onto this.
  //    The first round rejected every candidate with `Argument "info" at
  //    position 0 ... failed to pass validation`, so the shapes below lead with
  //    `info`-named objects (bare and nested), then fall back to the flat forms
  //    the Chat surface accepts and to the other plausible create entry points.
  const pong = "Reply with exactly one word: pong";
  const started = await tryShapes("start", "start", [
    [{ info: { sessionId, message: pong, messageUuid: randomUUID(), title: probeTitle } }],
    [{ info: { sessionId, message: pong, messageUuid: randomUUID(), sessionType: "code", title: probeTitle } }],
    [{ sessionId, message: pong, messageUuid: randomUUID(), title: probeTitle }],
    [{ sessionId, message: pong, messageUuid: randomUUID(), sessionType: "code", title: probeTitle }],
    [{ info: { sessionId } }, pong],
    [{ info: { sessionId, message: pong, messageUuid: randomUUID(), title: probeTitle }, sessionType: "code" }],
    [{ sessionId, prompt: pong }],
    [desktopSessionId, pong],
  ]);
  if (started === undefined) {
    // `start` may not be this surface's create path at all. The Code UI may
    // create through one of these instead, so record which the surface accepts
    // rather than guessing: a rejected call still tells us the real arg name.
    for (const method of ["createSession", "warmSession", "sendMessage", "getSessionsForScheduledTask"]) {
      const args = method === "sendMessage"
        ? [[{ info: { sessionId, message: pong, messageUuid: randomUUID(), title: probeTitle } }]]
        : method === "getSessionsForScheduledTask"
          ? [[], []]
          : [[{ sessionId, message: pong, messageUuid: randomUUID(), title: probeTitle }], [{ info: { sessionId } }]];
      await tryShapes(`create-fallback: ${method}`, method, args).catch(() => {});
    }
    throw new Error("start was rejected in every shape; the rest of the probe would only record a session that does not exist");
  }
  const afterStart = await waitIdle("start");
  note("start: session after turn", afterStart ?? null);
  if (afterStart) record.sessionId = afterStart.sessionId ?? afterStart.id ?? desktopSessionId;

  // 3. getSession — the detail record, whose field names map to SessionResource.
  const detail = await client.ipc(SURFACE, "getSession", [desktopSessionId]).catch((error) => {
    record.errors.push(`getSession: ${error.message}`);
    return null;
  });
  note("getSession", detail ?? null);

  // 4. getTranscript vs getTranscriptTail — the history source and its arg order.
  await tryShapes("getTranscript", "getTranscript", [
    [desktopSessionId],
    [desktopSessionId, {}],
    [desktopSessionId, 50],
    [desktopSessionId, { limit: 50 }],
  ]);
  await tryShapes("getTranscriptTail", "getTranscriptTail", [
    [desktopSessionId],
    [desktopSessionId, 50],
    [desktopSessionId, { limit: 50 }],
    [desktopSessionId, 0, 50],
  ]);

  // 5. sendMessage — does it return a message id or just an ack?
  const sentUuid = randomUUID();
  await tryShapes("sendMessage", "sendMessage", [
    [desktopSessionId, "Reply with exactly one word: pong", null, null, sentUuid],
    [desktopSessionId, "Reply with exactly one word: pong", sentUuid],
    [desktopSessionId, "Reply with exactly one word: pong"],
  ]);
  note("sendMessage: session after turn", await waitIdle("sendMessage"));

  // 6. setModel / setEffort / setPermissionMode — only needed if the composer sends them.
  const models = await client.chatModels().catch(() => null);
  note("chatModels (for a model id)", models ? { defaultModel: models.defaultModel } : null);
  if (models?.defaultModel) {
    await tryShapes("setModel", "setModel", [
      [desktopSessionId, models.defaultModel],
      [desktopSessionId, { model: models.defaultModel }],
    ]);
  }
  await tryShapes("setEffort", "setEffort", [
    [desktopSessionId, "low"],
    [desktopSessionId, { effort: "low" }],
  ]);
  await tryShapes("setPermissionMode", "setPermissionMode", [
    [desktopSessionId, "default"],
    [desktopSessionId, { mode: "default" }],
  ]);

  // 7. Tools: provoke a permission prompt and record its payload + how to answer.
  if (withTools) {
    const toolUuid = randomUUID();
    await tryShapes("tools: sendMessage", "sendMessage", [
      [desktopSessionId, "Run the shell command `echo code-probe-ok` and tell me exactly what it printed.", null, null, toolUuid],
      [desktopSessionId, "Run the shell command `echo code-probe-ok` and tell me exactly what it printed.", toolUuid],
    ]);
    // Give the prompt time to arrive on the listener before we answer.
    for (let waited = 0; waited < 20000; waited += 2000) {
      const prompt = record.events.find((event) => event?.data?.method === "onOnToolPermissionRequest");
      if (prompt) break;
      await sleep(2000);
    }
    const prompt = record.events.find((event) => event?.data?.method === "onOnToolPermissionRequest");
    record.permissionPrompt = prompt ?? null;
    const requestId = prompt?.data?.payload?.requestId ?? prompt?.data?.payload?.id ?? null;
    if (requestId) {
      await tryShapes("respondToToolPermission", "respondToToolPermission", [
        [desktopSessionId, requestId, "allow"],
        [requestId, "allow"],
        [desktopSessionId, requestId, { behavior: "allow" }],
        [{ requestId, behavior: "allow" }],
      ]);
    } else {
      record.errors.push("no tool permission prompt observed to answer");
    }
    note("tools: session after turn", await waitIdle("tools"));
  }

  // 8. interrupt — the stop path. No turn is running now, so this also records
  //    how Desktop answers an interrupt with nothing to interrupt.
  await tryShapes("interrupt", "interrupt", [[desktopSessionId], [desktopSessionId, "user_canceled"]]);
  await tryShapes("stop", "stop", [[desktopSessionId]]);
} catch (error) {
  record.errors.push(error.stack || String(error));
  console.error(`[code-probe] failed: ${error.message}`);
} finally {
  subscription.close();
  try {
    await client.ipc(SURFACE, "delete", [desktopSessionId]);
    console.log("[code-probe] deleted session");
  } catch (error) {
    record.errors.push(`cleanup delete failed: ${error.message}`);
    console.error(`[code-probe] could not delete ${desktopSessionId}: ${error.message}`);
  }
  await writeFile(out, JSON.stringify(record, null, 2));
  console.log(`[code-probe] wrote ${out} (${record.events.length} events, ${record.errors.length} errors)`);
}
process.exit(0);
