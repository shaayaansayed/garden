import { expect, test } from 'bun:test';
import { Engage, clean, postText } from './engage';
import type { Store } from './engage';
import { TwitterApi } from './twitterapi';
import type { XTweet, XUser } from './twitterapi';
import { Jev } from './jev';

const NOW = new Date('2026-10-06T11:00:00Z');
const user = (userName: string, followers = 12_000, description = 'healthcare investor'): XUser => ({ id: 'u-' + userName, userName, name: userName.toUpperCase(), followers, description });
const tweet = (id: string, author: string, text: string, hoursAgo = 2, extra: Partial<XTweet> = {}): XTweet => ({
  id, text, author: user(author), createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toUTCString(), replyCount: 3, likeCount: 20, ...extra,
});
function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return { get: async <T,>(k: string) => structuredClone(data.get(k)) as T | undefined, put: async (k, v) => { data.set(k, structuredClone(v)); } };
}
interface World { queries: string[]; followings: Record<string, XUser[]>; lastTweets: Record<string, XTweet[]>; searchTweets: XTweet[]; jevCalls: number; judge: (state: any, questions: Record<string, any>) => Record<string, unknown>; files: Record<string, string>; writes: number; lastJevBody?: string }
// Jev's answer per question key; every other key (heated, the topics) is a noul.
const ANSWERS: Record<string, unknown> = {
  lane: { type: 'choice', choice: 'value_based_care' }, claim: { type: 'choice', choice: 'argument' }, hook: { type: 'choice', choice: 'missing_tradeoff' },
  contestable: { type: 'noul', noul: 0.8 }, expertise: { type: 'score', score: 2.5 }, angle: { type: 'choice', choice: 'add_evidence' },
  individual: { type: 'noul', noul: 0.95 }, promotional: { type: 'noul', noul: 0.1 }, role: { type: 'choice', choice: 'investor' },
};
function world(): World {
  return { queries: [], followings: {}, lastTweets: {}, searchTweets: [], jevCalls: 0, files: {}, writes: 0,
    judge: (_state, questions) => Object.fromEntries(Object.keys(questions).map(k => [k, ANSWERS[k] ?? { type: 'noul', noul: k === 'topic_value_based_care' ? 0.8 : 0.2 }])) };
}
function fetcher(w: World): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(url.host === 'api.twitterapi.io' ? (init?.headers as Record<string, string>)['x-api-key'] : (init?.headers as Record<string, string>).Authorization).toBeTruthy();
    if (url.pathname === '/v1/systemone') {
      w.jevCalls++;
      w.lastJevBody = String(init?.body);
      const body = JSON.parse(String(init?.body)) as { state: unknown; questions: Record<string, unknown> };
      return Response.json({ answers: w.judge(body.state, body.questions), usage: { input_tokens: 500 } });
    }
    if (url.pathname === '/twitter/user/info') return Response.json({ status: 'success', data: user(url.searchParams.get('userName')!, 900) });
    if (url.pathname === '/twitter/tweet/advanced_search') {
      const q = url.searchParams.get('query')!; w.queries.push(q);
      const handles = [...q.matchAll(/from:(\w+)/g)].map(m => m[1].toLowerCase());
      return Response.json({ tweets: w.searchTweets.filter(t => handles.includes(t.author.userName.toLowerCase())), has_next_page: false, next_cursor: '' });
    }
    if (url.pathname === '/twitter/user/followings') return Response.json({ followings: (w.followings[url.searchParams.get('userName')!] ?? []).map(u => ({ id: u.id, screen_name: u.userName, name: u.name, description: u.description, followers_count: u.followers })), has_next_page: false, next_cursor: '' });
    if (url.pathname === '/twitter/user/last_tweets') return Response.json({ status: 'success', tweets: w.lastTweets[url.searchParams.get('userName')!] ?? [], has_next_page: false });
    throw new Error('unexpected ' + url.href);
  }) as typeof fetch;
}
function engine(w: World, seeds = ['@alice', 'bob', 'https://x.com/carol'], monthlyCredits = 500_000) {
  const send = fetcher(w), store = memoryStore();
  const engage = new Engage({
    store, seeds, now: () => NOW, twitter: () => new TwitterApi('k', send), jev: new Jev('j', send),
    github: { read: async p => w.files[p] === undefined ? null : { sha: 'sha-' + w.files[p].length, content: w.files[p] },
      write: async (p, c, sha, m) => { expect(sha).toBe(w.files[p] === undefined ? null : 'sha-' + w.files[p].length); expect(m.length).toBeLessThan(200); w.files[p] = c; w.writes++; return {}; } },
    config: { dir: 'Engage', timezone: 'America/New_York', monthlyCredits, myHandle: 'ShaayaanS' },
  });
  return { engage, store };
}

