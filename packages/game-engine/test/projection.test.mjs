import assert from 'node:assert/strict';
import test from 'node:test';
import { CARD_CATALOG, createInitialState, projectForPlayer } from '../dist/index.js';

test('player projection exposes only their own Mark, hand, and never the future deck', () => {
  const order = CARD_CATALOG.map(({ id }) => id);
  const state = createInitialState({ matchId: 'match', players: [
    { id: 'a', displayName: 'A', mark: 'ember' }, { id: 'b', displayName: 'B', mark: 'void' },
  ], shuffledDeck: order });
  const view = projectForPlayer(state, 'a');
  assert.deepEqual(view.you, { playerId: 'a', mark: 'ember' });
  assert.equal(JSON.stringify(view).includes('void'), false);
  assert.equal('deck' in view, false);
  assert.equal(view.vault.length, 5);
  assert.deepEqual(view.players.map(({ mark }) => mark), [null, null]);
  assert.equal(JSON.stringify(view).includes(state.deck[0]), false);
});

test('projection rejects a player outside the match', () => {
  const state = createInitialState({ matchId: 'match', players: [
    { id: 'a', displayName: 'A', mark: 'ember' }, { id: 'b', displayName: 'B', mark: 'void' },
  ], shuffledDeck: CARD_CATALOG.map(({ id }) => id) });
  assert.throws(() => projectForPlayer(state, 'intruder'), /not in this match/);
});
