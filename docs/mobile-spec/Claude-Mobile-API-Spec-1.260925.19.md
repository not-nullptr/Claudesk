# Claude iOS self-hosted backend contract

Target client: Claude iOS 1.260925.19 (build 36212809913)

This is the practical contract recovered from the supplied decrypted IPA and the working sideloaded-device login test. It is intended for a self-hosted compatibility backend. It does not describe or authorize access to Anthropic infrastructure.

## 0. Client patch required for a resigned build

The app's `Info.plist` contains:

```text
KeychainAccessGroup = Q6L2SF6YDW.com.anthropic.claude.shared
```

A resigned/sideloaded copy cannot normally write to Anthropic's original Keychain access group. The working client patch is simply to remove the `KeychainAccessGroup` key from `Info.plist`, allowing the app to use the default Keychain access group associated with your own signing identity.

No networking patch is required for the core API because the sideloaded original exposes the built-in endpoint picker with Production / Staging / Localhost / Custom.

Use the root origin in Custom, for example:

```text
https://mobile.example.com
```

Do not append `/api`; the app builds `/api/...` paths itself.

---

## 1. General HTTP conventions

### Base URL

```text
ORIGIN = https://mobile.example.com
```

REST endpoints are generally under:

```text
ORIGIN/api/...
```

Connect RPC endpoints are root-level and are **not** under `/api`:

```text
ORIGIN/anthropic.bard.api.v1alpha.ConversationService/...
ORIGIN/anthropic.claudeai_chats.api.v1alpha.RecentsService/...
```

The client may also use a `/claudeai-rpc` prefix in front of those RPC paths. Supporting both is cheap.

### JSON codec

The main HTTP connection uses Swift `JSONEncoder.KeyEncodingStrategy.convertToSnakeCase` and `JSONDecoder.KeyDecodingStrategy.convertFromSnakeCase`.

So Swift properties such as:

```text
emailAddress
currentLeafMessageUuid
modelSelectorState
```

appear on the wire as:

```text
email_address
current_leaf_message_uuid
model_selector_state
```

A few types have custom coding keys. Important ones are called out below.

### Dates

ISO-8601 UTC works:

```text
2026-01-01T00:00:00.000Z
```

### Authentication cookie

Cookie name is exactly:

```text
sessionKey
```

Known-good form:

```http
Set-Cookie: sessionKey=<opaque-private-token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure
```

Use `Secure` on HTTPS. A host-only cookie works; you do not need an Anthropic domain cookie.

Every authenticated REST and Connect request should accept this cookie. Supporting `Authorization: Bearer <token>` is optional and was only a convenience in the mock.

---

# 2. Device-confirmed login/bootstrap sequence

On the working device the sequence is:

```text
GET  /api/legal
POST /api/auth/send_magic_link
POST /api/auth/verify_magic_link
GET  /api/account
GET  /api/account
GET  /api/bootstrap/{organization_uuid}/app_start
```

Before the Keychain plist fix the client then called `/api/auth/logout`; after removing the hard-coded Keychain access group, the login persists successfully.

## 2.1 GET /api/legal

Minimal response:

```json
{}
```

Treat this as public / pre-auth.

---

## 2.2 Optional device bootstrap

The binary also contains:

```text
GET /api/bootstrap
GET /api/bootstrap/device
```

A minimal response used successfully by the mock is:

```json
{
  "growthbook": {
    "features": {},
    "experiments": []
  }
}
```

This is useful for keeping server-driven features off.

---

## 2.3 POST /api/auth/send_magic_link

The encoded request type has these fields:

```json
{
  "email_address": "user@example.com",
  "utc_offset": 0,
  "login_intent": null,
  "recaptcha_token": "...",
  "recaptcha_site_key": "...",
  "client": "...",
  "source": "..."
}
```

For a private backend, you can ignore the recaptcha/client/source values and authenticate only against your own identity system.

Known-good response for showing the numeric code UI:

```json
{
  "sent": true,
  "magic_link_intent_available": false,
  "fallback_code_configuration": {
    "charset": "numeric",
    "length": 6,
    "show_input_after_delay": 0
  }
}
```

