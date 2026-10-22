use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// The setting that lays out the model picker: an ordered list of model ids kept
/// at the root, with every other model moved under "More models". Each account's
/// bridge reads it (see `/api/auth/deployment`) and rewrites the picker data it
/// serves. Absent row means "unset" — the native layout, every model at the root.
pub const MODEL_PICKER_MAIN_MODELS: &str = "model_picker_main_models";
/// The model the app's configuration health check probes. Desktop otherwise
/// picks one itself — the shortest entry named like a haiku, sonnet or opus
/// model — and reports it as the "configured model" in
/// "Configured model not available", with no setting that reaches that choice.
/// Each account's bridge reads this and probes it instead of Desktop's pick.
/// Absent or empty means "let Desktop choose".
pub const CONFIGURED_MODEL: &str = "configured_model";
/// How many models an operator may pin, and how long one id may be. The bound is
/// about a typo or a paste accident, not a real limit: the list is a shortlist.
const MAX_MAIN_MODELS: usize = 50;
const MAX_MODEL_ID_LEN: usize = 200;

#[derive(Deserialize)]
pub struct UpdateSettingsRequest {
    /// Omitted leaves the stored list alone; an empty list clears it (back to the
    /// native layout). Order is the picker's root order.
    #[serde(default)]
    pub model_picker_main_models: Option<Vec<String>>,
    /// Omitted leaves the stored model alone; an empty string clears it (Desktop
    /// picks the model its health check probes again).
    #[serde(default)]
    pub configured_model: Option<String>,
}

/// The main-model list as it is stored: trimmed, de-duplicated
/// case-insensitively (the picker matches ids that way), bounded, and in the
/// order the operator gave.
pub fn normalize_main_models(raw: &[String]) -> AppResult<Vec<String>> {
    if raw.len() > MAX_MAIN_MODELS {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_MAIN_MODELS} main models are allowed"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for value in raw {
        let id = value.trim();
        if id.is_empty() {
            continue;
        }
        if id.len() > MAX_MODEL_ID_LEN {
            return Err(AppError::BadRequest(format!(
                "a model id must be at most {MAX_MODEL_ID_LEN} characters"
            )));
        }
        if !seen.insert(id.to_ascii_lowercase()) {
            continue;
        }
        models.push(id.to_string());
    }
    Ok(models)
}

