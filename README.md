# Shay’s Space

Jekyll blog plus a private personal portal on Cloudflare Workers. React and assistant-ui provide chat and activity views over the existing message API. Instinct uses the browser inbox at `/personal`; messages go to Pi Durable, which follows [agent/AGENTS.md](agent/AGENTS.md) and uses general repository tools. No tracking-specific API.

Current deployment: `https://shays.space/personal`, with `/personal` and `/personal/*` protected by owner-only Cloudflare Access (one-month application session, HttpOnly cookie). The live blog remains on its existing host; only the personal paths route to the Worker. The old agent URL redirects to the portal. GitHub App `5179496`, installation `167644943`, is limited to the Obsidian vault. Codex subscription inference and real repository reads/writes are verified; the connection-test commit is `ed15c10ccc50947cf7ba717d911c70e5dd630b85` and was pulled into the desktop vault without changing existing local edits. Future remote edits require the vault's Git pull/sync.

## Develop

```sh
mise trust
mise install
bun install
bundle install
bun run build:blog
bun run dev
bun run check
bun run test
bun run build:personal
bunx wrangler deploy --dry-run
```

Private routes fail closed until Cloudflare Access is configured. Local UI checks can use an isolated test fixture; there is no production authentication bypass. On recent macOS, the old `posix-spawn` dependency may need `bundle config set --local build.posix-spawn --with-cflags=-Wno-incompatible-function-pointer-types` before `bundle install`.

## Hosting and TLS

- The blog runs on Cloudflare Pages project `garden` (`garden-euu.pages.dev`). Its build command is `jekyll build && bun check-assets.ts`; the asset check must pass before publishing. The Worker owns only the personal routes and the legacy agent hostname.
- Zone baseline: Full (strict), minimum TLS 1.2, TLS 1.3 enabled, Always Use HTTPS enabled. Keep owner-only Access and Worker JWT verification during routing changes. Leave Cloudflare-managed certificate renewal intact.
- The October 4 SSL failure was isolated to `shays.space` in an Instinct browser session: both `/personal` and `/cdn-cgi/trace` failed while the Access hostname loaded. This isolates the destination, not the responsible network component. Local TLS 1.2, TLS 1.3, and hybrid `X25519MLKEM768` probes passed; both IPv4 addresses served the same valid certificate. IPv6 was unreachable locally.
- `shays.space` advertises ECH; the Access hostname does not. A local Chromium-like HTTP/2 client reached the DFW edge with both ECH (`sni=encrypted`) and `X25519MLKEM768`, and also with ECH disabled. This does not reproduce Instinct's browser/proxy path. Obtain its failing NetLog and compare ECH/PQ individually while holding the exit and endpoint fixed; fresh-session success cannot establish the cause.

## Connect and deploy

1. Authenticate Wrangler to the intended Cloudflare account. The account ID is configured in `wrangler.jsonc`; add a Worker custom domain before cutover. If an ambient `CLOUDFLARE_API_TOKEN` overrides your Wrangler login, run local Wrangler commands with `env -u CLOUDFLARE_API_TOKEN`. Build and deploy before changing the live domain's DNS; the existing Pages workflow remains available during migration.
2. Activate Zero Trust Free (the checkout requires terms and an overage authorization), then create a Cloudflare Access self-hosted application covering both `/personal` and `/personal/*` on that domain. Allow only your email, choose a suitable browser-session duration, and record the application audience. Configure `ACCESS_ISSUER` (`https://TEAM.cloudflareaccess.com`) and `ACCESS_AUD` as Worker secrets. The owner email is configured in Wrangler vars. The Worker independently verifies the signature, issuer, audience, expiry, and owner email on every private request. `workers.dev` and preview URLs are disabled.
3. Create a GitHub App with repository **Contents: read and write**, no webhook subscription, and install it only on `shaayaansayed/obsidian-vault`. Configure `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY`. Convert GitHub's downloaded RSA key to PKCS#8 with `openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out app-key.pkcs8.pem`; upload through `bunx wrangler secret put GITHUB_PRIVATE_KEY < app-key.pkcs8.pem`. Confirm the branch in `wrangler.jsonc`.
4. Run `bun run login:codex` locally for a dedicated Pi Codex subscription login. It creates gitignored `codex-auth.json` with private file permissions. Upload with `bunx wrangler secret put CODEX_OAUTH_JSON < codex-auth.json`. Delete the local export after uploading. Never copy the Codex desktop app's auth file or paste tokens into chat. Refreshed tokens live in the agent's durable storage. To replace a revoked login, upload a new export and increment `CODEX_AUTH_VERSION`.
5. Run `bun run deploy`. Sign in to `/personal`, send a read-only message first, then verify an explicitly requested test edit and its GitHub commit. Verify it reaches your desktop vault through its existing Git sync. The current path routes do not require a blog-hosting cutover.

