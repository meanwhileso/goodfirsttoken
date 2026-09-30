import claudeCodeSteps from '../../../../skill-src/shared/connect-claude-code.md?raw';
import harnessSteps from '../../../../skill-src/shared/connect.md?raw';
import { siteOrigin } from '../auth/settings';
import template from './start.md?raw';

// /start.md: how any agent adds the MCP server and the skills in its own
// harness. The steps for each harness are the skills' own shared parts in
// skill-src/shared/, put in at build time, so the page and the skills can't
// drift apart. {{MCP_URL}} becomes this site's /mcp, so a staging or
// self-hosted site names its own server.

export const START_PATH = '/start.md';

const PARTS: Record<string, string> = {
  'connect-claude-code': claudeCodeSteps,
  connect: harnessSteps,
};

/** The page's text for the MCP server at `mcpUrl`. */
export function startText(mcpUrl: string): string {
  const lines = template.split('\n').map((line) => {
    const name = /^\{\{include ([a-z-]+)\}\}$/.exec(line)?.[1];
    if (name === undefined) return line;
    const part = PARTS[name];
    if (part === undefined) throw new Error(`start.md includes ${name}, which isn't a part it knows.`);
    return part.replace(/\n$/, '');
  });
  return lines.join('\n').replaceAll('{{MCP_URL}}', mcpUrl);
}

export function isStartPath(request: Request): boolean {
  return new URL(request.url).pathname === START_PATH;
}

// Public, the same for everyone, and set no cookie.
const HEADERS = {
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

export function handleStart(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const body = startText(`${siteOrigin(request)}/mcp`);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { ...HEADERS, 'content-type': 'text/markdown; charset=utf-8' },
  });
}
