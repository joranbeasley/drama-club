// Clips copied into R2: from an allowed host only, owners only, with Range support.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const PORT = 8792;
const origin = `http://127.0.0.1:${PORT}`;
let wrangler: ChildProcess;
let source: Server;
let sourceUrl = '';
let served = 0;
const state = mkdtempSync(join(tmpdir(), 'dramaclub-clips-'));
// A stand-in "video": 1,000 bytes, each its own index mod 256, to check ranges.
const VIDEO = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

before(async () => {
  source = createServer((req, res) => {
    served++;
    if (req.url === '/gone.mp4' || req.url === '/gone.png') return void res.writeHead(404).end();
    if (req.url?.startsWith('/pic.png')) return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG));
    if (req.url === '/voice.mp3') return void res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from(PNG));
    if (req.url === '/voice.wav') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(PNG));
    if (req.url === '/page.svg') return void res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) }).end(Buffer.from(VIDEO));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => source.once('listening', r));
  sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
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
  source.close();
  rmSync(state, { recursive: true, force: true });
});

const signIn = async (email: string) =>
  (await fetch(origin + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).headers.get('set-cookie')!.split(';')[0];
const keep = (cookie: string, url: string) => fetch(origin + '/api/clips', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url }) });

describe('clips', () => {
  it('copies a clip into R2 and plays it back, with ranges, to its owner only', async () => {
    const ana = await signIn('ana@club.test');
    const r = await keep(ana, `${sourceUrl}/clip.mp4`);
    assert.equal(r.status, 201);
    const { url } = (await r.json()) as { url: string };
    assert.match(url, /^api\/clips\/[0-9a-f-]{36}\.mp4$/);
    const whole = await fetch(`${origin}/${url}`, { headers: { cookie: ana } });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), VIDEO);
    const part = await fetch(`${origin}/${url}`, { headers: { cookie: ana, range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const tail = await fetch(`${origin}/${url}`, { headers: { cookie: ana, range: 'bytes=-3' } });
    assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [997 % 256, 998 % 256, 999 % 256]);
    assert.equal((await fetch(`${origin}/${url}`, { headers: { cookie: ana, range: 'bytes=5000-' } })).status, 416);
    // Not Ben's; not without signing in.
    const ben = await signIn('ben@club.test');
    assert.equal((await fetch(`${origin}/${url}`, { headers: { cookie: ben } })).status, 404);
    assert.equal((await fetch(`${origin}/${url}`)).status, 401);
    // The same clip again: the same copy, not a second download.
    const before = served;
    assert.equal(((await (await keep(ana, `${sourceUrl}/clip.mp4`)).json()) as { url: string }).url, url);
    assert.equal(served, before);
  });

  it('keeps sound too (🎙 fixed voices), served as what it is', async () => {
    const ana = await signIn('ana@club.test');
    const mp3 = ((await (await keep(ana, `${sourceUrl}/voice.mp3`)).json()) as { url: string }).url;
    assert.match(mp3, /^api\/clips\/[0-9a-f-]{36}\.mp3$/);
    const got = await fetch(`${origin}/${mp3}`, { headers: { cookie: ana } });
    assert.equal(got.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
    const wav = ((await (await keep(ana, `${sourceUrl}/voice.wav`)).json()) as { url: string }).url;
    assert.match(wav, /\.wav$/);
    assert.equal((await fetch(`${origin}/${wav}`, { headers: { cookie: ana } })).headers.get('content-type'), 'audio/wav');
    // A picture still isn't kept here.
    assert.equal((await keep(ana, `${sourceUrl}/page.svg`)).status, 400);
  });

  it('copies only from fal (or a local server in development), and says when a link is gone', async () => {
    const ana = await signIn('ana@club.test');
    const no = await keep(ana, 'https://evil.test/x.mp4');
    assert.equal(no.status, 400);
    assert.match(((await no.json()) as { error: string }).error, /only be copied from fal/);
    assert.equal((await keep(ana, 'not a url')).status, 400);
    const gone = await keep(ana, `${sourceUrl}/gone.mp4`);
    assert.equal(gone.status, 502);
    assert.match(((await gone.json()) as { error: string }).error, /may have expired/);
  });
});

describe('pictures copied from Meshy and fal', () => {
  const copy = (cookie: string, url: string) => fetch(origin + '/api/images/copy', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url }) });

  it('keeps a service picture in R2, like an upload', async () => {
    const ana = await signIn('ana@club.test');
    const r = await copy(ana, `${sourceUrl}/pic.png?Expires=1&Signature=x`);
    assert.equal(r.status, 201);
    const { url } = (await r.json()) as { url: string };
    assert.match(url, /^api\/images\/[0-9a-f]{64}\.png$/);
    const pic = await fetch(`${origin}/${url}`, { headers: { cookie: ana } });
    assert.equal(pic.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await pic.arrayBuffer()), PNG);
    // The same picture uploaded by hand: the same link.
    const up = await fetch(origin + '/api/images', { method: 'POST', headers: { 'content-type': 'image/png', cookie: ana }, body: PNG });
    assert.equal(((await up.json()) as { url: string }).url, url);
  });

  it('copies pictures only, only from Meshy or fal, and says when a link has expired', async () => {
    const ana = await signIn('ana@club.test');
    const no = await copy(ana, 'https://example.test/x.png');
    assert.equal(no.status, 400);
    assert.match(((await no.json()) as { error: string }).error, /only be copied from Meshy or fal/);
    assert.equal((await copy(ana, `${sourceUrl}/page.svg`)).status, 415);
    const gone = await copy(ana, `${sourceUrl}/gone.png`);
    assert.equal(gone.status, 502);
    assert.match(((await gone.json()) as { error: string }).error, /may have expired/);
    assert.equal((await fetch(origin + '/api/images/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://assets.meshy.ai/a.png"}' })).status, 401);
  });
});
