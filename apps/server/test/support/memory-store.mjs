import { createHash } from 'node:crypto';
import { CARD_CATALOG, abandonMatch, applyAction, createInitialState, resumeMatch, pauseMatch } from '../../../../packages/game-engine/dist/index.js';
import { StoreError } from '../../dist/game-store.js';

const clone = (value) => structuredClone(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new StoreError({ code, message }); };

export class MemoryGameStore {
  constructor(now = Date.now) {
    this.now = now;
    this.rooms = new Map();
    this.tokens = new Map();
    this.actions = new Map();
    this.chains = new Map();
  }

  roomOrFail(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || (room.expiresAt && room.expiresAt.getTime() <= this.now())) fail('ROOM_NOT_FOUND', 'Room was not found or has expired.');
    return room;
  }
  publicRoom(room) {
    return {
      roomId: room.id, status: room.status, hostPlayerId: room.hostPlayerId,
      players: [...room.seats.values()].sort((a, b) => a.seatNo - b.seatNo).map((seat) => ({
        id: seat.id, displayName: seat.displayName, seatNo: seat.seatNo,
        connected: seat.connected, markSelected: seat.mark !== null,
      })), capacity: 4, matchId: room.matchId,
    };
  }
  session(room, playerId, extra = {}) {
    if (!room.seats.has(playerId)) fail('UNAUTHORIZED', 'This seat is not part of the room.');
    return { playerId, room: this.publicRoom(room), gameState: room.state ? clone(room.state) : null, ...extra };
  }
  async createRoom(input) {
    if ([...this.rooms.values()].some((room) => room.codeHash === input.codeHash)) fail('ROOM_CODE_COLLISION', 'collision');
    const seat = { ...input.seat, roomId: input.id, seatNo: 1, mark: null, connected: true };
    const room = {
      id: input.id, codeHash: input.codeHash, hostPlayerId: input.hostPlayerId, status: 'lobby',
      expiresAt: input.expiresAt, seats: new Map([[seat.id, seat]]), matchId: null, state: null, pauseDeadline: null,
    };
    this.rooms.set(room.id, room);
    this.tokens.set(seat.credentialHash, { roomId: room.id, playerId: seat.id });
    return this.session(room, seat.id);
  }
  async joinRoom(codeHash, input) {
    const room = [...this.rooms.values()].find((candidate) => candidate.codeHash === codeHash && (!candidate.expiresAt || candidate.expiresAt > new Date(this.now())));
    if (!room) fail('ROOM_NOT_FOUND', 'Room was not found or has expired.');
    if (room.status !== 'lobby') fail('ROOM_NOT_JOINABLE', 'This room is not accepting players.');
    if (room.seats.size >= 4) fail('ROOM_FULL', 'This room already has four players.');
    const used = new Set([...room.seats.values()].map((seat) => seat.seatNo));
    const seatNo = [1, 2, 3, 4].find((candidate) => !used.has(candidate));
    const seat = { ...input, roomId: room.id, seatNo, mark: null, connected: true };
    room.seats.set(seat.id, seat);
    this.tokens.set(seat.credentialHash, { roomId: room.id, playerId: seat.id });
    return this.session(room, seat.id);
  }
  async chooseMark(roomId, playerId, mark) {
    const room = this.roomOrFail(roomId);
    if (room.status !== 'lobby') fail('MATCH_ALREADY_STARTED', 'Marks can only be selected in the lobby.');
    const seat = room.seats.get(playerId);
    if (!seat) fail('UNAUTHORIZED', 'This seat is not part of the room.');
    if (seat.mark !== null) fail('MARK_LOCKED', 'Mark is locked.');
    seat.mark = mark;
    return this.publicRoom(room);
  }
  async startMatch(roomId, playerId, matchId, shuffledDeck) {
    const room = this.roomOrFail(roomId);
    if (room.hostPlayerId !== playerId) fail('NOT_HOST', 'Only the room host can start the match.');
    if (room.status !== 'lobby') fail('MATCH_ALREADY_STARTED', 'This room has already started a match.');
    if (room.seats.size < 2) fail('NOT_ENOUGH_PLAYERS', 'At least two players are required.');
    const seats = [...room.seats.values()].sort((a, b) => a.seatNo - b.seatNo);
    if (seats.some((seat) => seat.mark === null)) fail('MARK_REQUIRED', 'Every player must select a Mark.');
    room.matchId = matchId;
    // Keep the test fixture deterministic while production still supplies its CSPRNG shuffle.
    const fixtureDeck = ['hex-rot', ...CARD_CATALOG.map(({ id }) => id).filter((id) => id !== 'hex-rot')];
    room.state = createInitialState({ matchId, players: seats.map(({ id, displayName, mark }) => ({ id, displayName, mark })), shuffledDeck: fixtureDeck });
    room.status = 'active';
    room.expiresAt = null;
    return this.session(room, playerId);
  }
  async withLock(roomId, work) {
    const before = this.chains.get(roomId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = before.then(() => gate);
    this.chains.set(roomId, queued);
    await before;
    try { return await work(); }
    finally {
      release();
      if (this.chains.get(roomId) === queued) this.chains.delete(roomId);
    }
  }
  async takeCard(roomId, matchId, playerId, requestId, cardId, recipientPlayerId) {
    return this.withLock(roomId, async () => {
      const room = this.roomOrFail(roomId);
      if (!room.seats.has(playerId)) fail('UNAUTHORIZED', 'This seat is not part of the room.');
      if (!room.state || room.matchId !== matchId) fail('MATCH_NOT_FOUND', 'Match was not found.');
      const key = `${matchId}:${playerId}:${requestId}`;
      const payloadHash = sha(JSON.stringify({ cardId, recipientPlayerId: recipientPlayerId ?? null }));
      const previous = this.actions.get(key);
      if (previous) {
        if (previous.payloadHash !== payloadHash) fail('DUPLICATE_ACTION_ID', 'Action ID was reused for another move.');
        return this.session(room, playerId, { actionRevision: previous.revision, replayed: true });
      }
      if (room.status !== 'active') fail('MATCH_NOT_ACTIVE', 'Match is not active.');
      const moved = applyAction(room.state, {
        type: 'take_card', playerId, cardId,
        ...(recipientPlayerId === undefined ? {} : { recipientPlayerId }),
      });
      if (!moved.ok) {
        const code = moved.error.code === 'not_active_player' ? 'OUT_OF_TURN'
          : moved.error.code === 'card_not_in_vault' ? 'CARD_NOT_AVAILABLE'
            : moved.error.code === 'game_not_active' ? 'MATCH_NOT_ACTIVE' : 'INVALID_HEX_TARGET';
        fail(code, moved.error.message);
      }
      room.state = clone(moved.state);
      room.status = room.state.status;
      this.actions.set(key, { payloadHash, revision: room.state.revision });
      return this.session(room, playerId, { actionRevision: room.state.revision, replayed: false });
    });
  }
  async getSession(roomId, playerId) { return this.session(this.roomOrFail(roomId), playerId); }
  async getRoomView(roomId) { return this.publicRoom(this.roomOrFail(roomId)); }
  async reconnect(credentialHash) {
    const token = this.tokens.get(credentialHash);
    if (!token) fail('INVALID_RECONNECT_TOKEN', 'Reconnect credential is invalid or has expired.');
    const room = this.roomOrFail(token.roomId);
    const seat = room.seats.get(token.playerId);
    if (!seat) fail('INVALID_RECONNECT_TOKEN', 'Reconnect credential is invalid or has expired.');
    seat.connected = true;
    let resumed = false;
    if (room.status === 'paused' && [...room.seats.values()].every((item) => item.connected)) {
      const outcome = resumeMatch(room.state);
      if (!outcome.ok) fail('MATCH_NOT_RESUMABLE', 'Match could not resume.');
      room.state = outcome.state;
      room.status = 'active';
      room.pauseDeadline = null;
      resumed = true;
    }
    return this.session(room, token.playerId, { resumed });
  }
  async disconnect(roomId, playerId, deadline) {
    const room = this.roomOrFail(roomId);
    const seat = room.seats.get(playerId);
    if (!seat) return null;
    seat.connected = false;
    if (room.status === 'active' && room.state) {
      const outcome = pauseMatch(room.state);
      if (outcome.ok) {
        room.state = outcome.state;
        room.status = 'paused';
        room.pauseDeadline = deadline;
      }
    }
    return this.session(room, playerId);
  }
  async abandonIfDeadlineMatches(roomId, deadline) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'paused' || !room.pauseDeadline || room.pauseDeadline.getTime() !== deadline.getTime() || deadline.getTime() > this.now()) return null;
    const outcome = abandonMatch(room.state);
    if (!outcome.ok) return null;
    room.state = outcome.state;
    room.status = 'abandoned';
    room.expiresAt = new Date(this.now() + 30 * 24 * 60 * 60 * 1000);
    room.pauseDeadline = null;
    return this.session(room, [...room.seats.keys()][0]);
  }
  async leaveRoom(roomId, playerId) {
    const room = this.roomOrFail(roomId);
    if (room.status !== 'lobby') fail('ROOM_NOT_LEAVABLE', 'A player cannot leave after a match starts.');
    const seat = room.seats.get(playerId);
    if (!seat) fail('UNAUTHORIZED', 'Seat is not part of room.');
    room.seats.delete(playerId);
    this.tokens.delete(seat.credentialHash);
    if (!room.seats.size) { this.rooms.delete(roomId); return null; }
    if (room.hostPlayerId === playerId) room.hostPlayerId = [...room.seats.values()].sort((a, b) => a.seatNo - b.seatNo)[0].id;
    return this.publicRoom(room);
  }
  async recoverAfterRestart(deadline) {
    for (const room of this.rooms.values()) {
      for (const seat of room.seats.values()) seat.connected = false;
      if (room.status === 'active' && room.state) {
        const paused = pauseMatch(room.state);
        if (paused.ok) { room.state = paused.state; room.status = 'paused'; room.pauseDeadline = deadline; }
      }
    }
    return this.listPausedRooms();
  }
  async listPausedRooms() {
    return [...this.rooms.values()].filter((room) => room.status === 'paused' && room.pauseDeadline).map((room) => ({ roomId: room.id, deadline: room.pauseDeadline }));
  }
  async close() {}
}
