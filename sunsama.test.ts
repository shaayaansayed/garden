import { expect, test } from 'bun:test';
import { auth } from '@modelcontextprotocol/client';
import type { MCPClientManager } from 'agents/mcp/client';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { Sunsama, SUNSAMA_CALLBACK, sunsamaAuthUrl } from './sunsama';
import { SunsamaOAuthProvider, clearSunsamaCredentials } from './sunsama-auth';

const context = { abortSignal: undefined, value: () => undefined, toString: () => 'test' };
const api = {} as ToolExecutionApi;
function fixture() {
  let calls = 0, registrations = 0, discoveries = 0, row: { id: string; client_id: string | null } | undefined;
  const state = { connectionState: 'ready' };
  const waits: (number | undefined)[] = [];
  let invoke = async () => ({ content: [{ type: 'text', text: 'saved' }], isError: false });
  let wait = async (_options?: { timeout?: number }) => {};
  const mcp = {
    mcpConnections: { sunsama: state }, listServers: () => row ? [row] : [],
    registerServer: async (_id: string, options: { url: string; callbackUrl: string }) => {
      registrations++; expect(options.url).toBe('https://api.sunsama.com/mcp'); expect(options.callbackUrl).toBe(SUNSAMA_CALLBACK);
      row = { id: 'sunsama', client_id: 'test-client' };
    },
    connectToServer: async () => { state.connectionState = 'authenticating'; return { state: 'authenticating', authUrl: 'https://api.sunsama.com/oauth/authorize?state=test' }; },
    waitForConnections: async (options?: { timeout?: number }) => { waits.push(options?.timeout); await wait(options); },
    discoverIfConnected: async (id: string) => { expect(id).toBe('sunsama'); discoveries++; state.connectionState = 'ready'; return { success: true }; },
    listTools: ({ serverId }: { serverId: string }) => { expect(serverId).toBe('sunsama'); return [
      { name: 'sunsama.get_tasks', description: 'Read tasks', inputSchema: { type: 'object', properties: { date: { type: 'string' } } } },
      { name: 'sunsama.create_task', description: 'Create a task', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ]; },
    callTool: async (params: { serverId: string }, options: { timeout: number; maxTotalTimeout: number }) => {
      expect(params.serverId).toBe('sunsama'); expect(options.timeout).toBe(30_000); expect(options.maxTotalTimeout).toBe(30_000);
      calls++; return invoke();
    },
    removeServer: async () => { row = undefined; },
  } as unknown as MCPClientManager;
  return { sunsama: new Sunsama(mcp, async () => {}), state,
    connected: () => { row = { id: 'sunsama', client_id: 'test-client' }; state.connectionState = 'ready'; },
    setInvoke: (fn: typeof invoke) => { invoke = fn; }, setWait: (fn: typeof wait) => { wait = fn; }, waits,
    calls: () => calls, registrations: () => registrations, discoveries: () => discoveries };
}
test('connect reuses its server registration and status exposes no OAuth URL or credentials', async () => {
  const f = fixture();
  expect((await f.sunsama.status()).state).toBe('disconnected');
  await f.sunsama.connect(); await f.sunsama.connect();
  expect(f.registrations()).toBe(1);
  expect(await f.sunsama.status()).toEqual({ state: 'authenticating', tools: 0 });
  f.connected(); expect(await f.sunsama.connect()).toEqual({ state: 'ready' });
});
test('discovery returns schemas and calls require a connected catalog entry', async () => {
  const f = fixture(), [discover, call] = f.sunsama.tools();
  await expect(call!.execute({ name: 'create_task', arguments: {} } as never, api, context)).rejects.toThrow('not connected');
  f.connected();
  const list = await discover!.execute({ query: 'create' } as never, api, context);
  expect(JSON.stringify(list)).toContain('inputSchema'); expect(JSON.stringify(list)).toContain('create_task');
  await expect(call!.execute({ name: 'other_server.tool', arguments: {} } as never, api, context)).rejects.toThrow('Unknown');
  expect(f.calls()).toBe(0);
});
test('tools outlast a cold restore and repair a half-restored connection; the portal keeps its short wait', async () => {
  const f = fixture(), [discover, call] = f.sunsama.tools(); f.connected();
  state(f).connectionState = 'connecting';
  f.setWait(async options => { if ((options?.timeout ?? 0) >= 30_000) state(f).connectionState = 'ready'; });
  expect(await f.sunsama.status()).toEqual({ state: 'connecting', tools: 0 });
  expect(f.waits.at(-1)).toBe(5000);
  expect(JSON.stringify(await discover!.execute({} as never, api, context))).toContain('get_tasks');
  expect(f.waits.at(-1)).toBe(30_000);
  f.setWait(async () => {}); state(f).connectionState = 'connected';
  expect((await call!.execute({ name: 'get_tasks', arguments: {} }, api, context)).isError).toBe(false);
  expect(f.discoveries()).toBe(1); expect(f.calls()).toBe(1);
  state(f).connectionState = 'authenticating';
  await expect(discover!.execute({} as never, api, context)).rejects.toThrow('authorization expired');
  f.setWait(async () => {}); state(f).connectionState = 'connecting';
  await expect(discover!.execute({} as never, api, context)).rejects.toThrow('unreachable');
});
test('a rejected credential moves the connection to authenticating instead of a vague failure', async () => {
  const f = fixture(); f.connected(); const call = f.sunsama.tools()[1]!;
  f.setInvoke(async () => { throw new Error('Unauthorized: token expired'); });
  const result = await call.execute({ name: 'create_task', arguments: { title: 'test' } }, api, context);
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('authorization expired');
  expect(JSON.stringify(result)).toContain('no change'); expect(JSON.stringify(result)).not.toContain('may have succeeded');
  expect((await f.sunsama.status()).state).toBe('authenticating');
});
test('uncertain writes are sent once, preserve failure, and cannot be replayed on recovery', async () => {
  const f = fixture(); f.connected(); f.setInvoke(async () => { throw new Error('private provider details'); });
  const call = f.sunsama.tools()[1]!;
  expect(call.replay).toBe('unsafe');
  const result = await call.execute({ name: 'create_task', arguments: { title: 'test' } }, api, context);
  expect(f.calls()).toBe(1); expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('may have succeeded'); expect(JSON.stringify(result)).not.toContain('private provider');
  f.setInvoke(async () => ({ content: [{ type: 'text', text: 'Invalid date' }], isError: true }));
  expect((await call.execute({ name: 'create_task', arguments: {} }, api, context)).isError).toBe(true);
});
test('cancelled calls are not dispatched; disconnect waits for an in-flight write', async () => {
  const f = fixture(); f.connected(); const call = f.sunsama.tools()[1]!;
  await expect(call.execute({ name: 'create_task', arguments: {} }, api, { ...context, abortSignal: AbortSignal.abort() })).rejects.toThrow();
  expect(f.calls()).toBe(0);
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setInvoke(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return { content: [], isError: false }; });
  const pending = call.execute({ name: 'create_task', arguments: {} }, api, context);
  await started;
  let cleared = false;
  const disconnected = f.sunsama.disconnect(async id => { expect(id).toBe('test-client'); cleared = true; return true; });
  await Promise.resolve(); expect(cleared).toBe(false);
  finish(); await pending; await disconnected;
  expect(cleared).toBe(true); expect((await f.sunsama.status()).state).toBe('disconnected');
});
test('OAuth redirects cannot escape the official authorization endpoint', () => {
  for (const url of ['https://evil.example/oauth/authorize', 'https://api.sunsama.com.evil.example/oauth/authorize', 'https://user:pass@api.sunsama.com/oauth/authorize', 'http://api.sunsama.com/oauth/authorize', 'https://api.sunsama.com/other']) expect(() => sunsamaAuthUrl(url)).toThrow();
});

