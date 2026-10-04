import type { PersonalAgent } from './personal-agent';

export interface Env {
  ASSETS: Fetcher;
  PERSONAL_AGENT: DurableObjectNamespace<PersonalAgent>;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  CODEX_OAUTH_JSON?: string;
  CODEX_AUTH_VERSION?: string;
  GITHUB_APP_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_REPOSITORY: string;
  GITHUB_BRANCH: string;
  AGENT_MODEL: string;
  AGENT_TIMEZONE: string;
  MAX_REQUESTS_PER_DAY: string;
  MAX_MODEL_CALLS_PER_DAY: string;
}
