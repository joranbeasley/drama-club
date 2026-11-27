import { emailAllowed } from './allow.ts';
import type { Env } from './env.ts';
import { verifyGoogleToken } from './google.ts';
import { HttpError, json, readCookie, readJson, sha256hex } from './http.ts';
import { tokenUser } from './tokens.ts';

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string | null;
  /** How the request signed in: the app's session cookie, or an API token. */
  via?: 'session' | 'token';
}

const COOKIE = 'dc_session';
const days = (env: Env) => Number(env.SESSION_DAYS) || 30;

function cookie(req: Request, value: string, maxAge: number) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  if (req.headers.has('authorization')) return tokenUser(req, env);
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ')`,
  )
    .bind(await sha256hex(token))
    .first<User>();
  return user && { ...user, via: 'session' };
}

async function startSession(req: Request, env: Env, userId: number): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const d = days(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`).bind(
      await sha256hex(token),
      userId,
      `+${d} days`,
    ),
    // Housekeeping: drop this user's expired sessions.
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ')`).bind(userId),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': cookie(req, token, d * 86400) });
}

const devLogin = (req: Request, env: Env) => env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);

/** /api/config, /api/me and /api/auth/*. Returns undefined for other paths. */
export async function authRoute(req: Request, env: Env, path: string, user: User | null): Promise<Response | undefined> {
  const m = req.method;
  if (m === 'GET' && path === '/config') return json({ googleClientId: env.GOOGLE_CLIENT_ID || null, devLogin: devLogin(req, env) });
  if (m === 'GET' && path === '/me') return json({ user });

  if (m === 'POST' && path === '/auth/google') {
    if (!env.GOOGLE_CLIENT_ID) throw new HttpError(404, 'Google sign-in is not configured');
    const { credential } = await readJson(req);
    if (typeof credential !== 'string') throw new HttpError(400, 'Missing credential');
    let who;
    try {
      who = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID);
    } catch (err) {
      throw new HttpError(401, `Google sign-in failed: ${(err as Error).message}`);
    }
    if (!emailAllowed(env, who.email)) throw new HttpError(403, `${who.email} is not on this club's list. Ask an organiser to add you.`);
    // Match on the email so a user invited (or first seen) by email links up with their Google account.
    const row = await env.DB.prepare(
      `INSERT INTO users (google_sub, email, name, picture) VALUES (?, ?, ?, ?)
       ON CONFLICT (lower(email)) DO UPDATE SET google_sub = excluded.google_sub, name = excluded.name, picture = excluded.picture,
         last_login = strftime('%Y-%m-%dT%H:%M:%fZ')
       RETURNING id`,
    )
      .bind(who.sub, who.email, who.name, who.picture ?? null)
      .first<{ id: number }>();
    return startSession(req, env, row!.id);
  }

  if (m === 'POST' && path === '/auth/dev') {
    if (!devLogin(req, env)) throw new HttpError(404, 'Not found');
    const email = String((await readJson(req)).email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter an email address');
    const row = await env.DB.prepare(
      `INSERT INTO users (email, name) VALUES (?, ?)
       ON CONFLICT (lower(email)) DO UPDATE SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ') RETURNING id`,
    )
      .bind(email, email.split('@')[0])
      .first<{ id: number }>();
    return startSession(req, env, row!.id);
  }

  if (m === 'POST' && path === '/auth/logout') {
    const token = readCookie(req, COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(req, '', 0) });
  }
  return undefined;
}
