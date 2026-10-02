// Gives mobile chats the same Claude system prompt the official Desktop client
// attaches to every Chat model. Desktop serves its prompt template from
// GET /api/bootstrap/:org/system_prompts (cowork_system_prompt); the bridge
// publishes that route read-only, so the prompt is fetched at run time and
// follows Desktop updates instead of being copied into this repository.
//
// CLAUDE_MOBILE_SYSTEM_PROMPT selects what is sent:
//   chat (default)  behavior sections only. The VM, file, skills and
//                   computer-use sections describe tools mobile does not have
//                   and would make models claim abilities they lack.
//   full            the whole Desktop template, unfiltered.
//   off             no system prompt.

const desktopUrl = (process.env.CLAUDE_MOBILE_DESKTOP_URL || "http://claude-desktop:8080")
  .replace(/\/$/, "");
const mode = ["chat", "full", "off"].includes(process.env.CLAUDE_MOBILE_SYSTEM_PROMPT)
  ? process.env.CLAUDE_MOBILE_SYSTEM_PROMPT
  : "chat";
const ttlMs = Number(process.env.CLAUDE_MOBILE_SYSTEM_PROMPT_TTL_MS || 600000);
const cacheFile = "system-prompt.json";

const chatSections = [
  "refusal_handling",
  "legal_and_financial_advice",
  "tone_and_formatting", // contains lists_and_bullets
  "user_wellbeing",
  "evenhandedness",
  "responding_to_mistakes_and_criticism",
  "knowledge_cutoff",
];

const chatPreamble = "Claude is chatting with the user through the Claude mobile app. "
  + "No tools, files, or computer access are available in this conversation.";

export class SystemPromptUnavailableError extends Error {}

// Same wording as Desktop's modelIdentity text. Desktop also resolves display
// names for known Claude ids from a catalog; only the generic id pattern is
// reproduced here.
function claudeDisplayName(modelId) {
  const match = modelId.replace(/^anthropic\//, "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  if (!match) return undefined;
  const [, family, major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} `
    + `${minor !== undefined && minor !== "0" ? `${major}.${minor}` : major}`;
}

function modelIdentity(modelId, labelOverride) {
  if (!modelId) return "";
  const id = modelId.replace(/\[[^\]]+\]$/, "");
  const name = claudeDisplayName(id);
  const base = name === undefined
    ? `You are powered by the model ${id}.`
    : `You are powered by the model named ${name}. The exact model ID is ${id}.`;
  return labelOverride
    ? `${base} The administrator of this deployment has labeled this model "${labelOverride}".`
    : base;
}

function extractSection(template, name) {
  const start = template.indexOf(`<${name}>`);
  if (start < 0) return "";
  const close = `</${name}>`;
  const end = template.indexOf(close, start);
  return end < 0 ? "" : template.slice(start, end + close.length);
}

function currentDateTime(timeZone) {
  return new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone });
}

export function createSystemPromptProvider({ store, configModelLabel = () => "", log = console }) {
  let memory = null;
  let inflight = null;

  async function fetchTemplate() {
    const response = await fetch(
      `${desktopUrl}/api/bootstrap/00000000-0000-4000-8000-000000000000/system_prompts`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) throw new Error(`Desktop returned ${response.status}`);
    const prompt = (await response.json())?.cowork_system_prompt?.value?.prompt;
    if (typeof prompt !== "string" || prompt.length < 500) {
      throw new Error("Desktop returned no cowork_system_prompt");
    }
    return prompt;
  }

  async function refresh() {
    try {
      const prompt = await fetchTemplate();
      memory = { prompt, fetchedAt: Date.now() };
      await store.writeJsonFile(cacheFile, memory).catch((error) => {
        log.error(`[mobile-system-prompt] cannot persist cache: ${error.message}`);
      });
    } catch (error) {
      log.error(`[mobile-system-prompt] refresh failed: ${error.message}`);
      if (!memory) memory = await store.readJsonFile(cacheFile, null);
      if (typeof memory?.prompt !== "string") {
        memory = null;
        throw new SystemPromptUnavailableError(
          "the Desktop system prompt is unavailable and no cached copy exists",
        );
      }
      // Keep serving the stale copy, retrying after one TTL.
      memory = { ...memory, fetchedAt: Date.now() };
    }
  }

  async function getTemplate() {
    if (memory && Date.now() - memory.fetchedAt < ttlMs) return memory.prompt;
    inflight ||= refresh().finally(() => { inflight = null; });
    await inflight;
    return memory.prompt;
  }

  // Returns the system prompt for a turn, or undefined when disabled.
  async function build({ modelId }) {
    if (mode === "off") return undefined;
    const template = await getTemplate();
    const timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const identity = modelIdentity(modelId, configModelLabel(modelId));
    const model = (modelId || "Claude").replace(/\[[^\]]+\]$/, "");

    let prompt;
    if (mode === "full") {
      prompt = template
        .replaceAll("{{modelName}}", () => model)
        .replaceAll("{{currentDateTime}}", () => currentDateTime(timeZone))
        .replaceAll("{{currentTimezone}}", () => timeZone)
        .replaceAll("{{accountName}}", () => "")
        .replaceAll("{{emailAddress}}", () => "")
        .replaceAll("{{folderSelected}}", () => "No");
      prompt = identity
        ? prompt.replaceAll("{{modelIdentity}}", () => identity)
        : prompt.replace(/\n?\{\{modelIdentity\}\}/g, "");
    } else {
      const sections = chatSections.map((name) => extractSection(template, name)).filter(Boolean);
      if (!sections.length) {
        throw new SystemPromptUnavailableError(
          "the Desktop system prompt has none of the expected sections; "
          + "set CLAUDE_MOBILE_SYSTEM_PROMPT=full or update system-prompt.mjs",
        );
      }
      if (sections.length < chatSections.length) {
        log.error(`[mobile-system-prompt] ${chatSections.length - sections.length} expected section(s) missing from the Desktop prompt`);
      }
      prompt = [
        chatPreamble,
        `<claude_behavior>\n${sections.join("\n")}\n</claude_behavior>`,
        `<env>\nToday's date: ${currentDateTime(timeZone)}\nTimezone: ${timeZone}\nModel: ${model}\n</env>`,
        identity,
      ].filter(Boolean).join("\n\n");
    }
    return prompt;
  }

  return { build, mode };
}
