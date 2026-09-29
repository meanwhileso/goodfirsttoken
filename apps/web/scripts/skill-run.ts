// Follows the steps of the maintain and admin skills against a running site
// in development, with the MCP client SDK as each person's agent, the way a
// harness connects. No model runs, so it spends no tokens.
//
// 1. sample-maintainer's agent asks project_status about the GitHub fake's
//    sample-owner/sample-parser, then calls register_project for a proposal
//    and again with the proposed settings, confirmed as they are.
// 2. sample-admin's agent finds the registration with admin_queue and
//    approves it with admin_decide.
// 3. The maintainer's agent checks with project_status that it is approved.
//
// Each person approves their agent the way they would in a browser, on the
// site's page and then on the GitHub fake's sign-in page, here over plain
// HTTP. A repo can be registered once, so when an earlier run on the same
// database left the project in place, the admin's agent first removes it
// with admin_remove_project, and the run registers it again.
//
//   pnpm skills:run                                against pnpm dev
//   pnpm skills:run --site http://localhost:4173   against another local site
//
// The end-to-end tests run it against their preview, in e2e/skills.spec.ts.

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

/** The repo the run registers: one of the GitHub fake's sample repos that no sample work touches. */
export const FIXTURE_REPO = 'sample-owner/sample-parser';
/** An admin of the fixture on the GitHub fake. */
export const MAINTAINER = 'sample-maintainer';
/** The GitHub fake's sample admin, one of Good First Token's admins in development. */
export const ADMIN = 'sample-admin';

/** Where each agent says it listens for its code. Nothing listens, since the run reads the redirect. */
const REDIRECT_URI = 'http://127.0.0.1:33419/callback';

/** An OAuth client that keeps its registration, tokens, and PKCE verifier in memory, as a harness would. */
class MemoryOAuthClient implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  discovered: OAuthDiscoveryState | undefined;
  /** Where the SDK sent the person to approve the agent. */
  authorizationUrl: URL | undefined;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.client = client;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovered = state;
  }

  discoveryState() {
    return this.discovered;
  }
}

/**
 * An address in the IPv6 documentation range, 2001:db8::/32, in a /64 of
 * its own. The site counts its sign-in limit by client address, so the run's
 * sign-ins never use up anyone else's.
 */
export function runAddress(): string {
  const [a = '0', b = '0'] = [randomBytes(2), randomBytes(2)].map((bytes) => bytes.toString('hex'));
  return `2001:db8:${a}:${b}::1`;
}

/** Calls the site from the run's own address, the way an agent on the internet reaches it. */
function fromAddress(address: string) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('cf-connecting-ip', address);
    return fetch(new Request(request, { headers }));
  };
}

/** Where a redirect points. */
function location(response: Response, from: string): URL {
  const to = response.headers.get('location');
  if (!to) throw new Error(`Expected a redirect from ${from}, and got ${String(response.status)}.`);
  return new URL(to, from);
}

/**
 * The person's side of an agent's sign-in: opens the page the agent sent
 * them to, approves the agent, picks `login` on the GitHub fake's sign-in
 * page, and follows the site back to the agent. Returns where the site sent
 * them, with the code for the agent. Cookies tie the steps together, as in a
 * browser.
 */
async function approveAgent(site: string, address: string, authorizationUrl: URL, login: string): Promise<URL> {
  const cookies = new Map<string, string>();
  const onSite = fromAddress(address);
  const browse = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await onSite(url, { ...init, headers, redirect: 'manual' });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };

  const page = await browse(authorizationUrl);
  const handle = /<input type="hidden" name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
  if (page.status !== 200 || handle === undefined) {
    throw new Error(`The page to approve an agent answered ${String(page.status)} with no form to approve it.`);
  }
  const approved = await browse(new URL('/oauth/authorize', site), {
    method: 'POST',
    headers: { origin: new URL(site).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  });
  const gitHub = location(approved, `${site}/oauth/authorize`);

  // The GitHub fake's sign-in page is a form with a button for each sample
  // person, which posts the query it was opened with and their login.
  const fields = new URLSearchParams(gitHub.searchParams);
  fields.set('login', login);
  const picked = await fetch(new URL(gitHub.pathname, gitHub.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
    redirect: 'manual',
  });
  const callback = location(picked, gitHub.toString());
  return location(await browse(callback), callback.toString());
}

