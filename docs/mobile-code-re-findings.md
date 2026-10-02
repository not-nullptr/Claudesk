# Claude iOS: Code tab endpoints — reverse-engineering findings

Source: static analysis of the decrypted iOS binary
(`com.anthropic.claude_1.260925.19`, arm64 Mach-O, 94 MB) in `/workspace/ipa-work/claude.bin`.
Everything below is read from the binary's Swift metadata (`__swift5_types`,
`__swift5_fieldmd`, `__swift5_reflstr`) or its C-string pool; FACTS carry hex
addresses, INFERENCES are labelled.

## Requests the app makes when the Code tab opens

From the device capture (2026-10-02):

```
GET /v1/code/sessions?limit&statuses&statuses&statuses         -> 404
GET /v1/code/sessions?limit                                    -> 404
GET /api/organizations/<org-uuid>/experiences                  -> 404
GET /v1/environment_providers/private/organizations/<org-uuid>/environments?limit -> 404
```

All four are the tab's load legs (see `CodeTabLoadResult` below). The tab
requests them, so the earlier "tab hidden" gate — the membership role — is
already past; what is missing is the data these four return.

## The tab's model and load legs

`CodeRootModel` (type descriptor @0x4b2382c, 39 fields) holds:
`sessionListStore`, `archivedListStore`, `sessionCreator`, `repoStore`,
`environmentStore`, `ungatedRemoteDevices`, `ungatedProjectStore`,
`sessionList`, `organizationStore`, `subscriptionPickerBuilder`, `routinesBuilder`,
`isLoadingSessions`, `tabLoadMeasurement`.

`CodeTabLoadResult` (@0x4afdbd8) names the legs the tab measures:
`surface, durationMs, timedOut, hadError, sessionsMs, devicesMs, projectsMs,
settledMs, reposMs, authMs, bannerMs, fastLoad, navTemp, outcome`.

So "opening the tab" = sessions list + devices list + projects + repos + auth +
banner. `sessionsMs` is the `/v1/code/sessions` leg; `devicesMs` is the
`/v1/environment_providers/.../environments` leg (remote devices are environments
of kind `bridge`); `bannerMs` is the `/api/organizations/<uuid>/experiences` leg
(placement `codeSessionListBanner`).

## Endpoint 1 — `GET /v1/code/sessions`

Response envelope: **`ListSessionsResponse`** (@0x4ae9630), fields
`data, nextCursor, resumeToken`; its `CodingKeys` enum @0x4ae9844 has exactly
those three cases. So the body is `{"data":[…], "nextCursor":…, "resumeToken":…}`.

Request params: **`ListSessionsParams`** (@0x4aea080):
`cursor, limit, statuses, tags, excludeTags, includeTriggerSessions, triggerId`.
`statuses` is a repeated query parameter. Its wire values come from
`SessionListStatusFilter` (@0x4aea064): `active, paused, archived, provisionFailed`.

Row type: **`SessionResponse`** (@0x4ae94c8), 23 fields (see `CodingKeys` @0x4ae972c,
same names):

```
id, environmentId, environmentKind, title, status, tags, config, workerStatus,
connectionStatus, externalMetadata, createdAt, lastEventAt, updatedAt,
postTurnSummary, taskSummary, unread, selfHostedRunnerPoolId,
selfHostedRunnerState, agentId, triggerId, boundDevice, statusBucket,
connectorDomainsWithheld
```

`SessionConfig` variant (@0x4c7f274): `sources, outcomes, model, permissionMode,
effortLevel, origin, memoryMode`; the create-request variant (@0x4c7f4c4) is
`sources, cwd, outcomes, customSystemPrompt, appendSystemPrompt, model, effortLevel`.

A second, richer row type **`SessionResource`** (@0x4ae9cfc) is used for the
single-session read (`GET /v1/code/sessions/<id>`, `get_session_v2_bundled_shared`):
`id, title, sessionStatus, environmentId, environmentKind, createdAt, updatedAt,
sessionContext, permissionMode, bridgeSpawnPath, connectionStatus, workerStatus,
postTurnSummary, externalMetadata, unread, taskSummary, tags, agentId,
selfHostedRunnerPoolId, selfHostedRunnerState, triggerId, origin, boundDevice,
statusBucket, revision, connectorDomainsWithheld`.

