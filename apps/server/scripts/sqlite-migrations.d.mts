import type { Database as SqliteDatabase } from 'better-sqlite3';

export function applySqliteMigrations(db: SqliteDatabase, migrationsDirectory: string, databasePath: string): string[];
