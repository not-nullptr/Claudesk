#!/usr/bin/env node
// Checks the Desktop-transcript and Desktop-event translators, and the tool
// presentation built on them, against data recorded from a live Claudesk bridge:
//   desktop-chat-probe.json   plain turns, an image turn whose Read call was
//                             refused, and a file turn
//   desktop-tools-probe.json  a Bash turn and a web search turn
// (recorded by scripts/desktop-session-probe.mjs and a throwaway Chat session).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BLOCK, RUN, ROW, SUMMARY, bardSegments, describeTool, messageText, resultText, restThinking, restToolResult, restToolUse,
} from "../mobile/blocks.mjs";
import { createTurnTranslator } from "../mobile/events.mjs";
import { isHumanEntry, splitMentions, transcriptToMessages } from "../mobile/transcript.mjs";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const probe = await load("desktop-chat-probe.json");
const tools = await load("desktop-tools-probe.json");

const kinds = (out) => out.map((item) => item.event);
const text = (message) => messageText(message);
// What matters about a block, independent of timestamps.
const shape = (blocks) => blocks.map((block) => {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking" };
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "tool_result", id: block.tool_use_id, name: block.name, error: block.is_error, text: block.content[0].text };
});

function liveTurn(fixture, humanUuid, options = {}) {
  const translator = createTurnTranslator({
    sessionId: fixture.sessionId,
    humanUuid,
    assistantUuid: `assistant-${humanUuid.slice(0, 8)}`,
    model: "test-model",
    ...options,
  });
  const out = [];
  for (const { payload } of fixture.events) out.push(...translator.accept(payload));
  return { translator, out };
}

// ---- transcript -> messages ----
const humans = probe.transcript.filter(isHumanEntry);
assert.equal(humans.length, 4, "tool results and isMeta notes are not human turns");

const { messages, leaf, lastHumanUuid } = transcriptToMessages(probe.transcript);
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
assert.equal(text(messages[0]), "Reply with exactly one word: pong");
assert.equal(text(messages[1]), "pong");
assert.equal(text(messages[2]), "Describe this image in at most five words.");
assert.equal(text(messages[3]), "Red dot on white background.");
assert.equal(text(messages[7]), "walrus");
assert.ok(messages.every((message) => !JSON.stringify(message.content).includes("<signature>")), "the opaque signature is not forwarded");
assert.equal(messages[3].stop_reason, "end_turn");
assert.equal(leaf, messages[7].uuid);
assert.equal(lastHumanUuid, humans[3].uuid);

