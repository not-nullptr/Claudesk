//! authd — first-class authentication and account service for Claudesk.
//!
//! It owns users, sessions and invites, serves the login/admin SPA, and answers
//! Caddy's `forward_auth` (`/api/auth/verify`), returning the caller's instance
//! upstream so the reverse proxy can route them to their own Claude Desktop.
//! It never touches a container runtime.

mod api_admin;
mod api_auth;
mod api_gateway;
mod api_routines;
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
use crate::store::{Store, User};

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
    /// Directory the deleting side's systemd `.path` unit watches. Unlike the
    /// provision spool, a request here must carry its payload: by the time the
    /// host reads it the account row is already gone, so it can no longer be
    /// re-derived from the database. The file holds the account's email/id/upstream.
    pub deprovision_spool: String,
    /// Directory the VM-apply reconciler watches. An admin's Apply drops the
    /// account's email here; the host re-runs `provision-user.sh`, which reads
    /// the desired specs back out of this database and recreates the instance.
    pub vm_apply_spool: String,
    /// Shared secret the box gateway presents to `/internal/gateway/resolve`.
    /// Unset disables that route (404), so authd is inert until an operator opts in.
    pub gateway_secret: Option<String>,
    /// Shared secret for server-side instance actions (the VM restart/status
    /// proxy). Unset disables those routes, so an older deployment is inert.
    pub internal_secret: Option<String>,
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
            deprovision_spool: env("AXTD_DEPROVISION_SPOOL")
                .unwrap_or_else(|| "/data/deprovision-requests".into()),
            vm_apply_spool: env("AXTD_VM_APPLY_SPOOL")
                .unwrap_or_else(|| "/data/vm-apply-requests".into()),
            gateway_secret: env("AXTD_GATEWAY_SECRET"),
            internal_secret: env("AXTD_INTERNAL_SECRET"),
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

    /// Ask the host's reconciler to tear this account's instance down: drop a
    /// request file in the spool its systemd `.path` unit watches. Unlike
    /// `nudge_provision`, the file must carry the account — the row is deleted
    /// moments later, so the host can no longer re-read it from the database.
    /// Best-effort for the caller's response, but a lost write leaks the
    /// account's container and disk, so it is logged at warn.
    pub fn nudge_deprovision(&self, user: &User) {
        let path = std::path::Path::new(&self.cfg.deprovision_spool).join(user.id.to_string());
        let payload = deprovision_payload(&user.email, user.id, user.upstream.as_deref());
        if let Err(error) = std::fs::write(&path, payload) {
            tracing::warn!("deprovision nudge for user {} failed: {error}", user.id);
        }
    }

    /// Ask the host's VM-apply reconciler to recreate this account's instance
    /// with the specs saved on its row. The payload names the account because
    /// an Apply is a request for exactly one instance, not a sweep.
    pub fn nudge_vm_apply(&self, user: &User) {
        let path = std::path::Path::new(&self.cfg.vm_apply_spool).join(user.id.to_string());
        let payload = vm_apply_payload(&user.email);
        if let Err(error) = std::fs::write(&path, payload) {
            tracing::warn!("vm-apply nudge for user {} failed: {error}", user.id);
        }
    }
}

/// The line-oriented payload a VM-apply request carries. Free function so the
/// wire format is pinned by a test, like `deprovision_payload`.
fn vm_apply_payload(email: &str) -> String {
    format!("email={email}\n")
}

