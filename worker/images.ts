// Pictures in R2. The browser uploads a production's photos when it saves (raw bytes, already
// shrunk to ≤1024 px JPEG), and the production keeps a link (api/images/<hash>.<ext>) instead of
// the picture itself. Only people who uploaded a picture can fetch it.
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json } from './http.ts';

/** Raster types only: SVG could carry script, and served from our domain that would be unsafe. */
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MAX_IMAGE = 10 * 1024 * 1024;
const NAME = /^([0-9a-f]{64})\.(jpg|png|webp|gif)$/;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function imageRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  // Upload: POST /images, body = the picture.
  if (path === '/images' && req.method === 'POST') {
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) throw new HttpError(415, 'Send a JPEG, PNG, WebP or GIF picture');
    const body = await req.arrayBuffer();
    if (!body.byteLength) throw new HttpError(400, 'That picture is empty');
    if (body.byteLength > MAX_IMAGE) throw new HttpError(413, `Pictures can be up to ${MAX_IMAGE / 1024 / 1024} MB`);
    const name = `${hex(await crypto.subtle.digest('SHA-256', body))}.${ext}`;
    const key = `img/${name}`;
    // Stored once: someone may have uploaded the same picture already.
    if (!(await env.MEDIA.head(key))) await env.MEDIA.put(key, body, { httpMetadata: { contentType: type, cacheControl: 'private, max-age=31536000, immutable' } });
    await env.DB.prepare('INSERT OR IGNORE INTO image_owners (key, user_id, bytes) VALUES (?, ?, ?)').bind(key, user.id, body.byteLength).run();
    return json({ url: `api/images/${name}`, bytes: body.byteLength }, 201);
  }

  // Fetch: GET /images/<hash>.<ext>
  const m = /^\/images\/([^/]+)$/.exec(path);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!NAME.test(m[1])) throw new HttpError(404, 'No such picture');
    const key = `img/${m[1]}`;
    const mine = await env.DB.prepare('SELECT 1 FROM image_owners WHERE key = ? AND user_id = ?').bind(key, user.id).first();
    if (!mine) throw new HttpError(404, 'No such picture');
    // Pictures never change (the name is their hash): let the browser keep them.
    if (req.headers.get('if-none-match') === `"${m[1]}"`) return new Response(null, { status: 304, headers: { etag: `"${m[1]}"` } });
    const obj = await env.MEDIA.get(key);
    if (!obj) throw new HttpError(404, 'No such picture');
    return new Response(req.method === 'HEAD' ? null : obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'content-length': String(obj.size),
        etag: `"${m[1]}"`,
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  }
  return undefined;
}
