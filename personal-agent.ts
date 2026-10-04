import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
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

// Pi's default OAuth loader uses variable imports unavailable in a bundled Worker.
registerBunOAuthFlows();

export interface AgentRequest {
  id: string; message: string; created: string;
  status: 'queued' | 'running' | 'done' | 'unanswered'; text?: string; reason?: string;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export class PersonalAgent extends DurableObject<Env> {
  private github = new GitHub(this.env);
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
  private lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(60_000));
  }

  async submit(id: string, message: string): Promise<AgentRequest> {
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

  async stop(id: string) { return this.harness.abort({ operationId: id }); }

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
