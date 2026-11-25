import { Router } from 'express';
import { HttpError } from './auth.ts';
import type { Db } from './db.ts';

/** Just enough checking that what we store is a mobile-nodemap GraphJSON. */
function checkGraph(g: unknown): Record<string, unknown> {
  const o = g as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.nodes) || !Array.isArray(o.edges ?? [])) {
    throw new HttpError(400, 'graph must be a node map: { nodes: [...], edges: [...] }');
  }
  return o;
}

function checkTitle(t: unknown): string {
  const s = typeof t === 'string' ? t.trim() : '';
  if (!s) throw new HttpError(400, 'Give the production a title');
  if (s.length > 200) throw new HttpError(400, 'That title is too long');
  return s;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const SUMMARY = `id, title, version, created_at AS "createdAt", updated_at AS "updatedAt",
  jsonb_array_length(graph->'nodes') AS "nodeCount"`;

/** /api/productions: each user's own productions. Requires a signed-in user. */
export function productionRoutes(db: Db) {
  const router = Router();

  router.param('id', (_req, _res, next, id: string) => {
    if (!isUuid(id)) throw new HttpError(404, 'No such production');
    next();
  });

  router.get('/', async (req, res) => {
    const { rows } = await db.query(`SELECT ${SUMMARY} FROM productions WHERE owner_id = $1 ORDER BY updated_at DESC`, [req.user!.id]);
    res.json({ productions: rows });
  });

  router.post('/', async (req, res) => {
    const title = checkTitle(req.body?.title);
    const graph = checkGraph(req.body?.graph ?? { version: 1, type: 'drama2', nodes: [], edges: [] });
    const { rows } = await db.query(`INSERT INTO productions (owner_id, title, graph) VALUES ($1, $2, $3) RETURNING ${SUMMARY}, graph`, [req.user!.id, title, graph]);
    res.status(201).json({ production: rows[0] });
  });

  router.get('/:id', async (req, res) => {
    const { rows } = await db.query(`SELECT ${SUMMARY}, graph FROM productions WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user!.id]);
    if (!rows[0]) throw new HttpError(404, 'No such production');
    res.json({ production: rows[0] });
  });

  /**
   * Save. Send the `version` you loaded; if someone saved since (another tab or device) the
   * save is refused with 409 and the current version, so nothing is silently overwritten.
   * Send `force: true` to overwrite anyway.
   */
  router.put('/:id', async (req, res) => {
    const b = req.body ?? {};
    const title = b.title === undefined ? null : checkTitle(b.title);
    const graph = b.graph === undefined ? null : checkGraph(b.graph);
    if (!b.force && !Number.isInteger(b.version)) throw new HttpError(400, 'Send the version you are saving over');
    const { rows } = await db.query(
      `UPDATE productions SET title = COALESCE($3, title), graph = COALESCE($4, graph), version = version + 1, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND ($5::int IS NULL OR version = $5)
       RETURNING ${SUMMARY}`,
      [req.params.id, req.user!.id, title, graph, b.force ? null : b.version],
    );
    if (rows[0]) return void res.json({ production: rows[0] });
    const cur = await db.query(`SELECT ${SUMMARY} FROM productions WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user!.id]);
    if (!cur.rows[0]) throw new HttpError(404, 'No such production');
    throw new HttpError(409, 'This production was changed somewhere else since you opened it', { production: cur.rows[0] });
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await db.query('DELETE FROM productions WHERE id = $1 AND owner_id = $2', [req.params.id, req.user!.id]);
    if (!rowCount) throw new HttpError(404, 'No such production');
    res.status(204).end();
  });

  return router;
}
