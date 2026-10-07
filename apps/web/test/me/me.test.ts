import { REVIEW_WINDOW_MS, type ProjectSettingsInput } from '@goodfirsttoken/core';
import type { FakeState, GitHubFake } from '@goodfirsttoken/github-fake';
import { symmetricDecrypt } from 'better-auth/crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { signNotice } from '../../src/auth/notice';
import { createProject, getPerson, getSubmission, saveIssues, savePerson } from '../../src/db';
import { loadMePage } from '../../src/me/page';
import { issueRoom } from '../../src/rooms/issue-room';
import { Browser, ORIGIN, location, signIn, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { freshNumbers } from '../sync/helpers';

// /me, fetched and posted through the whole Worker by a browser signed in on
// the site with the GitHub fake, beside the donor's own agent, which claims
// and submits through the MCP client SDK. The review queue and Open PR run
// my_work's and open_pr's rules with the GitHub token from the person's
// sign-in on the site. sample-maintainer is an admin of the made-up
// sample-owner repos, and the donors can push to none of them. Every
// project setting, issue, and file here is made up.

const APP = 'sample-owner/sample-app';
const BY = 'sample-maintainer';
const maintainer = { githubId: 1009, login: 'sample-maintainer' };
const PEOPLE = { priya: 1001, kenji: 1002, sam: 1003, lena: 1006 } as const;
type Login = keyof typeof PEOPLE;
const NOTES = { summary: 'Keeps the trailing slash when a rewrite runs.', checks: 'pnpm test: 12 passing.' };
const PR_CALL = 'POST /repos/{owner}/{repo}/pulls';

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  github.forkDelayMs = 0;
  // Issue rooms keep their storage across the tests in a file.
  freshNumbers(github, APP);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  await savePerson(env.DB, maintainer, Date.now());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Donor {
  agent: ConnectedAgent;
  sessionId: string;
}

async function tool(d: Donor, name: string, args: Record<string, unknown>): Promise<Result> {
  const result = (await d.agent.client.callTool({ name, arguments: args })) as Result;
  if (result.isError) throw new Error(result.content.map((c) => c.text).join('\n'));
  return result;
}

/** The donor's agent, connected, with a session. */
async function agentOf(login: Login): Promise<Donor> {
  const agent = await connectAgent(github, login);
  const started = (await agent.client.callTool({
    name: 'start_session',
    arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } },
  })) as Result;
  return { agent, sessionId: String(started.structuredContent?.sessionId) };
}

/** A browser signed in on the site as `login`. */
async function site(login: Login): Promise<Browser> {
  const browser = new Browser();
  await signIn(browser, github, login);
  return browser;
}

/** The GitHub token the site holds for the person from their sign-in on the site, decrypted. */
async function siteToken(login: Login): Promise<string> {
  const stored = await env.DB.prepare('SELECT access_token FROM account WHERE account_id = ?1')
    .bind(String(PEOPLE[login]))
    .first<string | null>('access_token');
  if (!stored) throw new Error(`the site holds no token for ${login}`);
  return symmetricDecrypt({ key: env.AUTH_SECRET, data: stored });
}

async function project(settings: ProjectSettingsInput): Promise<void> {
  await createProject(
    env.DB,
    { repo: APP, status: 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId },
    Date.now(),
  );
}

