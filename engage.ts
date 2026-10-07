import { CREDITS_PER_DOLLAR, TwitterApi, tweetTime } from './twitterapi';
import type { XTweet, XUser } from './twitterapi';
import { Jev, choice, noul, score } from './jev';
import type { Answers, Question } from './jev';

// Daily X engagement finder: monitors a pool of healthcare accounts, has Jev judge posts and people, writes a vault note.
export interface Member {
  handle: string; id?: string; name?: string; bio?: string; followers?: number; role?: string; topics?: string[]; fit?: number;
  added: string; source: 'seed' | 'expand' | 'manual'; lastSeen?: string; lastExpanded?: string;
}
interface Candidate { handle: string; name?: string; bio?: string; followers?: number; count: number; firstSeen: string }
interface Judgment { at: string; accepted: boolean; fit: number }
export interface EngageState {
  lastDaily?: string; lastExpand?: string; lastError?: string; lastRun?: string;
  monthly?: { month: string; credits: number }; myFollowers?: number; changes?: string[];
}
export interface Pick {
  id: string; url: string; handle: string; name: string; followers?: number; role?: string; ageHours: number;
  replies: number; likes: number; text: string; lane: string; claim: string; hook: string; angle: string; strength: number;
  drop?: string; // why a judged post did not make the picks
  heat?: number; // Jev's probability that the post is a partisan attack, insult, or outrage
}
// One pull per scheduled run. The portal's Engage tab shows today's pulls; the list starts over each day.
export interface Pull { at: string; scanned: number; judged: number; picks: Pick[] }
export interface EngageToday { date: string; pulls: Pull[] }

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface EngageConfig {
  dir: string; timezone: string; monthlyCredits: number; myHandle: string;
  minFollowers?: number; maxFollowers?: number; picks?: number;
}
export interface EngageDeps {
  store: Store;
  twitter: () => TwitterApi;
  jev: Jev;
  github: { read(path: string): Promise<{ sha: string; content: string } | null>; write(path: string, content: string, sha: string | null, message: string): Promise<unknown> };
  seeds: string[];
  config: EngageConfig;
  now?: () => Date;
  onJudged?: (rows: Pick[]) => void; // every judged post with its score, for local previews
}

