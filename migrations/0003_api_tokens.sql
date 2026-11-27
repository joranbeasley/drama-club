-- Personal API tokens, for agents and scripts: `Authorization: Bearer dc_…`. Only the SHA-256 is
-- stored; the token is shown once, when it is made. A token acts as its owner, on productions only.
CREATE TABLE api_tokens (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  last_used_at TEXT
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