const state = (f: ReturnType<typeof fixture>) => f.state;
function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
    list: async ({ prefix, limit = 1000 }: { prefix: string; limit?: number }) => new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
  } as unknown as DurableObjectStorage;
  return { storage, data };
}
function provider(storage: DurableObjectStorage) {
  const p = new SunsamaOAuthProvider(storage); p.serverId = 'sunsama'; p.clientId = 'test-client'; return p;
}
test('OAuth state, PKCE verifier, and rotated tokens persist across provider instances', async () => {
  const { storage } = memoryStorage(), p = provider(storage);
  expect(p.clientMetadata.scope).toContain('offline_access');
  const state = await p.state();
  await p.saveCodeVerifier('test-verifier');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-verifier'))).toString('base64url');
  await p.redirectToAuthorization(new URL('https://api.sunsama.com/oauth/authorize?' + new URLSearchParams({ state, code_challenge: challenge })));
  await p.saveTokens({ access_token: 'old-access', refresh_token: 'old-refresh', token_type: 'Bearer' });
  const restored = provider(storage);
  expect((await restored.checkState(state)).valid).toBe(true);
  expect(await restored.runWithCodeVerifierState(state, () => restored.codeVerifier())).toBe('test-verifier');
  await restored.consumeState(state);
  expect((await p.checkState(state)).valid).toBe(false);
  await restored.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer' });
  expect((await provider(storage).tokens())?.refresh_token).toBe('new-refresh');
  expect((await restored.checkState('forged.sunsama')).valid).toBe(false);
});
test('disconnect clears only Sunsama credentials even if remote revocation fails', async () => {
  const { storage, data } = memoryStorage(), p = provider(storage);
  await p.saveTokens({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer' });
  await p.state(); await storage.put('codex-credential', { unrelated: true });
  let revoked = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe('https://api.sunsama.com/oauth/revoke');
    expect(new URLSearchParams(init?.body as URLSearchParams).get('client_id')).toBe('test-client');
    revoked++; return new Response('', { status: 503 });
  }) as typeof fetch;
  expect(await clearSunsamaCredentials(storage, 'test-client', request)).toBe(false);
  expect(revoked).toBe(2); expect([...data.keys()]).toEqual(['codex-credential']);
});
test('MCP OAuth registers with PKCE, exchanges the code, and refreshes after a cold restore', async () => {
  const { storage } = memoryStorage();
  let registrations = 0, exchanges = 0, refreshes = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://api.sunsama.com/', authorization_servers: ['https://api.sunsama.com'], scopes_supported: ['read', 'execute', 'offline_access'] });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({ issuer: 'https://api.sunsama.com',
      authorization_endpoint: 'https://api.sunsama.com/oauth/authorize', token_endpoint: 'https://api.sunsama.com/oauth/token', registration_endpoint: 'https://api.sunsama.com/oauth/register',
      scopes_supported: ['read', 'execute', 'offline_access'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/oauth/register') {
      registrations++;
      const metadata = JSON.parse(init?.body as string);
      expect(metadata.redirect_uris).toEqual([SUNSAMA_CALLBACK]); expect(metadata.grant_types).toContain('refresh_token');
      return Response.json({ ...metadata, client_id: 'test-client' });
    }
    if (url.pathname === '/oauth/token') {
      const params = new URLSearchParams(init?.body as URLSearchParams);
      expect(params.get('client_id')).toBe('test-client');
      if (params.get('grant_type') === 'authorization_code') {
        exchanges++; expect(params.get('redirect_uri')).toBe(SUNSAMA_CALLBACK); expect(params.get('code_verifier')!.length).toBeGreaterThan(40);
      } else { refreshes++; expect(params.get('refresh_token')).toBe('refresh-1'); }
      return Response.json({ access_token: 'test-access', refresh_token: refreshes ? 'refresh-2' : 'refresh-1', token_type: 'Bearer', expires_in: 3600, scope: 'read execute offline_access' });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const p = new SunsamaOAuthProvider(storage); p.serverId = 'sunsama';
  expect(await auth(p, { serverUrl: 'https://api.sunsama.com/mcp', fetchFn })).toBe('REDIRECT');
  const authorization = new URL(p.authUrl!);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization.searchParams.get('scope')).toContain('offline_access');
  const state = authorization.searchParams.get('state')!;
  const restored = provider(storage);
  expect((await restored.checkState(state)).valid).toBe(true);
  await restored.consumeState(state);
  expect(await restored.runWithCodeVerifierState(state, () => auth(restored, { serverUrl: 'https://api.sunsama.com/mcp', authorizationCode: 'test-code', fetchFn }))).toBe('AUTHORIZED');
  expect(await auth(provider(storage), { serverUrl: 'https://api.sunsama.com/mcp', fetchFn })).toBe('AUTHORIZED');
  expect((await provider(storage).tokens())?.refresh_token).toBe('refresh-2');
  expect([registrations, exchanges, refreshes]).toEqual([1, 1, 1]);
});
