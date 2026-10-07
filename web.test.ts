import { expect, test } from 'bun:test';
import { handleRequest } from './web';
import type { Env } from './env';
const id = 'c6b2d485-8b35-4f80-9fb2-b349de664ab0';
let calls = 0;
const env = { ASSETS: {fetch:()=>new Response('blog')}, PERSONAL_AGENT: { getByName: () => ({
  history: async () => [], request: async () => null,
  submit: async (id: string,message: string) => {calls++; return {id,message,status:'queued'};},
  stop: async () => true,
  sunsamaStatus: async () => { calls++; return { state: 'disconnected', tools: 0 }; },
  sunsamaConnect: async () => { calls++; return { state: 'authenticating', authUrl: 'https://api.sunsama.com/oauth/authorize?state=test' }; },
  sunsamaDisconnect: async () => { calls++; return { state: 'disconnected', revoked: true }; },
  sunsamaCallback: async () => { calls++; return new Response(null, { status: 303, headers: { Location: '/personal/?sunsama=connected' } }); },
  engageStatus: async () => { calls++; return { members: 66, spentUsd: 0.12 }; },
  engageToday: async () => { calls++; return { date: '2026-10-07', pulls: [] }; },
  engageRun: async (kind: string) => { calls++; return { kind, picks: 3 }; },
}) } } as unknown as Env;
const owner = async () => 'shay@example.com';
function post(body: unknown, origin = 'https://shays.space') {
  return new Request('https://shays.space/personal/requests',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
test('public blog works without personal authentication', async () => expect(await (await handleRequest(new Request('https://shays.space/'),env)).text()).toBe('blog'));
test('old entry redirects to the portal without redirecting request mutations', async () => {
  const r = await handleRequest(new Request('https://agent.shays.space/personal'), env);
  expect(r.status).toBe(307);
  expect(r.headers.get('Location')).toBe('https://shays.space/personal');
  expect((await handleRequest(new Request('https://agent.shays.space/personal/requests', { method: 'POST' }), env)).status).toBe(401);
});
test('all private routes fail closed before reaching the agent', async () => {
  calls = 0;
  for (const path of ['/personal','/personal/','/personal/inbox.js','/personal/requests','/personal/requests/'+id,'/personal/requests/'+id+'/cancel',
    '/personal/integrations/sunsama', '/personal/integrations/sunsama/connect', '/personal/integrations/sunsama/disconnect', '/personal/integrations/sunsama/callback?code=secret&state=test',
    '/personal/engage', '/personal/engage/today', '/personal/engage/run?kind=expand']) {
    const r=await handleRequest(new Request('https://shays.space'+path),env);
    expect(r.status).toBe(401); expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.text()).not.toContain('textarea');
  }
  expect(calls).toBe(0);
});
test('Sunsama connection mutations require owner authentication and same-origin POST', async () => {
  for (const action of ['connect', 'disconnect']) {
    const url = 'https://shays.space/personal/integrations/sunsama/' + action;
    calls = 0;
    expect((await handleRequest(new Request(url, { method: 'POST' }), env)).status).toBe(401);
    expect((await handleRequest(new Request(url, { method: 'POST', headers: { Origin: 'https://evil.example' } }), env, owner)).status).toBe(403);
    expect((await handleRequest(new Request(url), env, owner)).status).toBe(404);
    expect(calls).toBe(0);
    expect((await handleRequest(new Request(url, { method: 'POST', headers: { Origin: 'https://shays.space' } }), env, owner)).status).toBe(200);
    expect(calls).toBe(1);
  }
});
test('OAuth browser callback retains owner verification, no-store, and no-referrer', async () => {
  const r = await handleRequest(new Request('https://shays.space/personal/integrations/sunsama/callback?code=secret&state=test'), env, owner);
  expect(r.status).toBe(303);
  expect(r.headers.get('Location')).toBe('/personal/?sunsama=connected');
  expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(await r.text()).not.toContain('secret');
});
test('Sunsama provider errors are not exposed to the browser', async () => {
  const failing = { ...env, PERSONAL_AGENT: { getByName: () => ({ sunsamaConnect: () => { throw new Error('secret-token'); } }) } } as unknown as Env;
  const r = await handleRequest(new Request('https://shays.space/personal/integrations/sunsama/connect', { method: 'POST', headers: { Origin: 'https://shays.space' } }), failing, owner);
  expect(r.status).toBe(503); expect(await r.text()).not.toContain('secret-token');
});
test('browser can submit a general message; no tracking schema is required', async () => {
  const r=await handleRequest(post({id,message:'Help me organize my notes'}),env,owner);
  expect(r.status).toBe(202); expect((await r.json() as {message:string}).message).toBe('Help me organize my notes');
});
test('cross-origin mutations, invalid payloads, and large requests are rejected', async () => {
  expect((await handleRequest(post({id,message:'hi'},'https://evil.example'),env,owner)).status).toBe(403);
  for (const body of [null,{}, {id:'bad',message:'hi'}, {id,message:''}, {id,message:'x'.repeat(8001)}]) expect((await handleRequest(post(body),env,owner)).status).toBe(400);
  expect((await handleRequest(post({id,message:'x'.repeat(40001)}),env,owner)).status).toBe(413);
});
test('private UI uses external script, semantic form, and restrictive CSP', async () => {
  const r=await handleRequest(new Request('https://shays.space/personal'),env,owner);
  expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  const html=await r.text();expect(html).toContain('id="root"');expect(html).toContain('/personal/inbox.js');
});
test('engagement status and runs stay owner-only, same-origin for runs, and return the agent outcome', async () => {
  calls = 0;
  expect((await handleRequest(new Request('https://shays.space/personal/engage/run', { method: 'POST' }), env)).status).toBe(401);
  expect((await handleRequest(new Request('https://shays.space/personal/engage/run', { method: 'POST', headers: { Origin: 'https://evil.example' } }), env, owner)).status).toBe(403);
  expect(calls).toBe(0);
  const status = await handleRequest(new Request('https://shays.space/personal/engage'), env, owner);
  expect(status.status).toBe(200); expect(await status.json() as unknown).toEqual({ members: 66, spentUsd: 0.12 });
  const run = await handleRequest(new Request('https://shays.space/personal/engage/run?kind=expand', { method: 'POST', headers: { Origin: 'https://shays.space' } }), env, owner);
  expect(run.status).toBe(202); expect(await run.json() as unknown).toEqual({ kind: 'expand', picks: 3 });
  expect(calls).toBe(2);
  const today = await handleRequest(new Request('https://shays.space/personal/engage/today'), env, owner);
  expect(today.status).toBe(200); expect(await today.json() as unknown).toEqual({ date: '2026-10-07', pulls: [] });
});
