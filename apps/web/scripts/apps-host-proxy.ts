// Lets the MCP Apps reference host, basic-host from the extension's repo,
// talk to the MCP server of a site in development. basic-host connects with
// no sign-in, and the site's MCP server asks for one. So this signs a sample
// person's agent in to the site the way a harness does, then serves /mcp on
// a port of its own and passes each request on to the site's /mcp with that
// agent's access token, and with the CORS headers a browser needs, since
// basic-host calls it from a page. docs/architecture.md has the steps.
//
//   pnpm apps:host                                   @lena on pnpm dev, at http://localhost:3001/mcp
//   pnpm apps:host --login priya --port 3002         another person, on another port
//   pnpm apps:host --site http://localhost:4173      another local site
//
// It takes only a site on this machine, since the token it holds is a
// person's, and anything that can reach the port acts as them.

import http from 'node:http';
import { parseArgs } from 'node:util';
import { agentToken, runAddress } from './skill-run.ts';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The request headers the proxy passes on. The rest name the proxy, or the browser's page, and the site sets its own. */
const DROPPED = new Set(['host', 'origin', 'referer', 'cookie', 'authorization', 'content-length', 'connection']);
/** The answer's headers it drops, since it sends the body as it reads it. */
const DROPPED_BACK = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string', default: 'http://localhost:5173' },
      login: { type: 'string', default: 'lena' },
      port: { type: 'string', default: '3001' },
    },
  });
  const site = new URL(values.site);
  if (!LOCAL.has(site.hostname)) throw new Error(`${site.origin} isn't on this machine. The proxy signs in only to a site in development.`);
  const port = Number(values.port);
  const address = runAddress();

  const token = await agentToken(site.origin, address, values.login, `MCP Apps basic-host (@${values.login})`);

  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string' && !DROPPED.has(name)) headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${token}`);
      headers.set('cf-connecting-ip', address);
      const method = request.method ?? 'GET';
      const upstream = await fetch(new URL(request.url ?? '/', site.origin), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const back: Record<string, string> = { ...CORS };
      upstream.headers.forEach((value, name) => {
        if (!DROPPED_BACK.has(name)) back[name] = value;
      });
      response.writeHead(upstream.status, back);
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502, CORS);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`@${values.login}'s agent is signed in to ${site.origin}. basic-host can reach its MCP server at http://localhost:${String(port)}/mcp`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
