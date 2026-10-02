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
GET    /v1/code/sessions/watch                 SSE      (SessionWatchFrame)
GET    /v1/code/shared-sessions/{id}/events    shared_session_events_v2
GET    /v1/code/channels[/{id}]                channel (project/thread) list
GET    /v1/code/triggers[/{id}]                routines
GET    /v1/code/webhook-triggers
GET    /v1/code/runners/self-hosted/pools
GET    /v1/code/github/{compare-refs,get-batch-branch-status,get-file-content,
                       pull-request,set-pr-auto-merge,submit-pull-request-review}
GET    /v1/code/repos/resync
GET    /api/claude_code/organizations/{org}/…  (per-session sub-resources)
GET    /api/organizations/{org}/experiences    banner leg
GET    /v1/environment_providers/private/organizations/{org}/environments
```

Paging everywhere is `{data|rows, next_cursor, has_more}` (snake_case).

## 3. Event / transcript model (this is what the transcript pane renders)

```
SessionEventEnvelope   eventId, sequenceNum, eventType, source, payload, createdAt
ClientEventsPage       rows, maxSequenceNum, newestEventId, nextCursor, hasMore
ListClientEventsResponse  data, nextCursor
SessionWatchFrame      event    (one frame per SSE record)
SessionWatchEvent      upserted | deleted
```

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
| `mobile/code-events.mjs` | live `LocalSessions.onOnEvent` records → `SessionWatchFrame` (upserted/deleted), with the per-session sequence counter |
| `mobile/code-engine.mjs` | the engine: list/create/detail/update/delete, history paging, send, interrupt, permissions, live watch, `code-meta.json` |

The id scheme is deliberately distinct from Chat's `local_<uuid>`: a Code
session is `code_<desktopSessionId>`, so the two can never be confused and a
Desktop id is never adopted by the wrong surface. Both still satisfy the
bridge's `^[A-Za-z0-9_-]+$` sessionId charset.

Two things are **not** implemented here and answer clean empty states rather
than 404s, so those screens render: routines/triggers/channels, projects, the
git/PR/diff legs, and self-hosted runner pools.

## 7. Open questions to settle on a live bridge

These need `scripts/code-session-probe.mjs` against a real Desktop (they cannot
be read from the binary). The facade is written **against the fake bridge** in
`scripts/lib/fake-claudesk.mjs`, which implements the shapes below; each is
isolated so a probe result only touches one place.

The 2026-10 probe run (`/tmp/desktop-code-probe.json`, 18 live sessions) settled
the first batch:

| # | Question | Where the answer lives | Status |
|---|---|---|---|
| 5 | Whether `getAll` mixes Chat/Cowork/Code rows | `code-engine.mjs` `listSessions` filter | **settled — it does not.** `LocalSessions.getAll` returned 18 sessions, all `local_…`, and **none carried a `sessionType`**. The surface *is* the discriminator, so the filter now keeps every row with an id. (The old `sessionType === "code"` test dropped all 18.) |
| 6 | Whether the paired Desktop needs an `environment` before a session can start | `code-transcript.mjs` `bridgeEnvironment` | **settled — no.** Real Code sessions already exist and are addressable by `getSession` with a plain `local_…` id; the bridge device is offered as a runner, not provisioned before use. |
| 7 | Which prefix Code session ids use | `code-ids.mjs` | **settled — `local_<uuid>`, the same prefix as Chat.** Collisions are avoided by surface, never by prefix: `code_` is a facade-level tag stripped before every IPC call, and the chat legs are backed by a different Desktop surface, so a `local_` id reaching the Code routes can only mean a Code session. |
| 8 | What the `mode=code` event stream emits | `code-events.mjs` | **partly settled.** It opens with a `sessions` snapshot `{chat, cowork, observedAt}` — but note those buckets come from `bridge/realtime.mjs`'s `pollState`, which reads `LocalAgentModeSessions.getAll`, i.e. the *Chat* surface. Per-session `LocalSessions.onOnEvent` frames still need a live turn to observe. |
| 9 | The real create path | `code-engine.mjs` `ipcArgs.start` | **open, and now the only blocker.** All four first-round shapes were rejected with `Argument "info" at position 0 to method "start" ... failed to pass validation`, which names the argument but not its contents. The probe now leads with `info`-object shapes and, if all fail, tries `createSession`/`warmSession` and records which the surface accepts. |
| 1 | Arg order/shape of `getTranscript` vs `getTranscriptTail` | `code-engine.mjs` `ipcArgs.getTranscript` | open — the first probe run never got a session to read; assumes `[sessionId]` → full entry array |
| 2 | Whether `sendMessage` returns a message id or only an ack | `code-engine.mjs` `sendMessage` return | open — ack synthesized from the `clientMessageId` the app sent |
| 3 | Which `onOnEvent` payloads are `upserted` vs `deleted` | `code-events.mjs` `frameFromPayload` | open — assumes one entry per record, `removed`/`deleted` marks a removal |
| 4 | Tool-call payload → `ToolCall` field mapping | `code-transcript.mjs` `toolCallFromUse` | open — reuses `blocks.mjs`, so a Code and a Chat tool row look the same |

Questions 1-4 are now reachable: they only need a session to exist, which the
create-path fix unblocks.

Run it (it spends a few inference calls on the configured gateway and always
deletes the session it created):

```sh
CLAUDE_REMOTE_CODE_ACTIONS=1 \
CLAUDE_MOBILE_DESKTOP_URL=http://127.0.0.1:8080 \
  node scripts/code-session-probe.mjs --tools --out /tmp/desktop-code-probe.json
```

`--tools` also provokes a permission prompt so `respondToToolPermission`'s
arguments and the `onOnToolPermissionRequest` payload are recorded.