/// The configured model as it is stored: trimmed and bounded. Empty is a
/// meaningful value — it clears the setting, returning the choice to Desktop.
pub fn normalize_configured_model(raw: &str) -> AppResult<String> {
    let id = raw.trim();
    if id.len() > MAX_MODEL_ID_LEN {
        return Err(AppError::BadRequest(format!(
            "a model id must be at most {MAX_MODEL_ID_LEN} characters"
        )));
    }
    Ok(id.to_string())
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
    /// Replace the account's own upstream API key. The stored value is never read
    /// back, so this is a blind write; an empty string clears it.
    #[serde(default)]
    pub upstream_api_key: Option<String>,
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

/// The account's own upstream API key, which they supply when they accept the
/// invite (or an admin sets later). Required and bounded; the value is never
/// echoed back, and it is not verified against the provider here.
pub fn normalize_api_key(raw: Option<&str>) -> AppResult<&str> {
    let key = raw.unwrap_or("").trim();
    if key.is_empty() || key.len() > 200 {
        return Err(AppError::BadRequest("an API key is required".into()));
    }
    Ok(key)
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

/// The deployment settings the admin UI edits, as decoded values. Every known key
/// is present even when it is unset (its empty default), so the form never has to
/// tell "unset" from "not sent".
pub async fn get_settings(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    Ok(Json(json!({ "settings": deployment_settings(&state).await? })))
}

/// Write the settings the request carries. Keys it omits are left as they are,
/// so a future setting cannot be cleared by a client that predates it.
pub async fn update_settings(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<UpdateSettingsRequest>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    if let Some(raw) = body.model_picker_main_models.as_deref() {
        let models = normalize_main_models(raw)?;
        if models.is_empty() {
            state.store.clear_setting(MODEL_PICKER_MAIN_MODELS).await?;
        } else {
            let encoded = serde_json::to_string(&models)
                .map_err(|e| AppError::Internal(format!("setting encode: {e}")))?;
            state
                .store
                .set_setting(MODEL_PICKER_MAIN_MODELS, &encoded)
                .await?;
        }
    }
    if let Some(raw) = body.configured_model.as_deref() {
        let model = normalize_configured_model(raw)?;
        if model.is_empty() {
            state.store.clear_setting(CONFIGURED_MODEL).await?;
        } else {
            let encoded = serde_json::to_string(&model)
                .map_err(|e| AppError::Internal(format!("setting encode: {e}")))?;
            state
                .store
                .set_setting(CONFIGURED_MODEL, &encoded)
                .await?;
        }
    }
    Ok(Json(json!({ "settings": deployment_settings(&state).await? })))
}

/// Every stored setting, decoded. A value that no longer parses is passed through
/// as the raw string rather than dropped, so a hand-edited row stays visible.
async fn deployment_settings(state: &AppState) -> AppResult<Value> {
    let mut settings = serde_json::Map::new();
    settings.insert(
        MODEL_PICKER_MAIN_MODELS.into(),
        json!(main_models(state).await?),
    );
    settings.insert(CONFIGURED_MODEL.into(), json!(configured_model(state).await?));
    for (key, value) in state.store.settings().await? {
        if key == MODEL_PICKER_MAIN_MODELS || key == CONFIGURED_MODEL {
            continue;
        }
        let decoded = serde_json::from_str(&value).unwrap_or(Value::String(value));
        settings.insert(key, decoded);
    }
    Ok(Value::Object(settings))
}

/// The stored main-model list. Unset, or a stored value that is not a list of
/// strings, answers an empty list — which every reader treats as "no layout".
pub(crate) async fn main_models(state: &AppState) -> AppResult<Vec<String>> {
    let Some(raw) = state.store.setting(MODEL_PICKER_MAIN_MODELS).await? else {
        return Ok(Vec::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// The stored configured model. Unset, or a stored value that is not a string,
/// answers "" — the same meaning as unset: Desktop picks the model to probe.
pub(crate) async fn configured_model(state: &AppState) -> AppResult<String> {
    let Some(raw) = state.store.setting(CONFIGURED_MODEL).await? else {
        return Ok(String::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
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
    if let Some(api_key) = body.upstream_api_key.as_deref() {
        let value = api_key.trim();
        if value.is_empty() {
            state.store.clear_upstream_api_key(user.id).await?;
        } else {
            state
                .store
                .set_upstream_api_key(user.id, normalize_api_key(Some(value))?)
                .await?;
        }
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
    // Read the account before it is gone: once the row is deleted its email and
    // upstream are unrecoverable, and the host needs them to tear down the
    // account's instance and data root. The teardown request is written first, so
    // a crash in between leaves a replayable request rather than a silent leak.
    let user = state.store.user(id).await?;
    state.nudge_deprovision(&user);
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

/// The bounds the container init enforces (`30-claude-config.sh`). Refusing the
/// same values here keeps a bad spec out of the database: an out-of-range value
/// would make the account's Desktop container fail its init on the next Apply.
const VM_MEMORY_RANGE: std::ops::RangeInclusive<i64> = 1..=16;
const VM_CPU_RANGE: std::ops::RangeInclusive<i64> = 1..=8;

#[derive(Deserialize)]
pub struct UpdateUserVmRequest {
    /// `null` (or omitted) clears the override: the account inherits the
    /// deployment's `.env` sizing again.
    #[serde(default)]
    pub memory_gb: Option<i64>,
    #[serde(default)]
    pub cpu_count: Option<i64>,
}

pub fn validate_vm_spec(memory_gb: Option<i64>, cpu_count: Option<i64>) -> AppResult<()> {
    if let Some(value) = memory_gb {
        if !VM_MEMORY_RANGE.contains(&value) {
            return Err(AppError::BadRequest(
                "memory_gb must be between 1 and 16".into(),
            ));
        }
    }
    if let Some(value) = cpu_count {
        if !VM_CPU_RANGE.contains(&value) {
            return Err(AppError::BadRequest(
                "cpu_count must be between 1 and 8".into(),
            ));
        }
    }
    Ok(())
}

/// Save the desired Cowork VM sizing for one account. Nothing is recreated
/// here — an Apply is the destructive, explicit step.
pub async fn update_user_vm(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUserVmRequest>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    validate_vm_spec(body.memory_gb, body.cpu_count)?;
    state
        .store
        .set_vm_spec(user.id, body.memory_gb, body.cpu_count)
        .await?;
    Ok(Json(json!({ "user": state.store.user(user.id).await? })))
}

/// Queue the host reconcile that writes the saved sizing into the account's
/// compose project and recreates its containers. Asynchronous by design: the
/// reconciler owns the container runtime, and a recreate kills in-flight turns.
pub async fn apply_user_vm(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    if user.disabled != 0 {
        return Err(AppError::Conflict(
            "enable the account before applying VM specs".into(),
        ));
    }
    if user.upstream.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::Conflict("this account has no instance yet".into()));
    }
    state.nudge_vm_apply(&user);
    Ok(Json(json!({ "queued": true })))
}

/// Restart one account's Cowork VM. The instance's bridge owns the QMP/Desktop
/// side; authd only forwards the admin's request over the deployment network.
pub async fn restart_user_vm(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    let value = instance_call(&state, &user, "POST", "/internal/vm/restart")
        .await?;
    Ok(Json(json!({ "vm": value })))
}

/// The VM monitor state the admin panel shows beside its controls.
pub async fn user_vm_status(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    require_admin(&state, &jar).await?;
    let user = state.store.user(id).await?;
    let value = instance_call(&state, &user, "GET", "/internal/vm/status")
        .await?;
    Ok(Json(json!({ "vm": value })))
}

/// Call one internal action on the account's instance. The shared secret is
/// what the bridge checks; `internal_upstream` is the instance's `gateway_net`
/// alias, which authd can reach without host networking.
///
/// Deliberately a minimal HTTP/1.1 exchange rather than an HTTP client crate:
/// the route is plain HTTP on the deployment network, the answers are small
/// JSON documents, and authd's dependency set stays what it is.
async fn instance_call(
    state: &AppState,
    user: &User,
    method: &str,
    path: &str,
) -> AppResult<Value> {
    let secret = state.cfg.internal_secret.as_deref().ok_or_else(|| {
        AppError::Unavailable("instance actions are not configured (AXTD_INTERNAL_SECRET)".into())
    })?;
    let base = user
        .internal_upstream
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Conflict(
                "this account has no in-network instance address yet; deploy or refresh it"
                    .into(),
            )
        })?;
    let (host, port) = match base.rsplit_once(':') {
        Some((host, port)) => (
            host.trim_matches(['[', ']']),
            port.parse::<u16>().unwrap_or(80),
        ),
        None => (base, 80),
    };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\
         Accept: application/json\r\nx-claudesk-internal-secret: {secret}\r\n\
         Content-Length: 0\r\n\r\n"
    );
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect((host, port))
            .await
            .map_err(|error| {
                AppError::BadGateway(format!(
                    "could not reach the account's instance at {base}: {error}"
                ))
            })?;
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| AppError::BadGateway(format!("instance request failed: {error}")))?;
        let mut raw = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = stream
                .read(&mut buffer)
                .await
                .map_err(|error| AppError::BadGateway(format!("instance response failed: {error}")))?;
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&buffer[..read]);
        }
        Ok::<Vec<u8>, AppError>(raw)
    };
    let raw = tokio::time::timeout(std::time::Duration::from_secs(120), exchange)
        .await
        .map_err(|_| AppError::BadGateway("the account's instance did not answer in time".into()))??;
    let (status, body) = parse_http_response(&raw)?;
    let document: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = document
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the account's instance refused the action");
        return Err(AppError::BadGateway(message.to_string()));
    }
    Ok(document.get("value").cloned().unwrap_or(document))
}

