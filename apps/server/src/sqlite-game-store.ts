import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  abandonMatch,
  applyAction,
  createInitialState,
  getGameResult,
  pauseMatch,
  resumeMatch,
  type Faction,
  type CardId,
  type GameState,
  type PlayerId,
} from "@grudge-vault/game-engine";
import Sqlite from "better-sqlite3";
import type { Database as SqliteDatabase, RunResult } from "better-sqlite3";
import { applySqliteMigrations } from "../scripts/sqlite-migrations.mjs";
import { StoreError, type GameStore, type NewRoom, type NewSeat, type RoomStatus, type RoomView, type StoredSession } from "./game-store.js";

export const SQLITE_DATABASE = Symbol("SQLITE_DATABASE");
export const GAME_STORE = Symbol("GAME_STORE");
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SqliteQueryResult<T> { rows: T[]; rowCount: number; }
interface SqliteClient { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<SqliteQueryResult<T>>; release(): void; }

class SqlitePool {
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly db: SqliteDatabase) {}
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
  async connect(): Promise<SqliteClient> {
    const releaseLock = await this.acquire();
    return { query: async <T>(sql: string, values: readonly unknown[] = []) => this.execute<T>(sql, values), release: releaseLock };
  }
  async query<T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<SqliteQueryResult<T>> {
    const client = await this.connect();
    try { return await client.query<T>(sql, values); } finally { client.release(); }
  }
  private execute<T>(sql: string, values: readonly unknown[]): SqliteQueryResult<T> {
    const { sql: translatedSql, values: orderedValues } = normalizeSql(sql, values);
    const statement = this.db.prepare(translatedSql);
    const params = orderedValues.map((value) => value instanceof Date ? value.toISOString() : value);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)) {
      this.db.exec(translatedSql);
      return { rows: [], rowCount: 0 };
    }
    if (statement.reader) {
      const rows = statement.all(...params) as T[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...params) as RunResult;
    return { rows: [], rowCount: result.changes };
  }
  async end(): Promise<void> { this.db.close(); }
}

function normalizeSql(sql: string, values: readonly unknown[]): { sql: string; values: unknown[] } {
  const orderedValues: unknown[] = [];
  const translated = sql.replace(/\$(\d+)/gu, (_placeholder, position: string) => {
    orderedValues.push(values[Number(position) - 1]);
    return "?";
  });
  return { sql: translated, values: orderedValues };
}

export function resolveSqlitePath(databasePath = process.env.SQLITE_PATH ?? "./data/grudge-vault.sqlite"): string {
  if (databasePath === ":memory:") return databasePath;
  return resolve(SERVER_ROOT, databasePath);
}

