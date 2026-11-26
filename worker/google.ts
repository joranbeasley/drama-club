import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Checks an ID token from "Sign in with Google": Google's signature, that it was issued for
 * this app (audience), not expired, and that the email is verified.
 */
export async function verifyGoogleToken(token: string, clientId: string, keys: JWTVerifyGetKey = googleKeys): Promise<GoogleIdentity> {
  const { payload: p } = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
  });
  const email = typeof p.email === 'string' ? p.email : '';
  if (!p.sub || !email) throw new Error('Google did not return an email address');
  if (p.email_verified !== true && p.email_verified !== 'true') throw new Error('That Google account has no verified email address');
  return { sub: p.sub, email, name: typeof p.name === 'string' ? p.name : email, picture: typeof p.picture === 'string' ? p.picture : undefined };
}
