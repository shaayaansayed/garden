import { expect, test } from 'bun:test';
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Provider } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { failureCategory, limitProvider } from './model-limits';
const base=openaiCodexProvider();const model=base.getModels()[0];
const message: AssistantMessage={role:'assistant',content:[{type:'text',text:'ok'}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
test('failure diagnostics retain only fixed vocabulary, excluding credentials and personal text',()=>{
  expect(failureCategory('401 invalid token Bearer secretXYZ person@example.com private journal')).toBe('401 invalid token');
});
test('daily admission failure prevents any upstream model call',async()=>{
  let calls=0;const provider={...base,streamSimple:()=>{calls++;throw new Error('should never run');}} as Provider;
  const guarded=limitProvider(provider,async()=>{throw new Error('quota');});
  const result=await guarded.streamSimple(model,normalizeContext({messages:[]})).result();
  expect(calls).toBe(0);expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('limit');
});
test('bounded stream forwards model results and caps requested output',async()=>{
  let maxTokens=0;const provider={...base,streamSimple:(_m,_c,options)=>{
    maxTokens=options?.maxTokens??0;const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end(message);return stream;
  }} as Provider;
  const guarded=limitProvider(provider,async()=>{});expect((await guarded.streamSimple(model,normalizeContext({messages:[]}),{maxTokens:12000}).result()).content).toEqual(message.content);expect(maxTokens).toBe(4096);
});
