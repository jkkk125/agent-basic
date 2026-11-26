import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// 以 .env 为准：避免 shell 里遗留的 DATABASE_URL（如旧的 postgres 连接串）覆盖本地 sqlite 路径
config({ override: true });

const url = './data/agent.db';
if (!url) throw new Error('DATABASE_URL 未配置');

export default defineConfig({
  dbCredentials: {
    url,
  },
  dialect: 'sqlite',
  schema: './src/drizzle/schema.ts',
  out: './src/drizzle/migrations',
})