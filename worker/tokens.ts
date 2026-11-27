// Personal API tokens: made and revoked in the app (signed in with Google), used by agents and
// scripts as `Authorization: Bearer dc_…`. Tokens can't manage tokens.
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, readJson, sha256hex } from './http.ts';

const PREFIX = 'dc_';

/** The user behind a bearer token, or null. Marks it used (at most once a minute). */
export async function tokenUser(req: Request, env: Env): Promise<User | null> {
  const m = /^Bearer\s+(dc_[A-Za-z0-9_-]{20,})\s*$/.exec(req.headers.get('authorization') ?? '');
  if (!m) return null;
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, t.id AS tokenId, t.last_used_at AS lastUsed FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
  )
    .bind(hash)
    .first<User & { tokenId: string; lastUsed: string | null }>();
  if (!row) return null;
  if (!row.lastUsed || Date.now() - Date.parse(row.lastUsed) > 60_000) {
    await env.DB.prepare(`UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?`).bind(row.tokenId).run();
  }
  return { id: row.id, email: row.email, name: row.name, picture: row.picture, via: 'token' };
}

/** /api/tokens: list, make and revoke your tokens (signed in in the app, not with a token). */
export async function tokenRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  const m = /^\/tokens(?:\/([\w-]+))?$/.exec(path);
  if (!m) return undefined;
  if (user.via === 'token') throw new HttpError(403, 'API tokens are managed in the app, not with a token');
  if (!m[1] && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all();
    return json({ tokens: results });
  }
  if (!m[1] && req.method === 'POST') {
    const name = String((await readJson(req)).name ?? '').trim().slice(0, 80) || 'API token';
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash) VALUES (?, ?, ?, ?)').bind(id, user.id, name, await sha256hex(token)).run();
    // The only time the token is shown.
    return json({ id, name, token }, 201);
  }
  if (m[1] && req.method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(m[1], user.id).run();
    if (!r.meta.changes) throw new HttpError(404, 'No such token');
    return new Response(null, { status: 204 });
  }
  return undefined;
}
