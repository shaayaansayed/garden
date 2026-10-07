// One-time local crawl that builds the engagement feed from scratch: seed followings and lane searches, a shortlist by how many seeds follow each person,
// recent posts judged by Jev, then the top 300 by score.
// Run: bun bootstrap-feed.ts [--dry-run] [--judge 1500] [--feed 300] [--min 1000] [--max 300000] [--interval 250] [--only a,b,c].
// Keys from .dev.vars or the environment. --only judges just those handles and prints them, for checking the judge.
import { mkdir } from 'node:fs/promises';
import { TwitterApi, CREDITS_PER_DOLLAR, tweetTime } from './twitterapi';
import type { XTweet, XUser } from './twitterapi';
import { Jev, choice, noul, score } from './jev';
import type { Answers, Question } from './jev';
import { COMMENTER, ROLES, SUBLANES, TOPICS, clean, short } from './engage';

export interface Candidate { handle: string; name: string; bio: string; followers: number; overlap: number; keyword: number; seed: boolean }
export interface Judged extends Candidate {
  postsPerWeek: number; medianLikes: number; links: number; lanes: string[]; laneShare: number; role: string;
  individual: number; promotional: number; slop: number; discussion: number; audience: number; fit: number; score: number;
}
const DAY = 86_400_000;
const POSTS_JUDGED = 12;
export const QUERIES = [
  '"value-based care" OR "value based care" OR "risk adjustment" OR "Medicare Advantage"',
  '"fee-for-service" OR "fee for service" OR ACO OR "accountable care"',
  '"clinical AI" OR "ambient scribe" OR "sepsis model" OR "predictive model" hospital',
  '"AI evaluation" OR "model validation" OR "silent mode" OR "prospective study" health AI',
  '"quality measures" OR HEDIS OR "Star ratings" OR readmissions hospital',
  '"clinical operations" OR "care management" OR "length of stay" OR "patient flow" OR throughput hospital',
  '"clinical workflow" OR "care pathway" OR "order set" OR "nurse staffing" OR "discharge planning"',
  '"prior authorization" OR PBM OR "pharmacy benefit"',
  'Medicaid eligibility OR "Medicaid unwinding" OR "Medicaid redetermination"',
  'hospice OR "post-acute" OR "skilled nursing" Medicare margins',
  '"health system" AI deployment OR "AI governance" hospital',
  'CMS rule OR "final rule" Medicare payment',
];
// Each post is classified into one of these. Counting happens in code, which Jev's docs recommend over asking it to judge "regularly".
export const POST_LANES: Record<string, string> = {
  ...TOPICS,
  healthcare_other: 'healthcare, but none of the lanes above: clinical practice, biotech, public health, biosecurity, health IT, consumer wellness',
  ai_general: 'AI, software, or technology not specific to healthcare',
  not_healthcare: 'not about healthcare or technology: politics, sports, personal life, general business or markets',
};
const POST_WEIGHT = (lane: string) => SUBLANES[lane]?.admit ?? (lane === 'healthcare_other' ? 0.25 : 0);

export function shortlist(candidates: Candidate[], limit: number, min: number, max: number): Candidate[] {
  return candidates
    .filter(c => c.followers >= min && c.followers <= max && (c.seed || c.overlap >= 2 || c.keyword >= 1))
    .sort((a, b) => priority(b) - priority(a)).slice(0, limit);
}
// Keyword finds stay eligible but get no bonus: lane searches mostly surface people outside the seeds' crowd.
const priority = (c: Candidate) => c.overlap + (c.seed ? 3 : 0);

