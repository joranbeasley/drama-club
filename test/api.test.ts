// End-to-end API tests: the real Worker in `wrangler dev`, with a throwaway local D1.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8790;
const base = `http://127.0.0.1:${PORT}/api`;
let wrangler: ChildProcess;
const state = mkdtempSync(join(tmpdir(), 'dramaclub-test-'));

before(async () => {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'dramaclub', '--local', '--persist-to', state], { stdio: 'ignore' });
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', 'DEV_LOGIN:1', '--show-interactive-dev-session=false'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});
after(() => {
  if (wrangler.pid) process.kill(-wrangler.pid);
  rmSync(state, { recursive: true, force: true });
});

const req = async (method: string, path: string, opts: { body?: unknown; raw?: string; cookie?: string; headers?: Record<string, string> } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(opts.body !== undefined || opts.raw ? { 'content-type': 'application/json' } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const signIn = async (email: string) => {
  const r = await req('POST', '/auth/dev', { body: { email } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie!;
};
const map = (n: number, extra = '') => ({ version: 1, type: 'drama2', nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'drama2/prop', x: 0, y: 0, params: { note: extra } })), edges: [] });
const send = (method: string, path: string, g: ReturnType<typeof map>, cookie: string) =>
  req(method, path, { raw: JSON.stringify(g), cookie, headers: { 'x-node-count': String(g.nodes.length) } });

const expect201 = (status: number) => assert.equal(status, 201);

describe('api on workers', () => {
  it('has sessions', async () => {
    assert.equal((await req('GET', '/me')).body.user, null);
    const c = await signIn('ana@club.test');
    assert.equal((await req('GET', '/me', { cookie: c })).body.user.email, 'ana@club.test');
    assert.equal((await req('POST', '/auth/google', { body: { credential: 'x' } })).status, 404, 'no client id configured');
    assert.equal((await req('POST', '/auth/logout', { body: {}, cookie: c })).status, 200);
    assert.equal((await req('GET', '/me', { cookie: c })).body.user, null);
    assert.equal((await req('POST', '/auth/dev', { raw: 'email=a@b.c', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  });

  it('keeps productions private to their owner', async () => {
    const ana = await signIn('ana@club.test');
    const ben = await signIn('ben@club.test');
    assert.equal((await req('GET', '/productions')).status, 401);
    const made = await send('POST', `/productions?title=${encodeURIComponent('Spring ✨')}`, map(1), ana);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.production.id;
    assert.equal(made.body.production.title, 'Spring ✨');
    assert.equal((await req('GET', '/productions', { cookie: ana })).body.productions[0].nodeCount, 1);
    assert.deepEqual((await req('GET', `/productions/${id}`, { cookie: ana })).body.production.graph, map(1));
    assert.equal((await req('GET', `/productions/${id}`, { cookie: ben })).status, 404);
    assert.equal((await send('PUT', `/productions/${id}/graph?force=1`, map(3), ben)).status, 404);
    assert.equal((await req('PATCH', `/productions/${id}`, { body: { title: 'Mine', force: true }, cookie: ben })).status, 404);
    assert.equal((await req('DELETE', `/productions/${id}`, { cookie: ben })).status, 404);
    assert.equal((await req('GET', '/productions', { cookie: ben })).body.productions.length, 0);
    assert.equal((await req('POST', '/productions?title=x', { raw: '[1,2]', cookie: ana })).status, 400);
  });

  it('stores big maps in chunks, with emoji on the boundaries intact', async () => {
    const ana = await signIn('ana@club.test');
    // ~2.5M characters: several chunks, full of surrogate pairs.
    const big = map(5, '🎬'.repeat(250_000) + 'é');
    const made = await send('POST', '/productions?title=Big', big, ana);
    assert.equal(made.status, 201);
    const back = await req('GET', `/productions/${made.body.production.id}`, { cookie: ana });
    assert.deepEqual(back.body.production.graph, big);
  });

  it('refuses saves over a newer version unless forced, and renames', async () => {
    const ana = await signIn('ana@club.test');
    const { production: p } = (await send('POST', '/productions?title=Autumn', map(0), ana)).body;
    const first = await send('PUT', `/productions/${p.id}/graph?version=${p.version}`, map(1), ana);
    assert.equal(first.status, 200);
    assert.equal(first.body.production.version, p.version + 1);
    const stale = await send('PUT', `/productions/${p.id}/graph?version=${p.version}`, map(2), ana);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.production.version, p.version + 1);
    // The refused save left the stored map alone.
    assert.deepEqual((await req('GET', `/productions/${p.id}`, { cookie: ana })).body.production.graph, map(1));
    const forced = await send('PUT', `/productions/${p.id}/graph?force=1`, map(2), ana);
    assert.equal(forced.body.production.nodeCount, 2);
    const renamed = await req('PATCH', `/productions/${p.id}`, { body: { title: 'Winter', version: forced.body.production.version }, cookie: ana });
    assert.equal(renamed.body.production.title, 'Winter');
    assert.equal((await req('PATCH', `/productions/${p.id}`, { body: { title: 'Old', version: 1 }, cookie: ana })).status, 409);
    assert.equal((await req('DELETE', `/productions/${p.id}`, { cookie: ana })).status, 204);
    assert.equal((await req('GET', `/productions/${p.id}`, { cookie: ana })).status, 404);
  });

  it('stores pictures in R2, once each, for their owners only', async () => {
    const ana = await signIn('ana@club.test');
    const ben = await signIn('ben@club.test');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const up = (cookie: string, body: BodyInit, type = 'image/png') => fetch(base + '/images', { method: 'POST', headers: { 'content-type': type, cookie }, body });
    const r1 = await up(ana, png);
    expect201(r1.status);
    const { url, bytes } = (await r1.json()) as { url: string; bytes: number };
    assert.match(url, /^api\/images\/[0-9a-f]{64}\.png$/);
    assert.equal(bytes, png.length);
    // The same picture again: same name (stored once).
    assert.equal(((await (await up(ana, png)).json()) as { url: string }).url, url);
    const get = (cookie?: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${PORT}/${url}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
    const mine = await get(ana);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'image/png');
    assert.match(mine.headers.get('cache-control') ?? '', /private, max-age=31536000, immutable/);
    assert.deepEqual(new Uint8Array(await mine.arrayBuffer()), png);
    assert.equal((await get(ana, { 'if-none-match': mine.headers.get('etag')! })).status, 304);
    // Not Ben's (until he uploads it himself), and nobody's without signing in.
    assert.equal((await get(ben)).status, 404);
    assert.equal((await get()).status, 401);
    expect201((await up(ben, png)).status);
    assert.equal((await get(ben)).status, 200);
    // Raster pictures only, not empty, and not too big.
    assert.equal((await up(ana, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')).status, 415);
    assert.equal((await up(ana, new Uint8Array(0))).status, 400);
    assert.equal((await up(ana, new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/images/nothash.png`, { headers: { cookie: ana } })).status, 404);
  });

  it('serves the app', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.match(await res.text(), /<title>Drama Club<\/title>/);
  });
});
