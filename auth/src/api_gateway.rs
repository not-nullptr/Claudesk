//! The gateway's key-resolution endpoint.
//!
//! The box gateway (shitproxy) fronts every account's inference. It receives the
//! account's opaque gateway key as `X-Api-Key` and asks authd here for the key
//! that request should actually go upstream with — the account's own. This keeps
//! the real upstream key out of every instance's environment and out of the
//! gateway's static config.
//!
//! It is not a public API: the route lives under `/internal/`, which the reverse
//! proxy does not forward, and it is additionally gated on a shared secret. With
//! no secret configured the route answers 404, so authd is inert until an
//! operator opts in.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::AppState;

/// Proof that the caller is the gateway.
pub const SECRET_HEADER: &str = "x-gateway-secret";
/// The account's opaque gateway key, as the instance sent it.
pub const KEY_HEADER: &str = "x-gateway-key";

/// Compare through a hash so the comparison is fixed-width and does not leak the
/// secret's length. This is a defence-in-depth check on an internal route, not a
/// password verify.
fn secret_matches(presented: Option<&str>, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let a = Sha256::digest(presented.unwrap_or("").as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a == b
}

pub async fn resolve_gateway_key(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(expected) = state.cfg.gateway_secret.as_deref() else {
        // Distinct body from "unknown gateway key" below, so a disabled route is
        // not mistaken for a caller authd simply does not know.
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "gateway key resolution is disabled" })),
        )
            .into_response();
    };
    let presented = headers.get(SECRET_HEADER).and_then(|value| value.to_str().ok());
    if !secret_matches(presented, expected) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let Some(gateway_key) = headers
        .get(KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|key| !key.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "no gateway key" }))).into_response();
    };

    match state.store.resolve_gateway_key(gateway_key).await {
        // The account's own key: this is what the request goes upstream with.
        Ok(Some((_user_id, Some(api_key)))) => {
            (StatusCode::OK, Json(json!({ "upstream_api_key": api_key }))).into_response()
        }
        // A real account that has not supplied a key yet (or is disabled): refuse,
        // never fall back to the operator's key.
        Ok(Some((_user_id, None))) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "no upstream key set" })),
        )
            .into_response(),
        // Not a gateway key we issued.
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "unknown gateway key" })),
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::secret_matches;

    #[test]
    fn secret_matches_only_the_configured_value() {
        assert!(secret_matches(Some("s3cret"), "s3cret"));
        assert!(!secret_matches(Some("s3cret"), "s3cre"));
        assert!(!secret_matches(Some("wrong"), "s3cret"));
        assert!(!secret_matches(None, "s3cret"));
        assert!(!secret_matches(Some(""), "s3cret"));
    }
}
