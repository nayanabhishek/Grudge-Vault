import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CARD_CATALOG } from '../../../packages/game-engine/dist/index.js';
import { SqliteGameStore, createSqlitePool } from '../dist/sqlite-game-store.js';

async function fixture() {
  const pool = createSqlitePool(':memory:');
  const store = new SqliteGameStore(pool);
  const actor = randomUUID();
  const other = randomUUID();
  const roomId = randomUUID();
  const matchId = randomUUID();
  await store.createRoom({
    id: roomId, codeHash: 'a'.repeat(64), hostPlayerId: actor,
    expiresAt: new Date(Date.now() + 60_000),
    seat: { id: actor, displayName: 'Active', credentialHash: 'b'.repeat(64) },
  });
  await store.joinRoom('a'.repeat(64), { id: other, displayName: 'Other', credentialHash: 'c'.repeat(64) });
  await store.chooseMark(roomId, actor, 'ember');
  await store.chooseMark(roomId, other, 'tide');
  const started = await store.startMatch(roomId, actor, matchId, CARD_CATALOG.map(({ id }) => id));
  return { store, db: pool.db, actor, other, roomId, matchId, state: started.gameState };
}

test('SQLite transactions roll back rejected turns without persisting state or action keys', async () => {
  const { store, db, actor, other, roomId, matchId, state } = await fixture();
  try {
    await assert.rejects(store.takeCard(roomId, matchId, other, randomUUID(), state.vault[0]), (error) => error?.code === 'OUT_OF_TURN');
    const persisted = db.prepare('SELECT revision, state_json FROM matches WHERE id=?').get(matchId);
    assert.equal(persisted.revision, 0);
    assert.equal(JSON.parse(persisted.state_json).revision, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM processed_actions').get().n, 0);
    assert.deepEqual(JSON.parse(persisted.state_json).vault, state.vault);
  } finally { await store.close(); }
});

test('SQLite BEGIN IMMEDIATE serializes competing turns and retries are idempotent', async () => {
  const { store, db, actor, other, roomId, matchId, state } = await fixture();
  try {
    const requestId = randomUUID();
    const first = await store.takeCard(roomId, matchId, actor, requestId, state.vault[0]);
    const replay = await store.takeCard(roomId, matchId, actor, requestId, state.vault[0]);
    assert.equal(first.actionRevision, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.actionRevision, 1);

    const current = first.gameState.currentPlayerId;
    assert.equal(current, other);
    const choices = first.gameState.vault.slice(0, 2);
    const outcomes = await Promise.allSettled([
      store.takeCard(roomId, matchId, other, randomUUID(), choices[0]),
      store.takeCard(roomId, matchId, other, randomUUID(), choices[1]),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((result) => result.status === 'rejected' && result.reason?.code === 'OUT_OF_TURN').length, 1);
    assert.equal(db.prepare('SELECT revision FROM matches WHERE id=?').get(matchId).revision, 2);
  } finally { await store.close(); }
});
