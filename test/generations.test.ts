// What made each picture and clip: kept per production for 7 days, owners only.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8793;
const origin = `http://127.0.0.1:${PORT}`;
let wrangler: ChildProcess;
const state = mkdtempSync(join(tmpdir(), 'dramaclub-gen-'));

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

const signIn = async (email: string) =>
  (await fetch(origin + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).headers.get('set-cookie')!.split(';')[0];
const call = (method: string, path: string, cookie: string, body?: unknown) =>
  fetch(origin + '/api' + path, { method, headers: { 'content-type': 'application/json', cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const record = (n: number) => ({ at: n, kind: 'image', node: 's1b', param: 'images', service: 'fal', model: 'Nano Banana 2', prompt: `Storyboard frame ${n}`, references: [{ label: 'Theo' }], settings: { aspect: '16:9' } });

describe('generations', () => {
  it('keeps each field’s records for its owner, newest first, for 7 days', async () => {
    const ana = await signIn('ana@club.test');
    const made = await fetch(origin + '/api/productions?title=Spring', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ana, 'x-node-count': '0' }, body: JSON.stringify({ version: 1, type: 'drama2', nodes: [], edges: [] }) });
    assert.equal(made.status, 201);
    const id = ((await made.json()) as { production: { id: string } }).production.id;
    assert.equal((await call('POST', `/productions/${id}/generations`, ana, record(1))).status, 201);
    assert.equal((await call('POST', `/productions/${id}/generations`, ana, record(2))).status, 201);
    assert.equal((await call('POST', `/productions/${id}/generations`, ana, { ...record(3), param: 'lastFrame' })).status, 201);
    const list = async (cookie = ana) => ((await (await call('GET', `/productions/${id}/generations?node=s1b&param=images`, cookie)).json()) as { generations: { prompt: string }[] }).generations;
    assert.deepEqual((await list()).map((r) => r.prompt), ['Storyboard frame 2', 'Storyboard frame 1']);
    // Not Ben's.
    const ben = await signIn('ben@club.test');
    assert.equal((await call('GET', `/productions/${id}/generations?node=s1b&param=images`, ben)).status, 404);
    assert.equal((await call('POST', `/productions/${id}/generations`, ben, record(9))).status, 404);
    // A record needs its node and field.
    assert.equal((await call('POST', `/productions/${id}/generations`, ana, { prompt: 'x' })).status, 400);
    // Past their 7 days: gone from the list, and deleted when the next one arrives.
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'dramaclub', '--local', '--persist-to', state, '--command', "UPDATE generations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE data LIKE '%frame 1%'"], { stdio: 'ignore' });
    assert.deepEqual((await list()).map((r) => r.prompt), ['Storyboard frame 2']);
    await call('POST', `/productions/${id}/generations`, ana, record(4));
    const left = execFileSync('npx', ['wrangler', 'd1', 'execute', 'dramaclub', '--local', '--persist-to', state, '--json', '--command', 'SELECT COUNT(*) AS n FROM generations'], { encoding: 'utf8' });
    assert.equal(JSON.parse(left)[0].results[0].n, 3);
  });
});