export function activity(tweets: XTweet[], now: number) {
  const originals = tweets.filter(t => !t.retweeted_tweet && tweetTime(t) > 0);
  const recent = originals.filter(t => now - tweetTime(t) < 30 * DAY);
  const likes = originals.map(t => t.likeCount ?? 0).sort((a, b) => a - b);
  const span = originals.length ? Math.max(DAY, now - Math.min(...originals.map(tweetTime))) : DAY;
  return {
    recent: recent.length,
    postsPerWeek: Math.round(originals.length / (span / (7 * DAY)) * 10) / 10,
    medianLikes: likes.length ? likes[Math.floor(likes.length / 2)] : 0,
    links: originals.length ? Math.round(originals.filter(t => /https?:\/\//.test(t.text)).length / originals.length * 100) / 100 : 0,
    texts: originals.slice(0, POSTS_JUDGED).map(t => t.text.slice(0, 400)),
  };
}

// One account per call: state holds just this person's name, bio, and posts, so questions point straight at them.
export function questionsFor(posts: number): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (let k = 0; k < posts; k++) q[`p${k}_lane`] = { type: 'choice', instructions: `Which lane is \`posts[${k}]\` mainly about?`, criteria: POST_LANES };
  q.individual = { type: 'noul', instructions: 'Is `account` a single named person rather than a company, publication, podcast, or community account?' };
  q.promotional = { type: 'noul', instructions: 'Are most of `posts` promotional announcements, event plugs, hiring, or link drops rather than opinions, analysis, or discussion?' };
  q.slop = { type: 'noul', instructions: 'Are most of `posts` generic takes, engagement bait, motivational lines, or AI hype without specific claims, numbers, or first-hand detail?',
    criteria: { true: 'Vague, recycled, or hype-driven content with nothing specific', false: 'Specific claims, data, examples, or first-hand observations' } };
  q.discussion = { type: 'score', instructions: 'How much do `posts` invite informed discussion from healthcare operators?', criteria: [
    'Announcements or statements with nothing to respond to', 'Opinions that leave little to add', 'Arguments, data, or questions that invite informed replies', 'Contested claims or open questions where an expert reply would stand out'] };
  q.audience = { type: 'score', instructions: 'How likely is it that people who follow `account` would also want to follow `commenter`?', criteria: [
    'Different world: the audience has no reason to care about the commenter\'s work', 'Some overlap: a minority would be interested', 'Strong overlap: most of the audience works in or follows the same corner of healthcare', 'Same audience: the commenter is exactly who these followers look for'] };
  q.role = { type: 'choice', instructions: 'Based on `account` and `posts`, which role best describes this person?', criteria: ROLES };
  return q;
}

export function judgeAnswers(c: Candidate, s: ReturnType<typeof activity>, answers: Answers): Omit<Judged, 'fit' | 'score'> {
  const perPost = s.texts.map((_, k) => choice(answers[`p${k}_lane`], 'not_healthcare'));
  const counts: Record<string, number> = {};
  for (const lane of perPost) counts[lane] = (counts[lane] ?? 0) + 1;
  const lanes = Object.keys(SUBLANES).filter(l => (counts[l] ?? 0) >= 2).sort((a, b) => counts[b] - counts[a]);
  const laneShare = perPost.length ? round(perPost.reduce((sum, lane) => sum + POST_WEIGHT(lane), 0) / perPost.length) : 0;
  return { ...c, postsPerWeek: s.postsPerWeek, medianLikes: s.medianLikes, links: s.links, lanes, laneShare, role: choice(answers.role),
    individual: noul(answers.individual), promotional: noul(answers.promotional), slop: noul(answers.slop),
    discussion: score(answers.discussion), audience: score(answers.audience) };
}

// Lane fit is full once 40% of someone's posts sit in Shay's lanes. Slop and promotion only cost points above even odds,
// so a noisy 0.6 is a nudge, not a veto.
export function rank(j: Omit<Judged, 'fit' | 'score'>): Pick<Judged, 'fit' | 'score'> {
  const lane = Math.min(1, j.laneShare / 0.4);
  const gate = (p: number) => 1 - Math.max(0, p - 0.5) * 1.6;
  const fit = round(lane * gate(j.promotional) * gate(j.slop) * j.individual * (0.5 + 0.5 * j.discussion / 3) * (0.6 + 0.4 * j.audience / 3));
  const cadence = j.postsPerWeek >= 7 ? 1 : j.postsPerWeek >= 3 ? 0.9 : j.postsPerWeek >= 1 ? 0.7 : 0.4;
  const rate = j.followers ? j.medianLikes / j.followers : 0;
  const engagement = rate >= 0.004 ? 1 : rate >= 0.001 ? 0.85 : 0.65;
  // Very large accounts are less likely to notice or follow back, so they count three quarters as much; they still make the feed on merit.
  const size = j.followers > 100_000 ? 0.75 : 1;
  return { fit, score: round(fit * cadence * engagement * size) };
}
const round = (n: number) => Math.round(n * 100) / 100;

export function render(ranked: Judged[], feed: number, credits: number): string {
  const rows = ranked.map((j, i) => `| ${i + 1} | @${j.handle} | ${j.name.replace(/\|/g, ' ')} | ${short(j.followers)} | ${j.role} | ${j.lanes.join(', ') || '-'} | ${Math.round(j.laneShare * 100)}% | ${j.postsPerWeek}/wk | ${j.overlap} | ${j.score.toFixed(2)} | ${j.seed ? 'seed' : ''} |`);
  return ['# Feed candidates', '', `Top ${feed} of ${ranked.length} judged accounts, ranked by lane share × quality × cadence × engagement × size. Lane share is the part of their recent posts that falls in Shay's lanes. Crawl cost $${(credits / CREDITS_PER_DOLLAR).toFixed(2)}. Strike anyone wrong, then copy seeds.txt over engage-seeds.txt.`, '',
    '| # | Handle | Name | Followers | Role | Lanes | Lane share | Cadence | Followed by seeds | Score | |', '|---|---|---|---|---|---|---|---|---|---|---|', ...rows.slice(0, feed), '',
    '## Below the line', '', ...rows.slice(feed, feed + 100), ''].join('\n');
}

export async function loadEnv() {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const file = Bun.file('.dev.vars');
  if (await file.exists()) for (const line of (await file.text()).split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/); if (m && !env[m[1]]) env[m[1]] = m[2];
  }
  return env;
}
// Every successful HTTP response is cached on disk by URL (GET) or body (POST), so an interrupted run resumes without re-spending.
export function cachingFetch(dir: string, stats: { hits: number; misses: number }): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? String(init.body) : '';
    const name = new Bun.CryptoHasher('sha256').update(url + '\n' + body).digest('hex').slice(0, 32);
    const file = Bun.file(`${dir}/http/${name}.json`);
    if (await file.exists()) { stats.hits++; return new Response(await file.text(), { status: 200, headers: { 'content-type': 'application/json', 'x-cache': 'hit' } }); }
    const r = await fetch(input, init);
    if (r.ok) { const text = await r.text(); stats.misses++; await Bun.write(file, text); return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
    return r;
  }) as typeof fetch;
}
function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  return Promise.all(Array.from({ length: width }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main() {
  const arg = (name: string, fallback: number) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
  const dry = process.argv.includes('--dry-run'), judgeLimit = arg('judge', 1500), feedSize = arg('feed', 300), min = arg('min', 1_000), max = arg('max', 300_000);
  const onlyAt = process.argv.indexOf('--only'), only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(',').map(h => clean(h).toLowerCase())) : null;
  const env = await loadEnv();
  if (!env.TWITTERAPI_KEY || !env.TYPESAFE_API_KEY) throw new Error('Set TWITTERAPI_KEY and TYPESAFE_API_KEY in .dev.vars or the environment.');
  const dir = '.engage-bootstrap'; await mkdir(`${dir}/http`, { recursive: true });
  const stats = { hits: 0, misses: 0 }, send = cachingFetch(dir, stats);
  const twitter = new TwitterApi(env.TWITTERAPI_KEY, send, 10_000, arg('interval', 250)), jev = new Jev(env.TYPESAFE_API_KEY, send);
  const seeds = (await Bun.file('engage-seeds.txt').text()).split('\n').map(clean).filter(l => l && !l.startsWith('#'));
  const now = Date.now();
  const candidates = new Map<string, Candidate>();
  const upsert = (u: XUser, patch: Partial<Candidate>) => {
    const k = u.userName.toLowerCase();
    const c = candidates.get(k) ?? { handle: u.userName, name: u.name ?? '', bio: u.description ?? '', followers: u.followers ?? 0, overlap: 0, keyword: 0, seed: seeds.some(s => s.toLowerCase() === k) };
    Object.assign(c, { name: u.name ?? c.name, bio: u.description ?? c.bio, followers: u.followers ?? c.followers });
    c.overlap += patch.overlap ?? 0; c.keyword += patch.keyword ?? 0; candidates.set(k, c);
  };
  for (const seed of seeds) {
    const users: XUser[] = []; let cursor = '';
    for (let page = 0; page < 5; page++) { const r = await twitter.followings(seed, cursor); users.push(...r.users); if (!r.next) break; cursor = r.next; }
    for (const u of users) upsert(u, { overlap: 1 });
    const me = await twitter.user(seed);
    if (me) upsert(me, {});
    if (!only) console.error(`followings ${seed}: ${users.length} (candidates ${candidates.size}, $${(twitter.credits / CREDITS_PER_DOLLAR).toFixed(2)}, cache ${stats.hits}/${stats.hits + stats.misses})`);
  }
  for (const [i, query] of QUERIES.entries()) for (const type of ['Latest', 'Top'] as const) {
    const tweets: XTweet[] = []; let cursor = '';
    for (let page = 0; page < 3; page++) { const r = await twitter.search(`${query} lang:en -filter:replies -filter:retweets`, cursor); tweets.push(...r.tweets); if (!r.next) break; cursor = r.next; }
    for (const t of tweets) if (t.author?.userName) upsert(t.author, { keyword: 1 });
  }
  const list = only ? [...candidates.values()].filter(c => only.has(c.handle.toLowerCase())) : shortlist([...candidates.values()], judgeLimit, min, max);
  console.error(`${candidates.size} candidates, ${list.length} ${only ? 'selected' : 'shortlisted'}; crawl so far $${(twitter.credits / CREDITS_PER_DOLLAR).toFixed(2)}; judging costs about $${(list.length * 300 / CREDITS_PER_DOLLAR).toFixed(2)} more before cache.`);
  if (dry) return;
  const judged: Judged[] = [];
  await pool(list, 4, async c => {
    const s = activity(await twitter.lastTweets(c.handle), now);
    if (s.recent < 3) { if (only) console.error(`@${c.handle}: inactive (${s.recent} posts in 30 days)`); return; }
    const state = { commenter: COMMENTER, account: { name: c.name, handle: c.handle, bio: c.bio.slice(0, 200) }, posts: s.texts };
    const base = judgeAnswers(c, s, await jev.ask(state, questionsFor(s.texts.length)));
    judged.push({ ...base, ...rank(base) });
    if (!only && judged.length % 50 === 0) console.error(`judged ${judged.length} ($${(twitter.credits / CREDITS_PER_DOLLAR).toFixed(2)}, Jev ${jev.inputTokens} tokens)`);
  });
  judged.sort((a, b) => b.score - a.score);
  if (only) {
    for (const j of judged) console.log(`@${j.handle.padEnd(16)} score ${j.score.toFixed(2)} share ${Math.round(j.laneShare * 100)}% lanes [${j.lanes.join(',')}] slop ${j.slop.toFixed(2)} promo ${j.promotional.toFixed(2)} disc ${j.discussion.toFixed(1)} aud ${j.audience.toFixed(1)} ${j.role}`);
    console.error(`Jev ${jev.inputTokens} fresh input tokens.`);
    return;
  }
  await Bun.write(`${dir}/review.md`, render(judged, feedSize, twitter.credits));
  await Bun.write(`${dir}/seeds.txt`, ['# Built by bootstrap-feed.ts on ' + new Date().toISOString().slice(0, 10), ...judged.slice(0, feedSize).map(j => j.handle)].join('\n') + '\n');
  await Bun.write(`${dir}/judged.json`, JSON.stringify(judged, null, 1));
  console.error(`Done. ${judged.length} judged, ${judged.filter(j => j.score > 0).length} above zero, top ${feedSize} in ${dir}/seeds.txt, review in ${dir}/review.md. Spent $${(twitter.credits / CREDITS_PER_DOLLAR).toFixed(2)} this run, ${stats.hits} of ${stats.hits + stats.misses} calls from cache, Jev ${jev.inputTokens} fresh input tokens.`);
}
if (import.meta.main) await main();
