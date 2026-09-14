import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { buildApp } from './app.js';
import { db } from './db/index.js';
import { seed } from './db/seed.js';
import { env } from './lib/env.js';

const app = await buildApp();

if (process.env.SKIP_MIGRATIONS !== '1') {
  try {
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    await seed(db);
    app.log.info('migrations applied');
  } catch (e) {
    app.log.error({ err: e }, 'migration failed');
    if (env.NODE_ENV === 'production') process.exit(1);
  }
}

await app.listen({ port: env.PORT, host: env.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
