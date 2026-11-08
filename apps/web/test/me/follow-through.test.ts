import { tools } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createProject, listPrFollowModes, listWakes, saveIssues, savePerson } from '../../src/db';
import { followRefusalText } from '../../src/me/refusals';
import { followPrs } from '../../src/sync/prs';
import { ALLOWANCES } from '../../src/sync/allowances';
import { Browser, ORIGIN, location, signIn, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from '../mcp/helpers';
import { freshNumbers, jobDeps } from '../sync/helpers';

// Follow-through on /me (docs/specs/follow-through.md, under Status, Stalled
// PRs, A wake that stopped, and The donor's choice), fetched and posted
// through the whole Worker by a browser signed in on the site with the
// GitHub fake, beside the donor's own agent, which opens and records a PR
// and sorts its follow-ups through the MCP client SDK. A maintainer reviews
// the PR on the fake, and the PR job reads the review. Every project,
// issue, person, and comment here is made up.

const APP = 'sample-owner/sample-app';
const BY = 'sample-maintainer';
const maintainer = { githubId: 1009, login: BY };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOTES = { summary: 'Keeps the trailing slash when a rewrite runs.', checks: 'pnpm test: 12 passing.' };
const TRAILED = 'Keep the trailing slash in rewrites\n\nAssisted-by: claude-code (claude-opus-5-5)';
const desktop = { harness: 'claude-code-desktop', level: 'full', intervalMinutes: 15 };
const desktopWake = desktop;

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  github.forkDelayMs = 0;
  freshNumbers(github, APP);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await savePerson(env.DB, maintainer, Date.now());
  await createProject(
    env.DB,
    {
      repo: APP,
      status: 'approved',
      source: 'registered',
      policy: null,
      settings: { tags: ['help wanted'], prMode: 'automatic' },
      addedBy: maintainer.githubId,
    },
    Date.now(),
  );
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
  login: string;
  sessionId: string;
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text).join('\n');
}

async function call(d: Donor, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await d.agent.client.callTool({ name, arguments: args })) as Result;
}

async function tool(d: Donor, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await call(d, name, args);
  if (result.isError) throw new Error(textOf(result));
  return result;
}

async function donor(login: string): Promise<Donor> {
  const agent = await connectAgent(github, login);
  const started = await tool({ agent, login, sessionId: '' }, 'start_session', { agent: 'claude-code', budget: { kind: 'until_limit' } });
  return { agent, login, sessionId: String(started.structuredContent?.sessionId) };
}

/** A browser signed in on the site as `login`. */
async function site(login: string): Promise<Browser> {
  const browser = new Browser();
  await signIn(browser, github, login);
  return browser;
}

