// Minimal read-only twitterapi.io client with a credit meter. Never touches Shay's X login.
export interface XUser {
  id: string; userName: string; name: string; description?: string; location?: string;
  followers: number; following?: number; statusesCount?: number; isBlueVerified?: boolean; createdAt?: string;
}
export interface XTweet {
  id: string; url?: string; text: string; createdAt: string; lang?: string;
  replyCount?: number; likeCount?: number; retweetCount?: number; quoteCount?: number; viewCount?: number;
  isReply?: boolean; inReplyToId?: string; author: XUser; quoted_tweet?: XTweet | null; retweeted_tweet?: XTweet | null;
  entities?: { urls?: { url: string; expanded_url?: string }[] };
}
type Legacy = { screen_name?: string; followers_count?: number; friends_count?: number; statuses_count?: number; created_at?: string };
type Page<K extends string, T> = { [key in K]?: T[] } & { has_next_page?: boolean; next_cursor?: string; status?: string; msg?: string; message?: string; data?: unknown };

export const CREDITS_PER_DOLLAR = 100_000;
// Documented rates: $0.15/1k tweets, $0.18/1k profiles, $0.01/1k followings at page size 200, $0.00015 minimum per call.
const TWEET = 15, PROFILE = 18, FOLLOWING = 1, MIN_CALL = 15, MIN_FOLLOWINGS_CALL = 60;

export class TwitterApi {
  credits = 0;
  calls = 0;
  private nextAt = 0;
  constructor(private key: string, private send: typeof fetch = fetch.bind(globalThis), private maxCalls = 150, private minIntervalMs = 0) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    if (!this.key) throw new Error('twitterapi.io is not configured.');
    if (this.calls >= this.maxCalls) throw new Error('twitterapi.io call cap reached for this run.');
    this.calls++;
    const url = new URL('https://api.twitterapi.io' + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    // Trial accounts are limited to about one call per 5 seconds; back off on 429 instead of failing the run.
    let r: Response;
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await new Promise(f => setTimeout(f, wait));
      this.nextAt = Date.now() + this.minIntervalMs;
      try {
        r = await this.send(url, { headers: { 'x-api-key': this.key }, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        // Transient network failures and timeouts are retried a few times before the run gives up.
        if (attempt >= 3) throw error;
        await new Promise(f => setTimeout(f, 2_000 * (attempt + 1)));
        continue;
      }
      if (r.status !== 429 || attempt >= 6) break;
      const retryAfter = Number(r.headers.get('retry-after')) * 1000;
      await new Promise(f => setTimeout(f, retryAfter > 0 ? retryAfter : Math.min(30_000, 2_000 * 2 ** attempt)));
    }
    if (!r.ok) throw new Error(`twitterapi.io request failed (${r.status}).`);
    const data = await r.json() as T & { status?: string };
    if (data.status === 'error') throw new Error('twitterapi.io returned an error.');
    // A caching fetch (bootstrap-feed.ts) marks replays so they do not count toward spend.
    this.free = r.headers.get('x-cache') === 'hit';
    return data;
  }
  private free = false;
  private charge(credits: number) { if (!this.free) this.credits += credits; }

  async user(userName: string): Promise<XUser | null> {
    const d = await this.get<{ data?: XUser }>('/twitter/user/info', { userName });
    this.charge(PROFILE);
    return d.data?.id ? d.data : null;
  }

  async search(query: string, cursor = ''): Promise<{ tweets: XTweet[]; next: string | null }> {
    const d = await this.get<Page<'tweets', XTweet>>('/twitter/tweet/advanced_search', { query, queryType: 'Latest', cursor });
    const tweets = d.tweets ?? [];
    this.charge(Math.max(MIN_CALL, tweets.length * TWEET));
    return { tweets, next: d.has_next_page && d.next_cursor ? d.next_cursor : null };
  }

  async lastTweets(userName: string): Promise<XTweet[]> {
    const d = await this.get<Page<'tweets', XTweet>>('/twitter/user/last_tweets', { userName, includeReplies: 'false' });
    const tweets = d.tweets ?? (d.data as { tweets?: XTweet[] } | undefined)?.tweets ?? [];
    this.charge(Math.max(MIN_CALL, tweets.length * TWEET));
    return tweets;
  }

  async followings(userName: string, cursor = ''): Promise<{ users: XUser[]; next: string | null }> {
    const d = await this.get<Page<'followings', XUser & Legacy>>('/twitter/user/followings', { userName, pageSize: 200, cursor });
    // This endpoint returns legacy snake_case fields; normalize to the shape the other endpoints use.
    const users = (d.followings ?? []).map(u => ({ ...u, userName: u.userName ?? u.screen_name ?? '', followers: u.followers ?? u.followers_count ?? 0,
      following: u.following ?? u.friends_count, statusesCount: u.statusesCount ?? u.statuses_count, createdAt: u.createdAt ?? u.created_at }));
    this.charge(Math.max(MIN_FOLLOWINGS_CALL, users.length * FOLLOWING));
    return { users, next: d.has_next_page && d.next_cursor ? d.next_cursor : null };
  }
}

export function tweetTime(tweet: { createdAt: string }): number {
  const t = Date.parse(tweet.createdAt);
  return Number.isNaN(t) ? 0 : t;
}