/** Opens a tagged issue on GitHub, and caches it as a sync would. */
async function tagged(title = 'Keep the trailing slash in rewrites'): Promise<string> {
  const number = github.openIssue(APP, { title, body: 'A rewrite from /docs/ drops the slash.', labels: ['help wanted'], by: BY });
  const issue = `${APP}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: APP, title, labels: ['help wanted'], linkedPr: null, syncedAt: Date.now() }]);
  return issue;
}

/** The donor's agent claims the issue and submits work to it, which waits in their review queue. */
async function submitted(d: Donor, issue: string): Promise<string> {
  const claimed = await tool(d, 'claim_issue', { sessionId: d.sessionId, issue });
  const claimId = (claimed.structuredContent as { claim: { claimId: string } }).claim.claimId;
  const result = await tool(d, 'submit_work', {
    claimId,
    files: [{ path: 'src/rewrite.ts', content: 'export const keepSlash = true;\n' }],
    ...NOTES,
    agent: 'claude-code',
    model: 'claude-opus-5-5',
  });
  expect(result.structuredContent?.reviewReason).not.toBeNull();
  return claimId;
}

/** Follows the form's redirect back to /me, and returns the page's HTML. */
async function back(browser: Browser, answer: Response): Promise<string> {
  expect(answer.status).toBe(303);
  const to = location(answer);
  expect(to.pathname).toBe('/me');
  const page = await browser.fetch(`${to.pathname}${to.search}`);
  expect(page.status).toBe(200);
  return page.text();
}

/**
 * The notice the page shows, as HTML, or null when it shows none. The
 * page's address, which holds any notice, also rides in the page's own
 * data, so a test reads the notice where the page shows it.
 */
function shown(html: string): string | null {
  return /<p class="account__notice" role="status">(.*?)<\/p>/s.exec(html)?.[1] ?? null;
}

type PullRecord = FakeState['repos'][string]['issues'][string];

/** The open PRs in the sample repo, or the ones `login` opened. */
function pulls(login?: string): PullRecord[] {
  const repo = github.state.repos[APP.toLowerCase()];
  if (!repo) throw new Error(`the fake has no repo ${APP}`);
  return Object.values(repo.issues).filter(
    (issue) => issue.pull !== null && issue.state === 'open' && (login === undefined || issue.user === login),
  );
}

async function stateOf(issue: string, claimId: string) {
  return (await issueRoom(env.ISSUE_ROOM, issue).snapshot()).claims.find((c) => c.id === claimId)?.state;
}

const openPr = (claim: string, extra: Record<string, string> = {}) => ({ action: 'open_pr', claim, ...extra });

describe('the review queue on /me', () => {
  test("lists the person's own work waiting for its PR, with its summary and diff, and nobody else's", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const [mine, theirs] = [await tagged('Keep the trailing slash'), await tagged('Keep the query string')];
    const priya = await agentOf('priya');
    const kenji = await agentOf('kenji');
    const claimId = await submitted(priya, mine);
    const kenjiClaim = await submitted(kenji, theirs);
    const browser = await site('priya');

    const page = await (await browser.fetch('/me')).text();

    expect(page).toContain(mine);
    expect(page).toContain(NOTES.summary);
    expect(page).toContain('The project asks you to read the diff before its PR opens.');
    expect(page).toContain(`name="claim" value="${claimId}"`);
    expect(page).toContain(`/compare/`);
    expect(page).not.toContain(theirs);
    expect(page).not.toContain(kenjiClaim);
    expect(page).not.toContain('Keep the query string');
  });

  test('shows the titles and summaries agents wrote as text', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged('<img src=x onerror=alert(1)>');
    const priya = await agentOf('priya');
    await submitted(priya, issue);

    const page = await (await (await site('priya')).fetch('/me')).text();

    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x');
  });

  test('the page is never stored, by a browser or anyone else, so it is gone after sign-out', async () => {
    const page = await (await site('lena')).fetch('/me');

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
  });

  test('says how long work waits for its PR, as long as core keeps it in the queue', async () => {
    const page = await (await (await site('lena')).fetch('/me')).text();

    expect(page).toContain(`Open the PR within ${String(REVIEW_WINDOW_MS / 86_400_000)} days of the first submission.`);
  });

  test('with no work waiting, it says so', async () => {
    const page = await (await (await site('lena')).fetch('/me')).text();

    expect(page).toContain('Nothing to open yet.');
  });

  test("when GitHub no longer takes the site's token, the queue says to sign in again, the agents stay listed, and Open PR opens nothing", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    Reflect.deleteProperty(github.state.tokens, await siteToken('priya'));

    const page = await (await browser.fetch('/me')).text();
    const answer = await back(browser, await browser.post('/me', openPr(claimId)));

    expect(page).toContain('GitHub rejected your saved token.');
    expect(page).toContain('aria-label="Disconnect Claude Code (test)"');
    expect(shown(answer)).toContain('No PR opened. GitHub no longer takes the token this site holds for you.');
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });
});

describe('Open PR on /me', () => {
  test("opens the PR as the donor with the token from their sign-in on the site, and the work leaves the queue", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    const before = github.calls.length;

    const answer = await back(browser, await browser.post('/me', openPr(claimId)));

    const [pull] = pulls('priya');
    if (!pull?.pull) throw new Error('no PR opened');
    const submission = await getSubmission(env.DB, claimId);
    expect(pull.pull).toMatchObject({ head: { repo: 'priya/sample-app', ref: submission?.branch }, base: { ref: 'main' } });
    expect(pull.body).toContain(NOTES.summary);
    expect(pull.body).toContain(`Closes #${issue.slice(issue.indexOf('#') + 1)}`);
    const opened = github.calls.slice(before).filter((call) => call.operation === PR_CALL);
    expect(opened.map((call) => call.token)).toEqual([await siteToken('priya')]);
    // Every call the form made to GitHub ran as priya, with her site token.
    const made = github.calls.slice(before).filter((call) => call.url.startsWith(github.apiUrl));
    expect(new Set(made.map((call) => call.token))).toEqual(new Set([await siteToken('priya')]));
    expect(shown(answer)).toContain(`Opened PR #${String(pull.number)} on ${APP} for ${issue}: `);
    expect(await stateOf(issue, claimId)).toBe('pr_opened');
    expect(answer).toContain('Nothing to open yet.');
  });

  test("a claim ID from another donor is refused, and nothing is read from GitHub, opened, or changed", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const kenji = await site('kenji');
    const before = github.calls.length;

    const answer = await back(kenji, await kenji.post('/me', openPr(claimId)));

    expect(shown(answer)).toContain('No PR opened. Only the person who made the claim can do this.');
    expect(github.calls.slice(before).filter((call) => call.url.startsWith(github.apiUrl))).toEqual([]);
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
    expect(await (await (await site('priya')).fetch('/me')).text()).toContain(`name="claim" value="${claimId}"`);
  });

  test('a form from another site, or with no Origin, is refused with 403 and opens nothing', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');

    const elsewhere = await browser.post('/me', openPr(claimId), 'https://elsewhere.example');
    const none = await browser.post('/me', openPr(claimId), null);
    const lookalike = await browser.post('/me', openPr(claimId), `${ORIGIN}.elsewhere.example`);

    expect([elsewhere.status, none.status, lookalike.status]).toEqual([403, 403, 403]);
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });

  test('signed out, the form goes to sign-in and opens nothing', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);

    const answer = await new Browser().post('/me', openPr(claimId));

    expect(answer.status).toBe(303);
    expect(location(answer).pathname).toBe('/sign-in');
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });

  test("when GitHub answers with a server error, the page says no PR opened and to try again, and the work stays in the queue", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(github.apiUrl)) {
        return Promise.resolve(Response.json({ message: 'Server Error' }, { status: 502 }));
      }
      return github.fetch(request);
    });

    const answer = await back(browser, await browser.post('/me', openPr(claimId)));

    expect(shown(answer)).toContain("No PR opened. GitHub didn&#x27;t answer. Try again in a minute.");
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });

  test("when the donor's GitHub rate limit is spent, the page says no PR opened and to try again", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    github.state.rateLimits = {
      priya: { core: { limit: 5000, used: 5000, resetAt }, graphql: { limit: 5000, used: 5000, resetAt } },
    };

    const answer = await back(browser, await browser.post('/me', openPr(claimId)));

    expect(shown(answer)).toContain("No PR opened. GitHub didn&#x27;t answer. Try again in a minute.");
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });

  test("the refusals open_pr gives come back in the page's notice, like a second Open PR on work whose PR is open", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    await back(browser, await browser.post('/me', openPr(claimId)));

    const again = await back(browser, await browser.post('/me', openPr(claimId)));

    expect(shown(again)).toContain('No PR opened.');
    expect(pulls('priya')).toHaveLength(1);
  });
});

