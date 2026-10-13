use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api_auth::current_user;
use crate::error::{AppError, AppResult};
use crate::store::User;
use crate::AppState;

/// The largest profile photo authd will store, and the image types it accepts.
/// Mirrors the bridge's raster set (svg is left out of user uploads).
const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
const AVATAR_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
];

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub email: String,
    /// Optional at creation: the first name belongs to the invited person, who
    /// sets it when they accept. The admin may set one here for a script.
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// host:port of this user's instance, if it is already provisioned.
    #[serde(default)]
    pub upstream: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
    /// Empty string clears the upstream.
    #[serde(default)]
    pub upstream: Option<String>,
}

/// A first name that must be present (the invitee's, or an admin edit), trimmed
/// and length-checked.
pub fn normalize_first_name(raw: Option<&str>) -> AppResult<&str> {
    let name = raw.unwrap_or("").trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::BadRequest("a first name is required".into()));
    }
    Ok(name)
}

/// The `Content-Type` an uploaded avatar may carry, or a 400. A parameter such as
/// `; charset=` is ignored; the value is what the browser loads the image as.
pub fn normalize_avatar_type(raw: Option<&str>) -> AppResult<&'static str> {
    let value = raw
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    AVATAR_TYPES
        .iter()
        .copied()
        .find(|allowed| *allowed == value)
        .ok_or_else(|| {
            AppError::BadRequest("avatar must be a PNG, JPEG, WebP, GIF or AVIF image".into())
        })
}

/// The checks shared by the admin and the self avatar uploads, so both reject the
/// same bodies. Returns the content type to store.
pub fn validate_avatar(headers: &HeaderMap, body: &[u8]) -> AppResult<&'static str> {
    let content_type = normalize_avatar_type(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    )?;
    if body.is_empty() {
        return Err(AppError::BadRequest("avatar is empty".into()));
    }
    if body.len() > MAX_AVATAR_BYTES {
        return Err(AppError::BadRequest(format!(
            "avatar must be at most {} bytes",
            MAX_AVATAR_BYTES
        )));
    }
    Ok(content_type)
}

fn normalize_role(role: Option<&str>) -> AppResult<&'static str> {
    match role.unwrap_or("User") {
        "User" | "user" => Ok("User"),
        "Admin" | "admin" => Ok("Admin"),
        _ => Err(AppError::BadRequest("role must be User or Admin".into())),
    }
}

async fn require_admin(state: &AppState, jar: &CookieJar) -> AppResult<User> {
    let user = current_user(state, jar)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if !user.is_admin() {
        return Err(AppError::Forbidden);
    }
    Ok(user)
}

pub async fn list_users(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    Ok(Json(json!({ "users": state.store.list_users().await? })))
}

/// Create an account and return a one-time invite token. This is the only time
/// the token exists in the clear — the admin UI shows the invite link once.
pub async fn create_user(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<CreateUserRequest>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let email = body.email.trim().to_lowercase();
    if email.len() > 200 || !email.contains('@') {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    let first_name = body.first_name.as_deref().unwrap_or("").trim();
    if first_name.len() > 80 {
        return Err(AppError::BadRequest("first name is too long".into()));
    }
    let role = normalize_role(body.role.as_deref())?;
    let upstream = body
        .upstream
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let user = state
        .store
        .create_user(&email, first_name, role, upstream)
        .await?;
    let invite_token = state
        .store
        .create_invite(user.id, state.cfg.invite_ttl_secs)
        .await?;
    // Ask the host to provision this account's instance now, so it is ready by
    // the time the invite is accepted rather than on the reconciler's next poll.
    state.nudge_provision(user.id);
    Ok(Json(json!({ "user": user, "invite_token": invite_token })))
}

pub async fn update_user(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;

    if let Some(first_name) = body.first_name.as_deref() {
        state
            .store
            .set_first_name(user.id, normalize_first_name(Some(first_name))?)
            .await?;
    }
    if let Some(role) = body.role.as_deref() {
        state.store.set_role(user.id, normalize_role(Some(role))?).await?;
    }
    if let Some(disabled) = body.disabled {
        state.store.set_disabled(user.id, disabled).await?;
        if disabled {
            state.store.delete_sessions_for_user(user.id).await?;
        }
    }
    if let Some(upstream) = body.upstream.as_deref() {
        let value = upstream.trim();
        let value = if value.is_empty() { None } else { Some(value) };
        state.store.set_upstream(user.id, value).await?;
    }
    Ok(Json(json!({ "user": state.store.user(user.id).await? })))
}

/// Reset: revoke every session and issue a fresh invite. No password is set here
/// — the user chooses one when they accept.
pub async fn reset_password(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    state.store.delete_sessions_for_user(user.id).await?;
    let invite_token = state
        .store
        .create_invite(user.id, state.cfg.invite_ttl_secs)
        .await?;
    Ok(Json(json!({ "user": user, "invite_token": invite_token })))
}

pub async fn delete_user(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let admin = require_admin(&state, &jar).await?;
    if admin.id == id {
        return Err(AppError::BadRequest(
            "you cannot delete your own account".into(),
        ));
    }
    state.store.delete_user(id).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Replace a user's profile photo. The raw image bytes are the body, with the
/// image type in `Content-Type`; the admin UI does not send JSON here.
pub async fn set_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    let content_type = validate_avatar(&headers, &body)?;
    state.store.set_avatar(user.id, content_type, &body).await?;
    Ok(Json(json!({ "user": state.store.user(user.id).await? })))
}

/// Remove a user's profile photo, so their avatar falls back to the default mark.
pub async fn clear_avatar(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    state.store.clear_avatar(user.id).await?;
    Ok(Json(json!({ "user": state.store.user(user.id).await? })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(content_type: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
        headers
    }

    #[test]
    fn avatar_type_accepts_raster_images_and_tolerates_parameters() {
        assert_eq!(normalize_avatar_type(Some("image/png")).unwrap(), "image/png");
        assert_eq!(
            normalize_avatar_type(Some("image/jpeg; charset=binary")).unwrap(),
            "image/jpeg"
        );
        assert_eq!(normalize_avatar_type(Some("IMAGE/WEBP")).unwrap(), "image/webp");
    }

    #[test]
    fn avatar_type_rejects_missing_unknown_and_svg() {
        assert!(normalize_avatar_type(None).is_err());
        assert!(normalize_avatar_type(Some("application/octet-stream")).is_err());
        assert!(normalize_avatar_type(Some("image/svg+xml")).is_err());
    }

    #[test]
    fn validate_avatar_rejects_empty_and_oversized_bodies() {
        let png = headers("image/png");
        assert!(validate_avatar(&png, &[]).is_err());
        assert!(validate_avatar(&png, &[0u8; 8]).is_ok());
        let big = vec![0u8; MAX_AVATAR_BYTES + 1];
        assert!(validate_avatar(&png, &big).is_err());
    }

    #[test]
    fn first_name_is_required_and_bounded() {
        assert_eq!(normalize_first_name(Some("  Ada ")).unwrap(), "Ada");
        assert!(normalize_first_name(None).is_err());
        assert!(normalize_first_name(Some("   ")).is_err());
        assert!(normalize_first_name(Some(&"a".repeat(81))).is_err());
    }
}
