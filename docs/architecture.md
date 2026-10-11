# Grudge Vault architecture

## Workspace

```text
apps/
  web/                 React + TypeScript + Vite playable client
  server/              NestJS + Socket.IO API and SQLite repository
packages/
  game-engine/         standalone TypeScript rules and player projections
docs/
  architecture.md      contracts, persistence, security, and operations
```

`GameStore` in `apps/server/src/game-store.ts` is the persistence port used by `GameService`. `SqliteGameStore` implements it with `better-sqlite3`; a later PostgreSQL adapter can implement the same interface without changing rules or service orchestration. Keep database-specific SQL and transaction behavior within repository implementations.

The first deployment is a single NestJS API instance with one SQLite file. Socket bindings, join throttling, and pause timers are process-local; do not add Redis or multiple instances in this phase. Render's persistent disk is single-instance storage. SQLite is appropriate for the expected initial data volume and write concurrency, but its one-writer model and disk coupling are deliberate scale limits.

## Game engine and authoritative state

The engine has 20 relics (five in each faction: Ember, Tide, Thorn, Void) and four Hexes: Rot, Jinx, Shackle, Envy. A match contains 2–4 players. The server supplies a cryptographically shuffled permutation of all 24 cards; five begin face-up in the Vault and 19 remain in the ordered draw pile. Players privately select a Mark before start; duplicate Marks are allowed.

Canonical engine state includes match/revision/status, player order and current player, secret Marks, relic and Hex collections, ordered draw pile, Vault, and completed result. It is persisted server-side in SQLite `matches.state_json`. The pure engine calculates faction triangular scores (0, 1, 3, 6, 10, 15), +3 for holding at least three Mark-faction relics, and −3 for each held Hex. Negative scores are permitted; tied top scores win.

A turn takes one face-up Vault card. Relics go to the active player. A Hex must be transferred to another player as part of the same take. The Vault refills to five while the draw pile has cards. The game completes after the final cards are drafted and their Hex transfers resolve.

`projectForPlayer` is an allowlisted projection. It includes the Vault, turn/status, public collections, and the requesting player's Mark. Opponent Marks remain `null` until completion, when all Marks and results are revealed. It never includes draw-pile contents. Canonical state is never sent directly to a socket.

## Server state and identity

`GameService` coordinates room lifecycle, cryptographic room codes, 32-byte seat reconnect tokens, pause timers, and the `GameStore` repository. SQLite stores hashes of room codes and reconnect tokens, secret Marks, canonical game state, action request/payload hashes, audit events, and completed result JSON. The authenticated socket binding supplies acting player identity; clients cannot assert their own actor ID. Tokens are returned privately on room create/join and successful reconnect only.

Room codes are normalized before lookup. Seats are limited to 2–4; lobby rooms expire after 24 hours and terminal rooms are retained for 30 days. Expired rows are rejected and purged during subsequent room creation; periodic cleanup is not implemented. Join attempts are limited to 12 per minute per source address and per process.

An active-match disconnect pauses the match and starts a 60-second grace period. Reconnecting every seat before its deadline resumes the same match. Expiry abandons the match with no winner. Restart recovery marks seats offline, pauses active matches, preserves existing paused deadlines, and recreates timers.

## Socket.IO contract

Every incoming command is parsed from `unknown` at the gateway. Mutations include a UUID `requestId`; card takes include the expected `matchId`. Actor IDs come from the bound socket. Acks use `{ ok, requestId, data? }` or `{ ok: false, requestId, error: { code, message } }`. Game state is emitted separately to each seat; room roster broadcasts contain no Marks or credentials.

