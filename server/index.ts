import { createApp } from './app.ts';
import { googleVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);

const app = createApp(db, cfg, cfg.googleClientId ? googleVerifier(cfg.googleClientId) : undefined);
const server = app.listen(cfg.port, () => {
  console.log(`Drama Club on http://localhost:${cfg.port}` + (cfg.devLogin ? ' (dev login on)' : ''));
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    void db.end().then(() => process.exit(0));
  });
}
