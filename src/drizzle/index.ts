import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

const dbPath = resolve('./data/agent.db');
mkdirSync(dirname(dbPath), { recursive: true });

const client = new DatabaseSync(dbPath);
client.exec('PRAGMA journal_mode = WAL');
client.exec('PRAGMA foreign_keys = ON');

export const db = drizzle({
  client,
  // logger: true,
});

