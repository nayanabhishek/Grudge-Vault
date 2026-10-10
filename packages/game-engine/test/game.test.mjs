import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_CATALOG, abandonMatch, applyAction, calculatePlayerScore, calculateScores,
  createInitialState, getGameResult, isGameComplete, pauseMatch, projectForPlayer,
  resumeMatch, scoreFaction, validateAction,
} from '../dist/index.js';

const players = [
  { id: 'p1', displayName: 'One', mark: 'ember' },
  { id: 'p2', displayName: 'Two', mark: 'ember' },
];
const deck = CARD_CATALOG.map(({ id }) => id);
const fresh = (options = {}) => createInitialState({ matchId: 'test-match', players, shuffledDeck: deck, ...options });
const take = (state, cardId, recipientPlayerId) => applyAction(state, {
  type: 'take_card', playerId: state.currentPlayerId, cardId,
  ...(recipientPlayerId === undefined ? {} : { recipientPlayerId }),
});

test('catalog has exactly 24 unique cards with the named faction and Hex sets', () => {
  assert.equal(CARD_CATALOG.length, 24);
  assert.equal(new Set(CARD_CATALOG.map(({ id }) => id)).size, 24);
  assert.equal(CARD_CATALOG.filter(({ type }) => type === 'relic').length, 20);
  assert.equal(CARD_CATALOG.filter(({ type }) => type === 'hex').length, 4);
});

test('initial state has five Vault cards, nineteen draw cards, empty collections and a deterministic deck order', () => {
  const state = fresh();
  assert.deepEqual(state.vault, deck.slice(0, 5));
  assert.deepEqual(state.deck, deck.slice(5));
  assert.equal(state.players.every(({ heldRelicIds, heldHexIds }) => !heldRelicIds.length && !heldHexIds.length), true);
  assert.deepEqual(state.turnOrder, ['p1', 'p2']);
  assert.equal(state.currentPlayerId, 'p1');
});

test('randomness is injectable and produces repeatable valid shuffled decks', () => {
  const a = createInitialState({ matchId: 'a', players, random: () => 0.25 });
  const b = createInitialState({ matchId: 'b', players, random: () => 0.25 });
  assert.deepEqual([...a.vault, ...a.deck], [...b.vault, ...b.deck]);
  assert.equal(new Set([...a.vault, ...a.deck]).size, 24);
});

test('duplicate Marks are allowed', () => {
  assert.deepEqual(fresh().players.map(({ mark }) => mark), ['ember', 'ember']);
});

test('only the active player can act and an absent Vault card is rejected', () => {
  const state = fresh();
  assert.equal(validateAction(state, { type: 'take_card', playerId: 'p2', cardId: state.vault[0] }).valid, false);
  assert.equal(validateAction(state, { type: 'take_card', playerId: 'p1', cardId: 'void-maw' }).valid, false);
});

test('invalid Hex recipients, missing recipients and self-targeting are rejected', () => {
  const state = fresh({ shuffledDeck: ['hex-rot', ...deck.filter((id) => id !== 'hex-rot')] });
  for (const recipientPlayerId of [undefined, 'p1', 'not-a-player']) {
    const result = applyAction(state, { type: 'take_card', playerId: 'p1', cardId: 'hex-rot', ...(recipientPlayerId ? { recipientPlayerId } : {}) });
    assert.equal(result.ok, false);
  }
  assert.equal(applyAction(state, { type: 'take_card', playerId: 'p1', cardId: 'hex-rot' }).error.code, 'hex_recipient_required');
});