// The image turn: Desktop saved the image and the model tried to Read it, which was refused.
assert.deepEqual(messages[3].content.map((block) => block.type), ["thinking", "tool_use", "tool_result", "thinking", "text"]);
const readUse = messages[3].content.find((block) => block.type === "tool_use");
const readResult = messages[3].content.find((block) => block.type === "tool_result");
assert.equal(readUse.name, "view", "Read is presented under claude.ai's file-view name");
assert.match(readUse.input.file_path, /images\/1\.png$/);
assert.equal(readResult.tool_use_id, readUse.id);
assert.equal(readResult.is_error, true);
assert.match(readResult.content[0].text, /outside this session's scratch directory/);
assert.deepEqual(messages[1].content.map((block) => block.type), ["thinking", "text"], "reasoning comes before the answer");
const reasoning = messages[1].content[0];
assert.equal(reasoning.type, "thinking");
assert.ok(reasoning.thinking.length > 20);
assert.deepEqual(reasoning.summaries, []);
assert.equal(reasoning.cut_off, false);
assert.ok(reasoning.start_timestamp && reasoning.stop_timestamp);
assert.ok(!("signature" in reasoning));

// An @"path" mention becomes an attachment, not message text.
assert.equal(text(messages[6]), "What is the secret word in that file? One word.");
assert.equal(messages[6].attachments.length, 1);
assert.equal(messages[6].attachments[0].file_name, "probe-notes.txt");
assert.match(messages[6].attachments[0].path, /^\/workspace\/RemoteUploads\/[0-9a-f-]+\/probe-notes\.txt$/);
assert.deepEqual(splitMentions('@"/a/b.txt"\n@"/c d/e.zip"\nhello'), { text: "hello", files: ["/a/b.txt", "/c d/e.zip"] });
assert.deepEqual(splitMentions("no mention @\"inline\" here"), { text: 'no mention @"inline" here', files: [] });

// toolBlocks: false and thinking: false are the escape hatches.
const textOnly = transcriptToMessages(probe.transcript, { toolBlocks: false, thinking: false }).messages;
assert.deepEqual(textOnly[3].content.map((block) => block.type), ["text"]);
assert.equal(text(textOnly[3]), "Red dot on white background.");
assert.deepEqual(
  transcriptToMessages(probe.transcript, { thinking: false }).messages[3].content.map((block) => block.type),
  ["tool_use", "tool_result", "text"],
);
assert.deepEqual(
  transcriptToMessages(probe.transcript, { toolBlocks: false }).messages[3].content.map((block) => block.type),
  ["thinking", "thinking", "text"],
);

// The uuid the mobile client chose for an assistant message wins when known.
const chosen = "11111111-1111-4111-8111-111111111111";
const renamed = transcriptToMessages(probe.transcript, {
  assistantUuidFor: (humanUuid) => (humanUuid === humans[0].uuid ? chosen : undefined),
}).messages;
assert.equal(renamed[1].uuid, chosen);
assert.equal(renamed[2].parent_uuid, chosen, "the next human message chains to the chosen uuid");
assert.notEqual(renamed[3].uuid, chosen);

// A turn that has not produced an assistant entry yet has only its human message.
const pending = transcriptToMessages(probe.transcript.slice(0, 1));
assert.equal(pending.messages.length, 1);
assert.equal(pending.leaf, humans[0].uuid);
assert.deepEqual(transcriptToMessages([]).messages, []);
assert.deepEqual(transcriptToMessages(undefined).messages, []);

// ---- the live stream matches the stored transcript, turn by turn ----
let streamedReasoning = 0;
for (const [name, fixture] of [["chat", probe], ["tools", tools]]) {
  const turnHumans = fixture.transcript.filter(isHumanEntry);
  const stored = transcriptToMessages(fixture.transcript).messages.filter((message) => message.sender === "assistant");
  assert.equal(stored.length, turnHumans.length);
  for (const [index, human] of turnHumans.entries()) {
    const label = `${name} turn ${index + 1}`;
    const { translator, out } = liveTurn(fixture, human.uuid);
    assert.deepEqual(kinds(out).filter((kind) => kind === "message_start"), ["message_start"], `${label}: one message_start`);
    assert.deepEqual(kinds(out).filter((kind) => kind === "message_stop"), ["message_stop"], `${label}: one message_stop`);
    assert.equal(kinds(out)[0], "message_start");
    assert.deepEqual(kinds(out).slice(-2), ["message_delta", "message_stop"]);
    assert.equal(out[0].data.message.uuid, `assistant-${human.uuid.slice(0, 8)}`);
    assert.equal(out[0].data.message.parent_uuid, human.uuid);
    assert.ok(translator.finished && !translator.error, label);
    assert.equal(translator.stopReason, "end_turn");

    // Indices are contiguous from 0 and every block that opens is closed.
    const starts = out.filter((item) => item.event === "content_block_start");
    const stops = out.filter((item) => item.event === "content_block_stop");
    assert.deepEqual(starts.map((item) => item.data.index), starts.map((_, position) => position), `${label}: contiguous indices`);
    assert.deepEqual([...stops.map((item) => item.data.index)].sort((a, b) => a - b), starts.map((_, position) => position), `${label}: blocks are closed`);
    assert.deepEqual(starts.map((item) => item.data.content_block.type), translator.blocks.map((block) => block.type));

    // The stream and the transcript describe the same assistant message.
    assert.deepEqual(shape(translator.blocks), shape(stored[index].content), `${label}: live blocks equal stored blocks`);
    // The fixtures keep only the first few thinking deltas of a recording, so live
    // reasoning is a prefix of (not equal to) the stored text.
    translator.blocks.forEach((block, position) => {
      if (block.type !== "thinking") return;
      const full = stored[index].content[position].thinking;
      assert.ok(full.startsWith(block.thinking), `${label}: reasoning streams from the start`);
      assert.ok(block.stop_timestamp, `${label}: reasoning is closed`);
      streamedReasoning += block.thinking.length;
    });
    const streamedText = out
      .filter((item) => item.event === "content_block_delta" && item.data.delta.type === "text_delta")
      .map((item) => item.data.delta.text)
      .join("");
    assert.equal(streamedText, translator.text);
    assert.equal(translator.text, stored[index].content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  }
}

assert.ok(streamedReasoning > 0, "reasoning is streamed, not only stored");

// ---- Bash and web search, as recorded ----
const toolHumans = tools.transcript.filter(isHumanEntry);
const toolMessages = transcriptToMessages(tools.transcript).messages;
const [bashAnswer, searchAnswer] = [toolMessages[1], toolMessages[3]];
const kindsOf = (message) => message.content.map((block) => block.type);
const pick = (message, type) => message.content.find((block) => block.type === type);
assert.deepEqual(kindsOf(bashAnswer), ["thinking", "tool_use", "tool_result", "thinking", "text"]);
assert.equal(pick(bashAnswer, "tool_use").name, "bash_tool", "the shell is presented as bash_tool");
assert.equal(pick(bashAnswer, "tool_use").input.command, "echo probe-ok && uname -s");
assert.equal(pick(bashAnswer, "tool_result").content[0].text, "probe-ok\nLinux\n");
assert.equal(pick(bashAnswer, "tool_result").is_error, false);
assert.match(text(bashAnswer), /probe-ok/);
assert.match(bashAnswer.content[0].thinking, /shell command/i, "the reasoning before the call is kept");
// Stored reasoning is timed from the entry before it (the prompt, or a tool result) to its own entry.
const thinkingEntries = tools.transcript.filter((entry) => entry.message?.content?.some?.((block) => block.type === "thinking"));
assert.equal(bashAnswer.content[0].start_timestamp, toolHumans[0].timestamp, "the first reasoning block starts at the prompt");
assert.equal(bashAnswer.content[0].stop_timestamp, thinkingEntries[0].timestamp);
const bashResultEntry = tools.transcript.find((entry) => entry.message?.content?.some?.((block) => block.type === "tool_result"));
assert.equal(bashAnswer.content[3].start_timestamp, bashResultEntry.timestamp, "reasoning after a tool call starts at its result");
assert.ok(Date.parse(bashAnswer.content[3].stop_timestamp) >= Date.parse(bashAnswer.content[3].start_timestamp));
assert.deepEqual(kindsOf(searchAnswer), ["thinking", "tool_use", "tool_result", "thinking", "text"]);
assert.equal(pick(searchAnswer, "tool_use").name, "web_search");
assert.match(pick(searchAnswer, "tool_use").input.query, /Node\.js/);
assert.match(pick(searchAnswer, "tool_result").content[0].text, /^Web search results for query/);

// The live stream carries the tool input as it is typed.
const bashLive = liveTurn(tools, toolHumans[0].uuid);
const toolStart = bashLive.out.find((item) => item.event === "content_block_start" && item.data.content_block.type === "tool_use");
assert.deepEqual(toolStart.data.content_block.input, {}, "a tool call opens with an empty input");
assert.equal(toolStart.data.content_block.name, "bash_tool");
const jsonDeltas = bashLive.out.filter((item) => item.event === "content_block_delta" && item.data.delta.type === "input_json_delta");
assert.equal(JSON.parse(jsonDeltas.map((item) => item.data.delta.partial_json).join("")).command, "echo probe-ok && uname -s");
const resultStart = bashLive.out.find((item) => item.event === "content_block_start" && item.data.content_block.type === "tool_result");
assert.equal(resultStart.data.content_block.tool_use_id, toolStart.data.content_block.id);

// The reasoning streams as thinking_delta events.
const thinkingStart = bashLive.out.find((item) => item.event === "content_block_start" && item.data.content_block.type === "thinking");
assert.equal(thinkingStart.data.index, 0, "reasoning comes first");
assert.equal(thinkingStart.data.content_block.thinking, "");
const thinkingDeltas = bashLive.out.filter((item) => item.event === "content_block_delta" && item.data.delta.type === "thinking_delta");
assert.ok(thinkingDeltas.length > 0 && thinkingDeltas.every((item) => typeof item.data.delta.thinking === "string"));
assert.equal(bashLive.translator.blocks[0].thinking, thinkingDeltas.filter((item) => item.data.index === 0).map((item) => item.data.delta.thinking).join(""));
assert.ok(!JSON.stringify(bashLive.out).includes("signature"), "the signature is never forwarded");

// The switches: neither streams the hidden kind.
const noThinking = liveTurn(tools, toolHumans[0].uuid, { thinking: false });
assert.deepEqual([...new Set(noThinking.translator.blocks.map((block) => block.type))].sort(), ["text", "tool_result", "tool_use"]);
const noTools = liveTurn(tools, toolHumans[0].uuid, { toolBlocks: false });
assert.deepEqual([...new Set(noTools.translator.blocks.map((block) => block.type))].sort(), ["text", "thinking"]);
const hidden = liveTurn(tools, toolHumans[0].uuid, { toolBlocks: false, thinking: false });
assert.ok(hidden.out.filter((item) => item.event === "content_block_start").every((item) => item.data.content_block.type === "text"));
assert.equal(hidden.translator.blocks.length, 1);
assert.match(hidden.translator.text, /probe-ok/);

// version moves on every change, so watchers hear about reasoning as it arrives.
const versioned = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
const seen = [versioned.version];
const feed = (event) => { versioned.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "stream_event", event } }); seen.push(versioned.version); };
feed({ type: "message_start", message: {} });
feed({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
feed({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } });
feed({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "m" } });
assert.deepEqual(seen.slice(1).map((value, position) => value > seen[position]), [false, true, true, true]);
assert.equal(versioned.blocks[0].thinking, "hmm");