The reflected response type additionally supports optional:

```text
sso_url
sso_browser_requirement
```

You can omit those.

---

## 2.4 POST /api/auth/send_code

Alternative login route present in the client.

Request type:

```json
{
  "email_address": "user@example.com",
  "recaptcha_token": "...",
  "recaptcha_site_key": "...",
  "source": "..."
}
```

Minimal response:

```json
{
  "sent": true,
  "length": 6
}
```

---

## 2.5 POST /api/auth/verify_magic_link

Request type:

```json
{
  "recaptcha_site_key": "...",
  "recaptcha_token": "...",
  "source": "...",
  "client_attestation": null,
  "credentials": {
    "method": "code",
    "email_address": "user@example.com",
    "code": "123456"
  }
}
```

The credential enum also has a nonce form:

```json
{
  "method": "...",
  "encoded_email_address": "...",
  "nonce": "..."
}
```

For the self-hosted numeric-code flow you only need the code variant.

Successful response body:

```json
{
  "created": false
}
```

and **the same response must set `sessionKey`**:

```http
Set-Cookie: sessionKey=<opaque-token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure
```

The client has a specific internal login error called:

```text
verify_response_no_session_cookie
```

so do not return a successful verify response without a usable session cookie.

---

## 2.6 POST /api/auth/logout

Authenticated.

Response:

```json
{}
```

Clear the cookie:

```http
Set-Cookie: sessionKey=; Path=/; Max-Age=0; HttpOnly
```

---

# 3. Account and organization model

## 3.1 GET /api/account

`/api/account_profile` can be implemented as an alias.

Known-good minimal response:

```json
{
  "uuid": "ACCOUNT-UUID",
  "email_address": "user@example.com",
  "full_name": "Local user",
  "display_name": "Local user",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "is_verified": true,
  "is_anonymous": false,
  "settings": {
    "has_finished_claudeai_onboarding": true,
    "preview_feature_uses_artifacts": false,
    "enabled_web_search": false,
    "enabled_mcp_tools": {},
    "enabled_connector_suggestions": false,
    "enabled_monkeys_in_a_barrel": false,
    "enabled_model_auto_fallback": false,
    "grove_enabled": false,
    "village_weaver_eligible": false,
    "dismissed_claudeai_banners": []
  },
  "memberships": [
    {
      "role": "owner",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z",
      "organization": {
        "uuid": "ORGANIZATION-UUID",
        "name": "Self-hosted",
        "capabilities": ["chat"],
        "analytics_subscription_plan": "free",
        "plan_display_name": "Self-hosted",
        "settings": {}
      }
    }
  ]
}
```

The reflected Account model additionally has optional/extra fields:

```text
tagged_id
avatar
is_signed_out
```

Membership additionally supports:

```text
notification_preferences
```

Organization additionally supports billing/rate-limit/access/subscription metadata, but none is required for the basic chat UI.

### AccountSettings custom wire names

These are worth preserving if you expose the broader settings object:

```text
Swift property                         wire key
hasFinishedClaudeaiOnboarding          has_finished_claudeai_onboarding
areArtifactsEnabled                    preview_feature_uses_artifacts
isWebSearchEnabled                     enabled_web_search
enabledMcpTools                        enabled_mcp_tools
areConnectorSuggestionsEnabled         enabled_connector_suggestions
isRemoteTerminalEnabled                enabled_monkeys_in_a_barrel
toolSearchMode                         tool_search_mode
userDataTrainingEnabled                grove_enabled
dispatchMobileOnboardingSeenAt         dittos_mobile_onboarding_seen_at
isModelAutoFallbackEnabled             enabled_model_auto_fallback
voicePreference                        voice_preference
voiceSpeed                             voice_speed
voiceLanguageCode                      voice_language_code
voiceSessionRecordingEligible          village_weaver_eligible
voiceSessionRecordingConsentState      village_weaver_consent_state
hasSharedVoiceSessionRecordings        has_village_weaver_recordings
dismissedClaudeaiBanners               dismissed_claudeai_banners
```

---

## 3.2 GET /api/organizations

Minimal response:

```json
[
  {
    "uuid": "ORGANIZATION-UUID",
    "name": "Self-hosted",
    "capabilities": ["chat"],
    "analytics_subscription_plan": "free",
    "plan_display_name": "Self-hosted",
    "settings": {}
  }
]
```

---

## 3.3 GET /api/bootstrap/{organization_uuid}/app_start

Static construction shows these query parameters:

```text
growthbook_format=sdk
include_system_prompts=false
```

So accept:

```text
GET /api/bootstrap/{org}/app_start?growthbook_format=sdk&include_system_prompts=false
```

Known-good minimal response:

```json
{
  "account": { "...": "same Account object as /api/account" },
  "org_growthbook": {
    "features": {},
    "experiments": []
  },
  "current_user_access": {
    "features": [],
    "account_features": [],
    "organization_permissions": []
  },
  "model_selector_state": [
    {
      "id": "chat",
      "model": "claude-sonnet-4-6"
    }
  ],
  "model_selector_config": [
    {
      "id": "chat",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "name": "Self-hosted",
          "short_name": "Local",
          "section": "main",
          "disabled": false,
          "capabilities": {}
        }
      ]
    }
  ]
}
```

`personalized_greeting` is optional and may be omitted.

The exact AccountBootstrap coding keys are:

```text
account
org_growthbook
current_user_access
personalized_greeting
model_selector_state
model_selector_config
```

Important: the Swift property corresponding to `org_growthbook` is named `growthBookPayload`; do not infer the wire key from the property name.

---

# 4. Other small account routes

These are useful to implement as simple defaults:

```text
GET  /api/account/settings
PUT/PATCH/POST /api/account/settings
GET  /api/account/standing
GET  /api/account/current_appeal
POST /api/account/accept_legal_docs
POST /api/account/grove_notice_viewed
POST /api/event_logging/v2/batch
GET  /api/accounts/me/consents/check
GET/POST /api/accounts/me/consents
POST /api/accounts/me/consents/revoke
GET  /api/auth/trusted_devices
GET  /api/auth/session_reattest/device_key/challenge
POST /api/auth/session_reattest/device_key
```

Safe basic responses:

```json
/api/account/standing
{"banned_at":null,"hide_steps_card":true}

/api/account/current_appeal
null

/api/accounts/me/consents/check
{"has_consent":false}

/api/accounts/me/consents
[]

/api/auth/trusted_devices
[]

/api/auth/session_reattest/device_key/challenge
{"challenge":"self-hosted-challenge"}
```

Mutation/no-op routes can return `{}`.

---

# 5. Legacy conversation REST API

Everything below is scoped to an organization:

```text
/api/organizations/{organization_uuid}/...
```

## 5.1 Conversation list

### GET chat_conversations_v2

```text
GET /api/organizations/{org}/chat_conversations_v2?limit=100&offset=0&starred=true|false
```

Response:

```json
{
  "data": [
    {
      "uuid": "CONVERSATION-UUID",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z",
      "name": "Example",
      "model": "claude-sonnet-4-6",
      "is_starred": false,
      "settings": {
        "enabled_mcp_tools": {}
      },
      "is_temporary": false,
      "current_leaf_message_uuid": "MESSAGE-UUID"
    }
  ],
  "has_more": false
}
```

Exact recovered Conversation coding keys:

```text
uuid
created_at
updated_at
name
model
is_starred
project_uuid
settings
is_temporary
current_leaf_message_uuid
routine_id
```

`project_uuid` and `routine_id` can be omitted for basic chat.

### Legacy GET chat_conversations

```text
GET /api/organizations/{org}/chat_conversations
```

Return the array directly instead of the v2 pagination object.

---

## 5.2 Create conversation

```text
POST /api/organizations/{org}/chat_conversations
```

Recovered request model:

```json
{
  "uuid": "CONVERSATION-UUID",
  "name": "New conversation",
  "summary": null,
  "model": "claude-sonnet-4-6",
  "project_uuid": null,
  "research_mode": null,
  "is_imagine_enabled": null,
  "include_conversation_preferences": null,
  "is_temporary": false,
  "chat_memory_mode": null
}
```