export function createSqlitePool(databasePath = process.env.SQLITE_PATH ?? "./data/grudge-vault.sqlite", migrationsDirectory = resolve(SERVER_ROOT, "migrations")): SqlitePool {
  const absolutePath = resolveSqlitePath(databasePath);
  if (process.env.NODE_ENV === "production" && !absolutePath.startsWith(resolve("/var/data") + sep)) {
    throw new Error("Production SQLite must be stored beneath the Render persistent disk mount /var/data (set SQLITE_PATH). ");
  }
  if (absolutePath === ":memory:" && process.env.NODE_ENV === "production") throw new Error("Production SQLite must use a persistent file path, not :memory:.");
  const parent = absolutePath === ":memory:" ? null : dirname(absolutePath);
  if (parent) mkdirSync(parent, { recursive: true });
  const logger = new Logger("SqliteGameStore");
  logger.log(`SQLite database path: ${absolutePath}`);
  const db = new Sqlite(absolutePath);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (absolutePath !== ":memory:") db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("temp_store = MEMORY");
    const appliedMigrations = applySqliteMigrations(db, migrationsDirectory, absolutePath);
    logger.log(`SQLite schema ready; migrations applied: ${appliedMigrations.join(", ")}`);
    return new SqlitePool(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

interface RoomRow {
  id: string; status: RoomStatus; host_player_id: string; expires_at: string | Date | null;
}
interface SeatRow {
  id: string; display_name: string; seat_no: number; connected: boolean; mark: Faction | null;
}
interface MatchRow {
  id: string; status: GameState["status"]; state_json: GameState | string; result_json: unknown;
  pause_deadline: string | Date | null;
}

function fail(code: string, message: string): never { throw new StoreError({ code, message }); }
function readState(value: GameState | string): GameState {
  return (typeof value === "string" ? JSON.parse(value) : value) as GameState;
}
function toMillis(value: string | Date): number { return value instanceof Date ? value.getTime() : Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`); }
function roomExpired(row: RoomRow): boolean { return row.expires_at !== null && toMillis(row.expires_at) <= Date.now(); }

@Injectable()
export class SqliteGameStore implements GameStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqliteGameStore.name);
  constructor(@Inject(SQLITE_DATABASE) private readonly pool: SqlitePool) {}

  async onModuleInit(): Promise<void> {
    await this.pool.query("SELECT 1");
    await this.pool.query("SELECT id FROM rooms LIMIT 0").catch(() => {
      throw new Error("Game database schema is missing. Run `corepack pnpm --filter @grudge-vault/server migrate` first.");
    });
    const migration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE id='001_initial'").catch(() => ({ rowCount: 0, rows: [] }));
    if (!migration.rowCount) throw new Error("Game database migration 001_initial is missing. Run the server migrate command before startup.");
    this.logger.log("SQLite database ready");
  }

  async onModuleDestroy(): Promise<void> { await this.close(); }
  async close(): Promise<void> { await this.pool.end(); }

  private async transaction<T>(work: (client: SqliteClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN IMMEDIATE");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        this.logger.error("SQLite rollback failed", rollbackError instanceof Error ? rollbackError.stack : undefined);
      }
      throw error;
    } finally { client.release(); }
  }

  private async lockedRoom(client: SqliteClient, roomId: string): Promise<RoomRow> {
    const result = await client.query<RoomRow>("SELECT id, status, host_player_id, expires_at FROM rooms WHERE id = $1", [roomId]);
    const room = result.rows[0];
    if (!room || roomExpired(room)) fail("ROOM_NOT_FOUND", "Room was not found or has expired.");
    return room;
  }

  private async readRoomView(client: SqliteClient, roomId: string): Promise<RoomView> {
    const roomResult = await client.query<RoomRow>("SELECT id, status, host_player_id, expires_at FROM rooms WHERE id = $1", [roomId]);
    const room = roomResult.rows[0];
    if (!room || roomExpired(room)) fail("ROOM_NOT_FOUND", "Room was not found or has expired.");
    const [seatResult, matchResult] = await Promise.all([
      client.query<SeatRow>("SELECT id, display_name, seat_no, connected, mark FROM room_seats WHERE room_id = $1 ORDER BY seat_no", [roomId]),
      client.query<{ id: string }>("SELECT id FROM matches WHERE room_id = $1", [roomId]),
    ]);
    return {
      roomId: room.id,
      status: room.status,
      hostPlayerId: room.host_player_id,
      players: seatResult.rows.map((seat) => ({
        id: seat.id, displayName: seat.display_name, seatNo: seat.seat_no,
        connected: Boolean(seat.connected), markSelected: seat.mark !== null,
      })),
      capacity: 4,
      matchId: matchResult.rows[0]?.id ?? null,
    };
  }

  private async readSession(client: SqliteClient, roomId: string, playerId: PlayerId): Promise<StoredSession> {
    const seat = await client.query("SELECT 1 FROM room_seats WHERE room_id = $1 AND id = $2", [roomId, playerId]);
    if (!seat.rowCount) fail("UNAUTHORIZED", "This seat is not part of the room.");
    const room = await this.readRoomView(client, roomId);
    const match = await client.query<MatchRow>("SELECT id, status, state_json, result_json, pause_deadline FROM matches WHERE room_id = $1", [roomId]);
    return { playerId, room, gameState: match.rows[0] ? readState(match.rows[0].state_json) : null };
  }

  async createRoom(input: NewRoom): Promise<StoredSession> {
    return this.transaction(async (client) => {
      await client.query("DELETE FROM rooms WHERE expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')");
      await client.query(
        "INSERT INTO rooms(id, code_hash, host_player_id, status, expires_at) VALUES($1, $2, $3, 'lobby', $4)",
        [input.id, input.codeHash, input.hostPlayerId, input.expiresAt],
      );
      await client.query(
        "INSERT INTO room_seats(id, room_id, seat_no, display_name, credential_hash, connected, connected_at) VALUES($1, $2, 1, $3, $4, true, CURRENT_TIMESTAMP)",
        [input.seat.id, input.id, input.seat.displayName, input.seat.credentialHash],
      );
      return this.readSession(client, input.id, input.hostPlayerId);
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) fail("ROOM_CODE_COLLISION", "Room code collision; retry room creation.");
      throw error;
    });
  }

  async joinRoom(codeHash: string, seat: NewSeat): Promise<StoredSession> {
    return this.transaction(async (client) => {
      const result = await client.query<RoomRow>("SELECT id, status, host_player_id, expires_at FROM rooms WHERE code_hash = $1", [codeHash]);
      const room = result.rows[0];
      if (!room || roomExpired(room)) fail("ROOM_NOT_FOUND", "Room was not found or has expired.");
      if (room.status !== "lobby") fail("ROOM_NOT_JOINABLE", "This room is not accepting players.");
      const occupied = await client.query<{ seat_no: number }>("SELECT seat_no FROM room_seats WHERE room_id=$1 ORDER BY seat_no", [room.id]);
      if (occupied.rows.length >= 4) fail("ROOM_FULL", "This room already has four players.");
      const usedSeats = new Set(occupied.rows.map(({ seat_no }) => Number(seat_no)));
      const seatNo = [1, 2, 3, 4].find((candidate) => !usedSeats.has(candidate))!;
      await client.query(
        "INSERT INTO room_seats(id, room_id, seat_no, display_name, credential_hash, connected, connected_at) VALUES($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)",
        [seat.id, room.id, seatNo, seat.displayName, seat.credentialHash],
      );
      return this.readSession(client, room.id, seat.id);
    });
  }

  async chooseMark(roomId: string, playerId: PlayerId, mark: Faction): Promise<RoomView> {
    return this.transaction(async (client) => {
      const room = await this.lockedRoom(client, roomId);
      if (room.status !== "lobby") fail("MATCH_ALREADY_STARTED", "Marks can only be selected in the lobby.");
      const result = await client.query<{ mark: string | null }>("SELECT mark FROM room_seats WHERE room_id=$1 AND id=$2", [roomId, playerId]);
      if (!result.rowCount) fail("UNAUTHORIZED", "This seat is not part of the room.");
      if (result.rows[0]!.mark !== null) fail("MARK_LOCKED", "Your Mark has already been selected and cannot be changed.");
      await client.query("UPDATE room_seats SET mark=$3 WHERE room_id=$1 AND id=$2", [roomId, playerId, mark]);
      return this.readRoomView(client, roomId);
    });
  }

  async startMatch(roomId: string, playerId: PlayerId, matchId: string, shuffledDeck: readonly CardId[]): Promise<StoredSession> {
    return this.transaction(async (client) => {
      const room = await this.lockedRoom(client, roomId);
      if (room.host_player_id !== playerId) fail("NOT_HOST", "Only the room host can start the match.");
      if (room.status !== "lobby") fail("MATCH_ALREADY_STARTED", "This room has already started a match.");
      const seats = await client.query<SeatRow>("SELECT id, display_name, seat_no, connected, mark FROM room_seats WHERE room_id=$1 ORDER BY seat_no", [roomId]);
      if (seats.rows.length < 2) fail("NOT_ENOUGH_PLAYERS", "At least two players are required to start.");
      if (seats.rows.some((seat) => seat.mark === null)) fail("MARK_REQUIRED", "Every player must privately choose a Mark before the match starts.");
      const state = createInitialState({
        matchId,
        players: seats.rows.map((seat) => ({ id: seat.id, displayName: seat.display_name, mark: seat.mark! })),
        shuffledDeck,
      });
      await client.query(
        "INSERT INTO matches(id, room_id, status, revision, current_player_id, state_json) VALUES($1, $2, 'active', 0, $3, $4)",
        [matchId, roomId, state.currentPlayerId, JSON.stringify(state)],
      );
      await client.query("UPDATE rooms SET status='active', expires_at=NULL WHERE id=$1", [roomId]);
      await client.query("INSERT INTO match_events(match_id, revision, event_type, public_payload) VALUES($1, 0, 'match.started', '{}')", [matchId]);
      return this.readSession(client, roomId, playerId);
    });
  }

  async takeCard(roomId: string, expectedMatchId: string, playerId: PlayerId, requestId: string, cardId: string, recipientPlayerId?: PlayerId): Promise<StoredSession> {
    return this.transaction(async (client) => {
      const room = await this.lockedRoom(client, roomId);
      const seat = await client.query("SELECT 1 FROM room_seats WHERE room_id=$1 AND id=$2", [roomId, playerId]);
      if (!seat.rowCount) fail("UNAUTHORIZED", "This seat is not part of the room.");
      const matchResult = await client.query<MatchRow>("SELECT id, status, state_json, result_json, pause_deadline FROM matches WHERE room_id=$1", [roomId]);
      const match = matchResult.rows[0];
      if (!match) fail("MATCH_NOT_STARTED", "This room does not have an active match.");
      if (match.id !== expectedMatchId) fail("MATCH_NOT_FOUND", "The requested match does not belong to this room.");
      const before = readState(match.state_json);
      const payloadHash = sha256(JSON.stringify({ cardId, recipientPlayerId: recipientPlayerId ?? null }));
      const prior = await client.query<{ payload_hash: string; response_revision: number }>(
        "SELECT payload_hash, response_revision FROM processed_actions WHERE match_id=$1 AND player_id=$2 AND request_id=$3",
        [match.id, playerId, requestId],
      );
      if (prior.rowCount) {
        if (prior.rows[0]!.payload_hash !== payloadHash) fail("DUPLICATE_ACTION_ID", "This action ID was already used for a different action.");
        const session = await this.readSession(client, roomId, playerId);
        session.actionRevision = Number(prior.rows[0]!.response_revision);
        session.replayed = true;
        return session;
      }
      if (room.status !== "active" || match.status !== "active") fail("MATCH_NOT_ACTIVE", "This match is not accepting actions.");
      const outcome = applyAction(before, {
        type: "take_card", playerId, cardId: cardId as GameState["vault"][number],
        ...(recipientPlayerId === undefined ? {} : { recipientPlayerId }),
      });
      if (!outcome.ok) {
        const code = outcome.error.code === "not_active_player" ? "OUT_OF_TURN"
          : outcome.error.code === "card_not_in_vault" ? "CARD_NOT_AVAILABLE"
            : outcome.error.code === "game_not_active" ? "MATCH_NOT_ACTIVE" : "INVALID_HEX_TARGET";
        fail(code, outcome.error.message);
      }
      const state = outcome.state;
      const result = getGameResult(state);
      const responseRevision = state.revision;
      await client.query(
        "UPDATE matches SET status=$2, revision=$3, current_player_id=$4, state_json=$5, result_json=$6, ended_at=$7, pause_deadline=NULL WHERE id=$1",
        [match.id, state.status, state.revision, state.currentPlayerId, JSON.stringify(state), result ? JSON.stringify(result) : null, result ? new Date().toISOString() : null],
      );
      await client.query("UPDATE rooms SET status=$2, expires_at=CASE WHEN $2='complete' THEN datetime('now', '+30 days') ELSE NULL END WHERE id=$1", [roomId, state.status]);
      await client.query(
        "INSERT INTO processed_actions(match_id, room_id, player_id, request_id, payload_hash, response_revision) VALUES($1, $2, $3, $4, $5, $6)",
        [match.id, roomId, playerId, requestId, payloadHash, responseRevision],
      );
      await client.query(
        "INSERT INTO match_events(match_id, revision, actor_player_id, request_id, event_type, public_payload) VALUES($1, $2, $3, $4, $5, $6)",
        [match.id, responseRevision, playerId, requestId, result ? "match.completed" : "card.taken", JSON.stringify({ cardId, recipientPlayerId: recipientPlayerId ?? null })],
      );
      const session = await this.readSession(client, roomId, playerId);
      session.actionRevision = responseRevision;
      session.replayed = false;
      return session;
    });
  }

  async getSession(roomId: string, playerId: PlayerId): Promise<StoredSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await this.readSession(client, roomId, playerId);
      await client.query("COMMIT");
      return session;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection cleanup follows */ }
      throw error;
    } finally { client.release(); }
  }

  async getRoomView(roomId: string): Promise<RoomView> {
    const client = await this.pool.connect();
    try { return await this.readRoomView(client, roomId); } finally { client.release(); }
  }

  async reconnect(credentialHash: string): Promise<StoredSession> {
    return this.transaction(async (client) => {
      const found = await client.query<{ room_id: string; player_id: string }>(
        "SELECT room_id, id AS player_id FROM room_seats WHERE credential_hash=$1", [credentialHash],
      );
      const seat = found.rows[0];
      if (!seat) fail("INVALID_RECONNECT_TOKEN", "Reconnect credential is invalid or has expired.");
      const room = await this.lockedRoom(client, seat.room_id);
      await client.query("UPDATE room_seats SET connected=true, connected_at=CURRENT_TIMESTAMP WHERE room_id=$1 AND id=$2", [seat.room_id, seat.player_id]);
      let resumed = false;
      const matchResult = await client.query<MatchRow>("SELECT id, status, state_json, result_json, pause_deadline FROM matches WHERE room_id=$1", [seat.room_id]);
      const match = matchResult.rows[0];
      if (room.status === "paused" && match?.status === "paused") {
        const count = await client.query<{ connected_count: number; seat_count: number }>(
          "SELECT count(*) FILTER (WHERE connected) AS connected_count, count(*) AS seat_count FROM room_seats WHERE room_id=$1", [seat.room_id],
        );
        const row = count.rows[0]!;
        if (Number(row.connected_count) === Number(row.seat_count)) {
          const outcome = resumeMatch(readState(match.state_json));
          if (!outcome.ok) fail("MATCH_NOT_RESUMABLE", outcome.error.message);
          await client.query("UPDATE matches SET status='active', revision=$2, state_json=$3, pause_deadline=NULL WHERE id=$1", [match.id, outcome.state.revision, JSON.stringify(outcome.state)]);
          await client.query("UPDATE rooms SET status='active' WHERE id=$1", [seat.room_id]);
          await client.query("INSERT INTO match_events(match_id, revision, event_type, public_payload) VALUES($1, $2, 'match.resumed', '{}')", [match.id, outcome.state.revision]);
          resumed = true;
        }
      }
      const session = await this.readSession(client, seat.room_id, seat.player_id);
      session.resumed = resumed;
      return session;
    });
  }

  async disconnect(roomId: string, playerId: PlayerId, pauseDeadline: Date): Promise<StoredSession | null> {
    return this.transaction(async (client) => {
      const room = await this.lockedRoom(client, roomId);
      const updated = await client.query("UPDATE room_seats SET connected=false WHERE room_id=$1 AND id=$2", [roomId, playerId]);
      if (!updated.rowCount) return null;
      const matchResult = await client.query<MatchRow>("SELECT id, status, state_json, result_json, pause_deadline FROM matches WHERE room_id=$1", [roomId]);
      const match = matchResult.rows[0];
      if (!match || match.status !== "active" || room.status !== "active") return this.readSession(client, roomId, playerId);
      const outcome = pauseMatch(readState(match.state_json));
      if (!outcome.ok) fail("MATCH_NOT_PAUSABLE", outcome.error.message);
      await client.query("UPDATE matches SET status='paused', revision=$2, state_json=$3, pause_deadline=$4 WHERE id=$1", [match.id, outcome.state.revision, JSON.stringify(outcome.state), pauseDeadline.toISOString()]);
      await client.query("UPDATE rooms SET status='paused' WHERE id=$1", [roomId]);
      await client.query("INSERT INTO match_events(match_id, revision, event_type, public_payload) VALUES($1, $2, 'match.paused', '{}')", [match.id, outcome.state.revision]);
      return this.readSession(client, roomId, playerId);
    });
  }

  async abandonIfDeadlineMatches(roomId: string, expectedDeadline: Date): Promise<StoredSession | null> {
    return this.transaction(async (client) => {
      const room = await client.query<RoomRow>("SELECT id, status, host_player_id, expires_at FROM rooms WHERE id=$1", [roomId]);
      const roomRow = room.rows[0];
      if (!roomRow || roomRow.status !== "paused") return null;
      const matchResult = await client.query<MatchRow>("SELECT id, status, state_json, result_json, pause_deadline FROM matches WHERE room_id=$1", [roomId]);
      const match = matchResult.rows[0];
      if (!match || match.status !== "paused" || !match.pause_deadline || toMillis(match.pause_deadline) !== expectedDeadline.getTime() || toMillis(match.pause_deadline) > Date.now()) return null;
      const outcome = abandonMatch(readState(match.state_json));
      if (!outcome.ok) return null;
      await client.query("UPDATE matches SET status='abandoned', revision=$2, current_player_id=NULL, state_json=$3, ended_at=CURRENT_TIMESTAMP, pause_deadline=NULL WHERE id=$1", [match.id, outcome.state.revision, JSON.stringify(outcome.state)]);
      await client.query("UPDATE rooms SET status='abandoned', expires_at=datetime('now', '+30 days') WHERE id=$1", [roomId]);
      await client.query("INSERT INTO match_events(match_id, revision, event_type, public_payload) VALUES($1, $2, 'match.abandoned', '{}')", [match.id, outcome.state.revision]);
      const seat = await client.query<{ id: string }>("SELECT id FROM room_seats WHERE room_id=$1 ORDER BY seat_no LIMIT 1", [roomId]);
      return seat.rows[0] ? this.readSession(client, roomId, seat.rows[0].id) : null;
    });
  }

  async leaveRoom(roomId: string, playerId: PlayerId): Promise<RoomView | null> {
    return this.transaction(async (client) => {
      const room = await this.lockedRoom(client, roomId);
      if (room.status !== "lobby") fail("ROOM_NOT_LEAVABLE", "A player cannot leave after a match has started.");
      const deleted = await client.query("DELETE FROM room_seats WHERE room_id=$1 AND id=$2", [roomId, playerId]);
      if (!deleted.rowCount) fail("UNAUTHORIZED", "This seat is not part of the room.");
      const remaining = await client.query<SeatRow>("SELECT id, display_name, seat_no, connected, mark FROM room_seats WHERE room_id=$1 ORDER BY seat_no", [roomId]);
      if (!remaining.rowCount) {
        await client.query("DELETE FROM rooms WHERE id=$1", [roomId]);
        return null;
      }
      const hostPlayerId = room.host_player_id === playerId ? remaining.rows[0]!.id : room.host_player_id;
      if (hostPlayerId !== room.host_player_id) await client.query("UPDATE rooms SET host_player_id=$2 WHERE id=$1", [roomId, hostPlayerId]);
      return this.readRoomView(client, roomId);
    });
  }

  async recoverAfterRestart(pauseDeadline: Date): Promise<readonly { roomId: string; deadline: Date }[]> {
    return this.transaction(async (client) => {
      await client.query("UPDATE room_seats SET connected=false WHERE connected=true");
      const active = await client.query<{ id: string; room_id: string; state_json: GameState | string }>(
        "SELECT m.id, m.room_id, m.state_json FROM matches m JOIN rooms r ON r.id=m.room_id WHERE m.status='active'",
      );
      for (const match of active.rows) {
        const outcome = pauseMatch(readState(match.state_json));
        if (!outcome.ok) continue;
        await client.query("UPDATE matches SET status='paused', revision=$2, state_json=$3, pause_deadline=$4 WHERE id=$1", [match.id, outcome.state.revision, JSON.stringify(outcome.state), pauseDeadline.toISOString()]);
        await client.query("UPDATE rooms SET status='paused' WHERE id=$1", [match.room_id]);
        await client.query("INSERT INTO match_events(match_id, revision, event_type, public_payload) VALUES($1, $2, 'match.paused.server_restart', '{}')", [match.id, outcome.state.revision]);
      }
      return this.pausedRooms(client);
    });
  }

  async listPausedRooms(): Promise<readonly { roomId: string; deadline: Date }[]> {
    const client = await this.pool.connect();
    try { return await this.pausedRooms(client); } finally { client.release(); }
  }

  private async pausedRooms(client: SqliteClient): Promise<readonly { roomId: string; deadline: Date }[]> {
    const result = await client.query<{ room_id: string; pause_deadline: string | Date }>(
      "SELECT room_id, pause_deadline FROM matches WHERE status='paused' AND pause_deadline IS NOT NULL",
    );
    return result.rows.map(({ room_id, pause_deadline }) => ({ roomId: room_id, deadline: new Date(toMillis(pause_deadline)) }));
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}


