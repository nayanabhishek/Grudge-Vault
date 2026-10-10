PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  host_player_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'paused', 'complete', 'abandoned')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  FOREIGN KEY (host_player_id) REFERENCES room_seats(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS room_seats (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL CHECK (seat_no BETWEEN 1 AND 4),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 24),
  mark TEXT CHECK (mark IN ('ember', 'tide', 'thorn', 'void')),
  credential_hash TEXT NOT NULL UNIQUE CHECK (length(credential_hash) = 64),
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1)),
  connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_id, seat_no),
  UNIQUE(room_id, id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'abandoned')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  current_player_id TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  pause_deadline TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  UNIQUE(id, room_id),
  FOREIGN KEY (room_id, current_player_id) REFERENCES room_seats(room_id, id)
);

CREATE TABLE IF NOT EXISTS processed_actions (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  response_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, player_id, request_id),
  FOREIGN KEY (match_id, room_id) REFERENCES matches(id, room_id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, player_id) REFERENCES room_seats(room_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  actor_player_id TEXT,
  request_id TEXT,
  event_type TEXT NOT NULL,
  public_payload TEXT NOT NULL CHECK (json_valid(public_payload)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, revision)
);

CREATE INDEX IF NOT EXISTS rooms_expiry_idx ON rooms(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS matches_pause_deadline_idx ON matches(pause_deadline) WHERE pause_deadline IS NOT NULL;
