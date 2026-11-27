import { defineConfig } from 'drizzle-kit';
import { getDbPath } from './src/paths.ts';

export default defineConfig({
  dbCredentials: {
    url: getDbPath(),
  },
  dialect: 'sqlite',
  schema: './src/drizzle/schema.ts',
  out: './src/drizzle/migrations',
});