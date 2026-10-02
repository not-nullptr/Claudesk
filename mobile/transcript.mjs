// Desktop's session transcript (Claude Code JSONL entries returned by
// LocalAgentModeSessions.getTranscript) -> the claude.ai-style messages the
// mobile facade serves. Shapes were recorded from a live bridge; see
// scripts/fixtures/desktop-chat-probe.json.
//
// One Desktop turn is: a human entry, then any number of assistant entries
// (one per content block: thinking, text, tool_use), tool_result entries and
// synthetic isMeta notes, until the next human entry. The facade presents a
// turn as one human message and one assistant message whose content keeps the
// reasoning, text, tool calls and tool results in order.
import { restThinking, restToolResult, restToolUse } from "./blocks.mjs";

const mentionPattern = /^\s*@"([^"\n]+)"\s*\n?/;

function hasToolResult(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
}

// Content blocks of one turn's assistant side, in transcript order.
function assistantBlocks(entries, { toolBlocks, thinking, startedAt }) {
  const blocks = [];
  const uses = new Map(); // tool_use id -> { name, input }
  // A reasoning block ends when its entry is written and began when the previous
  // entry (the prompt, or a tool result) was.
  let previous = startedAt;
  for (const entry of entries) {
    const began = previous;
    previous = entry.timestamp ?? previous;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === "assistant") {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text, citations: [], is_closed: true });
        } else if (thinking && block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          blocks.push(restThinking({ thinking: block.thinking, startedAt: began, stoppedAt: entry.timestamp }));
        } else if (toolBlocks && block?.type === "tool_use") {
          uses.set(block.id, { name: block.name, input: block.input });
          blocks.push(restToolUse({
            id: block.id, name: block.name, input: block.input, startedAt: entry.timestamp, stoppedAt: entry.timestamp,
          }));
        }
      }
    } else if (toolBlocks && hasToolResult(entry)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const use = uses.get(block.tool_use_id);
        blocks.push(restToolResult({
          toolUseId: block.tool_use_id,
          name: use?.name,
          input: use?.input,
          content: block.content,
          isError: block.is_error,
          at: entry.timestamp,
        }));
      }
    }
  }
  return blocks;
}

export function isHumanEntry(entry) {
  if (entry?.type !== "user" || entry.isMeta || entry.toolUseResult || hasToolResult(entry)) {
    return false;
  }
  if (entry.origin?.kind) return entry.origin.kind === "human";
  return entry.turnOrigin ? entry.turnOrigin === "human" : true;
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

// Leading @"path" mentions are how uploaded files reach the model (see
// attachmentMention in engine.mjs). They are shown as attachments, not text.
export function splitMentions(text) {
  const files = [];
  let rest = String(text ?? "");
  for (let match = mentionPattern.exec(rest); match; match = mentionPattern.exec(rest)) {
    files.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { text: rest, files };
}

export function serverStopReason(reason) {
  return reason === "max_tokens" || reason === "refusal" ? reason : "end_turn";
}

function textContent(text, closed = true) {
  return [{ type: "text", text, citations: [], is_closed: closed }];
}

/**
 * @param {object[]} entries Desktop transcript entries.
 * @param {{ assistantUuidFor?: (humanUuid: string) => string | undefined, toolBlocks?: boolean }} [options]
 *   assistantUuidFor returns the assistant message uuid the mobile client chose
 *   for a turn; otherwise the turn's first assistant entry uuid is used.
 *   toolBlocks (default true) includes tool calls and results in assistant content;
 *   thinking (default true) includes the model's reasoning.
 * @returns {{ messages: object[], leaf: string | null, lastHumanUuid: string | null }}
 */
export function transcriptToMessages(
  entries,
  { assistantUuidFor = () => undefined, toolBlocks = true, thinking = true } = {},
) {
  const turns = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isHumanEntry(entry)) {
      turns.push({ human: entry, assistant: [], body: [] });
    } else if (turns.length && !entry.isSidechain && !entry.isMeta) {
      const turn = turns.at(-1);
      if (entry.type === "assistant") {
        turn.assistant.push(entry);
        turn.body.push(entry);
      } else if (hasToolResult(entry)) {
        turn.body.push(entry);
      }
    }
  }

  const messages = [];
  let previousUuid = null;
  for (const turn of turns) {
    const { text, files } = splitMentions(textBlocks(turn.human.message?.content).join("\n"));
    const human = {
      uuid: turn.human.uuid,
      parent_uuid: previousUuid,
      sender: "human",
      index: messages.length,
      created_at: turn.human.timestamp,
      updated_at: turn.human.timestamp,
      content: textContent(text),
      attachments: files.map((path) => ({ file_name: path.split("/").pop(), file_size: 0, file_type: "", path })),
      files: [],
    };
    messages.push(human);
    previousUuid = human.uuid;

    if (!turn.assistant.length) continue;
    const content = assistantBlocks(turn.body, { toolBlocks, thinking, startedAt: turn.human.timestamp });
    const last = turn.assistant.at(-1);
    const assistant = {
      uuid: assistantUuidFor(human.uuid) || turn.assistant[0].uuid,
      parent_uuid: human.uuid,
      sender: "assistant",
      index: messages.length,
      created_at: turn.assistant[0].timestamp,
      updated_at: last.timestamp,
      content: content.length ? content : textContent(""),
      attachments: [],
      files: [],
      stop_reason: serverStopReason(last.message?.stop_reason),
    };
    messages.push(assistant);
    previousUuid = assistant.uuid;
  }

  const lastHuman = [...messages].reverse().find((message) => message.sender === "human");
  return {
    messages,
    leaf: messages.at(-1)?.uuid ?? null,
    lastHumanUuid: lastHuman?.uuid ?? null,
  };
}