const KEYS = { pool: 'engage:pool', candidates: 'engage:candidates', judged: 'engage:judged', seen: 'engage:seen', state: 'engage:state', today: 'engage:today' };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const HANDLES_PER_QUERY = 15, PAGES_PER_QUERY = 2, MAX_JUDGED_TWEETS = 300;
const EXPAND_MEMBERS = 8, EXPAND_JUDGE = 15, MAX_ADDS = 8, MIN_OVERLAP = 2, PRUNE_DAYS = 45, REJUDGE_DAYS = 90;
// Who is commenting. Jev reads this once per batch to judge expertise fit; keep it short and factual.
export const COMMENTER = 'Founder of a healthcare robotics startup focused on hospital and care operations. Previously five years as growth lead at ClosedLoop, a healthcare AI company that built risk-stratification and predictive models for health systems, payers, and value-based care organizations, improving care protocols and clinical operations workflows (risk stratification, medication management, ICU triage, care management programs) and winning the CMS AI Health Outcomes Challenge. Sold AI into health systems and payers from the vendor side and now runs a startup, so knows health tech go-to-market and fundraising first-hand. Has evaluated, deployed, and run clinical AI programs inside health systems and knows quality measures and the workflows behind them. Former Bridgewater investment associate. Machine learning research background. Writes evidence-driven essays on clinical AI explainability and evaluation, hospice and Medicare payment incentives, and Medicaid enrollment.';
// One table drives both scorers. post: weight when ranking a post for the daily picks. admit: weight when judging a person for the feed.
// Healthcare AI gets a slight edge in the picks (1.2), since it is where Shay most wants to be seen.
// Robotics stays a post lane, since Shay is the expert when it comes up, but it is too niche for this crowd to count toward admission.
export const SUBLANES: Record<string, { topic: string; post: number; admit: number }> = {
  ai_evaluation: { topic: 'how health AI is evaluated and proven: validation, prospective studies, monitoring, bias, and evidence of return on investment', post: 1.2, admit: 1 },
  ai_care_delivery: { topic: 'AI used in care delivery: ambient scribes, clinical decision support, predictive models, and deployment or adoption stories', post: 1.2, admit: 1 },
  ai_adoption: { topic: 'how health systems, payers, and providers buy, govern, and roll out AI: procurement, governance, budgets, and change management', post: 1.2, admit: 1 },
  quality: { topic: 'quality measures and outcomes: HEDIS, Star ratings, readmissions, CMS quality programs, and patient safety', post: 1, admit: 1 },
  clinical_ops: { topic: 'clinical operations: throughput, capacity, length of stay, discharge, staffing, and care management', post: 1, admit: 1 },
  clinical_workflows: { topic: 'clinical workflows and program rollouts: care pathways, protocols, running clinical programs, and change management on the floor', post: 1, admit: 1 },
  value_based_care: { topic: 'value-based care and risk: Medicare Advantage, risk adjustment, ACOs, capitation, and shared savings', post: 1, admit: 1 },
  payer_pharmacy: { topic: 'payer and pharmacy economics: insurers, premiums, PBMs, prior authorization, drug pricing, and claims', post: 1, admit: 1 },
  provider_economics: { topic: 'provider economics: hospital and physician margins, reimbursement rates, site-neutral payment, consolidation, and private equity', post: 1, admit: 1 },
  public_programs: { topic: 'Medicare and Medicaid policy: CMS rules, eligibility and enrollment, post-acute and hospice payment, and health policy analysis', post: 0.9, admit: 0.9 },
  healthtech_business: { topic: 'healthcare companies as businesses: health tech startups, fundraising for health companies, go-to-market into health systems and payers, and why health companies succeed or fail; general startup advice that is not about healthcare does not count', post: 1, admit: 1 },
  robotics: { topic: 'robots, automation, or physical AI in hospital operations, logistics, pharmacy, labs, or home care; surgical robots do not count', post: 0.6, admit: 0 },
};
export const TOPICS: Record<string, string> = Object.fromEntries(Object.entries(SUBLANES).map(([k, v]) => [k, v.topic]));
export const ROLES: Record<string, string> = {
  executive: 'C-level, president, or VP at a healthcare, payer, provider, or health tech company',
  investor: 'venture capitalist, angel, or fund partner who invests in healthcare',
  founder: 'founder or early operator at a startup',
  clinician: 'practicing physician, nurse, or other clinician',
  academic: 'professor, researcher, or economist at a university or think tank',
  journalist: 'reporter, analyst, newsletter writer, or podcaster',
  other: 'none of the above, or unclear',
};
// Lane weight: how much a reply in this lane builds the audience Shay wants. Zero drops the post.
const LANES: Record<string, [string, number]> = {
  ...Object.fromEntries(Object.entries(SUBLANES).map(([k, v]) => [k, [v.topic, v.post] as [string, number]])),
  ai_technical: ['general AI, LLM, or machine learning claims not specific to healthcare', 0.6],
  startup_general: ['startups, fundraising, venture capital, hiring, or company building, not specific to healthcare', 0.25],
  healthcare_other: ['healthcare, but none of the lanes above: clinical practice, health IT and interoperability, surgical robots, biotech, consumer wellness, hiring, culture', 0.4],
  not_healthcare: ['not about healthcare or AI', 0],
};
// Claim weight: what kind of post it is. Announcements and personal posts rarely reward a substantive reply.
const CLAIMS: Record<string, [string, number]> = {
  evidence: ['shares numbers, a study, a chart, or a document and draws a conclusion from it', 1],
  argument: ['makes a causal, strategic, or contrarian argument in the author\'s own words', 1],
  question: ['asks the audience a genuine question', 0.9],
  news: ['links or summarizes news with little commentary of the author\'s own', 0.6],
  announcement: ['a launch, funding, hiring, event, podcast episode, or self-promotion', 0.15],
  personal: ['a personal update, celebration, joke, or thank-you', 0],
};
const HOOKS: Record<string, string> = {
  unstated_assumption: 'the conclusion rests on an assumption the post never states',
  missing_tradeoff: 'the post ignores a cost, second-order effect, or who pays',
  mechanism: 'the post asserts an effect without explaining the mechanism that produces it',
  data_context: 'the numbers or study need context, a denominator, or a comparison to mean what the post claims',
  implementation: 'the idea skips how it would work in a real health system, payer, or regulatory process',
  none: 'the post is complete as written; nothing substantive is missing',
};
const ANGLES: Record<string, string> = {
  ask_question: 'the best reply would ask a sharpening question about a gap or assumption',
  add_evidence: 'the best reply would add data, a source, or a concrete example that extends the point',
  push_back: 'the best reply would respectfully disagree with a specific claim',
  share_experience: 'the best reply would share first-hand operator, builder, or clinical experience',
  none: 'there is nothing useful to reply with',
};
const EXPERTISE = [
  'No overlap with the commenter\'s experience',
  'Adjacent: the commenter could comment as an informed generalist',
  'Direct: the post is squarely in one of the commenter\'s areas',
  'First-hand: the commenter has built, sold, or analyzed exactly this',
];
// The six questions Jev answers about every pulled post. Code turns the answers into a reply score.
const POST_QUESTIONS: Record<string, Question> = {
  lane: { type: 'choice', instructions: 'Which lane does `post` belong to?', criteria: Object.fromEntries(Object.entries(LANES).map(([k, [d]]) => [k, d])) },
  claim: { type: 'choice', instructions: 'What kind of post is `post`?', criteria: Object.fromEntries(Object.entries(CLAIMS).map(([k, [d]]) => [k, d])) },
  hook: { type: 'choice', instructions: 'What is the most important thing `post` leaves out that an informed reply could name?', criteria: HOOKS },
  contestable: { type: 'noul', instructions: 'Does `post` make a claim that a well-informed person could reasonably disagree with or qualify?',
    criteria: { true: 'A specific claim, prediction, or recommendation that could be challenged with evidence or experience', false: 'A fact, announcement, or statement nobody would dispute' } },
  expertise: { type: 'score', instructions: 'How closely does `post` match the experience described in `commenter`?', criteria: EXPERTISE },
  angle: { type: 'choice', instructions: 'Which kind of reply to `post` would add the most value?', criteria: ANGLES },
  heated: { type: 'noul', instructions: 'Would replying to `post` drag `commenter` into a partisan or personal fight?',
    criteria: { true: 'The post attacks or mocks a party, politician, official, or person, assigns partisan blame, is about elections, or uses insults', false: 'The post analyzes policy, data, or business, even if it sharply criticizes a decision or names who made it' } },
};
// Heat lowers a post's score in proportion: 0.6 heat costs 30%. Only near-certain insults are dropped outright.
const HEAT_WEIGHT = 0.5, HEAT_LIMIT = 0.85;
const MIN_STRENGTH = 1.2; // with 7 picks per run and two runs a day, this lands at 5 to 14 picks on a normal day
const freshness = (hours: number) => hours <= 6 ? 1 : hours <= 12 ? 0.8 : hours <= 24 ? 0.6 : 0.4;
const crowd = (replies: number) => replies < 10 ? 1 : replies < 25 ? 0.8 : replies < 75 ? 0.55 : 0.3;
const audience = (followers?: number) => followers === undefined ? 0.9 : followers < 1_000 ? 0.5 : followers < 5_000 ? 0.8 : followers <= 100_000 ? 1 : followers <= 500_000 ? 0.85 : 0.6;
// X returns HTML-escaped text with t.co links. Show the real URLs, drop trailing t.co links (media or quoted posts), unescape.
export function postText(t: { text: string; entities?: XTweet['entities'] }): string {
  let text = t.text;
  for (const u of t.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  return text.replace(/(\s*https?:\/\/t\.co\/\w+)+\s*$/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}
export const clean = (handle: string) => handle.trim().replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, '').split(/[/?]/)[0] ?? '';
const key = (handle: string) => clean(handle).toLowerCase();
export const band = (n?: number) => n === undefined ? 'unknown' : n < 1_000 ? 'under 1k' : n < 5_000 ? '1k-5k' : n < 20_000 ? '5k-20k' : n < 100_000 ? '20k-100k' : n < 500_000 ? '100k-500k' : 'over 500k';
export const short = (n?: number) => n === undefined ? '?' : n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1e3)}k` : String(n);

export class Engage {
  private now: () => Date;
  constructor(private deps: EngageDeps) { this.now = deps.now ?? (() => new Date()); }

  private get config() { return this.deps.config; }
  private today(at = this.now()) { return at.toLocaleDateString('en-CA', { timeZone: this.config.timezone }); }

  async pool(): Promise<Member[]> {
    const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool);
    if (pool && Object.keys(pool).length) return Object.values(pool).sort((a, b) => a.handle.localeCompare(b.handle));
    const added = this.now().toISOString();
    const seeded: Record<string, Member> = {};
    for (const h of this.deps.seeds.map(clean).filter(Boolean)) seeded[key(h)] = { handle: h, added, source: 'seed', lastSeen: added };
    await this.deps.store.put(KEYS.pool, seeded);
    return Object.values(seeded);
  }

  async todayPulls(): Promise<EngageToday> {
    const date = this.today(), stored = await this.deps.store.get<EngageToday>(KEYS.today);
    return stored?.date === date ? stored : { date, pulls: [] };
  }

  async status(): Promise<EngageState & { members: number; spentUsd: number }> {
    const state = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
    const month = this.today().slice(0, 7);
    const credits = state.monthly?.month === month ? state.monthly.credits : 0;
    return { ...state, members: (await this.pool()).length, spentUsd: Math.round(credits / CREDITS_PER_DOLLAR * 100) / 100 };
  }

  async add(handles: string[], source: Member['source'] = 'manual'): Promise<{ added: string[]; existing: string[] }> {
    await this.pool();
    const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool) ?? {};
    const added: string[] = [], existing: string[] = [];
    const at = this.now().toISOString();
    for (const raw of handles) {
      const h = clean(raw); if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) continue;
      if (pool[key(h)]) existing.push(h); else { pool[key(h)] = { handle: h, added: at, source, lastSeen: at }; added.push(h); }
    }
    await this.deps.store.put(KEYS.pool, pool);
    if (added.length) await this.log(`${this.today()} added ${added.map(h => '@' + h).join(' ')} (${source})`);
    return { added, existing };
  }

  async remove(handles: string[]): Promise<string[]> {
    await this.pool();
    const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool) ?? {};
    const judged = await this.deps.store.get<Record<string, Judgment>>(KEYS.judged) ?? {};
    const removed: string[] = [];
    for (const raw of handles) {
      const h = clean(raw), k = key(h); if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) continue;
      removed.push(pool[k]?.handle ?? h); delete pool[k];
      judged[k] = { at: this.now().toISOString(), accepted: false, fit: 0 }; // Never add a removed account automatically.
    }
    await this.deps.store.put(KEYS.pool, pool);
    await this.deps.store.put(KEYS.judged, judged);
    if (removed.length) await this.log(`${this.today()} removed ${removed.map(h => '@' + h).join(' ')} (manual)`);
    return removed;
  }

  // Drop every member so the next run reseeds from the bundled list; removal blocks are kept.
  async reset(): Promise<number> {
    const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool) ?? {};
    const count = Object.keys(pool).length;
    await this.deps.store.put(KEYS.pool, {});
    await this.deps.store.put(KEYS.candidates, {});
    await this.log(`${this.today()} reset the pool (${count} members); reseeding from the bundled list on the next run`);
    return count;
  }

  private async log(line: string) {
    const state = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
    state.changes = [line, ...(state.changes ?? [])].slice(0, 40);
    await this.deps.store.put(KEYS.state, state);
  }

  private async withBudget<T>(kind: 'daily' | 'expand', fn: (twitter: TwitterApi) => Promise<T>): Promise<T | { skipped: string }> {
    const state = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
    const month = this.today().slice(0, 7);
    const spent = state.monthly?.month === month ? state.monthly.credits : 0;
    if (spent >= this.config.monthlyCredits) {
      state.lastError = `Monthly twitterapi.io budget reached (${month}); ${kind} run skipped.`;
      await this.deps.store.put(KEYS.state, state);
      return { skipped: state.lastError };
    }
    const twitter = this.deps.twitter();
    try {
      return await fn(twitter);
    } catch (error) {
      const fresh = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      fresh.lastError = `${this.now().toISOString()} ${kind}: ${error instanceof Error ? error.message : 'failed'}`;
      await this.deps.store.put(KEYS.state, fresh);
      throw error;
    } finally {
      const fresh = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      const credits = (fresh.monthly?.month === month ? fresh.monthly.credits : 0) + twitter.credits;
      fresh.monthly = { month, credits }; fresh.lastRun = this.now().toISOString();
      await this.deps.store.put(KEYS.state, fresh);
    }
  }

  // Daily: search the pool's posts since the last run, judge them, write the day's note.
  async daily() {
    return this.withBudget('daily', async twitter => {
      const members = await this.pool();
      const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool) ?? {};
      const state = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      const seen = await this.deps.store.get<Record<string, string>>(KEYS.seen) ?? {};
      const nowMs = this.now().getTime();
      const since = Math.max(state.lastDaily ? Date.parse(state.lastDaily) - HOUR : 0, nowMs - 36 * HOUR);
      if (!state.myFollowers || !state.lastDaily || nowMs - Date.parse(state.lastDaily) > 7 * DAY) {
        const me = await twitter.user(this.config.myHandle).catch(() => null);
        if (me) state.myFollowers = me.followers;
      }
      const tweets = new Map<string, XTweet>();
      for (let i = 0; i < members.length; i += HANDLES_PER_QUERY) {
        const batch = members.slice(i, i + HANDLES_PER_QUERY);
        const query = `(${batch.map(m => 'from:' + m.handle).join(' OR ')}) since_time:${Math.floor(since / 1000)} -filter:replies -filter:retweets`;
        let cursor = '';
        for (let page = 0; page < PAGES_PER_QUERY; page++) {
          const result = await twitter.search(query, cursor);
          for (const t of result.tweets) if (t?.id && t.author?.userName) tweets.set(t.id, t);
          if (!result.next) break;
          cursor = result.next;
        }
      }
      for (const t of tweets.values()) {
        const m = pool[key(t.author.userName)]; if (!m) continue;
        Object.assign(m, profile(t.author), { lastSeen: new Date(Math.max(tweetTime(t), Date.parse(m.lastSeen ?? '') || 0)).toISOString() });
      }
      const fresh = [...tweets.values()].filter(t => !seen[t.id] && !t.isReply && !t.retweeted_tweet && pool[key(t.author.userName)]
        && (t.lang ?? 'en') === 'en' && t.text.replace(/https?:\S+/g, '').trim().length >= 40 && nowMs - tweetTime(t) < 30 * HOUR)
        .sort((a, b) => tweetTime(b) - tweetTime(a)).slice(0, MAX_JUDGED_TWEETS);
      const picks = await this.judgeTweets(fresh, pool, nowMs);
      const date = this.today();
      const stored = await this.deps.store.get<EngageToday>(KEYS.today);
      const pulls = stored?.date === date ? stored.pulls : [];
      pulls.push({ at: new Date(nowMs).toISOString(), scanned: tweets.size, judged: fresh.length, picks: picks.map(({ drop, ...p }) => p) });
      await this.deps.store.put(KEYS.today, { date, pulls });
      const cutoff = nowMs - 4 * DAY;
      for (const [id, at] of Object.entries(seen)) if (Date.parse(at) < cutoff) delete seen[id];
      for (const p of fresh) seen[p.id] = new Date(nowMs).toISOString(); // judged once; a later pull never re-scores it
      const pruned = this.prune(pool, nowMs);
      await this.deps.store.put(KEYS.seen, seen);
      await this.deps.store.put(KEYS.pool, pool);
      const latest = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      Object.assign(latest, { lastDaily: new Date(nowMs).toISOString(), lastError: undefined, myFollowers: state.myFollowers });
      if (pruned.length) latest.changes = [`${date} pruned ${pruned.map(h => '@' + h).join(' ')} (no posts in ${PRUNE_DAYS} days)`, ...(latest.changes ?? [])].slice(0, 40);
      await this.deps.store.put(KEYS.state, latest);
      return { date, picks: picks.length, scanned: tweets.size, judged: fresh.length, credits: twitter.credits, pruned };
    });
  }

  private prune(pool: Record<string, Member>, nowMs: number): string[] {
    const pruned: string[] = [];
    for (const [k, m] of Object.entries(pool)) {
      const last = Math.max(Date.parse(m.lastSeen ?? '') || 0, Date.parse(m.added) || 0);
      if (nowMs - last > PRUNE_DAYS * DAY) { pruned.push(m.handle); delete pool[k]; }
    }
    return pruned;
  }

  // One tweet per Jev call: the state is just this post and its author, so every question points straight at it.
  private async judgeTweets(tweets: XTweet[], pool: Record<string, Member>, nowMs: number): Promise<Pick[]> {
    const rows: Pick[] = [], queue = [...tweets];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const state = { commenter: COMMENTER, author: { name: t.author.name, handle: t.author.userName, bio: (t.author.description ?? '').slice(0, 200) },
          post: postText(t).slice(0, 1200), quoted: t.quoted_tweet ? postText(t.quoted_tweet).slice(0, 400) : undefined };
        rows.push(this.scoreTweet(t, await this.deps.jev.ask(state, POST_QUESTIONS), pool, nowMs));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    this.deps.onJudged?.(rows);
    const picks = rows.filter(r => !r.drop).sort((a, b) => b.strength - a.strength);
    const perAuthor: Record<string, number> = {};
    return picks.filter(p => (perAuthor[p.handle] = (perAuthor[p.handle] ?? 0) + 1) <= 2).slice(0, this.config.picks ?? 7);
  }

  private scoreTweet(t: XTweet, answers: Answers, pool: Record<string, Member>, nowMs: number): Pick {
    const lane = choice(answers.lane, 'not_healthcare'), claim = choice(answers.claim, 'personal');
    const hook = choice(answers.hook, 'none'), angle = choice(answers.angle, 'none');
    const laneWeight = LANES[lane]?.[1] ?? 0, claimWeight = CLAIMS[claim]?.[1] ?? 0;
    const hookStrength = 0.5 * (hook === 'none' ? 0 : 1) + 0.5 * noul(answers.contestable);
    const expertise = Math.min(3, Math.max(0, score(answers.expertise))) / 3;
    const substance = laneWeight * claimWeight * (0.4 + 0.6 * hookStrength) * (0.5 + 0.5 * expertise);
    const ageHours = Math.max(0, (nowMs - tweetTime(t)) / HOUR);
    const replies = t.replyCount ?? 0;
    const m = pool[key(t.author.userName)];
    const author = audience(t.author.followers) * (0.75 + 0.25 * (m?.fit ?? 1));
    const heat = noul(answers.heated);
    const strength = Math.round(3 * substance * freshness(ageHours) * crowd(replies) * author * (1 - HEAT_WEIGHT * heat) * 100) / 100;
    const drop = !laneWeight ? 'off lane' : !claimWeight ? 'personal post' : heat >= HEAT_LIMIT ? 'heated' : angle === 'none' ? 'nothing to add' : strength < MIN_STRENGTH ? 'below threshold' : undefined;
    return { id: t.id, url: t.url ?? `https://x.com/${t.author.userName}/status/${t.id}`, handle: t.author.userName, name: t.author.name,
      followers: t.author.followers, role: m?.role, ageHours, replies, likes: t.likeCount ?? 0, text: postText(t),
      lane: lane.replaceAll('_', ' '), claim, hook: hook.replaceAll('_', ' '), angle: angle.replaceAll('_', ' '), strength, drop, heat: Math.round(heat * 100) / 100 };
  }

  // Weekly: walk who the pool follows, score the overlap, judge the best candidates, grow the pool.
  async expand() {
    return this.withBudget('expand', async twitter => {
      const members = await this.pool();
      const pool = await this.deps.store.get<Record<string, Member>>(KEYS.pool) ?? {};
      const candidates = await this.deps.store.get<Record<string, Candidate>>(KEYS.candidates) ?? {};
      const judged = await this.deps.store.get<Record<string, Judgment>>(KEYS.judged) ?? {};
      const state = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      const nowMs = this.now().getTime(), at = new Date(nowMs).toISOString(), date = this.today();
      const due = members.sort((a, b) => (Date.parse(a.lastExpanded ?? '') || 0) - (Date.parse(b.lastExpanded ?? '') || 0)).slice(0, EXPAND_MEMBERS);
      for (const m of due) {
        const { users } = await twitter.followings(m.handle);
        for (const u of users) {
          const k = key(u.userName); if (!u.userName || pool[k]) continue;
          const c = candidates[k] ?? { handle: u.userName, count: 0, firstSeen: at };
          Object.assign(c, { name: u.name, bio: u.description, followers: u.followers, count: c.count + 1 });
          candidates[k] = c;
        }
        pool[key(m.handle)].lastExpanded = at;
      }
      for (const [k, c] of Object.entries(candidates)) if (c.count < MIN_OVERLAP && nowMs - Date.parse(c.firstSeen) > 60 * DAY) delete candidates[k];
      const min = this.config.minFollowers ?? 1_000, max = this.config.maxFollowers ?? Math.max(300_000, 25 * (state.myFollowers ?? 0));
      const shortlist = Object.values(candidates)
        .filter(c => !pool[key(c.handle)] && c.count >= MIN_OVERLAP && (c.followers ?? 0) >= min && (c.followers ?? 0) <= max
          && !(judged[key(c.handle)] && nowMs - Date.parse(judged[key(c.handle)].at) < REJUDGE_DAYS * DAY))
        .sort((a, b) => b.count - a.count || (b.followers ?? 0) - (a.followers ?? 0)).slice(0, EXPAND_JUDGE);
      const added: string[] = [];
      for (const c of shortlist) {
        const tweets = (await twitter.lastTweets(c.handle)).filter(t => !t.retweeted_tweet);
        const recent = tweets.filter(t => nowMs - tweetTime(t) < 14 * DAY).length;
        const verdict = recent >= 3 ? await this.judgeAccount(c, tweets) : { fit: 0, role: 'other', topics: [] as string[] };
        judged[key(c.handle)] = { at, accepted: verdict.fit >= 0.6 && added.length < MAX_ADDS, fit: verdict.fit };
        if (!judged[key(c.handle)].accepted) continue;
        pool[key(c.handle)] = { handle: c.handle, name: c.name, bio: c.bio, followers: c.followers, role: verdict.role, topics: verdict.topics, fit: verdict.fit,
          added: at, source: 'expand', lastSeen: at };
        added.push(`@${c.handle} (${verdict.role}, ${verdict.topics.join('/') || 'healthcare'}, ${short(c.followers)} followers, followed by ${c.count} pool members)`);
      }
      await this.deps.store.put(KEYS.pool, pool);
      await this.deps.store.put(KEYS.candidates, candidates);
      await this.deps.store.put(KEYS.judged, judged);
      const latest = await this.deps.store.get<EngageState>(KEYS.state) ?? {};
      latest.lastExpand = at; latest.lastError = undefined;
      if (added.length) latest.changes = [`${date} added ${added.join('; ')}`, ...(latest.changes ?? [])].slice(0, 40);
      await this.deps.store.put(KEYS.state, latest);
      const path = `${this.config.dir}/Pool.md`;
      const existing = await this.deps.github.read(path);
      await this.deps.github.write(path, this.renderPool(Object.values(pool), latest), existing?.sha ?? null, `Engage pool ${date}`);
      return { date, expanded: due.map(m => m.handle), candidates: Object.keys(candidates).length, judged: shortlist.length, added: added.length, credits: twitter.credits };
    });
  }

  private async judgeAccount(c: Candidate, tweets: XTweet[]): Promise<{ fit: number; role: string; topics: string[] }> {
    const state = { handle: c.handle, name: c.name, bio: c.bio, followers: band(c.followers), recent_posts: tweets.slice(0, 8).map(t => t.text.slice(0, 400)) };
    // Topics mirror the ranking lanes so the pool grows toward accounts whose posts Shay can answer.
    const questions: Record<string, Question> = {
      individual: { type: 'noul', instructions: 'Is this account a single named person rather than a company, publication, podcast, or community account?' },
      promotional: { type: 'noul', instructions: 'Are `recent_posts` mostly promotional announcements, event plugs, or link drops rather than opinions, analysis, or discussion?' },
      role: { type: 'choice', instructions: 'Based on `bio`, which role best describes this person?', criteria: ROLES },
    };
    for (const [k, v] of Object.entries(TOPICS)) questions[`topic_${k}`] = { type: 'noul', instructions: { question: `Do \`bio\` and \`recent_posts\` show this person regularly discussing \`topic\`?`, topic: v } };
    const answers = await this.deps.jev.ask(state, questions);
    const topics = Object.keys(TOPICS).filter(k => noul(answers[`topic_${k}`]) >= 0.5);
    const topic = Math.max(...Object.keys(TOPICS).map(k => noul(answers[`topic_${k}`]) * SUBLANES[k].admit));
    const fit = noul(answers.individual) < 0.5 || noul(answers.promotional) >= 0.7 ? 0 : Math.round(topic * 100) / 100;
    return { fit, role: choice(answers.role), topics };
  }

  private renderPool(members: Member[], state: EngageState): string {
    const rows = members.sort((a, b) => a.handle.localeCompare(b.handle, undefined, { sensitivity: 'base' }))
      .map(m => `| @${m.handle} | ${m.name ?? ''} | ${short(m.followers)} | ${m.role ?? ''} | ${(m.topics ?? []).join(', ')} | ${m.source} | ${m.added.slice(0, 10)} | ${(m.lastSeen ?? '').slice(0, 10)} |`);
    return ['# Engage pool', '', `${members.length} accounts. Generated by the personal agent; edit through the portal (engage_pool) rather than here.`, '',
      '| Handle | Name | Followers | Role | Topics | Source | Added | Last post |', '|---|---|---|---|---|---|---|---|', ...rows, '',
      '## Changes', ...(state.changes ?? []).map(c => `- ${c}`), ''].join('\n');
  }
}

function profile(u: XUser): Partial<Member> {
  return { id: u.id, name: u.name, bio: u.description, followers: u.followers };
}
