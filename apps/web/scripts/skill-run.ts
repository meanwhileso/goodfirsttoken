// Follows the steps of the maintain, admin, and give skills against a
// running site in development, with the MCP client SDK as each person's
// agent, the way a harness connects. No model runs, so it spends no tokens.
//
// 1. sample-maintainer's agent asks project_status about the GitHub fake's
//    sample-owner/sample-parser, then calls register_project for a proposal
//    and again with the proposed settings, confirmed as they are.
// 2. sample-admin's agent finds the registration with admin_queue and
//    approves it with admin_decide.
// 3. The maintainer's agent checks with project_status that it is approved.
// 4. The sample donor ines's agent follows the give skill: start_session,
//    set_interests on the first run, suggest_issues until the sample work's
//    sample-owner/sample-app#311 comes up, claim_issue, post_update three
//    times with the second folded into the third after the wait the server
//    asks for, submit_work, and my_work, with open_pr when the work waits
//    in the review queue. The issue takes that claim until a PR opens on it,
//    so on one local database the donor's steps run once, after pnpm seed.
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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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

/**
 * Opens a page the way a browser opens it in a tab of its own: a GET with the
 * Sec-Fetch headers a browser sends for that, which the page to approve an
 * agent needs. Node's fetch always sends Sec-Fetch-Mode: cors, so this uses
 * node:http. It follows no redirect.
 */
function openInTab(url: URL, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const sent = send(
      url,
      { method: 'GET', headers: { ...headers, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on('data', (chunk: Buffer) => chunks.push(chunk));
        answer.on('error', reject);
        answer.on('end', () => {
          const received = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(name, one);
          }
          resolve(new Response(Buffer.concat(chunks), { status: answer.statusCode ?? 500, headers: received }));
        });
      },
    );
    sent.on('error', reject);
    sent.end();
  });
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
  const keep = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };
  const cookieHeader = (): Record<string, string> =>
    cookies.size > 0 ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {};
  const browse = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(cookieHeader())) headers.set(name, value);
    return keep(await onSite(url, { ...init, headers, redirect: 'manual' }));
  };

  const page = keep(await openInTab(authorizationUrl, { ...cookieHeader(), 'cf-connecting-ip': address }));
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

/** Signs a new agent in for `login`: the SDK meets the 401, registers, and sends the person to approve it. */
async function signIn(site: string, address: string, login: string, name: string): Promise<MemoryOAuthClient> {
  const mcpUrl = new URL('/mcp', site);
  const oauth = new MemoryOAuthClient(name);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: oauth, fetch: fromAddress(address) });
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
  return oauth;
}

