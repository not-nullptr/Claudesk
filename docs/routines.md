# Routine fire triggers

Anthropic's cloud Claude Code routines have an HTTP entry point
(`POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire`) that starts
a new run of an already-saved routine. This deployment has no claude.ai backend,
but it does have everything a routine is: the Desktop's local scheduled tasks.
The bridge gives those tasks the same entry point, on the instance's own origin:

```http
POST https://claude.example.com/v1/claude_code/routines/{routine_id}/fire
Authorization: Bearer sk-ant-oat01-…
anthropic-version: 2023-06-01
Content-Type: application/json

{"text": "Sentry alert SEN-4521 fired in prod. Stack trace attached."}
```

The body is optional and carries `text` (≤ 65,536 characters), exactly as
upstream, plus an optional `images` array (a Claudesk extension — see below).
Everything else — model, folder, permission mode, schedule, the saved
instructions — is the task's own configuration. Each successful call starts one
new session and returns:

```json
{
  "type": "routine_fire",
  "claude_code_session_id": "cse_…",
  "claude_code_session_url": "https://claude.example.com/code/cse_…"
}
```

## What a routine is here

The routine list is `CoworkScheduledTasks.getAllScheduledTasks` over the Desktop
IPC — the same tasks the **Scheduled** page shows. The bridge tells the two
stores apart by the task's `filePath`:

| store | path | fires as |
| --- | --- | --- |
| Code routine | `~/.claude/scheduled-tasks/<id>/SKILL.md` | a Code session placed on the instance's self-hosted runner (the Cowork VM) |
| Cowork routine | `<cowork user files>/Scheduled/<id>/SKILL.md` | a Cowork session, the same `LocalAgentModeSessions.start` call Run now makes |

A fire reads the task's `SKILL.md` body (frontmatter stripped), appends the
caller's `text`, and starts the session with `scheduledTaskId` and
`scheduledTaskManualStart`, so the run is attributed to the routine.

Routine ids are opaque `trig_…` strings, like upstream's. This bridge encodes
the scheduled task's id into the suffix (base64url), so the id round-trips and
there is no second mapping store. A raw scheduled-task id is accepted too.

## Images

Upstream's fire body has no image field. This deployment accepts one anyway,
because both executors already carry images on a session's opening turn:

```json
{
  "text": "Sentry alert SEN-4521 fired in prod.",
  "images": [
    {"media_type": "image/png", "data": "<base64>"}
  ]
}
```

- Up to 20 images, 5 MiB each (decoded), `image/png`, `image/jpeg`,
  `image/gif` or `image/webp`. `{ "mimeType": …, "base64": … }` and a `name`
  are accepted too; a Claude API image block's `source` object can be pasted
  directly. The request body may be up to 32 MiB with images.
- They ride the routine's opening user turn:
  - a **Cowork** routine passes them to `LocalAgentModeSessions.start`, which
    attaches them to the new session;
  - a **Code** routine puts them in the first user event as base64 image
    blocks, and the guest runner forwards the whole content list to the agent
    (text and images together).
- No separate token or endpoint: the same per-routine bearer token covers it.
  A caller that sends only `text` is unaffected, and upstream would ignore the
  unknown `images` field.

## Tokens

One bearer token per routine, returned once and stored only as a SHA-256 hash
(on the instance, and mirrored into authd for edge routing). `text` cannot leak
through a token, and a token only fires the routine it was minted for.

Routine ids are the `trig_…` values the instance's own list returns:

```bash
curl -s https://claude.example.com/api/routines \
  -H "Cookie: sessionKey=<session cookie>" | jq '.value[] | {id, name, kind}'
```

The session cookie is the one the browser holds after signing in (devtools →
Application → Cookies; it is HttpOnly and Secure). The mint/revoke routes sit
behind the same gate, so a `curl` needs it; the in-app API card does the same
call with the page's session.

Mint or rotate:

```bash
curl -X POST https://claude.example.com/api/routines/<routine_id>/token \
  -H "Cookie: $SESSION_COOKIE"
```

Revoke:

```bash
curl -X DELETE https://claude.example.com/api/routines/<routine_id>/token \
  -H "Cookie: $SESSION_COOKIE"
```

Both sit behind the ordinary proxy session gate, like every other `/api/` leg.
The in-app card (**Routines → a routine → API**) uses the same code path through
`POST|DELETE /v1/code/triggers/{id}/api-token`, so a token minted there is the
same token.

### Token console

The instance serves a small UI for this at **`/routine-tokens`** (same session
gate). It lists the routines with their fire URLs, mints/rotates a token per
routine, shows the token once with a copy button and a ready-to-run `curl`, and
revokes it. It exists because the native API card is only on the cloud routine
detail; the Code/Cowork list opens the *local* task detail, which carries no
token UI, and the separate `routines-chorus` entry is compiled out of this
build.

