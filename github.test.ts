import { beforeAll, expect, test } from 'bun:test';
import { exportPKCS8, generateKeyPair } from 'jose';
import { GitHub, repositoryPath } from './github';
import type { Env } from './env';
let env: Env;
beforeAll(async()=>{const {privateKey}=await generateKeyPair('RS256',{extractable:true});env={GITHUB_REPOSITORY:'owner/vault',GITHUB_BRANCH:'main',GITHUB_APP_ID:'1',GITHUB_INSTALLATION_ID:'2',GITHUB_PRIVATE_KEY:await exportPKCS8(privateKey)} as Env;});
function mockGitHub(content: string | null, sha='before') {
  const calls: {url:string;init?:RequestInit}[]=[];
  const send=async (url: string|URL|Request, init?:RequestInit) => {
    calls.push({url:String(url),init});
    if(String(url).includes('/access_tokens')) return Response.json({token:'test',expires_at:new Date(Date.now()+3600000).toISOString()});
    if(init?.method==='PUT') return Response.json({commit:{sha:'after',html_url:'https://github.com/owner/vault/commit/after'}});
    if(content===null) return new Response('',{status:404});
    return Response.json({type:'file',encoding:'base64',sha,content:Buffer.from(content).toString('base64')});
  };
  return {github:new GitHub(env,send as typeof fetch),calls};
}
test('UTF-8 read/write preserves unicode and returns a commit receipt', async()=>{
  const {github,calls}=mockGitHub('✓ reflection');expect((await github.read('Daily/today.md'))?.content).toBe('✓ reflection');
  expect((await github.write('Daily/today.md','✓ updated','before','Update daily note')).commit).toBe('after');
  const put=calls.find(c=>c.init?.method==='PUT')!;const body=JSON.parse(put.init!.body as string);expect(Buffer.from(body.content,'base64').toString()).toBe('✓ updated');
  expect(body.sha).toBe('before');expect(body.branch).toBe('main');
});
test('replay of an already applied write does not create another commit',async()=>{
  const {github,calls}=mockGitHub('desired','newsha');expect((await github.write('Tracker.md','desired','oldsha','Log')).unchanged).toBe(true);
  expect(calls.filter(c=>c.init?.method==='PUT')).toHaveLength(0);
});
test('concurrent edits are protected; stale writes fail',async()=>{
  const {github,calls}=mockGitHub('desktop edit','newsha');await expect(github.write('Tracker.md','agent edit','oldsha','Log')).rejects.toThrow('conflict');
  expect(calls.filter(c=>c.init?.method==='PUT')).toHaveLength(0);
});
test('new files require absence; traversal and Git internals are rejected',async()=>{
  const {github}=mockGitHub(null);expect((await github.write('Daily/new.md','hello',null,'Create note')).commit).toBe('after');
  for(const path of ['../x','/x','a/../x','a//b','.git/config','a\\b','a\nfile'])expect(()=>repositoryPath(path)).toThrow();
});
