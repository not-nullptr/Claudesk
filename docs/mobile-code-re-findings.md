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

**`revision` is a `Foundation.Date?`** — its mangled field type resolves through
the chained-fixup import table to `_$s10Foundation4DateVMn`, the same type as
`createdAt`/`updatedAt` (see `docs/mobile-code-wire-correction.md`). It is the
session's last-change *time*, not a counter: an integer here fails the decode of
the whole `SessionResource`, i.e. the `POST /v1/code/sessions` 201 body, the
detail read, and every watch `upserted` frame. This was the "can't send in Claude
Code" failure (2026-10-04) — the session list rendered (its row has no
`revision`), but the create reply died as `ModelDecodingError` before any
message-send leg was even reached.

Watch stream (`GET /v1/code/sessions/watch`, SSE): `SessionWatchEvent` (@0x4aea6d8)
= `upserted | deleted`; the request carries `include_trigger_sessions`. The
associated values are `upserted(SessionResource)` and
`deleted(AnthropicTagged<SessionTag>)` — so the SSE `data` for `upserted` is a
whole `SessionResource` (more than a transcript entry carries; the engine builds
it from its session mirror) and for `deleted` the session's tagged id string. An
earlier revision of this leg wrongly put a `SessionEventEnvelope` on `upserted`
and a `{session_id, event_id}` object on `deleted`.

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

### The request is organization-scoped three ways; the response shape is confirmed
(2026-10-03, latest)