You can accept a subset. `uuid`, `name`, `model`, and `is_temporary` are enough for the compatibility implementation used here.

Return the Conversation object.

---

## 5.3 Read conversation/history

```text
GET /api/organizations/{org}/chat_conversations/{conversation_uuid}
```

The client decodes a `ConversationWithMessages`. The conversation fields are at the **top level**, not nested under `conversation`.

Known-good shape:

```json
{
  "uuid": "CONVERSATION-UUID",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "name": "Example",
  "model": "claude-sonnet-4-6",
  "is_starred": false,
  "settings": {"enabled_mcp_tools": {}},
  "is_temporary": false,
  "current_leaf_message_uuid": "ASSISTANT-MESSAGE-UUID",
  "chat_messages": [
    {
      "uuid": "HUMAN-MESSAGE-UUID",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z",
      "sender": "human",
      "index": 0,
      "content": [
        {
          "type": "text",
          "text": "Hello",
          "citations": [],
          "is_closed": true
        }
      ],
      "attachments": [],
      "files": []
    },
    {
      "uuid": "ASSISTANT-MESSAGE-UUID",
      "created_at": "2026-01-01T00:00:01.000Z",
      "updated_at": "2026-01-01T00:00:01.000Z",
      "sender": "assistant",
      "index": 1,
      "content": [
        {
          "type": "text",
          "text": "Hi",
          "citations": [],
          "is_closed": true
        }
      ],
      "attachments": [],
      "files": []
    }
  ],
  "is_wiggle_enabled": false
}
```

Exact recovered Message keys include:

```text
uuid
created_at
updated_at
content
sender
attachments
files
chat_feedback
index
input_mode
```

`ConversationWithMessages` additionally supports optional:

```text
has_container
server_date
revision
```

Returning an ETag representing your canonical revision is useful but not required for the minimal flow.

---

## 5.4 Update/delete conversation

```text
PATCH /api/organizations/{org}/chat_conversations/{id}
PUT   /api/organizations/{org}/chat_conversations/{id}
```

Useful accepted body fields:

```json
{
  "name": "New title",
  "is_starred": true,
  "is_archived": false,
  "model": "your-model-id"
}
```

Return the updated Conversation.

Delete:

```text
DELETE /api/organizations/{org}/chat_conversations/{id}
```

Response:

```json
{}
```

---

## 5.5 Small conversation actions

Useful compatibility routes:

```text
GET/POST /api/organizations/{org}/chat_conversations/{id}/serving
POST     /api/organizations/{org}/chat_conversations/{id}/title
POST     /api/organizations/{org}/chat_conversations/{id}/archive
POST     /api/organizations/{org}/chat_conversations/{id}/unarchive
POST     /api/organizations/{org}/chat_conversations/{id}/star
POST     /api/organizations/{org}/chat_conversations/{id}/unstar
POST     /api/organizations/{org}/chat_conversations/{id}/stop_response
```

`serving` can return:

```json
{"connector_domains_withheld":[]}
```

`title` request:

```json
{"name":"New title"}
```

and response:

```json
{"title":"New title"}
```

The other mutations can return `{}`.

---

# 6. Sending a message: REST + SSE

Routes:

```text
POST /api/organizations/{org}/chat_conversations/{id}/completion
POST /api/organizations/{org}/chat_conversations/{id}/append_message
POST /api/organizations/{org}/chat_conversations/{id}/retry_completion
```

## 6.1 Append/completion request

Recovered `WrappedAppendMessageRequest` fields:

```json
{
  "prompt": "Hello",
  "timezone": "Europe/London",
  "model": "claude-sonnet-4-6",
  "effort": null,
  "thinking_mode": null,
  "attachments": [],
  "files": [],
  "input_mode": null,
  "tools": [],
  "is_mobile_app_intent": null,
  "rendering_mode": "...",
  "parent_message_uuid": null,
  "create_conversation_params": null,
  "turn_message_uuids": {
    "human_message_uuid": "HUMAN-UUID",
    "assistant_message_uuid": "ASSISTANT-UUID"
  },
  "tool_states": null,
  "completion_request_id": "REQUEST-UUID",
  "publish_file": null
}
```

