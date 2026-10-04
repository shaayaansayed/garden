import { expect, test } from 'bun:test';
import { credentialStore, oauthCredential } from './credentials';
import type { Env } from './env';
const seed={type:'oauth',access:'initial',refresh:'refresh',expires:123};
function store(){const values=new Map();return {get:async(k:string)=>values.get(k),put:async(k:string,v:unknown)=>{values.set(k,v);},delete:async(k:string)=>values.delete(k)} as unknown as DurableObjectStorage;}
test('OAuth only: API keys and malformed credentials are rejected',()=>{
  expect(oauthCredential(JSON.stringify({'openai-codex':seed})).type).toBe('oauth');
  for(const value of [{type:'api_key',key:'secret'}, {}, {type:'oauth',access:'x'}])expect(()=>oauthCredential(JSON.stringify(value))).toThrow();
});
test('refresh is serialized and survives a new store instance',async()=>{
  const storage=store();const env={CODEX_OAUTH_JSON:JSON.stringify(seed),CODEX_AUTH_VERSION:'1'} as Env;const creds=credentialStore(storage,env);
  await Promise.all([creds.modify('openai-codex',async current=>({...current!,access:'rotated'})),creds.modify('openai-codex',async current=>{expect(current?.type==='oauth'&&current.access).toBe('rotated');return {...current!,access:'latest'};})]);
  const read=await credentialStore(storage,env).read('openai-codex');expect(read?.type==='oauth'&&read.access).toBe('latest');
  expect(await creds.list()).toEqual([{providerId:'openai-codex',type:'oauth'}]);
});
test('incrementing auth version replaces a revoked login',async()=>{
  const storage=store();await credentialStore(storage,{CODEX_OAUTH_JSON:JSON.stringify(seed)} as Env).read('openai-codex');
  const next=credentialStore(storage,{CODEX_OAUTH_JSON:JSON.stringify({...seed,access:'new-login'}),CODEX_AUTH_VERSION:'2'} as Env);
  const read=await next.read('openai-codex');expect(read?.type==='oauth'&&read.access).toBe('new-login');
});