Watch stream (`GET /v1/code/sessions/watch`, SSE): `SessionWatchEvent` (@0x4aea6d8)
= `upserted | deleted`; the request carries `include_trigger_sessions`.

## The two Code SSE protocols (settled from the binary)

`/watch` and `/{id}/events/stream` are **different wire protocols**; emitting
the watch shape on the transcript leg is what made a session open to "the
messages failed to load".

- **`SessionWatchWire`** (`GET /v1/code/sessions/watch`): `SessionWatchFrame`
  (@0x4ae9b30) with a single field `event` of type `SessionWatchEvent`
  (@0x4aea6d8 = `upserted | deleted`).
- **`SessionStreamWire`** (`GET …/events/stream`, `POST …/messages/stream`):
  `SessionSseFrame` (@0x4ae9230), a 6-case enum —
  `clientEvent | ephemeralEvent | deliveryUpdate | sessionUpdate |
  catchUpTruncated | decodeFailure` — with the payload structs
  `StreamDeliveryUpdate` (@0x4ae9100), `StreamSessionUpdate` (@0x4ae9128),
  `StreamCatchUpTruncated` (@0x4ae92ac), and the two error types
  `SessionStreamDecodeError` (@0x4ae91c0 = `context, eventId, eventType,
  underlyingTypeName`) and `SessionStreamContractViolationError` (@0x4ae91dc =
  `context, missing`).

Evidence for the wire casing:

- `SessionSseFrame`'s `CodingKeys` field descriptor is the **only** cluster
  holding its case names, contiguous at `__swift5_reflstr` **0x4ba37f0**:
  `clientEvent ephemeralEvent deliveryUpdate sessionUpdate catchUpTruncated
  decodeFailure`. Swift synthesizes enum `Codable` as a single-key object, and
  the app's `JSONDecoder` runs `.convertFromSnakeCase` (keys only), so the wire
  keys are `client_event`, `ephemeral_event`, … .
- The SSE dispatcher (fn @0x101eb7b00) compares the SSE **`event:` name**
  against exactly two inline Swift small-strings: `client_event` (built at
  0x101eb7b34) and `ephemeral_event` (at 0x101eb7c2c).
- The JSON body is decoded with `JSONDecoder.decode(_:from:)` at 0x101f08e08;
  the failure paths build the two error types above.
- `SessionSseFrame.clientEvent` carries `StdoutMessage` (@0x4ae70e8), whose
  `CodingKeys` cluster (reflstr ~0x4ba1e08) is `controlRequest controlResponse
  controlCancelRequest streamEvent sourcesChanged sdkMessage`; its
  `sdkMessage` case is `SdkMessage` (@0x4ae7088), whose cases are the
  stream-json `type` values (`assistant user result system envManagerLog
  toolUseSummary rateLimitEvent promptSuggestion conversationReset
  composerNotice composerNoticeDismissed controlRequest controlResponse
  controlCancelRequest unknown`).

So a transcript frame is
`event: client_event` / `data: {"client_event":{"sdk_message":<SdkMessage>}}`,
and `<SdkMessage>` is essentially the Desktop transcript entry
(`{type, uuid, message, parentUuid, timestamp, origin, …}`) — see
`mobile/code-transcript.mjs#streamJsonFor`.

### The paged read is the same payload type (settled on device, 2026-10-03)

The session detail screen does **two** reads, and both carry the same message:

```
GET /v1/code/sessions/{id}/events?sort_order=desc&limit=200   the page
GET /v1/code/sessions/{id}/events/stream?from_sequence_num=0  the live follow
POST /v1/code/sessions/{id}/events   (x2)                     the app's ack
```

Both paths appear only in the app's own request log — they are composed from the
`v1/code/sessions/` base, so neither is a whole-string literal in the binary.
`SessionsApi+Events.swift` owns the `list_client_events_v2` page; the stream
leg is built alongside it.

`ClientEventsPage` (type descriptor @0x4ae917c has its nested `Row`) is

