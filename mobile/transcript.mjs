// Desktop's session transcript (Claude Code JSONL entries returned by
// LocalAgentModeSessions.getTranscript) -> the claude.ai-style messages the
// mobile facade serves. Shapes were recorded from a live bridge; see
// scripts/fixtures/desktop-chat-probe.json.
//
// One Desktop turn is: a human entry, then any number of assistant entries
// (one per content block: thinking, text, tool_use), tool_result entries and
// synthetic isMeta notes, until the next human entry. The facade presents a
// turn as one human message and one assistant message.

const mentionPattern = /^\s*@"([^"\n]+)"\s*\n?/;

function hasToolResult(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
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
 * @param {{ assistantUuidFor?: (humanUuid: string) => string | undefined }} [options]
 *   assistantUuidFor returns the assistant message uuid the mobile client chose
 *   for a turn; otherwise the turn's first assistant entry uuid is used.
 * @returns {{ messages: object[], leaf: string | null, lastHumanUuid: string | null }}
 */
export function transcriptToMessages(entries, { assistantUuidFor = () => undefined } = {}) {
  const turns = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isHumanEntry(entry)) {
      turns.push({ human: entry, assistant: [] });
    } else if (turns.length && entry?.type === "assistant" && !entry.isSidechain) {
      turns.at(-1).assistant.push(entry);
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
    // Assistant entries hold one content block each; keep the text ones. Thinking
    // and tool blocks are not shown on mobile yet.
    const answer = turn.assistant.flatMap((entry) => Array.isArray(entry.message?.content)
      ? entry.message.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
      : []);
    const last = turn.assistant.at(-1);
    const assistant = {
      uuid: assistantUuidFor(human.uuid) || turn.assistant[0].uuid,
      parent_uuid: human.uuid,
      sender: "assistant",
      index: messages.length,
      created_at: turn.assistant[0].timestamp,
      updated_at: last.timestamp,
      content: textContent(answer.join("\n\n")),
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
