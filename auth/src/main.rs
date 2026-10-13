//! authd — first-class authentication and account service for Claudesk.
//!
//! It owns users, sessions and invites, serves the login/admin SPA, and answers
//! Caddy's `forward_auth` (`/api/auth/verify`), returning the caller's instance
//! upstream so the reverse proxy can route them to their own Claude Desktop.
//! It never touches a container runtime.

mod api_admin;
mod api_auth;
mod crypto;
mod error;
mod store;

use std::net::SocketAddr;

use axum::extract::{DefaultBodyLimit, State};
use axum::routing::{any, get, patch, post, put};
use axum::{Json, Router};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::crypto::hash_password;
use crate::store::Store;

#[derive(Clone)]
pub struct Config {
    pub bind: String,
    pub db_path: String,
    pub web_dir: String,
    pub cookie_name: String,
    pub cookie_secure: bool,
    pub session_ttl_secs: i64,
    pub invite_ttl_secs: i64,
    pub min_password_len: usize,
    pub max_failures: i64,
    pub base_ban_secs: i64,
    pub trust_proxy_hops: u8,
    pub bootstrap_admin_email: Option<String>,
    /// Directory the reconciler's systemd `.path` unit watches. authd drops a
    /// per-account request file here so the host provisions on the event rather
    /// than on its next poll. authd itself never touches a container runtime.
    pub provision_spool: String,
}

