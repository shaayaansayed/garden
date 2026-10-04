import { importPKCS8, SignJWT } from 'jose';
import type { Env } from './env';

export class GitHub {
  private token?: { value: string; expires: number };
  constructor(private env: Env, private send: typeof fetch = fetch.bind(globalThis)) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const { GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY } = this.env;
    if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !GITHUB_PRIVATE_KEY) throw new Error('GitHub App is not configured.');
    const key = await importPKCS8(GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(GITHUB_APP_ID).setIssuedAt(Math.floor(Date.now() / 1000) - 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 540).sign(key);
    const [owner, name] = this.env.GITHUB_REPOSITORY.split('/');
    if (!owner || !name) throw new Error('Invalid configured repository.');
    const r = await this.send(`https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: 'POST', headers: this.headers(jwt),
      body: JSON.stringify({ repositories: [name], permissions: { contents: 'write' } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`GitHub authentication failed (${r.status}).`);
    const data = await r.json() as { token: string; expires_at: string };
    this.token = { value: data.token, expires: Date.parse(data.expires_at) };
    return data.token;
  }

  private headers(token: string) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shays-space-agent', 'Content-Type': 'application/json' };
  }

  private async request(path: string, init?: RequestInit) {
    const r = await this.send(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}${path}`, {
      ...init, headers: this.headers(await this.accessToken()), signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 404 && !init?.method) return null;
    if (!r.ok) throw new Error(r.status === 409 || r.status === 422
      ? 'GitHub write conflict. Read the file again and reconcile before retrying.'
      : `GitHub request failed (${r.status}).`);
    return r.json();
  }

  async read(path: string): Promise<{ path: string; sha: string; content: string } | null> {
    const safe = repositoryPath(path);
    const data = await this.request(`/contents/${encodePath(safe)}?ref=${encodeURIComponent(this.env.GITHUB_BRANCH)}`) as
      { type: string; encoding: string; sha: string; content: string } | null;
    if (!data) return null;
    if (data.type !== 'file' || data.encoding !== 'base64') throw new Error('Expected a text file. Use list_files to browse.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(data.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
    if (content.length > 100_000) throw new Error('File exceeds the 100 KB agent read limit.');
    return { path: safe, sha: data.sha, content };
  }

  async list(path = '') {
    const safe = path ? repositoryPath(path) : '';
    const data = await this.request(`/contents/${encodePath(safe)}?ref=${encodeURIComponent(this.env.GITHUB_BRANCH)}`) as
      { path: string; type: string; size: number }[] | null;
    if (!data) return [];
    if (!Array.isArray(data)) throw new Error('Expected a directory.');
    return data.slice(0, 500).map(({ path, type, size }) => ({ path, type, size }));
  }

  async write(path: string, content: string, expectedSha: string | null, message: string) {
    const safe = repositoryPath(path);
    if (content.length > 100_000 || !message.trim() || message.length > 200) throw new Error('Invalid content or commit message.');
    const current = await this.read(safe);
    // Recovery after a successful commit: an identical whole-file write is harmless.
    if (current?.content === content) return { path: safe, unchanged: true, sha: current.sha };
    if ((current?.sha ?? null) !== expectedSha) throw new Error('GitHub write conflict. Read the file again and reconcile before retrying.');
    const bytes = new TextEncoder().encode(content);
    const encoded = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
    const result = await this.request(`/contents/${encodePath(safe)}`, {
      method: 'PUT', body: JSON.stringify({ message, content: encoded, branch: this.env.GITHUB_BRANCH,
        ...(expectedSha ? { sha: expectedSha } : {}) }),
    }) as { commit: { sha: string; html_url: string } };
    return { path: safe, commit: result.commit.sha, url: result.commit.html_url };
  }
}

export function repositoryPath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path)
      || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error('Invalid repository path.');
  }
  return path;
}
function encodePath(path: string) { return path.split('/').map(encodeURIComponent).join('/'); }
