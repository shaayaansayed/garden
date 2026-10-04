import { handleRequest } from './web';
import type { Env } from './env';
export { PersonalAgent } from './personal-agent';
export default { fetch: (request: Request, env: Env) => handleRequest(request, env) } satisfies ExportedHandler<Env>;
