-- Finished video clips, copied into R2 from the service that made them (its links expire).
-- The key is random (clips aren't hashed: hashing a video costs too much CPU on Workers).
CREATE TABLE clips (
  key         TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes       INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);
CREATE INDEX clips_user_idx ON clips (user_id);
CREATE INDEX clips_source_idx ON clips (user_id, source);
