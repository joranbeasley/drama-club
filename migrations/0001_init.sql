-- D1 (SQLite). Users sign in with Google; `google_sub` is Google's stable account id.
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  picture     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  last_login  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

-- The session cookie holds a random token; only its SHA-256 (hex) is stored.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- A production is one Drama boards map. Its JSON (pictures included) can be many MB, more
-- than D1 allows in one value, so it lives in `production_chunks`. Each save writes a new
-- generation of chunks and flips `gen` in the same transaction as the version check.
CREATE TABLE productions (
  id          TEXT PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  gen         TEXT NOT NULL,
  node_count  INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);
CREATE INDEX productions_owner_idx ON productions (owner_id, updated_at DESC);

CREATE TABLE production_chunks (
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  gen            TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  data           TEXT NOT NULL,
  PRIMARY KEY (production_id, gen, seq)
);
