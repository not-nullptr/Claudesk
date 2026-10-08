# Mobile chat runs inside Claudesk

The mobile service (`mobile/`) impersonates claude.ai for the iOS app. It does not
call a model itself. A phone chat is a **Claude Desktop Chat session**, reached
through the bridge, so it appears in the Claudesk web UI and uses the same system
prompt, models, tools and attachment handling. Chats started in the web UI show up
on the phone.

```
iOS app ──REST/SSE + Connect──▶ mobile service ──HTTP (docker network)──▶ cowork-bridge ──▶ Claude Desktop
                                  chat-meta.json                          /api/remote/ipc
                                  uploads, auth                           /api/events (SSE)
```

## How it maps

| Phone | Desktop |
|---|---|
| conversation `<uuid>` | session `local_<uuid>` (the id is chosen by the app and honoured by Desktop) |
| human message uuid | the transcript user entry's `uuid` (passed as `messageUuid`) |
| assistant message uuid | chosen by the app, remembered in `chat-meta.json`; otherwise the first assistant entry's uuid |
| first message of a new chat | `LocalAgentModeSessions.start` (a conversation is a local draft until then) |
| later messages | `sendMessage` |
| streaming | Desktop's `onOnEvent` stream (Anthropic stream events wrapped in `stream_event`), translated by `events.mjs` |
| history | `getTranscript` (Claude Code JSONL), translated by `transcript.mjs` |
| tool calls | `tool_use` / `tool_result` pairs, presented by `blocks.mjs` |
| edit, retry | `rewind(sessionId, humanMessageUuid)` then `sendMessage`, like the web UI |
| stop | `stop` |
| rename, model | `updateSession({title})`, `setModel` |
| delete, archive | `delete`, `archive` (Desktop cannot un-archive a Chat session) |
| Cowork session in Recents | a `LocalAgentModeSessions` row whose `sessionType !== "chat"`, as a `coworkSession` item |
| opening a Cowork session | `ConversationService/ReadCoworkSession` → the same `BardConversationUpdate` a Chat read returns |
| sending in Cowork | `PerformAction` → `sendMessage` with `continueCoworkSessionId`; a new one starts with `targetDeviceId` |
| text/other files | uploaded to `/workspace/RemoteUploads/<id>/` and referenced as `@"path"` at the start of the message |
| images | the `images` argument as `{name, mimeType, base64}` |

Chat and Cowork share one Desktop manager (`LocalAgentModeSessions`) and one
transcript format, so they are one engine in this service: `engine.mjs` handles
both, and `sessionType` is the only difference. The two phone surfaces stay
disjoint — a Chat read never serves a Cowork session and vice versa, and neither
adopts the other's ids. Claude Code is a different Desktop surface
(`LocalSessions`) with its own engine (`mobile/code-engine.mjs`).

## Behaviour to know about

- **Edit is destructive.** Desktop Chat has one linear branch, so editing a message
  discards it and everything after it, exactly as in the web UI. There are no
  sibling branches; `setCurrentLeaf` is acknowledged and ignored.
- **Reasoning and tool calls are shown.** Whatever Desktop reports as the model's
  reasoning is sent as a `thinking` block on the REST stream and in history, and as a
  reasoning row (text, a short heading, start and completion times) on the Connect
  surface: a reasoning summary for closed-weights models, the raw reasoning for
  open-weights ones. Models that report none (some open-weights routes) show none.
  Desktop's opaque signature is never forwarded. `CLAUDE_MOBILE_THINKING=0` hides it.
  A tool call and its result appear inline:
  as `tool_use` / `tool_result` blocks on the REST stream and in history, and as a
  timeline group with a tool row (title, input summary, state, result text) on the
  Connect surface. Desktop's shell is presented as `bash_tool`, web search as
  `web_search`, file reads as `view`. How the iOS app actually draws these rows has
  not been verified on a device; `CLAUDE_MOBILE_TOOL_BLOCKS=0` hides tool calls and
  shows only the answer text. Tool results are cut at 12,000 characters.
