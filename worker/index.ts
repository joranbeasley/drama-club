// Drama Club on Cloudflare Workers: /api/* here, everything else from the static assets (public/).
import { authRoute, currentUser } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json } from './http.ts';
import { productionRoute } from './productions.ts';

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' };

async function api(req: Request, env: Env, path: string): Promise<Response> {
  if (path === '/health') {
    await env.DB.prepare('SELECT 1').first();
    return json({ ok: true });
  }
  // State-changing calls must be JSON: a cross-site form can't send that without a CORS preflight.
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !(req.headers.get('content-type') ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON');
  }
  const user = await currentUser(req, env);
  const res = (await authRoute(req, env, path, user)) ?? (path.startsWith('/productions') ? await withUser(user, (u) => productionRoute(req, env, path, u)) : undefined);
  if (!res) throw new HttpError(404, 'Not found');
  return res;
}

function withUser<T>(user: Awaited<ReturnType<typeof currentUser>>, fn: (u: NonNullable<typeof user>) => T): T {
  if (!user) throw new HttpError(401, 'Please sign in');
  return fn(user);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    let res: Response;
    try {
      res = await api(req, env, url.pathname.slice(4));
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message, ...err.body }, err.status);
      else {
        console.error(err);
        res = json({ error: 'Something went wrong on the server' }, 500);
      }
    }
    for (const [k, v] of Object.entries(SECURITY)) res.headers.set(k, v);
    res.headers.set('cache-control', 'no-store');
    return res;
  },
} satisfies ExportedHandler<Env>;
