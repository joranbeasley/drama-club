-- Users sign in with Google. `google_sub` is Google's stable account id; email can change.
CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  google_sub  text UNIQUE,
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  picture     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

-- Server-side sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- A production is one Drama boards map (mobile-nodemap GraphJSON, type "drama2").
-- `version` goes up on every save so two open tabs can't silently overwrite each other.
CREATE TABLE productions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  graph       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX productions_owner_idx ON productions (owner_id, updated_at DESC);
