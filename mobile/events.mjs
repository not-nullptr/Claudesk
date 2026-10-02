// Desktop's native session events (LocalAgentModeSessions.onOnEvent, relayed by
// the bridge as `desktop-ipc` SSE records) -> the canonical streaming events the
// mobile REST-SSE and Connect emitters consume (message_start,
// content_block_*, message_delta, message_stop).
//
// A Desktop turn wraps Anthropic's streaming protocol in Agent SDK messages:
//   { type: "message", sessionId, userMessageUuid,
//     message: { type: "stream_event", event: <Anthropic stream event> } }
// ending with message.type === "result". A tool-using turn contains several
// inner Anthropic messages (message_start ... message_stop) with the tool
// results arriving between them as `user` messages; it still counts as one
// assistant message here, so inner message boundaries are folded and the final
// message_delta / message_stop are emitted once, from the result event.
//
// Text and tool calls are surfaced (a tool call is a tool_use block followed by
// a tool_result block). Thinking is skipped, and so is anything a sub-agent does
// (parent_tool_use_id set).
import { restToolResult, restToolUse, trimInput } from "./blocks.mjs";
import { serverStopReason } from "./transcript.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {{ sessionId: string, humanUuid: string, assistantUuid: string, model?: string, toolBlocks?: boolean }} turn
 */