test('handles are normalized and the pool seeds itself once', async () => {
  expect(['@Alice', 'https://x.com/Bob?s=20', 'twitter.com/carol/status/1'].map(clean)).toEqual(['Alice', 'Bob', 'carol']);
  const { engage } = engine(world());
  expect((await engage.pool()).map(m => m.handle)).toEqual(['alice', 'bob', 'carol']);
  expect(await engage.add(['@Dave', 'bob', 'not a handle'])).toEqual({ added: ['Dave'], existing: ['bob'] });
  expect(await engage.remove(['@BOB'])).toEqual(['bob']);
  expect((await engage.pool()).map(m => m.handle).sort()).toEqual(['Dave', 'alice', 'carol'].sort());
  expect((await engage.status()).changes?.[0]).toContain('removed @bob');
  expect(await engage.reset()).toBe(3);
  expect((await engage.pool()).map(m => m.handle)).toEqual(['alice', 'bob', 'carol']); // reseeded from the file; bob's block only affects admission
});

test('daily run batches searches, judges fresh posts, stores the pull for the Engage tab, and never repeats a pick', async () => {
  const w = world();
  w.searchTweets = [
    tweet('1', 'alice', 'Value-based care contracts fail when the attribution model is wrong. Here is the data from 40 ACOs.'),
    tweet('2', 'bob', 'Hot take: fee-for-service is not the problem, the fee schedule is. Change my mind.', 9, { replyCount: 20, likeCount: 300 }),
    tweet('3', 'carol', 'Thanks everyone for a great week!', 1),
    tweet('4', 'alice', 'RT content', 1, { retweeted_tweet: tweet('9', 'zed', 'x') }),
    tweet('5', 'bob', 'Replying to a thread with a long enough message to pass the length filter easily', 1, { isReply: true }),
    tweet('6', 'carol', 'Old post about PBMs that is far too old to be a candidate for a reply today, sadly', 40),
    tweet('7', 'mallory', 'Not in the pool but somehow returned by search, should be ignored by the filter', 1),
  ];
  const seeds = Array.from({ length: 31 }, (_, i) => 'h' + i).concat(['alice', 'bob', 'carol']);
  const { engage, store } = engine(w, seeds);
  const first = await engage.daily();
  if ('skipped' in first) throw new Error(first.skipped);
  expect(w.queries.length).toBe(3);
  for (const q of w.queries) { expect((q.match(/from:/g) ?? []).length).toBeLessThanOrEqual(15); expect(q).toContain('since_time:'); expect(q).toContain('-filter:replies'); }
  expect(first.judged).toBe(2);
  expect(first.picks).toBe(2);
  const pull = (await engage.todayPulls()).pulls[0];
  expect(pull.scanned).toBe(6);
  expect(pull.picks.map(p => p.handle)).toEqual(['alice', 'bob']);
  expect(pull.picks[0]).toMatchObject({ url: 'https://x.com/alice/status/1', lane: 'value based care', claim: 'argument', hook: 'missing tradeoff', angle: 'add evidence' });
  expect(JSON.stringify(pull)).not.toContain('Thanks everyone');
  expect(w.writes).toBe(0); // nothing goes to the vault
  expect(first.credits).toBe(18 + 15 * 2 + 15 * 6); // profile, two empty searches, six tweets
  const sent = JSON.parse(String(w.lastJevBody)) as { state: { commenter: string; post: string; author: { handle: string } }; questions: Record<string, { criteria?: unknown }> };
  expect(sent.state.commenter).toContain('ClosedLoop'); expect(sent.state.post.length).toBeGreaterThan(40);
  expect(Object.keys(sent.questions)).toEqual(['lane', 'claim', 'hook', 'contestable', 'expertise', 'angle', 'heated']);
  expect(w.jevCalls).toBe(2); // one call per judged post
  expect((await engage.status()).spentUsd).toBe(0);
  expect(((await store.get<Record<string, { followers: number }>>('engage:pool'))!).alice.followers).toBe(12_000);
  const second = await engage.daily();
  if ('skipped' in second) throw new Error(second.skipped);
  expect(second.picks).toBe(0);
  const today = await engage.todayPulls();
  expect(today.date).toBe('2026-10-06');
  expect(today.pulls.map(p => p.picks.length)).toEqual([2, 0]); // the first pull's picks stay put
  await store.put('engage:today', { date: '2026-10-05', pulls: today.pulls });
  expect((await engage.todayPulls()).pulls).toEqual([]); // yesterday's pulls are not shown today
});

