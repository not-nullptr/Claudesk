# Claude iOS "Code" tab — full wire contract and the Claudesk bridge

Source: static analysis of the decrypted iOS binary
(`com.anthropic.claude_1.260925.19`, arm64 Mach-O) in `/workspace/ipa-work/claude.bin`.
Addresses are VAs in that image (`__TEXT` base 0x100000000). Companion to
`docs/mobile-code-re-findings.md` (which covers the four load legs and the DTO
field lists); this file records the **complete** endpoint surface, the event /
message wire shapes, and how each maps onto the bridge's real Desktop IPC.

## 1. Client API modules (who calls what)

The Code surface is an SPM target `ClaudeCodeApi`, five source files:

| File | Endpoints |
|---|---|
| `SessionsApi+Events.swift` | `v1/code/sessions/…/events` (`list_client_events_v2`) |
| `SessionsApi+Stream.swift` | `v1/code/sessions/watch` (SSE), `include_trigger_sessions` |
| `SessionsApi+Share.swift` | `v1/code/shared-sessions/…`, `shared_session_events_v2`, `from_sequence_num` |
| `ChannelMessagesApi.swift` | `…/messages/stream` (send), channel message CRUD |
| `SessionPendingPrompts.swift` | `session_pending_prompts`, `permission_suggestions`, `force_run_trigger` |

UI lives in `ClaudeCodeSessionFeature` (134 files: `SessionModel`,
`SessionModel+Composer`, `CodeSessionDetailModel`, `Transcript*`, `ToolCall*`,
`DiffReview*`, `PullRequest*`, `Routine*`, `Project*`). The list/detail/transcript
all read the **same** `SessionResource` + event stream; there is no separate
"list DTO" beyond `SessionResponse` (widget-only thin row).

## 2. Endpoint surface (all under `/v1/code/…` unless noted)

```
GET    /v1/code/sessions?limit&cursor&statuses&tags&exclude_tags
                        &include_trigger_sessions&trigger_id
POST   /v1/code/sessions                       create   (CreateSessionRequest)
GET    /v1/code/sessions/{id}                  detail   (SessionResource)
POST   /v1/code/sessions/{id}/messages/stream  SEND (SendChannelMessageRequest)
GET    /v1/code/sessions/{id}/events           list_client_events_v2 -> ListClientEventsResponse
GET    /v1/code/sessions/{id}/events/stream    SSE — the transcript read the
                                               session detail screen opens
                                               (`SessionStreamWire`): the history
                                               replayed as `client_event` frames,
                                               then the live ones.
                                               `from_sequence_num` resumes. Not
                                               a literal in the binary (it is
                                               composed from the events base);
                                               found by watching the app's own
                                               requests against the facade.
GET    /v1/code/sessions/watch                 SSE      (SessionWatchFrame)
GET    /v1/code/shared-sessions/{id}/events    shared_session_events_v2
GET    /v1/code/channels[/{id}]                channel (project/thread) list
GET    /v1/code/triggers[/{id}]                routines
GET    /v1/code/webhook-triggers
GET    /v1/code/runners/self-hosted/pools
GET    /v1/code/github/{compare-refs,get-file-content,pull-request}
POST   /v1/code/github/{get-batch-branch-status,set-pr-auto-merge,
                        submit-pull-request-review}   ← POST despite the name
GET    /v1/code/repos/resync
GET    /api/claude_code/organizations/{org}/…  (per-session sub-resources)
GET    /api/organizations/{org}/experiences    banner leg
GET    /api/organizations/{org}/usage          org usage card       (UsageResponse)
GET    /v1/environment_providers/private/organizations/{org}/environments
GET    /v1/environment_providers/private/organizations/{org}/environments/{id}
```

Two of these were only found by watching the app's own traffic against the
facade, because neither is a plain literal in the binary:

- **`POST /v1/code/sessions/{id}/events`** — the app pushes its *own* client
  events (presence, the "I loaded these events" ack, client attestation) to the
  same collection it reads history from. `sendEventsHandler` and the event kinds
  `load_events` / `send_events` / `ws_close` / `sse_probe` in the string pool are
  what the app sends here. There is no upstream for them on the facade, but a
  404 breaks the detail screen.
- **`POST /v1/code/github/get-batch-branch-status`** — a POST (it carries the
  refs in the body), reached alongside its GET siblings once a PR row exists.
- **`GET …/environments/{id}`** — the by-id read the detail screen makes to
  resolve a session's runner; it asks for the same `anthropic-bridge-local`
  record the list advertises.

Paging everywhere is `{data|rows, next_cursor, has_more}` (snake_case).

## 3. Event / transcript model (this is what the transcript pane renders)

