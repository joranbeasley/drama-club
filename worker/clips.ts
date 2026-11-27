// Finished clips, copied into R2 from the service that made them, so they last (service links
// expire) and the app can read them from its own site (for the last frame, and to play them).
//
//   POST /api/clips { url }      copy a clip from an allowed service; → { url: 'api/clips/<id>.mp4' }
//   GET  /api/clips/<id>.mp4     play it (owners only), with Range support for seeking
// Sound (🎙 Fixed voices: the music and the changed voices) is kept the same way, as .mp3/.wav/.m4a.
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, readJson } from './http.ts';

export const MAX_CLIP = 300 * 1024 * 1024;
/** Where clips may be copied from: fal's file servers. */
const ALLOWED = [/(^|\.)fal\.media$/];
/** What can be kept, by extension. */
const TYPES: Record<string, string> = { mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
function extOf(type: string, url: URL): string {
  if (/^video\//.test(type)) return 'mp4';
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3';
  if (/^audio\/(x-)?wav/.test(type)) return 'wav';
  if (type === 'audio/mp4' || type === 'audio/x-m4a' || type === 'audio/aac') return 'm4a';
  const byName = /\.(mp3|wav|m4a|mp4)$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (type === 'application/octet-stream' || /^audio\//.test(type)) return byName ?? 'mp4';
  throw new HttpError(400, 'That isn’t a video or a sound');
}

function allowed(env: Env, raw: unknown): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new HttpError(400, 'Give the clip’s URL');
  }
  // Local development (and tests) may copy from a local server.
  const local = env.DEV_LOGIN === '1' && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (!local && (u.protocol !== 'https:' || !ALLOWED.some((re) => re.test(u.hostname)))) throw new HttpError(400, 'Clips can only be copied from fal');
  return u;
}

export async function clipRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  if (path === '/clips' && req.method === 'POST') {
    const source = allowed(env, (await readJson(req)).url);
    // Already copied (the same clip collected twice): hand back the copy.
    const had = await env.DB.prepare('SELECT key FROM clips WHERE user_id = ? AND source = ?').bind(user.id, source.href).first<{ key: string }>();
    if (had) return json({ url: `api/${had.key}` });
    const res = await fetch(source.href);
    if (!res.ok || !res.body) throw new HttpError(502, `Couldn’t fetch the clip (${res.status}); its link may have expired`);
    const type = (res.headers.get('content-type') ?? 'video/mp4').split(';')[0];
    const ext = extOf(type, source);
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_CLIP) throw new HttpError(413, 'That clip is too big to keep');
    const key = `clips/${crypto.randomUUID()}.${ext}`;
    // Streamed straight into R2 (no copy in memory) when the size is known.
    let body: ReadableStream | ArrayBuffer = res.body;
    if (Number.isFinite(length) && length > 0) {
      const fixed = new FixedLengthStream(length);
      void res.body.pipeTo(fixed.writable);
      body = fixed.readable;
    } else {
      body = await res.arrayBuffer();
      if (body.byteLength > MAX_CLIP) throw new HttpError(413, 'That clip is too big to keep');
    }
    const obj = await env.MEDIA.put(key, body, { httpMetadata: { contentType: TYPES[ext], cacheControl: 'private, max-age=31536000, immutable' } });
    await env.DB.prepare('INSERT INTO clips (key, user_id, bytes, source) VALUES (?, ?, ?, ?)').bind(key, user.id, obj?.size ?? 0, source.href).run();
    return json({ url: `api/${key}` }, 201);
  }

  const m = /^\/clips\/([0-9a-f-]{36})\.(mp4|mp3|wav|m4a)$/.exec(path);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const key = `clips/${m[1]}.${m[2]}`;
    if (!(await env.DB.prepare('SELECT 1 FROM clips WHERE key = ? AND user_id = ?').bind(key, user.id).first())) throw new HttpError(404, 'No such clip');
    // Seeking (and Safari, which always asks for ranges) needs Range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    const head = await env.MEDIA.head(key);
    if (!head) throw new HttpError(404, 'No such clip');
    const size = head.size;
    const headers: Record<string, string> = { 'content-type': TYPES[m[2]], 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable', etag: head.httpEtag };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      const part = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
      return new Response(req.method === 'HEAD' ? null : part!.body, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      });
    }
    const obj = await env.MEDIA.get(key);
    return new Response(req.method === 'HEAD' ? null : obj!.body, { headers: { ...headers, 'content-length': String(size) } });
  }
  return undefined;
}