For basic chat your backend really needs:

```json
{
  "prompt": "Hello",
  "turn_message_uuids": {
    "human_message_uuid": "HUMAN-UUID",
    "assistant_message_uuid": "ASSISTANT-UUID"
  }
}
```

Honor the client-supplied message UUIDs. They are important for deduplication/retry and for `current_leaf_message_uuid`.

### Retry request

The retry request has the same general prompt/model/thinking fields but its turn UUID object only requires the assistant UUID.

---

## 6.2 SSE response

Response header:

```http
Content-Type: text/event-stream; charset=utf-8
X-Accel-Buffering: no
```

Send ordinary SSE records:

```text
event: message_start
data: {"type":"message_start","message":{"uuid":"ASSISTANT-UUID","parent_uuid":"HUMAN-UUID","model":"claude-sonnet-4-6"}}

```

Then:

```text
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","citations":[],"is_closed":false}}

```

Stream one or more text deltas:

```text
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from "}}

```

```text
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"your backend"}}

```

Finish with:

```text
event: content_block_stop
data: {"type":"content_block_stop","index":0,"stop_timestamp":"2026-01-01T00:00:01.000Z"}

```

```text
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}

```

```text
event: message_stop
data: {"type":"message_stop"}

```

Persist the human and assistant messages before/while completing the stream so reopening the conversation returns the same IDs/content.

Do not let Caddy/nginx buffer this response.

---

# 7. Attachments/files

## 7.1 Prepare upload

```text
POST /api/organizations/{org}/files/prepare-upload
```

Basic request:

```json
{
  "files": [
    {"name":"note.txt"}
  ]
}
```

Response used by the compatibility backend:

```json
{
  "uploads": [
    {
      "file_uuid": "FILE-UUID",
      "filesystem_id": "self-hosted",
      "path": "/FILE-UUID/note.txt"
    }
  ]
}
```

---

## 7.2 Upload

Observed/static upload-related routes include:

```text
POST /api/organizations/{org}/wiggle/upload-file
POST /api/organizations/{org}/convert_document
POST /api/organizations/{org}/files
POST /v1/filestore/fs/createFile
```

The compatibility server accepts multipart form data with a `path` field and one file.

Example multipart semantics:

```text
path = /FILE-UUID/note.txt
file = note.txt
```

Useful response:

```json
{
  "uuid": "FILE-UUID",
  "id": "FILE-UUID",
  "file_uuid": "FILE-UUID",
  "file_name": "note.txt",
  "file_size": 18,
  "file_type": "text/plain",
  "extracted_content": "attachment content",
  "created_at": "2026-01-01T00:00:00.000Z",
  "url": "https://mobile.example.com/files/FILE-UUID",
  "download_url": "https://mobile.example.com/files/FILE-UUID"
}
```

The completion request's attachment object can use:

```json
{
  "file_name": "note.txt",
  "file_size": 18,
  "file_type": "text/plain",
  "extracted_content": "attachment content"
}
```

The reflected `AttachmentCreateParams` is exactly those four properties.

For a first backend, text-file extraction is enough. Add PDF/image/doc conversion only when you need it.

---

# 8. Connect / protobuf APIs

Newer conversation/home surfaces also use Connect RPC. These paths are outside `/api`.

## 8.1 Supported media types

Support:

```text
application/json
application/proto
application/connect+json
application/connect+proto
```

For Connect framing, each message is:

```text
1 byte flags
4 byte big-endian payload length
N bytes payload
```

The app can send gzip-compressed framed requests with:

```http
Connect-Content-Encoding: gzip
```

For streaming responses send:

```http
Connect-Protocol-Version: 1
X-Accel-Buffering: no
```

An end-stream frame uses Connect flag `0x02`.

---

## 8.2 RecentsService

Service prefix:

```text
/anthropic.claudeai_chats.api.v1alpha.RecentsService/
```

### ListRecents

```text
POST .../ListRecents
```

A minimal request can be `{}`.

Minimal JSON response:

