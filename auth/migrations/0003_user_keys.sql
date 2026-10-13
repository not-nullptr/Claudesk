-- Per-account upstream credentials (Eva Mode). Like `avatars`, the secrets live
-- in their own table so the `SELECT *` every user query runs never drags a key;
-- the users row carries only when the upstream key last changed, which doubles as
-- the presence flag the admin UI reads. NULL api_key_updated_at means "no key
-- set". A `gateway_key` is the opaque token an account's instance presents to the
-- box gateway, which authd resolves to that account's own `upstream_api_key`.

ALTER TABLE users ADD COLUMN api_key_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS user_keys (
    user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- The real key this account's requests go upstream with. NULL on an account
    -- that has not supplied one yet (the invite asks for it).
    upstream_api_key TEXT,
    -- Opaque identity the instance sends as X-Api-Key to the gateway. Unique so a
    -- lookup resolves to exactly one account.
    gateway_key      TEXT UNIQUE,
    updated_at       INTEGER NOT NULL
);
