import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { emailAllowed, type Config } from './config.ts';
import type { Db } from './db.ts';

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string | null;
}

/** A verified Google identity. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}
/** Checks a Google ID token (from Sign in with Google) and returns who it belongs to. */
export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

export function googleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('Google did not return an email address');
    if (!p.email_verified) throw new Error('That Google account has no verified email address');
    return { sub: p.sub, email: p.email, name: p.name ?? p.email, picture: p.picture };
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

const COOKIE = 'dc_session';
const hash = (token: string) => createHash('sha256').update(token).digest();

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export class HttpError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function authRoutes(db: Db, cfg: Config, verify?: GoogleVerifier) {
  const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: cfg.production, path: '/', maxAge: cfg.sessionDays * 864e5 };

  async function startSession(res: Response, userId: number) {
    const token = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [hash(token), userId, cfg.sessionDays]);
    // Housekeeping: drop expired sessions now and then.
    if (Math.random() < 0.05) await db.query('DELETE FROM sessions WHERE expires_at < now()');
    res.cookie(COOKIE, token, cookieOpts);
  }

  /** Sets req.user when the request has a live session. */
  async function loadUser(req: Request, _res: Response, next: NextFunction) {
    const token = readCookie(req, COOKIE);
    if (token) {
      const { rows } = await db.query<User>(
        `SELECT u.id::int AS id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hash(token)],
      );
      req.user = rows[0];
    }
    next();
  }

  function requireUser(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    next();
  }

  const router = Router();

  // What the sign-in page needs to know.
  router.get('/config', (_req, res) => {
    res.json({ googleClientId: cfg.googleClientId ?? null, devLogin: cfg.devLogin });
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ?? null });
  });

  // Sign in with Google: the browser posts the ID token the Google button gave it.
  router.post('/auth/google', async (req, res) => {
    if (!verify) throw new HttpError(404, 'Google sign-in is not configured');
    const credential = req.body?.credential;
    if (typeof credential !== 'string') throw new HttpError(400, 'Missing credential');
    let who: GoogleIdentity;
    try {
      who = await verify(credential);
    } catch (err) {
      throw new HttpError(401, `Google sign-in failed: ${(err as Error).message}`);
    }
    if (!emailAllowed(cfg, who.email)) throw new HttpError(403, `${who.email} is not on this club's list. Ask an organiser to add you.`);
    // Match on Google's account id; fall back to the email so a user invited by email links up.
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO users (google_sub, email, name, picture) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(email)) DO UPDATE SET google_sub = EXCLUDED.google_sub, name = EXCLUDED.name, picture = EXCLUDED.picture, last_login = now()
       RETURNING id::int AS id`,
      [who.sub, who.email, who.name, who.picture ?? null],
    );
    await startSession(res, rows[0].id);
    res.json({ ok: true });
  });

  // Local development only: sign in as any email, no password.
  if (cfg.devLogin) {
    router.post('/auth/dev', async (req, res) => {
      const email = String(req.body?.email ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter an email address');
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO users (email, name) VALUES ($1, $2)
         ON CONFLICT (lower(email)) DO UPDATE SET last_login = now() RETURNING id::int AS id`,
        [email, email.split('@')[0]],
      );
      await startSession(res, rows[0].id);
      res.json({ ok: true });
    });
  }

  router.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true });
  });

  return { router, loadUser, requireUser };
}
