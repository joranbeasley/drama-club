// The agent API end to end: tokens, scene setup, edits, wardrobe, and a board the app can load.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph, drama2Graph, toDrama, seedanceShot } from 'mobile-nodemap';

const PORT = 8791;
const origin = `http://127.0.0.1:${PORT}`;
let wrangler: ChildProcess;
const state = mkdtempSync(join(tmpdir(), 'dramaclub-agent-'));

before(async () => {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'dramaclub', '--local', '--persist-to', state], { stdio: 'ignore' });
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', 'DEV_LOGIN:1', '--show-interactive-dev-session=false'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(origin + '/api/health')).ok) return;
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

type Res = { status: number; body: any; cookie?: string };
const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string; token?: string } = {}): Promise<Res> => {
  const res = await fetch(origin + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

describe('agent API', () => {
  let cookie = '';
  let token = '';
  let tokenId = '';
  let pid = '';

  it('makes API tokens in the app, and they act as their owner', async () => {
    cookie = (await call('POST', '/api/auth/dev', { body: { email: 'ana@club.test' } })).cookie!;
    const made = await call('POST', '/api/tokens', { body: { name: 'Claude' }, cookie });
    assert.equal(made.status, 201);
    assert.match(made.body.token, /^dc_[A-Za-z0-9_-]{40,}$/);
    token = made.body.token;
    tokenId = made.body.id;
    assert.deepEqual((await call('GET', '/api/tokens', { cookie })).body.tokens.map((t: { name: string }) => t.name), ['Claude']);
    assert.equal((await call('GET', '/api/me', { token })).body.user.email, 'ana@club.test');
    // Tokens can't make tokens; a wrong token is nobody.
    assert.equal((await call('POST', '/api/tokens', { body: { name: 'x' }, token })).status, 403);
    assert.equal((await call('GET', '/api/productions', { token: 'dc_' + 'x'.repeat(43) })).status, 401);
    // A production to work on (made in the app).
    const g = { version: 1, type: 'drama2', nodes: [], edges: [] };
    const res = await fetch(`${origin}/api/productions?title=Spring`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(g) });
    pid = ((await res.json()) as { production: { id: string } }).production.id;
    assert.equal((await call('GET', '/api/productions', { token })).body.productions[0].id, pid);
  });

  it('describes itself', async () => {
    const spec = (await call('GET', '/api/openapi.json')).body;
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/api/productions/{productionId}/scenes'].post);
    const md = await (await fetch(origin + '/agents.md')).text();
    assert.match(md, /# Drama Club for agents/);
  });

  it('sets up a scene in one call, creating what it names', async () => {
    const r = await call('POST', `/api/productions/${pid}/scenes`, {
      token,
      body: {
        episode: 'Opening Night',
        time: 'night',
        description: 'The lights fail mid-performance.',
        location: 'School hall',
        wardrobe: { Maya: 'Stage blacks' },
        shots: [
          { framing: 'Wide', characters: ['Theo', 'Jules'], description: 'The stage goes dark mid-line.', duration: 4 },
          { framing: 'close-up', characters: ['Maya'], props: ['Torch'], description: 'Maya grabs a torch in the wings.' },
          { framing: 'Medium', characters: ['Maya', 'Theo'], description: 'She lights his face.', continues: true, wardrobe: { Theo: 'Lead costume' } },
        ],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sc = r.body.scene;
    assert.equal(sc.number, 1);
    assert.equal(sc.time, 'NIGHT');
    assert.equal(sc.episode.title, 'Opening Night');
    assert.deepEqual(sc.shots.map((s: { number: string; framing: string }) => [s.number, s.framing]), [['1', 'Wide'], ['2', 'Close-up'], ['3', 'Medium']]);
    assert.equal(sc.shots[0].location.name, 'School hall'); // the scene's location, by default
    assert.deepEqual(sc.shots[1].wearing.map((w: any) => [w.character.name, w.outfit.name, w.from]), [['Maya', 'Stage blacks', 'scene']]);
    assert.deepEqual(sc.shots[2].wearing.map((w: any) => [w.character.name, w.outfit.name, w.from]), [['Maya', 'Stage blacks', 'scene'], ['Theo', 'Lead costume', 'shot']]);
    assert.equal(sc.shots[2].continuesPreviousShot, true);
    const names = (k: string) => r.body.created[k].map((x: { name: string }) => x.name).sort();
    assert.deepEqual(names('characters'), ['Jules', 'Maya', 'Theo']);
    assert.deepEqual(names('locations'), ['School hall']);
    assert.deepEqual(names('props'), ['Lead costume', 'Stage blacks', 'Torch']);
    assert.deepEqual(names('episodes'), ['Opening Night']);
    // A second scene reuses everything by name (ignoring case) and numbers itself next.
    const r2 = await call('POST', `/api/productions/${pid}/scenes`, { token, body: { episode: 'opening night', location: 'school hall', shots: [{ characters: ['maya'] }] } });
    assert.equal(r2.body.scene.number, 2);
    assert.deepEqual(Object.values(r2.body.created).flat(), []);
    // Refusing to create: a clear error, and nothing saved.
    const before = r2.body.production.version;
    const bad = await call('POST', `/api/productions/${pid}/scenes`, { token, body: { createMissing: false, shots: [{ characters: ['Nobody'] }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /No character "Nobody"/);
    assert.equal((await call('GET', `/api/productions/${pid}/outline`, { token })).body.production.version, before);
  });

  it('checks values and explains what is allowed', async () => {
    const r = await call('POST', `/api/productions/${pid}/scenes`, { token, body: { shots: [{ framing: 'Fisheye' }] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /^framing must be one of: Wide, Full, Medium/);
    const outfit = await call('POST', `/api/productions/${pid}/scenes`, { token, body: { shots: [{ props: ['Stage blacks'] }] } });
    assert.match(outfit.body.error, /is an outfit: dress people with wardrobe/);
  });

  it('edits, dresses and deletes items, keeping references tidy', async () => {
    const o = (await call('GET', `/api/productions/${pid}/outline`, { token })).body.outline;
    const theo = o.characters.find((c: { name: string }) => c.name === 'Theo');
    const scene1 = o.episodes[0].scenes[0];
    const edited = await call('PATCH', `/api/productions/${pid}/items/${theo.id}`, { token, body: { appearance: '17, tall and lanky, messy auburn hair.', actor: 'Sam R.' } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.item.appearance, '17, tall and lanky, messy auburn hair.');
    assert.match((await call('PATCH', `/api/productions/${pid}/items/${theo.id}`, { token, body: { framing: 'Wide' } })).body.error, /Can't change framing here/);
    // Dress Theo for the whole episode; shot 3's own choice still wins there.
    const w = await call('PUT', `/api/productions/${pid}/wardrobe`, { token, body: { at: o.episodes[0].id, character: 'Theo', outfit: 'Stage blacks' } });
    assert.equal(w.status, 200);
    let shots = (await call('GET', `/api/productions/${pid}/outline`, { token })).body.outline.episodes[0].scenes[0].shots;
    assert.deepEqual(shots[0].wearing.find((x: any) => x.character.name === 'Theo'), { character: { id: theo.id, name: 'Theo' }, outfit: shots[0].wearing.find((x: any) => x.character.name === 'Theo').outfit, from: 'episode' });
    assert.equal(shots[2].wearing.find((x: any) => x.character.name === 'Theo').from, 'shot');
    // "usual" on the shot: back to their own clothes there.
    await call('PUT', `/api/productions/${pid}/wardrobe`, { token, body: { at: shots[0].id, character: 'Theo', outfit: 'usual' } });
    shots = (await call('GET', `/api/productions/${pid}/outline`, { token })).body.outline.episodes[0].scenes[0].shots;
    assert.equal(shots[0].wearing.find((x: any) => x.character.name === 'Theo'), undefined);
    // Delete Jules: gone from shots too.
    const jules = o.characters.find((c: { name: string }) => c.name === 'Jules');
    assert.equal((await call('DELETE', `/api/productions/${pid}/items/${jules.id}`, { token })).status, 200);
    const after = (await call('GET', `/api/productions/${pid}/outline`, { token })).body.outline;
    assert.equal(after.characters.some((c: { id: string }) => c.id === jules.id), false);
    assert.deepEqual(after.episodes[0].scenes[0].shots[0].characters.map((c: { name: string }) => c.name), ['Theo']);
    assert.equal(after.episodes[0].scenes[0].id, scene1.id);
  });

  it('honours ?version= and refuses token deletion of productions', async () => {
    const v = (await call('GET', `/api/productions/${pid}/outline`, { token })).body.production.version;
    assert.equal((await call('POST', `/api/productions/${pid}/characters?version=${v - 1}`, { token, body: { name: 'Late' } })).status, 409);
    assert.equal((await call('POST', `/api/productions/${pid}/characters?version=${v}`, { token, body: { name: 'Okafor' } })).status, 201);
    assert.equal((await call('DELETE', `/api/productions/${pid}`, { token })).status, 403);
  });

  it('writes a board the app loads, and the video export reads', async () => {
    const res = await call('GET', `/api/productions/${pid}`, { cookie });
    const board = Graph.fromJSON(res.body.production.graph, drama2Graph.createRegistry());
    const shot3 = [...board.nodes.values()].find((n) => n.type === 'drama2/shot' && n.params.number === '3' && n.params.continues)!;
    const s = seedanceShot(toDrama(board), shot3.id);
    assert.match(s.prompt, /Maya/);
    assert.match(s.prompt, /Theo/);
    assert.match(s.prompt, /Setting: School hall, interior, night/);
    assert.match(s.prompt, /Costume in this scene: Stage blacks/);
    assert.match(s.prompt, /Costume in this scene: Lead costume/);
  });

  it('revokes tokens', async () => {
    assert.equal((await call('DELETE', `/api/tokens/${tokenId}`, { cookie })).status, 204);
    assert.equal((await call('GET', '/api/productions', { token })).status, 401);
  });
});
