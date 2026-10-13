use axum::extract::{Path, State};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api_auth::current_user;
use crate::error::{AppError, AppResult};
use crate::store::User;
use crate::AppState;

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub email: String,
    pub first_name: String,
    #[serde(default)]
    pub role: Option<String>,
    /// host:port of this user's instance, if it is already provisioned.
    #[serde(default)]
    pub upstream: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
    /// Empty string clears the upstream.
    #[serde(default)]
    pub upstream: Option<String>,
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
    let first_name = body.first_name.trim();
    if first_name.is_empty() || first_name.len() > 80 {
        return Err(AppError::BadRequest("a first name is required".into()));
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
