import { expect, test } from 'bun:test';
import { handleRequest } from './web';
import type { Env } from './env';
const id = 'c6b2d485-8b35-4f80-9fb2-b349de664ab0';
let calls = 0;
const env = { ASSETS: {fetch:()=>new Response('blog')}, PERSONAL_AGENT: { getByName: () => ({
  history: async () => [], request: async () => null,
  submit: async (id: string,message: string) => {calls++; return {id,message,status:'queued'};},
  stop: async () => true,
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
  for (const path of ['/personal','/personal/','/personal/inbox.js','/personal/requests','/personal/requests/'+id,'/personal/requests/'+id+'/cancel']) {
    const r=await handleRequest(new Request('https://shays.space'+path),env);
    expect(r.status).toBe(401); expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.text()).not.toContain('textarea');
  }
  expect(calls).toBe(0);
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
