import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from '@earendil-works/pi-ai';

export function failureCategory(message: string): string {
  const words = message.toLowerCase().match(/[a-z]+|\b[45]\d\d\b/g) ?? [];
  const allowed = new Set('invalid unsupported instructions store model not supported account authentication token expired reasoning effort missing unauthorized forbidden blocked cloudflare limit reached rate access parse output tokens must be set to false true required 400 401 403 404 429 500'.split(' '));
  return words.filter(word => allowed.has(word)).slice(0, 24).join(' ') || 'provider error';
}

export function limitProvider(provider: Provider, admit: () => Promise<void>, report: (category: string) => Promise<void> = async () => {}): Provider {
  const guard = (method: 'stream' | 'streamSimple'): Provider['streamSimple'] => (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        await admit();
        const upstream = provider[method](model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? 4096, 4096) });
        for await (const event of upstream) {
          if (event.type === 'error') await report(failureCategory(event.error.errorMessage ?? ''));
          output.push(event);
        }
        output.end(await upstream.result());
      } catch (cause) {
        await report(failureCategory(cause instanceof Error ? cause.message : ''));
        const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider,
          model: model.id, stopReason: 'error', errorMessage: 'Model request failed or daily model-call limit reached.', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push({ type: 'error', reason: 'error', error });
        output.end(error);
      }
    })();
    return output;
  };
  return { ...provider, stream: guard('stream') as Provider['stream'], streamSimple: guard('streamSimple') };
}