// Events for other sessions or other turns are ignored, and so is a sub-agent.
const other = createTurnTranslator({ sessionId: "local_other", humanUuid: humans[0].uuid, assistantUuid: "a" });
for (const { payload } of probe.events) assert.deepEqual(other.accept(payload), []);
const foreign = createTurnTranslator({ sessionId: probe.sessionId, humanUuid: "not-this-turn", assistantUuid: "a" });
for (const { payload } of probe.events) assert.deepEqual(foreign.accept(payload), []);
assert.equal(foreign.finished, false);
const sub = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
assert.deepEqual(sub.accept({
  type: "message", sessionId: "s", userMessageUuid: "h",
  message: { type: "stream_event", parent_tool_use_id: "toolu_parent", event: { type: "message_start", message: {} } },
}), [], "sub-agent traffic is ignored");

// A duplicated tool_result event is shown once.
const dup = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
const resultEvent = {
  type: "message", sessionId: "s", userMessageUuid: "h",
  message: { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
};
assert.ok(dup.accept(resultEvent).length > 0);
assert.deepEqual(dup.accept(resultEvent), []);

// A failed turn still closes the stream and reports the error.
const failing = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
const failed = failing.accept({
  type: "message", sessionId: "s", userMessageUuid: "h",
  message: { type: "result", subtype: "error_during_execution", is_error: true, result: "boom" },
});
assert.deepEqual(kinds(failed), ["message_start", "message_delta", "message_stop"]);
assert.equal(failing.error?.message, "boom");
assert.deepEqual(failing.accept({ type: "message", sessionId: "s", message: { type: "result", subtype: "success" } }), [], "nothing after the result");

// ---- complete() finishes a turn whose live stream was missed ----
const live = (message) => ({ type: "message", sessionId: "s", userMessageUuid: "h", message });
const streamEvent = (event) => live({ type: "stream_event", event });
const open = () => {
  const translator = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
  translator.accept(streamEvent({ type: "message_start", message: { model: "m" } }));
  translator.accept(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
  translator.accept(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }));
  return translator;
};
const scratch = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
assert.deepEqual(kinds(scratch.complete("hello")), [
  "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
]);
assert.equal(scratch.text, "hello");
assert.deepEqual(scratch.complete("again"), [], "nothing after the turn has finished");
const partial = open();
const rest = partial.complete("hello");
assert.deepEqual(kinds(rest), ["content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
assert.equal(rest[0].data.delta.text, "lo");
assert.equal(rest[0].data.index, 0, "the open block is continued, not a new one");
assert.equal(partial.blocks[0].text, "hello");
assert.deepEqual(kinds(open().complete("xyz")), ["content_block_stop", "message_delta", "message_stop"]);
const dangling = open();
assert.deepEqual(kinds(dangling.accept(live({ type: "result", subtype: "success", stop_reason: "end_turn" }))), ["content_block_stop", "message_delta", "message_stop"]);

// ---- how tools are described ----
const bash = describeTool("mcp__workspace__bash", { command: "ls -la\n/tmp" });
assert.deepEqual([bash.kind, bash.restName, bash.displayName, bash.inputSummaryKind], [ROW.SHELL, "bash_tool", "Bash", SUMMARY.COMMAND]);
assert.equal(bash.inputSummary, "ls -la /tmp", "the summary is one line");
assert.equal(describeTool("Bash", {}).kind, ROW.SHELL);
assert.deepEqual([describeTool("WebSearch", { query: "q" }).kind, describeTool("WebSearch", { query: "q" }).inputSummaryKind], [ROW.WEB_SEARCH, SUMMARY.QUERY]);
assert.equal(describeTool("WebFetch", { url: "https://x.test" }).inputSummary, "https://x.test");
assert.equal(describeTool("Edit", { file_path: "/a.js" }).kind, ROW.FILE_EDIT);
assert.equal(describeTool("Grep", { pattern: "foo" }).kind, ROW.FILE_SEARCH);
const generic = describeTool("mcp__crm__lookup_customer", { q: "ada" });
assert.deepEqual([generic.kind, generic.restName, generic.runningTitle, generic.doneTitle, generic.inputSummary], [ROW.GENERIC, "lookup_customer", "Running lookup_customer", "Ran lookup_customer", "ada"]);
assert.equal(describeTool("Bash", { command: "x".repeat(500) }).inputSummary.length, 200);
assert.equal(describeTool(undefined, undefined).kind, ROW.GENERIC);

assert.deepEqual(resultText("plain"), { text: "plain", truncated: false });
assert.equal(resultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]).text, "a\n[image]\nb");
assert.equal(resultText("y".repeat(20000)).text.length, 12000);
assert.equal(resultText("y".repeat(20000)).truncated, true);
assert.equal(resultText(null).text, "");
assert.equal(restToolUse({ id: "t", name: "Write", input: { content: "z".repeat(5000) } }).input.content.length, 2001, "a large input is trimmed");