export function createTurnTranslator({ sessionId, humanUuid, assistantUuid, model, toolBlocks = true }) {
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let innerMessage = 0;
  let text = "";
  let error = null;
  let stopReason = "end_turn";
  const outputIndex = new Map(); // `${innerMessage}:${index}` -> output index
  const blocks = []; // normalized content blocks, in order
  const blockAt = new Map(); // output index -> block
  const jsonBuffers = new Map(); // output index -> partial tool input
  const toolUses = new Map(); // tool_use id -> { name, input }
  const seenResults = new Set();
  const openBlocks = new Set(); // output indices started but not yet stopped

  function startEvent(innerModel) {
    started = true;
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: { uuid: assistantUuid, parent_uuid: humanUuid || null, model: innerModel || model },
      },
    };
  }

  function blockStart(index, block) {
    openBlocks.add(index);
    return {
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { ...block } },
    };
  }

  function blockStop(index) {
    openBlocks.delete(index);
    return {
      event: "content_block_stop",
      data: { type: "content_block_stop", index, stop_timestamp: nowIso() },
    };
  }

  function addBlock(block) {
    const index = nextIndex;
    nextIndex += 1;
    blocks.push(block);
    blockAt.set(index, block);
    return index;
  }

  function addText() {
    const block = { type: "text", text: "", citations: [], is_closed: false };
    return { index: addBlock(block), block };
  }

  function finish(reason) {
    finished = true;
    stopReason = serverStopReason(reason || stopReason);
    return [
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null } },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
  }

  function streamEvent(event, out) {
    if (event?.type === "message_start") {
      innerMessage += 1;
      if (!started) out.push(startEvent(event.message?.model));
      return;
    }
    if (event?.type === "content_block_start") {
      const kind = event.content_block?.type;
      const key = `${innerMessage}:${event.index}`;
      if (kind === "text") {
        if (!started) out.push(startEvent());
        const { index, block } = addText();
        outputIndex.set(key, index);
        out.push(blockStart(index, block));
      } else if (toolBlocks && kind === "tool_use") {
        if (!started) out.push(startEvent());
        const { id, name } = event.content_block;
        toolUses.set(id, { name, input: {} });
        const block = restToolUse({ id, name, input: {}, startedAt: nowIso() });
        const index = addBlock(block);
        outputIndex.set(key, index);
        jsonBuffers.set(index, "");
        out.push(blockStart(index, block));
      }
      return;
    }
    if (event?.type === "content_block_delta") {
      const index = outputIndex.get(`${innerMessage}:${event.index}`);
      if (index === undefined) return;
      const block = blockAt.get(index);
      if (block?.type === "text" && event.delta?.type === "text_delta" && event.delta.text) {
        block.text += event.delta.text;
        text += event.delta.text;
        out.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index, delta: { type: "text_delta", text: event.delta.text } },
        });
      } else if (block?.type === "tool_use" && event.delta?.type === "input_json_delta" && event.delta.partial_json) {
        jsonBuffers.set(index, `${jsonBuffers.get(index) ?? ""}${event.delta.partial_json}`);
        out.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: event.delta.partial_json },
          },
        });
      }
      return;
    }
    if (event?.type === "content_block_stop") {
      const index = outputIndex.get(`${innerMessage}:${event.index}`);
      if (index === undefined) return;
      const block = blockAt.get(index);
      if (block?.type === "text") block.is_closed = true;
      if (block?.type === "tool_use") {
        let input = {};
        try {
          input = JSON.parse(jsonBuffers.get(index) || "{}");
        } catch {
          // Keep an empty input rather than failing the turn on malformed JSON.
        }
        toolUses.set(block.id, { name: toolUses.get(block.id)?.name, input });
        block.input = trimInput(input);
        block.stop_timestamp = nowIso();
      }
      out.push(blockStop(index));
      return;
    }
    if (event?.type === "message_delta" && event.delta?.stop_reason) {
      stopReason = serverStopReason(event.delta.stop_reason);
    }
  }

  // Tool results arrive as `user` messages carrying tool_result blocks.
  function toolResults(message, out) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item?.type !== "tool_result" || seenResults.has(item.tool_use_id)) continue;
      seenResults.add(item.tool_use_id);
      if (!started) out.push(startEvent());
      const use = toolUses.get(item.tool_use_id);
      const block = restToolResult({
        toolUseId: item.tool_use_id,
        name: use?.name,
        input: use?.input,
        content: item.content,
        isError: item.is_error,
        at: nowIso(),
      });
      const index = addBlock(block);
      out.push(blockStart(index, block));
      out.push(blockStop(index));
    }
  }

  // Returns the canonical events for one Desktop event payload.
  function accept(payload) {
    if (finished || payload?.type !== "message" || payload.sessionId !== sessionId) return [];
    if (payload.userMessageUuid && humanUuid && payload.userMessageUuid !== humanUuid) return [];
    const message = payload.message;
    if (message?.parent_tool_use_id) return []; // a sub-agent's own traffic
    const out = [];

    if (message?.type === "stream_event") {
      streamEvent(message.event, out);
      return out;
    }
    if (message?.type === "user" && toolBlocks) {
      toolResults(message, out);
      return out;
    }
    if (message?.type === "result") {
      if (message.is_error || (message.subtype && message.subtype !== "success")) {
        error = new Error(
          typeof message.result === "string" && message.result
            ? message.result
            : `the session ended with ${message.subtype || "an error"}`,
        );
      }
      if (!started) out.push(startEvent());
      for (const index of [...openBlocks]) out.push(blockStop(index));
      out.push(...finish(message.stop_reason));
    }
    return out;
  }

  // Finishes the turn from the stored transcript when the live stream was
  // missed (for example across a bridge reconnect): emits whatever text has not
  // been streamed yet, closes open blocks and ends the message.
  function complete(fullText) {
    if (finished) return [];
    const out = [];
    if (!started) out.push(startEvent());
    const missing = typeof fullText === "string" && fullText.startsWith(text)
      ? fullText.slice(text.length)
      : "";
    if (missing) {
      let index = [...openBlocks].filter((i) => blockAt.get(i)?.type === "text").at(-1);
      if (index === undefined) {
        const added = addText();
        index = added.index;
        out.push(blockStart(index, added.block));
      }
      blockAt.get(index).text += missing;
      text += missing;
      out.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "text_delta", text: missing } },
      });
    }
    for (const index of [...openBlocks]) {
      const block = blockAt.get(index);
      if (block?.type === "text") block.is_closed = true;
      out.push(blockStop(index));
    }
    out.push(...finish());
    return out;
  }

  return {
    accept,
    complete,
    get finished() { return finished; },
    get started() { return started; },
    get text() { return text; },
    get blocks() { return blocks.map((block) => ({ ...block })); },
    get error() { return error; },
    get stopReason() { return stopReason; },
  };
}
