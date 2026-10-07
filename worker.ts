import { handleRequest } from './web';
import type { Env } from './env';
export { PersonalAgent } from './personal-agent';
// Weekly feed expansion is paused: add EXPAND_CRON back to the triggers in wrangler.jsonc to resume it.
export const EXPAND_CRON = '0 12 * * 1';
export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
  // Cron triggers run in UTC: 17:00 and 22:00 are 1pm and 6pm New York in summer, an hour earlier in winter. The agent never loops on its own.
  scheduled: (controller, env, ctx) => {
    const kind = controller.cron === EXPAND_CRON ? 'expand' : 'daily';
    ctx.waitUntil(env.PERSONAL_AGENT.getByName('shay').engageRun(kind).catch(() => console.error('Engage run failed.')));
  },
} satisfies ExportedHandler<Env>;
