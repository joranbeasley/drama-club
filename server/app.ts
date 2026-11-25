import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { authRoutes, HttpError, type GoogleVerifier } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { productionRoutes } from './productions.ts';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp(db: Db, cfg: Config, verify?: GoogleVerifier) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.production) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: cfg.maxBody }));
  // State-changing calls must be JSON: a cross-site form can't send that without a CORS preflight.
  api.use((req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !req.is('application/json')) {
      throw new HttpError(415, 'Send JSON');
    }
    next();
  });
  const auth = authRoutes(db, cfg, verify);
  api.use(auth.loadUser);
  api.use(auth.router);
  api.use('/productions', auth.requireUser, productionRoutes(db));
  api.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });
  api.use((_req, _res) => {
    throw new HttpError(404, 'Not found');
  });
  app.use('/api', api);

  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: cfg.production ? '1h' : 0 }));
  // Links from before productions moved to ?p=<id>.
  app.get('/p/:id', (req, res) => res.redirect(301, `/?p=${encodeURIComponent(req.params.id)}`));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...err.body });
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500) return void res.status(status).json({ error: err.type === 'entity.too.large' ? 'That production is too big to save' : err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  };
  app.use(onError);
  return app;
}