Other secrets use `bunx wrangler secret put NAME` interactively. Never put secrets in Wrangler vars, blog assets, or GitHub commits. Codex OAuth uses subscription allowance, not an API-key fallback; the live inference check establishes account/model compatibility.

Pi's OAuth flows must be statically registered for Worker bundling (`registerBunOAuthFlows`); its default variable import cannot load at runtime. GitHub fetch is bound to the global runtime. Do not deploy while checking an active task; inspect its saved outcome before retrying writes.

### Sunsama

Use **Connect Sunsama** in the portal sidebar and approve Sunsama's OAuth screen. The official `https://api.sunsama.com/mcp` connection and refreshed credentials persist in the existing Durable Object. The callback is `https://shays.space/personal/integrations/sunsama/callback`, behind the same owner-only Access checks. No API key or container is needed. Disconnect removes local credentials and attempts to revoke both tokens.

`sunsama.ts` exposes tool discovery and calls through Pi; schemas are discovered from Sunsama on demand. Calls have a 30-second timeout, propagate cancellation, preserve tool errors, and are never automatically replayed after interruption. Unknown write outcomes require a read before retrying. The pinned Agents MCP lifecycle API is experimental; test OAuth, reconnection, and task recovery when upgrading.

### X engagement engine

Read-only growth helper: twice a day it lists X posts worth replying to, and once a week it grows the pool of accounts it watches. It never posts, likes, or follows, and it never touches Shay's X login.

**Terminology**

- **Feed:** the X accounts we watch, the people Shay wants follows from. Starts from `engage-seeds.txt`. In code and tools this is still the pool (`engage_pool`, `Engage/Pool.md`).
- **Admission:** the weekly judgment of a person. Candidates are accounts that feed members recently followed, counted by how many members follow them. Jev checks that the candidate is an individual, posts regularly in one of the five lanes, and is not mostly promotional. The result is an admission score (fit) kept on the member record. Removed handles are never readmitted automatically.
- **Picks:** the posts in the portal's Engage tab. Each carries a reply score built from lane, claim type, what the post leaves out, contestability, expertise match, reply crowding, the author's audience band, and heat. Time matters only mildly: anything under six hours old is weighted equally.
- **Slop gate:** the drops before ranking. Announcements and personal posts score near zero, non-healthcare lanes drop, generic AI takes are down-weighted, and replies, reposts, and short posts never reach Jev. Admission does most of this work by keeping slop posters out of the feed; the post-level gate is the backstop for members who drift.
- **Lanes:** twelve sub-lanes in one table at the top of `engage.ts`, each with a post weight and an admission weight. Health AI: AI evaluation, AI in care delivery, AI adoption and buying. Care delivery: quality measures, clinical operations, clinical workflows and program rollouts. Payment: value-based care and risk, payer and pharmacy economics, provider economics. Policy: Medicare and Medicaid. Business: health tech go-to-market, fundraising, and company building. Robotics in hospital operations counts for posts at reduced weight but not for admission, since the crowd barely talks about it. Health IT, interoperability, and surgical robots count as other healthcare.

