# Grudge Vault

Grudge Vault is a mobile-first multiplayer card game for 2–4 players. The pnpm monorepo contains a React/Vite client, an authoritative NestJS/Socket.IO server, and an independent TypeScript game engine.

## Current status

The shared engine, Phase 2 authoritative server, and Phase 3 playable web client are implemented. The server persists matches in SQLite using `better-sqlite3`. The client supports private rooms, lobby Marks, live Vault drafting, Hex assignment, reconnect states, and final results.

See [docs/architecture.md](docs/architecture.md) for game contracts, security, SQLite transaction settings, Render persistent-disk setup, migrations, backups, and recovery.

## Requirements and setup

- Node.js 18 or newer
- pnpm 9 (the repository pins 9.15.9 through Corepack)
- SQLite database file path writable by the API process

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

For local development, set `SQLITE_PATH=./data/grudge-vault.sqlite` and `WEB_ORIGIN` to the allowed browser origin. Relative database paths are resolved from `apps/server`, regardless of the shell's current directory. Startup applies pending migrations to the same resolved database before constructing game services; the standalone `corepack pnpm --filter @grudge-vault/server migrate` command uses that same path and is safe to rerun. Start the API with `corepack pnpm --filter @grudge-vault/server dev` and the client with `corepack pnpm --filter @grudge-vault/web dev`.

## Render persistence

Attach a persistent disk to the single API web service at mount path `/var/data`, then set `SQLITE_PATH=/var/data/grudge-vault.sqlite`. Do not store production data in the repository, working directory, or another ephemeral path. A Render disk requires a plan that supports persistent disks and prevents scaling this service to multiple instances; see the [Render persistent disk docs](https://render.com/docs/disks).

For temporary free-tier testing only, production can explicitly opt in to ephemeral SQLite by setting both `ALLOW_EPHEMERAL_SQLITE=true` and `SQLITE_PATH=/tmp/grudge-vault.sqlite`. The opt-in value is case-sensitive and must be exactly `true`; with it enabled, startup rejects every database path outside `/tmp`. SQLite migrations and transaction safeguards still apply, but `/tmp` is ephemeral: rooms and matches can disappear after a restart, redeploy, or free-tier spin-down. Do not use this mode for matches or data you need to retain. Without the opt-in, production continues to require a database path beneath `/var/data`.

Set `WEB_ORIGIN` to the deployed frontend origin. On startup, the API applies pending migrations on the mounted disk before it serves requests. Do not run migrations in the build phase, which cannot access the mounted disk.

## Backup and restore

To create a consistent SQLite backup, set `SQLITE_BACKUP_PATH` to a different destination and run `corepack pnpm --filter @grudge-vault/server backup` in the service environment. Copy the resulting file off the Render disk to durable storage and periodically verify it by restoring to a separate test database.

For recovery, stop the API, copy the chosen backup to `/var/data/grudge-vault.sqlite`, ensure the file is owned and writable by the service, run the migration command, and restart the API. On startup active matches are paused and the normal 60-second reconnect recovery lifecycle applies. Keep Render disk snapshots as an additional recovery option, not a replacement for application-consistent SQLite backups.

## Server protocol and verification

The API handles room create/join/state/leave, private Mark selection, match start, card takes/Hex transfers, reconnect, and sync. Commands are validated at runtime, tied to the authenticated socket seat, and acknowledged with structured results. Reconnect tokens are returned only to their seat and only hashes are stored.

`corepack pnpm test` runs pure-engine tests, server lifecycle/authorization tests using a deterministic store, and SQLite-backed transaction, idempotency, and concurrent-turn tests. The SQLite tests use a real in-memory SQLite database with the production migration schema. Run the client and API locally with the commands above. The client proxies `/socket.io` to `127.0.0.1:3000` during local development; set `VITE_SERVER_URL` to use another API origin. Browser Socket.IO flow has been exercised locally with two isolated browser sessions. A live Render deployment and restore drill remain outstanding.
