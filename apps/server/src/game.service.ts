import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  CARD_CATALOG,
  projectForPlayer,
  type CardId,
  type Faction,
  type PlayerId,
} from "@grudge-vault/game-engine";
import { StoreError, type GameStore, type PlayerGameView, type RoomView, type StoredSession } from "./game-store.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOBBY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const RECONNECT_GRACE_MS = 60_000;

export interface ClockAndTimer {
  now(): number;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(handle: ReturnType<typeof setTimeout>): void;
}

const systemClock: ClockAndTimer = {
  now: Date.now,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
};

export interface RoomChange { roomId: string }
export type RoomChangeListener = (change: RoomChange) => void;

export class GameService {
  private readonly logger = new Logger(GameService.name);
  private readonly timers = new Map<string, { handle: ReturnType<typeof setTimeout>; deadline: Date }>();
  private readonly changeListeners = new Set<RoomChangeListener>();

  constructor(
    private readonly store: GameStore,
    private readonly clock: ClockAndTimer = systemClock,
    private readonly randomId: () => string = randomUUID,
  ) {}

  async onModuleInit(): Promise<void> {
    const pauseDeadline = new Date(this.clock.now() + RECONNECT_GRACE_MS);
    await this.store.recoverAfterRestart(pauseDeadline);
    for (const paused of await this.store.listPausedRooms()) this.scheduleAbandonment(paused.roomId, paused.deadline);
  }

  onModuleDestroy(): void {
    for (const { handle } of this.timers.values()) this.clock.cancel(handle);
    this.timers.clear();
  }

  onRoomChange(listener: RoomChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async createRoom(displayName: string): Promise<PlayerGameView & { roomCode: string; reconnectToken: string }> {
    const name = cleanDisplayName(displayName);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const roomCode = makeRoomCode();
      const reconnectToken = randomBytes(32).toString("base64url");
      const playerId = this.randomId();
      try {
        const session = await this.store.createRoom({
          id: this.randomId(),
          codeHash: hash(roomCode),
          expiresAt: new Date(this.clock.now() + LOBBY_LIFETIME_MS),
          hostPlayerId: playerId,
          seat: { id: playerId, displayName: name, credentialHash: hash(reconnectToken) },
        });
        return { ...this.toPlayerView(session), roomCode, reconnectToken };
      } catch (error) {
        if (error instanceof StoreError && error.code === "ROOM_CODE_COLLISION") continue;
        throw error;
      }
    }
    throw new StoreError({ code: "ROOM_CREATE_FAILED", message: "Could not allocate a unique room code. Retry room creation." });
  }

  async joinRoom(roomCode: string, displayName: string): Promise<PlayerGameView & { reconnectToken: string }> {
    const code = normalizeRoomCode(roomCode);
    const reconnectToken = randomBytes(32).toString("base64url");
    const session = await this.store.joinRoom(hash(code), {
      id: this.randomId(), displayName: cleanDisplayName(displayName), credentialHash: hash(reconnectToken),
    });
    return { ...this.toPlayerView(session), reconnectToken };
  }

  async chooseMark(roomId: string, playerId: PlayerId, mark: Faction): Promise<RoomView> {
    return this.store.chooseMark(roomId, playerId, mark);
  }

  async startMatch(roomId: string, playerId: PlayerId): Promise<PlayerGameView> {
    const shuffledDeck = secureShuffle(CARD_CATALOG.map(({ id }) => id));
    return this.toPlayerView(await this.store.startMatch(roomId, playerId, this.randomId(), shuffledDeck));
  }

  async takeCard(roomId: string, matchId: string, playerId: PlayerId, requestId: string, cardId: CardId, recipientPlayerId?: PlayerId): Promise<PlayerGameView> {
    return this.toPlayerView(await this.store.takeCard(roomId, matchId, playerId, requestId, cardId, recipientPlayerId));
  }

  async getRoomView(roomId: string): Promise<RoomView> { return this.store.getRoomView(roomId); }

  async getPlayerView(roomId: string, playerId: PlayerId): Promise<PlayerGameView> {
    return this.toPlayerView(await this.store.getSession(roomId, playerId));
  }

  async reconnect(reconnectToken: string): Promise<PlayerGameView> {
    const session = await this.store.reconnect(hash(reconnectToken));
    if (session.resumed) this.clearAbandonment(session.room.roomId);
    return this.toPlayerView(session);
  }

  async leaveRoom(roomId: string, playerId: PlayerId): Promise<RoomView | null> {
    return this.store.leaveRoom(roomId, playerId);
  }

  async disconnected(roomId: string, playerId: PlayerId): Promise<PlayerGameView | null> {
    const deadline = new Date(this.clock.now() + RECONNECT_GRACE_MS);
    const session = await this.store.disconnect(roomId, playerId, deadline);
    if (!session) return null;
    if (session.gameState?.status === "paused" && !this.timers.has(roomId)) this.scheduleAbandonment(roomId, deadline);
    if (session.room.status === "paused") this.publishRoomChange(roomId);
    return this.toPlayerView(session);
  }

  private toPlayerView(session: StoredSession): PlayerGameView {
    const { gameState, ...publicSession } = session;
    return { ...publicSession, game: gameState ? projectForPlayer(gameState, session.playerId) : null };
  }

  private scheduleAbandonment(roomId: string, deadline: Date): void {
    this.clearAbandonment(roomId);
    const delay = Math.max(0, deadline.getTime() - this.clock.now());
    const handle = this.clock.schedule(() => {
      void this.store.abandonIfDeadlineMatches(roomId, deadline).then((session) => {
        this.timers.delete(roomId);
        if (session) this.publishRoomChange(roomId);
      }).catch((error: unknown) => {
        this.timers.delete(roomId);
        this.logger.error(`Unable to expire paused match ${roomId}`, error instanceof Error ? error.stack : undefined);
      });
    }, delay);
    this.timers.set(roomId, { handle, deadline });
  }

  private clearAbandonment(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) this.clock.cancel(timer.handle);
    this.timers.delete(roomId);
  }

  private publishRoomChange(roomId: string): void {
    for (const listener of this.changeListeners) {
      try { listener({ roomId }); }
      catch (error) { this.logger.error("Room change listener failed", error instanceof Error ? error.stack : undefined); }
    }
  }
}

export function cleanDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 24 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new StoreError({ code: "INVALID_DISPLAY_NAME", message: "Display name must contain 1–24 printable characters." });
  }
  return name;
}

export function normalizeRoomCode(value: string): string {
  const code = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{10}$/u.test(code)) throw new StoreError({ code: "INVALID_ROOM_CODE", message: "Room code is invalid." });
  return code;
}

function makeRoomCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte & 31]!).join("");
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function secureShuffle(cards: readonly CardId[]): CardId[] {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled;
}
