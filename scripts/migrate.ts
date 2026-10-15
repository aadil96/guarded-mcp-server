import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://meridian:meridian@localhost:5432/meridian' });
try {
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
  console.log('migrations applied');
} finally {
  await pool.end();
}
