import { expect, test } from 'bun:test';
import { activity, judgeAnswers, questionsFor, rank, render, shortlist } from './bootstrap-feed';
import type { Answers } from './jev';
import { TOPICS } from './engage';
import type { Candidate, Judged } from './bootstrap-feed';
import type { XTweet } from './twitterapi';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const c = (handle: string, extra: Partial<Candidate> = {}): Candidate => ({ handle, name: handle, bio: '', followers: 20_000, overlap: 0, keyword: 0, seed: false, ...extra });
const t = (daysAgo: number, likes = 10, text = 'A post about risk adjustment in Medicare Advantage with enough length.'): XTweet =>
  ({ id: String(Math.random()), text, author: { id: 'u', userName: 'x', name: 'x', followers: 1 }, createdAt: new Date(NOW - daysAgo * 86_400_000).toUTCString(), likeCount: likes });

test('shortlist keeps seeds, overlap, and keyword hits inside the follower band and orders by priority', () => {
  const list = shortlist([c('tiny', { followers: 100, overlap: 5 }), c('huge', { followers: 900_000, overlap: 5 }), c('lonely', { overlap: 1 }),
    c('kw', { keyword: 3 }), c('popular', { overlap: 4 }), c('seedy', { seed: true })], 10, 1_000, 300_000);
  expect(list.map(x => x.handle)).toEqual(['popular', 'seedy', 'kw']); // keyword finds are eligible but get no ranking bonus
  expect(shortlist([c('a', { overlap: 2 }), c('b', { overlap: 3 })], 1, 0, 1e9).map(x => x.handle)).toEqual(['b']);
});

test('activity measures cadence, median likes, and link share from original posts only', () => {
  const a = activity([t(1, 5), t(2, 50, 'see https://x.y'), t(3, 20), t(20, 100), { ...t(0), retweeted_tweet: t(0) }], NOW);
  expect(a.recent).toBe(4); // the 20-day-old post counts inside the 30-day window
  expect(a.medianLikes).toBe(50);
  expect(a.links).toBe(0.25);
  expect(a.postsPerWeek).toBeCloseTo(1.4, 1);
  expect(a.texts.length).toBe(4);
});

test('rank rewards lane share, discussion, audience overlap, and cadence while punishing heavy slop and promotion', () => {
  const base: Omit<Judged, 'fit' | 'score'> = { ...c('a'), postsPerWeek: 8, medianLikes: 120, links: 0.1, lanes: ['value_based_care'], laneShare: 0.5, role: 'investor',
    individual: 1, promotional: 0.1, slop: 0.1, discussion: 2.5, audience: 2.5 };
  const good = rank(base), slop = rank({ ...base, slop: 0.9 }), quiet = rank({ ...base, postsPerWeek: 0.5, medianLikes: 2 }), offLane = rank({ ...base, laneShare: 0 });
  expect(good.score).toBeGreaterThan(0.6);
  expect(slop.score).toBeLessThan(good.score * 0.4);
  expect(rank({ ...base, slop: 0.5 }).score).toBe(good.score); // slop at even odds costs nothing
  expect(quiet.score).toBeLessThan(good.score * 0.6);
  expect(offLane.score).toBe(0);
  expect(rank({ ...base, laneShare: 0.2 }).score).toBeCloseTo(good.score / 2, 1); // lane fit is full at 40% of posts
  expect(rank({ ...base, followers: 3_000 }).score).toBe(good.score); // under 5k and 5k to 100k weigh the same
  expect(rank({ ...base, followers: 250_000, medianLikes: 120 * 12.5 }).score).toBeCloseTo(good.score * 0.75, 1); // over 100k counts three quarters
});

test('each post is classified and lane share is counted in code; robotics does not count toward admission', () => {
  const s = { recent: 10, postsPerWeek: 4, medianLikes: 30, links: 0, texts: Array(10).fill('post') };
  const lanes = ['value_based_care', 'value_based_care', 'value_based_care', 'value_based_care', 'robotics', 'robotics', 'healthcare_other', 'not_healthcare', 'not_healthcare', 'ai_general'];
  const answers: Answers = Object.fromEntries(lanes.map((l, k) => [`p${k}_lane`, { type: 'choice', choice: l, probabilities: {}, confidence: 0.9 }]));
  Object.assign(answers, { individual: { type: 'noul', noul: 0.9 }, role: { type: 'choice', choice: 'investor', probabilities: {}, confidence: 0.8 } });
  const j = judgeAnswers(c('a'), s, answers);
  expect(j.lanes).toEqual(['value_based_care', 'robotics']);
  expect(j.laneShare).toBe(0.43); // four full posts plus a quarter for other healthcare, out of ten
  expect(j.role).toBe('investor');
});

test('questions point at one account and review output is shaped for review', () => {
  const q = questionsFor(3);
  expect(Object.keys(q).length).toBe(3 + 6);
  expect(JSON.stringify(q)).toContain('`posts[2]`');
  expect(Object.keys((q.p0_lane as { criteria: Record<string, unknown> }).criteria)).toEqual([...Object.keys(TOPICS), 'healthcare_other', 'ai_general', 'not_healthcare']);
  const j: Judged = { ...c('alice', { overlap: 7 }), postsPerWeek: 5, medianLikes: 40, links: 0, lanes: ['ai_evaluation'], laneShare: 0.6, role: 'founder', individual: 1, promotional: 0, slop: 0, discussion: 2, audience: 2, fit: 0.8, score: 0.75 };
  const md = render([j, { ...j, handle: 'bob', score: 0.5 }], 1, 123_456);
  expect(md).toContain('| 1 | @alice |');
  expect(md).toContain('| 60% |');
  expect(md.indexOf('@bob')).toBeGreaterThan(md.indexOf('## Below the line'));
  expect(md).toContain('$1.23');
});

