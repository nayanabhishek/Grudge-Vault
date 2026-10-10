import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Sqlite from 'better-sqlite3';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredPath = process.env.SQLITE_PATH ?? './data/grudge-vault.sqlite';
const destination = process.env.SQLITE_BACKUP_PATH;
if (!destination) throw new Error('Set SQLITE_BACKUP_PATH to the backup file destination.');
const sourcePath = configuredPath === ':memory:' ? configuredPath : resolve(serverRoot, configuredPath);
const backupPath = resolve(serverRoot, destination);
if (sourcePath === backupPath) throw new Error('Backup destination must differ from SQLITE_PATH.');
mkdirSync(dirname(backupPath), { recursive: true });
const db = new Sqlite(sourcePath, { readonly: true, fileMustExist: true });
try {
  await db.backup(backupPath);
  console.log(`Consistent SQLite backup written to ${backupPath}. Copy it off the Render disk to durable object storage.`);
} finally {
  db.close();
}
