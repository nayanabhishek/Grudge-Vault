import { mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Sqlite from 'better-sqlite3';
import { applySqliteMigrations } from './sqlite-migrations.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredPath = process.env.SQLITE_PATH ?? './data/grudge-vault.sqlite';
const absolutePath = configuredPath === ':memory:' ? configuredPath : resolve(serverRoot, configuredPath);
if (process.env.NODE_ENV === 'production' && !absolutePath.startsWith(resolve('/var/data') + sep)) {
  throw new Error('In production set SQLITE_PATH to a file beneath the Render persistent disk mount /var/data.');
}
if (absolutePath !== ':memory:') mkdirSync(dirname(absolutePath), { recursive: true });
console.log(`SQLite database path: ${absolutePath}`);
const db = new Sqlite(absolutePath);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
if (absolutePath !== ':memory:') db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
try {
  const applied = applySqliteMigrations(db, resolve(serverRoot, 'migrations'), absolutePath);
  console.log(`SQLite schema ready; migrations applied: ${applied.join(', ')}.`);
} finally {
  db.close();
}