// ---- Connect rows ----
const bashRows = bardSegments("m1", bashAnswer.content);
assert.deepEqual(bashRows.groups.map((group) => group.style), [2, 1], "tool calls form a timeline group, the answer an inline one");
assert.equal(bashRows.groups[0].runState, RUN.SETTLED);
assert.equal(bashRows.groups[0].summary, "Ran command");
assert.equal(bashRows.groups[0].isComplete, true);
const [thought1, row, thought2, answerBlock] = bashRows.contentBlocks;
assert.deepEqual([thought1.title, thought1.state, thought2.title], ["Thought", BLOCK.COMPLETE, "Thought"]);
assert.equal(thought1.displayGroupId, bashRows.groups[0].id, "reasoning shares the timeline group with the tool call");
assert.deepEqual(
  [row.title, row.state, row.rowKind, row.inputSummary, row.inputSummaryKind, row.toolDisplayName, row.text],
  ["Ran command", BLOCK.COMPLETE, ROW.SHELL, "echo probe-ok && uname -s", SUMMARY.COMMAND, "Bash", "probe-ok\nLinux\n"],
);
assert.equal(row.displayGroupId, bashRows.groups[0].id);
assert.equal(answerBlock.displayGroupId, bashRows.groups[1].id);
assert.match(answerBlock.text, /probe-ok/);
assert.equal(new Set(bashRows.contentBlocks.map((block) => block.id)).size, bashRows.contentBlocks.length, "block ids are unique");