impl Config {
    fn from_env() -> Config {
        let env = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
        let num = |key: &str, default: i64| -> i64 {
            env(key).and_then(|v| v.parse().ok()).unwrap_or(default)
        };
        let flag = |key: &str, default: bool| -> bool {
            env(key).map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(default)
        };
        Config {
            bind: env("AXTD_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()),
            db_path: env("AXTD_DB").unwrap_or_else(|| "/data/auth.db".into()),
            web_dir: env("AXTD_WEB_DIR").unwrap_or_else(|| "/app/web".into()),
            cookie_name: env("AXTD_COOKIE_NAME").unwrap_or_else(|| "sessionKey".into()),
            cookie_secure: flag("AXTD_COOKIE_SECURE", true),
            session_ttl_secs: num("AXTD_SESSION_TTL_DAYS", 30) * 86_400,
            invite_ttl_secs: num("AXTD_INVITE_TTL_HOURS", 72) * 3_600,
            min_password_len: num("AXTD_MIN_PASSWORD_LEN", 8).max(6) as usize,
            max_failures: num("AXTD_MAX_FAILURES", 5).max(1),
            base_ban_secs: num("AXTD_BASE_BAN_SECONDS", 600).max(1),
            trust_proxy_hops: num("AXTD_TRUST_PROXY", 1).clamp(0, 4) as u8,
            bootstrap_admin_email: env("AXTD_BOOTSTRAP_ADMIN_EMAIL"),
            provision_spool: env("AXTD_PROVISION_SPOOL")
                .unwrap_or_else(|| "/data/provision-requests".into()),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub cfg: Config,
    /// A real Argon2id hash of a throwaway value, verified on the "no such user"
    /// path so a missing account costs the same time as a wrong password.
    pub dummy_hash: String,
}

impl AppState {
    /// Ask the host's reconciler to provision this account now: drop a request
    /// file in the spool its systemd `.path` unit watches. Best-effort — a
    /// failure only costs the timer backstop a little time, never the caller's
    /// response, and authd stays a plain component.
    pub fn nudge_provision(&self, user_id: i64) {
        let path = std::path::Path::new(&self.cfg.provision_spool).join(user_id.to_string());
        if let Err(error) = std::fs::write(&path, b"") {
            tracing::debug!("provision nudge for user {user_id} failed: {error}");
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--healthcheck") {
        healthcheck();
    }
    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let invite_for = flag("--invite");
    let admin_for = flag("--create-admin");
    let show_for = flag("--show");
    let pending = args.iter().any(|arg| arg == "--pending");
    let provisioned = args.iter().any(|arg| arg == "--provisioned");
    let set_upstream_for = flag("--set-upstream");
    let set_upstream_value = args
        .iter()
        .position(|arg| arg == "--set-upstream")
        .and_then(|index| args.get(index + 2))
        .cloned();

    // An unrecognised option is a mistake, not a request to serve. Without this
    // an older binary handed a flag it does not know falls through and tries to
    // bind the port its own running instance already holds — which is exactly
    // how `--show` used to fail confusingly.
    if let Some(unknown) = args.iter().skip(1).find(|arg| {
        arg.starts_with("--")
            && !matches!(
                arg.as_str(),
                "--healthcheck"
                    | "--invite"
                    | "--create-admin"
                    | "--show"
                    | "--pending"
                    | "--provisioned"
                    | "--set-upstream"
            )
    }) {
        eprintln!("authd: unknown option {unknown}");
        eprintln!(
            "usage: authd [--healthcheck | --invite EMAIL | --create-admin EMAIL \
             | --show EMAIL | --pending | --provisioned | --set-upstream EMAIL HOST:PORT]"
        );
        std::process::exit(2);
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "authd=info,tower_http=info".into()),
        )
        .init();

    let cfg = Config::from_env();
    let store = match Store::connect(&cfg.db_path).await {
        Ok(store) => store,
        Err(error) => {
            eprintln!("[authd] cannot open {}: {error}", cfg.db_path);
            std::process::exit(1);
        }
    };
    let state = AppState {
        store,
        cfg,
        dummy_hash: hash_password("authd-timing-equalizer").expect("hash dummy"),
    };
    // The reconciler's path unit watches this directory. Create it so a drop
    // never fails and the host can install the unit before the first account.
    if let Err(error) = std::fs::create_dir_all(&state.cfg.provision_spool) {
        tracing::debug!(
            "cannot create provision spool {}: {error}",
            state.cfg.provision_spool
        );
    }

    // Operator tooling: `docker compose exec authd /app/authd --invite <email>`
    // (or --create-admin). Runs against the same database, prints one thing, exits.
    if let Some(email) = invite_for.as_deref() {
        match cli_invite(&state.cfg, &state.store, email).await {
            Ok(()) => std::process::exit(0),
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    if let Some(email) = admin_for.as_deref() {
        match cli_create_admin(&state.cfg, &state.store, email).await {
            Ok(()) => std::process::exit(0),
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    // `--pending` lists accounts that still need an instance and
    // `--provisioned` the ones that already have one, one email per line;
    // `--show` prints one account for the provisioner to read.
    if pending {
        match cli_pending(&state.store).await {
            Ok(emails) => {
                println!("{}", emails.join("\n"));
                std::process::exit(0);
            }
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    if provisioned {
        match cli_provisioned(&state.store).await {
            Ok(emails) => {
                println!("{}", emails.join("\n"));
                std::process::exit(0);
            }
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    if let Some(email) = show_for.as_deref() {
        match cli_show(&state.store, email).await {
            Ok(text) => {
                println!("{text}");
                std::process::exit(0);
            }
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    if let Some(email) = set_upstream_for.as_deref() {
        let upstream = set_upstream_value.as_deref().unwrap_or("");
        match cli_set_upstream(&state.store, email, upstream).await {
            Ok(()) => std::process::exit(0),
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }

    if let Err(error) = bootstrap_admin(&state).await {
        tracing::error!("bootstrap admin failed: {error}");
    }

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login", post(api_auth::login))
        .route("/api/auth/logout", post(api_auth::logout))
        .route("/api/auth/me", get(api_auth::me))
        .route("/api/auth/accept-invite", post(api_auth::accept_invite))
        .route("/api/auth/avatar/:id", get(api_auth::avatar))
        .route("/api/auth/me/avatar", put(api_auth::set_my_avatar))
        .route("/api/auth/verify", any(api_auth::verify))
        .route("/api/admin/users", get(api_admin::list_users).post(api_admin::create_user))
        .route(
            "/api/admin/users/:id",
            patch(api_admin::update_user).delete(api_admin::delete_user),
        )
        .route("/api/admin/users/:id/reset-password", post(api_admin::reset_password))
        .route(
            "/api/admin/users/:id/avatar",
            put(api_admin::set_avatar).delete(api_admin::clear_avatar),
        )
        // The SPA: every non-API path serves the app shell.
        .fallback_service(
            ServeDir::new(&state.cfg.web_dir)
                .fallback(ServeFile::new(format!("{}/index.html", state.cfg.web_dir))),
        )
        // Avatars are uploaded as raw image bytes; the handler enforces the real
        // cap, this only stops a body large enough to buffer before it looks.
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(&state.cfg.bind).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[authd] cannot bind {}: {error}", state.cfg.bind);
            std::process::exit(1);
        }
    };
    tracing::info!("authd listening on {}", state.cfg.bind);
    if let Err(error) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("[authd] server error: {error}");
        std::process::exit(1);
    }
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "authd", "cookie_secure": state.cfg.cookie_secure }))
}

/// Container healthcheck: exit 0 if the configured port is accepting. A plain
/// TCP connect keeps the runtime image free of curl/wget.
fn healthcheck() -> ! {
    let bind = std::env::var("AXTD_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let port = bind.rsplit(':').next().unwrap_or("8080");
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .expect("healthcheck address");
    let ok = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)).is_ok();
    std::process::exit(if ok { 0 } else { 1 });
}

/// Create the first admin from `AXTD_BOOTSTRAP_ADMIN_EMAIL` and print its
/// one-time invite link to the log. Runs whenever no admin can actually sign in
/// — no admin at all, or the bootstrap admin never accepted its invite — so a
/// lost or expired link is recovered by simply restarting.
async fn bootstrap_admin(state: &AppState) -> crate::error::AppResult<()> {
    let Some(email) = state.cfg.bootstrap_admin_email.as_deref() else {
        return Ok(());
    };
    let email = email.trim().to_lowercase();

    if state
        .store
        .list_users()
        .await?
        .iter()
        .any(|user| user.is_admin() && user.can_sign_in())
    {
        return Ok(());
    }

    let user = match state.store.user_by_email(&email).await? {
        Some(existing) => existing,
        // No name: the admin sets their own when they accept the invite.
        None => state
            .store
            .create_user(&email, "", "Admin", None)
            .await?,
    };
    if !user.is_admin() {
        state.store.set_role(user.id, "Admin").await?;
    }
    let token = state
        .store
        .create_invite(user.id, state.cfg.invite_ttl_secs)
        .await?;
    tracing::warn!(
        "bootstrap admin invite for {email}: /accept-invite?token={token} (accept it, then this line can be removed)"
    );
    Ok(())
}

/// `authd --invite <email>`: print a fresh invite link for an existing account.
async fn cli_invite(cfg: &Config, store: &Store, email: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let user = store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no account for {email}"))?;
    let token = store
        .create_invite(user.id, cfg.invite_ttl_secs)
        .await
        .map_err(|error| error.to_string())?;
    println!("/accept-invite?token={token}");
    Ok(())
}

/// `authd --show <email>`: one account as `key=value` lines, for the host-side
/// provisioner. Values have newlines stripped so the shell can read them
/// without a JSON parser.
async fn cli_show(store: &Store, email: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    let user = store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no account for {email}"))?;
    let line = |key: &str, value: &str| {
        format!("{key}={}", value.replace(&['\n', '\r'][..], " "))
    };
    Ok([
        line("id", &user.id.to_string()),
        line("email", &user.email),
        line("first_name", &user.first_name),
        line("role", &user.role),
        line("disabled", &user.disabled.to_string()),
        line(
            "avatar",
            if user.avatar_updated_at.is_some() { "1" } else { "0" },
        ),
        line("upstream", user.upstream.as_deref().unwrap_or("")),
        line(
            "has_password",
            if user.password_hash.is_some() { "1" } else { "0" },
        ),
    ]
    .join("\n"))
}

/// `authd --pending`: emails of enabled accounts that still need an instance.
async fn cli_pending(store: &Store) -> Result<Vec<String>, String> {
    let users = store.list_users().await.map_err(|error| error.to_string())?;
    Ok(users
        .into_iter()
        .filter(|user| user.disabled == 0 && user.upstream.as_deref().unwrap_or("").is_empty())
        .map(|user| user.email)
        .collect())
}

/// `authd --provisioned`: emails of enabled accounts that already have an
/// instance. The inverse of `--pending`, and what a host-side roll-out reads to
/// recreate exactly the accounts a rebuilt image has to reach.
async fn cli_provisioned(store: &Store) -> Result<Vec<String>, String> {
    let users = store.list_users().await.map_err(|error| error.to_string())?;
    Ok(users
        .into_iter()
        .filter(|user| {
            user.disabled == 0 && !user.upstream.as_deref().unwrap_or("").is_empty()
        })
        .map(|user| user.email)
        .collect())
}

/// `authd --set-upstream <email> <host:port>`: point an account at its instance
/// (an empty upstream clears it).
async fn cli_set_upstream(store: &Store, email: &str, upstream: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let user = store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no account for {email}"))?;
    let value = upstream.trim();
    let value = if value.is_empty() { None } else { Some(value) };
    store
        .set_upstream(user.id, value)
        .await
        .map_err(|error| error.to_string())?;
    println!("{} -> {}", user.email, value.unwrap_or("(cleared)"));
    Ok(())
}

/// `authd --create-admin <email>`: create (or promote) an admin and print a
/// fresh invite link for it.
async fn cli_create_admin(cfg: &Config, store: &Store, email: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let user = match store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
    {
        Some(existing) => existing,
        // No name: the admin sets their own when they accept the invite.
        None => store
            .create_user(&email, "", "Admin", None)
            .await
            .map_err(|error| error.to_string())?,
    };
    if !user.is_admin() {
        store
            .set_role(user.id, "Admin")
            .await
            .map_err(|error| error.to_string())?;
    }
    let token = store
        .create_invite(user.id, cfg.invite_ttl_secs)
        .await
        .map_err(|error| error.to_string())?;
    println!("/accept-invite?token={token}");
    Ok(())
}