- **Reasoning effort and thinking mode.** Each model in the model list carries
  Desktop's own `thinking` block (`effort_options`, `mode_options`, `always_on`), which
  is what the web UI builds its effort picker from; models without it show no picker.
  The app's pick arrives as `effort` / `thinking_mode` on a REST completion, or as
  `effort_level_token` / `thinking_mode_token` in a Connect send or settings update, and
  is applied to the Desktop session with `setEffort` and `setExtendedThinking` (a mode
  of `off` turns thinking off, any other offered mode turns it on). Values the model
  does not offer are ignored. The pick is remembered and reported back in the
  conversation's settings. `start` has no effort field, so on a chat's very first
  message the effort is applied right after the session is created and may only take
  hold from the second turn. Whether the iOS app reads the `thinking` block from this
  model list in the form the web UI does is not verified on a device.
  Static analysis of the iOS app shows the options are read from
  `model_selector_config[].models[].thinking` (`effort_options`, `mode_options`) and the
  selection from `model_selector_state[]` (`thinking`: `{effort, mode}` and
  `thinking_by_model`). The service stores the selection the app writes to
  `model_selector_state/{surface}`, reports it in bootstrap, and uses it for sends that carry
  no pick of their own. Feature flags that might gate the picker are unverified.
  The selector is **per surface**. The app's `ModelSurface` is exactly
  `unspecified | chat | cowork | code`; `ModelSelector` holds
  `states`/`configs` as `IdentifiedArray`s of `SurfaceState`/`SurfaceConfig`, and
  a surface with no entry gets no model, no picker and no send. The service
  answers all three real surfaces (`chat`, `cowork`, `code`) from the same model
  list. Two shapes are load-bearing: `SurfaceState.id`/`SurfaceConfig.id` are a
  `Surface` string wrapper that goes out as the bare string (`"chat"`), and
  `thinkingByModel` is an `IdentifiedArray<ModelThinkingDefault>` — a JSON
  **array** of `{id, thinking}`, not a dictionary. IdentifiedArray decodes
  all-or-nothing and the states sit in one, so a wrong container there takes the
  whole selector down with it.
- **Code tab gate.** On a paid plan, app_start carries the `mobile_remote_enabled` flag (in `org_growthbook`) and a `claude_code_web` access entry (in `current_user_access`); without them the Code tab is hidden. The sessions behind it are not implemented yet.
- **Titles.** After a new chat's first message starts, the service asks Desktop to
  write a title (`dust/generate_session_title`, the same call the web UI makes, which
  runs one small model request) and applies it unless the chat was renamed meanwhile.
  Until then the title is the first message. The request must carry a `model`:
  Desktop otherwise resolves its own small title model, which this gateway
  refuses (HTTP 403), and the generation fails outright — see the Code-side note
  in [mobile-code-re-findings](mobile-code-re-findings.md). `CLAUDE_TITLE_MODEL`
  selects it; unset, the conversation's model is used.
  The app sends an empty rename after a
  chat's first turn; that is ignored, because applying it blanked the title in
  Desktop. `CLAUDE_MOBILE_TITLES=0` turns generation off. Chats started before this
  change keep their empty title in Desktop (the phone shows the first message);
  rename them to fix.
- **Tool permission prompts** are not expected in Chat (the probe saw none while the
  model read files), but nothing on the phone could answer one. They are logged.
- **Model errors are shown as the answer.** When the gateway rejects a call (for example
  `API Error: 400 Upstream /v1/responses ...`), Desktop records that text as the
  reply, and so does the phone, rather than showing an empty message.
- **Reconnects.** If the event stream drops mid-turn, the live text may be cut short;
  the stored transcript is complete and is what the app sees on its next read.
- Mobile needs Claudesk: if the bridge is down, requests fail with 502/503 and the
  service recovers when it returns.

## Finding out how Cowork and Claude Code work on the phone

Cowork is implemented, but a few shapes are inferred rather than captured (the read
method name, the `RecentCoworkSession` worker oneof, and whether a new-Cowork
`start` needs extra arguments — see the notes in `connect.mjs` and `engine.mjs`).
To correct them, set `CLAUDE_MOBILE_CAPTURE=1`, recreate the service, open the
Cowork tab (start a session, open one, send a message), then read
`mobile-data/capture.jsonl`. Each line is a request; those the service does not
implement include a redacted body. `CLAUDE_MOBILE_COWORK=0` withdraws the whole
surface if it misbehaves. The schema names the pieces (`cowork/sessions`,
`cowork/remote_devices`, `RecentCoworkSession`, `RecentCodeSession`,
`ReadCoworkSession`, and the `targetDeviceId`, `continueCoworkSessionId` and
`attachedFolders` fields of `BardSendMessage`). Turn capture off afterwards.

## Tests

- `scripts/desktop-translators-smoke.mjs` replays data recorded from a live bridge
  (`scripts/fixtures/desktop-chat-probe.json`, `desktop-tools-probe.json`) and checks
  that the live stream and the stored transcript give identical blocks.
- `scripts/mobile-api-smoke.mjs` runs the whole service against
  `scripts/lib/fake-claudesk.mjs`.
- `scripts/desktop-session-probe.mjs` is a manual probe that records fresh fixtures
  from a live bridge (it spends a few inference calls and deletes its session).
