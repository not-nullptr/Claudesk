// How tool calls are shown on the phone. Desktop reports an ordinary
// tool_use / tool_result pair (names recorded from a live bridge: the shell is
// "mcp__workspace__bash", web search is "WebSearch", file access is "Read",
// "Write", "Edit", ...). This module turns them into
//   - claude.ai-style REST content blocks (tool_use / tool_result), and
//   - rows for the Connect surface (BardDisplayGroup + BardContentBlock).
// The enum numbers come from the recovered schema; how the app draws them has
// not been verified on a device yet (see CLAUDE_MOBILE_TOOL_BLOCKS).

const MAX_RESULT_CHARS = 12000;
const MAX_INPUT_CHARS = 2000;

// BardToolRowKind
export const ROW = {
  GENERIC: 1, SHELL: 2, FILE_READ: 3, FILE_WRITE: 4, FILE_EDIT: 5, FILE_SEARCH: 6,
  WEB_SEARCH: 7, WEB_FETCH: 8, AGENT: 9, TASK_LIST: 11, SKILL: 12, QUESTION: 13,
};
// BardInputSummaryKind
export const SUMMARY = { TEXT: 1, COMMAND: 2, FILE_PATH: 3, PATTERN: 4, URL: 5, QUERY: 6, SKILL_NAME: 8 };
// BardToolRunState
export const RUN = { WORKING: 1, SETTLED: 2, FAILED: 3 };
// BardContentBlockState
export const BLOCK = { RUNNING: 1, COMPLETE: 2, ERROR: 3 };

const catalog = [
  { match: /(^|__)bash(_tool)?$/i, kind: ROW.SHELL, name: "bash_tool", display: "Bash", field: "command", summary: SUMMARY.COMMAND, verbs: ["Running command", "Ran command"] },
  { match: /^(read|view)$/i, kind: ROW.FILE_READ, name: "view", display: "Read", field: "file_path", summary: SUMMARY.FILE_PATH, verbs: ["Reading file", "Read file"] },
  { match: /^(write|create_file)$/i, kind: ROW.FILE_WRITE, name: "create_file", display: "Write", field: "file_path", summary: SUMMARY.FILE_PATH, verbs: ["Writing file", "Wrote file"] },
  { match: /^(edit|multiedit|notebookedit|str_replace)$/i, kind: ROW.FILE_EDIT, name: "str_replace", display: "Edit", field: "file_path", summary: SUMMARY.FILE_PATH, verbs: ["Editing file", "Edited file"] },
  { match: /^(glob|grep)$/i, kind: ROW.FILE_SEARCH, name: null, display: "Search", field: "pattern", summary: SUMMARY.PATTERN, verbs: ["Searching files", "Searched files"] },
  { match: /^(websearch|web_search)$/i, kind: ROW.WEB_SEARCH, name: "web_search", display: "Web search", field: "query", summary: SUMMARY.QUERY, verbs: ["Searching the web", "Searched the web"] },
  { match: /^(webfetch|web_fetch)$/i, kind: ROW.WEB_FETCH, name: "web_fetch", display: "Web fetch", field: "url", summary: SUMMARY.URL, verbs: ["Fetching page", "Fetched page"] },
  { match: /^(task|agent)$/i, kind: ROW.AGENT, name: null, display: "Agent", field: "description", summary: SUMMARY.TEXT, verbs: ["Running agent", "Ran agent"] },
  { match: /^todowrite$/i, kind: ROW.TASK_LIST, name: null, display: "Tasks", field: null, summary: SUMMARY.TEXT, verbs: ["Updating tasks", "Updated tasks"] },
  { match: /^skill$/i, kind: ROW.SKILL, name: null, display: "Skill", field: "skill", summary: SUMMARY.SKILL_NAME, verbs: ["Using skill", "Used skill"] },
  { match: /^askuserquestion$/i, kind: ROW.QUESTION, name: null, display: "Question", field: null, summary: SUMMARY.TEXT, verbs: ["Asking", "Asked"] },
];

function oneLine(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function summaryText(input, field) {
  if (input && typeof input === "object") {
    if (field && typeof input[field] === "string") return input[field];
    const first = Object.values(input).find((value) => typeof value === "string" && value);
    if (first) return first;
    const keys = Object.keys(input);
    if (keys.length) return JSON.stringify(input);
  }
  return typeof input === "string" ? input : "";
}

// Presentation facts for one tool call. Accepts Desktop's tool names and the
// claude.ai-style names this module renames them to, so it works on both raw
// events and stored REST blocks.
export function describeTool(rawName, input) {
  const cleaned = String(rawName || "tool").replace(/^mcp__.+?__/, "");
  const entry = catalog.find((item) => item.match.test(cleaned) || item.match.test(String(rawName)));
  const display = entry?.display ?? cleaned;
  return {
    kind: entry?.kind ?? ROW.GENERIC,
    restName: entry?.name ?? cleaned,
    displayName: display,
    runningTitle: entry?.verbs[0] ?? `Running ${display}`,
    doneTitle: entry?.verbs[1] ?? `Ran ${display}`,
    inputSummary: oneLine(summaryText(input, entry?.field), 200),
    inputSummaryKind: entry?.summary ?? SUMMARY.TEXT,
  };
}

// Tool results are text for Bash and a string for web search; images are noted.
export function resultText(content) {
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block) => (block?.type === "text" ? block.text : block?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  } else text = content == null ? "" : JSON.stringify(content);
  return text.length > MAX_RESULT_CHARS
    ? { text: text.slice(0, MAX_RESULT_CHARS), truncated: true }
    : { text, truncated: false };
}

