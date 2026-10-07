import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import type { MCPClientManager } from 'agents/mcp/client';

export const SUNSAMA_ID = 'sunsama';
export const SUNSAMA_CLIENT = 'Shays Space';
export const SUNSAMA_URL = 'https://api.sunsama.com/mcp';
export const SUNSAMA_CALLBACK = 'https://shays.space/personal/integrations/sunsama/callback';
export type SunsamaStatus = { state: 'disconnected' | 'authenticating' | 'connecting' | 'ready' | 'failed'; tools: number };
type Client = Pick<MCPClientManager, 'listServers' | 'registerServer' | 'connectToServer' | 'discoverIfConnected' | 'waitForConnections' | 'listTools' | 'callTool' | 'removeServer' | 'mcpConnections'>;
const DISCONNECTED = 'Sunsama is not connected. Use Connect Sunsama in the personal portal.';
const EXPIRED = 'Sunsama authorization expired. Use Connect Sunsama in the personal portal.';
const isUnauthorized = (error: unknown) => error instanceof Error && /unauthorized|\b401\b/i.test(error.message);
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export function sunsamaAuthUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://api.sunsama.com' || url.pathname !== '/oauth/authorize' || url.username || url.password) {
    throw new Error('Unexpected Sunsama authorization URL.');
  }
  return url.href;
}

// One queue owns connection changes and calls, including refresh-token rotation.
export class Sunsama {
  private line: Promise<unknown> = Promise.resolve();
  constructor(private mcp: Client, private start: () => Promise<void>) {}

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.line.then(fn); this.line = next.catch(() => {}); return next;
  }

  async status(): Promise<SunsamaStatus> {
    await this.start();
    await this.mcp.waitForConnections({ timeout: 5000 });
    if (!this.mcp.listServers().some(s => s.id === SUNSAMA_ID)) return { state: 'disconnected', tools: 0 };
    const state = this.mcp.mcpConnections[SUNSAMA_ID]?.connectionState;
    return { state: state === 'ready' || state === 'authenticating' || state === 'failed' ? state : 'connecting',
      tools: state === 'ready' ? this.catalog().length : 0 };
  }

  connect() {
    return this.exclusive(async () => {
      await this.start();
      await this.mcp.waitForConnections();
      if ((await this.status()).state === 'ready') return { state: 'ready' as const };
      if (!this.mcp.listServers().some(s => s.id === SUNSAMA_ID)) {
        await this.mcp.registerServer(SUNSAMA_ID, { name: 'Sunsama', url: SUNSAMA_URL, callbackUrl: SUNSAMA_CALLBACK,
          transport: { type: 'streamable-http' }, retry: { maxAttempts: 1 } });
      }
      const connection = await this.mcp.connectToServer(SUNSAMA_ID);
      if (connection.state === 'authenticating') return { state: 'authenticating' as const, authUrl: sunsamaAuthUrl(connection.authUrl) };
      if (connection.state === 'connected' && (await this.mcp.discoverIfConnected(SUNSAMA_ID, { timeoutMs: 15_000 }))?.success) return { state: 'ready' as const };
      throw new Error('Sunsama could not connect. Try connecting again.');
    });
  }

  disconnect(clearCredentials: (clientId: string | null) => Promise<boolean>) {
    return this.exclusive(async () => {
      await this.start();
      await this.mcp.waitForConnections();
      const server = this.mcp.listServers().find(s => s.id === SUNSAMA_ID);
      await this.mcp.removeServer(SUNSAMA_ID);
      const revoked = await clearCredentials(server?.client_id ?? null);
      return { state: 'disconnected' as const, revoked };
    });
  }

  private catalog() {
    return this.mcp.listTools({ serverId: SUNSAMA_ID }).map(tool => ({
      name: tool.name.replace(/^sunsama\./, ''), description: tool.description,
      inputSchema: tool.inputSchema, annotations: tool.annotations,
    }));
  }

  // Tools outlast a cold restore and repair a connection that woke without its catalog; only the portal keeps the short wait.
  private async ready() {
    await this.start();
    await this.mcp.waitForConnections({ timeout: 30_000 });
    if (!this.mcp.listServers().some(s => s.id === SUNSAMA_ID)) throw new Error(DISCONNECTED);
    const state = () => this.mcp.mcpConnections[SUNSAMA_ID]?.connectionState;
    if (state() === 'failed') await this.mcp.connectToServer(SUNSAMA_ID);
    if (state() === 'connected') await this.mcp.discoverIfConnected(SUNSAMA_ID, { timeoutMs: 15_000 });
    if (state() === 'ready') return;
    if (state() === 'authenticating') throw new Error(EXPIRED);
    throw new Error('Sunsama is unreachable right now. Retry this tool once; if it still fails, report Sunsama as temporarily unavailable, not disconnected.');
  }

  tools() {
    return [
      defineTool({ name: 'sunsama_tools', description: 'Discover Sunsama tools and their exact input schemas before calling them. Omit query to list names; supply words from a name or description for matching schemas. Requires a connected Sunsama account.',
        parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })) }), replay: 'safe',
        execute: async ({ query }) => this.exclusive(async () => {
          await this.ready();
          const tools = this.catalog();
          if (!query?.trim()) return text({ tools: tools.map(t => ({ name: t.name, description: t.description })) });
          const terms = query.toLowerCase().trim().split(/\s+/);
          const matches = tools.filter(t => terms.every(term => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(term)));
          return text({ tools: matches.slice(0, 8), matches: matches.length, more: matches.length > 8 });
        }) }),
      defineTool({ name: 'sunsama_call', description: 'Call an exact Sunsama tool discovered with sunsama_tools. Follow its input schema. Only make changes the user requested. After an interrupted or uncertain write, inspect current Sunsama state before any retry; never blindly repeat creation.',
        parameters: Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
        replay: 'unsafe', executionMode: 'sequential', outputLimits: { maxBytes: 30_000, maxLines: 500 },
        execute: async ({ name, arguments: args }, _api, context) => this.exclusive(async () => {
          await this.ready();
          if (!this.catalog().some(t => t.name === name)) throw new Error('Unknown Sunsama tool. Discover its exact name and schema first.');
          context.abortSignal?.throwIfAborted();
          try {
            const result = await this.mcp.callTool({ serverId: SUNSAMA_ID, name, arguments: args }, {
              signal: context.abortSignal, timeout: 30_000, maxTotalTimeout: 30_000, resetTimeoutOnProgress: false,
            });
            return { ...text({ content: result.content, structuredContent: result.structuredContent }), isError: Boolean(result.isError) };
          } catch (error) {
            if (isUnauthorized(error)) {
              // Re-initialising moves the connection to authenticating so the portal offers sign-in instead of reporting ready.
              await this.mcp.connectToServer(SUNSAMA_ID).catch(() => {});
              return { ...text({ error: `${EXPIRED} Sunsama rejected the credentials, so this call made no change.` }), isError: true };
            }
            return { ...text({ error: 'Sunsama did not confirm the result. A write may have succeeded. Inspect current state before retrying.' }), isError: true };
          }
        }) }),
    ];
  }
}