const refused = bardSegments("m2", messages[3].content);
assert.equal(refused.contentBlocks.find((block) => block.rowKind).state, BLOCK.ERROR);
assert.equal(refused.groups[0].runState, RUN.FAILED);

// While a call runs it has no result yet.
const running = bardSegments("m3", [pick(bashAnswer, "tool_use")], { live: true });
assert.equal(running.contentBlocks[0].state, BLOCK.RUNNING);
assert.equal(running.contentBlocks[0].title, "Running command");
assert.equal(running.groups[0].runState, RUN.WORKING);
assert.equal(running.groups[0].statusText, "Running command");
assert.equal(running.groups[0].isComplete, false);

// Several calls in a row share one group; text between them splits groups.
const use = (id, name) => restToolUse({ id, name, input: { command: id } });
const done = (id, name) => restToolResult({ toolUseId: id, name, input: {}, content: "ok" });
const run = bardSegments("m4", [use("a", "Bash"), done("a", "Bash"), use("b", "Bash"), done("b", "Bash"), { type: "text", text: "then" }, use("c", "WebSearch"), done("c", "WebSearch")]);
assert.deepEqual(run.groups.map((group) => group.style), [2, 1, 2]);
assert.equal(run.groups[0].summary, "Used 2 tools");
assert.deepEqual(run.contentBlocks.filter((block) => block.displayGroupId === run.groups[0].id).map((block) => block.index), [0, 1]);
assert.deepEqual(run.groups.map((group) => group.index), [0, 1, 2]);

