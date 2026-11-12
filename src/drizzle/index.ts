import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  allowExitOnIdle: true,
})

export const pgsql = drizzle({
  client: pool,
  // logger: true,
});

