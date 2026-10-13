-- Eva Mode account model. Timestamps are unix seconds (INTEGER) so nothing
-- depends on a date/time crate or a sqlx time feature.

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    first_name    TEXT    NOT NULL,
    timezone      TEXT,
    -- NULL until the invite is accepted: there is no password for the admin to
    -- set or see.
    password_hash TEXT,
    role          TEXT    NOT NULL CHECK (role IN ('User','Admin')),
    -- host:port of this user's Claude Desktop instance, as Caddy should reach it.
    upstream      TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_sha256 TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    token_sha256 TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    used_at      INTEGER
);

-- Per-client-address login throttle, mirroring the mobile service's lockout.
CREATE TABLE IF NOT EXISTS login_failures (
    bucket       TEXT    PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    banned_until INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS invites_user  ON invites(user_id);
