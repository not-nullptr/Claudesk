// Desktop's native session events (LocalAgentModeSessions.onOnEvent, relayed by
// the bridge as `desktop-ipc` SSE records) -> the canonical streaming events the
// mobile REST-SSE and Connect emitters consume (message_start,
// content_block_*, message_delta, message_stop).
//
// A Desktop turn wraps Anthropic's streaming protocol in Agent SDK messages:
//   { type: "message", sessionId, userMessageUuid,
//     message: { type: "stream_event", event: <Anthropic stream event> } }
// ending with message.type === "result". A tool-using turn contains several
// inner Anthropic messages (message_start ... message_stop) and still counts as
// one assistant message here, so inner message boundaries are folded and the
// final message_delta / message_stop are emitted once, from the result event.
//
// Only text blocks are surfaced for now. Thinking and tool_use blocks are
// skipped because their on-screen rendering in the iOS app has not been
// captured yet; adding them means handling more content_block types below.
import { serverStopReason } from "./transcript.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {{ sessionId: string, humanUuid: string, assistantUuid: string, model?: string }} turn
 */
export function createTurnTranslator({ sessionId, humanUuid, assistantUuid, model }) {
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let innerMessage = 0;
  let text = "";
  let error = null;
  let stopReason = "end_turn";
  const textBlocks = new Map(); // `${innerMessage}:${index}` -> output index
  const openBlocks = new Set(); // output indices started but not yet stopped

  function blockStart(index) {
    openBlocks.add(index);
    return {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: [], is_closed: false },
      },
    };
  }

  function blockStop(index) {
    openBlocks.delete(index);
    return {
      event: "content_block_stop",
      data: { type: "content_block_stop", index, stop_timestamp: nowIso() },
    };
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

  // Returns the canonical events for one Desktop event payload.
  function accept(payload) {
    if (finished || payload?.type !== "message" || payload.sessionId !== sessionId) return [];
    if (payload.userMessageUuid && humanUuid && payload.userMessageUuid !== humanUuid) return [];
    const message = payload.message;
    const out = [];

    if (message?.type === "stream_event") {
      const event = message.event;
      if (event?.type === "message_start") {
        innerMessage += 1;
        if (!started) out.push(startEvent(event.message?.model));
      } else if (event?.type === "content_block_start") {
        if (event.content_block?.type === "text") {
          if (!started) out.push(startEvent());
          const index = nextIndex;
          nextIndex += 1;
          textBlocks.set(`${innerMessage}:${event.index}`, index);
          out.push(blockStart(index));
        }
      } else if (event?.type === "content_block_delta") {
        const index = textBlocks.get(`${innerMessage}:${event.index}`);
        if (index !== undefined && event.delta?.type === "text_delta" && event.delta.text) {
          text += event.delta.text;
          out.push({
            event: "content_block_delta",
            data: { type: "content_block_delta", index, delta: { type: "text_delta", text: event.delta.text } },
          });
        }
      } else if (event?.type === "content_block_stop") {
        const index = textBlocks.get(`${innerMessage}:${event.index}`);
        if (index !== undefined) out.push(blockStop(index));
      } else if (event?.type === "message_delta" && event.delta?.stop_reason) {
        stopReason = serverStopReason(event.delta.stop_reason);
      }
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
      let index = [...openBlocks].at(-1);
      if (index === undefined) {
        index = nextIndex;
        nextIndex += 1;
        out.push(blockStart(index));
      }
      text += missing;
      out.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta: { type: "text_delta", text: missing } },
      });
    }
    for (const index of [...openBlocks]) out.push(blockStop(index));
    out.push(...finish());
    return out;
  }

  return {
    accept,
    complete,
    get finished() { return finished; },
    get started() { return started; },
    get text() { return text; },
    get error() { return error; },
    get stopReason() { return stopReason; },
  };
}