async function tagged(): Promise<string> {
  const title = 'Keep the trailing slash in rewrites';
  const number = github.openIssue(APP, { title, body: 'A rewrite from /docs/ drops the slash.', labels: ['help wanted'], by: BY });
  const issue = `${APP}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: APP, title, labels: ['help wanted'], linkedPr: null, syncedAt: Date.now() }]);
  return issue;
}

interface Opened {
  issue: string;
  claimId: string;
  pr: { repo: string; number: number; url: string };
}

/**
 * The donor's agent claims a tagged issue, pushes the claim's branch to the
 * donor's fork as their own git would, and submits it, which clears it in
 * the automatic project. The donor opens the PR with their own gh, and
 * their agent records it.
 */
async function openedPr(d: Donor): Promise<Opened> {
  const issue = await tagged();
  const claimed = await tool(d, 'claim_issue', { sessionId: d.sessionId, issue });
  const content = claimed.structuredContent as { claim: { claimId: string }; clone: { commit: string }; branch: { name: string } };
  const { claimId } = content.claim;
  const name = content.branch.name;
  const fork = `${d.login}/sample-app`;
  const headers = { authorization: `Bearer ${github.tokenFor(d.login)}`, 'content-type': 'application/json', 'user-agent': 'me-test' };
  if (github.state.repos[fork] === undefined) {
    const made = await github.fetch(`${github.apiUrl}/repos/${APP}/forks`, { method: 'POST', headers, body: '{}' });
    if (!made.ok) throw new Error(`no fork for ${d.login}`);
  }
  const branches = github.state.repos[fork]?.branches;
  if (!branches) throw new Error(`the fake has no fork ${fork}`);
  branches[name] ??= content.clone.commit;
  const head = github.commitFiles(fork, { 'src/rewrite.ts': 'export const keepSlash = true;\n' }, d.login, { branch: name, message: TRAILED });
  const submitted = await tool(d, 'submit_work', {
    claimId,
    branch: { repo: fork, name, head },
    ...NOTES,
    agent: 'claude-code',
    model: 'claude-opus-5-5',
  });
  const toOpen = submitted.structuredContent?.toOpen as { repo: string; head: string; base: string; title: string; body: string };
  const response = await github.fetch(`${github.apiUrl}/repos/${toOpen.repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: toOpen.title, body: toOpen.body, head: toOpen.head, base: toOpen.base }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`);
  const { number }: { number: number } = await response.json();
  const recorded = await tool(d, 'record_pr', { claimId, pr: `${github.webUrl}/${APP}/pull/${String(number)}` });
  return { issue, claimId, pr: (recorded.structuredContent as { pr: Opened['pr'] }).pr };
}

const runPrJob = () => followPrs(jobDeps(github, ALLOWANCES.prs));

/** A maintainer's review on the PR, read by the PR job, and its follow-up's ID. */
async function reviewed(d: Donor, number: number, body: string): Promise<string> {
  github.reviewPullRequest(APP, number, { login: BY, state: 'COMMENTED', body });
  await runPrJob();
  const listed = (await tool(d, 'my_work')).structuredContent?.followUps as { followUpId: string; comment: string }[];
  const found = listed.find((f) => f.comment === body);
  if (found === undefined) throw new Error(`no follow-up for ${body}`);
  return found.followUpId;
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

/** The notice the page shows, as HTML, or null when it shows none. */
function shown(html: string): string | null {
  return /<p class="account__notice" role="status">(.*?)<\/p>/s.exec(html)?.[1] ?? null;
}

/** Each open PR's part of the page, in the page's order. */
function prParts(html: string): string[] {
  const parts = html.split('<li class="follow-pr"').slice(1);
  const last = parts.length - 1;
  if (last >= 0) parts[last] = (parts[last] ?? '').split('Submitted work')[0] ?? '';
  return parts;
}

/** The part of the page for the PR, by its number. */
function partFor(html: string, number: number): string {
  const found = prParts(html).find((part) => part.includes(`>PR #${String(number)}<`));
  if (found === undefined) throw new Error(`/me shows no PR #${String(number)}`);
  return found;
}

/** The page's follow-through section in the aside: the mode, the wakes, and the feed. */
function followSection(html: string): string {
  return /aria-label="follow-through">(.*?)<\/section>/s.exec(html)?.[1] ?? '';
}

