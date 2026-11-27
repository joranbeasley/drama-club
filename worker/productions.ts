// Productions, stored so the Worker never parses a map: the JSON arrives as text, is stored in
// chunks, and is sent back spliced into the response. That keeps CPU time tiny however many
// pictures a production holds (the free plan allows 10 ms per request).
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, readJson } from './http.ts';

/** Characters per chunk. Worst case 3 bytes each in UTF-8: under D1's 2 MB per value. */
const CHUNK = 600_000;
/** Largest map accepted (characters). 40 chunks keeps a save within the free plan's 50 queries. */
export const MAX_GRAPH = 40 * CHUNK;

const SUMMARY = `id, title, version, created_at AS createdAt, updated_at AS updatedAt, node_count AS nodeCount`;
export interface Summary {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

function chunks(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let end = Math.min(i + CHUNK, s.length);
    // Never split a surrogate pair (an emoji) across chunks.
    const c = s.charCodeAt(end - 1);
    if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

function checkTitle(t: unknown): string {
  const s = typeof t === 'string' ? t.trim() : '';
  if (!s) throw new HttpError(400, 'Give the production a title');
  if (s.length > 200) throw new HttpError(400, 'That title is too long');
  return s;
}

/** The request body: a map's JSON, checked only for shape and size. */
async function readGraph(req: Request): Promise<{ text: string; nodeCount: number }> {
  const text = (await req.text()).trim();
  if (text.length > MAX_GRAPH) throw new HttpError(413, `That production is too big to save (${Math.round(text.length / 1e6)} MB; the limit is ${MAX_GRAPH / 1e6} MB). Use smaller or fewer pictures.`);
  if (!text.startsWith('{') || !text.endsWith('}') || !text.includes('"nodes"')) throw new HttpError(400, 'Send a node map: { "nodes": [...], "edges": [...] }');
  return { text, nodeCount: Math.max(0, Math.min(1e6, Number(req.headers.get('x-node-count')) || 0)) };
}

export const isId = (s: string) => /^[0-9a-f-]{36}$/.test(s);

/** A production's summary and its stored map (as text), or undefined if it isn't the user's. */
export async function loadProduction(db: D1Database, userId: number, id: string): Promise<{ meta: Summary; text: string } | undefined> {
  if (!isId(id)) return undefined;
  const meta = await db.prepare(`SELECT ${SUMMARY} FROM productions WHERE id = ? AND owner_id = ?`).bind(id, userId).first<Summary>();
  if (!meta) return undefined;
  const { results } = await db
    .prepare('SELECT data FROM production_chunks WHERE production_id = ? AND gen = (SELECT gen FROM productions WHERE id = ?) ORDER BY seq')
    .bind(id, id)
    .all<{ data: string }>();
  return { meta, text: results.map((r) => r.data).join('') || '{"version":1,"type":"drama2","nodes":[],"edges":[]}' };
}

/**
 * Save a map over `version` (or whatever is there, with `version: null`). New chunks, the version
 * check and the switch-over happen in one transaction: if the version moved on meanwhile,
 * nothing changes and the new chunks go with it. Returns the new summary, or null on a conflict.
 */
export async function saveProduction(db: D1Database, userId: number, id: string, text: string, nodeCount: number, version: number | null): Promise<Summary | null> {
  if (text.length > MAX_GRAPH) throw new HttpError(413, `That production is too big to save (${Math.round(text.length / 1e6)} MB; the limit is ${MAX_GRAPH / 1e6} MB)`);
  const gen = crypto.randomUUID();
  const parts = chunks(text);
  const results = await db.batch([
    ...parts.map((c, i) => db.prepare('INSERT INTO production_chunks (production_id, gen, seq, data) VALUES (?, ?, ?, ?)').bind(id, gen, i, c)),
    db
      .prepare(
        `UPDATE productions SET gen = ?, version = version + 1, node_count = ?, bytes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
         WHERE id = ? AND owner_id = ? AND (? OR version = ?)`,
      )
      .bind(gen, nodeCount, text.length, id, userId, version === null ? 1 : 0, version ?? 0),
    db.prepare('DELETE FROM production_chunks WHERE production_id = ? AND gen <> (SELECT gen FROM productions WHERE id = ?)').bind(id, id),
  ]);
  if (results[parts.length].meta.changes !== 1) return null;
  return db.prepare(`SELECT ${SUMMARY} FROM productions WHERE id = ? AND owner_id = ?`).bind(id, userId).first<Summary>();
}

export async function productionRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  const db = env.DB;
  const m = req.method;
  const url = new URL(req.url);
  const match = /^\/productions(?:\/([^/]+))?(\/graph)?$/.exec(path);
  if (!match) return undefined;
  const [, id, graphPath] = match;
  if (id && !isId(id)) throw new HttpError(404, 'No such production');

  const summary = (pid: string) => db.prepare(`SELECT ${SUMMARY} FROM productions WHERE id = ? AND owner_id = ?`).bind(pid, user.id).first<Summary>();
  const mustOwn = async (pid: string) => (await summary(pid)) ?? Promise.reject(new HttpError(404, 'No such production'));

  // List
  if (!id && m === 'GET') {
    const { results } = await db.prepare(`SELECT ${SUMMARY} FROM productions WHERE owner_id = ? ORDER BY updated_at DESC`).bind(user.id).all<Summary>();
    return json({ productions: results });
  }

  // Create: POST /productions?title=…, body = the map
  if (!id && m === 'POST') {
    const title = checkTitle(url.searchParams.get('title'));
    const { text, nodeCount } = await readGraph(req);
    const pid = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO productions (id, owner_id, title, gen, node_count, bytes) VALUES (?, ?, ?, ?, ?, ?)').bind(pid, user.id, title, gen, nodeCount, text.length),
      ...chunks(text).map((c, i) => db.prepare('INSERT INTO production_chunks (production_id, gen, seq, data) VALUES (?, ?, ?, ?)').bind(pid, gen, i, c)),
    ]);
    return json({ production: await summary(pid) }, 201);
  }

  if (!id) return undefined;

  // Open: the summary with the stored map spliced in, unparsed.
  if (!graphPath && m === 'GET') {
    const p = await loadProduction(db, user.id, id);
    if (!p) throw new HttpError(404, 'No such production');
    const head = JSON.stringify({ production: p.meta }).slice(0, -2); // drop the closing "}}"
    const body = `${head},"graph":${p.text}}}`;
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  // Save the map: PUT /productions/:id/graph?version=N (or ?force=1), body = the map.
  // New chunks, the version check and the switch-over happen in one transaction: if the
  // version moved on meanwhile, nothing changes and the new chunks are cleaned up with it.
  if (graphPath && m === 'PUT') {
    await mustOwn(id);
    const force = url.searchParams.get('force') === '1';
    const version = Number(url.searchParams.get('version'));
    if (!force && !Number.isInteger(version)) throw new HttpError(400, 'Send the version you are saving over');
    const { text, nodeCount } = await readGraph(req);
    const saved = await saveProduction(db, user.id, id, text, nodeCount, force ? null : version);
    if (!saved) throw new HttpError(409, 'This production was changed somewhere else since you opened it', { production: await summary(id) });
    return json({ production: saved });
  }

  // Rename: PATCH /productions/:id { title, version | force }
  if (!graphPath && m === 'PATCH') {
    await mustOwn(id);
    const b = await readJson(req);
    const title = checkTitle(b.title);
    if (!b.force && !Number.isInteger(b.version)) throw new HttpError(400, 'Send the version you are saving over');
    const r = await db
      .prepare(`UPDATE productions SET title = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ? AND owner_id = ? AND (? OR version = ?)`)
      .bind(title, id, user.id, b.force ? 1 : 0, Number(b.version) || 0)
      .run();
    if (r.meta.changes !== 1) throw new HttpError(409, 'This production was changed somewhere else since you opened it', { production: await summary(id) });
    return json({ production: await summary(id) });
  }

  if (!graphPath && m === 'DELETE') {
    // A whole production goes only from the app: a leaked token can't wipe one out.
    if (user.via === 'token') throw new HttpError(403, 'Productions can only be deleted in the app');
    await mustOwn(id);
    await db.prepare('DELETE FROM productions WHERE id = ? AND owner_id = ?').bind(id, user.id).run();
    return new Response(null, { status: 204 });
  }
  return undefined;
}