/** Connects a new agent for `login`, signed in as a harness signs in. */
export async function connectAgent(site: string, address: string, login: string): Promise<Client> {
  const oauth = await signIn(site, address, login, `Good First Token skill run (${login})`);
  const client = new Client({ name: 'goodfirsttoken-skill-run', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', site), { authProvider: oauth, fetch: fromAddress(address) }));
  return client;
}

/** Signs a new agent in for `login`, named `name` on the page that approves it, and returns its access token. */
export async function agentToken(site: string, address: string, login: string, name: string): Promise<string> {
  const token = (await signIn(site, address, login, name)).saved?.access_token;
  if (token === undefined) throw new Error(`The site gave @${login}'s agent no access token.`);
  return token;
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

/**
 * The issue the donor run works: the one sample issue no other end-to-end
 * test claims. Its project opens agent PRs by itself, and the sample work
 * leaves one of its three slots open.
 */
export const DONOR_ISSUE = 'sample-owner/sample-app#311';
/** A sample donor with no claim on the issue in the sample work. */
export const DONOR = 'ines';

interface Suggestion {
  issue: string;
  claUrl: string | null;
}

interface Claimed {
  claim: { claimId: string; issue: string };
  resumed: boolean;
  clone: { url: string; commit: string };
}

interface Posted {
  posted: boolean;
  waitSeconds: number | null;
}

interface Submitted {
  pr: { number: number; url: string } | null;
  reviewReason: string | null;
}

export interface DonorRun {
  issue: string;
  claimId: string;
  /** Whether the run took up a claim an earlier run left unfinished. */
  resumed: boolean;
  /** How long the server asked the run to wait before its folded update. */
  waitedSeconds: number;
  /** The PR the work is on, opened by itself or from the review queue. */
  pr: { number: number; url: string };
  /** Why the work waited in the review queue, or null when the PR opened by itself. */
  reviewReason: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the give skill's steps against `site`, a site in development with
 * the sample work, as the sample donor's agent: a session, interests on the
 * first run, suggestions, a claim, updates, a submit, and the review queue.
 * Says each call and its answer through `say`, and throws when an answer
 * isn't what the skill expects.
 */
export async function runDonorSkills(site: string, say: (line: string) => void = console.log): Promise<DonorRun> {
  const project = DONOR_ISSUE.slice(0, DONOR_ISSUE.indexOf('#'));
  const donor = await connectAgent(site, runAddress(), DONOR);
  say(`@${DONOR} approved their agent on the site and signed in on the GitHub fake.`);
  const call = async (name: string, args: Record<string, unknown>) => {
    say(`@${DONOR}'s agent calls ${name} ${JSON.stringify(args)}`);
    const result = await donor.callTool({ name, arguments: args });
    say(textOf(result).replace(/^/gm, '    '));
    return result;
  };
  // The structured answer of a call that didn't fail.
  const answer = (result: CallToolResult, step: string): unknown => {
    if (result.isError === true || result.structuredContent === undefined) throw new Error(`${step} failed: ${textOf(result)}`);
    return result.structuredContent;
  };
  try {
    // Start a session, and save interests on the donor's first run.
    const session = answer(
      await call('start_session', { agent: 'claude-code', budget: { kind: 'issues', count: 1 } }),
      'start_session',
    ) as { sessionId: string; interests: unknown; unfinishedClaims: { issue: string }[] };
    const { sessionId } = session;
    if (session.interests === null) {
      say(`@${DONOR} has no saved interests, so the agent asks, and saves what they like.`);
      answer(await call('set_interests', { languages: ['TypeScript'], projects: [project], kinds: ['bugs'] }), 'set_interests');
    }

    // An unfinished claim comes before anything new. An earlier run that
    // stopped before its submit left one.
    const unfinished = session.unfinishedClaims.some((claim) => claim.issue.toLowerCase() === DONOR_ISSUE);
    if (unfinished) {
      say(`@${DONOR} has an unfinished claim on ${DONOR_ISSUE}, and takes it up again.`);
    } else {
      if (session.unfinishedClaims.length > 0) say(`@${DONOR} keeps their unfinished claims for later, and asks for new issues.`);
      // Suggestions, until the issue comes up. The donor picks it.
      const shown: string[] = [];
      let pick: Suggestion | undefined;
      for (let tries = 0; tries < 10 && pick === undefined; tries++) {
        const { suggestions } = answer(
          await call('suggest_issues', { sessionId, ...(shown.length > 0 ? { exclude: shown } : {}) }),
          'suggest_issues',
        ) as { suggestions: Suggestion[] };
        pick = suggestions.find((s) => s.issue.toLowerCase() === DONOR_ISSUE);
        if (suggestions.length === 0) break;
        shown.push(...suggestions.map((s) => s.issue));
      }
      if (pick === undefined) {
        throw new Error(
          `${DONOR_ISSUE} wasn't suggested. It takes a claim once pnpm seed gave the site the sample work, until a PR opens on it, and each run opens one. For a run on the same database, stop pnpm dev, empty its local data with pnpm --filter @goodfirsttoken/web exec node scripts/migrate-local.mjs --fresh, start pnpm dev, and run pnpm seed. Then run this again.`,
        );
      }
      if (pick.claUrl !== null) throw new Error(`${project} asks for a CLA, which the sample work never sets.`);
    }
    const claimed = answer(await call('claim_issue', { sessionId, issue: DONOR_ISSUE }), 'claim_issue') as Claimed;
    const { claimId } = claimed.claim;
    say(`The agent asks "Any special instructions for this one?" @${DONOR} has none.`);
    say(`The agent clones ${claimed.clone.url} at ${claimed.clone.commit}, and reads its CONTRIBUTING.`);

    // Updates as it works. Two lines close together: the second waits, and
    // is folded into the next.
    const first = answer(await call('post_update', { claimId, text: 'read CONTRIBUTING.md and the notes for agents' }), 'post_update') as Posted;
    const early = answer(
      await call('post_update', { claimId, text: 'wrote failing test: /docs/ keeps its trailing slash' }),
      'post_update',
    ) as Posted;
    if (!first.posted || early.posted || early.waitSeconds === null) {
      throw new Error('Two posts a moment apart should take the first and ask the second to wait.');
    }
    say(`The server asks for ${String(early.waitSeconds)}s, so the agent waits, and folds the line into its next one.`);
    await sleep(early.waitSeconds * 1000);
    const folded = answer(
      await call('post_update', { claimId, text: 'wrote failing test for /docs/, kept its trailing slash (src/rewrite.ts)' }),
      'post_update',
    ) as Posted;
    if (!folded.posted) throw new Error('The folded update, after the wait, was not posted.');

    // Submit. GitHub may still be making the donor's fork, and the same
    // submit works once it is done.
    const submit = {
      claimId,
      files: [
        { path: 'src/rewrite.ts', content: 'export const keepTrailingSlash = true;\n' },
        { path: 'test/rewrite.test.ts', content: "import { keepTrailingSlash } from '../src/rewrite';\n" },
      ],
      summary: 'Keeps the trailing slash when a rewrite starts from a path that ends in one.',
      checks: 'pnpm skills:run follows the give skill with no model, so it ran no tests.',
      agent: 'claude-code',
      model: 'skill-run',
    };
    let result = await call('submit_work', submit);
    for (let tries = 0; tries < 5 && refusalOf(result) === 'fork_not_ready'; tries++) {
      await sleep(2000);
      result = await call('submit_work', submit);
    }
    const submitted = answer(result, 'submit_work') as Submitted;

    // The review queue. Work that waits there opens once the donor read it.
    const queue = answer(await call('my_work', {}), 'my_work') as { readyToOpen: { claimId: string }[] };
    const waiting = queue.readyToOpen.some((item) => item.claimId === claimId);
    let pr = submitted.pr;
    if (pr === null) {
      if (!waiting) throw new Error(`The work went to the review queue with ${String(submitted.reviewReason)}, and my_work doesn't list it.`);
      say(`@${DONOR} reads the diff, and says to open it.`);
      pr = (answer(await call('open_pr', { claimId }), 'open_pr') as { pr: { number: number; url: string } }).pr;
    } else if (waiting) {
      throw new Error(`The PR opened by itself, and my_work still lists claim ${claimId} to open.`);
    }
    return { issue: DONOR_ISSUE, claimId, resumed: claimed.resumed, waitedSeconds: early.waitSeconds, pr, reviewReason: submitted.reviewReason };
  } finally {
    await donor.close().catch(() => undefined);
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
    `\nDone. @${MAINTAINER} registered ${run.repo} on ${site}, @${ADMIN} approved it as ${run.queueId}, and project_status says ${run.status}.\n`,
  );
  const given = await runDonorSkills(site);
  console.log(
    `\nDone. @${DONOR} claimed ${given.issue} as claim ${given.claimId}, posted as they worked, submitted, and the work is on PR #${String(given.pr.number)}: ${given.pr.url}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