```json
{
  "data": [
    {
      "chat": {
        "uuid": "CONVERSATION-UUID",
        "name": "Example",
        "model": "claude-sonnet-4-6",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "isStarred": false,
        "isTemporary": false
      }
    }
  ],
  "surfaces": [],
  "pageOffset": 0
}
```

Recovered response fields are:

```text
1 data[]
2 cursor
3 surfaces[]
5 searchId
6 pageOffset
```

### ListRecentGroups

```text
POST .../ListRecentGroups
```

Minimal response:

```json
{
  "groups": [
    {"id":1,"title":"Pinned","data":[]},
    {"id":2,"title":"Recents","data":[]}
  ],
  "surfaces": []
}
```

### StreamRecents

```text
POST .../StreamRecents
```

Streaming update shape used by the compatibility layer:

```json
{
  "update": {
    "replaceHead": true,
    "items": [],
    "syncToken": "opaque-sync-token"
  }
}
```

---

## 8.3 ConversationService

Service prefix:

```text
/anthropic.bard.api.v1alpha.ConversationService/
```

### GetNewConversationDefaults

Request:

```json
{}
```

Response:

```json
{
  "regular": {
    "settings": {},
    "unavailableActions": [],
    "maxUploadBytes": "20971520",
    "computerToolsEligible": false,
    "nativeAutoModeAvailable": false
  },
  "temporary": {
    "settings": {},
    "unavailableActions": [],
    "maxUploadBytes": "20971520",
    "computerToolsEligible": false,
    "nativeAutoModeAvailable": false
  }
}
```

Recovered `BardNewConversationDefaults` fields:

```text
1 workMode
2 unavailableActions[]
3 computerToolsEligible
4 nativeAutoModeAvailable
5 settings
6 maxUploadBytes
7 orgUploadMaxBytes
8 inlineAttachmentMaxAcceptedBytes
9 inlineAttachmentsTotalMaxAcceptedBytes
```

---

### ReadConversation

Request:

```json
{
  "conversationId": "CONVERSATION-UUID"
}
```

Recovered optional request fields:

```text
conversationId       field 1
maxResponseBytes     field 3
knownRevisionNs      field 4
displayLanguage      field 5
```

Response:

```json
{
  "outcome": 1,
  "update": { "...BardConversationUpdate...": true }
}
```

---

### ReadConversationHistory

Request fields:

```text
1 conversationId
2 cursor
3 limit
4 corbelEarlierChat
5 artifactVersionUuid
6 clientCapabilities
```

Response fields:

```text
1 update
2 olderCursor
3 outcome
4 corbelEarlierChat
```

For a simple backend you can return the complete state in `update` and omit pagination until needed.

---

### BardConversationUpdate

Core shape:

```json
{
  "replaceAllState": true,
  "conversation": { "...": "..." },
  "messages": [],
  "displayGroups": [],
  "contentBlocks": []
}
```

The recovered important fields are:

```text
1  replaceAllState
2  conversation
3  messages[]
4  displayGroups[]
5  contentBlocks[]
7  elicitations[]
10 deletedMessageIds[]
11 deletedDisplayGroupIds[]
12 deletedContentBlockIds[]
14 deletedElicitationIds[]
20 mutationAcks[]
22 degradedFallback
27 rebaseReason
28 projectionConfigKey
29 olderHistoryCursor
30 baselineFloorMessageId
31 turnDisposition
32 inlineComparisons[]
33 deletedInlineComparisonIds[]
34 conversationStatement
```

For text chat, fields 1-5 are enough.

Minimal Bard conversation object:

```json
{
  "id": "CONVERSATION-UUID",
  "title": "Example",
  "status": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "model": {"identifier":"claude-sonnet-4-6"},
  "currentLeafMessageId": "MESSAGE-UUID",
  "settings": {},
  "isStarred": false,
  "isTemporary": false,
  "isArchived": false,
  "revisionNs": "1"
}
```

Minimal Bard message:

```json
{
  "id": "MESSAGE-UUID",
  "conversationId": "CONVERSATION-UUID",
  "role": 1,
  "index": 0,
  "isComplete": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "parentMessageId": "",
  "stopReason": 0,
  "turnStartKind": 1
}
```

