#!/usr/bin/env node
// Manual probe (not part of validate.sh): drives one throwaway Chat session on
// a live Claudesk bridge and records what Desktop actually returns, so the
// mobile facade's translators can be written against real shapes. It spends a
// few inference calls on the configured gateway and always deletes the session.
//
//   CLAUDE_MOBILE_DESKTOP_URL=http://127.0.0.1:8080 \
//     node scripts/desktop-session-probe.mjs [--tools] [--out probe.json]
//
// --tools adds a turn that asks for a shell command. In Chat that may start the
// Cowork VM, so it is opt-in.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createDesktopClient } from "../mobile/desktop-client.mjs";

const args = process.argv.slice(2);
const withTools = args.includes("--tools");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "/tmp/desktop-probe.json";
const client = createDesktopClient({
  baseUrl: process.env.CLAUDE_MOBILE_DESKTOP_URL || "http://127.0.0.1:8080",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = `local_${randomUUID()}`;
const startedAt = Date.now();
const record = { sessionId, steps: [], events: [], errors: [] };
const note = (name, value) => {
  record.steps.push({ name, atMs: Date.now() - startedAt, value });
  console.log(`[probe] ${name}`);
};

const subscription = client.subscribe({
  mode: "chat",
  sessionId,
  onEvent: (event) => record.events.push({ atMs: Date.now() - startedAt, ...event }),
  onReconnect: () => record.events.push({ atMs: Date.now() - startedAt, event: "__reconnect__" }),
});

async function session() {
  return client.ipc("LocalAgentModeSessions", "getSession", [sessionId]);
}

async function waitIdle(label) {
  await sleep(1500);
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const current = await session().catch(() => null);
    if (current && current.isRunning === false) {
      await sleep(1500);
      return current;
    }
    await sleep(1000);
  }
  record.errors.push(`${label}: still running after 150s`);
  return null;
}

async function transcript() {
  return client.ipc("LocalAgentModeSessions", "getTranscript", [sessionId]);
}

function userEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const role = entry?.message?.role ?? entry?.role;
    return entry?.uuid && (entry.type === "user" || role === "user");
  });
}

async function send(label, message, extra = {}) {
  const messageUuid = randomUUID();
  const result = await client.ipc("LocalAgentModeSessions", "sendMessage", [
    sessionId,
    message,
    extra.images,
    extra.userSelectedFiles,
    messageUuid,
  ]);
  note(`${label}: sendMessage returned`, result ?? null);
  const idle = await waitIdle(label);
  note(`${label}: session after turn`, idle);
  note(`${label}: transcript`, await transcript());
  return messageUuid;
}

// Desktop validates `images` against a schema we cannot read, and a rejected
// shape fails before anything is sent, so try the shapes the renderer uses.
async function sendWithFirstValidImage(label, message, png) {
  const candidates = [
    { name: "probe.png", mimeType: "image/png", base64: png },
    { name: "probe.png", data: png, mimeType: "image/png" },
    { data: png, mimeType: "image/png" },
    { name: "probe.png", data: png, mediaType: "image/png" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
  ];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const uuid = await send(label, message, { images: [candidate] });
      record.imageShape = { index, keys: Object.keys(candidate) };
      return uuid;
    } catch (error) {
      if (!/failed to pass validation/.test(error.message)) throw error;
      note(`${label}: image shape ${index} rejected`, Object.keys(candidate));
    }
  }
  throw new Error("no image shape passed validation");
}

try {
  const { models, defaultModel } = await client.chatModels();
  note("models", { models, defaultModel });
  const model = models.find((item) => /haiku/i.test(item.id))?.id || defaultModel;
  if (!model) throw new Error("no chat model available");

  const firstUuid = randomUUID();
  const started = await client.ipc("LocalAgentModeSessions", "start", [{
    sessionId,
    message: "Reply with exactly one word: pong",
    messageUuid: firstUuid,
    model,
    title: "Claudesk probe (safe to delete)",
    sessionType: "chat",
    images: [],
    userSelectedFiles: [],
    userSelectedFolders: [],
    syntheticMessage: false,
    documentFunnelEnabled: false,
  }]);
  note("start returned", started ?? null);
  note("turn 1: session after turn", await waitIdle("turn 1"));
  note("turn 1: transcript", await transcript());

  // 1x1 PNG, passed the way the renderer builds image blocks.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const imageTurn = await sendWithFirstValidImage("image", "Describe this image in at most five words.", png);

  const uploaded = await client.upload([{ name: "probe-notes.txt", data: Buffer.from("The secret word is walrus.\n") }]);
  note("upload returned", uploaded);
  const fileTurn = await send("file", "What is the secret word in the attached file? Answer with one word.", {
    userSelectedFiles: uploaded.paths,
  });
  const fileAnswer = JSON.stringify(await transcript()).toLowerCase();
  record.fileAnswerMentionsWalrus = fileAnswer.split("walrus").length > 2;
  if (!record.fileAnswerMentionsWalrus) {
    // The Code composer references files by @"path" in the text instead.
    await send("file via mention", `@"${uploaded.paths[0]}"\nWhat is the secret word in that file? One word.`);
  }

  if (withTools) {
    await send("tools", "Run the shell command `echo probe-ok` and tell me exactly what it printed.");
  }

  const target = userEntries(await transcript()).find((entry) => entry.uuid === imageTurn)
    || userEntries(await transcript()).at(1);
  if (target) {
    const removed = await client.ipc("LocalAgentModeSessions", "rewind", [sessionId, target.uuid]);
    note("rewind returned", { targetUuid: target.uuid, imageTurn, fileTurn, removed: removed ?? null });
    note("rewind: session after", await session());
    note("rewind: transcript", await transcript());
  } else {
    record.errors.push("no user entry with a uuid found to rewind to");
  }
} catch (error) {
  record.errors.push(error.stack || String(error));
  console.error(`[probe] failed: ${error.message}`);
} finally {
  subscription.close();
  try {
    await client.ipc("LocalAgentModeSessions", "delete", [sessionId]);
    console.log("[probe] deleted session");
  } catch (error) {
    record.errors.push(`cleanup delete failed: ${error.message}`);
    console.error(`[probe] could not delete ${sessionId}: ${error.message}`);
  }
  await writeFile(out, JSON.stringify(record, null, 2));
  console.log(`[probe] wrote ${out} (${record.events.length} events, ${record.errors.length} errors)`);
}
process.exit(0);
