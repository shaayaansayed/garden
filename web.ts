import { authenticate, isSameOrigin } from './access';
import { inbox, inboxScript } from './inbox';
import type { Env } from './env';

const privateHeaders = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: privateHeaders });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleRequest(request: Request, env: Env, verify = authenticate): Promise<Response> {
  const url = new URL(request.url);
  // Route on the normalized URL before serving any private content.
  if (url.pathname !== '/personal' && !url.pathname.startsWith('/personal/')) {
    return env.ASSETS.fetch(request);
  }
  if (url.hostname === 'agent.shays.space' && request.method === 'GET' && ['/personal', '/personal/'].includes(url.pathname)) {
    return new Response(null, { status: 307, headers: { ...privateHeaders, Location: 'https://shays.space/personal' } });
  }
  if (!await verify(request, env)) return json({ error: 'Sign in through Cloudflare Access to use the personal agent.' }, 401);
  if (request.method === 'POST' && !isSameOrigin(request)) return json({ error: 'A same-origin browser request is required.' }, 403);
  if (request.method === 'GET' && ['/personal', '/personal/'].includes(url.pathname)) {
    return new Response(inbox, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (request.method === 'GET' && url.pathname === '/personal/inbox.js') {
    return new Response(inboxScript, { headers: { ...privateHeaders, 'Content-Type': 'text/javascript; charset=utf-8' } });
  }
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  try {
    const agent = env.PERSONAL_AGENT.getByName('shay');
    const sunsama = '/personal/integrations/sunsama';
    if (url.pathname === sunsama && request.method === 'GET') return json(await agent.sunsamaStatus());
    if (url.pathname === sunsama + '/connect' && request.method === 'POST') return json(await agent.sunsamaConnect());
    if (url.pathname === sunsama + '/disconnect' && request.method === 'POST') return json(await agent.sunsamaDisconnect());
    if (url.pathname === sunsama + '/callback' && request.method === 'GET') {
      const response = await agent.sunsamaCallback(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname === '/personal/engage' && request.method === 'GET') return json(await agent.engageStatus());
    if (url.pathname === '/personal/engage/today' && request.method === 'GET') return json(await agent.engageToday());
    if (url.pathname === '/personal/engage/run' && request.method === 'POST') {
      const kind = url.searchParams.get('kind') === 'expand' ? 'expand' : 'daily';
      return json(await agent.engageRun(kind), 202);
    }
    if (url.pathname === '/personal/requests') {
      if (request.method === 'GET') return json(await agent.history());
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415);
      const text = await readBody(request, 40_000);
      let body: unknown; try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON.' }, 400); }
      const data = body as { id?: unknown; message?: unknown } | null;
      if (!data || typeof data.id !== 'string' || !uuid.test(data.id) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000) {
        return json({ error: 'Provide a UUID and a message of 1–8000 characters.' }, 400);
      }
      return json(await agent.submit(data.id, data.message.trim()), 202);
    }
    const match = url.pathname.match(/^\/personal\/requests\/([^/]+)(\/cancel)?$/);
    if (!match || !uuid.test(match[1])) return json({ error: 'Not found.' }, 404);
    if (match[2] && request.method === 'POST') return json({ stopped: await agent.stop(match[1]) });
    if (!match[2] && request.method === 'GET') {
      const row = await agent.request(match[1]);
      return row ? json(row) : json({ error: 'Not found.' }, 404);
    }
    return json({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (url.pathname.startsWith('/personal/integrations/sunsama')) return json({ error: 'Could not reach Sunsama. Try connecting again.' }, 503);
    const message = error instanceof Error ? error.message : '';
    if (message === 'Request body too large.') return json({ error: message }, 413);
    if (message === 'Daily request limit reached.') return json({ error: message }, 429);
    if (message === 'Request ID already belongs to a different message.') return json({ error: message }, 409);
    // Never return provider errors, tokens, or user content to logs.
    console.error('Personal agent request failed.');
    return json({ error: 'The agent is unavailable. Your message can be retried with the same request ID.' }, 503);
  }
}

async function readBody(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error('Request body too large.'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(data);
}
