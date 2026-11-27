// What made each picture and clip, kept for 7 days.
//
//   POST /api/productions/<id>/generations  a record (JSON, as the app sends it)  → 201
//   GET  /api/productions/<id>/generations?node=<id>&param=<name>  → { generations: [...] }, newest first
//
// Records are stored as text, not parsed beyond the two fields they're found by. Expired rows
// are deleted whenever a new one arrives, so nothing needs to run on a schedule.
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json } from './http.ts';

export const KEEP_DAYS = 7;
const MAX_RECORD = 64 * 1024;
const LIST = 30;

export async function generationRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  const m = /^\/productions\/([^/]+)\/generations$/.exec(path);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]);
  const own = await env.DB.prepare('SELECT 1 FROM productions WHERE id = ? AND owner_id = ?').bind(id, user.id).first();
  if (!own) throw new HttpError(404, 'No such production');
  const now = new Date();

  if (req.method === 'POST') {
    const text = await req.text();
    if (text.length > MAX_RECORD) throw new HttpError(413, 'That record is too big');
    let rec: { node?: unknown; param?: unknown };
    try {
      rec = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Send the record as JSON');
    }
    if (typeof rec.node !== 'string' || typeof rec.param !== 'string' || !rec.node || !rec.param) throw new HttpError(400, 'A record needs its node and param');
    const expires = new Date(now.getTime() + KEEP_DAYS * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO generations (production_id, node, param, data, expires_at) VALUES (?, ?, ?, ?, ?)').bind(id, rec.node, rec.param, text, expires),
      env.DB.prepare('DELETE FROM generations WHERE expires_at < ?').bind(now.toISOString()),
    ]);
    return json({ ok: true }, 201);
  }

  if (req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    const node = q.get('node');
    const param = q.get('param');
    if (!node || !param) throw new HttpError(400, 'Say which node and param');
    const rows = await env.DB.prepare(
      'SELECT data FROM generations WHERE production_id = ? AND node = ? AND param = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT ?',
    )
      .bind(id, node, param, now.toISOString(), LIST)
      .all<{ data: string }>();
    // Stored as sent: joined, not parsed.
    return new Response(`{"generations":[${(rows.results ?? []).map((r) => r.data).join(',')}]}`, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return undefined;
}
