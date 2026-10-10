import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const requiredColumns = {
  rooms: ['id', 'code_hash', 'host_player_id', 'status', 'created_at', 'expires_at'],
  room_seats: ['id', 'room_id', 'seat_no', 'display_name', 'mark', 'credential_hash', 'connected', 'connected_at'],
  matches: ['id', 'room_id', 'status', 'revision', 'current_player_id', 'state_json', 'result_json', 'pause_deadline'],
  processed_actions: ['match_id', 'room_id', 'player_id', 'request_id', 'payload_hash', 'response_revision'],
  match_events: ['match_id', 'revision', 'actor_player_id', 'request_id', 'event_type', 'public_payload'],
};
const requiredIndexes = ['rooms_expiry_idx', 'matches_pause_deadline_idx'];

function validateSchema(db, databasePath) {
  for (const [table, required] of Object.entries(requiredColumns)) {
    const present = new Set(db.pragma(`table_info(${table})`).map(({ name }) => name));
    const missing = required.filter((column) => !present.has(column));
    if (missing.length) throw new Error(`Table ${table} is missing required columns: ${missing.join(', ')}.`);
  }

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => name));
  if (!tables.has('schema_migrations')) throw new Error('Migration registry table schema_migrations is missing.');
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(({ name }) => name));
  const missingIndexes = requiredIndexes.filter((name) => !indexes.has(name));
  if (missingIndexes.length) throw new Error(`Required indexes are missing: ${missingIndexes.join(', ')}.`);
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error(`Foreign-key validation found ${violations.length} violation(s).`);
  const appliedIds = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(({ id }) => id);
  return appliedIds;
}

export function applySqliteMigrations(db, migrationsDirectory, databasePath) {
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .sort((left, right) => Number(left.split('_', 1)[0]) - Number(right.split('_', 1)[0]));

  if (!migrationFiles.length) {
    throw new Error(`No numbered SQL migrations found in ${resolve(migrationsDirectory)}.`);
  }

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');

  for (const filename of migrationFiles) {
    const migrationId = filename.slice(0, -4);
    try {
      const migrationSql = readFileSync(join(migrationsDirectory, filename), 'utf8');
      const apply = db.transaction(() => {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(migrationId)) return false;
        db.exec(migrationSql);
        db.prepare('INSERT INTO schema_migrations(id) VALUES(?)').run(migrationId);
        return true;
      });
      apply.immediate();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`SQLite migration "${migrationId}" failed for database "${databasePath}": ${detail}`, { cause });
    }
  }

  try {
    return validateSchema(db, databasePath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`SQLite schema validation failed for database "${databasePath}": ${detail}`, { cause });
  }
}
