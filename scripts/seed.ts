import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { seed } from '../src/db/seed.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://meridian:meridian@localhost:5432/meridian' });
try {
  console.log('seeded (rows in seed set):', await seed(drizzle(pool)));
} finally {
  await pool.end();
}