| Client event | Payload | Behavior |
| --- | --- | --- |
| `room:create` | `{ displayName }` | Creates a private lobby; ack returns `roomId`, `roomCode`, `playerId`, `reconnectToken`, and room state. |
| `room:join` | `{ roomCode, displayName }` | Joins an open lobby; ack returns that seat's identity/token and room state. |
| `room:state` | `{ roomId }` | Returns public lobby roster only to a seated member. |
| `room:leave` | `{ roomId, requestId }` | Leaves a lobby; leaving a started match is rejected. |
| `match:choose-mark` | `{ roomId, requestId, mark }` | Stores that seat's private Mark before start. |
| `match:start` | `{ roomId, requestId }` | Host starts with 2–4 seats and all Marks selected; server shuffles and deals. |
| `game:take-card` | `{ matchId, requestId, cardId, recipientPlayerId? }` | Current player takes a Vault card; a Hex recipient is mandatory and must be an opponent. |
| `match:reconnect` | `{ reconnectToken }` | Authenticates and rebinds the seat; token is not broadcast. |
| `match:sync` | `{ roomId }` | Sends the bound seat a fresh player-specific snapshot. |

Room broadcasts use `room:updated` and public roster fields only. Duplicate successful takes with the same request ID and payload replay their accepted revision; reusing the ID with a different payload is rejected. Store methods validate membership, phase, turn, card, recipient, and request ID before committing. Failed actions do not partially update state.

## SQLite schema and transaction model

Migration `apps/server/migrations/001_initial.sql` creates:

- `rooms`: unique room-code hash, host seat, lifecycle status, creation and expiry.
- `room_seats`: seat number/name, private Mark, hashed reconnect credential, connection state.
- `matches`: room, status/revision/current seat, canonical engine JSON, completed result JSON, pause deadline.
- `processed_actions`: unique `(match_id, player_id, request_id)` plus payload hash and response revision.
- `match_events`: revisioned audit history with public payload only.

`better-sqlite3` is synchronous and embedded. `SqliteGameStore` wraps each access with a process-local connection mutex and runs every mutation under `BEGIN IMMEDIATE`; SQLite takes the reserved writer lock before reading the action preconditions. This prevents two commands from checking the same turn and both consuming it. The action transition, canonical state/result write, idempotency key, and event record commit atomically. The busy timeout is 5000 ms so an external busy writer fails predictably rather than spinning indefinitely.

On every open the adapter enables `foreign_keys=ON`, `busy_timeout=5000`, `journal_mode=WAL` (for file databases), `synchronous=FULL`, and `temp_store=MEMORY`. WAL allows readers alongside the single writer; `FULL` favors durable commits. Do not put the database on a network filesystem or share it between server instances. Production startup requires `SQLITE_PATH` under `/var/data` by default. Temporary Render free-tier testing may explicitly set `ALLOW_EPHEMERAL_SQLITE=true` and `SQLITE_PATH=/tmp/grudge-vault.sqlite`; the setting must exactly equal `true`, and then the path must be beneath `/tmp`. This does not change migration, transaction, or validation behavior. Relative `SQLITE_PATH` values resolve from the server package root (`apps/server`), not the caller's working directory; the default is `apps/server/data/grudge-vault.sqlite`.

The server synchronously applies all numbered SQL migrations inside the SQLite connection factory before Nest can construct `SqliteGameStore` or `GameService`. Each migration and its registry entry commit in one `BEGIN IMMEDIATE` transaction; failures roll back that migration and stop startup with the migration ID and resolved database path. Startup then validates required tables, columns, indexes, and existing foreign-key integrity. It does not depend on Nest lifecycle-hook ordering. The standalone `corepack pnpm --filter @grudge-vault/server migrate` command invokes the same migration runner and path resolution and is safe to rerun. Migration files are loaded from the server package's `migrations` directory in source and compiled deployments.

## Render disk, environment, backup, and recovery

Attach a persistent disk to the API web service with mount path `/var/data`, then configure:

```text
SQLITE_PATH=/var/data/grudge-vault.sqlite
WEB_ORIGIN=https://<deployed-web-origin>
```