The CodingKeys tables were recovered this session, which settles the *response*
side of Endpoint 2 beyond doubt. `EnvironmentResource`'s CodingKeys
(fileoff 0x4aead70) are exactly `kind | environmentId | name | createdAt | state
| config | bridgeInfo`, and each configuration's are
`environmentType` alone (`unknown`), `environmentType, machineName, directory,
branch, gitRepoUrl` (`paired`), `environmentType, cwd, taskSetupScript` (`byoc`),
and `environmentType, cwd, initScript, environment, languages, networkConfig`
(`anthropic`). `EnvironmentListResponse`'s are `environments | hasMore | firstId
| lastId`. Those match the facade's emission one-for-one, so a decode failure is
no longer a live hypothesis.

The request side is where the remaining suspicion now sits. The URL builder at
`0x101f2f048` assembles `/v1/environment_providers/private/organizations/` (VA
`0x1047e91d0`) with:

* the **organization id in the path**, and
* a query item **`included_worker_types`** (`0x101f2f208`), whose value is built
  from a list on the request (a `.joined(separator:)` loop at `0x101f2f218`),
* and the transport layer adds an **`X-Organization-Uuid`** header (string at
  fileoff 0x47e9358, beside `Anthropic-Version` and the `ccr-byoc-2025-07-29` /
  `ccr-triggers-2026-01-30` betas).

So the app scopes the read to its organization id in three independent places
(path, header, and the worker-type filter). If the facade answers a path org that
differs from the header org, the HTTP leg still returns 200 and both records,
while the app can drop rows after decode — which is exactly what an empty picker
with clean logs looks like. The facade issues a single `identity.orgUuid` from
`/api/organizations`, so the two should agree, but that is now printed on every
read (`mobile/server.mjs`, `path_org=` / `header_org=` / `worker_types=`) so one
picker open on device reveals whether the app is asking with something else.

`included_worker_types` is the other lead: it filters the list by worker type
before the app ever splits rows by `kind`. A bridge/cloud record whose worker
type is not in the app's requested set would be filtered out at the source, not
in the picker. The facade currently ignores that query parameter, so it cannot
narrow anything today — but if the app sends a non-empty filter and then drops
rows itself, returning the full set is not enough.

### Correction: matching CodingKeys rules out *unknown keys*, not *null values*
(2026-10-04)

The section above concludes "a decode failure is no longer a live hypothesis"
because `EnvironmentResource`'s CodingKeys match the emitted keys one-for-one.
That reasoning has a hole, and the hole is the bug. **CodingKeys only name the
keys; they say nothing about whether a property is optional.** A synthesized
`init(from:)` calls `decode(_:forKey:)` for a non-optional property and
`decodeIfPresent(_:forKey:)` for an optional one. A key that is *present but
`null`* therefore still throws `valueNotFound` for a non-optional property —
same all-or-nothing failure the CodingKeys check was meant to exclude:

* `[EnvironmentResource]` decodes as one unit, so **one** bad value drops
  **every** row — both the `anthropic_cloud` and the `bridge` record.
* `EnvironmentPicker.swift:82` picks its empty state from a model Bool / string
  `==` display state (see above), not from a row count. A load that throws
  leaves that state in its un-populated arm — the `environments_empty_state`
  onboarding screen — which is exactly the reported symptom, with clean logs.

The facade had been emitting `created_at: null`, `network_config: null` (cloud)
and `bridge_info: null` (cloud) — three values whose *optionality was never
established* from the binary, unlike the fields whose fieldmd mangling ends in
`Sg` (`init_script`, `branch`, `git_repo_url`, `cli_version`) — which were
*believed* Optional and safe as `null`, but are not: the app's decoder reports
`valueNotFound` for at least one of them ("Cannot get value of type String --
found null value instead", read off the live error). None of them may be `null`;
each now carries `""`. The fix (`mobile/code-transcript.mjs`) is: **never
emit `null` for a field whose optionality is unconfirmed.** A well-formed value
decodes whether the property is `T` or `T?`; `null` decodes only for `T?`. So:

* `created_at` now carries an ISO-8601 string. It shares its exact field
  encoding with `SessionResource.createdAt` (fieldmd type target `0x45ccb80`),
  a field the app already decodes from this facade's ISO strings — but the
  environment records sent `null` where the session records sent a string.
* `network_config` now carries `{allowed_hosts: [], allow_default_hosts: true}`
  rather than `null`.
* the cloud record's `bridge_info` now carries the same machine descriptor the
  bridge record uses. The app classifies rows by `kind` and only *reads*
  `bridgeInfo` for a bridge row, so a value on a cloud row is ignored — but it
  is still *decoded*, and a well-formed object is decode-safe either way.

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
"config": { "paired":    { "environment_type": "bridge", "machine_name": …, … } }
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
`environmentType` inside a payload is **not** the case's own literal: it is typed
`ConfigType` (@0x4aeae00), whose cases are `anthropic | byoc | bridge | unknown`
— there is NO `paired` member. So the `paired` payload carries
`environment_type = "bridge"`, the same axis value its sibling `kind` reports;
the literal `"paired"` is not a case of that enum and fails the whole
`EnvironmentConfiguration`, dropping every row of the picker. (The `anthropic`
payload's `"anthropic"` happens to be both the case name and a valid
`ConfigType`, which is why the flat-reading bug hid there.)
NOTE: the earlier claim that BYOC's `cwd`/`taskSetupScript` thunk (0x101f32310)
proved explicit camelCase keys was wrong — those literals are the *case names*
of a synthesised `CodingKeys` enum (a raw value defaults to the case name), not
custom raw values. Their presence is expected under either strategy.

### Correction — the `config` payload nests under `_0` (2026-10-05)

The section above is right that `config` is a keyed container with a single key,
the case name — but wrong about that key's value. The case's associated value is
**unlabelled**, and SE-0295's synthesised Codable nests unlabelled associated
values under `_0` (Apple's example: `case upc(Int, Int, Int, Int)` encodes as
`{"upc":{"_0":8,"_1":…}}`). So the wire shape is

```
"config": { "anthropic": { "_0": { "environment_type": "anthropic", … } } }
```

Omitting `_0` throws `keyNotFound(_0)`, which drops the whole
`EnvironmentConfiguration` → `EnvironmentResource` → the list, and reaches the
phone as `ModelDecodingError(kind: unexpected_schema)` — naming neither the field
nor the level. That is the decode failure seen on device, and it is also why the
picker's cloud section stayed empty. The edit path already accepted `_0`
(`mobile/server.mjs`, `editObject`); the response builders did not. Fixed in
`mobile/code-transcript.mjs` (`environmentCase`).

### SUPERSEDED — `config` is FLAT, not `_0`-nested (2026-10-05)

The `_0` correction above is **wrong**, and so was everything before it that
nested the payload under the case name. `EnvironmentConfiguration`'s Codable is
**custom**, not SE-0295-synthesised, and it is keyed off a **flat
`environment_type`**. The proof is the type's own declared `CodingKeys`, dumped
straight from the binary with `ipsw macho info --swift`:

```
enum ClaudeCodeApi.EnvironmentConfiguration.CodingKeys {
  case environmentType          // <-- exactly ONE case
}
```

A synthesised enum would key on its case names (`anthropic | byoc | paired`). A
single `environmentType` case means the decoder reads `environment_type` as a
**discriminator** and decodes the payload struct from the **same dictionary** —
flat. So the wire shape is:

```json
"config": { "environment_type": "anthropic", "cwd": …, "init_script": …, … }
"config": { "environment_type": "bridge",    "machine_name": …, … }
```

`environment_type` is a `ConfigType` (`anthropic | byoc | bridge | unknown`,
**no** `paired`), so the `paired` case is selected by `"bridge"`. Both the list
and the by-id read failed identically under every nested mode tried
(`boxed`/`direct`) precisely because none of them emitted this flat shape.

The full environment schema, verbatim from the same dump (`ipsw macho info
--swift /workspace/ipa-work/extracted/Payload/Claude.app/Claude`):

```
struct EnvironmentResource {
  let kind: EnvironmentKind                 // anthropicCloud | byoc | bridge | unknown
  let environmentId: AnthropicTagged<CodeEnvironmentTag, String>   // wire: bare String
  let name: String
  let createdAt: Foundation.Date            // ISO-8601
  let state: EnvironmentState               // active | unknown
  let config: EnvironmentConfiguration?     // flat, see above
  let bridgeInfo: BridgeEnvironmentInfo?
}
struct EnvironmentListResponse {
  let environments: IdentifiedArray<EnvironmentResource>   // wire: JSON array
  let hasMore: Bool
  let firstId: AnthropicTagged<CodeEnvironmentTag, String>?
  let lastId:  AnthropicTagged<CodeEnvironmentTag, String>?
}
struct BridgeEnvironmentInfo {
  let maxSessions: Int?; let machineName: String?; let directory: String?
  let branch: String?; let gitRepoUrl: String?
  let online: Bool?; let spawnMode: BridgeSpawnMode?   // wire: single-session|worktree|same-dir
  let cliVersion: String?
}
struct AnthropicEnvironmentConfiguration {
  let environmentType: ConfigType
  let cwd: String?; let initScript: String?
  let environment: [String: String]         // dictionary, {} is fine
  let languages: [EnvironmentLanguage]      // [] is fine
  let networkConfig: CCRNetworkConfig?      // { allowedHosts: [String], allowDefaultHosts: Bool }
}
struct PairedEnvironmentConfiguration {
  let environmentType: ConfigType
  let machineName: String?; let directory: String?; let branch: String?; let gitRepoUrl: String?
}
```

`AnthropicTagged<Tag, B>` is `struct { var rawValue: B }` + `RawRepresentable` +
`ClaudeCodable.TrimmedRawRepresentable`, and has **no** synthesised `CodingKeys`
in the dump (unlike the real DTOs) — so it decodes as a single value (bare
string), the way `SessionResource.Origin` (also `TrimmedRawRepresentable`)
already does. `EnvironmentKind`/`EnvironmentState`/`ConfigType` conform to
`LossyRawRepresentable` (unknown values fall back to `.unknown`, no throw).
**`BridgeSpawnMode` does NOT** — it is the one enum on the record that rejects
an unknown value, so its raw value is the one that can fail the decode. Those
raw values are the HYPHENATED spellings `single-session | worktree | same-dir`:
they sit in `__cstring`, referenced by the enum's raw-value table, while the
`__swift5_reflstr` copies (`singleSession/worktree/sameDir`) are only the case
names. `worktree` — where the two spellings coincide — is the only one that
appears twice, which is what gives the custom spellings away. Fixed in
`mobile/code-transcript.mjs` (`environmentConfig`) and `mobile/code-ids.mjs`
(`BRIDGE_SPAWN_MODE`).

These were **two independent wrong fields** (the nested `config` and the
`spawn_mode` value), which is why the earlier single-field bisect
(`nobridge`/`nocfg`/…) never decoded: removing one still left the other wrong.

> Tooling note: `docs/mobile-code-decodable-types.txt` only lists conformance
> names. The **fields and their types** come from `ipsw` (`blacktop/ipsw` release
> binary, run locally), which pre-caches Swift metadata and prints a full type
> dump — far faster than hand-parsing `__swift5_fieldmd` (the record layout is
> not the naive `[name][type][flags]` my first attempts assumed).

Enum raw values recovered for the session responses: `SessionListStatusFilter` =
`active | paused | archived | provision_failed`; `SessionStatusBucket` =
`blocked | review_ready | waiting | completed | failed | unknown`;
`EnvironmentKind` = `anthropicCloud | byoc | bridge | unknown` (the earlier
`anthropic_cloud` snake reading was wrong).

## The model selector, and how to tell a synthesized `Codable` from a custom one

The empty model picker (2026-10-04) made the `ModelSelector` family worth nailing
down. `__swift5_types` field descriptors give the shape; the **type kind** and the
**string pool** give the encoding.

Kinds (descriptor `flags & 0x1f`: 17 = struct, 18 = enum):

```
Surface, ThinkingEffort, ThinkingMode      Struct  { rawValue: String }   (one stored field)
SurfaceState, SurfaceConfig, ModelEntry,
ModelSelector, ModelThinkingDefault        Struct
ThinkingState                              Enum    effortAndMode(effort:mode:) | effort | mode
Section                                    Enum    main | overflow | deprecated
```

The trick for the encoding: a **synthesized** `CodingKeys` puts each property (or
case) name into `__cstring` verbatim — that is the fact the "Wire casing" section
above already uses. A **custom** `init(from:)`/`encode(to:)` does not. So:

* `thinkingByModel` @0x10479e620, `shortName`, `selectionNotice`, `quickSelect`,
  `requiredPermissionMode`, `voiceModel`, `minClaudeCodeVersion`, `effortOptions`,
  `modeOptions`, `models` — all present as bare `__cstring` literals, pooled with
  `main`/`overflow`/`deprecated` @0x10479e600. ⇒ the **structs** use synthesized
  Codable, so their wire keys are the camelCase names the app's
  `.convertFromSnakeCase` turns into `thinking_by_model`, `short_name`, ….
* `rawValue` (the one field of `Surface`/`ThinkingEffort`/`ThinkingMode`) exists
  **only** in `__swift5_reflstr` (reflection), never as a `__cstring` — so those
  wrappers have a **custom** Codable and go on the wire as the **bare string** —
  the shape the facade emits for `id`, `model`, `effort` and `mode`.
* `effortAndMode` likewise exists only in `__swift5_reflstr` — so `ThinkingState`
  is custom too, and the facade's flat `thinking: {effort, mode}` is the shape
  those cases were written to read. (`effort`/`mode` do not appear as standalone
  keys near the pool; the reflstr names are the tuple labels.)

Open: `Section`'s three names sit in the *same pool as the coding keys*, which fits
either a synthesized payload-less enum (wire `{"main":{}}`) or a `String`-raw enum
(wire `"main"`). The facade sends `"main"` and `section` is non-optional, so if the
picker is still empty after the per-surface fix, this is the next thing to test —
along with the app's own PUT body, which the facade now logs.

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

## Channels: the conversation addressed as a claude.ai channel

The binary's `ClaudeCodeApi/ChannelMessagesApi.swift` addresses a Code
conversation as a *channel*. The channel id is the session id; the message
stream is `/v1/code/channels/{id}/messages/stream` with `scope=timeline|thread`.
Types and their non-optional fields (`dec.mjs` over the descriptors at
`0x104ae4xxx`, raw enum values from `__cstring`):

```
Channel                  storage, name
ChannelMessage           id, inTimeline, serverNotice, attachments,
                         participantAccountIds, boundSessions, reactions,
                         attachedOutputs, links  (NINE; all else optional)