describe('the description a project asks the donor to write', () => {
  test("starts empty, never holding the agent's summary", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed', personWrittenDescription: true });
    const issue = await tagged();
    const priya = await agentOf('priya');
    await submitted(priya, issue);

    const page = await (await (await site('priya')).fetch('/me')).text();

    const field = /<textarea[^>]*name="description"[^>]*>([^<]*)<\/textarea>/.exec(page);
    expect(field).not.toBeNull();
    expect(field?.[1]).toBe('');
    expect(field?.[0]).toContain('required');
    expect(field?.[0]).not.toContain(NOTES.summary);
  });

  test("isn't asked for when the project doesn't ask the donor to write one", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed' });
    const issue = await tagged();
    const priya = await agentOf('priya');
    await submitted(priya, issue);

    const page = await (await (await site('priya')).fetch('/me')).text();

    expect(page).toContain('Open PR');
    expect(page).not.toContain('name="description"');
  });

  test('sent blank, or with spaces alone, is refused and opens nothing', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed', personWrittenDescription: true });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');

    const left = await back(browser, await browser.post('/me', openPr(claimId)));
    const blank = await back(browser, await browser.post('/me', openPr(claimId, { description: '' })));
    const spaces = await back(browser, await browser.post('/me', openPr(claimId, { description: ' \r\n\t ' })));

    for (const answer of [left, blank, spaces]) {
      expect(shown(answer)).toContain('No PR opened. This project asks you to write the PR description yourself.');
    }
    expect(pulls()).toEqual([]);
    expect(await stateOf(issue, claimId)).toBe('awaiting_review');
  });

  test("written, it opens the PR with the donor's words in place of the agent's summary, as they wrote them", async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed', personWrittenDescription: true });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    // A browser sends each line break in a form as CR LF.
    const words = 'Rewrites keep the *trailing* slash now.\r\n\r\nI read the diff <b>twice</b>, and ran the tests.';

    await back(browser, await browser.post('/me', openPr(claimId, { description: `  ${words}\r\n` })));

    const [pull] = pulls('priya');
    const number = issue.slice(issue.indexOf('#') + 1);
    expect(pull?.body).toBe(
      `Rewrites keep the *trailing* slash now.\n\nI read the diff <b>twice</b>, and ran the tests.\n\nCloses #${number}\n\nWritten with a coding agent through Good First Token.`,
    );
    expect(pull?.body).not.toContain(NOTES.summary);
    expect(await stateOf(issue, claimId)).toBe('pr_opened');
  });

  test('a key or token in the words reaches the PR only as [redacted]', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed', personWrittenDescription: true });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');
    // Made up here, in the shape of a GitHub token.
    const token = ['ghp', '_', 'A1b2'.repeat(9)].join('');

    await back(browser, await browser.post('/me', openPr(claimId, { description: `It works with ${token} set.` })));

    const [pull] = pulls('priya');
    expect(pull?.body).toMatch(/^It works with \[redacted\] set\./);
    expect(pull?.body).not.toContain(token);
  });

  test('longer than open_pr takes is refused, and opens nothing', async () => {
    await project({ tags: ['help wanted'], prMode: 'reviewed', personWrittenDescription: true });
    const issue = await tagged();
    const priya = await agentOf('priya');
    const claimId = await submitted(priya, issue);
    const browser = await site('priya');

    const answer = await back(browser, await browser.post('/me', openPr(claimId, { description: 'x'.repeat(60_001) })));

    expect(shown(answer)).toContain('No PR opened. description: must be at most 60,000 characters.');
    expect(pulls()).toEqual([]);
  });
});

