import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { getDbPath, getMigrationsDir } from '../paths.ts';

const dbPath = getDbPath();
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

const client = new DatabaseSync(dbPath);
client.exec('PRAGMA journal_mode = WAL');
client.exec('PRAGMA foreign_keys = ON');

export const db = drizzle({
  client,
  // logger: true,
});

// 启动时自动应用尚未执行的 SQL 迁移（幂等）
migrate(db, { migrationsFolder: getMigrationsDir() });

