import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import type { Env } from './env';

export function oauthCredential(json: string): Credential {
  const parsed = JSON.parse(json);
  const credential = parsed['openai-codex'] ?? parsed;
  if (credential.type !== 'oauth' || typeof credential.access !== 'string'
      || typeof credential.refresh !== 'string' || typeof credential.expires !== 'number') {
    throw new Error('Expected Pi Codex OAuth credentials. API keys are not accepted.');
  }
  return credential;
}

// One personal Durable Object owns this credential. Refreshes are serialized and persisted.
export function credentialStore(storage: DurableObjectStorage, env: Env): CredentialStore {
  let line: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = line.then(fn); line = result.catch(() => {}); return result;
  };
  const read = async (provider: string): Promise<Credential | undefined> => {
    if (provider !== 'openai-codex') return undefined;
    const version = env.CODEX_AUTH_VERSION ?? '1';
    const saved = await storage.get<{ version: string; credential?: Credential }>('codex-credential');
    if (saved?.version === version) return saved.credential;
    if (!env.CODEX_OAUTH_JSON) return undefined;
    const credential = oauthCredential(env.CODEX_OAUTH_JSON);
    await storage.put('codex-credential', { version, credential });
    return credential;
  };
  return {
    read: provider => serial(() => read(provider)),
    list: () => serial(async () => (await read('openai-codex')) ? [{ providerId: 'openai-codex', type: 'oauth' as const }] : []),
    modify: (provider, fn) => serial(async () => {
      const current = await read(provider);
      const next = await fn(current);
      if (next) {
        if (provider !== 'openai-codex' || next.type !== 'oauth') throw new Error('Only Codex OAuth is supported.');
        await storage.put('codex-credential', { version: env.CODEX_AUTH_VERSION ?? '1', credential: next });
      }
      return next ?? current;
    }),
    delete: () => serial(async () => { await storage.put('codex-credential', { version: env.CODEX_AUTH_VERSION ?? '1' }); }),
  };
}