Only files under Render's disk mount survive deploys/restarts; the SQLite file and its WAL must stay under that path. A Render persistent disk is available only on supported paid plans, is attached to one service instance, and prevents scaling the service to multiple instances. Disk-backed deploys also involve an instance swap with brief downtime. See [Render's persistent disk documentation](https://render.com/docs/disks) for current platform constraints.

The app applies pending migrations on startup after the disk is mounted. Do not use a build/pre-deploy command for migrations. The app creates the containing directory if missing. Production mode refuses a database path outside `/var/data`, except when the explicit `/tmp` testing opt-in described below is enabled.

### Ephemeral free-tier testing

Set `NODE_ENV=production`, `ALLOW_EPHEMERAL_SQLITE=true`, and `SQLITE_PATH=/tmp/grudge-vault.sqlite` only for temporary testing without a persistent disk. With the opt-in, startup allows SQLite only beneath `/tmp`; it does not switch to `:memory:`. Data in `/tmp` is not durable and can disappear after a restart, redeploy, or free-tier spin-down. Use a mounted `/var/data` disk and omit `ALLOW_EPHEMERAL_SQLITE` for any data that must persist.

For an application-consistent backup, set `SQLITE_BACKUP_PATH` to a destination different from `SQLITE_PATH` and run `corepack pnpm --filter @grudge-vault/server backup` in the live service environment. Relative `SQLITE_BACKUP_PATH` values also resolve from `apps/server`; absolute paths such as a separate mounted backup location are accepted. The script uses SQLite's online backup API so a consistent standalone database file can be created while the API is running. Copy that backup off the Render disk to separate durable storage, encrypt/restrict access, and regularly test restoring a copy. Render's periodic disk snapshots are an additional recovery layer, not a substitute for application-level database backups; see its docs for retention and limitations.

Recovery procedure:

1. Stop the API service to prevent writes.
2. Copy the selected verified backup to `/var/data/grudge-vault.sqlite` and ensure the service can read/write it.
3. Run the migration command in the mounted runtime (it is a no-op for an already-applied migration).
4. Restart the API. Startup recovery marks seats offline, pauses any still-active match, and restores the 60-second reconnect grace timer; existing paused deadlines remain in force.
5. Verify health, room/match state, and reconnect behavior before returning normal traffic.

If the database is corrupted, restore an application-consistent backup. Do not copy only the main SQLite file while the service is live; WAL changes may still be in flight. Preserve a damaged copy for diagnosis before replacement.

## Security and limits

- Never log or broadcast canonical JSON, Marks, reconnect tokens, room-code secrets, or deck order. Error responses do not expose SQL or filesystem details.
- Gateway validation plus repository validation protect against invalid IDs, non-members, wrong phases/turns, unavailable cards, invalid Hex targets, and duplicate requests.
- SQLite gives atomic writes and one local writer, not multi-host coordination. The instance-local mutex complements `BEGIN IMMEDIATE`; the latter is the database-level guard. Keep one API instance.
- Reconnect tokens remain valid for their room lifetime and are not rotated on reconnect. Token rotation/revocation UX should precede treating lost-device recovery as production-ready.
- The client stores its reconnect credential and current seat data in tab-scoped `sessionStorage`; it never receives opponent Marks or draw-pile contents. Public score previews are estimates because opponents' Mark bonuses remain hidden until completion.
- The client supports lobby creation/join, private Mark selection, drafting, Hex recipient selection, connection/reconnect states, and final results. Local two-browser Socket.IO flow has been exercised; real Render disk operations, restore drills, and production monitoring remain to be verified.

## Milestones

1. **Foundation and game engine (complete):** workspace, catalog, transitions, scoring, projections, pure-engine tests.
2. **Authoritative server and SQLite persistence (implemented):** private room lifecycle, runtime command validation, secret seat credentials, transactional actions, idempotency, recovery lifecycle, SQLite migration and repository tests.
3. **Playable web UI (implemented):** responsive lobby/table/results, Hex assignment, reconnect/loading/error states. Dedicated accessibility and device-level mobile QA remain outstanding.
4. **Production validation:** Render disk-backed deployment, live Socket.IO tests, backup/restore drill, operational health and alerting. Add Capacitor packaging later.
