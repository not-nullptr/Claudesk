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
| text/other files | uploaded to `/workspace/RemoteUploads/<id>/` and referenced as `@"path"` at the start of the message |
| images | the `images` argument as `{name, mimeType, base64}` |

Only Chat sessions are visible or writable from the phone; Cowork and Claude Code
sessions are never listed, read or modified, and a completion cannot adopt their id.

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

Set `CLAUDE_MOBILE_CAPTURE=1`, recreate the service, open the Cowork and Code tabs
(start a session, open one, send a message), then read `mobile-data/capture.jsonl`.
Each line is a request; those the service does not implement include a redacted
body. The schema already names the pieces (`cowork/sessions`, `cowork/remote_devices`,
`RecentCoworkSession`, `RecentCodeSession`, `ReadCoworkSession`, and the
`targetDeviceId`, `continueCoworkSessionId` and `attachedFolders` fields of
`BardSendMessage`). Turn capture off afterwards.

## Tests

- `scripts/desktop-translators-smoke.mjs` replays data recorded from a live bridge
  (`scripts/fixtures/desktop-chat-probe.json`, `desktop-tools-probe.json`) and checks
  that the live stream and the stored transcript give identical blocks.
- `scripts/mobile-api-smoke.mjs` runs the whole service against
  `scripts/lib/fake-claudesk.mjs`.
- `scripts/desktop-session-probe.mjs` is a manual probe that records fresh fixtures
  from a live bridge (it spends a few inference calls and deletes its session).
