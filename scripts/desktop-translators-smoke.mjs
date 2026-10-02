#!/usr/bin/env node
// Checks the Desktop-transcript and Desktop-event translators against data
// recorded from a live Claudesk bridge (scripts/desktop-session-probe.mjs). The
// fixture covers a plain turn, an image turn that used a tool, a file turn the
// model could not see, and a file turn referenced by an @"path" mention.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTurnTranslator } from "../mobile/events.mjs";
import { isHumanEntry, splitMentions, transcriptToMessages } from "../mobile/transcript.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/desktop-chat-probe.json", import.meta.url), "utf8"));
const { sessionId, transcript, events } = fixture;

// ---- transcript -> messages ----
const humans = transcript.filter(isHumanEntry);
assert.equal(humans.length, 4, "tool results and isMeta notes are not human turns");

const { messages, leaf, lastHumanUuid } = transcriptToMessages(transcript);
assert.equal(messages.length, 8);
assert.deepEqual(messages.map((message) => message.sender), [
  "human", "assistant", "human", "assistant", "human", "assistant", "human", "assistant",
]);
assert.deepEqual(messages.map((message) => message.index), [0, 1, 2, 3, 4, 5, 6, 7]);
assert.equal(messages[0].uuid, humans[0].uuid, "human message uuids are Desktop's");
assert.equal(messages[0].parent_uuid, null);
for (let index = 1; index < messages.length; index += 1) {
  assert.equal(messages[index].parent_uuid, messages[index - 1].uuid, `message ${index} chains to the previous one`);
}
const text = (message) => message.content.map((part) => part.text).join("");
assert.equal(text(messages[0]), "Reply with exactly one word: pong");
assert.equal(text(messages[1]), "pong");
assert.equal(text(messages[2]), "Describe this image in at most five words.");
assert.equal(text(messages[3]), "Red dot on white background.", "thinking, tool calls and results are not shown");
assert.equal(text(messages[7]), "walrus");
assert.ok(messages.every((message) => !/signature|\[Image: source/.test(JSON.stringify(message.content))));
assert.equal(messages[3].stop_reason, "end_turn");
assert.equal(leaf, messages[7].uuid);
assert.equal(lastHumanUuid, humans[3].uuid);

// An @"path" mention becomes an attachment, not message text.
assert.equal(text(messages[6]), "What is the secret word in that file? One word.");
assert.equal(messages[6].attachments.length, 1);
assert.equal(messages[6].attachments[0].file_name, "probe-notes.txt");
assert.match(messages[6].attachments[0].path, /^\/workspace\/RemoteUploads\/[0-9a-f-]+\/probe-notes\.txt$/);
assert.deepEqual(splitMentions('@"/a/b.txt"\n@"/c d/e.zip"\nhello'), { text: "hello", files: ["/a/b.txt", "/c d/e.zip"] });
assert.deepEqual(splitMentions("no mention @\"inline\" here"), { text: 'no mention @"inline" here', files: [] });

// The uuid the mobile client chose for an assistant message wins when known.
const chosen = "11111111-1111-4111-8111-111111111111";
const renamed = transcriptToMessages(transcript, {
  assistantUuidFor: (humanUuid) => (humanUuid === humans[0].uuid ? chosen : undefined),
}).messages;
assert.equal(renamed[1].uuid, chosen);
assert.equal(renamed[2].parent_uuid, chosen, "the next human message chains to the chosen uuid");
assert.notEqual(renamed[3].uuid, chosen);

// A turn that has not produced an assistant entry yet has only its human message.
const pending = transcriptToMessages(transcript.slice(0, 1));
assert.equal(pending.messages.length, 1);
assert.equal(pending.leaf, humans[0].uuid);
assert.deepEqual(transcriptToMessages([]).messages, []);
assert.deepEqual(transcriptToMessages(undefined).messages, []);

// ---- native events -> canonical streaming events ----
function runTurn(humanUuid, { assistantUuid = `assistant-${humanUuid.slice(0, 8)}`, forSession = sessionId } = {}) {
  const translator = createTurnTranslator({ sessionId: forSession, humanUuid, assistantUuid, model: "test-model" });
  const out = [];
  for (const { payload } of events) out.push(...translator.accept(payload));
  return { translator, out, assistantUuid };
}

const kinds = (out) => out.map((item) => item.event);
for (const [index, human] of humans.entries()) {
  const { translator, out, assistantUuid } = runTurn(human.uuid);
  const label = `turn ${index + 1}`;
  assert.equal(kinds(out).filter((kind) => kind === "message_start").length, 1, `${label}: one message_start`);
  assert.equal(kinds(out).filter((kind) => kind === "message_stop").length, 1, `${label}: one message_stop`);
  assert.equal(kinds(out)[0], "message_start");
  assert.equal(kinds(out).at(-1), "message_stop");
  assert.equal(kinds(out).at(-2), "message_delta");
  assert.equal(out[0].data.message.uuid, assistantUuid);
  assert.equal(out[0].data.message.parent_uuid, human.uuid);
  assert.ok(translator.finished && !translator.error, label);
  assert.equal(translator.stopReason, "end_turn");

  // Content block indices are contiguous from 0, every opened block is closed,
  // and only text is surfaced (no thinking or tool_use).
  const starts = out.filter((item) => item.event === "content_block_start");
  const stops = out.filter((item) => item.event === "content_block_stop");
  assert.deepEqual(starts.map((item) => item.data.index), starts.map((_, position) => position), `${label}: contiguous indices`);
  assert.equal(stops.length, starts.length, `${label}: blocks are closed`);
  assert.ok(starts.every((item) => item.data.content_block.type === "text"));
  const streamed = out
    .filter((item) => item.event === "content_block_delta")
    .map((item) => item.data.delta.text)
    .join("");
  assert.equal(streamed, translator.text);
  assert.equal(streamed, text(messages[index * 2 + 1]), `${label}: streamed text matches the stored transcript`);
}

// Events for other sessions or other turns are ignored.
assert.deepEqual(runTurn(humans[0].uuid, { forSession: "local_other" }).out, []);
const foreign = createTurnTranslator({ sessionId, humanUuid: "not-this-turn", assistantUuid: "a" });
for (const { payload } of events) assert.deepEqual(foreign.accept(payload), []);
assert.equal(foreign.finished, false);

// A failed turn still closes the stream and reports the error.
const failing = createTurnTranslator({ sessionId, humanUuid: "h", assistantUuid: "a" });
const failed = failing.accept({
  type: "message",
  sessionId,
  userMessageUuid: "h",
  message: { type: "result", subtype: "error_during_execution", is_error: true, result: "boom" },
});
assert.deepEqual(kinds(failed), ["message_start", "message_delta", "message_stop"]);
assert.equal(failing.error?.message, "boom");
assert.deepEqual(failing.accept({ type: "message", sessionId, message: { type: "result", subtype: "success" } }), [], "nothing after the result");

// complete() finishes a turn whose live stream was missed.
const live = (partial) => ({ type: "message", sessionId, userMessageUuid: "h", message: partial });
const streamEvent = (event) => live({ type: "stream_event", event });

const scratch = createTurnTranslator({ sessionId, humanUuid: "h", assistantUuid: "a" });
assert.deepEqual(kinds(scratch.complete("hello")), [
  "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
]);
assert.equal(scratch.text, "hello");
assert.ok(scratch.finished);
assert.deepEqual(scratch.complete("again"), [], "nothing after the turn has finished");

const partial = createTurnTranslator({ sessionId, humanUuid: "h", assistantUuid: "a" });
partial.accept(streamEvent({ type: "message_start", message: { model: "m" } }));
partial.accept(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
partial.accept(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }));
const rest = partial.complete("hello");
assert.deepEqual(kinds(rest), ["content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
assert.equal(rest[0].data.delta.text, "lo");
assert.equal(rest[0].data.index, 0, "the open block is continued, not a new one");
assert.equal(partial.text, "hello");

const mismatch = createTurnTranslator({ sessionId, humanUuid: "h", assistantUuid: "a" });
mismatch.accept(streamEvent({ type: "message_start", message: { model: "m" } }));
mismatch.accept(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
mismatch.accept(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }));
assert.deepEqual(kinds(mismatch.complete("xyz")), ["content_block_stop", "message_delta", "message_stop"]);
assert.equal(mismatch.text, "hel", "streamed text is never rewritten");

// A result that arrives with a block still open closes it first.
const dangling = createTurnTranslator({ sessionId, humanUuid: "h", assistantUuid: "a" });
dangling.accept(streamEvent({ type: "message_start", message: { model: "m" } }));
dangling.accept(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
assert.deepEqual(
  kinds(dangling.accept(live({ type: "result", subtype: "success", stop_reason: "end_turn" }))),
  ["content_block_stop", "message_delta", "message_stop"],
);

console.log("desktop-translators-smoke: transcript and live-event translation match the recorded Desktop data");
