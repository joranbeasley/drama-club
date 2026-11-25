// npm run migrate: apply pending migrations and exit. The server also migrates on start.
import { createPool, migrate } from './db.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = createPool(url);
await migrate(db);
await db.end();
