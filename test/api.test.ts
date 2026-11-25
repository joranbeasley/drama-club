// API tests against a real Postgres. Set TEST_DATABASE_URL to a database the tests may wipe.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { createPool, migrate, type Db } from '../server/db.ts';
import type { GoogleVerifier } from '../server/auth.ts';

const url = process.env.TEST_DATABASE_URL;

describe('api', { skip: !url && 'TEST_DATABASE_URL is not set' }, () => {
  let db: Db;
  let server: Server;
  let base: string;
  // "Google" accepts tokens of the form good:<sub>:<email>.
  const verify: GoogleVerifier = async (cred) => {
    const [ok, sub, email] = cred.split(':');
    if (ok !== 'good') throw new Error('bad token');
    return { sub, email, name: email.split('@')[0] };
  };

  before(async () => {
    db = createPool(url!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(db, () => undefined);
    const cfg = loadConfig({ DATABASE_URL: url, GOOGLE_CLIENT_ID: 'test', ALLOWED_DOMAINS: 'club.test', NODE_ENV: 'test' });
    server = createApp(db, cfg, verify).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(async () => {
    server.close();
    await db.end();
  });

  const req = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const signIn = async (email: string) => {
    const r = await req('POST', '/auth/google', { credential: `good:${email}:${email}` });
    assert.equal(r.status, 200);
    return r.cookie!;
  };

  it('signs in with Google and only lets allowed domains in', async () => {
    assert.equal((await req('POST', '/auth/google', { credential: 'nope' })).status, 401);
    assert.equal((await req('POST', '/auth/google', { credential: 'good:x:x@elsewhere.test' })).status, 403);
    const cookie = await signIn('ana@club.test');
    assert.match(cookie, /^dc_session=/);
    assert.equal((await req('GET', '/me', undefined, cookie)).body.user.email, 'ana@club.test');
    assert.equal((await req('GET', '/me')).body.user, null);
    assert.equal((await req('POST', '/auth/dev', { email: 'a@b.c' })).status, 404, 'dev login is off');
  });

  it('keeps productions private to their owner', async () => {
    const ana = await signIn('ana@club.test');
    const ben = await signIn('ben@club.test');
    assert.equal((await req('GET', '/productions')).status, 401);
    const graph = { version: 1, type: 'drama2', nodes: [{ id: 'c1', type: 'drama2/character', x: 0, y: 0, params: {} }], edges: [] };
    const made = await req('POST', '/productions', { title: 'Spring', graph }, ana);
    assert.equal(made.status, 201);
    const id = made.body.production.id;
    assert.equal((await req('GET', '/productions', undefined, ana)).body.productions[0].nodeCount, 1);
    assert.deepEqual((await req('GET', `/productions/${id}`, undefined, ana)).body.production.graph, graph);
    assert.equal((await req('GET', `/productions/${id}`, undefined, ben)).status, 404);
    assert.equal((await req('PUT', `/productions/${id}`, { title: 'Mine', force: true }, ben)).status, 404);
    assert.equal((await req('DELETE', `/productions/${id}`, undefined, ben)).status, 404);
    assert.equal((await req('GET', '/productions', undefined, ben)).body.productions.length, 0);
    assert.equal((await req('GET', '/productions/not-a-uuid', undefined, ana)).status, 404);
    assert.equal((await req('POST', '/productions', { title: 'x', graph: { nodes: 'no' } }, ana)).status, 400);
  });

  it('refuses saves over a newer version unless forced', async () => {
    const ana = await signIn('ana@club.test');
    const { production } = (await req('POST', '/productions', { title: 'Autumn' }, ana)).body;
    const g = (n: number) => ({ version: 1, nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'drama2/prop', x: 0, y: 0, params: {} })), edges: [] });
    const first = await req('PUT', `/productions/${production.id}`, { graph: g(1), version: production.version }, ana);
    assert.equal(first.status, 200);
    assert.equal(first.body.production.version, production.version + 1);
    const stale = await req('PUT', `/productions/${production.id}`, { graph: g(2), version: production.version }, ana);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.production.version, production.version + 1);
    const forced = await req('PUT', `/productions/${production.id}`, { graph: g(2), force: true }, ana);
    assert.equal(forced.body.production.nodeCount, 2);
    assert.equal((await req('DELETE', `/productions/${production.id}`, undefined, ana)).status, 204);
  });

  it('signs out', async () => {
    const ana = await signIn('ana@club.test');
    assert.equal((await req('POST', '/auth/logout', {}, ana)).status, 200);
    assert.equal((await req('GET', '/me', undefined, ana)).body.user, null);
  });
});