function utcMinute(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const apostrophe = (words: string) => words.replaceAll("'", '&#x27;');

describe('open PRs on /me', () => {
  test("each open PR shows where it stands, a stalled one first with the step to take, and no one else's PRs", async () => {
    const priya = await donor('priya');
    const kenji = await donor('kenji');
    const fresh = await openedPr(priya);
    const old = await openedPr(priya);
    const theirs = await openedPr(kenji);
    await reviewed(priya, fresh.pr.number, 'Please add a test.');
    await reviewed(priya, old.pr.number, 'Add a changelog line.');
    await env.DB.prepare('UPDATE follow_ups SET read_at = ? WHERE claim_id = ?').bind(Date.now() - DAY - MINUTE, old.claimId).run();

    const page = await (await (await site('priya')).fetch('/me')).text();

    const parts = prParts(page);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(`>PR #${String(old.pr.number)}<`);
    expect(parts[0]).toContain('>stalled<');
    expect(parts[0]).toContain('A follow-up has waited a day with no run to sort it.');
    expect(parts[1]).toContain(`>PR #${String(fresh.pr.number)}<`);
    expect(parts[1]).toContain('>your agent is on it<');
    expect(parts[1]).not.toContain('A follow-up has waited a day');
    expect(page.indexOf('Open PRs')).toBeLessThan(page.indexOf('Submitted work'));
    expect(page).not.toContain(`>PR #${String(theirs.pr.number)}<`);
    expect(page).not.toContain(theirs.claimId);
  });

  test("a follow-up that waits for the donor shows the reviewer's words and the agent's question, and the PR waits for them", async () => {
    const priya = await donor('priya');
    const { claimId, pr } = await openedPr(priya);
    const asked = await reviewed(priya, pr.number, 'Could this cover the admin feed as well?');
    const question = 'The issue names the public feed only. Should the fix cover the admin feed too?';
    await tool(priya, 'sort_follow_ups', { claimId, followUps: [{ followUpId: asked, state: 'waiting_donor', question }] });

    const part = partFor(await (await (await site('priya')).fetch('/me')).text(), pr.number);

    expect(part).toContain('>waiting for you<');
    expect(part).toContain('Could this cover the admin feed as well?');
    expect(part).toContain(question);
    expect(part).toContain('@sample-maintainer');
    expect(part).toContain('Answer it in a session with your agent.');
    expect(part).toContain('checked again once you answer');
  });

  test('the latest follow-ups show where each stands, with the reply, and the PR says when it is checked next, as my_work does', async () => {
    const priya = await donor('priya');
    const { claimId, pr } = await openedPr(priya);
    const why = await reviewed(priya, pr.number, 'Why keep the slash here?');
    const thanks = await reviewed(priya, pr.number, 'Thanks, this reads well.');
    const reply = `${pr.url}#issuecomment-77`;
    await tool(priya, 'sort_follow_ups', {
      claimId,
      followUps: [
        { followUpId: why, state: 'waiting_reviewer', replyUrl: reply },
        { followUpId: thanks, state: 'settled', outcome: 'no_change' },
      ],
    });
    const work = await tool(priya, 'my_work');

    const part = partFor(await (await (await site('priya')).fetch('/me')).text(), pr.number);

    const ft = work.structuredContent?.followThrough as { prs: { claimId: string; nextCheckAt: string | null }[] };
    const next = ft.prs.find((one) => one.claimId === claimId)?.nextCheckAt ?? null;
    expect(next).not.toBeNull();
    expect(part).toContain('>waiting for a reviewer<');
    expect(part).toContain('waiting for the reviewer');
    expect(part).toContain(`href="${reply}"`);
    expect(part).toContain('no change needed');
    expect(part).toContain('Thanks, this reads well.');
    expect(part).toContain(`checked next ${utcMinute(Date.parse(next ?? ''))}`);
    expect(part).toContain('go ahead, your mode');
  });

  test('a PR with a question for the donor comes before an older one with none, and stays first until they answer', async () => {
    const priya = await donor('priya');
    const older = await openedPr(priya);
    const newer = await openedPr(priya);
    const asked = await reviewed(priya, newer.pr.number, 'Should this cover the admin feed?');
    await tool(priya, 'sort_follow_ups', { claimId: newer.claimId, followUps: [{ followUpId: asked, state: 'waiting_donor', question: 'Cover it?' }] });
    const browser = await site('priya');

    const before = prParts(await (await browser.fetch('/me')).text());
    await tool(priya, 'sort_follow_ups', { claimId: newer.claimId, followUps: [{ followUpId: asked, state: 'settled', outcome: 'no_change' }] });
    const after = prParts(await (await browser.fetch('/me')).text());

    expect(before.map((part) => part.includes(`>PR #${String(newer.pr.number)}<`))).toEqual([true, false]);
    expect(after.map((part) => part.includes(`>PR #${String(older.pr.number)}<`))).toEqual([true, false]);
  });

  test("the summary of the agent's latest submit shows, which a round's push replaces", async () => {
    const priya = await donor('priya');
    const { pr } = await openedPr(priya);

    const part = partFor(await (await (await site('priya')).fetch('/me')).text(), pr.number);

    expect(part).toContain('your agent&#x27;s latest submit,');
    expect(part).toContain(NOTES.summary);
  });

  test('the green live chip shows only while a run holds the PR, and an open follow-up with no run shows the open PR chip', async () => {
    const priya = await donor('priya');
    const { claimId, pr } = await openedPr(priya);
    await reviewed(priya, pr.number, 'Please add a test.');
    const browser = await site('priya');

    const waiting = partFor(await (await browser.fetch('/me')).text(), pr.number);
    await tool(priya, 'follow_pr', { claimId, runId: 'run-me-test', action: 'take' });
    const held = partFor(await (await browser.fetch('/me')).text(), pr.number);

    expect(waiting).toContain('<span class="chip chip--opened">your agent is on it</span>');
    expect(held).toContain('<span class="chip chip--live">your agent is on it</span>');
    expect(waiting).toContain('due at your agent&#x27;s next run');
  });

  test('/me.md lists the open PRs, how each stands and is followed, the wakes, and the feed', async () => {
    const priya = await donor('priya');
    const { claimId, pr } = await openedPr(priya);
    const asked = await reviewed(priya, pr.number, 'Could this cover the admin feed as well?');
    await tool(priya, 'sort_follow_ups', { claimId, followUps: [{ followUpId: asked, state: 'waiting_donor', question: 'Cover the admin feed?' }] });
    await tool(priya, 'set_follow_through', { wake: desktop });

    const markdown = await (await (await site('priya')).fetch('/me.md')).text();

    expect(markdown).toContain('## Open PRs');
    expect(markdown).toContain(`[PR #${String(pr.number)}](${pr.url})`);
    expect(markdown).toContain('waiting for you, go ahead, checked again once you answer.');
    expect(markdown).toContain('Your agent asks: Cover the admin feed?');
    expect(markdown).toContain('## Follow-through');
    expect(markdown).toContain("Your PRs follow go ahead. You haven't chosen, so this is the default.");
    expect(markdown).toContain('Claude Code desktop app, full, every 15 minutes, no run yet');
    expect(markdown).toContain(`${ORIGIN}/@priya/live.ndjson`);
  });

  test('a donor with no open PR and no wake has nothing to follow, and the page shows no follow-through', async () => {
    const page = await (await (await site('lena')).fetch('/me')).text();
    const markdown = await (await (await site('lena')).fetch('/me.md')).text();

    expect(page).not.toContain('Open PRs');
    expect(page).not.toContain('aria-label="follow-through"');
    expect(markdown).not.toContain('## Follow-through');
  });
});

describe('the follow-through forms on /me', () => {
  test("the donor's mode saves for all their PRs, in place of one PR's own but off, and my_work gives it", async () => {
    const priya = await donor('priya');
    const first = await openedPr(priya);
    const second = await openedPr(priya);
    await tool(priya, 'set_follow_through', { mode: 'off', claimId: first.claimId });
    await tool(priya, 'set_follow_through', { mode: 'go_ahead', claimId: second.claimId });
    const browser = await site('priya');
    const before = followSection(await (await browser.fetch('/me')).text());

    const page = await back(browser, await browser.post('/me', { action: 'follow_mode', mode: 'ask_first' }));

    expect(before).toContain(apostrophe("You haven't chosen, so your PRs follow go ahead."));
    expect(shown(page)).toMatch(/^Your PRs follow ask first now\./);
    const work = await tool(priya, 'my_work');
    expect(work.structuredContent?.followMode).toEqual({ mode: 'ask_first', chosen: true });
    expect((work.structuredContent?.openPrs as { claimId: string; followMode: string }[]).map((open) => [open.claimId, open.followMode])).toEqual([
      [first.claimId, 'off'],
      [second.claimId, 'ask_first'],
    ]);
    expect(followSection(page)).not.toContain('haven&#x27;t chosen');
    expect(followSection(page)).toMatch(/checked="" value="ask_first"/);
  });

  test('one PR takes its own mode, or off, alone, and its part of the page says so', async () => {
    const priya = await donor('priya');
    const first = await openedPr(priya);
    const second = await openedPr(priya);
    const browser = await site('priya');

    const asked = await back(browser, await browser.post('/me', { action: 'pr_follow_mode', claim: first.claimId, mode: 'ask_first' }));
    const off = await back(browser, await browser.post('/me', { action: 'pr_follow_mode', claim: second.claimId, mode: 'off' }));

    expect(shown(asked)).toContain(`PR #${String(first.pr.number)} follows ask first now.`);
    expect(shown(off)).toContain(`Your agent stops following PR #${String(second.pr.number)}.`);
    expect(await listPrFollowModes(env.DB, 1001)).toEqual(
      new Map([
        [first.claimId, 'ask_first'],
        [second.claimId, 'off'],
      ]),
    );
    expect(partFor(off, first.pr.number)).toContain('ask first, set for this PR');
    expect(partFor(off, second.pr.number)).toContain('>not followed<');
    expect(partFor(off, second.pr.number)).toContain('You stopped following this PR.');
    const work = await tool(priya, 'my_work');
    expect((work.structuredContent?.followMode as { chosen: boolean }).chosen).toBe(false);
  });

  test("another donor's claim or wake changes nothing, and the page says so in its own words", async () => {
    const priya = await donor('priya');
    const { claimId } = await openedPr(priya);
    const saved = await tool(priya, 'set_follow_through', { wake: desktop });
    const wakeId = (saved.structuredContent?.savedWake as { wakeId: string }).wakeId;
    await site('kenji');
    const kenji = await site('kenji');

    const mode = await back(kenji, await kenji.post('/me', { action: 'pr_follow_mode', claim: claimId, mode: 'off' }));
    const goOn = await back(kenji, await kenji.post('/me', { action: 'go_on', claim: claimId }));
    const wake = await back(kenji, await kenji.post('/me', { action: 'remove_wake', wake: wakeId }));

    expect(shown(mode)).toContain('Nothing changed. Only the person who made the claim can change how its PR is followed.');
    expect(shown(goOn)).toContain('Nothing changed. Only the person who made the claim can change how its PR is followed.');
    expect(shown(wake)).toContain('Nothing changed. Good First Token has no record of that PR or wake now.');
    expect(await listPrFollowModes(env.DB, 1001)).toEqual(new Map());
    expect((await listWakes(env.DB, 1001)).map((w) => w.id)).toEqual([wakeId]);
  });

  test('a form from another site, or with no Origin, is refused with 403 and changes nothing', async () => {
    const priya = await donor('priya');
    const { claimId } = await openedPr(priya);
    const browser = await site('priya');

    const elsewhere = await browser.post('/me', { action: 'pr_follow_mode', claim: claimId, mode: 'off' }, 'https://elsewhere.example');
    const none = await browser.post('/me', { action: 'follow_mode', mode: 'ask_first' }, null);

    expect([elsewhere.status, none.status]).toEqual([403, 403]);
    expect(await listPrFollowModes(env.DB, 1001)).toEqual(new Map());
    expect(((await tool(priya, 'my_work')).structuredContent?.followMode as { chosen: boolean }).chosen).toBe(false);
  });

  test("a mode set_follow_through doesn't take, or off for all PRs, is refused and changes nothing", async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const browser = await site('priya');

    const odd = await back(browser, await browser.post('/me', { action: 'follow_mode', mode: 'sometimes' }));
    const allOff = await back(browser, await browser.post('/me', { action: 'follow_mode', mode: 'off' }));

    expect(shown(odd)).toMatch(/^Nothing changed\. mode/);
    expect(shown(allOff)).toMatch(/^Nothing changed\. claimId: must name the claim whose PR to stop following\./);
    expect(((await tool(priya, 'my_work')).structuredContent?.followMode as { chosen: boolean }).chosen).toBe(false);
  });

  test('a PR at its round limit for the day says so with Go on, and Go on lets it take more rounds', async () => {
    const priya = await donor('priya');
    const { claimId, pr } = await openedPr(priya);
    const day = Math.floor(Date.now() / DAY);
    await env.DB.prepare('UPDATE prs SET rounds = 3, rounds_day = ?, rounds_on_day = 3 WHERE claim_id = ?').bind(day, claimId).run();
    const browser = await site('priya');
    const before = partFor(await (await browser.fetch('/me')).text(), pr.number);

    const after = await back(browser, await browser.post('/me', { action: 'go_on', claim: claimId }));

    expect(before).toContain('>waiting for you<');
    expect(before).toContain('Your agent took 3 rounds on this PR today, the most in a day.');
    expect(before).toContain(`aria-label="Go on with PR #${String(pr.number)}"`);
    expect(shown(after)).toContain(`PR #${String(pr.number)} goes on. Your agent can take 3 more rounds on it today, and 10 more in all.`);
    expect(partFor(after, pr.number)).not.toContain('aria-label="Go on with');
    const ft = (await tool(priya, 'my_work')).structuredContent?.followThrough as { prs: { claimId: string; roundLimit: string | null }[] };
    expect(ft.prs.find((one) => one.claimId === claimId)?.roundLimit).toBeNull();
  });

  test('every refusal set_follow_through lists has words on the page for the person, naming no tool or field', () => {
    const codes = tools.set_follow_through.refusals ?? [];
    expect(codes.length).toBeGreaterThan(0);
    const names = [...Object.keys(tools), 'claimId', 'removeWake', 'goOn', 'wakeId'];
    for (const code of codes) {
      const words = followRefusalText({ code });
      expect(words, `no words on /me for ${code}`).toMatch(/\S/);
      for (const name of names) expect(words, `the words for ${code} name ${name}`).not.toContain(name);
    }
  });
});

