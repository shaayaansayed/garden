import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import { MCPClientManager } from 'agents/mcp/client';
import { createModels, Type } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { createRegistry, defineTool, Harness } from '@earendil-works/pi-durable';
import type { ConversationId } from '@earendil-works/pi-durable';
import protocol from './agent/AGENTS.md';
import { GitHub } from './github';
import { credentialStore } from './credentials';
import { failureCategory, limitProvider } from './model-limits';
import type { Env } from './env';
import { Sunsama, SUNSAMA_CLIENT } from './sunsama';
import { SunsamaOAuthProvider, clearSunsamaCredentials } from './sunsama-auth';
import { Engage } from './engage';
import { TwitterApi } from './twitterapi';
import { Jev } from './jev';
import seeds from './engage-seeds.txt';

// Pi's default OAuth loader uses variable imports unavailable in a bundled Worker.
registerBunOAuthFlows();

export interface AgentRequest {
  id: string; message: string; created: string;
  status: 'queued' | 'running' | 'done' | 'unanswered'; text?: string; reason?: string;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export class PersonalAgent extends DurableObject<Env> {
  private github = new GitHub(this.env);
  private mcp = new MCPClientManager(SUNSAMA_CLIENT, '1.0.0', {
    createAuthProvider: callback => new SunsamaOAuthProvider(this.ctx.storage, callback),
  });
  private sunsama = new Sunsama(this.mcp, () => this.lifecycle.start());
  private engage = new Engage({
    store: this.ctx.storage, seeds: seeds.split('\n').filter(l => l.trim() && !l.startsWith('#')),
    twitter: () => new TwitterApi(this.env.TWITTERAPI_KEY ?? ''), jev: new Jev(this.env.TYPESAFE_API_KEY ?? ''),
    github: this.github,
    config: { dir: this.env.ENGAGE_DIR, timezone: this.env.AGENT_TIMEZONE, myHandle: this.env.X_HANDLE, monthlyCredits: Number(this.env.ENGAGE_MONTHLY_CREDITS) || 500_000 },
  });
  private engageLine: Promise<unknown> = Promise.resolve();
  private line: Promise<unknown> = Promise.resolve();
  private failureDetail?: (session: string, id: string) => Promise<string | undefined>;
  private harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.failureDetail = async (session, id) => {
        const record = await storage.submissionByRequest(Number(session) as ConversationId, id, context);
        return record?.status === 'unanswered' && typeof record.detail === 'string' ? failureCategory(record.detail) : undefined;
      };
      const models = createModels({ credentials: credentialStore(this.ctx.storage, this.env) });
      models.setProvider(limitProvider(openaiCodexProvider(), () => this.admitModelCall(), category => this.ctx.storage.put('model-failure', category)));
      const registry = createRegistry();
      registry.install({ name: 'personal', sections: [{ key: 'protocol', tag: false, render: () =>
        `${protocol}\nTimezone: ${this.env.AGENT_TIMEZONE}. Current local time: ${new Date().toLocaleString('en-US', { timeZone: this.env.AGENT_TIMEZONE })}. Repository: ${this.env.GITHUB_REPOSITORY}.` }],
        tools: [
          ...this.sunsama.tools(),
          defineTool({ name: 'engage_pool', description: 'Manage the X engagement pool (accounts whose posts are scanned daily). list shows status and members; add/remove take handles; reset empties the pool so the next run reseeds from the deployed seed list (only when the user explicitly asks).',
            parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('remove'), Type.Literal('reset')]), handles: Type.Optional(Type.Array(Type.String())) }),
            replay: 'safe', executionMode: 'sequential',
            execute: async ({ action, handles }) => {
              if (action === 'add') return result(await this.engage.add(handles ?? []));
              if (action === 'remove') return result({ removed: await this.engage.remove(handles ?? []) });
              if (action === 'reset') return result({ cleared: await this.engage.reset() });
              return result({ status: await this.engage.status(), members: (await this.engage.pool()).map(m => ({ handle: m.handle, role: m.role, followers: m.followers, source: m.source, lastSeen: m.lastSeen })) });
            } }),
          defineTool({ name: 'engage_run', description: 'Run the X engagement engine now. daily adds a pull of posts worth replying to in the portal Engage tab; expand grows the pool from who members follow. Costs twitterapi.io credits; do not repeat on failure.',
            parameters: Type.Object({ kind: Type.Union([Type.Literal('daily'), Type.Literal('expand')]) }), replay: 'unsafe', executionMode: 'sequential',
            execute: async ({ kind }) => result(await this.engageRun(kind)) }),
          defineTool({ name: 'list_files', description: 'List a directory in the configured Obsidian repository.',
            parameters: Type.Object({ path: Type.String() }), replay: 'safe',
            execute: async ({ path }) => result(await this.github.list(path)) }),
          defineTool({ name: 'read_file', description: 'Read a UTF-8 repository file and its SHA; null means absent.',
            parameters: Type.Object({ path: Type.String() }), replay: 'safe',
            execute: async ({ path }) => result(await this.github.read(path)) }),
          defineTool({ name: 'write_file', description: 'Commit a whole UTF-8 file. Provide SHA from read_file; null only for a new file. Preserve unrelated content.',
            parameters: Type.Object({ path: Type.String(), content: Type.String(), expectedSha: Type.Union([Type.String(), Type.Null()]), message: Type.String() }),
            replay: 'safe', executionMode: 'sequential',
            execute: async ({ path, content, expectedSha, message }) => result(await this.github.write(path, content, expectedSha, message)) }),
          ...(this.ctx.container ? [defineTool({ name: 'run_command', description: 'Run Bash in an isolated temporary Debian sandbox with no credentials or Internet. For scripts/calculations; use repository tools for GitHub.',
            parameters: Type.Object({ command: Type.String() }), replay: 'unsafe', executionMode: 'sequential',
            execute: async ({ command }) => result(await this.runCommand(command)) })] : []),
        ],
      });
      return Harness.open(storage, { models, registry,
        settings: { toolExecution: 'sequential', retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 },
          stream: { transport: 'sse', timeoutMs: 120_000, maxRetries: 0 },
          compaction: { backgroundTokens: 0 } },
        onReport: () => console.error('Personal agent extension failed.'),
      }, context);
    },
    defaults: { model: { provider: 'openai-codex', id: this.env.AGENT_MODEL }, thinkingLevel: 'low' },
  });
  private lifecycle = Lifecycle.install(this).use(this.mcp).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.mcp.configureOAuthCallback({ customHandler: result => new Response(null, { status: 303,
      headers: { Location: '/personal/?sunsama=' + (result.authSuccess ? 'connected' : 'error') } }) });
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(60_000));
  }

  async submit(id: string, message: string): Promise<AgentRequest> {
    await this.lifecycle.start();
    const next = this.line.then(async () => {
      if (!this.env.CODEX_OAUTH_JSON) throw new Error('Codex subscription login is not configured.');
      const key = `request:${id}`;
      let row = await this.ctx.storage.get<AgentRequest>(key);
      if (row && row.message !== message) throw new Error('Request ID already belongs to a different message.');
      if (!row) {
        const day = new Date().toISOString().slice(0, 10);
        await this.ctx.storage.transaction(async tx => {
          const counter = await tx.get<{ day: string; count: number }>('daily-count');
          const count = counter?.day === day ? counter.count : 0;
          const limit = Number(this.env.MAX_REQUESTS_PER_DAY);
          if (!Number.isInteger(limit) || limit < 1 || count >= limit) throw new Error('Daily request limit reached.');
          row = { id, message, created: new Date().toISOString(), status: 'queued' };
          await tx.put(key, row);
          await tx.put('daily-count', { day, count: count + 1 });
        });
      }
      await this.harness.submit(message, { operationId: id });
      return row!;
    });
    this.line = next.catch(() => {});
    return next;
  }

  async request(id: string): Promise<AgentRequest | null> {
    await this.lifecycle.start();
    const row = await this.ctx.storage.get<AgentRequest>(`request:${id}`);
    if (!row || row.status === 'done' || row.status === 'unanswered') return row ?? null;
    // Re-admit with the same key after interruption between receipt storage and Pi admission.
    await this.harness.submit(row.message, { operationId: id });
    try {
      const outcome = await this.harness.wait(id, { signal: AbortSignal.timeout(100) });
      row.status = outcome.status;
      row.text = outcome.text;
      const category = outcome.status === 'unanswered' && outcome.reason === 'model_error'
        ? await this.failureDetail?.(outcome.session, id) ?? await this.ctx.storage.get<string>('model-failure') : undefined;
      row.reason = outcome.status === 'unanswered' ? `The agent could not finish (${outcome.reason}${category ? ': ' + category : ''}). Check connections or ask it to inspect the previous task before retrying edits.` : undefined;
      await this.ctx.storage.put(`request:${id}`, row);
    } catch (error) {
      if (!(error instanceof Error) || !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      row.status = (await this.harness.pending()).find(p => p.operationId === id)?.status ?? 'queued';
    }
    return row;
  }

  async history(): Promise<AgentRequest[]> {
    const rows = await this.ctx.storage.list<AgentRequest>({ prefix: 'request:' });
    return [...rows.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 30);
  }

  async stop(id: string) { await this.lifecycle.start(); return this.harness.abort({ operationId: id }); }

  async engageStatus() { await this.lifecycle.start(); return this.engage.status(); }
  async engageToday() { await this.lifecycle.start(); return this.engage.todayPulls(); }
  async engageRun(kind: 'daily' | 'expand') {
    await this.lifecycle.start();
    // One run at a time; a second trigger waits rather than double-spending credits.
    const next = this.engageLine.then(async () => {
      const outcome = kind === 'expand' ? await this.engage.expand() : await this.engage.daily();
      // Report counts rather than handle lists.
      if ('expanded' in outcome) return { kind, ...outcome, expanded: outcome.expanded.length };
      if ('pruned' in outcome) return { kind, ...outcome, pruned: outcome.pruned.length };
      return { kind, ...outcome };
    });
    this.engageLine = next.catch(() => {});
    return next;
  }

  async sunsamaStatus() { return this.sunsama.status(); }
  async sunsamaConnect() { return this.sunsama.connect(); }
  async sunsamaDisconnect() { return this.sunsama.disconnect(id => clearSunsamaCredentials(this.ctx.storage, id)); }
  async sunsamaCallback(request: Request) {
    return this.sunsama.exclusive(async () => {
      const response = await this.lifecycle.fetch(request);
      // An invalid/missing OAuth state never produces a success screen.
      return response.status === 303 ? response : new Response(null, { status: 303, headers: { Location: '/personal/?sunsama=error' } });
    });
  }

  private async admitModelCall() {
    await this.ctx.storage.transaction(async tx => {
      const day = new Date().toISOString().slice(0, 10);
      const counter = await tx.get<{ day: string; count: number }>('model-count');
      const count = counter?.day === day ? counter.count : 0;
      const limit = Number(this.env.MAX_MODEL_CALLS_PER_DAY);
      if (!Number.isInteger(limit) || limit < 1 || count >= limit) throw new Error('Model-call limit reached.');
      await tx.put('model-count', { day, count: count + 1 });
    });
  }

  private async runCommand(command: string) {
    const container = this.ctx.container!;
    if (!container.running) container.start({ image: 'cloudflare/debian-trixie', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    await container.setInactivityTimeout(60_000);
    const process = await container.exec(['timeout', '--kill-after=5', '60', 'bash', '-lc', command]);
    const output = await process.output();
    const decoder = new TextDecoder();
    return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout).slice(-10_000), stderr: decoder.decode(output.stderr).slice(-10_000) };
  }
}