test('a Hex goes to the selected opponent and its pick consumes exactly one turn', () => {
  const state = fresh({ shuffledDeck: ['hex-rot', ...deck.filter((id) => id !== 'hex-rot')] });
  const result = applyAction(state, { type: 'take_card', playerId: 'p1', cardId: 'hex-rot', recipientPlayerId: 'p2' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.players[0].heldHexIds, []);
  assert.deepEqual(result.state.players[1].heldHexIds, ['hex-rot']);
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(result.state.currentPlayerId, 'p2');
  assert.equal(result.state.vault.length, 5);
});

test('a relic cannot be assigned to a Hex recipient', () => {
  const state = fresh();
  const result = applyAction(state, { type: 'take_card', playerId: 'p1', cardId: state.vault[0], recipientPlayerId: 'p2' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unexpected_hex_recipient');
});

test('Vault refills from the draw pile until it returns to five cards', () => {
  const state = fresh();
  const result = take(state, state.vault[0]);
  assert.equal(result.ok, true);
  assert.equal(result.state.vault.length, 5);
  assert.equal(result.state.deck.length, 18);
  assert.equal(state.deck.length, 19);
});

test('after the draw pile empties, the Vault shrinks by one for each successful pick', () => {
  let state = fresh();
  let picks = 0;
  while (state.deck.length > 0) {
    const cardId = state.vault[0];
    const card = CARD_CATALOG.find(({ id }) => id === cardId);
    const result = take(state, cardId, card.type === 'hex' ? (state.currentPlayerId === 'p1' ? 'p2' : 'p1') : undefined);
    assert.equal(result.ok, true);
    state = result.state;
    picks += 1;
  }
  assert.equal(picks, 19);
  assert.equal(state.vault.length, 5);
  const next = state.vault[0];
  const before = state.vault.length;
  const card = CARD_CATALOG.find(({ id }) => id === next);
  const result = take(state, next, card.type === 'hex' ? (state.currentPlayerId === 'p1' ? 'p2' : 'p1') : undefined);
  assert.equal(result.state.vault.length, before - 1);
  assert.equal(result.state.deck.length, 0);
  state = result.state;
  while (state.status === 'active') {
    const oldLength = state.vault.length;
    const cardId = state.vault[0];
    const nextCard = CARD_CATALOG.find(({ id }) => id === cardId);
    const recipient = state.currentPlayerId === 'p1' ? 'p2' : 'p1';
    const nextResult = take(state, cardId, nextCard.type === 'hex' ? recipient : undefined);
    assert.equal(nextResult.ok, true);
    assert.equal(nextResult.state.vault.length, oldLength - 1);
    state = nextResult.state;
  }
  assert.equal(isGameComplete(state), true);
});

test('final Hex transfer resolves before completion and the result reveals every Mark', () => {
  const orderedDeck = [...deck.filter((id) => id !== 'hex-envy'), 'hex-envy'];
  let state = fresh({ shuffledDeck: orderedDeck });
  while (state.vault.length > 1 || state.deck.length > 0) {
    const cardId = state.vault[0];
    const card = CARD_CATALOG.find(({ id }) => id === cardId);
    const recipient = state.currentPlayerId === 'p1' ? 'p2' : 'p1';
    const result = take(state, cardId, card.type === 'hex' ? recipient : undefined);
    assert.equal(result.ok, true);
    state = result.state;
  }
  assert.equal(state.vault[0], 'hex-envy');
  const picker = state.currentPlayerId;
  const recipient = picker === 'p1' ? 'p2' : 'p1';
  const finalAction = applyAction(state, { type: 'take_card', playerId: picker, cardId: 'hex-envy', recipientPlayerId: recipient });
  assert.equal(finalAction.ok, true);
  state = finalAction.state;
  assert.equal(isGameComplete(state), true);
  assert.equal(state.players.find(({ id }) => id === recipient).heldHexIds.includes('hex-envy'), true);
  assert.equal(state.currentPlayerId, null);
  assert.deepEqual(projectForPlayer(state, 'p1').players.map(({ mark }) => mark), ['ember', 'ember']);
  assert.equal(getGameResult(state).scores.length, 2);
});

test('faction scoring is triangular for zero through five relics', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(scoreFaction), [0, 1, 3, 6, 10, 15]);
});

test('Mark bonus starts at exactly three matching relics and applies above three', () => {
  const emberIds = deck.filter((id) => id.startsWith('ember-'));
  for (const [count, bonus] of [[2, 0], [3, 3], [4, 3], [5, 3]]) {
    const player = { ...fresh().players[0], heldRelicIds: emberIds.slice(0, count) };
    assert.equal(calculatePlayerScore(player).markBonus, bonus);
  }
});

test('each Hex costs exactly three points and final scores may be negative', () => {
  const player = { ...fresh().players[0], heldHexIds: ['hex-rot', 'hex-jinx', 'hex-shackle'] };
  const score = calculatePlayerScore(player);
  assert.equal(score.hexPenalty, 9);
  assert.equal(score.total, -9);
});

test('all players tied for the highest final score share the victory', () => {
  const state = fresh();
  const complete = {
    ...state, status: 'complete', deck: [], vault: [], currentPlayerId: null,
    players: state.players.map((player, index) => ({ ...player, heldRelicIds: [index === 0 ? 'ember-spark' : 'ember-cinder'] })),
  };
  const result = getGameResult(complete);
  assert.deepEqual(result.winnerPlayerIds, ['p1', 'p2']);
});

test('invalid actions return the original state without mutation', () => {
  const state = fresh();
  const before = structuredClone(state);
  const result = applyAction(state, { type: 'take_card', playerId: 'p2', cardId: state.vault[0] });
  assert.equal(result.ok, false);
  assert.equal(result.state, state);
  assert.deepEqual(state, before);
});

test('pause and resume preserve the turn, deck and Marks; abandoned matches have no result', () => {
  const state = fresh();
  const paused = pauseMatch(state);
  assert.equal(paused.ok, true);
  assert.equal(paused.state.status, 'paused');
  assert.equal(paused.state.currentPlayerId, state.currentPlayerId);
  assert.deepEqual(paused.state.deck, state.deck);
  assert.deepEqual(paused.state.players.map(({ mark }) => mark), state.players.map(({ mark }) => mark));
  const resumed = resumeMatch(paused.state);
  assert.equal(resumed.state.currentPlayerId, state.currentPlayerId);
  const abandoned = abandonMatch(paused.state);
  assert.equal(abandoned.state.status, 'abandoned');
  assert.equal(getGameResult(abandoned.state), null);
});

test('in-progress projections expose public collections and own Mark only, never deck order', () => {
  const state = fresh();
  const projected = projectForPlayer(state, 'p1');
  assert.equal(projected.you.mark, 'ember');
  assert.equal(projected.players[1].mark, null);
  assert.equal('deck' in projected, false);
  assert.equal(JSON.stringify(projected).includes(state.deck[0]), false);
  assert.deepEqual(projected.players[1].heldRelicIds, []);
});