test('the monthly credit budget stops runs and failures record an error without hiding spend', async () => {
  const w = world();
  const { engage } = engine(w, ['alice'], 30);
  w.searchTweets = [tweet('1', 'alice', 'A long enough healthcare post about Medicare Advantage risk adjustment and coding intensity.')];
  const first = await engage.daily();
  expect('skipped' in first).toBe(false);
  const second = await engage.daily();
  expect('skipped' in second && second.skipped).toContain('budget');
  expect((await engage.status()).lastError).toContain('budget');
  const broken = engine(w, ['alice']);
  w.judge = () => { throw new Error('provider detail'); };
  await expect(broken.engage.daily()).rejects.toThrow();
  const state = await broken.store.get<{ lastError: string; monthly: { credits: number } }>('engage:state');
  expect(state!.lastError).toContain('daily');
  expect(state!.monthly.credits).toBeGreaterThan(0);
});

test('expansion scores overlap, judges with Jev, adds accepted accounts, and respects removals', async () => {
  const w = world();
  const dan = user('dan', 15_000, 'GP at a health fund'), eve = user('eve', 8_000, 'founder'), huge = user('huge', 2_000_000), tiny = user('tiny', 200), gone = user('gone', 9_000);
  w.followings = { alice: [dan, eve, huge, tiny, gone], bob: [dan, eve, huge, tiny, gone], carol: [dan] };
  const posts = (h: string) => Array.from({ length: 5 }, (_, i) => tweet('p' + h + i, h, 'Post about payer economics and value-based care number ' + i, 24 * i));
  w.lastTweets = { dan: posts('dan'), eve: posts('eve').slice(0, 1), gone: posts('gone') };
  const { engage, store } = engine(w);
  await engage.remove(['gone']);
  const result = await engage.expand();
  if ('skipped' in result) throw new Error(result.skipped);
  expect(result.expanded).toEqual(['alice', 'bob', 'carol']);
  expect(result.judged).toBe(2);
  expect(result.added).toBe(1);
  const pool = (await store.get<Record<string, { source: string; role: string; topics: string[]; fit: number }>>('engage:pool'))!;
  expect(pool.dan).toMatchObject({ source: 'expand', role: 'investor', topics: ['value_based_care'] });
  expect(pool.eve).toBeUndefined();
  expect(pool.gone).toBeUndefined();
  expect(w.files['Engage/Pool.md']).toContain('| @dan |');
  expect(w.files['Engage/Pool.md']).toContain('added @dan (investor, value_based_care, 15k followers, followed by 3 pool members)');
  expect(w.jevCalls).toBe(1);
  const again = await engage.expand();
  if ('skipped' in again) throw new Error(again.skipped);
  expect(again.judged).toBe(0);
});

test('post text shows real links, drops trailing media links, and unescapes X entities', () => {
  expect(postText({ text: 'Margins &amp; prices &lt;3 https://t.co/abc see https://t.co/xyz', entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://kff.org/report' }] } }))
    .toBe('Margins & prices <3 https://kff.org/report see');
  expect(postText({ text: 'Chart below https://t.co/m1 https://t.co/m2' })).toBe('Chart below');
});