/// Split an HTTP/1.1 response into its status code and body, honouring
/// `Content-Length` and chunked encoding. The routes this calls are Node's
/// `sendJson`, which may answer either way depending on whether it precomputed
/// a length.
fn parse_http_response(raw: &[u8]) -> AppResult<(u16, Vec<u8>)> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AppError::BadGateway("the instance answered an incomplete response".into()))?;
    let head = std::str::from_utf8(&raw[..split])
        .map_err(|_| AppError::BadGateway("the instance answered a malformed response".into()))?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| AppError::BadGateway("the instance answered no status".into()))?;
    let mut chunked = false;
    let mut length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => {
                chunked = true
            }
            "content-length" => length = value.trim().parse::<usize>().ok(),
            _ => {}
        }
    }
    let body = &raw[split + 4..];
    if !chunked {
        return Ok((
            status,
            match length {
                Some(length) => body[..length.min(body.len())].to_vec(),
                None => body.to_vec(),
            },
        ));
    }
    let mut decoded = Vec::new();
    let mut rest = body;
    loop {
        let Some(line_end) = rest.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let size_text = std::str::from_utf8(&rest[..line_end]).unwrap_or("");
        let Ok(size) = usize::from_str_radix(size_text.trim().split(';').next().unwrap_or("0"), 16)
        else {
            break;
        };
        rest = &rest[line_end + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            decoded.extend_from_slice(rest);
            break;
        }
        decoded.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    Ok((status, decoded))
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

    #[test]
    fn api_key_is_required_trimmed_and_bounded() {
        assert_eq!(normalize_api_key(Some("  sk-abc  ")).unwrap(), "sk-abc");
        assert!(normalize_api_key(None).is_err());
        assert!(normalize_api_key(Some("   ")).is_err());
        assert!(normalize_api_key(Some(&"k".repeat(201))).is_err());
    }

    #[test]
    fn vm_specs_are_bounded_like_the_container_init() {
        assert!(validate_vm_spec(None, None).is_ok(), "unset inherits the deployment");
        assert!(validate_vm_spec(Some(1), Some(1)).is_ok());
        assert!(validate_vm_spec(Some(16), Some(8)).is_ok());
        assert!(validate_vm_spec(Some(0), None).is_err());
        assert!(validate_vm_spec(Some(17), None).is_err());
        assert!(validate_vm_spec(None, Some(0)).is_err());
        assert!(validate_vm_spec(None, Some(9)).is_err());
    }

    #[test]
    fn main_models_keep_their_order_and_drop_duplicates() {
        let raw = ["  claude-opus-5-5 ".to_string(), "claude-sonnet-5".to_string()];
        assert_eq!(
            normalize_main_models(&raw).unwrap(),
            vec!["claude-opus-5-5", "claude-sonnet-5"]
        );
        // The picker matches ids case-insensitively, so two spellings are one
        // model: the one named first is the one kept.
        let raw = ["Opus".to_string(), "opus".to_string(), "Sonnet".to_string()];
        assert_eq!(normalize_main_models(&raw).unwrap(), vec!["Opus", "Sonnet"]);
    }

    #[test]
    fn main_models_drop_blanks_and_accept_an_empty_list() {
        let raw = ["".to_string(), "   ".to_string(), "opus".to_string()];
        assert_eq!(normalize_main_models(&raw).unwrap(), vec!["opus"]);
        assert!(normalize_main_models(&[]).unwrap().is_empty());
    }

    #[test]
    fn configured_model_is_trimmed_empty_or_bounded() {
        assert_eq!(
            normalize_configured_model("  claude-opus-5-5 ").unwrap(),
            "claude-opus-5-5"
        );
        // Empty is how the page clears the setting: Desktop picks the probe model.
        assert_eq!(normalize_configured_model("   ").unwrap(), "");
        assert!(normalize_configured_model(&"a".repeat(MAX_MODEL_ID_LEN + 1)).is_err());
        assert!(normalize_configured_model(&"a".repeat(MAX_MODEL_ID_LEN)).is_ok());
    }

    #[test]
    fn main_models_are_bounded() {
        let long = vec!["opus".to_string(); MAX_MAIN_MODELS + 1];
        assert!(normalize_main_models(&long).is_err());
        let wide = ["a".repeat(MAX_MODEL_ID_LEN + 1)];
        assert!(normalize_main_models(&wide).is_err());
        let at_limit = ["a".repeat(MAX_MODEL_ID_LEN)];
        assert!(normalize_main_models(&at_limit).is_ok());
    }
}