describe('wakes on /me', () => {
  test('each wake shows its harness, level, how often it runs, and its last run, and one that stopped says when it last ran', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const running = (await tool(priya, 'set_follow_through', { wake: desktop })).structuredContent?.savedWake as { wakeId: string };
    const quiet = (await tool(priya, 'set_follow_through', { wake: { harness: 'grok-bot', level: 'notify', intervalMinutes: 60 } }))
      .structuredContent?.savedWake as { wakeId: string };
    await tool(priya, 'my_work', { wakeId: running.wakeId });
    const lastRun = Date.now() - 3 * DAY;
    await env.DB.prepare('UPDATE wakes SET created_at = ?1, last_run_at = ?1 WHERE id = ?2').bind(lastRun, quiet.wakeId).run();

    const section = followSection(await (await (await site('priya')).fetch('/me')).text());

    const parts = section.split('class="account__agent follow-wake"').slice(1);
    const desktopPart = parts.find((part) => part.includes('Claude Code desktop app')) ?? '';
    const grokPart = parts.find((part) => part.includes('Grok Bot')) ?? '';
    expect(parts).toHaveLength(2);
    expect(desktopPart).toContain('Claude Code desktop app');
    expect(desktopPart).toContain('>full<');
    expect(desktopPart).toContain('every 15 minutes · last ran');
    expect(desktopPart).not.toContain('No run since');
    expect(grokPart).toContain('Grok Bot');
    expect(grokPart).toContain('>notify<');
    expect(grokPart).toContain(`every hour · last ran ${utcMinute(lastRun)}`);
    expect(grokPart).toContain(`No run since ${utcMinute(lastRun)}. Check that its schedule is still on in Grok Bot.`);
  });

  test("Remove removes the wake, the page names it, and the wake's next run is refused", async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const saved = (await tool(priya, 'set_follow_through', { wake: desktop })).structuredContent?.savedWake as { wakeId: string };
    const browser = await site('priya');

    const page = await back(browser, await browser.post('/me', { action: 'remove_wake', wake: saved.wakeId }));

    expect(shown(page)).toContain('Removed the Claude Code desktop app wake. Turn its schedule off in the harness too.');
    expect(await listWakes(env.DB, 1001)).toEqual([]);
    expect(followSection(page)).toContain('No wakes.');
    const run = await call(priya, 'my_work', { wakeId: saved.wakeId });
    expect(run.isError).toBe(true);
    expect(textOf(run)).toMatch(/^Refused \(not_found\)/);
  });
});

