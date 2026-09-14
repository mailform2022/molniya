import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './index.js';
import { seed } from './seed.js';

await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
await seed(db);
await sql.end();
console.log('migrations + seed done');
