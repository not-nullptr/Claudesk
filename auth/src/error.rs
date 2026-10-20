use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Every failure the API can produce. The mobile facade's error envelope is
/// `{ "error": … }`, so keep the same shape.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    /// An upstream instance answered with an error (or not at all).
    #[error("{0}")]
    BadGateway(String),
    /// The deployment has not configured this action.
    #[error("{0}")]
    Unavailable(String),
    #[error("too many attempts")]
    RateLimited,
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<sqlx::migrate::MigrateError> for AppError {
    fn from(error: sqlx::migrate::MigrateError) -> Self {
        AppError::Internal(format!("migration: {error}"))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        // A UNIQUE violation is a client-visible conflict, not a server fault.
        if let sqlx::Error::Database(db) = &error {
            if db.message().contains("UNIQUE") {
                return AppError::Conflict("already exists".into());
            }
        }
        AppError::Internal(error.to_string())
    }
}

impl From<argon2::password_hash::Error> for AppError {
    fn from(error: argon2::password_hash::Error) -> Self {
        AppError::Internal(format!("password hash: {error}"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "not signed in".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m.clone()),
            AppError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m.clone()),
            AppError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "too many attempts".to_string()),
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