describe("the donor's feed on /me", () => {
  test('links /@<login>/live.ndjson, which answers as the feed of every claim of theirs', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const browser = await site('priya');

    const section = followSection(await (await browser.fetch('/me')).text());
    const feed = await browser.fetch('/@priya/live.ndjson', { method: 'HEAD', headers: { 'sec-fetch-mode': 'cors' } });

    expect(section).toContain('href="/@priya/live.ndjson"');
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
  });
});

describe("a wake's trigger on /me", () => {
  const CLOUD = { harness: 'claude-code-cloud', level: 'notify', intervalMinutes: 60 };
  const URL_PASTED = 'https://api.anthropic.com/v1/claude_code/routines/trig_01SampleRoutine/fire';
  const KEY = 'sk-ant-oat01-made-up-key-for-me-tests';

  /** The page's part for the wake, by its ID. */
  function wakePart(html: string, wakeId: string): string {
    return html.split(`id="wake-${wakeId}"`)[1]?.split('</li>')[0] ?? '';
  }

  async function cloudWake(d: Donor): Promise<string> {
    return ((await tool(d, 'set_follow_through', { wake: CLOUD })).structuredContent?.savedWake as { wakeId: string }).wakeId;
  }

  test('the donor pastes the URL and key, the page shows the trigger on with its host alone, and never shows the key again', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const wakeId = await cloudWake(priya);
    const browser = await site('priya');
    const before = wakePart(await (await browser.fetch('/me')).text(), wakeId);

    const answer = await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED, key: `Bearer ${KEY}` });
    const notice = location(answer).search;
    const page = await back(browser, answer);

    expect(before).toContain('set up a trigger');
    expect(before).toMatch(/<input [^>]*type="password"[^>]*name="key"/);
    expect(shown(page)).toContain('Saved the trigger for the Claude Code cloud scheduled tasks wake. Good First Token calls api.anthropic.com when a follow-up comes, at most once in 15 minutes.');
    expect(wakePart(page, wakeId)).toContain('Trigger on, at api.anthropic.com. Not fired yet.');
    for (const never of [KEY, 'trig_01SampleRoutine']) {
      expect(page).not.toContain(never);
      expect(decodeURIComponent(notice)).not.toContain(never);
    }
    const stored = await env.DB.prepare('SELECT trigger_key, trigger_url FROM wakes WHERE id = ?').bind(wakeId).first<{ trigger_key: string; trigger_url: string }>();
    expect(stored?.trigger_url).toBe(URL_PASTED);
    expect(stored?.trigger_key).not.toContain(KEY);
    const markdown = await (await browser.fetch('/me.md')).text();
    expect(markdown).toContain('Trigger on, at api.anthropic.com.');
    expect(markdown).not.toContain(KEY);
  });

  test('the tools say a trigger is on and give its host and the page to set it up at, never its key or URL', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const saved = await tool(priya, 'set_follow_through', { wake: CLOUD });
    const wakeId = (saved.structuredContent?.savedWake as { wakeId: string }).wakeId;
    const browser = await site('priya');
    await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED, key: KEY });

    const work = await tool(priya, 'my_work', { wakeId });
    const desktop = (await tool(priya, 'set_follow_through', { wake: desktopWake })).structuredContent?.savedWake as { trigger: unknown };

    expect((saved.structuredContent?.savedWake as { trigger: unknown }).trigger).toEqual({
      state: 'none',
      host: null,
      lastFiredAt: null,
      off: null,
      setUpAt: `${ORIGIN}/me#wake-${wakeId}`,
    });
    expect(textOf(saved)).toContain(`paste its URL and key at ${ORIGIN}/me#wake-${wakeId}`);
    expect((work.structuredContent?.wake as { trigger: unknown }).trigger).toMatchObject({ state: 'on', host: 'api.anthropic.com' });
    expect(desktop.trigger).toBeNull();
    for (const answer of [work, saved]) {
      expect(JSON.stringify(answer)).not.toContain(KEY);
      expect(JSON.stringify(answer)).not.toContain('trig_01SampleRoutine');
    }
  });

  test("a URL that isn't the harness's trigger, or over plain HTTP, or no key, saves nothing, and the page says what the URL looks like", async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const wakeId = await cloudWake(priya);
    const browser = await site('priya');

    const plain = await back(browser, await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED.replace('https', 'http'), key: KEY }));
    const elsewhere = await back(browser, await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: 'https://hooks.example.net/fire', key: KEY }));
    const keyless = await back(browser, await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED, key: '  ' }));

    expect(shown(plain)).toContain('Nothing saved. The URL has to be the trigger&#x27;s own, like');
    expect(shown(plain)).toContain('https://api.anthropic.com/v1/claude_code/routines/trig_.../fire');
    expect(shown(elsewhere)).toBe(shown(plain));
    expect(shown(keyless)).toContain('Nothing saved. Paste the trigger&#x27;s key as the harness shows it.');
    expect(await env.DB.prepare('SELECT trigger_url FROM wakes WHERE id = ?').bind(wakeId).first('trigger_url')).toBeNull();
  });

  test("a wake in a harness that takes no trigger has no form, and another donor's wake changes nothing", async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const desktopId = ((await tool(priya, 'set_follow_through', { wake: desktopWake })).structuredContent?.savedWake as { wakeId: string }).wakeId;
    const cloudId = await cloudWake(priya);
    const browser = await site('priya');
    const kenji = await site('kenji');

    const desktopPart = wakePart(await (await browser.fetch('/me')).text(), desktopId);
    const onDesktop = await back(browser, await browser.post('/me', { action: 'save_trigger', wake: desktopId, url: URL_PASTED, key: KEY }));
    const theirs = await back(kenji, await kenji.post('/me', { action: 'save_trigger', wake: cloudId, url: URL_PASTED, key: KEY }));

    expect(desktopPart).not.toContain('trigger');
    expect(shown(onDesktop)).toContain('Nothing saved. A Claude Code desktop app wake can&#x27;t have a trigger.');
    expect(shown(theirs)).toContain('Nothing changed. Good First Token has no record of that wake now.');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM wakes WHERE trigger_url IS NOT NULL').first('n')).toBe(0);
  });

  test('a trigger form from another site, or with no Origin, is refused with 403 and saves nothing', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const wakeId = await cloudWake(priya);
    const browser = await site('priya');

    const elsewhere = await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED, key: KEY }, 'https://elsewhere.example');
    const none = await browser.post('/me', { action: 'save_trigger', wake: wakeId, url: URL_PASTED, key: KEY }, null);

    expect([elsewhere.status, none.status]).toEqual([403, 403]);
    expect(await env.DB.prepare('SELECT trigger_url FROM wakes WHERE id = ?').bind(wakeId).first('trigger_url')).toBeNull();
  });

  test('Turn off removes the trigger and its key, and removing the wake removes its trigger', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const first = await cloudWake(priya);
    const second = await cloudWake(priya);
    const browser = await site('priya');
    await browser.post('/me', { action: 'save_trigger', wake: first, url: URL_PASTED, key: KEY });
    await browser.post('/me', { action: 'save_trigger', wake: second, url: URL_PASTED, key: KEY });

    const off = await back(browser, await browser.post('/me', { action: 'remove_trigger', wake: first }));
    await browser.post('/me', { action: 'remove_wake', wake: second });

    expect(shown(off)).toContain('Removed the trigger from the Claude Code cloud scheduled tasks wake. Revoke its key in the harness too.');
    expect(wakePart(off, first)).toContain('No trigger.');
    const { results } = await env.DB.prepare('SELECT id, trigger_url, trigger_key FROM wakes').all();
    expect(results).toEqual([{ id: first, trigger_url: null, trigger_key: null }]);
  });

  test('a trigger Good First Token turned off shows with the step to fix it, on /me and in the next session, and one turned off by failures turns on again', async () => {
    const priya = await donor('priya');
    await openedPr(priya);
    const wrongKey = await cloudWake(priya);
    const failing = await cloudWake(priya);
    const browser = await site('priya');
    await browser.post('/me', { action: 'save_trigger', wake: wrongKey, url: URL_PASTED, key: KEY });
    await browser.post('/me', { action: 'save_trigger', wake: failing, url: URL_PASTED, key: KEY });
    await env.DB.prepare("UPDATE wakes SET trigger_on = 0, trigger_off = 'key', trigger_key = NULL WHERE id = ?").bind(wrongKey).run();
    await env.DB.prepare("UPDATE wakes SET trigger_on = 0, trigger_off = 'failures', trigger_failures = 3 WHERE id = ?").bind(failing).run();

    const page = await (await browser.fetch('/me')).text();
    const session = await tool(priya, 'start_session', { agent: 'claude-code', budget: { kind: 'until_limit' } });
    const again = await back(browser, await browser.post('/me', { action: 'trigger_on', wake: failing }));
    const notAgain = await back(browser, await browser.post('/me', { action: 'trigger_on', wake: wrongKey }));

    expect(wakePart(page, wrongKey)).toContain(
      'Trigger off. Claude Code cloud scheduled tasks refused its key. Check the trigger in Claude Code cloud scheduled tasks, make a new key for it, and paste its URL and key here.',
    );
    expect(wakePart(page, wrongKey)).not.toContain('Turn on again');
    expect(wakePart(page, failing)).toContain('Three calls in a row failed.');
    expect(wakePart(page, failing)).toContain('Turn on again');
    expect(textOf(session)).toContain('Triggers that turned off (2).');
    expect(textOf(session)).toContain(`the harness refused its key. Ask the donor to check the trigger in the harness, make a new key for it, and paste its URL and key at ${ORIGIN}/me#wake-${wrongKey}`);
    expect(shown(again)).toContain('The trigger for the Claude Code cloud scheduled tasks wake is on again.');
    expect(wakePart(again, failing)).toContain('Trigger on, at api.anthropic.com.');
    expect(shown(notAgain)).toContain('Nothing changed. Paste the trigger&#x27;s URL and key again for the Claude Code cloud scheduled tasks wake.');
  });
});
