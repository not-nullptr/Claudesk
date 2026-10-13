-- Per-account profile photo (Eva Mode). The bytes live in their own table so the
-- `SELECT *` every user query runs never drags a photo; the users row carries
-- only when the photo last changed, which doubles as a presence flag and the
-- cache-buster in the avatar URL. NULL avatar_updated_at means "no photo".

ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;

CREATE TABLE IF NOT EXISTS avatars (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    bytes        BLOB NOT NULL,
    updated_at   INTEGER NOT NULL
);
