// Local dry run of the daily scan against live X data. Prints the pull the Engage tab would show, then every judged post
// with its score and why it was dropped, for tuning. Saves the pull to .engage-bootstrap/preview/today.json.
// Run: bun engage-preview.ts [--at 2026-10-07T17:00:00Z]. Reusing the same --at replays searches and Jev answers from cache for free.
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Engage, clean } from './engage';
import type { Pick, Store } from './engage';
import { TwitterApi, CREDITS_PER_DOLLAR } from './twitterapi';
import { Jev } from './jev';
import { cachingFetch, loadEnv } from './bootstrap-feed';

const atArg = process.argv.indexOf('--at');
const at = new Date(atArg > 0 ? process.argv[atArg + 1] : new Date().toISOString().slice(0, 16) + ':00Z');
const env = await loadEnv();
if (!env.TWITTERAPI_KEY || !env.TYPESAFE_API_KEY) throw new Error('Set TWITTERAPI_KEY and TYPESAFE_API_KEY in .dev.vars or the environment.');
const dir = '.engage-bootstrap', out = `${dir}/preview`;
await mkdir(`${dir}/http`, { recursive: true });
await rm(out, { recursive: true, force: true }); // each preview is one clean run
const stats = { hits: 0, misses: 0 }, send = cachingFetch(dir, stats);
const data = new Map<string, unknown>();
const store: Store = { get: async <T,>(k: string) => data.get(k) as T | undefined, put: async (k, v) => { data.set(k, v); } };
const rows: Pick[] = [];
let twitter: TwitterApi | undefined;
const jev = new Jev(env.TYPESAFE_API_KEY, send);
const engage = new Engage({
  store, now: () => at, onJudged: r => rows.push(...r),
  seeds: (await Bun.file('engage-seeds.txt').text()).split('\n').map(clean).filter(l => l && !l.startsWith('#')),
  twitter: () => (twitter = new TwitterApi(env.TWITTERAPI_KEY, send, 150, 300)), jev,
  github: {
    read: async p => { const f = Bun.file(`${out}/${p}`); return await f.exists() ? { sha: 'local', content: await f.text() } : null; },
    write: async (p, content) => { await mkdir(dirname(`${out}/${p}`), { recursive: true }); await Bun.write(`${out}/${p}`, content); return {}; },
  },
  config: { dir: 'Engage', timezone: 'America/New_York', monthlyCredits: 500_000, myHandle: env.X_HANDLE ?? 'ShaayaanS' },
});
const result = await engage.daily();
const today = await engage.todayPulls();
await mkdir(out, { recursive: true });
await Bun.write(`${out}/today.json`, JSON.stringify(today, null, 1));
for (const [i, p] of (today.pulls.at(-1)?.picks ?? []).entries()) console.log(`${i + 1}. ${p.name} @${p.handle} · ${Math.round(p.ageHours)}h · ${p.replies} replies · ${p.lane} · ${p.angle} on ${p.hook} · ${p.strength}\n   ${p.text.replace(/\s+/g, ' ').slice(0, 160)}\n`);
console.log('## Every judged post\n');
const tally: Record<string, number> = {};
for (const r of rows) tally[r.drop ?? 'picked'] = (tally[r.drop ?? 'picked'] ?? 0) + 1;
console.log(Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · '), '\n');
for (const r of rows.sort((a, b) => b.strength - a.strength)) {
  console.log(`${r.strength.toFixed(2)} heat ${(r.heat ?? 0).toFixed(2)} ${(r.drop ?? 'PICK').padEnd(15)} @${r.handle.padEnd(16)} ${Math.round(r.ageHours)}h ${r.replies}r · ${r.lane} · ${r.claim} · ${r.hook} · ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
}
console.error(`\n--at ${at.toISOString()} · ${JSON.stringify(result)} · twitterapi $${((twitter?.credits ?? 0) / CREDITS_PER_DOLLAR).toFixed(3)} · ${stats.hits}/${stats.hits + stats.misses} calls cached · Jev ${jev.inputTokens} tokens`);
