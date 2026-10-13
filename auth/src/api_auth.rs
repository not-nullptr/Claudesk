use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use serde_json::json;

use crate::crypto::{hash_password, verify_password};
use crate::error::{AppError, AppResult};
use crate::store::User;
use crate::{AppState, Config};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct AcceptInviteRequest {
    pub token: String,
    pub password: String,
    /// Sent by the browser when the invite is accepted — the first moment the
    /// user's own browser, rather than the admin's, is in the loop.
    #[serde(default)]
    pub timezone: Option<String>,
}

/// Collapse an IPv6 client to its /64 so rotating the host part cannot escape a
/// ban; IPv4 (including v4-mapped) buckets as its own address.
fn bucket(address: &str) -> String {
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.to_string();
            }
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        _ => address.to_string(),
    }
}

/// The client address, taking `trust_proxy_hops` entries off the right of
/// `X-Forwarded-For` (the one the nearest trusted proxy appended).
fn client_bucket(hops: u8, peer: SocketAddr, headers: &HeaderMap) -> String {
    let ip = if hops > 0 {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|xff| {
                let parts: Vec<&str> = xff
                    .split(',')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .collect();
                parts
                    .len()
                    .checked_sub(hops as usize)
                    .and_then(|i| parts.get(i))
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| peer.ip().to_string())
    } else {
        peer.ip().to_string()
    };
    bucket(&ip)
}

fn session_cookie(cfg: &Config, token: String) -> Cookie<'static> {
    Cookie::build((cfg.cookie_name.clone(), token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(cfg.cookie_secure)
        .max_age(time::Duration::seconds(cfg.session_ttl_secs))
        .build()
}

pub fn cleared_cookie(cfg: &Config) -> Cookie<'static> {
    Cookie::build((cfg.cookie_name.clone(), ""))
        .path("/")
        .max_age(time::Duration::seconds(0))
        .build()
}

pub async fn current_user(state: &AppState, jar: &CookieJar) -> AppResult<Option<User>> {
    match jar.get(&state.cfg.cookie_name) {
        Some(cookie) => state.store.session_user(cookie.value()).await,
        None => Ok(None),
    }
}

/// Sign in. Every failure — unknown email, no password set, wrong password — is
/// the same 401, and a dummy Argon2 verify keeps the timing flat.
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    let bucket = client_bucket(state.cfg.trust_proxy_hops, peer, &headers);
    if state.store.banned_until(&bucket).await?.is_some() {
        return Err(AppError::RateLimited);
    }

    let email = body.email.trim().to_lowercase();
    let user = state.store.user_by_email(&email).await?;
    let ok = match &user {
        Some(u) if u.can_sign_in() => u
            .password_hash
            .as_deref()
            .map(|h| verify_password(h, &body.password))
            .unwrap_or(false),
        _ => {
            verify_password(&state.dummy_hash, &body.password);
            false
        }
    };
    if !ok {
        state
            .store
            .record_failure(&bucket, state.cfg.max_failures, state.cfg.base_ban_secs)
            .await?;
        return Err(AppError::Unauthorized);
    }

    let user = user.ok_or(AppError::Unauthorized)?;
    state.store.clear_failures(&bucket).await?;
    let token = state
        .store
        .create_session(user.id, state.cfg.session_ttl_secs)
        .await?;
    Ok((jar.add(session_cookie(&state.cfg, token)), Json(json!({ "user": user }))))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if let Some(cookie) = jar.get(&state.cfg.cookie_name) {
        state.store.delete_session(cookie.value()).await?;
    }
    Ok((jar.add(cleared_cookie(&state.cfg)), Json(json!({ "ok": true }))))
}

pub async fn me(State(state): State<AppState>, jar: CookieJar) -> AppResult<Json<serde_json::Value>> {
    let user = current_user(&state, &jar)
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(Json(json!({ "user": user })))
}

pub async fn accept_invite(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<AcceptInviteRequest>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    if body.password.len() < state.cfg.min_password_len {
        return Err(AppError::BadRequest(format!(
            "password must be at least {} characters",
            state.cfg.min_password_len
        )));
    }
    let user_id = state.store.consume_invite(&body.token).await?;
    state
        .store
        .set_password(user_id, &hash_password(&body.password)?)
        .await?;
    if let Some(tz) = body.timezone.as_deref().map(str::trim).filter(|t| !t.is_empty() && t.len() <= 64) {
        state.store.set_timezone(user_id, tz).await?;
    }
    let token = state
        .store
        .create_session(user_id, state.cfg.session_ttl_secs)
        .await?;
    let user = state.store.user(user_id).await?;
    Ok((jar.add(session_cookie(&state.cfg, token)), Json(json!({ "user": user }))))
}

/// Caddy's `forward_auth` endpoint: 200 + `X-Instance-Upstream` when the session
/// is live and the user has an instance, otherwise a non-2xx and no upstream.
pub async fn verify(State(state): State<AppState>, jar: CookieJar) -> Response {
    match current_user(&state, &jar).await {
        Ok(Some(user)) => match user.upstream.as_deref().filter(|u| !u.is_empty()) {
            Some(upstream) => {
                let mut response = StatusCode::OK.into_response();
                let headers = response.headers_mut();
                if let Ok(value) = HeaderValue::from_str(upstream) {
                    headers.insert(HeaderName::from_static("x-instance-upstream"), value);
                }
                headers.insert(
                    HeaderName::from_static("x-auth-user"),
                    HeaderValue::from_str(&user.id.to_string())
                        .unwrap_or(HeaderValue::from_static("")),
                );
                response
            }
            None => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "no instance provisioned for this account" })),
            )
                .into_response(),
        },
        _ => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response(),
    }
}
