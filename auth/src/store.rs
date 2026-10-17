use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::crypto::sha256_hex;
use crate::error::{AppError, AppResult};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub first_name: String,
    pub timezone: Option<String>,
    /// Never serialized: the Argon2id hash stays inside the service.
    #[serde(skip_serializing)]
    pub password_hash: Option<String>,
    pub role: String,
    pub upstream: Option<String>,
    pub disabled: i64,
    /// When this account's profile photo last changed; NULL means it has none.
    /// Serves as the presence flag the bridge reads and the cache-buster in the
    /// avatar URL.
    pub avatar_updated_at: Option<i64>,
    /// When this account's upstream API key last changed; NULL means it has none.
    /// The key itself lives in `user_keys` and is never serialized. This doubles
    /// as the "has a key" flag the admin UI reads.
    pub api_key_updated_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "Admin"
    }
    /// A user can sign in only once an invite has been accepted (a password set)
    /// and the account is not disabled.
    pub fn can_sign_in(&self) -> bool {
        self.password_hash.is_some() && self.disabled == 0
    }
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn connect(path: &str) -> AppResult<Store> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))
            .map_err(|e| AppError::Internal(format!("db path: {e}")))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Store { pool })
    }

    // --- users -------------------------------------------------------------

    pub async fn create_user(
        &self,
        email: &str,
        first_name: &str,
        role: &str,
        upstream: Option<&str>,
    ) -> AppResult<User> {
        let ts = now();
        let id = sqlx::query(
            "INSERT INTO users (email, first_name, role, upstream, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        )
        .bind(email)
        .bind(first_name)
        .bind(role)
        .bind(upstream)
        .bind(ts)
        .execute(&self.pool)
        .await?
        .last_insert_rowid();
        self.user(id).await
    }

    pub async fn user(&self, id: i64) -> AppResult<User> {
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(AppError::NotFound)
    }

    pub async fn user_by_email(&self, email: &str) -> AppResult<Option<User>> {
        Ok(sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = ?1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn list_users(&self) -> AppResult<Vec<User>> {
        Ok(sqlx::query_as::<_, User>("SELECT * FROM users ORDER BY id")
            .fetch_all(&self.pool)
            .await?)
    }

    pub async fn set_first_name(&self, user_id: i64, first_name: &str) -> AppResult<()> {
        sqlx::query("UPDATE users SET first_name = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(first_name)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_password(&self, user_id: i64, hash: &str) -> AppResult<()> {
        sqlx::query("UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(hash)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_timezone(&self, user_id: i64, timezone: &str) -> AppResult<()> {
        sqlx::query("UPDATE users SET timezone = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(timezone)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_upstream(&self, user_id: i64, upstream: Option<&str>) -> AppResult<()> {
        sqlx::query("UPDATE users SET upstream = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(upstream)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_role(&self, user_id: i64, role: &str) -> AppResult<()> {
        sqlx::query("UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(role)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_disabled(&self, user_id: i64, disabled: bool) -> AppResult<()> {
        sqlx::query("UPDATE users SET disabled = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(user_id)
            .bind(if disabled { 1 } else { 0 })
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Deleting a user cascades to their sessions, invites and avatar.
    pub async fn delete_user(&self, user_id: i64) -> AppResult<()> {
        sqlx::query("DELETE FROM users WHERE id = ?1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- avatars -----------------------------------------------------------

    /// Store (or replace) a user's profile photo, stamping the change on the
    /// user row in the same transaction so the presence flag and the bytes never
    /// disagree.
    pub async fn set_avatar(
        &self,
        user_id: i64,
        content_type: &str,
        bytes: &[u8],
    ) -> AppResult<()> {
        let ts = now();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO avatars (user_id, content_type, bytes, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id) DO UPDATE SET content_type = ?2, bytes = ?3, updated_at = ?4",
        )
        .bind(user_id)
        .bind(content_type)
        .bind(bytes)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE users SET avatar_updated_at = ?2, updated_at = ?2 WHERE id = ?1")
            .bind(user_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn clear_avatar(&self, user_id: i64) -> AppResult<()> {
        let ts = now();
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM avatars WHERE user_id = ?1")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE users SET avatar_updated_at = NULL, updated_at = ?2 WHERE id = ?1")
            .bind(user_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn avatar(&self, user_id: i64) -> AppResult<Option<(String, Vec<u8>)>> {
        Ok(sqlx::query_as::<_, (String, Vec<u8>)>(
            "SELECT content_type, bytes FROM avatars WHERE user_id = ?1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?)
    }

    // --- upstream keys -----------------------------------------------------

    /// Store (or replace) the account's own upstream API key, stamping the change
    /// on the user row in the same transaction so the presence flag and the key
    /// never disagree. A `gateway_key` already set is left alone.
    pub async fn set_upstream_api_key(&self, user_id: i64, api_key: &str) -> AppResult<()> {
        let ts = now();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO user_keys (user_id, upstream_api_key, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET upstream_api_key = ?2, updated_at = ?3",
        )
        .bind(user_id)
        .bind(api_key)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE users SET api_key_updated_at = ?2, updated_at = ?2 WHERE id = ?1")
            .bind(user_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Forget the account's upstream key, so the gateway refuses its requests
    /// again until a new one is set. The `gateway_key` stays.
    pub async fn clear_upstream_api_key(&self, user_id: i64) -> AppResult<()> {
        let ts = now();
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE user_keys SET upstream_api_key = NULL, updated_at = ?2 WHERE user_id = ?1")
            .bind(user_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE users SET api_key_updated_at = NULL, updated_at = ?2 WHERE id = ?1")
            .bind(user_id)
            .bind(ts)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The account's gateway identity, creating it if it has none. The gateway
    /// key is opaque and long-lived: it is what the instance sends to the box
    /// gateway as `X-Api-Key`, and it never changes once set.
    pub async fn ensure_gateway_key(&self, user_id: i64) -> AppResult<String> {
        if let Some(existing) = self.gateway_key(user_id).await? {
            return Ok(existing);
        }
        let token = crate::crypto::random_token();
        sqlx::query(
            "INSERT INTO user_keys (user_id, gateway_key, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET gateway_key = COALESCE(user_keys.gateway_key, ?2), \
             updated_at = ?3",
        )
        .bind(user_id)
        .bind(&token)
        .bind(now())
        .execute(&self.pool)
        .await?;
        // Read back so a concurrent writer that won the insert is what the caller
        // gets, not a token this call generated and then discarded.
        Ok(self.gateway_key(user_id).await?.unwrap_or(token))
    }

    pub async fn gateway_key(&self, user_id: i64) -> AppResult<Option<String>> {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT gateway_key FROM user_keys WHERE user_id = ?1")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.and_then(|(key,)| key))
    }

    /// Resolve a gateway key to its account and that account's upstream API key.
    /// `None` is an unknown key; `Some((id, None))` is a known account that has
    /// not supplied a key yet (or is disabled), which the gateway must refuse.
    pub async fn resolve_gateway_key(
        &self,
        gateway_key: &str,
    ) -> AppResult<Option<(i64, Option<String>)>> {
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT user_keys.user_id, user_keys.upstream_api_key
             FROM user_keys JOIN users ON users.id = user_keys.user_id
             WHERE user_keys.gateway_key = ?1 AND users.disabled = 0",
        )
        .bind(gateway_key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // --- invites -----------------------------------------------------------

    /// Issue a one-time invite token, valid for `ttl_secs`. Returns the plaintext
    /// token — the only time it exists in the clear; only its hash is stored.
    pub async fn create_invite(&self, user_id: i64, ttl_secs: i64) -> AppResult<String> {
        let token = crate::crypto::random_token();
        let ts = now();
        // One live invite per user.
        sqlx::query("DELETE FROM invites WHERE user_id = ?1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        sqlx::query(
            "INSERT INTO invites (token_sha256, user_id, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(sha256_hex(&token))
        .bind(user_id)
        .bind(ts)
        .bind(ts + ttl_secs)
        .execute(&self.pool)
        .await?;
        Ok(token)
    }

    /// Consume an invite: returns the user id, marks it used. Errors if missing,
    /// expired or already used.
    pub async fn consume_invite(&self, token: &str) -> AppResult<i64> {
        let ts = now();
        let row: Option<(i64, i64, Option<i64>)> = sqlx::query_as(
            "SELECT user_id, expires_at, used_at FROM invites WHERE token_sha256 = ?1",
        )
        .bind(sha256_hex(token))
        .fetch_optional(&self.pool)
        .await?;
        let (user_id, expires_at, used_at) = row.ok_or(AppError::BadRequest("invite is not valid".into()))?;
        if used_at.is_some() {
            return Err(AppError::BadRequest("invite has already been used".into()));
        }
        if expires_at < ts {
            return Err(AppError::BadRequest("invite has expired".into()));
        }
        sqlx::query("UPDATE invites SET used_at = ?2 WHERE token_sha256 = ?1")
            .bind(sha256_hex(token))
            .bind(ts)
            .execute(&self.pool)
            .await?;
        Ok(user_id)
    }

    // --- sessions ----------------------------------------------------------

    pub async fn create_session(&self, user_id: i64, ttl_secs: i64) -> AppResult<String> {
        let token = crate::crypto::random_token();
        let ts = now();
        sqlx::query(
            "INSERT INTO sessions (token_sha256, user_id, created_at, last_seen_at, expires_at)
             VALUES (?1, ?2, ?3, ?3, ?4)",
        )
        .bind(sha256_hex(&token))
        .bind(user_id)
        .bind(ts)
        .bind(ts + ttl_secs)
        .execute(&self.pool)
        .await?;
        Ok(token)
    }

    /// Resolve a session token to its live user, touching `last_seen_at`. Expired
    /// rows are deleted on the way out.
    pub async fn session_user(&self, token: &str) -> AppResult<Option<User>> {
        let hash = sha256_hex(token);
        let ts = now();
        let row: Option<(i64, i64)> = sqlx::query_as(
            "SELECT sessions.user_id, sessions.expires_at
             FROM sessions JOIN users ON users.id = sessions.user_id
             WHERE sessions.token_sha256 = ?1 AND users.disabled = 0",
        )
        .bind(&hash)
        .fetch_optional(&self.pool)
        .await?;
        let Some((user_id, expires_at)) = row else {
            return Ok(None);
        };
        if expires_at < ts {
            sqlx::query("DELETE FROM sessions WHERE token_sha256 = ?1")
                .bind(&hash)
                .execute(&self.pool)
                .await?;
            return Ok(None);
        }
        sqlx::query("UPDATE sessions SET last_seen_at = ?2 WHERE token_sha256 = ?1")
            .bind(&hash)
            .bind(ts)
            .execute(&self.pool)
            .await?;
        Ok(Some(self.user(user_id).await?))
    }

    pub async fn delete_session(&self, token: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM sessions WHERE token_sha256 = ?1")
            .bind(sha256_hex(token))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_sessions_for_user(&self, user_id: i64) -> AppResult<()> {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- login throttle ----------------------------------------------------

    pub async fn banned_until(&self, bucket: &str) -> AppResult<Option<i64>> {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT banned_until FROM login_failures WHERE bucket = ?1")
                .bind(bucket)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0).filter(|until| *until > now()))
    }

    pub async fn record_failure(&self, bucket: &str, max: i64, base: i64) -> AppResult<()> {
        let ts = now();
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT count FROM login_failures WHERE bucket = ?1")
                .bind(bucket)
                .fetch_optional(&self.pool)
                .await?;
        let count = row.map(|r| r.0).unwrap_or(0) + 1;
        let over = count - max;
        let banned_until = if over > 0 {
            let shift = over.min(6) as u32;
            ts + base.saturating_mul(1 << shift)
        } else {
            0
        };
        sqlx::query(
            "INSERT INTO login_failures (bucket, count, banned_until, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(bucket) DO UPDATE SET count = ?2, banned_until = ?3, updated_at = ?4",
        )
        .bind(bucket)
        .bind(count)
        .bind(banned_until)
        .bind(ts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_failures(&self, bucket: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM login_failures WHERE bucket = ?1")
            .bind(bucket)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- deployment settings ------------------------------------------------

    /// Every stored setting as JSON text, keyed. A key with no row is unset, so
    /// an absent key is not an error here — the reader applies its own default.
    pub async fn settings(&self) -> AppResult<Vec<(String, String)>> {
        Ok(sqlx::query_as("SELECT key, value FROM settings ORDER BY key")
            .fetch_all(&self.pool)
            .await?)
    }

    pub async fn setting(&self, key: &str) -> AppResult<Option<String>> {
        let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(value,)| value))
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
        )
        .bind(key)
        .bind(value)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove a setting. The row's absence *is* the unset state, so clearing is a
    /// delete rather than a row holding `null`.
    pub async fn clear_setting(&self, key: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM settings WHERE key = ?1")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- routine fire tokens ----------------------------------------------

    /// Replace an account's token for one routine. One row per routine, so
    /// rotating a token revokes the previous one in the same step.
    pub async fn upsert_routine_token(
        &self,
        user_id: i64,
        routine_id: &str,
        token_sha256: &str,
    ) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM routine_tokens WHERE user_id = ?1 AND routine_id = ?2")
            .bind(user_id)
            .bind(routine_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO routine_tokens (token_sha256, user_id, routine_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(token_sha256)
        .bind(user_id)
        .bind(routine_id)
        .bind(now())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn revoke_routine_token(&self, user_id: i64, routine_id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM routine_tokens WHERE user_id = ?1 AND routine_id = ?2")
            .bind(user_id)
            .bind(routine_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The account and instance a fire token names. A disabled account resolves
    /// to nothing, the same as a signed-out session.
    pub async fn resolve_routine_token(
        &self,
        token_sha256: &str,
    ) -> AppResult<Option<(i64, Option<String>)>> {
        Ok(sqlx::query_as(
            "SELECT routine_tokens.user_id, users.upstream
             FROM routine_tokens
             JOIN users ON users.id = routine_tokens.user_id
             WHERE routine_tokens.token_sha256 = ?1 AND users.disabled = 0",
        )
        .bind(token_sha256)
        .fetch_optional(&self.pool)
        .await?)
    }
}