```
ClientEventsPage        rows, maxSequenceNum, newestEventId, nextCursor, hasMore
ClientEventsPage.Row    sequenceNum, message
ListClientEventsResponse data, nextCursor
```

Evidence for the keys: the coding-key cluster at `__swift5_reflstr` **0x4ba374f**
reads `…connectionStatus desc asc rows maxSequenceNum newestEventId nextCursor
hasMore message`, and the `ListClientEventsResponse` cluster at **0x4ba37c0**
reads `…offendingSequenceNum context underlyingTypeName missing data clientEvent
ephemeralEvent deliveryUpdate sessionUpdate catchUpTruncated decodeFailure
fromSequenceNum…` (so `data` is the response, and the frame cases follow).

FACT: a row's `message` **is** a `StdoutMessage`. In the field descriptors,
`ClientEventsPage.Row.message`'s type slot holds the bytes `01 29 f9 51` —
**byte-identical** to `StdoutMessage.sdkMessage`'s slot (both resolve to the
same `__LINKEDIT` symbol). So the paged read and the SSE stream deliver the same
type, and a row is `{sequence_num, message: {<case>: …}}`, not an envelope.

Emitting our own `SessionEventEnvelope` (`{event_id, sequence_num, event_type,
source, payload}`) on this leg is what left the transcript blank: the app
decoded a page whose rows had no `message`, so it had nothing to draw, while
`…/events/stream` was answering 200 with perfectly good frames the screen never
consulted for history.

## Endpoint 2 — `GET /v1/environment_providers/private/organizations/<uuid>/environments`

String at `v1/environment_providers/private/organizations/` (VA 0x1047e91d0).
Response: **`EnvironmentListResponse`** (@0x4aea52c): `environments, hasMore,
firstId, lastId`. Element: **`EnvironmentResource`** (@0x4aea504):
`kind, environmentId, name, createdAt, state, config, bridgeInfo`.

* `EnvironmentConfiguration` enum (@0x4aea4e8) = `anthropic | byoc | paired | unknown`.
* `AnthropicEnvironmentConfiguration` (@0x4aea494): `environmentType, cwd,
  initScript, environment, languages, networkConfig`.
* `ByocEnvironmentConfiguration` (@0x4aea4b0): `environmentType, cwd, taskSetupScript`.
* `PairedEnvironmentConfiguration` (@0x4aea4cc): `environmentType, machineName,
  directory, branch, gitRepoUrl`.
* `BridgeEnvironmentInfo` (@0x4aea424): `maxSessions, machineName, directory,
  branch, gitRepoUrl, online, spawnMode, cliVersion`.
* `EnvironmentState` (@0x4aea408) = `active | unknown`.
* `EnvironmentKind` (@0x4a7e00c) = `anthropicCloud | byoc | bridge | unknown`.
* `BridgeSpawnMode` (@0x4aea440) = `singleSession | worktree | sameDir`.

A remote device is an `EnvironmentResource` with `kind = bridge` and a
`bridgeInfo` describing the machine; the Devices section of the tab lists these.

## Endpoint 3 — `GET /api/organizations/<uuid>/experiences`

Base string `experiences` (VA 0x1047bc2e1); tracking paths `/experiences/track`
and `/experiences/action` (VAs 0x1047bc290, and its sibling) are already stubbed.
Response: **`ExperienceListResponse`** (@0x4ab37f8) = `experiences, rules`.

Element **`ExperienceResponse`** (@0x4a7eb40): `id, key, content, placementKey,
enabled, expId, tier, config`.

* `ExperienceContent` enum (@0x4a7ebbc) = `spotlight | tooltip | codeSessionBanner
  | chatInputBanner | unknown`.
* `ExperiencePlacement` enum (@0x4a7ec0c) = `spotlight | chatTooltip |
  codeSessionListBanner | chatInputBanner | projectsCreateSpotlight | unknown`.
* `ExperienceTier` = `ambient | unknown`.
* `ExperienceConfig` (@0x4a7eb68): `bypassGlobalRules, bypassAllRules`.
* `ExperienceRules` (@0x4a7ebe4): `global, placements`.
* `CodeSessionBannerContent` (@0x4a7ee20): `title, description, asset, buttons,
  inlineButtons, dismissible`.
