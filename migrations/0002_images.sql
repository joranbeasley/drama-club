-- Pictures live in R2, named by their content's SHA-256, so each is stored once however many
-- productions (or people) use it. This table says who may see each one: whoever uploaded it.
CREATE TABLE image_owners (
  key         TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  PRIMARY KEY (key, user_id)
);
CREATE INDEX image_owners_user_idx ON image_owners (user_id);