describe('interests on /me', () => {
  test("save through set_interests' schema, show on the page, and reach start_session", async () => {
    const browser = await site('lena');

    const page = await back(
      browser,
      await browser.post('/me', { action: 'interests', languages: 'rust, typescript', projects: APP, kinds: 'docs, , tests' }),
    );
    const lena = await agentOf('lena');
    const started = await tool(lena, 'start_session', { agent: 'claude-code', budget: { kind: 'issues', count: 1 } });

    const saved = { languages: ['rust', 'typescript'], projects: [APP], kinds: ['docs', 'tests'] };
    expect((await getPerson(env.DB, PEOPLE.lena))?.interests).toEqual(saved);
    expect(started.structuredContent?.interests).toEqual(saved);
    expect(shown(page)).toContain('Saved your interests.');
    expect(page).toContain('value="rust, typescript"');
  });

  test('a list longer than set_interests takes saves nothing, and says why', async () => {
    const browser = await site('lena');
    await browser.post('/me', { action: 'interests', languages: 'rust', projects: '', kinds: '' });
    const many = Array.from({ length: 21 }, (_, i) => `lang${String(i)}`).join(', ');

    const page = await back(browser, await browser.post('/me', { action: 'interests', languages: many, projects: '', kinds: '' }));

    expect(shown(page)).toContain('Nothing saved. languages: must list at most 20.');
    expect((await getPerson(env.DB, PEOPLE.lena))?.interests).toEqual({ languages: ['rust'], projects: [], kinds: [] });
  });

  test('from another site, the form saves nothing', async () => {
    const browser = await site('lena');

    const answer = await browser.post('/me', { action: 'interests', languages: 'rust' }, 'https://elsewhere.example');

    expect(answer.status).toBe(403);
    expect((await getPerson(env.DB, PEOPLE.lena))?.interests).toBeNull();
  });
});

describe("the page's notice", () => {
  test("shows only a notice the page signed for the person reading it", async () => {
    const browser = await site('priya');
    const forPriya = await signNotice(`me-notice:${String(PEOPLE.priya)}`, 'Saved your interests.');
    const forKenji = await signNotice(`me-notice:${String(PEOPLE.kenji)}`, 'Opened PR #1 on the wrong repo.');
    const forAdmin = await signNotice('admin-notice', 'Removed a repo.');
    const at = (notice: string, sig: string) => `/me?${new URLSearchParams({ notice, sig }).toString()}`;

    const signed = await (await browser.fetch(at('Saved your interests.', forPriya))).text();
    const kenjis = await (await browser.fetch(at('Opened PR #1 on the wrong repo.', forKenji))).text();
    const admins = await (await browser.fetch(at('Removed a repo.', forAdmin))).text();
    const forged = await (await browser.fetch(at('Opened PR #9.', 'not-a-signature'))).text();

    expect(shown(signed)).toContain('Saved your interests.');
    expect(shown(kenjis)).toBeNull();
    expect(shown(admins)).toBeNull();
    expect(shown(forged)).toBeNull();
  });
});

describe("the page's server function", () => {
  test('reads nothing for someone signed out', async () => {
    const reads = vi.spyOn(env.DB, 'prepare');

    const { result } = await loadMePage(new Request(`${ORIGIN}/me`), {});

    expect(result).toEqual({ state: 'signed_out' });
    expect(reads).not.toHaveBeenCalled();
    expect(github.calls).toEqual([]);
  });
});
