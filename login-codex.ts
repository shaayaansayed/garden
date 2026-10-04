import { createModels, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';

// Create a dedicated login. Never copy the Codex app's own refresh token.
const saved = new Map<string, Credential>();
const store: CredentialStore = {
  read: async id => saved.get(id),
  list: async () => [...saved].map(([providerId, c]) => ({ providerId, type: c.type })),
  modify: async (id, fn) => { const next = await fn(saved.get(id)); if (next) saved.set(id, next); return saved.get(id); },
  delete: async id => { saved.delete(id); },
};
const models = createModels({ credentials: store });
models.setProvider(openaiCodexProvider());
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  await models.login('openai-codex', 'oauth', {
    prompt: async p => {
      if (p.type === 'select') {
        const options = p.options ?? [];
        const answer = await terminal.question(p.message + '\n' + options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') + '\n> ', { signal: p.signal });
        const selected = options[Number(answer || '1') - 1];
        if (!selected) throw new Error('Invalid login method');
        return selected.id;
      }
      return terminal.question(p.message + '\n> ', { signal: p.signal });
    },
    notify: event => {
      if (event.type === 'auth_url') console.log('Open this sign-in link:\n' + event.url);
      else if (event.type === 'device_code') console.log(`Enter ${event.userCode} at ${event.verificationUri}`);
      else console.log(event.message);
    },
  });
  await writeFile('codex-auth.json', JSON.stringify(Object.fromEntries(saved)), { mode: 0o600 });
  console.log('Saved dedicated OAuth credentials to gitignored codex-auth.json. Upload as CODEX_OAUTH_JSON using Wrangler secret put; do not commit or paste them into chat.');
} finally { terminal.close(); }
