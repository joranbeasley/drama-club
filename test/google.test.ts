// Google ID token checks, with a local key standing in for Google's.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { verifyGoogleToken } from '../worker/google.ts';
import { emailAllowed } from '../worker/allow.ts';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
const token = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string } = {}) =>
  new SignJWT({ email: 'ana@club.test', email_verified: true, name: 'Ana', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('123')
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? 'my-client')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(privateKey);

describe('google sign-in', () => {
  it('accepts a good token', async () => {
    assert.deepEqual(await verifyGoogleToken(await token({}), 'my-client', keys), { sub: '123', email: 'ana@club.test', name: 'Ana', picture: undefined });
  });
  it('rejects tokens for another app, from another issuer, expired, or unverified', async () => {
    await assert.rejects(verifyGoogleToken(await token({}, { aud: 'other' }), 'my-client', keys));
    await assert.rejects(verifyGoogleToken(await token({}, { iss: 'https://evil.test' }), 'my-client', keys));
    await assert.rejects(verifyGoogleToken(await token({}, { exp: '-1m' }), 'my-client', keys));
    await assert.rejects(verifyGoogleToken(await token({ email_verified: false }), 'my-client', keys), /verified/);
    await assert.rejects(verifyGoogleToken('not.a.token', 'my-client', keys));
  });
  it('applies the allow lists', () => {
    assert.ok(emailAllowed({} as never, 'x@any.test'));
    const env = { ALLOWED_EMAILS: 'Ben@Gmail.com', ALLOWED_DOMAINS: '@club.test' } as never;
    assert.ok(emailAllowed(env, 'ana@club.test'));
    assert.ok(emailAllowed(env, 'ben@gmail.com'));
    assert.ok(!emailAllowed(env, 'eve@gmail.com'));
  });
});