ChannelMessageTag        (AnthropicTagged<ChannelMessageTag,String> — bare string on the wire)
ChannelTimelineResponse  data: [ChannelMessage], nextCursor: String?
ChannelThreadsResponse   sections: [ChannelThreadSection]
ChannelThreadSection     status: ThreadStatus, data: [ChannelMessage], nextCursor: String?
ChannelPullRequestsPage  data, nextCursor?, total: Int, truncated: Bool, source: ChannelPullRequestsSource
ChannelArtifactsPage     data, nextCursor?, total: Int, truncated: Bool
ChannelFilesPage         entries, nextCursor: String?
ChannelStreamStart       after: ChannelMessageId | tail
ChannelStreamEvent       message | messageUpdated | reactionsReplaced | sessionActivity |
                         threadSessionBound | threadResolved | threadDeleted |
                         sessionModel | sessionRequiresAction
ChannelPullRequestsSource live | no_github_token | github_unavailable | unspecified | unknown
```

Record the `ChannelMessage` field set with `node scripts/inspect-swift-types.mjs
ChannelMessage` before changing it: the first reading of the descriptor listed
only the five fields that carry data and marked the rest optional, which is
wrong. `boundSessions`, `reactions`, `attachedOutputs` and `links` are
non-Optional collections that look incidental and are not — a `channel_message_updated`
frame without them throws `ClaudeApiServices.ModelDecodingError` in the
synthesized `Codable` before any of the visible content is read. Empty arrays
are a valid value for all four. `scripts/lib/code-wire-contract.mjs` now pins
the nine keys so a hand-written mock cannot hide the omission again.

The channel the client streams by name uses the SSE event names in the string
pool at `0x1047e67a8`: `channel_message_updated`, `channel_message_reactions`,
`session_activity`, `thread_session_bound`, `session_requires_action` (plus
`thread_roots_only`). A `channel_message_created` event name does not exist —
new messages arrive as `channel_message_updated`. The reader logs and skips any
event name it does not know ("ignoring unknown channel stream event type:
%{public}s"), so a minimal stream that carries only `channel_message_updated` is
tolerated.

## Tooling left in the repo

`scripts/inspect-swift-types.mjs` reads the Swift type metadata offline. It
walks `__swift5_types` into a name → descriptor index and dumps a named type's
fields with their types, flagging the non-Optional ones:

```sh
node scripts/inspect-swift-types.mjs SendChannelMessageResponse CreateSessionRequest
node scripts/inspect-swift-types.mjs --grep ChannelMessage      # find types by name
node scripts/inspect-swift-types.mjs --path /elsewhere/Claude SessionResource
```

The non-Optional flag is the whole game on this surface: an absent or null
non-Optional field is exactly what throws `ClaudeApiServices.ModelDecodingError`,
while an absent Optional one decodes fine. So the check for any route is
mechanical — dump its DTO, make sure every required field is present, non-null,
and the right shape. Two things this reader does that `/workspace/ipa-work/`'s
cannot: it resolves field type pointers as Swift *symbolic references* (the
older `swifttypes.mjs` reads them as C strings and prints garbage for every
non-trivial field type — its `fields.tsv` is still fine for *names*), and it
addresses any type by name rather than by a hand-found descriptor address.

Route → type is the one link that is not automated. The route strings are
enumerable in the image (`search_strings` over Ghidra, or grep
`/workspace/ipa-work/strings6.txt`) and the type names are enumerable here, but
nothing joins them: Swift string literals are referenced through a literal
struct rather than by `adrp/add` to the character data, so `xref.mjs`/`findrefs.py`
do not land on the call site. In practice the DTO's name restates the route's
nouns (`SendChannelMessageResponse` for `…/channels/{id}/messages/stream`),
`--grep` lists the candidates, and the field dump confirms which one fits — with
the facade's `[mobile-code] posted=` self-report as the backstop when a shape is
still wrong.

`/workspace/ipa-work/` holds the rest of the RE scripts: `swifttypes.py`,
`codingkeys.py`, `rawkeys.py`, `swiftmeta.py`, `xref.mjs` (string VA → `adrp/add`
code refs), plus `/tmp/{macho,swift,fmd,refs,funcs,armdis}.py` from an earlier
session. Do not create a file named `dis.py` (it shadows the stdlib module and
breaks capstone).

## Code watch SSE: payload is keyed by the event name; `deleted` is an object
(2026-10-05)

`GET /v1/code/sessions/watch` is an SSE stream. Each record's SSE `event:` names
the case and its `data` is that case's payload — the app does **not** decode a
`SessionWatchFrame` (that type is an internal, non-`Decodable` model: its only
conformances are `Equatable` / `CasePathable`, and so are `SessionWatchEvent`'s).
The two wire payloads are:

* `event: upserted` → a whole `SessionResource` (bare object)
* `event: deleted`  → `SessionWatchWire.Removed` = `{"id":"<session id>"}`

`SessionWatchWire.Removed { let id: AnthropicTagged<SessionTag,String> }` is
`Decodable` with the single key `id`. Verified by compiling it with Swift 6:

* `{"id":"code_x"}` → decodes
* `"code_x"` (bare string) → `typeMismatch(Dictionary<String,Any>, found string)`
* `null` → `valueNotFound(Dictionary<String,Any>, "found null value instead")`

Neither failure is `dataCorrupted`, so the classifier returns `unexpected_schema`
— i.e. `ModelDecodingError(path: /v1/code/sessions, kind: unexpected_schema)`,
the failure seen on send. The facade had been sending the bare id **string**
(and `null` when the list watch had no session id). Fixed in `mobile/server.mjs`:
`deleted` now sends `{"id": …}` and a frame with no id is dropped; `upserted`
stays the bare resource, keyed off the SSE `event:` name.

(Superseded: an earlier note here claimed the `data` is a `SessionWatchFrame`
with the payload under `_0` — that was inferred from the type name before
checking its conformances, and is wrong.)