* `ExperienceButton` (@0x4a7ede8): `text, type, actions, successToast`;
  `ExperienceButtonType` = `primary | secondary | destructive | tinted`.
* `ExperienceTooltipContent`: `title, text, footnote, locationId`.
* `ExperienceSpotlightContent` (@0x4a7ecb0): `title, description, badgeTitle,
  asset, bullets, bulletsStyle, buttons, dismissible, requiredClientState,
  toggle, requireScrollToBottom`.
* `ExperienceSpotlightAsset`: `image, video, resizeMode, backgroundColor, width,
  height`; scaled URLs are `{scale, url}`.

The tab only needs the `codeSessionListBanner` placement, so an empty
`{"experiences":[],"rules":{...}}` is enough to make the leg succeed.

## Next: creating a session

`POST /v1/code/sessions` body is **`CreateSessionRequest`** (@0x4ae956c):
`title, environmentId, selfHostedRunnerPoolId, config, idempotencyKey`.
Its `config` is **`CreateSessionRequestConfig`** (@0x4ae9588): `sources, cwd,
outcomes, customSystemPrompt, appendSystemPrompt, model, effortLevel`.

The client-side draft (**`CreateSessionParams`** @0x4b04ee4) carries the whole
intent: `repos, environmentId, selfHostedRunnerPoolId, isRepoLessCloudCreate,
message, modelId, effortLevel, fileAttachments, humanTypedText, permissionMode,
chatProjectId, device, memoryMode, source` — that is what the composer fills in
before the wire request is built. A `POST` returns the created session (a
`SessionResource`) and the watch stream then carries `upserted` frames.

Session title/branch generation: `POST …/generate_title_and_branch` takes
`GenerateTitleAndBranchParams{firstSessionMessage}` and returns
`GenerateTitleAndBranchResponse{title, branchName}`; the session-title variant
takes the same param and returns `{title}`.

## Wire casing

FACT: every camelCase field name of `ListSessionsResponse`, `SessionResponse`,
`EnvironmentListResponse`, `EnvironmentResource` etc. appears **verbatim** as a
C-string literal in the binary (e.g. `environmentId` @0x1047e69da,
`selfHostedRunnerPoolId` @0x10479bc60, `statusBucket` @0x1047e8a14,
`nextCursor` @0x1047e8a88, `firstId` @0x1047e96e9, `hasMore` @0x1047e958a),
and none of those literals has a code reference (`refs_all.py` finds zero) —
consistent with synthesised `CodingKeys` whose case names ARE the wire keys.

FACT: the snake_case spellings of the *access-status* enum values are present and
referenced: `blocked_by_org_admin` (0x10479c1d0, referenced at 0x1003c560c — a
getter returning that literal), `blocked_by_org_tier` (0x10479c1b0),
`blocked_by_entitlement` (0x10479c1f0), `blocked_by_platform` (0x10479c190).
So `CurrentUserAccess`'s `{feature,status}` items use **snake_case enum values**
(`available`, `blocked_by_org_admin`, …) while the surrounding object keys are the
snake_case names already sent (`features`, `account_features`,
`organization_permissions`).

FACT (resolved): the wire body is **snake_case**. The app's shared `JSONDecoder`
(factory 0x1001e5768, `keyDecodingStrategy` setter call 0x1001e5854; 42 call
sites) installs `.convertFromSnakeCase`, and its shared `JSONEncoder`
(0x1001e59f4) installs `.convertToSnakeCase`. So a camelCase Swift property such
as `nextCursor` is **`next_cursor`** in the JSON. Evidence, three independent
ways:

1. The repo's own spec states it (`docs/mobile-spec/…API-Spec….md` §"JSON
   codec": `emailAddress → email_address`, `modelSelectorState →
   model_selector_state`) and the facade's already-working `/api/account`
   endpoint sends `email_address` / `created_at` / `is_verified`.
2. These DTOs carry **no** custom `CodingKeys` raw values: the snake spellings
   (`next_cursor`, `status_bucket`, `self_hosted_runner_pool_id`,
   `connector_domains_withheld`) do **not** occur anywhere in the binary. The
   only `*_kind`/`*_token` hits (`environment_kind` 0x1048010b8, `resume_token`
   0x1047e63b8) are parts of unrelated analytics strings
   (`default_environment_kind`, `missing_resume_token`). With a custom raw value
   the literal would have to be present — it is not, so the strategy supplies
   the conversion.
3. Positive control: a DTO that *does* use camelCase literals is a
   proto-JSON message, not a REST DTO — `entityId` has a literal (0x104b78b14)
   and `pageOffset` too (0x104b7cd58), while the REST side has `page_offset`
   (0x1041d10a6). Two codecs, two casings; the Code REST DTOs are on the
   snake_case one.

CAUTION: `.convertFromSnakeCase` rewrites **dictionary keys only**, never
string-raw **enum values**. Enum values must be the literal raw values the app
declares (`requires_action`, `review_ready`, `provision_failed`, `same-dir`, …).

FACT: `EnvironmentResource.config` is a **flat** object whose `environmentType`
is `"anthropic" | "byoc" | "paired"`, but discrimination is on the **sibling
`kind`** field, not on `environmentType` — `kind` is `"anthropic" | "byoc" |
"bridge" | "unknown"`. `BridgeSpawnMode` wire values are `"single-session" |
"worktree" | "same-dir"` (not the Swift case spellings).
NOTE: the earlier claim that BYOC's `cwd`/`taskSetupScript` thunk (0x101f32310)
proved explicit camelCase keys was wrong — those literals are the *case names*
of a synthesised `CodingKeys` enum (a raw value defaults to the case name), not
custom raw values. Their presence is expected under either strategy.

Enum raw values recovered for the session responses: `SessionListStatusFilter` =
`active | paused | archived | provision_failed`; `SessionStatusBucket` =
`blocked | review_ready | waiting | completed | failed | unknown`;
`EnvironmentKind` = `anthropic_cloud | byoc | bridge | unknown`.

## Gating: `CodeBlockedReason`

`CodeBlockedReason` (@0x4b02c94) = `orgAdmin | orgTier | entitlement | platform |
unknown`, mapped to four localized strings in `ClaudePackage_ClaudeCodeFeature`:
`code_turned_off_by_organization_administrator` (0x10482f650),
`code_not_included_in_current_seat` (0x10482f680),
`code_not_available_for_account` (0x10482f6b0),
`code_unavailable` (0x10482f6d0).
These correspond 1:1 to `FeatureAccessStatus` values
`blockedByOrgAdmin → orgAdmin`, `blockedByOrgTier → orgTier`,
`blockedByEntitlement → entitlement`, `blockedByPlatform → platform`.
So the *same* `current_user_access` list that shows the tab can also block it —
the server should report `claude_code_web` as `available` there.

## Handling plan for `mobile/server.mjs`

1. **`GET /api/organizations/<uuid>/experiences`** → `200`
   `{"experiences": [], "rules": {"global": {}, "placements": {}}}`.
   (Also covers the `bannerMs` leg.)
2. **`GET /v1/environment_providers/private/organizations/<uuid>/environments`** →
   `200` `{"environments": [], "has_more": false, "first_id": null, "last_id": null}`
   (or a single `bridge` device if the Desktop bridge is paired). Covers the
   `devicesMs` leg.
3. **`GET /v1/code/sessions`** → `200` `{"data": [], "next_cursor": null,
   "resume_token": null}`. Covers the `sessionsMs` leg. Real rows come later from
   Desktop IPC.
4. `GET /v1/code/sessions/<id>` and `/v1/code/sessions/watch` (SSE) only when a
   session is actually opened; watch should emit `upserted`/`deleted` frames.

With these four returning 200, the tab's load legs all settle and it renders the
(empty) session list instead of erroring.

## Tooling left in the repo

`/workspace/ipa-work/` holds the RE scripts: `swifttypes.py` (Swift type +
field + field-type dumper, writes `/tmp/types_full.tsv`), `codingkeys.py`,
`rawkeys.py`, `swiftmeta.py`, plus `/tmp/{macho,swift,fmd,refs,funcs,armdis}.py`
from an earlier session. Do not create a file named `dis.py` (it shadows the
stdlib module and breaks capstone).