// Reasoning rows: running while it streams, then settled, with a heading from its first sentence.
const pondering = restThinking({ thinking: "Let me weigh the options. First, the cost.", startedAt: "2026-10-02T12:00:00.000Z" });
const thinkingLive = bardSegments("m7", [pondering], { live: true });
assert.deepEqual(thinkingLive.groups.map((group) => group.style), [2]);
assert.equal(thinkingLive.groups[0].runState, RUN.WORKING);
assert.equal(thinkingLive.groups[0].summary, "Thinking");
assert.equal(thinkingLive.groups[0].statusText, "Thinking");
const [thinkingRow] = thinkingLive.contentBlocks;
assert.deepEqual([thinkingRow.title, thinkingRow.state, thinkingRow.isComplete], ["Thinking", BLOCK.RUNNING, false]);
assert.equal(thinkingRow.text, "Let me weigh the options. First, the cost.");
assert.deepEqual(thinkingRow.summaries, [{ summary: "Let me weigh the options." }]);
assert.deepEqual(thinkingRow.thinkingDisplay, { startedAt: "2026-10-02T12:00:00.000Z" });
const thinkingDone = bardSegments("m8", [{ ...pondering, stop_timestamp: "2026-10-02T12:00:04.000Z" }, { type: "text", text: "Answer" }], { live: true });
assert.equal(thinkingDone.groups[0].runState, RUN.SETTLED);
assert.equal(thinkingDone.groups[0].summary, "Thought");
assert.deepEqual(thinkingDone.contentBlocks[0].thinkingDisplay, { startedAt: "2026-10-02T12:00:00.000Z", completedAt: "2026-10-02T12:00:04.000Z" });
assert.equal(thinkingDone.contentBlocks[0].state, BLOCK.COMPLETE);
assert.equal(thinkingDone.contentBlocks[1].state, BLOCK.RUNNING, "the answer is the part still streaming");
assert.equal(bardSegments("m9", [restThinking({ thinking: "" }), { type: "text", text: "x" }]).groups.length, 1, "empty reasoning is skipped");
const longThought = bardSegments("m10", [restThinking({ thinking: "z".repeat(40000), stoppedAt: "t" })]);
assert.equal(longThought.contentBlocks[0].text.length, 30000);
assert.equal(longThought.contentBlocks[0].isTruncated, true);
assert.equal(new Set(bardSegments("m11", [restThinking({ thinking: "a", stoppedAt: "t" }), restThinking({ thinking: "b", stoppedAt: "t" })]).contentBlocks.map((block) => block.id)).size, 2, "reasoning block ids are unique");