Tokens are also removed when the routine is deleted or the account is deleted
(authd's `routine_tokens` rows cascade).

## Edge routing (host-side)

The fire request has no session cookie, so `forward_auth` cannot choose an
instance by itself. authd answers a second `forward_auth` target for exactly
this path: `/api/auth/verify-routine` accepts only a `sk-ant-oat01-…` bearer
token, resolves its account, and returns `X-Instance-Upstream`. Caddy's
Caddyfile is host-side (not in this repository); add this matcher **before** the
catch-all workspace handler, next to the existing session gate:

```caddyfile
	# Routine fire: bearer token only, no session cookie.
	@routine_fire path_regexp routine_fire ^/v1/claude_code/routines/[^/]+/fire/?$
	handle @routine_fire {
		forward_auth 127.0.0.1:15832 {
			uri /api/auth/verify-routine
			copy_headers X-Instance-Upstream
		}
		reverse_proxy {http.request.header.X-Instance-Upstream}
	}
```

Without this matcher the fire route still reaches the instance only through the
normal session gate, so an external caller gets a 401 — a safe failure, not a
silently different behaviour. The instance validates the token again against
its own store before starting anything.

`/internal/routine-tokens` and `/internal/routine-tokens/revoke` are mounted on
authd but deliberately outside `/api/*`: the proxy never forwards `/internal/*`,
and only an instance on the deployment network can reach authd directly. The
call carries the administrator's own session cookie, which is how authd decides
whose token it is.

## Rate limits

Mirroring upstream: 30 fires per routine per hour (shared with the in-app Run
now path) and 100 API fires per instance per hour. A limited call answers `429`
with `Retry-After` in seconds. There is no idempotency key: a retried webhook
starts another session.

## Error shape

```json
{"type":"error","error":{"type":"invalid_request_error","message":"…"}}
```

| status | type | cause |
| --- | --- | --- |
| 400 | `invalid_request_error` | missing/wrong `anthropic-version`, `text` not a string or over 65,536 chars, routine paused, no readable instructions |
| 401 | `authentication_error` | no bearer token, or it does not belong to this routine |
| 404 | `not_found_error` | no such routine |
| 429 | `rate_limit_error` | fire limit reached |
| 503 | `overloaded_error` | no inference model or no runner pool configured |

## Where the Routines entry comes from

In the Code frame the nav entry is the `scheduled` entry, renamed **Routines**
and pointed at `/code/routines`. Its visibility is not one gate but two, and both
must read true before the route renders at all:

- the **environment capabilities** document
  (`/v1/environment_providers/private/organizations/{org}/capabilities`) must
  carry `routines.enabled`; with the self-hosted-session flag on (see
  `withSelfHostedSessions`), the renderer takes its `session_host` branch and
  reads the routine capability from exactly there. The bridge answers
  `routines: {enabled: true, delete_removes_runs: true, persist_session: false,
  reviewed_save: false}`.
- the **`chilling_sloth_clocks`** rollout gate must be on. The bridge forces it
  on in a web-shell bootstrap (not only adding it when absent, because an
  upstream false hides the entry too).

Without either half, `/code/routines` is filtered out of the sidebar and the
route renders nothing, however the fire endpoint itself is configured.

## The in-app API card

The Routines page is the renderer's cloud-routines surface. The bridge serves
its data family (`/v1/code/triggers` list/detail/run/update/delete and
`/v1/code/triggers/{id}/api-token`) from the local task store, and grants the
`routines-chorus` gate in the web shell. Two details make the card useful:

- `api_token_hint` is present once a token exists, which is what the card keys
  on to show the "Generate token" state.
- The `routine-fire-origin` renderer patch replaces the hardcoded
  `https://api.anthropic.com` origin in the card's copied URL with
  `window.location.origin`, so the URL the user copies is this deployment's.
  It is a web-shell patch and intentionally not required: on a bundle that no
  longer matches, the card keeps the cloud URL rather than failing renderer
  preparation.

The cloud form's **Create** maps to `createScheduledTask` (name, instructions,
schedule, model and permission mode; repositories and connectors have no local
equivalent and are not carried). **Run now** maps to the same fire path as the
API. **Recent fires** is served empty — the local session history lives on the
**Scheduled** page (`getSessionsForScheduledTask`), and this first cut does not
project it into the cloud detail view.

## Not supported

- The literal `api.anthropic.com` URL and its claude.ai-issued tokens: upstream
  routines, tokens and cloud sessions live in a backend this deployment does not
  have.
- Per-fire overrides: `text` and `images` are the only body fields; model,
  folder, permission mode and the rest stay the task's. Other unknown fields are
  ignored, as upstream (which itself has no `images`).
- Notifications, repositories and connector configuration on the cloud form.
