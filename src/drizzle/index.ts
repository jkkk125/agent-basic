import { config } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

// 以 .env 为准：避免 shell 里遗留的 DATABASE_URL（如旧的 postgres 连接串）覆盖本地 sqlite 路径
config({ override: true });

const dbPath = resolve(process.env.DATABASE_URL ?? './data/agent.db');
mkdirSync(dirname(dbPath), { recursive: true });

const client = new DatabaseSync(dbPath);
client.exec('PRAGMA journal_mode = WAL');
client.exec('PRAGMA foreign_keys = ON');

export const db = drizzle({
  client,
  // logger: true,
});

