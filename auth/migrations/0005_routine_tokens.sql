-- Per-routine fire tokens. The instance mints the token and stores its hash;
-- authd keeps the same hash so Caddy's forward_auth can resolve a cookie-less
-- fire request to the account's instance. Only the hash is stored anywhere.
--
-- One token per routine: rotating a token replaces the row, and revoking deletes
-- it. `routine_id` is the instance's opaque `trig_…` id.
CREATE TABLE IF NOT EXISTS routine_tokens (
    token_sha256 TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    routine_id   TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS routine_tokens_routine ON routine_tokens(user_id, routine_id);
