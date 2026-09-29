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
//   pnpm apps:host --timeout 60                      a sign-in that may take 60 seconds (30 by default)
//
// It takes only a site on this machine, since the token it holds is a
// person's, and anything that can reach the port acts as them. For the same
// reason it passes on only /mcp, to that site, and answers only pages on
// this machine.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { agentToken, runAddress } from './skill-run.ts';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where a request to the proxy goes: the site's /mcp, whatever the request
 * asks for, or null when it asks for anything else. The address is built
 * from the site alone, so no request can send the token to another host or
 * path.
 */
export function upstreamUrl(requestUrl: string | undefined, site: URL): URL | null {
  if (requestUrl === undefined) return null;
  const path = requestUrl.split('?', 1)[0];
  return path === '/mcp' ? new URL('/mcp', site.origin) : null;
}

/** Whether a page's origin is on this machine, the only pages the proxy answers. */
export function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL.has(url.hostname);
  } catch {
    return false;
  }
}

/** The request headers the proxy passes on. The rest name the proxy, or the browser's page, and the site sets its own. */
const DROPPED = new Set(['host', 'origin', 'referer', 'cookie', 'authorization', 'content-length', 'connection']);
/** The answer's headers it drops, since it sends the body as it reads it. */
const DROPPED_BACK = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/** The CORS headers for a page on this machine at `origin`. */
const cors = (origin: string) => ({
  'access-control-allow-origin': origin,
  vary: 'origin',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
});

export interface ProxyOptions {
  /** The site in development whose /mcp the proxy passes requests on to. */
  site: URL;
  /** The agent's access token, or the promise of it while the agent signs in. A request waits for it. */
  token: string | Promise<string>;
  /** The client address each request to the site carries, the one the agent signed in from. */
  address: string;
}

/**
 * The proxy's server, before it listens. It passes a request for /mcp from
 * a page on this machine, or from no page, on to the site's /mcp with the
 * agent's token, answers a preflight itself, and refuses the rest.
 */
export function proxyServer({ site, token, address }: ProxyOptions): http.Server {
  return http.createServer((request, response) => {
    const origin = request.headers.origin;
    // A request from a browser page names its origin. basic-host's page is on
    // this machine, and any other page is refused.
    if (origin !== undefined && !localOrigin(origin)) {
      response.writeHead(403).end();
      return;
    }
    const CORS = origin === undefined ? {} : cors(origin);
    const upstreamAt = upstreamUrl(request.url, site);
    if (upstreamAt === null) {
      response.writeHead(404, CORS).end();
      return;
    }
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
      headers.set('authorization', `Bearer ${await token}`);
      headers.set('cf-connecting-ip', address);
      const method = request.method ?? 'GET';
      const upstream = await fetch(upstreamAt, {
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
}

/** Listens on `port` on this machine, or throws when the port is taken. */
function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string', default: 'http://localhost:5173' },
      login: { type: 'string', default: 'lena' },
      port: { type: 'string', default: '3001' },
      timeout: { type: 'string', default: '30' },
    },
  });
  const site = new URL(values.site);
  if (!LOCAL.has(site.hostname)) throw new Error(`${site.origin} isn't on this machine. The proxy signs in only to a site in development.`);
  const port = Number(values.port);
  const seconds = Number(values.timeout);
  if (!(seconds > 0)) throw new Error(`--timeout takes a number of seconds above 0, and got ${values.timeout}.`);
  const address = runAddress();

  // It listens before the agent signs in, so a port that is taken stops it
  // before a new agent shows among the person's connected agents.
  let signedIn: (token: string) => void = () => undefined;
  const token = new Promise<string>((resolve) => {
    signedIn = resolve;
  });
  const server = proxyServer({ site, token, address });
  try {
    await listen(server, port);
  } catch (error) {
    throw new Error(`The proxy can't listen on port ${String(port)}: ${error instanceof Error ? error.message : String(error)}. Name another with --port.`, {
      cause: error,
    });
  }
  // A site that takes the sign-in's requests and never answers would leave
  // the proxy waiting with nothing said, so the sign-in has a time limit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${site.origin} didn't sign @${values.login}'s agent in within ${String(seconds)} s. Check that the site runs there, with pnpm dev, then run this again.`));
    }, seconds * 1000);
  });
  try {
    signedIn(await Promise.race([agentToken(site.origin, address, values.login, `MCP Apps basic-host (@${values.login})`), late]));
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const listening = (server.address() as AddressInfo).port;
  console.log(`@${values.login}'s agent is signed in to ${site.origin}. basic-host can reach its MCP server at http://localhost:${String(listening)}/mcp`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    // It exits at once, since a sign-in past its time limit may still be
    // waiting on the site.
    process.exit(1);
  });
}
