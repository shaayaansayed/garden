import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './env';

const resolvers = new Map<string, JWTVerifyGetKey>();

// Fail closed, including direct origin requests that bypass the Access login page.
export async function authenticate(request: Request, env: Env, keys?: JWTVerifyGetKey): Promise<string | null> {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD || !env.OWNER_EMAIL) return null;
  let issuer: URL;
  try { issuer = new URL(env.ACCESS_ISSUER); } catch { return null; }
  if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.pathname !== '/') return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    let resolver = keys ?? resolvers.get(issuer.origin);
    if (!resolver) {
      resolver = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer));
      resolvers.set(issuer.origin, resolver);
    }
    const { payload } = await jwtVerify(token, resolver, {
      issuer: issuer.origin, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return null;
    return payload.email.toLowerCase();
  } catch { return null; }
}

export function isSameOrigin(request: Request): boolean {
  return request.headers.get('Origin') === new URL(request.url).origin
    && request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}
