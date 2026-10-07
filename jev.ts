// TypeSafe Jev: a System One decision model. State plus typed questions in, calibrated answers out, no generation.
export type Question =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> };
export type Answers = Record<string, Answer | undefined>;

export class Jev {
  calls = 0;
  inputTokens = 0;
  constructor(private key: string, private send: typeof fetch = fetch.bind(globalThis), private model = 'jev-latest') {}

  async ask(state: unknown, questions: Record<string, Question>): Promise<Answers> {
    if (!this.key) throw new Error('TypeSafe is not configured.');
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const r = await this.send('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', body, signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      });
      if ((r.status === 429 || r.status === 529) && attempt < 2) { await new Promise(f => setTimeout(f, 1500 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error(`TypeSafe request failed (${r.status}).`);
      const data = await r.json() as { answers?: Answers; usage?: { input_tokens?: number } };
      this.inputTokens += data.usage?.input_tokens ?? 0;
      return data.answers ?? {};
    }
  }
}

export const noul = (a: Answer | undefined) => a?.type === 'noul' ? a.noul : 0;
export const score = (a: Answer | undefined) => a?.type === 'score' ? a.score : 0;
export const choice = (a: Answer | undefined, fallback = 'other') => a?.type === 'choice' ? a.choice : fallback;
