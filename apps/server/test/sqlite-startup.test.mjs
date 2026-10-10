import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GameService } from '../dist/game.service.js';
import { SqliteGameStore, createSqlitePool, resolveSqlitePath } from '../dist/sqlite-game-store.js';

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'grudge-vault-sqlite-startup-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('fresh SQLite file is migrated and ready before GameService startup recovery', async () => {
  await withTempDir(async (directory) => {
    const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    assert.equal(resolveSqlitePath('./data/grudge-vault.sqlite'), join(serverRoot, 'data', 'grudge-vault.sqlite'));
    const databasePath = join(directory, 'fresh.sqlite');
    const pool = createSqlitePool(databasePath);
    const store = new SqliteGameStore(pool);
    try {
      const tableNames = new Set(pool.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => name));
      for (const table of ['schema_migrations', 'rooms', 'room_seats', 'matches', 'processed_actions', 'match_events']) assert.ok(tableNames.has(table), `${table} exists`);
      const indexes = new Set(pool.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(({ name }) => name));
      assert.ok(indexes.has('rooms_expiry_idx'));
      assert.ok(indexes.has('matches_pause_deadline_idx'));
      const seatIndexes = pool.db.pragma("index_list('room_seats')");
      const uniqueSeatKeys = seatIndexes.filter(({ unique }) => unique === 1)
        .map(({ name }) => pool.db.pragma(`index_info('${name}')`).map(({ name: column }) => column).join(','));
      assert.ok(uniqueSeatKeys.includes('room_id,seat_no'));
      assert.ok(uniqueSeatKeys.includes('room_id,id'));
      const foreignKeys = (table) => pool.db.pragma(`foreign_key_list('${table}')`);
      assert.ok(foreignKeys('rooms').some(({ table, from, to }) => table === 'room_seats' && from === 'host_player_id' && to === 'id'));
      assert.ok(foreignKeys('room_seats').some(({ table, from, to }) => table === 'rooms' && from === 'room_id' && to === 'id'));
      assert.ok(foreignKeys('matches').some(({ table, from, to }) => table === 'rooms' && from === 'room_id' && to === 'id'));
      assert.ok(foreignKeys('processed_actions').some(({ table, from, to }) => table === 'room_seats' && from === 'player_id' && to === 'id'));
      assert.ok(foreignKeys('match_events').some(({ table, from, to }) => table === 'matches' && from === 'match_id' && to === 'id'));
      const seatSchema = pool.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_seats'").get().sql;
      assert.match(seatSchema, /CHECK \(seat_no BETWEEN 1 AND 4\)/u);
      assert.match(seatSchema, /UNIQUE\(room_id, seat_no\)/u);
      assert.deepEqual(pool.db.prepare('SELECT id FROM schema_migrations').all().map(({ id }) => id), ['001_initial']);
      assert.equal(pool.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(pool.db.pragma('foreign_key_check'), []);
      await store.onModuleInit();
      const service = new GameService(store);
      await service.onModuleInit();
      service.onModuleDestroy();
    } finally { await store.close(); }
  });
});

test('already migrated SQLite file opens without resetting persisted room data', async () => {
  await withTempDir(async (directory) => {
    const databasePath = join(directory, 'existing.sqlite');
    const roomId = randomUUID();
    const playerId = randomUUID();
    let pool = createSqlitePool(databasePath);
    let store = new SqliteGameStore(pool);
    await store.createRoom({
      id: roomId,
      codeHash: 'a'.repeat(64),
      hostPlayerId: playerId,
      expiresAt: new Date(Date.now() + 60_000),
      seat: { id: playerId, displayName: 'Persisted host', credentialHash: 'b'.repeat(64) },
    });
    await store.close();

    pool = createSqlitePool(databasePath);
    store = new SqliteGameStore(pool);
    try {
      assert.equal((await store.getRoomView(roomId)).players[0].displayName, 'Persisted host');
      assert.equal(pool.db.prepare('SELECT count(*) AS n FROM room_seats').get().n, 1);
      await store.onModuleInit();
      const service = new GameService(store);
      await service.onModuleInit();
      service.onModuleDestroy();
    } finally { await store.close(); }
  });
});

test('failed migration aborts SQLite pool creation with database and migration context', async () => {
  await withTempDir(async (directory) => {
    const databasePath = join(directory, 'broken.sqlite');
    const migrationsPath = join(directory, 'migrations');
    await mkdir(migrationsPath);
    await writeFile(join(migrationsPath, '001_broken.sql'), 'CREATE TABL room_seats (id TEXT);');

    assert.throws(() => createSqlitePool(databasePath, migrationsPath), (error) => {
      assert.match(error.message, /SQLite migration "001_broken" failed/u);
      assert.match(error.message, new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
      assert.match(error.message, /syntax error/u);
      return true;
    });

    // A failed transactional migration leaves the existing file in place and does not record success.
    const Sqlite = (await import('better-sqlite3')).default;
    const db = new Sqlite(databasePath);
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='room_seats'").get().n, 0);
    } finally { db.close(); }
  });
});
