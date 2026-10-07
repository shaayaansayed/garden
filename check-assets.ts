import { readdir } from 'node:fs/promises';

// Fail the build if a Jekyll configuration change exposes backend sources or credentials.
const files = await readdir('_site', { recursive: true });
const forbidden = files.filter(path => /(^|\/)(agent|node_modules|\.dev\.vars[^/]*|\.env[^/]*|auth\.json|codex-auth\.json)(\/|$)/.test(path)
  || /\.(tsx?|pem|key)$/.test(path) || /(^|\/)(AGENTS\.md|INSTINCT\.md|personal\.css|engage-seeds\.txt|wrangler\.jsonc|bun\.lock|package\.json|tsconfig\.json|mise\.toml)$/.test(path));
if (forbidden.length) throw new Error('Private files found in blog output: ' + forbidden.join(', '));
console.log('Blog assets contain no agent sources or credential files.');