- **Data:** [twitterapi.io](https://twitterapi.io) (API key only; about $0.15 per 1k tweets, $0.01 per 1k followings). Set `wrangler secret put TWITTERAPI_KEY`.
- **Judgment:** [TypeSafe Jev](https://docs.typesafe.ai), a System One decision model that returns calibrated probabilities instead of text (about $0.04 per million input tokens). Set `wrangler secret put TYPESAFE_API_KEY`. Numbers, dates, and thresholds stay in code; Jev only answers semantic questions.
- **Schedule:** crons `0 17 * * *` and `0 22 * * *` pull twice a day (1pm and 6pm New York in summer, an hour earlier in winter). Each pull is stored in the Durable Object and shown in the Engage tab at `/personal#engage`, newest first; the list starts over each day. The weekly expansion cron (`0 12 * * 1`) is paused; run it on demand with `engage_run expand`. Both call `engageRun` on the Durable Object; one run at a time. Nothing is written to the vault except `Engage/Pool.md` on expansion.
- **Daily:** batches the pool into `from:` searches since the last pull and drops replies, reposts, short posts, anything older than 30 hours, and posts already judged. Each remaining post gets its own Jev call with a short description of Shay's background: lane, claim type (evidence, argument, question, news, announcement, personal), what it leaves out, whether the claim is contestable, expertise match, reply angle, and heat (would a reply drag Shay into a partisan or personal fight). Code multiplies lane and claim weights, the hook, and expertise, then freshness (flat up to 6h), reply crowding, audience band, and a heat penalty of half the heat score; heat of 0.85 or more drops the post. Healthcare AI lanes weigh 1.2. A post needs 1.2 to qualify; each pull keeps the top 7, at most two per author. `bun engage-preview.ts` runs a real pull locally without touching production and lists every judged post with its score and drop reason; `--at` replays from cache.
- **Weekly, paused since 2026-10-07:** pulls the latest 200 followings for eight pool members, counts how many members follow each candidate, keeps candidates with at least two overlaps and 1k to 300k followers, fetches their recent posts, and asks Jev whether they are an individual who regularly discusses one of the admission sub-lanes and is not purely promotional. Accepted accounts (up to eight per run) join the pool; `Engage/Pool.md` lists everything. Members with no posts for 45 days are pruned. Removed handles are never re-added automatically.
- **Bootstrap:** `bun bootstrap-feed.ts --dry-run` crawls the seeds' followings (up to 1,000 each) and twelve lane searches, prints the candidate count and the cost of judging, and stops. Without `--dry-run` it shortlists the `--judge 1500` people followed by the most seeds inside the follower band, pulls their last 20 posts, keeps accounts with at least three posts in the last month, and makes one Jev call per account: each of up to 12 recent posts is classified into a lane, and code counts the share of posts in Shay's lanes (robotics counts zero, other healthcare a quarter). The same call asks about individual versus organization, promotion, slop, how much the posts invite discussion, and audience overlap with Shay (about $4.50 for posts, under $0.50 for Jev). Score is lane share (full at 40%) × quality × cadence × engagement × size, where slop and promotion only cost points above even odds and accounts over 100k followers count three quarters as much. `--only a,b,c` judges just those handles and prints them, for spot checks. Output in ignored `.engage-bootstrap/`: `review.md`, `seeds.txt` (top `--feed 300`), and `judged.json`; every HTTP response is cached there by URL or body, so reruns cost nothing. Review, copy `seeds.txt` over `engage-seeds.txt`, deploy, and ask the agent for `engage_pool reset` so the next run reseeds.
- **Budget:** `ENGAGE_MONTHLY_CREDITS` (default 500000 credits, $5) stops runs for the rest of the month; each run also has a call cap. Status and spend: `GET /personal/engage`; manual run: `POST /personal/engage/run?kind=daily|expand` or the `engage_run` tool. Seeds: `engage-seeds.txt`, loaded once when the pool is empty; later edits go through `engage_pool`.

#### Feed bootstrap log

**2026-10-07, first run**

- **Seeds:** 68. The followed Healthcare list (`x.com/i/lists/1349194274848579587`) minus AtlasMD, plus Bilal Farooqui.
- **Crawl:** up to 1,000 followings per seed and 12 lane searches found 32,270 people. 4,451 are followed by two or more seeds and have 1k to 300k followers. Cost $0.47.
- **Shortlist:** the 1,500 followed by the most seeds, about four or more. 680 posted at least three times in the last 30 days.
- **Judge v1, failed:** Jev was asked whether each person "regularly" discusses each sub-lane. Only 72 of 680 scored above zero, because people who post across several sub-lanes cleared none. Posts cost $4.33.
- **Judge v2:** Jev classifies each of up to 12 recent posts by lane, and code counts the share in Shay's lanes, full at 40%. Slop and promotion only penalize above 0.5. Accounts over 100k count 0.75. 333 scored above zero. Jev cost about $0.23, and posts came from cache.
- **Result:** 43 people score 0.3 or more, 88 score 0.2 or more, and 155 score 0.1 or more. Below about #225 it is mostly general tech. Output is in `.engage-bootstrap/`.
- **Next:** cut at 0.1 for about 155 people, review, replace `engage-seeds.txt`, deploy, then `engage_pool reset`. Optional: judge the next 2,950 people, followed by two or three seeds, for about $9.

## Instinct instruction

Give Instinct [INSTINCT.md](INSTINCT.md) after updates; changes are not delivered automatically.

## Local X

Use the official [xurl CLI](https://github.com/xdevplatform/xurl), installed locally with `bun add --global @xdevplatform/xurl@1.3.4`. It is independent of the Worker.

Setup requires an X developer app and local OAuth. Register `http://localhost:8080/callback`; keep credentials in `~/.xurl`, outside this repo. Check identity before publishing; never print tokens or use `--verbose`.

```sh
xurl auth status
xurl whoami
xurl search '("healthcare" OR "health tech") (AI OR robotics) lang:en -is:retweet' -n 10
```

Intended account: `ShaayaanS`. Read-only smoke test: identity, one search, then one post's metrics. Publishing requires a specific requested post/reply. Self-serve API replies require the original author to have mentioned the account or quoted its post; see [X restrictions](https://docs.x.com/x-api/posts/manage-tweets/introduction).

## Cost and operation

- Public blog assets bypass Worker execution. SQLite Durable Objects support the Workers Free plan. Start without a container and measure usage; do not upgrade the plan automatically.
- The agent wakes on messages; there is no recurring scheduler or idle model loop. Default limits: 50 new messages and 200 model calls per UTC day, one model retry, 120-second model-request timeout, low reasoning, and requested output capped at 4096 tokens. Provider limits still apply; these are usage guards, not a dollar cap.
- Pi queues duplicate-safe request IDs and resumes after eviction. GitHub writes use current file SHAs and reject conflicting edits. Already-applied identical writes return without another commit. Each file is committed separately; multi-file tasks can partially succeed. After interruption, inspect the existing task before submitting a new instruction to repeat an edit.
- The Stop task button aborts queued/running work; it does not undo commits. History is private and uncached. Provider/user content is not logged; transcripts and OAuth credentials persist server-side.
- Optional sandbox support is implemented in the agent but disabled in the default deployment. To enable later, review the Workers Paid plan and add `containers: [{class_name: "PersonalAgent", scheduling_policy: "durable_object"}]`. The shell tool starts Debian only on use, has no Internet or credentials, times commands out after 60 seconds, and sets a 60-second inactivity timeout. Files are temporary; use repository tools to persist work. Container execution has not been tested in this first pass.
- Pi Durable is experimental. Package versions are pinned; upgrade with recovery tests. Repository text is treated as data except explicit note protocols. The current tools operate only in the configured vault repository.

References: [Static assets](https://developers.cloudflare.com/workers/static-assets/), [Pi Durable](https://developers.cloudflare.com/agents/harnesses/pi/), [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/), [Codex authentication](https://learn.chatgpt.com/docs/auth).