// The heading is a short label cut at a word boundary.
const headingOf = (thinking) => bardSegments("h", [restThinking({ thinking, stoppedAt: "t" })]).contentBlocks[0].summaries?.[0]?.summary;
assert.equal(headingOf("Short one. And a second sentence."), "Short one.");
assert.equal(headingOf("First line\nsecond line"), "First line");
const longHeading = headingOf("The user is asking me to calculate seventeen multiplied by twenty three and wants me to think carefully.");
assert.ok(longHeading.length <= 61 && longHeading.endsWith("…") && !longHeading.includes("  "));
assert.match(longHeading, /^The user is asking me to calculate seventeen multiplied by( twenty)?…$/, "cut at a word boundary");
assert.equal(headingOf(""), undefined);

// A failed model call is reported by Desktop as an assistant message with no stream events.
const failedCall = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
assert.deepEqual(failedCall.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "API Error: 400 Upstream /v1/responses returned HTTP 400" }] } } }), []);
const failedOut = failedCall.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "result", subtype: "success", stop_reason: "stop_sequence" } });
assert.deepEqual(kinds(failedOut), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
assert.equal(failedCall.text, "API Error: 400 Upstream /v1/responses returned HTTP 400");
assert.equal(failedCall.blocks[0].is_closed, true);
assert.ok(failedCall.finished && !failedCall.error);
// ...but a normal streamed answer is not repeated from the assistant message.
const streamed = createTurnTranslator({ sessionId: "s", humanUuid: "h", assistantUuid: "a" });
for (const event of [
  { type: "message_start", message: {} },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "391" } },
  { type: "content_block_stop", index: 0 },
]) streamed.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "stream_event", event } });
streamed.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "assistant", message: { content: [{ type: "text", text: "391" }] } } });
const streamedEnd = streamed.accept({ type: "message", sessionId: "s", userMessageUuid: "h", message: { type: "result", subtype: "success" } });
assert.deepEqual(kinds(streamedEnd), ["message_delta", "message_stop"]);
assert.equal(streamed.text, "391");

// A live text answer is marked as still running; an empty message still has a block.
const writing = bardSegments("m5", [{ type: "text", text: "partial" }], { live: true });
assert.equal(writing.contentBlocks[0].state, BLOCK.RUNNING);
assert.equal(writing.groups[0].isComplete, false);
const empty = bardSegments("m6", [], { live: true });
assert.equal(empty.contentBlocks.length, 1);
assert.equal(empty.contentBlocks[0].text, "");

console.log("desktop-translators-smoke: transcript, live events and tool presentation match the recorded Desktop data");
