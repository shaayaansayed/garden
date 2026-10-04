import { beforeAll, expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticate, isSameOrigin } from './access';
import type { Env } from './env';

const env = { ACCESS_ISSUER: 'https://shay.cloudflareaccess.com', ACCESS_AUD: 'personal', OWNER_EMAIL: 'shay@example.com' } as Env;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => { pair = await generateKeyPair('RS256'); keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test' }] }); });
async function request(overrides: { email?: string; audience?: string; expires?: string; issuer?: string } = {}) {
  const jwt = await new SignJWT({ email: overrides.email ?? 'shay@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(overrides.issuer ?? env.ACCESS_ISSUER!).setSubject('owner').setAudience(overrides.audience ?? 'personal')
    .setIssuedAt().setExpirationTime(overrides.expires ?? '1h').sign(pair.privateKey);
  return new Request('https://shays.space/personal', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
}
test('accepts signed owner token for this Access application', async () => expect(await authenticate(await request(), env, keys)).toBe('shay@example.com'));
test('rejects forged, expired, other-user, other-app, and other-issuer tokens', async () => {
  for (const overrides of [{email:'someone@example.com'}, {audience:'blog'}, {expires:'-1h'}, {issuer:'https://attacker.cloudflareaccess.com'}]) {
    expect(await authenticate(await request(overrides), env, keys)).toBeNull();
  }
  expect(await authenticate(new Request('https://shays.space/personal', {headers:{'Cf-Access-Jwt-Assertion':'forged'}}), env, keys)).toBeNull();
});
test('missing configuration and missing assertions fail closed', async () => {
  expect(await authenticate(await request(), {} as Env, keys)).toBeNull();
  expect(await authenticate(new Request('https://shays.space/personal'), env, keys)).toBeNull();
});
test('mutations require same-origin browser requests', () => {
  for (const origin of ['', 'https://evil.example', 'null']) expect(isSameOrigin(new Request('https://shays.space/personal/requests',{headers:{Origin:origin}}))).toBe(false);
  expect(isSameOrigin(new Request('https://shays.space/personal/requests',{headers:{Origin:'https://shays.space'}}))).toBe(true);
});