The compatibility implementation uses role `1` for human and `2` for assistant.

A text block can be represented as:

```json
{
  "id": "MESSAGE-UUID-text",
  "displayGroupId": "MESSAGE-UUID-group",
  "index": 0,
  "isComplete": true,
  "state": 2,
  "text": "Hello"
}
```

A corresponding display group:

```json
{
  "id": "MESSAGE-UUID-group",
  "messageId": "MESSAGE-UUID",
  "index": 0,
  "style": 1,
  "isComplete": true
}
```

---

### PerformAction

```text
POST .../PerformAction
```

Request contains a header plus one action/oneof.

Header core:

```json
{
  "conversationId": "CONVERSATION-UUID",
  "mutationId": {
    "sessionId": "CLIENT-SESSION-ID",
    "version": 1
  }
}
```

The header has many optional fields (client capabilities, device information, actor UUID, language, signing metadata); you can ignore them for a private backend unless the UI begins relying on one.

#### sendMessage

```json
{
  "header": {
    "conversationId": "CONVERSATION-UUID",
    "mutationId": {"sessionId":"client","version":1}
  },
  "sendMessage": {
    "messageId": "HUMAN-UUID",
    "assistantMessageId": "ASSISTANT-UUID",
    "text": "Hello",
    "parentMessageId": "PREVIOUS-MESSAGE-UUID",
    "isTemporary": false,
    "timezone": "Europe/London",
    "locale": "en-GB"
  }
}
```

Recovered `BardSendMessage` additionally supports attachments, model, settings updates, project, work mode, inline attachments, client tools, chat-memory mode, attached folders, local project, routine run, safety controls and other newer features.

#### Other important PerformAction variants

Recovered variants include:

```text
stopGeneration
respondToElicitation
messageFeedback
renameConversation
updateConversationSettings
starConversation
submitClientToolResult
refreshConversation
workspaceUpgrade
stopResearchTask
warmTurn
browserAttachAcquire
browserAttachRelease
browserAttachTakeover
publishFile
reloadSkills
provideDeviceSignatures
externalReplyProgress
setCurrentLeaf
attuneStart
attuneEnd
bindDevice
setConversationModel
abandonInlineComparison
invokeBlockAction
```

For basic chat, implement send/rename/star/model plus harmless acknowledgements for refresh/stop/warm-turn.

Successful acknowledgement:

```json
{
  "ack": {
    "highWaterMark": {
      "sessionId": "client",
      "version": 1
    },
    "applied": true
  }
}
```

---

### StreamTimeline

Request:

```json
{"conversationId":"CONVERSATION-UUID"}
```

Stream Connect-framed responses such as:

```json
{
  "event": {
    "update": {
      "replaceAllState": true,
      "conversation": {},
      "messages": [],
      "displayGroups": [],
      "contentBlocks": []
    },
    "version": {
      "value": "1"
    }
  }
}
```

When canonical state changes, emit another update. The compatibility mock ends/reconnects periodically; a production backend can keep this stream open normally.

---

### ReportViewing

Can return an empty message:

```json
{}
```

---

# 9. MCP and optional feature routes

You do not need these to do basic text chat, but returning empty/disabled states prevents unrelated UI from becoming a blocker.

Under `/api/organizations/{org}/`:

```text
projects                              -> []
published_artifacts                   -> []
artifacts                             -> []
composer_notices                      -> []
members/display_info                  -> []
cowork/sessions                       -> []
cowork/remote_devices                 -> []
skills/list-skills                    -> []
mcp/remote_servers                    -> []
notification/channels                 -> []
```

No-op `{}` routes used by the mock include:

```text
experiences/track
experiences/action
notification/push/track_open
notification/live-activity/start-token
notification/live-activity/token
notification/live-activity/user-dismiss
reflections/time_spent
```

Useful disabled settings:

```json
memory/settings
{
  "is_memory_enabled": false,
  "is_melange_memory_enabled": false,
  "is_memory_search_enabled": false
}
```

```json
reflections/settings
{"verdict":null}
```

```json
sync/auth/status
{"connected":false}
```

```json
notification/preferences
{"preferences":{},"effective_push":{}}
```