/// The line-oriented payload a deprovision request carries. The account is gone
/// from the database by the time the host reads it, so the file itself is the
/// record: scripts/converge-deprovisions.sh parses `email=` back out of it. Kept
/// as a free function so the wire format is pinned by a test.
fn deprovision_payload(email: &str, id: i64, upstream: Option<&str>) -> String {
    format!("email={email}\nid={id}\nupstream={}\n", upstream.unwrap_or(""))
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
    let set_vm_applied_for = flag("--set-vm-applied");
    let set_vm_applied_values = args
        .iter()
        .position(|arg| arg == "--set-vm-applied")
        .map(|index| (args.get(index + 2).cloned(), args.get(index + 3).cloned()));
    let set_internal_upstream_for = flag("--set-internal-upstream");
    let set_internal_upstream_value = args
        .iter()
        .position(|arg| arg == "--set-internal-upstream")
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
                    | "--set-vm-applied"
                    | "--set-internal-upstream"
            )
    }) {
        eprintln!("authd: unknown option {unknown}");
        eprintln!(
            "usage: authd [--healthcheck | --invite EMAIL | --create-admin EMAIL \
             | --show EMAIL | --pending | --provisioned | --set-upstream EMAIL HOST:PORT \
             | --set-vm-applied EMAIL MEMORY_GB CPU_COUNT \
             | --set-internal-upstream EMAIL HOST:PORT]"
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
    // The deprovision spool, watched by its own `.path` unit. Create it up front
    // for the same reason — but a drop here is not merely a late provision, it is
    // a leaked container and data root, so a failure is worth a warning.
    if let Err(error) = std::fs::create_dir_all(&state.cfg.deprovision_spool) {
        tracing::warn!(
            "cannot create deprovision spool {}: {error}",
            state.cfg.deprovision_spool
        );
    }
    // The VM-apply spool, watched by its own `.path` unit. A missing directory
    // turns an admin's Apply into a silent no-op, so say so.
    if let Err(error) = std::fs::create_dir_all(&state.cfg.vm_apply_spool) {
        tracing::warn!(
            "cannot create VM-apply spool {}: {error}",
            state.cfg.vm_apply_spool
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
    if let Some(email) = set_vm_applied_for.as_deref() {
        let (memory, cpu) = match set_vm_applied_values {
            Some((Some(memory), Some(cpu))) => (memory, cpu),
            _ => {
                eprintln!("authd: --set-vm-applied needs EMAIL MEMORY_GB CPU_COUNT");
                std::process::exit(2);
            }
        };
        match cli_set_vm_applied(&state.store, email, &memory, &cpu).await {
            Ok(()) => std::process::exit(0),
            Err(message) => {
                eprintln!("authd: {message}");
                std::process::exit(1);
            }
        }
    }
    if let Some(email) = set_internal_upstream_for.as_deref() {
        let upstream = set_internal_upstream_value.as_deref().unwrap_or("");
        match cli_set_internal_upstream(&state.store, email, upstream).await {
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

    // Say whether per-user key resolution is on, so a deployment that meant to
    // enable it (and forgot the secret) is visible in the log rather than only as
    // every request falling back at the gateway. Only on the serving path: the
    // CLI subcommands above print their result to stdout, and the provisioner
    // reads that output directly, so a log line there would be read as data.
    if state.cfg.gateway_secret.is_some() {
        tracing::info!("gateway key resolution enabled at /internal/gateway/resolve");
    } else {
        tracing::info!("gateway key resolution disabled (set AXTD_GATEWAY_SECRET to enable it)");
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
        // The fire path's own forward_auth target: bearer-only, no cookie. The
        // reverse proxy must be pointed at it for the routine fire route (see
        // docs/routines.md); the ordinary verify stays cookie-only.
        .route("/api/auth/verify-routine", any(api_routines::verify))
        // Internal, reached only from an instance on the deployment network.
        // The proxy never forwards `/internal/*`; the session cookie on the
        // call is what names the account.
        .route(
            "/internal/routine-tokens",
            post(api_routines::register),
        )
        .route(
            "/internal/routine-tokens/revoke",
            post(api_routines::revoke),
        )
        // Read by an account's instance (no session), so it sits under /api/auth/
        // where the proxy routes to authd; it answers one key. See api_auth.rs.
        .route("/api/auth/deployment", get(api_auth::deployment))
        // Internal: the box gateway resolves an account's opaque gateway key to
        // that account's own upstream key. Deliberately outside `/api/*` so the
        // public reverse-proxy matcher never forwards it; secret-gated and inert
        // (404) with no secret configured. See api_gateway.rs.
        .route(
            "/internal/gateway/resolve",
            post(api_gateway::resolve_gateway_key),
        )
        .route("/api/admin/users", get(api_admin::list_users).post(api_admin::create_user))
        .route(
            "/api/admin/settings",
            get(api_admin::get_settings).put(api_admin::update_settings),
        )
        .route(
            "/api/admin/users/:id",
            patch(api_admin::update_user).delete(api_admin::delete_user),
        )
        .route("/api/admin/users/:id/reset-password", post(api_admin::reset_password))
        .route(
            "/api/admin/users/:id/avatar",
            put(api_admin::set_avatar).delete(api_admin::clear_avatar),
        )
        // Per-account Cowork VM sizing and control. An Apply is a request to
        // the host reconciler (authd never touches a container runtime); the
        // restart and status actions proxy to the instance's bridge.
        .route("/api/admin/users/:id/vm", put(api_admin::update_user_vm))
        .route("/api/admin/users/:id/vm/apply", post(api_admin::apply_user_vm))
        .route("/api/admin/users/:id/vm/restart", post(api_admin::restart_user_vm))
        .route("/api/admin/users/:id/vm/status", get(api_admin::user_vm_status))
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
    // The gateway key is created here, on first read, so an account provisioned
    // before this existed gets one the next time the reconciler runs it.
    let gateway_key = store
        .ensure_gateway_key(user.id)
        .await
        .map_err(|error| error.to_string())?;
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
        // Empty means "inherit the deployment's .env" for the VM sizing; the
        // provisioner reads these into the account's compose environment.
        line(
            "vm_memory_gb",
            &user.vm_memory_gb.map(|value| value.to_string()).unwrap_or_default(),
        ),
        line(
            "vm_cpu_count",
            &user.vm_cpu_count.map(|value| value.to_string()).unwrap_or_default(),
        ),
        line(
            "internal_upstream",
            user.internal_upstream.as_deref().unwrap_or(""),
        ),
        line("gateway_key", &gateway_key),
        line(
            "has_password",
            if user.password_hash.is_some() { "1" } else { "0" },
        ),
        line(
            "has_api_key",
            if user.api_key_updated_at.is_some() { "1" } else { "0" },
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

/// `authd --set-vm-applied <email> <memory_gb> <cpu_count>`: record the sizing
/// the host reconciler actually wrote into the account's instance. The
/// dashboard shows this beside the desired spec, so a saved-but-not-applied
/// change is visible instead of looking live.
async fn cli_set_vm_applied(
    store: &Store,
    email: &str,
    memory: &str,
    cpu: &str,
) -> Result<(), String> {
    let memory: i64 = memory
        .trim()
        .parse()
        .map_err(|_| "memory_gb must be an integer".to_string())?;
    let cpu: i64 = cpu
        .trim()
        .parse()
        .map_err(|_| "cpu_count must be an integer".to_string())?;
    if !(1..=16).contains(&memory) {
        return Err("memory_gb must be between 1 and 16".into());
    }
    if !(1..=8).contains(&cpu) {
        return Err("cpu_count must be between 1 and 8".into());
    }
    let email = email.trim().to_lowercase();
    let user = store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no account for {email}"))?;
    store
        .set_vm_applied(user.id, memory, cpu)
        .await
        .map_err(|error| error.to_string())?;
    println!("{} -> {}GB / {} vCPU", user.email, memory, cpu);
    Ok(())
}

/// `authd --set-internal-upstream <email> <host:port>`: the instance's
/// `gateway_net` alias, which server-side admin actions reach. The loopback
/// `upstream` remains the reverse proxy's address; an empty value clears this.
async fn cli_set_internal_upstream(
    store: &Store,
    email: &str,
    upstream: &str,
) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let user = store
        .user_by_email(&email)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("no account for {email}"))?;
    let value = upstream.trim();
    let value = if value.is_empty() { None } else { Some(value) };
    store
        .set_internal_upstream(user.id, value)
        .await
        .map_err(|error| error.to_string())?;
    println!("{} internal -> {}", user.email, value.unwrap_or("(cleared)"));
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

#[cfg(test)]
mod tests {
    use super::{deprovision_payload, vm_apply_payload};

    #[test]
    fn vm_apply_payload_names_the_account() {
        // scripts/converge-vm-applies.sh reads `email=` back out of the file.
        assert_eq!(
            vm_apply_payload("ada@example.com"),
            "email=ada@example.com\n"
        );
    }

    #[test]
    fn deprovision_payload_carries_email_id_and_upstream() {
        assert_eq!(
            deprovision_payload("ada@example.com", 7, Some("127.0.0.1:15908")),
            "email=ada@example.com\nid=7\nupstream=127.0.0.1:15908\n"
        );
        // An account that was deleted before its instance existed still
        // deprovisions cleanly, with an empty upstream.
        assert_eq!(
            deprovision_payload("ada@example.com", 7, None),
            "email=ada@example.com\nid=7\nupstream=\n"
        );
    }
}
