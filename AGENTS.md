# Shay’s Space

- Public site: Jekyll blog at `shays.space` on its existing host. Private portal: `shays.space/personal`; Cloudflare routes only `/personal` and `/personal/*` to this Worker. Old agent URL redirects here.
- `worker.ts` / `web.ts`: Cloudflare Worker serves blog assets and authenticates every `/personal` route with owner-only Cloudflare Access JWTs.
- `personal-agent.ts`: SQLite-backed Durable Object with Cloudflare `PiHarness` + Pi Durable; persistent tasks, duplicate-safe request IDs, cancellation, and usage limits. Sandbox is disabled.
- Instinct delegates through the browser. `personal.tsx` / `personal.css`: React + assistant-ui chat and activity; `inbox.ts`: private HTML. Receipt is not completion; preserve retry IDs and report actual outcomes.
- Model uses Codex subscription OAuth. GitHub App tools read/write only `shaayaansayed/obsidian-vault`; desktop Obsidian receives edits through Git sync. Agent behavior: `agent/AGENTS.md`.
- Secrets stay in Cloudflare/local ignored files. Exclude backend files and this file from Jekyll assets. Keep Access protection during domain changes.
- Use Bun and mise; keep files flat. `build-personal.ts` bundles private assets into ignored `.personal/`. Check: `bun run check`, `bun run test`, `mise exec -- bun run build:blog`. Browser checks: `playwright-cli`. Deploy: `mise exec -- bun run deploy`.
