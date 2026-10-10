import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CARD_CATALOG } from '../../../packages/game-engine/dist/index.js';
import { GameService } from '../dist/game.service.js';
import { MemoryGameStore } from './support/memory-store.mjs';

const uuid = () => randomUUID();
const requestId = () => randomUUID();

class FakeClock {
  nowValue = 1_800_000_000_000;
  nextId = 0;
  scheduled = new Map();
  now = () => this.nowValue;
  schedule = (callback, delayMs) => {
    const handle = { id: ++this.nextId, callback, dueAt: this.nowValue + delayMs };
    this.scheduled.set(handle.id, handle);
    return handle;
  };
  cancel = (handle) => { this.scheduled.delete(handle.id); };
  async advance(ms) {
    this.nowValue += ms;
    const due = [...this.scheduled.values()].filter((timer) => timer.dueAt <= this.nowValue);
    for (const timer of due) { this.scheduled.delete(timer.id); timer.callback(); }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup() {
  const clock = new FakeClock();
  const store = new MemoryGameStore(clock.now);
  const service = new GameService(store, clock, uuid);
  return { clock, store, service };
}

async function createStarted(service, marks = ['ember', 'tide']) {
  const host = await service.createRoom(' Host  Player ');
  const guest = await service.joinRoom(host.roomCode, 'Guest');
  const roomId = host.room.roomId;
  for (const [seat, mark] of [[host, marks[0]], [guest, marks[1]]]) await service.chooseMark(roomId, seat.playerId, mark);
  const started = await service.startMatch(roomId, host.playerId);
  return { host, guest, started, roomId, matchId: started.game.matchId };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test('room creation and joining issue separate credentials, enforce 2 to 4 seats, and expose no Mark', async () => {
  const { service, store } = setup();
  const host = await service.createRoom('Host');
  assert.equal(host.roomCode.length, 10);
  assert.equal(host.reconnectToken.length, 43);
  assert.equal([...store.tokens.keys()].includes(host.reconnectToken), false);
  const players = [host];
  for (let index = 0; index < 3; index += 1) players.push(await service.joinRoom(host.roomCode, `Guest ${index}`));
  assert.equal(players.length, 4);
  assert.deepEqual((await service.getRoomView(host.room.roomId)).players.map(({ markSelected }) => markSelected), [false, false, false, false]);
  await expectCode(service.joinRoom(host.roomCode, 'Extra'), 'ROOM_FULL');
});

test('a room requires two players and every seated player to lock a private Mark before start', async () => {
  const { service } = setup();
  const host = await service.createRoom('Host');
  await expectCode(service.startMatch(host.room.roomId, host.playerId), 'NOT_ENOUGH_PLAYERS');
  const guest = await service.joinRoom(host.roomCode, 'Guest');
  await expectCode(service.startMatch(host.room.roomId, host.playerId), 'MARK_REQUIRED');
  // A successful first choice is immutable; a second submission cannot replace it.
  await service.chooseMark(host.room.roomId, host.playerId, 'ember');
  await expectCode(service.chooseMark(host.room.roomId, host.playerId, 'void'), 'MARK_LOCKED');
  await expectCode(service.startMatch(host.room.roomId, guest.playerId), 'NOT_HOST');
  await service.chooseMark(host.room.roomId, guest.playerId, 'ember');
  const started = await service.startMatch(host.room.roomId, host.playerId);
  assert.equal(started.game.players.every(({ mark }) => mark === null || mark === 'ember'), true);
});

test('public room updates disclose Mark selection status, never the selected faction', async () => {
  const { service } = setup();
  const host = await service.createRoom('Host');
  const guest = await service.joinRoom(host.roomCode, 'Guest');
  await service.chooseMark(host.room.roomId, host.playerId, 'void');
  const view = await service.getRoomView(host.room.roomId);
  assert.equal(view.players[0].markSelected, true);
  assert.equal('mark' in view.players[0], false);
  await service.chooseMark(host.room.roomId, guest.playerId, 'tide');
  const started = await service.startMatch(host.room.roomId, host.playerId);
  const playerView = await service.getPlayerView(host.room.roomId, host.playerId);
  assert.equal(playerView.game.you.mark, 'void');
  assert.equal(playerView.game.players.find(({ id }) => id === guest.playerId).mark, null);
  assert.equal('deck' in playerView.game, false);
  assert.equal(JSON.stringify(playerView.game).includes('tide-drip'), false);
  assert.equal(started.game.players.length, 2);
});

test('unauthorized, out-of-turn, absent-card, and invalid Hex-target actions are rejected', async () => {
  const { service } = setup();
  const { host, guest, roomId, matchId, started } = await createStarted(service);
  const relicId = started.game.vault.find((id) => id.startsWith('ember-'));
  await expectCode(service.takeCard(roomId, matchId, uuid(), requestId(), relicId), 'UNAUTHORIZED');
  await expectCode(service.takeCard(roomId, matchId, guest.playerId, requestId(), relicId), 'OUT_OF_TURN');
  await expectCode(service.takeCard(roomId, matchId, host.playerId, requestId(), 'void-maw'), 'CARD_NOT_AVAILABLE');
  await expectCode(service.takeCard(roomId, matchId, host.playerId, requestId(), 'hex-rot'), 'INVALID_HEX_TARGET');
  await expectCode(service.takeCard(roomId, matchId, host.playerId, requestId(), 'hex-rot', host.playerId), 'INVALID_HEX_TARGET');
  await expectCode(service.takeCard(roomId, 'wrong-match', host.playerId, requestId(), relicId), 'MATCH_NOT_FOUND');
});

test('Hex pick transfers to the chosen opponent and consumes one turn exactly once', async () => {
  const { service } = setup();
  const { host, guest, roomId, matchId } = await createStarted(service);
  const id = requestId();
  const after = await service.takeCard(roomId, matchId, host.playerId, id, 'hex-rot', guest.playerId);
  assert.equal(after.game.revision, 1);
  assert.equal(after.game.currentPlayerId, guest.playerId);
  assert.deepEqual(after.game.players.find(({ id: playerId }) => playerId === guest.playerId).heldHexIds, ['hex-rot']);
  assert.deepEqual(after.game.players.find(({ id: playerId }) => playerId === host.playerId).heldHexIds, []);
  const retried = await service.takeCard(roomId, matchId, host.playerId, id, 'hex-rot', guest.playerId);
  assert.equal(retried.replayed, true);
  assert.equal(retried.actionRevision, 1);
  assert.equal(retried.game.revision, 1);
  await expectCode(service.takeCard(roomId, matchId, host.playerId, id, 'ember-spark'), 'DUPLICATE_ACTION_ID');
});

test('two concurrent moves compete for one turn; exactly one commits', async () => {
  const { service, store } = setup();
  const { host, roomId, matchId, started } = await createStarted(service);
  const relics = started.game.vault.filter((id) => id.startsWith('ember-')).slice(0, 2);
  assert.equal(relics.length, 2);
  const [first, second] = await Promise.allSettled([
    service.takeCard(roomId, matchId, host.playerId, requestId(), relics[0]),
    service.takeCard(roomId, matchId, host.playerId, requestId(), relics[1]),
  ]);
  assert.equal([first, second].filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal([first, second].find((entry) => entry.status === 'rejected').reason.code, 'OUT_OF_TURN');
  assert.equal(store.rooms.get(roomId).state.revision, 1);
});

test('reconnect uses the existing token hash, restores the same seat and Mark, and resumes after everyone is back', async () => {
  const { service, store } = setup();
  const { host, guest, roomId } = await createStarted(service, ['thorn', 'void']);
  const originalTurn = (await service.getPlayerView(roomId, guest.playerId)).game.currentPlayerId;
  const originalMark = (await service.getPlayerView(roomId, guest.playerId)).game.you.mark;
  await service.disconnected(roomId, guest.playerId);
  assert.equal((await service.getPlayerView(roomId, host.playerId)).game.status, 'paused');
  const restored = await service.reconnect(guest.reconnectToken);
  assert.equal(restored.playerId, guest.playerId);
  assert.equal(restored.game.you.mark, originalMark);
  assert.equal(restored.game.status, 'active');
  assert.equal(restored.resumed, true);
  assert.equal(store.rooms.get(roomId).state.currentPlayerId, originalTurn);
});

test('the injected 60-second grace timer abandons without a winner', async () => {
  const { service, clock, store } = setup();
  const { guest, roomId } = await createStarted(service);
  await service.disconnected(roomId, guest.playerId);
  await clock.advance(59_999);
  assert.equal(store.rooms.get(roomId).status, 'paused');
  await clock.advance(1);
  assert.equal(store.rooms.get(roomId).status, 'abandoned');
  const abandoned = await service.getPlayerView(roomId, guest.playerId);
  assert.equal(abandoned.game.status, 'abandoned');
  assert.equal(abandoned.game.result, null);
});

test('startup recovery pauses persisted active state, marks all sockets offline and restores its timer', async () => {
  const { service, clock, store } = setup();
  const { roomId } = await createStarted(service);
  const before = structuredClone(store.rooms.get(roomId).state);
  await service.onModuleInit();
  const room = store.rooms.get(roomId);
  assert.equal(room.status, 'paused');
  assert.deepEqual([...room.seats.values()].map(({ connected }) => connected), [false, false]);
  assert.equal(room.state.currentPlayerId, before.currentPlayerId);
  assert.deepEqual(room.state.deck, before.deck);
  assert.equal(clock.scheduled.size, 1);
  service.onModuleDestroy();
  assert.equal(clock.scheduled.size, 0);
});

test('lobby leave revokes that seat token; leaving is forbidden after start', async () => {
  const { service } = setup();
  const host = await service.createRoom('Host');
  const guest = await service.joinRoom(host.roomCode, 'Guest');
  await service.leaveRoom(host.room.roomId, guest.playerId);
  await expectCode(service.reconnect(guest.reconnectToken), 'INVALID_RECONNECT_TOKEN');
  const guest2 = await service.joinRoom(host.roomCode, 'Guest again');
  await service.chooseMark(host.room.roomId, host.playerId, 'ember');
  await service.chooseMark(host.room.roomId, guest2.playerId, 'tide');
  await service.startMatch(host.room.roomId, host.playerId);
  await expectCode(service.leaveRoom(host.room.roomId, guest2.playerId), 'ROOM_NOT_LEAVABLE');
});

test('all players finish a persisted match and only the completed snapshot reveals all Marks', async () => {
  const { service } = setup();
  const { host, guest, roomId, matchId } = await createStarted(service, ['ember', 'ember']);
  for (let turn = 0; turn < 24; turn += 1) {
    const current = await service.getPlayerView(roomId, turn % 2 === 0 ? host.playerId : guest.playerId);
    const actorId = current.game.currentPlayerId;
    const cardId = current.game.vault[0];
    const recipient = actorId === host.playerId ? guest.playerId : host.playerId;
    await service.takeCard(roomId, matchId, actorId, requestId(), cardId, cardId.startsWith('hex-') ? recipient : undefined);
  }
  const finalHost = await service.getPlayerView(roomId, host.playerId);
  const finalGuest = await service.getPlayerView(roomId, guest.playerId);
  assert.equal(finalHost.game.status, 'complete');
  assert.equal(finalHost.game.result.winnerPlayerIds.length >= 1, true);
  assert.deepEqual(finalHost.game.players.map(({ mark }) => mark), ['ember', 'ember']);
  assert.deepEqual(finalGuest.game.players.map(({ mark }) => mark), ['ember', 'ember']);
  assert.equal(CARD_CATALOG.length, 24);
});

test('server cleans service timers on shutdown', async () => {
  const { service, clock } = setup();
  const { guest, roomId } = await createStarted(service);
  await service.disconnected(roomId, guest.playerId);
  assert.equal(clock.scheduled.size, 1);
  service.onModuleDestroy();
  assert.equal(clock.scheduled.size, 0);
});
