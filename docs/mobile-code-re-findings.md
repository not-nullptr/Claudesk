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

## Transcript wire correction (2026-10-03)

The earlier transcript claims in this document were incorrect. Direct tracing
of the supplied IPA's Decodable witnesses establishes that both HTTP history
`data[]` and SSE `event: client_event` carry `SessionEventEnvelope` objects.
`ClientEventsPage.Row` and `SessionSseFrame` are internal models. SDK messages
are flat objects discriminated by `type`, and sequence numbers are positive
**strings**, starting at `"1"`.

See [the correction, binary addresses, and reproduction script](mobile-code-wire-correction.md).
This supersedes the previous synthesized-enum-wrapper and paged-row claims.

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

### The list is split by `kind`, and the split is what blocks a new session
(settled on device, 2026-10-03)

With the facade advertising one `kind = bridge` record, the new-session picker
read "Choose environment" and its cloud section showed the onboarding empty
state — **"Create a cloud environment to get started"**, the localization key
`environments_empty_state` (`ClaudePackage_ClaudeCode.bundle`), with the button
`create_default_cloud_environment` ("Create your default cloud environment").
That state is reached when there is no environment to offer, and it blocks
starting a session outright (the device capture shows every leg `200`).

The picker sections come from `EnvironmentStore` (struct @0x4b0325c), whose
fields separate the list by kind:

```
_cloudEnvironments          [EnvironmentResource]   the "Cloud environments" rows
_soleCloudEnvironment       EnvironmentResource?    the auto-selected one
_resolvedBridgeEnvironments [EnvironmentResource]   the paired devices
_connectedDevices           …                       the "Remote control" rows
_savedEnvironment           …                       the remembered pick
offersHostedEnvironments    Bool (getter)           whether the cloud section is offered
```

The section titles are the keys `cloud_environments` ("Cloud environments") and
`paired_environments` ("Remote control"); a `bridge` record lands in the latter,
so a bridge-only list never fills the cloud section and the empty state stays.
`CloudEnvironmentRow` (@0x4b0720c) = `environment, isIncompatible, isSelected,
onTap, onEdit` — a row's `environment` is the `EnvironmentResource` above, so a
cloud row is simply an `EnvironmentResource` with `kind = anthropic_cloud` and
the `anthropic` configuration case (`environment_type = "anthropic"`).

So the facade must advertise **both**: an `anthropic_cloud` record for the cloud
section the picker needs, and the `bridge` record for the paired device. Both
run on the same self-hosted Desktop — the facade ignores the runner kind when it
starts a turn — so a session created against either reports the environment id it
was created with (`meta.environment_id`), and the by-id read resolves it.
`POST …/environments` (`EnvironmentCreateRequest` = `name, kind, description,
config`) is what the "Create environment" button sends; answering it with the
cloud record (rather than `404`) keeps the create sheet from sticking.

### The wire shape is now VERIFIED against the binary; the block is elsewhere
(2026-10-03, later)

The facade's environment payload was checked byte-for-byte against the app's own
field-name tables, and it is **correct** — so the nested-config change (commit
`22b7366`) is right and stays, and the empty picker is *not* a payload-shape
problem. Evidence, all from `claude.bin`:

* `EnvironmentKind`'s cases are `anthropicCloud | byoc | bridge | unknown`
  (NUL-separated string block, fileoff 0x4b5c93x) — so the wire value
  `anthropic_cloud` is correct.
* The `EnvironmentConfiguration` payload case names are `anthropic | byoc |
  paired`, and the DTO cluster reads contiguously as
  `…environmentType | initScript | environment | languages | networkConfig |
  taskSetupScript | anthropic | byoc | paired | config | bridgeInfo |
  environments | firstId | poolId` (fileoff 0x4ba46c0–0x4ba47fe). That is exactly
  what `bridgeEnvironment`/`cloudEnvironment` emit: `config` nests the payload
  under the case name.
* `EnvironmentStore`'s field list (fileoff 0x4bb4b0x) is
  `isSelfHostedRunnersEnabled | offersHostedEnvironments |
  isSendEnvironmentSetupEnabled | … | _cloudEnvironments | _soleCloudEnvironment`.

**Correction to the section above.** The picker's empty state is *not* selected
by a count of cloud rows. `EnvironmentPicker.swift:82` computes a **Bool** and
stores it as the `_ConditionalContent` selector; SwiftUI runs the populated-list
arm when it is true and the `environments_empty_state` arm when it is false
(`0x1027fabf0` stores the Bool at `[x19,#57]`, the closure pair at `[x19,#64]`).
The three `cbz`-on-array checks for `cloud_environments` /
`paired_environments` / `self_hosted_environments` are **inside** the populated
arm and only hide individual sections — they do not choose the empty state.

The picker model's own fields (fileoff 0x4bb1400 block) include
`… | listed | remembered | devices | hidden | loading | empty | …`, so the
selector is one of the model's display-state Bools. The predicate
(`0x1025d9514` / `0x1025d9adc`) is a **string `==`** test, not an `isEmpty` —
it compares a model field against a stored value. That points at the app waiting
for a display state it never reaches (the load never "applies" its rows), rather
than at the row contents.

Also ruled out: `hostedEnvironmentsOff` / "Hosted environments turned off by the
organization" is a case of the **continue-on-cloud (CCR) error** enum
(`network | notFound | forbidden | hostedEnvironmentsOff | repoAccessDenied |
… | sessionNotActive | gitHubNotConnected`, dispatched by the byte switch at
`0x1025bdc70`), a different feature — not the picker's gate.

Still open: which model Bool the picker selects on, and what leaves it in the
un-populated state. Resolving it needs the observation key-path descriptor at
`0x104338888` (relative-pointer metadata), which was not decoded here.

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

CORRECTED (2026-10-03): `EnvironmentResource.config` is **not** flat. It is the
`EnvironmentConfiguration` enum — a Swift enum with **associated values**
(`__swift5_fieldmd` flags `kind = 3`; cases `anthropic | byoc | paired |
unknown`) — so its synthesised Codable is a keyed container holding exactly ONE
key, the case name, whose value is the case's payload:

```
"config": { "anthropic": { "environment_type": "anthropic", "cwd": …, … } }
"config": { "paired":    { "environment_type": "paired", "machine_name": …, … } }
```

The flat reading below was an inference from seeing the *inner* struct's keys
(`environment_type`, `init_script`, …) and assuming they sit at `config`'s top
level — the same mistake this section already warns about. A flat `config` does
not decode, which fails the whole `EnvironmentResource`, which drops **every**
row of the picker: the app is handed both records (confirmed in the server log)
and still shows the `environments_empty_state` onboarding state. Discrimination
between the cases is therefore by the **single nested key**, not by a sibling
`environmentType`; the sibling `kind` field (`"anthropic_cloud" | "byoc" |
"bridge" | "unknown"`) remains the section split. `BridgeSpawnMode` wire values
are `"single-session" | "worktree" | "same-dir"` (not the Swift spellings).
`environmentType` inside a payload is still the case's own literal
(`"anthropic"` / `"paired"`).
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
