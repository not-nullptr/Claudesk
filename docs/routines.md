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

The body is optional and carries only `text` (≤ 65,536 characters), exactly as
upstream. Everything else — model, folder, permission mode, schedule, the saved
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

## Tokens

One bearer token per routine, returned once and stored only as a SHA-256 hash
(on the instance, and mirrored into authd for edge routing). `text` cannot leak
through a token, and a token only fires the routine it was minted for.

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
	@routine_fire path_regexp routine_fire ^/v1/claude_code/routines/[^/]+/fire$
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
- Per-fire overrides: `text` is the only body field; unknown fields are ignored,
  as upstream.
- Notifications, repositories and connector configuration on the cloud form.