**There are two distinct SSE protocols under `/v1/code/…`, and they do not
share a frame shape.** Feeding one the other's envelope is what made the
session detail screen open to "the messages failed to load" (the app's
`SessionSseFrame` decoder rejects an `upserted` envelope and renders nothing).

### 3a. The list leg — `SessionWatchWire`

```
GET /v1/code/sessions/watch        (and /v1/code/sessions/{id}/watch)
SessionWatchFrame   event          (the ONLY field — no payload)
SessionWatchEvent   upserted | deleted
```

The list screen subscribes here to keep its rows current. The facade emits one
`upserted`/`deleted` frame per Desktop `onOnEvent` record, carrying the entry's
`SessionEventEnvelope` as the record payload.

### 3b. The transcript leg — `SessionStreamWire`

```
GET  /v1/code/sessions/{id}/events/stream     the detail screen's transcript
POST /v1/code/sessions/{id}/messages/stream   the send leg (same protocol)
```

Each SSE record's **`event:` name** is one of `client_event` or
`ephemeral_event` (the only two the app's dispatcher compares against), and the
**`data:`** is `SessionSseFrame`, a 6-case Swift enum:

```
SessionSseFrame   clientEvent | ephemeralEvent | deliveryUpdate | sessionUpdate
                  | catchUpTruncated | decodeFailure
StreamDeliveryUpdate      eventId, status, timestamp
StreamSessionUpdate       connectionStatus
StreamCatchUpTruncated    fromSequenceNum, atSequenceNum
SessionStreamDecodeError              context, eventId, eventType, underlyingTypeName
SessionStreamContractViolationError   context, missing
```

Swift synthesizes enum `Codable` as a **single-key object**, and the app's
shared `JSONDecoder` runs `.convertFromSnakeCase` over the keys, so the wire is:

```
event: client_event
data: {"client_event":{"sdk_message":<SdkMessage>}}
```

`clientEvent` carries a **`StdoutMessage`**, itself a synthesized enum keyed
`sdk_message | control_request | control_response | control_cancel_request |
stream_event | sources_changed | unknown`. Its `sdk_message` case is a
**`SdkMessage`**, whose cases are the stream-json `type` values:

```
assistant | user | result | system | env_manager_log | tool_use_summary
| rate_limit_event | prompt_suggestion | conversation_reset
| composer_notice | composer_notice_dismissed | control_request
| control_response | control_cancel_request | unknown
```

`SdkUserMessage` / `SdkAssistantMessage` / `SdkResultMessage` are **structs**
declaring the stream-json fields (`type, uuid, message, parentToolUseId,
timestamp, origin, …`) — i.e. the Desktop transcript entry passes through
almost verbatim. `mobile/code-transcript.mjs#streamJsonFor` does that mapping;
`#sseFrameForEntry` wraps it into the frame. History and live records both use
it, so a session with no live activity still draws.

### The paged history read (neither leg)

```
GET    /v1/code/sessions/{id}/events          list_client_events_v2
SessionEventEnvelope   eventId, sequenceNum, eventType, source, payload, createdAt
ClientEventsPage       rows, maxSequenceNum, newestEventId, nextCursor, hasMore
ListClientEventsResponse  data, nextCursor
UsageResponse          limits, spend, extraUsage
MessageLimit           status, resetsAt, remaining, overageInUse, notice,
                       perModelLimit, overageStatus, overageResetsAt,
                       windows, model     (windows: [MessageLimitWindow])
MessageLimitWindow     status, resetsAt, utilization, surpassedThreshold,
                       period, limitScope, groupUuid
```

The usage card's window `period` values are `five_hour | seven_day |
seven_day_opus | seven_day_sonnet | overage`; an unmetered self-hosted
deployment reports every one at `utilization: 0`.

So history = paged `ClientEventsPage` seeded by walking **down** from the newest
`sequenceNum` until `hasMore == false`; live = `sessions/watch` SSE emitting a
`SessionWatchFrame{event}` per change, resumable `from_sequence_num`. The pager
type confirms the algorithm: `SessionTranscriptPager`
(@0x4b063bc) with `olderCursor`, `lastSequenceNum`, `readsGapAscending`,
`initialEventsLimit` — it reads **ascending above** a floor and pages **older**
on demand, and tolerates a truncated catch-up.

`payload` carries the actual turn content. The rendering types are
`ToolCall` (@0x4b050fc, 22 fields: `id name displayName status input output
outputImages subagentToolCalls gitOperation fileMetadata artifactId …`) and the
transcript block union (`SessionTranscriptEntry` / `DisplayBlock*` /
`AssistantTextBlockView`, `CodeThinkingView`, `CollapsedToolCallList`).

## 4. Sending a message

```
SendChannelMessageRequest   body, replyToMessageId, clientMessageId, attachments
SendChannelMessageResponse  messageId, threadRootId, createdAt
```

The composer POSTs `/v1/code/sessions/{id}/messages/stream` with a body of
`{body, client_message_id, attachments?, reply_to_message_id?}` and then reads
the turn from `sessions/watch`. `clientMessageId` is the app's optimistic uuid
(mirrors the chat `messageUuid` honouring in `docs/mobile-claudesk-backend.md`).

## 5. Enums (raw values recovered from the string pool)

```
SessionStatus           requires_action | running | idle | archived | pending | unknown
SessionStatusBucket     blocked | unknown | review_ready | working | completed | failed
SessionConnectionStatus connected | disconnected | unspecified | unknown
SessionWorkerStatus     running | idle | requires_action | unspecified | unknown
EnvironmentKind         anthropic_cloud | byoc | bridge | unknown
BridgeSpawnMode         single-session | worktree | same-dir
SessionWatchEvent       upserted | deleted
```

Wildcard values are 0x1047e59e0 `provision_failed`, 0x1047e901c `review_ready`,
0x10479e4e9 `anthropic_cloud`, 0x1047e9089 `single-session`, 0x1047e90a1
`same-dir`, 0x104ba4984 `upserted`. Note the **enum-value casing rule**: the key
strategy never rewrites these, only dictionary keys, so the wire values are the
literals above even though the Swift cases are camelCase.

## 6. Mapping onto Claudesk (the real Desktop IPC)

Claudesk's bridge already exposes, behind `CLAUDE_REMOTE_CODE_ACTIONS=1`, the
`LocalSessions` surface and its listeners `onOnEvent` /
`onOnToolPermissionRequest` (`bridge/server.mjs` @290 / @464) — that is Desktop's
own Claude Code session manager, the same one the Claudesk web UI drives. No new
Desktop surface is needed; the mobile facade must **translate**:

| Phone (claude.ai shape) | Desktop IPC (LocalSessions) |
|---|---|
| list sessions | `getAll`, `searchSessions`, `getSessionsForScheduledTask` |
| session detail (`SessionResource`) | `getSession` + `getTranscriptTail`/`getTranscript` |
| history (`ClientEventsPage`) | `getTranscript` / `listSessionDirectory`, paged |
| live turn (`sessions/watch` SSE) | listener `onOnEvent` |
| send message | `sendMessage` (+ `start` for a new session) |
| stop | `interrupt` / `stop`, `stopTask` |
| queued message | `promoteQueuedMessage`, `cancelQueuedMessage`, `reorderQueuedMessage` |
| permission prompt | `respondToToolPermission` (listener `onOnToolPermissionRequest`) |
| model / effort / mode | `setModel`, `setEffort`, `setFastMode`, `setPermissionMode` |
| git / diff | `getGitInfo`, `getGitDiff`, `getGitDiffStats`, `getUncommittedChanges`, `getDiffFileContent` |
| files | `readSessionFile`, `writeSessionFile`, `resolveSessionFile`, `listSessionDirectory` |
| archive / delete / rename | `archive`, `unarchive`, `delete`, `updateSession` |
| projects / channels | `getDetectedProjects`, `getLocalBranches`, `getRemoteSessionSpaces` |

This is exactly the shape `mobile/engine.mjs` already uses for Chat
(`SURFACE = "LocalAgentModeSessions"`), so the Code work is a parallel
`LocalSessions` module: a new `mobile/code-*.mjs` translation layer plus routes
in `mobile/server.mjs`, with the session record translated to `SessionResource`
and the turn translated to `SessionEventEnvelope` / `ToolCall`.

### What was built (this landing)

| Module | Role |
|---|---|
| `mobile/code-ids.mjs` | `code_<desktopSessionId>` scheme and the enum literal tables + status/bucket/connection/worker derivations |
| `mobile/code-transcript.mjs` | `SessionResponse`/`SessionResource`, transcript entry → `SessionEventEnvelope`, `ToolCall`, the cursor pager, and the bridge environment record |
| `mobile/code-events.mjs` | live `LocalSessions.onOnEvent` records → both SSE protocols: `client_event` frames for the transcript leg (`frameFromPayload`) and `SessionWatchFrame` upserted/deleted for the list leg (`watchFrameFromPayload`), with the per-session sequence counter |
| `mobile/code-engine.mjs` | the engine: list/create/detail/update/delete, history paging, send, interrupt, permissions, live watch, `code-meta.json` |

The id scheme is deliberately distinct from Chat's `local_<uuid>`: a Code
session is `code_<desktopSessionId>`, so the two can never be confused and a
Desktop id is never adopted by the wrong surface. Both still satisfy the
bridge's `^[A-Za-z0-9_-]+$` sessionId charset.

Two things are **not** implemented here and answer clean empty states rather
than 404s, so those screens render: routines/triggers/channels, projects, the
git/PR/diff legs, and self-hosted runner pools.

## 7. The Desktop IPC contract (read from the app, not guessed)

The `LocalSessions` argument shapes are **not** recoverable from the iOS binary
and do not need to be probed: they are in the **installed Desktop app's ASAR**,
in this container at

```
/usr/lib/claude-desktop/resources/app.asar
  → /.vite/build/index.chunk-<hash>.js
```

Each interface registers as `[method, [[paramName, validator], ...], resultValidator]`,
and the validators are small combinators: `F = typeof === "string"`,
`L = optional` (undefined or inner), `R = nullable`, `z = array-of`. The
validator that raises `Argument "X" at position N to method "M" … failed to pass
validation` walks those `[paramName, validator]` pairs — which is why the error
names the *parameter* but never its shape, and why the earlier shape-guessing
probe could not converge.

The signatures the facade depends on:

| Method | Parameters |
|---|---|
| `start` | `info` — **`cwd: string` and `message: string` are both required**; optional include `sessionId`, `model`, `title`, `permissionMode`, `useWorktree`, `effort`, `fastMode`, `mcpServers`, `attachments`, `additionalDirectories` |
| `getAll` | *(none)* → array of session objects (`sessionId`, `cwd`, `originCwd`, `isRunning` required; no `sessionType`) |
| `getSession` | `sessionId` |
| `getTranscript` | `sessionId` → array of entries |
| `getTranscriptTail` | `sessionId`, `limit` (number) |
| `sendMessage` | `sessionId`, `message`, then optional tails (`images`, `userSelectedFiles`, `messageUuid`, …) — **no positional gap** |
| `interrupt` / `stop` | `sessionId` |
| `delete` | `sessionId` |
| `setModel` | `sessionId`, `model` |
| `setEffort` | `sessionId`, **`effortLevel`** |
| `setPermissionMode` | `sessionId`, `mode` (`default\|acceptEdits\|plan\|bypassPermissions\|dontAsk\|auto`) |
| `updateSession` | `sessionId`, `options` (all fields optional; **rejected for a session that does not exist**) |
| `respondToToolPermission` | **`requestId`, `decision`** (+ optional `updatedInput`) — two args, `requestId` first, **no `sessionId`**. `decision ∈ once \| always \| deny` |
| `getDefaultWorkspaceFolders` | *(none)* → `string[]` — the source of a new session's `cwd` |

`sessionId` is a plain string everywhere: no prefix, no regex, no brand. The
`code_` tag is therefore purely the facade's own convention, never sent to
Desktop.

### Corrections this produced

Five bugs passed against the fake bridge and could only fail live; all are fixed
and now guarded offline, because `scripts/lib/fake-claudesk.mjs` reproduces
Desktop's validation:

1. `start` sent no `cwd` — the single reason every probe shape was rejected.
2. `respondToToolPermission` sent `(sessionId, requestId, behavior)`; the real
   call is `(requestId, decision)` with `decision ∈ once|always|deny`. The old
   `"allow"` would have validated (plain string) and been silently ignored.
3. `createSession` fabricated a session Desktop had never heard of; the first
   `sendMessage` is what actually creates one.
4. `sendMessage` inserted a positional `undefined` gap copied from Chat.
5. `setEffort`'s parameter is named `effortLevel`.

Also corrected against the live surface: **`getAll` rows carry no `sessionType`**
(18 real rows, all `local_…`), so filtering on `sessionType === "code"` dropped
every session — the surface is the discriminator. And **Code ids are `local_<uuid>`**,
the same prefix Chat uses; collisions are avoided by surface, not by prefix.

### What is still open

Only the **listener payloads**, which the type schema does not describe:
`onOnEvent`'s framing (entry vs wrapper, and what marks a removal) and
`onOnToolPermissionRequest`'s payload. `scripts/code-session-probe.mjs` is now a
small live watcher for exactly those — it starts one real session (with the
verified `{cwd, message}`), records both listeners, and deletes the session.

```sh
CLAUDE_REMOTE_CODE_ACTIONS=1 \
CLAUDE_MOBILE_DESKTOP_URL=http://127.0.0.1:15821 \
  node scripts/code-session-probe.mjs --tools --out /tmp/desktop-code-probe.json
```

`--tools` also provokes a permission prompt. From the host, use the published
port (15821), not the in-network 8080.
