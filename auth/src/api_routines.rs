//! Per-routine fire tokens.
//!
//! An instance mints a token for one of its scheduled tasks and stores the
//! hash locally; it mirrors the same hash here so a cookie-less fire request can
//! be routed before any instance sees it. Two routes do that:
//!
//! - `/internal/routine-tokens[/revoke]` — the instance registers or revokes a
//!   hash. Reachable only from inside the deployment network (the reverse
//!   proxy does not forward `/internal/*`), and authenticated by the account's
//!   own session cookie, which the instance forwards.
//! - `/api/auth/verify-routine` — Caddy's `forward_auth` target for the fire
//!   path. It accepts only a bearer token, never a cookie, and answers with the
//!   owning account's `X-Instance-Upstream` exactly as `/api/auth/verify` does
//!   for a session.
//!
//! A token is scoped to one routine by the instance that minted it; the edge
//! only needs to know which instance, which is what the table row carries.

use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;

use crate::api_auth::current_user;
use crate::crypto::sha256_hex;
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub routine_id: String,
    pub token_sha256: String,
}

#[derive(Deserialize)]
pub struct RevokeRequest {
    pub routine_id: String,
}

fn routine_id(value: &str) -> AppResult<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err(AppError::BadRequest("invalid routine id".into()));
    }
    Ok(trimmed)
}

fn token_hash(value: &str) -> AppResult<String> {
    let hash = value.trim().to_ascii_lowercase();
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(
            "token_sha256 must be a SHA-256 hex digest".into(),
        ));
    }
    Ok(hash)
}

/// Register (or rotate) the caller's token for one routine.
pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<RegisterRequest>,
) -> AppResult<StatusCode> {
    let user = current_user(&state, &jar)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if !user.can_sign_in() {
        return Err(AppError::Unauthorized);
    }
    let routine = routine_id(&body.routine_id)?;
    let hash = token_hash(&body.token_sha256)?;
    state
        .store
        .upsert_routine_token(user.id, routine, &hash)
        .await?;
    Ok(StatusCode::OK)
}

/// Revoke the caller's token for one routine. Idempotent.
pub async fn revoke(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<RevokeRequest>,
) -> AppResult<StatusCode> {
    let user = current_user(&state, &jar)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let routine = routine_id(&body.routine_id)?;
    state.store.revoke_routine_token(user.id, routine).await?;
    Ok(StatusCode::OK)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response()
}

/// Caddy's `forward_auth` target for a fire request: bearer-only, no cookie.
pub async fn verify(State(state): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(str::trim)
        .unwrap_or("");
    // Only this deployment's per-routine tokens are accepted here. Anything
    // else is a plain unauthorised request, not a session check.
    if !token.starts_with("sk-ant-oat01-") {
        return unauthorized();
    }
    match state.store.resolve_routine_token(&sha256_hex(token)).await {
        Ok(Some((user_id, upstream))) => match upstream.as_deref().filter(|value| !value.is_empty()) {
            Some(upstream) => {
                let mut response = StatusCode::OK.into_response();
                let headers = response.headers_mut();
                if let Ok(value) = HeaderValue::from_str(upstream) {
                    headers.insert(HeaderName::from_static("x-instance-upstream"), value);
                }
                headers.insert(
                    HeaderName::from_static("x-auth-user"),
                    HeaderValue::from_str(&user_id.to_string())
                        .unwrap_or(HeaderValue::from_static("")),
                );
                response
            }
            // The account exists but has no instance yet. Not a token failure.
            None => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "workspace not ready" })),
            )
                .into_response(),
        },
        Ok(None) => unauthorized(),
        Err(error) => error.into_response(),
    }
}
