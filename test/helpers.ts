import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

export async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: 'drizzle' });
  return { client, db };
}
