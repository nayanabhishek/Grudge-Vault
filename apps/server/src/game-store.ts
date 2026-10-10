import type { CardId, Faction, GameState, GameStatus, PlayerId, PlayerPublicState } from "@grudge-vault/game-engine";

export type RoomStatus = "lobby" | GameStatus;

export interface NewRoom {
  id: string;
  codeHash: string;
  expiresAt: Date;
  hostPlayerId: string;
  seat: NewSeat;
}

export interface NewSeat {
  id: string;
  displayName: string;
  credentialHash: string;
}

export interface RoomPlayerView {
  id: string;
  displayName: string;
  seatNo: number;
  connected: boolean;
  markSelected: boolean;
}

export interface RoomView {
  roomId: string;
  status: RoomStatus;
  hostPlayerId: PlayerId;
  players: RoomPlayerView[];
  capacity: 4;
  matchId: string | null;
}

export interface StoredSession {
  playerId: PlayerId;
  room: RoomView;
  gameState: GameState | null;
  /** Action response revision; only populated by a successful take command. */
  actionRevision?: number;
  replayed?: boolean;
  resumed?: boolean;
}

export interface StoreErrorOptions {
  code: string;
  message: string;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(options: StoreErrorOptions) {
    super(options.message);
    this.name = "StoreError";
    this.code = options.code;
  }
}

export interface GameStore {
  createRoom(input: NewRoom): Promise<StoredSession>;
  joinRoom(codeHash: string, seat: NewSeat): Promise<StoredSession>;
  chooseMark(roomId: string, playerId: PlayerId, mark: Faction): Promise<RoomView>;
  startMatch(roomId: string, playerId: PlayerId, matchId: string, shuffledDeck: readonly CardId[]): Promise<StoredSession>;
  takeCard(roomId: string, matchId: string, playerId: PlayerId, requestId: string, cardId: string, recipientPlayerId?: PlayerId): Promise<StoredSession>;
  getSession(roomId: string, playerId: PlayerId): Promise<StoredSession>;
  getRoomView(roomId: string): Promise<RoomView>;
  reconnect(credentialHash: string): Promise<StoredSession>;
  disconnect(roomId: string, playerId: PlayerId, pauseDeadline: Date): Promise<StoredSession | null>;
  abandonIfDeadlineMatches(roomId: string, expectedDeadline: Date): Promise<StoredSession | null>;
  leaveRoom(roomId: string, playerId: PlayerId): Promise<RoomView | null>;
  recoverAfterRestart(pauseDeadline: Date): Promise<readonly { roomId: string; deadline: Date }[]>;
  listPausedRooms(): Promise<readonly { roomId: string; deadline: Date }[]>;
  close(): Promise<void>;
}

export interface PlayerGameView extends Omit<StoredSession, "gameState"> {
  game: PlayerPublicState | null;
}