/** Connects a new agent for `login`: the SDK meets the 401, registers, and sends the person to approve it. */
export async function connectAgent(site: string, address: string, login: string): Promise<Client> {
  const mcpUrl = new URL('/mcp', site);
  const oauth = new MemoryOAuthClient(`Good First Token skill run (${login})`);
  const transport = () =>
    new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauth, fetch: fromAddress(address) });
  const first = transport();
  try {
    await new Client({ name: 'goodfirsttoken-skill-run', version: '0.0.0' }).connect(first);
    throw new Error(`${mcpUrl.toString()} took an agent with no sign-in.`);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  if (!oauth.authorizationUrl) throw new Error('The MCP client SDK never sent the person to approve the agent.');
  const back = await approveAgent(site, address, oauth.authorizationUrl, login);
  if (!back.searchParams.has('code')) throw new Error(`The site sent @${login} back to the agent with no code: ${back.toString()}`);
  await first.finishAuth(back.searchParams);
  const client = new Client({ name: 'goodfirsttoken-skill-run', version: '0.0.0' });
  await client.connect(transport());
  return client;
}

/** A tool's answer as text, the way a terminal harness shows it. */
function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/** A refusal's code, from text like `Refused (not_found): ...`, or null. */
function refusalOf(result: CallToolResult): string | null {
  return result.isError === true ? (/^Refused \(([a-z_]+)\)/.exec(textOf(result))?.[1] ?? null) : null;
}

interface Settings {
  tags: string[];
  [setting: string]: unknown;
}

interface ProjectAnswer {
  repo: string;
  status: string;
  source?: string;
  saved?: boolean;
  settings: Settings;
  reasons?: { setting: string; reason: string }[];
}

interface QueueItem {
  id: string;
  kind: string;
  repo: string;
  requestedBy: string | null;
  settings: Settings;
  onDoNotList: boolean;
}

export interface SkillRun {
  repo: string;
  /** The settings register_project proposed, which the maintainer confirmed as they are. */
  proposed: Settings;
  /** The registration's ID in the admin queue. */
  queueId: string;
  /** The project's status at the end, from project_status. */
  status: string;
  /** Whether the run first removed the project an earlier run left. */
  reset: boolean;
}

/**
 * Runs the maintain and admin skills' steps against `site`, a site in
 * development, and says each call and its answer through `say`. Throws when
 * an answer isn't what the skills expect.
 */
