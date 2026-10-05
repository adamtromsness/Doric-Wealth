-- Server-wide settings that aren't book data (no book_id, no row-level security),
-- e.g. 'secret_key_check': a known value encrypted with APP_SECRET_KEY, so a restore
-- drill (and each boot) can prove the key in hand decrypts this database's secrets
-- even when no one has stored a credential yet. Additive and idempotent.
CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