```json
cowork_settings
{"skip_approvals_enabled":false,"auto_mode_enabled":false}
```

```json
permission_mode_policy
{
  "auto_permissions":{"allowed":false,"managed":false},
  "bypass_permissions":{"allowed":false,"managed":false}
}
```

MCP bootstrap uses SSE:

```text
POST /api/organizations/{org}/mcp/v2/bootstrap
```

A minimal empty bootstrap is:

```text
event: server_list
data: {"servers":[]}

event: first_pass_complete
data: {}

event: completed
data: {}

```

---

# 10. Supported regions

The client has:

```text
GET /api/supported_regions
```

Example permissive response:

```json
{
  "regions": {
    "GB": {
      "claudeai_supported": true,
      "phone_verification_supported": false
    },
    "US": {
      "claudeai_supported": true,
      "phone_verification_supported": false
    }
  },
  "phone_verification_allowed_regions": []
}
```

Populate whatever regions your service actually supports.

---

# 11. Error format

A compatible generic JSON error envelope is:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request",
    "message": "description"
  }
}
```

Use ordinary status codes: `400`, `401`, `403`, `404`, `429`, `500`, `501`.

For your own backend, the important distinction is that `verify_magic_link` must not return success unless it also establishes `sessionKey`.

---

# 12. Recommended architecture

Keep this split:

```text
Claude iOS
  -> thin Claude-Mobile adapter
  -> your stable Router API
  -> per-user Claudesk/session runtime
  -> inference backend
```

Do not make your canonical session model copy the private mobile API. Map these client concepts instead:

```text
Claude conversation UUID  <-> canonical session ID
Claude message UUID       <-> canonical message/event ID
organization UUID         <-> tenant/workspace ID
sessionKey                <-> your authenticated mobile session
Bard mutation/version     <-> canonical revision/event cursor
```

A good internal API remains roughly:

```text
getCurrentUser
listSessions
createSession
getSession
sendMessage
subscribeToEvents
uploadFile
approveToolCall
renameSession
archiveSession
deleteSession
```

Then implement both REST/SSE and Connect/protobuf as disposable adapters over that API.

---

# 13. What is confirmed vs still approximate

## Device-confirmed on the supplied build

The custom endpoint picker is usable in the original sideloaded IPA. The app reaches `/api/legal`, `send_magic_link`, `verify_magic_link`, `/api/account`, and `/api/bootstrap/{org}/app_start`. The `sessionKey` cookie is accepted and sent back. Removing the hard-coded Anthropic Keychain access-group plist entry allows the authenticated state to persist successfully.

## Confirmed from static analysis

The JSON snake-case strategies, Account/AccountBootstrap coding keys, login request types, conversation coding keys, SSE event types, `sessionKey`, REST conversation paths, RecentsService/ConversationService method names, and protobuf field-number/name tables are present in the exact analyzed binary.

## Compatibility implementation choices, not claims about Anthropic production

The synthetic account values, `free` plan label, disabled feature defaults, enum numeric values used for the minimal Bard projection, empty optional-feature responses, and the exact subset of newer Bard fields emitted above are choices made to satisfy the client with a self-hosted backend. Preserve the shapes the client needs, not Anthropic business semantics.

---

# 14. Fastest path to your own backend

Implement in this order:

1. `GET /api/legal`.
2. `POST /api/auth/send_magic_link` and `verify_magic_link` + `sessionKey`.
3. `GET /api/account`.
4. `GET /api/bootstrap/{org}/app_start` with the minimal model selector.
5. `GET/POST /api/organizations/{org}/chat_conversations_v2` and `chat_conversations`.
6. `GET /chat_conversations/{id}`.
7. `POST /chat_conversations/{id}/completion` with the SSE sequence.
8. Persist client UUIDs and history.
9. Implement RecentsService + ConversationService if the current UI requests them.
10. Add uploads.
11. Return empty/disabled optional-feature states.
12. Add tool-use approval and richer Bard actions last.

The accompanying recovered schema JSON contains the protobuf message/enum field-number tables extracted from this build. It is much larger than the minimal text-chat subset documented above.
