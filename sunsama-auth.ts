import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { SUNSAMA_CALLBACK, SUNSAMA_CLIENT, SUNSAMA_ID, sunsamaAuthUrl } from './sunsama';

export class SunsamaOAuthProvider extends DurableObjectOAuthClientProvider {
  constructor(storage: DurableObjectStorage, callback = SUNSAMA_CALLBACK) { super(storage, SUNSAMA_CLIENT, callback); }
  get clientMetadata() { return { ...super.clientMetadata, scope: 'read execute offline_access' }; }
  async redirectToAuthorization(url: URL) { await super.redirectToAuthorization(new URL(sunsamaAuthUrl(url.href))); }
}

// Removing a server from the manager alone does not erase its OAuth credentials.
export async function clearSunsamaCredentials(storage: DurableObjectStorage, clientId: string | null, request = globalThis.fetch.bind(globalThis)) {
  let revoked = true;
  try {
    if (clientId) {
      const provider = new SunsamaOAuthProvider(storage);
      provider.serverId = SUNSAMA_ID; provider.clientId = clientId;
      const tokens = await provider.tokens();
      for (const [token, hint] of [[tokens?.refresh_token, 'refresh_token'], [tokens?.access_token, 'access_token']]) {
        if (!token) continue;
        try {
          const response = await request('https://api.sunsama.com/oauth/revoke', { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(5000),
            body: new URLSearchParams({ token, token_type_hint: hint!, client_id: clientId }) });
          if (!response.ok) revoked = false;
        } catch { revoked = false; }
      }
    }
  } finally {
    const prefix = `/${SUNSAMA_CLIENT}/${SUNSAMA_ID}/`;
    while (true) {
      const keys = [...(await storage.list({ prefix, limit: 128 })).keys()];
      if (!keys.length) break;
      await storage.delete(keys);
    }
  }
  return revoked;
}