// Keeps display payloads small: a Write call can carry a whole file.
export function trimInput(value, depth = 0) {
  if (typeof value === "string") return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}…` : value;
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => trimInput(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimInput(item, depth + 1)]));
}

// ---- claude.ai-style REST content blocks ----

export function restToolUse({ id, name, input, startedAt = null, stoppedAt = null }) {
  const tool = describeTool(name, input);
  return {
    type: "tool_use",
    id,
    name: tool.restName,
    input: trimInput(input ?? {}),
    message: tool.runningTitle,
    integration_name: null,
    integration_icon_url: null,
    icon_name: null,
    context: null,
    display_content: null,
    approval_options: null,
    approval_key: null,
    start_timestamp: startedAt,
    stop_timestamp: stoppedAt,
  };
}

export function restToolResult({ toolUseId, name, input, content, isError = false, at = null }) {
  const tool = describeTool(name, input);
  const result = resultText(content);
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    name: tool.restName,
    content: [{ type: "text", text: result.text }],
    is_error: Boolean(isError),
    structured_content: null,
    meta: result.truncated ? { truncated: true } : null,
    message: null,
    integration_name: null,
    mcp_server_url: null,
    display_content: { type: "text", text: result.text },
    start_timestamp: at,
    stop_timestamp: at,
  };
}

// The text of a message: only its text blocks.
export function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

// ---- Connect rows ----

// Splits an assistant message's blocks into display groups: each text block is
// an inline group, and a run of consecutive tool calls shares one timeline
// group. `live` marks a message that is still streaming.
export function bardSegments(messageUuid, blocks, { live = false } = {}) {
  const results = new Map(blocks.filter((b) => b.type === "tool_result").map((b) => [b.tool_use_id, b]));
  const groups = [];
  const contentBlocks = [];
  let toolRun = null;
  let textCount = 0;

  const nextGroupId = () => `${messageUuid}-g${groups.length}`;

  function flushTools() {
    if (!toolRun) return;
    const { group, items } = toolRun;
    toolRun = null;
    const rows = items.map((use, position) => {
      const result = results.get(use.id);
      const tool = describeTool(use.name, use.input);
      const running = !result && live;
      const failed = Boolean(result?.is_error);
      return {
        tool,
        block: {
          id: use.id,
          displayGroupId: group.id,
          index: position,
          isComplete: !running,
          title: running ? tool.runningTitle : tool.doneTitle,
          state: running ? BLOCK.RUNNING : failed ? BLOCK.ERROR : BLOCK.COMPLETE,
          text: result?.content?.[0]?.text ?? "",
          isTruncated: Boolean(result?.meta?.truncated),
          toolDisplayName: tool.displayName,
          inputSummary: tool.inputSummary,
          rowKind: tool.kind,
          inputSummaryKind: tool.inputSummaryKind,
          titleSource: 1, // BardTitleSource LIFECYCLE
        },
        running,
        failed,
      };
    });
    const working = rows.some((row) => row.running);
    group.isComplete = !working;
    group.runState = working ? RUN.WORKING : rows.every((row) => row.failed) ? RUN.FAILED : RUN.SETTLED;
    group.summary = rows.length === 1 ? rows[0].block.title : `Used ${rows.length} tools`;
    group.statusText = working ? rows.find((row) => row.running).block.title : "";
    contentBlocks.push(...rows.map((row) => row.block));
  }

  for (const block of blocks) {
    if (block.type === "tool_result") continue;
    if (block.type === "tool_use") {
      if (!toolRun) {
        const group = { id: nextGroupId(), messageId: messageUuid, index: groups.length, style: 2, isComplete: true };
        groups.push(group);
        toolRun = { group, items: [] };
      }
      toolRun.items.push(block);
      continue;
    }
    if (block.type !== "text") continue;
    flushTools();
    const group = { id: nextGroupId(), messageId: messageUuid, index: groups.length, style: 1, isComplete: true };
    groups.push(group);
    textCount += 1;
    contentBlocks.push({
      id: `${messageUuid}-text${textCount}`,
      displayGroupId: group.id,
      index: 0,
      isComplete: true,
      state: BLOCK.COMPLETE,
      text: block.text,
    });
  }
  flushTools();

  // The block still being written is the last one when the message is live.
  if (live) {
    const last = groups.at(-1);
    const lastBlock = contentBlocks.filter((b) => b.displayGroupId === last?.id).at(-1);
    if (last?.style === 1 && lastBlock) {
      last.isComplete = false;
      lastBlock.isComplete = false;
      lastBlock.state = BLOCK.RUNNING;
    }
  }
  if (!groups.length) {
    const group = { id: nextGroupId(), messageId: messageUuid, index: 0, style: 1, isComplete: !live };
    groups.push(group);
    contentBlocks.push({
      id: `${messageUuid}-text1`,
      displayGroupId: group.id,
      index: 0,
      isComplete: !live,
      state: live ? BLOCK.RUNNING : BLOCK.COMPLETE,
      text: "",
    });
  }
  return { groups, contentBlocks };
}
