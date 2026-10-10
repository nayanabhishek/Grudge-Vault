import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { CARD_CATALOG, FACTIONS, type ClientToServerEvents, type RoomCreated, type RoomJoined, type RoomPublicState, type ServerToClientEvents, type InterServerEvents, type SocketData } from "@grudge-vault/game-engine";
import type { Namespace, Socket } from "socket.io";
import { GameService } from "./game.service.js";
import { StoreError, type PlayerGameView, type RoomView } from "./game-store.js";

type EventName = keyof ClientToServerEvents;
type Payload<E extends EventName> = Parameters<ClientToServerEvents[E]>[0];
type Reply<T> = { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: { code: string; message: string } };
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const validCards = new Set<string>(CARD_CATALOG.map(({ id }) => id));

@WebSocketGateway({
  namespace: "/game",
  cors: { origin: process.env.WEB_ORIGIN?.split(",").map((origin) => origin.trim()) ?? (process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"]) },
})
export class GameGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer() private namespace!: Namespace<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  private readonly logger = new Logger(GameGateway.name);
  private readonly seatSockets = new Map<string, string>();
  private readonly joinRate = new Map<string, { start: number; count: number }>();
  private unsubscribeRoomChange?: () => void;

  constructor(private readonly games: GameService) {}

  onModuleInit(): void {
    this.unsubscribeRoomChange = this.games.onRoomChange(({ roomId }) => {
      void this.broadcastRoomAndGame(roomId).catch(() => this.logger.error("Failed to publish lifecycle update"));
    });
  }
  onModuleDestroy(): void { this.unsubscribeRoomChange?.(); }

  @SubscribeMessage("room:create")
  createRoom(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<RoomCreated>> {
    return this.command("room:create", raw, async (payload) => {
      const created = await this.games.createRoom(stringField(payload, "displayName"));
      await this.attach(socket, created.room.roomId, created.playerId);
      const { roomCode, reconnectToken, room, playerId } = created;
      socket.emit("room:created", { roomId: room.roomId });
      this.emitRoom(room);
      return { roomId: room.roomId, roomCode, reconnectToken, playerId };
    });
  }

  @SubscribeMessage("room:join")
  joinRoom(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<RoomJoined>> {
    return this.command("room:join", raw, async (payload) => {
      this.consumeJoinAttempt(socket);
      const joined = await this.games.joinRoom(stringField(payload, "roomCode"), stringField(payload, "displayName"));
      await this.attach(socket, joined.room.roomId, joined.playerId);
      const { reconnectToken, room, playerId } = joined;
      this.emitRoom(room);
      return { roomId: room.roomId, reconnectToken, playerId };
    });
  }

  @SubscribeMessage("room:state")
  roomState(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<RoomPublicState>> {
    return this.command("room:state", raw, async (payload) => {
      const identity = this.requireIdentity(socket);
      const roomId = roomField(payload, identity.roomId);
      return await this.games.getRoomView(roomId) as RoomPublicState;
    });
  }

  @SubscribeMessage("room:leave")
  leaveRoom(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{ left: true }>> {
    return this.command("room:leave", raw, async (payload) => {
      const identity = this.requireIdentity(socket);
      const roomId = roomField(payload, identity.roomId);
      const room = await this.games.leaveRoom(roomId, identity.playerId);
      await socket.leave(roomId);
      this.seatSockets.delete(identity.playerId);
      delete socket.data.roomId;
      delete socket.data.playerId;
      if (room) this.emitRoom(room);
      return { left: true };
    });
  }

  @SubscribeMessage("match:choose-mark")
  chooseMark(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{}>> {
    return this.command("match:choose-mark", raw, async (payload) => {
      const identity = this.requireIdentity(socket);
      const roomId = roomField(payload, identity.roomId);
      const mark = stringField(payload, "mark");
      if (!FACTIONS.includes(mark as (typeof FACTIONS)[number])) throw new StoreError({ code: "INVALID_MARK", message: "Mark must be one of Ember, Tide, Thorn, or Void." });
      const room = await this.games.chooseMark(roomId, identity.playerId, mark as (typeof FACTIONS)[number]);
      this.emitRoom(room);
      return {};
    });
  }

  @SubscribeMessage("match:start")
  startMatch(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{ matchId: string }>> {
    return this.command("match:start", raw, async (payload) => {
      const identity = this.requireIdentity(socket);
      const roomId = roomField(payload, identity.roomId);
      const started = await this.games.startMatch(roomId, identity.playerId);
      const game = started.game;
      if (!game) throw new StoreError({ code: "MATCH_START_FAILED", message: "Match state was not created." });
      const matchId = game.matchId;
      this.namespace.to(roomId).emit("match:started", { matchId, revision: game.revision });
      await this.broadcastGame(roomId);
      return { matchId };
    });
  }

  @SubscribeMessage("game:take-card")
  takeCard(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{ revision: number }>> {
    return this.command("game:take-card", raw, async (payload, requestId) => {
      const identity = this.requireIdentity(socket);
      const matchId = stringField(payload, "matchId");
      const cardId = stringField(payload, "cardId");
      if (!validCards.has(cardId)) throw new StoreError({ code: "INVALID_CARD", message: "Card ID is not in the game catalog." });
      const recipient = optionalStringField(payload, "recipientPlayerId");
      const updated = await this.games.takeCard(identity.roomId, matchId, identity.playerId, requestId, cardId as Payload<"game:take-card">["cardId"], recipient);
      if (!updated.replayed) await this.broadcastGame(identity.roomId);
      return { revision: updated.actionRevision ?? updated.game?.revision ?? 0 };
    });
  }

  @SubscribeMessage("match:reconnect")
  reconnect(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{ room: RoomPublicState; game: PlayerGameView["game"] }>> {
    return this.command("match:reconnect", raw, async (payload) => {
      const token = stringField(payload, "reconnectToken");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new StoreError({ code: "INVALID_RECONNECT_TOKEN", message: "Reconnect credential is invalid or has expired." });
      const session = await this.games.reconnect(token);
      await this.attach(socket, session.room.roomId, session.playerId);
      if (session.resumed) await this.broadcastGame(session.room.roomId);
      else if (session.game) this.emitGameState(socket, session.game);
      this.emitRoom(session.room);
      return { room: session.room, game: session.game };
    });
  }

  @SubscribeMessage("match:sync")
  sync(@ConnectedSocket() socket: GameSocket, @MessageBody() raw: unknown): Promise<Reply<{ room: RoomPublicState; game: PlayerGameView["game"] }>> {
    return this.command("match:sync", raw, async (payload) => {
      const identity = this.requireIdentity(socket);
      const roomId = roomField(payload, identity.roomId);
      const [room, session] = await Promise.all([this.games.getRoomView(roomId), this.games.getPlayerView(roomId, identity.playerId)]);
      return { room, game: session.game };
    });
  }

  handleDisconnect(socket: GameSocket): void {
    const playerId = socket.data.playerId;
    const roomId = socket.data.roomId;
    if (!playerId || !roomId || this.seatSockets.get(playerId) !== socket.id) return;
    this.seatSockets.delete(playerId);
    void this.games.disconnected(roomId, playerId).then(async (session) => {
      if (session) {
        this.emitRoom(session.room);
        if (session.game) await this.broadcastGame(roomId);
      }
    }).catch(() => this.logger.error("Failed to process player disconnect"));
  }

  private async command<T>(event: EventName, raw: unknown, operation: (payload: Record<string, unknown>, requestId: string) => Promise<T>): Promise<Reply<T>> {
    const requestId = isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : "invalid-request";
    try {
      if (!isRecord(raw)) throw new StoreError({ code: "INVALID_PAYLOAD", message: "Command payload must be an object." });
      if (!requestIdPattern.test(requestId)) throw new StoreError({ code: "INVALID_REQUEST_ID", message: "requestId must be a UUID." });
      const data = await operation(raw, requestId);
      return { ok: true, requestId, data };
    } catch (error) {
      const safeError = toPublicError(error);
      if (!(error instanceof StoreError)) this.logger.error(`Command ${event} failed (${safeError.code})`);
      return { ok: false, requestId, error: safeError };
    }
  }

  private async attach(socket: GameSocket, roomId: string, playerId: string): Promise<void> {
    const oldSocketId = this.seatSockets.get(playerId);
    this.seatSockets.set(playerId, socket.id);
    if (oldSocketId && oldSocketId !== socket.id) this.namespace.sockets.get(oldSocketId)?.disconnect(true);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    await socket.join(roomId);
  }

  private requireIdentity(socket: GameSocket): { roomId: string; playerId: string } {
    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId || this.seatSockets.get(playerId) !== socket.id) {
      throw new StoreError({ code: "UNAUTHORIZED", message: "Join a room or reconnect before sending this command." });
    }
    return { roomId, playerId };
  }

  private emitGameState(socket: GameSocket, state: NonNullable<PlayerGameView["game"]>): void {
    if (socket.data.lastStateRevision !== undefined && state.revision < socket.data.lastStateRevision) return;
    socket.data.lastStateRevision = state.revision;
    if (state.status === "complete") socket.emit("match:ended", { state });
    else socket.emit("game:state", { state });
  }

  private emitRoom(room: RoomView): void {
    this.namespace.to(room.roomId).emit("room:updated", room as RoomPublicState);
  }

  private async broadcastRoomAndGame(roomId: string): Promise<void> {
    const room = await this.games.getRoomView(roomId);
    this.emitRoom(room);
    if (room.matchId) await this.broadcastGame(roomId);
  }

  private async broadcastGame(roomId: string): Promise<void> {
    const peers = await this.namespace.in(roomId).fetchSockets();
    for (const peer of peers) {
      const playerId = peer.data.playerId;
      if (!playerId || peer.data.roomId !== roomId) continue;
      try {
        const session = await this.games.getPlayerView(roomId, playerId);
        if (session.game && (peer.data.lastStateRevision === undefined || session.game.revision >= peer.data.lastStateRevision)) {
          peer.data.lastStateRevision = session.game.revision;
          if (session.game.status === "complete") peer.emit("match:ended", { state: session.game });
          else peer.emit("game:state", { state: session.game });
        }
      } catch { /* A departed seat is not sent state. */ }
    }
  }

  private consumeJoinAttempt(socket: GameSocket): void {
    const key = socket.handshake.address || "unknown";
    const now = Date.now();
    for (const [address, attempt] of this.joinRate) if (now - attempt.start >= 60_000) this.joinRate.delete(address);
    const current = this.joinRate.get(key);
    if (!current || now - current.start >= 60_000) this.joinRate.set(key, { start: now, count: 1 });
    else if (current.count >= 12) throw new StoreError({ code: "RATE_LIMITED", message: "Too many room join attempts. Wait one minute and try again." });
    else current.count += 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new StoreError({ code: "INVALID_PAYLOAD", message: `${key} must be a non-empty string.` });
  return value.trim();
}
function optionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
  if (payload[key] === undefined) return undefined;
  return stringField(payload, key);
}
function roomField(payload: Record<string, unknown>, authenticatedRoomId: string): string {
  const claimedRoomId = stringField(payload, "roomId");
  if (claimedRoomId !== authenticatedRoomId) throw new StoreError({ code: "UNAUTHORIZED", message: "This socket is not authenticated for that room." });
  return authenticatedRoomId;
}
function toPublicError(error: unknown): { code: string; message: string } {
  if (error instanceof StoreError) return { code: error.code, message: error.message };
  return { code: "INTERNAL_ERROR", message: "The server could not complete this command." };
}
