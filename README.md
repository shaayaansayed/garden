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

## Connect and deploy

1. Authenticate Wrangler to the intended Cloudflare account. The account ID is configured in `wrangler.jsonc`; add a Worker custom domain before cutover. If an ambient `CLOUDFLARE_API_TOKEN` overrides your Wrangler login, run local Wrangler commands with `env -u CLOUDFLARE_API_TOKEN`. Build and deploy before changing the live domain's DNS; the existing Pages workflow remains available during migration.
2. Activate Zero Trust Free (the checkout requires terms and an overage authorization), then create a Cloudflare Access self-hosted application covering both `/personal` and `/personal/*` on that domain. Allow only your email, choose a suitable browser-session duration, and record the application audience. Configure `ACCESS_ISSUER` (`https://TEAM.cloudflareaccess.com`) and `ACCESS_AUD` as Worker secrets. The owner email is configured in Wrangler vars. The Worker independently verifies the signature, issuer, audience, expiry, and owner email on every private request. `workers.dev` and preview URLs are disabled.
3. Create a GitHub App with repository **Contents: read and write**, no webhook subscription, and install it only on `shaayaansayed/obsidian-vault`. Configure `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY`. Convert GitHub's downloaded RSA key to PKCS#8 with `openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out app-key.pkcs8.pem`; upload through `bunx wrangler secret put GITHUB_PRIVATE_KEY < app-key.pkcs8.pem`. Confirm the branch in `wrangler.jsonc`.
4. Run `bun run login:codex` locally for a dedicated Pi Codex subscription login. It creates gitignored `codex-auth.json` with private file permissions. Upload with `bunx wrangler secret put CODEX_OAUTH_JSON < codex-auth.json`. Delete the local export after uploading. Never copy the Codex desktop app's auth file or paste tokens into chat. Refreshed tokens live in the agent's durable storage. To replace a revoked login, upload a new export and increment `CODEX_AUTH_VERSION`.
5. Run `bun run deploy`. Sign in to `/personal`, send a read-only message first, then verify an explicitly requested test edit and its GitHub commit. Verify it reaches your desktop vault through its existing Git sync. The current path routes do not require a blog-hosting cutover.

Other secrets use `bunx wrangler secret put NAME` interactively. Never put secrets in Wrangler vars, blog assets, or GitHub commits. Codex OAuth uses subscription allowance, not an API-key fallback; the live inference check establishes account/model compatibility.

Pi's OAuth flows must be statically registered for Worker bundling (`registerBunOAuthFlows`); its default variable import cannot load at runtime. GitHub fetch is bound to the global runtime. Do not deploy while checking an active task; inspect its saved outcome before retrying writes.

## Instinct instruction

> Open https://shays.space/personal in your signed-in browser. Submit my message verbatim in the Message field. Wait for the task to complete and relay the agent’s response. If login is required, ask me to sign in. If a submission times out, retry from the same page so it reuses the request ID. Don’t edit GitHub directly or infer that a received message means the notes were updated.

## Cost and operation

- Public blog assets bypass Worker execution. SQLite Durable Objects support the Workers Free plan. Start without a container and measure usage; do not upgrade the plan automatically.
- The agent wakes on messages; there is no recurring scheduler or idle model loop. Default limits: 50 new messages and 200 model calls per UTC day, one model retry, 120-second model-request timeout, low reasoning, and requested output capped at 4096 tokens. Provider limits still apply; these are usage guards, not a dollar cap.
- Pi queues duplicate-safe request IDs and resumes after eviction. GitHub writes use current file SHAs and reject conflicting edits. Already-applied identical writes return without another commit. Each file is committed separately; multi-file tasks can partially succeed. After interruption, inspect the existing task before submitting a new instruction to repeat an edit.
- The Stop task button aborts queued/running work; it does not undo commits. History is private and uncached. Provider/user content is not logged; transcripts and OAuth credentials persist server-side.
- Optional sandbox support is implemented in the agent but disabled in the default deployment. To enable later, review the Workers Paid plan and add `containers: [{class_name: "PersonalAgent", scheduling_policy: "durable_object"}]`. The shell tool starts Debian only on use, has no Internet or credentials, times commands out after 60 seconds, and sets a 60-second inactivity timeout. Files are temporary; use repository tools to persist work. Container execution has not been tested in this first pass.
- Pi Durable is experimental. Package versions are pinned; upgrade with recovery tests. Repository text is treated as data except explicit note protocols. The current tools operate only in the configured vault repository.

References: [Static assets](https://developers.cloudflare.com/workers/static-assets/), [Pi Durable](https://developers.cloudflare.com/agents/harnesses/pi/), [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/), [Codex authentication](https://learn.chatgpt.com/docs/auth).
