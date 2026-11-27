-- What made each picture and clip (the exact prompt, pictures, service, settings), kept for 7
-- days. The record is stored as the app sends it (JSON text); expired rows go as new ones arrive.
CREATE TABLE generations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id  TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  node           TEXT NOT NULL,
  param          TEXT NOT NULL,
  data           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  expires_at     TEXT NOT NULL
);
CREATE INDEX generations_field_idx ON generations (production_id, node, param, created_at);
CREATE INDEX generations_expiry_idx ON generations (expires_at);