export async function runSkills(site: string, say: (line: string) => void = console.log): Promise<SkillRun> {
  const address = runAddress();
  const repo = FIXTURE_REPO;

  const call = async (agent: Client, who: string, name: string, args: Record<string, unknown>) => {
    say(`@${who}'s agent calls ${name} ${JSON.stringify(args)}`);
    const result = await agent.callTool({ name, arguments: args });
    say(textOf(result).replace(/^/gm, '    '));
    return result;
  };
  // The structured answer of a call that didn't fail.
  const answer = (result: CallToolResult, step: string): unknown => {
    if (result.isError === true || result.structuredContent === undefined) {
      throw new Error(`${step} failed: ${textOf(result)}`);
    }
    return result.structuredContent;
  };

  const maintainer = await connectAgent(site, address, MAINTAINER);
  say(`@${MAINTAINER} approved their agent on the site and signed in on the GitHub fake.`);
  const admin = await connectAgent(site, address, ADMIN);
  say(`@${ADMIN} approved their agent on the site and signed in on the GitHub fake.`);
  try {
    // The maintain skill starts with project_status.
    const before = await call(maintainer, MAINTAINER, 'project_status', { repo });
    let reset = false;
    if (refusalOf(before) === 'not_maintainer') {
      throw new Error(`The GitHub fake doesn't show ${repo} to @${MAINTAINER} as theirs. Run pnpm seed, then run this again.`);
    }
    if (refusalOf(before) !== 'not_found') {
      const project = answer(before, 'project_status') as ProjectAnswer;
      if (project.status !== 'rejected') {
        say(`${repo} is left from an earlier run, so @${ADMIN}'s agent removes it first.`);
        answer(
          await call(admin, ADMIN, 'admin_remove_project', {
            repo,
            note: 'pnpm skills:run removed the project an earlier run left, to register it again.',
          }),
          'admin_remove_project',
        );
        reset = true;
      }
    }

    const proposal = answer(
      await call(maintainer, MAINTAINER, 'register_project', { repo }),
      'register_project with the repo alone',
    ) as ProjectAnswer;
    if (proposal.saved !== false) throw new Error('register_project saved the project before the maintainer confirmed the settings.');
    say(`@${MAINTAINER} confirms the proposed settings as they are.`);
    const registered = answer(
      await call(maintainer, MAINTAINER, 'register_project', { repo, settings: proposal.settings }),
      'register_project with the confirmed settings',
    ) as ProjectAnswer;
    if (registered.saved !== true || registered.status !== 'pending') {
      throw new Error(`The registration is ${registered.status}. It should wait for an admin as pending.`);
    }

    const queue = answer(
      await call(admin, ADMIN, 'admin_queue', { kind: 'registration' }),
      'admin_queue',
    ) as { items: QueueItem[] };
    const item = queue.items.find((i) => i.repo === registered.repo && i.requestedBy === MAINTAINER);
    if (!item) throw new Error(`${registered.repo} isn't in the admin queue as @${MAINTAINER}'s registration.`);
    if (!isDeepStrictEqual(item.settings, registered.settings)) {
      throw new Error("The admin queue's settings differ from the ones the maintainer confirmed.");
    }
    say(`@${ADMIN} reads the item and approves it.`);
    const decided = answer(
      await call(admin, ADMIN, 'admin_decide', { id: item.id, decision: 'approve' }),
      'admin_decide',
    ) as { status: string };
    if (decided.status !== 'approved') throw new Error(`admin_decide left ${registered.repo} ${decided.status}.`);

    const after = answer(
      await call(maintainer, MAINTAINER, 'project_status', { repo }),
      'project_status after the approval',
    ) as ProjectAnswer;
    if (after.status !== 'approved' || after.source !== 'registered') {
      throw new Error(`project_status says ${after.repo} is ${after.status}, from ${String(after.source)}.`);
    }
    return { repo: after.repo, proposed: proposal.settings, queueId: item.id, status: after.status, reset };
  } finally {
    await Promise.allSettled([maintainer.close(), admin.close()]);
  }
}

/** Checks that `site` answers and runs as development, where the sample admin is an admin. */
async function checkSite(site: string): Promise<void> {
  let health: { environment?: string };
  try {
    health = (await (await fetch(new URL('/healthz', site))).json()) as { environment?: string };
  } catch {
    throw new Error(`Nothing answered at ${site}. Start the site with pnpm dev, then run this again.`);
  }
  if (health.environment !== 'development') {
    throw new Error(`${site} runs as ${String(health.environment)}. The run needs a site in development, with the GitHub fake.`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { site: { type: 'string', default: 'http://localhost:5173' } } });
  const site = new URL(values.site).origin;
  await checkSite(site);
  const run = await runSkills(site);
  console.log(
    `\nDone. @${MAINTAINER} registered ${run.repo} on ${site}, @${ADMIN} approved it as ${run.queueId}, and project_status says ${run.status}.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
