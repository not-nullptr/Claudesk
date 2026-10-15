-- Deployment-wide settings an admin edits in the web UI.
--
-- These are not per-account preferences: they describe the deployment, so they
-- live in one key/value table rather than on a user row. Each account's Desktop
-- instance reads the ones it cares about from authd (see `/api/auth/deployment`
-- and the bridge's model-picker rewrite), which is why the values are stored as
-- JSON text: the reader is another service, and the shape belongs to that
-- setting rather than to this table. A missing row means "unset", which every
-- reader must treat as its own default (for the model picker: no rewrite).

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    -- JSON-encoded value. Stored as text so a new setting needs no migration.
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
