-- Invite-only registration. A signup invite lets a new person create an account with
-- their own books; it's separate from book invites (the invites table), which add
-- someone to an existing book. Single-use, optionally locked to one email address.
-- Only a SHA-256 hash of the code is stored. Not tenant data, so there's no book_id
-- or row-level security (like users and sessions).
CREATE TABLE IF NOT EXISTS signup_invites (
  id          SERIAL PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  email       TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  used_at     TIMESTAMPTZ,
  used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
