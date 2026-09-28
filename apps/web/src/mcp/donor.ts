import {
  budgetLeft,
  claimDeadlines,
  holdsSlot,
  nextClaimState,
  toolRefusal,
  toolResult,
  type ClaimRecord,
  type ClaimState,
  type ClaimSummary,
  type Interests,
  type ProjectRecord,
  type Refusal,
  type RefusalCode,
  type SessionRecord,
  type Suggestion,
  type ToolInput,
  type ToolRefusal,
  type ToolResult,
} from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { requirePermission, type Caller } from '../auth/permissions';
import {
  blockedAmong,
  countOpenPrsByProject,
  createSession,
  editSessionQueue,
  getClaim,
  getIssue,
  getPerson,
  getProject,
  getSession,
  listClaimsOn,
  listPersonClaims,
  listWaitingIssues,
  returnSessionIssue,
  savePerson,
  setInterests as saveInterests,
  takeSessionIssue,
  type ClaimWithPr,
  type WaitingIssue,
} from '../db';
import {
  checkIssueOnGitHub,
  donorReader,
  readIssue,
  readRepoFacts,
  type GitHubIssue,
  type RepoFacts,
} from '../donor/github';
import { rankIssues, weightedOrder, type Candidate } from '../donor/pick';
import { blockedRefusal, claRefusal, openPrRefusal, vouchRefusal, type Donor } from '../donor/rules';
import { gitHubRest, gitHubUrls } from '../github';
import { findIssue } from '../issue/find';
import { closedBecause, followedCopy } from '../issue/waiting';
import { issueRoom } from '../rooms/issue-room';
import type { GitHubReader } from '../sync/github';

// The donor's tools: start_session, set_interests, suggest_issues,
// claim_issue, post_update, release_claim, and my_work. Each acts only as
// the caller, and reads GitHub only with the caller's own token. Claims go
// through the issue's room, which holds them and is the lock for the cap.
// The rules are in docs/how-it-works.md, under The donor's tools.

/** A tool's answer, as the MCP SDK takes it. */
export type Answer = CallToolResult;

function answer(result: ToolResult<unknown> | ToolRefusal): Answer {
  return { ...result };
}

function refuse(refusal: Refusal): Answer {
  return answer(toolRefusal(refusal));
}

function refusal(code: RefusalCode, message: string): Refusal {
  return { code, message };
}

/** The caller's GitHub token, from their agent's grant. */
async function tokenOf(caller: Caller): Promise<string> {
  return (await caller.gitHubToken()) ?? '';
}

const lower = (text: string) => text.toLowerCase();

function splitIssue(issue: string): { repo: string; number: number } {
  const hash = issue.lastIndexOf('#');
  return { repo: issue.slice(0, hash), number: Number(issue.slice(hash + 1)) };
}

/** The issue on GitHub, where the GitHub the Worker calls serves pages. */
function gitHubIssueUrl(issue: string): string {
  const { repo, number } = splitIssue(issue);
  return `${gitHubUrls().web}/${repo}/issues/${String(number)}`;
}

/** The issue's live page on the site. */
function liveUrl(origin: string, issue: string): string {
  const { repo, number } = splitIssue(issue);
  return `${origin}/${repo}/issues/${String(number)}`;
}

function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

/** The claim's state at `now`, with its timers applied, as its room would give it. */
function stateAt(claim: ClaimRecord, now: number): ClaimState {
  return nextClaimState(claim, { kind: 'tick' }, now).claim.state;
}

function summaryOf(claim: ClaimRecord, title: string, url: string, origin: string): ClaimSummary {
  return {
    claimId: claim.id,
    issue: claim.issue,
    title,
    url,
    liveUrl: liveUrl(origin, claim.issue),
    state: claim.state,
    agent: claim.agent,
    claimedAt: new Date(claim.claimedAt).toISOString(),
    expiresAt: iso(claimDeadlines(claim).expiresAt),
  };
}

/** The donor as the rules name them, their GitHub ID and their login now, and their saved interests. */
async function donorOf(caller: Caller): Promise<Donor & { interests: Interests | null }> {
  const person = await getPerson(env.DB, caller.githubId);
  return { githubId: caller.githubId, login: person?.login ?? caller.login, interests: person?.interests ?? null };
}

/** The caller's session, or a refusal. Someone else's session is as good as none. */
async function ownSession(caller: Caller, sessionId: string): Promise<SessionRecord | Refusal> {
  const session = await getSession(env.DB, sessionId);
  if (session?.githubId === caller.githubId) return session;
  return refusal('not_found', `There is no session ${sessionId} for you. Start one with start_session.`);
}

function isRefusal(value: object): value is Refusal {
  return 'code' in value && 'message' in value;
}

/**
 * The donor's claims that are working or paused now, newest first, with the
 * paused ones first of all. The claims table lists them, and each one's room,
 * which holds the claim, gives its state now.
 */
async function unfinishedClaims(person: number, now: number): Promise<ClaimRecord[]> {
  const unfinished = (state: ClaimState) => state === 'active' || state === 'paused';
  const listed = (await listPersonClaims(env.DB, person)).filter((claim) => unfinished(stateAt(claim, now)));
  const current = await Promise.all(
    listed.map(async (claim) => {
      const held = (await issueRoom(env.ISSUE_ROOM, claim.issue).snapshot()).claims.find((c) => c.id === claim.id);
      return held ?? claim;
    }),
  );
  return current
    .filter((claim) => unfinished(claim.state))
    .sort((a, b) => Number(b.state === 'paused') - Number(a.state === 'paused'));
}

/** Summaries of claims, each titled from its project's cached copy of the issue. */
async function summaries(claims: readonly ClaimRecord[], origin: string): Promise<ClaimSummary[]> {
  return Promise.all(
    claims.map(async (claim) => {
      const copy = await getIssue(env.DB, claim.project, claim.issue);
      return summaryOf(claim, copy?.title ?? claim.issue, gitHubIssueUrl(claim.issue), origin);
    }),
  );
}

export async function startSession(
  caller: Caller,
  input: ToolInput<'start_session'>,
  origin: string,
  now: number,
): Promise<Answer> {
  const token = await tokenOf(caller);
  const profile = await gitHubRest<{ id: number; login: string }>(token, 'GET', '/user');
  if (profile.id !== caller.githubId) throw new Error("GitHub says the grant's token is someone else's.");
  const person = await savePerson(env.DB, { githubId: caller.githubId, login: profile.login }, now);
  const session = await createSession(env.DB, { githubId: caller.githubId, agent: input.agent, budget: input.budget }, now);
  return answer(
    toolResult('start_session', {
      sessionId: session.id,
      login: person.login,
      budget: session.budget,
      interests: person.interests,
      // Maintainers' requests for changes arrive with the PR follow-ups (#17).
      followUps: [],
      unfinishedClaims: await summaries(await unfinishedClaims(caller.githubId, now), origin),
      mergedPrs: [],
    }),
  );
}

export async function setInterests(caller: Caller, input: ToolInput<'set_interests'>): Promise<Answer> {
  const person = await saveInterests(env.DB, caller.githubId, input);
  if (person === null) return refuse(refusal('not_found', 'Call start_session first, then save interests.'));
  return answer(toolResult('set_interests', { interests: person.interests ?? input }));
}

export async function myWork(caller: Caller, origin: string, now: number): Promise<Answer> {
  return answer(
    toolResult('my_work', {
      // Follow-ups arrive with #17, and work waiting to open as a PR with #16.
      followUps: [],
      readyToOpen: [],
      working: await summaries(await unfinishedClaims(caller.githubId, now), origin),
    }),
  );
}

/** The claim, found by its ID in the claims table, once the caller is the one who made it. */
async function ownClaim(caller: Caller, claimId: string): Promise<ClaimRecord | Refusal> {
  const claim = await getClaim(env.DB, claimId);
  if (claim === null) return refusal('not_found', `There is no claim ${claimId}.`);
  await requirePermission(caller, 'work_claim', { claimantGithubId: claim.githubId });
  return claim;
}

export async function postUpdate(caller: Caller, input: ToolInput<'post_update'>): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const result = await issueRoom(env.ISSUE_ROOM, claim.issue).postUpdate({
    claimId: claim.id,
    githubId: caller.githubId,
    text: input.text,
    job: input.job ?? null,
  });
  if (!result.ok) return refuse(result.refusal);
  // The result drops the room's ok, which the tool's schema doesn't list.
  return answer(toolResult('post_update', result));
}

export async function releaseClaim(caller: Caller, input: ToolInput<'release_claim'>): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const result = await issueRoom(env.ISSUE_ROOM, claim.issue).release({
    claimId: claim.id,
    githubId: caller.githubId,
    reason: input.reason,
  });
  if (!result.ok) return refuse(result.refusal);
  return answer(toolResult('release_claim', { claimId: claim.id, issue: claim.issue, state: result.claim.state }));
}

/** The refusal for a session whose budget is spent. A budget until the limit is never spent. */
function budgetSpent(session: SessionRecord): Refusal {
  const { budget } = session;
  const spent =
    budget.kind === 'issues'
      ? `${String(session.issuesClaimed)} of ${String(budget.count)} issues claimed`
      : budget.kind === 'time'
        ? `its ${String(budget.minutes)} minutes are up`
        : 'it is spent';
  return refusal(
    'budget_spent',
    `Session ${session.id} has spent its budget: ${spent}. Finish or release the claims in progress. To spend more, start a new session with start_session.`,
  );
}

// suggest_issues

/** How many suggestions come back at most. */
const SUGGESTIONS = 3;
/** How many issues one call checks on GitHub at most, so one call's reads stay few. */
const MAX_CHECKS = 8;
/** How many projects' code repos one call reads on GitHub at most. */
const MAX_REPOS = 20;
/** How many claims on an issue must end without a merged PR for it to be tough. */
export const TOUGH_AFTER = 3;

/**
 * Tough: claimed often without a merged PR. At least TOUGH_AFTER of its
 * claims ended without one, released, expired, or with their PR closed
 * without merging, and no claim's PR merged.
 */
function isTough(claims: readonly ClaimWithPr[], now: number): boolean {
  if (claims.some(({ prState }) => prState === 'merged')) return false;
  const ended = claims.filter(({ claim, prState }) => {
    const state = stateAt(claim, now);
    return state === 'released' || state === 'expired' || prState === 'closed';
  });
  return ended.length >= TOUGH_AFTER;
}

/** The first of the project's tags the labels carry, spelled as the project spells it. */
function tagOf(labels: readonly string[], project: ProjectRecord): string {
  const carried = new Set(labels.map(lower));
  return project.settings.tags.find((tag) => carried.has(lower(tag))) ?? project.settings.tags[0] ?? '';
}

export async function suggestIssues(
  caller: Caller,
  input: ToolInput<'suggest_issues'>,
  origin: string,
  now: number,
  random: () => number = Math.random,
): Promise<Answer> {
  const session = await ownSession(caller, input.sessionId);
  if (isRefusal(session)) return refuse(session);
  if (budgetLeft(session, now).spent) return refuse(budgetSpent(session));
  const donor = await donorOf(caller);
  const blocked = await blockedRefusal(env.DB, donor);
  if (blocked) return refuse(blocked);

  const [waiting, mine, openPrs] = await Promise.all([
    listWaitingIssues(env.DB, now),
    listPersonClaims(env.DB, caller.githubId),
    countOpenPrsByProject(env.DB, caller.githubId),
  ]);
  // Left out: the issues already shown, the picks waiting in the session,
  // and the issues the donor holds, which start_session offers to resume.
  const leftOut = new Set(
    [...input.exclude, ...session.queue, ...mine.filter((claim) => holdsSlot(claim, now)).map((claim) => claim.issue)].map(
      lower,
    ),
  );
  // An issue two projects keep goes to the older project, as a claim does.
  const seen = new Set<string>();
  const candidates: (Candidate & { entry: WaitingIssue })[] = [];
  for (const entry of waiting) {
    const key = lower(entry.copy.issue);
    if (leftOut.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (openPrRefusal(entry.project, openPrs.get(lower(entry.project.repo)) ?? 0) !== null) continue;
    candidates.push({
      issue: entry.copy.issue,
      project: entry.project.repo,
      title: entry.copy.title,
      labels: entry.copy.labels,
      language: entry.language,
      holding: entry.holding,
      entry,
    });
  }
  const order = weightedOrder(rankIssues(candidates, donor.interests), random);

  // In that order, each issue's project is read on GitHub with the donor's
  // token, once, and a project GitHub doesn't show them, whose code repo has
  // no commits, or whose vouch file keeps them out, is left out whole, as a
  // claim would be refused. Then each issue is checked on GitHub,
  // and one that no longer takes claims gives way to the next in the order,
  // which runs down the whole ranking.
  const reader = donorReader(await tokenOf(caller));
  const facts = new Map<string, RepoFacts | null>();
  const picked: { entry: WaitingIssue; issue: GitHubIssue }[] = [];
  let checks = 0;
  for (const { entry } of order) {
    if (picked.length === SUGGESTIONS || checks === MAX_CHECKS) break;
    const repo = lower(entry.project.repo);
    if (!facts.has(repo)) {
      if (facts.size === MAX_REPOS) continue;
      const read = await readRepoFacts(reader, entry.project.repo);
      facts.set(repo, read !== null && read.head !== null && vouchRefusal(entry.project, donor, read) === null ? read : null);
    }
    const repoFacts = facts.get(repo);
    if (!repoFacts) continue;
    checks += 1;
    const check = await checkIssueOnGitHub(reader, entry.project, entry.copy.issue, [repoFacts.name]);
    if (check.ok) picked.push({ entry, issue: check.issue });
  }

  const claims = await listClaimsOn(
    env.DB,
    picked.map(({ entry }) => entry.copy.issue),
  );
  // Claimants go by their login now. A blocked donor's claim takes its slot
  // and counts among the times claimed, but names no one, as on the issue
  // page.
  const claimantIds = [...new Set(claims.map(({ claim }) => claim.githubId))];
  const [logins, hidden] = await Promise.all([
    Promise.all(claimantIds.map(async (id) => [id, (await getPerson(env.DB, id))?.login] as const)).then(
      (pairs) => new Map(pairs),
    ),
    blockedAmong(env.DB, claimantIds),
  ]);
  const suggestions: Suggestion[] = picked.map(({ entry, issue }) => {
    const onIssue = claims.filter(({ claim }) => lower(claim.issue) === lower(entry.copy.issue));
    return {
      issue: entry.copy.issue,
      title: issue.title,
      url: issue.url || gitHubIssueUrl(entry.copy.issue),
      liveUrl: liveUrl(origin, entry.copy.issue),
      project: entry.project.repo,
      tag: tagOf(issue.labels, entry.project),
      prMode: entry.project.settings.prMode,
      claUrl: entry.project.settings.claUrl,
      claimants: onIssue
        .filter(({ claim }) => holdsSlot(claim, now) && !hidden.has(claim.githubId))
        .map(({ claim }) => ({
          login: logins.get(claim.githubId) ?? claim.login,
          agent: claim.agent,
          state: stateAt(claim, now),
        })),
      slotsTaken: onIssue.filter(({ claim }) => holdsSlot(claim, now)).length,
      slots: entry.project.settings.claimsPerIssue,
      timesClaimed: onIssue.length,
      tough: isTough(onIssue, now),
    };
  });
  return answer(toolResult('suggest_issues', { suggestions }));
}

// claim_issue

/** A claim made or resumed, with what the answer needs. */
interface Claimed {
  ok: true;
  claim: ClaimRecord;
  resumed: boolean;
  slotsTaken: number;
  slots: number;
  project: ProjectRecord;
  issue: GitHubIssue | null;
}

type Attempt = Claimed | { ok: false; refusal: Refusal };

function refused(code: RefusalCode, message: string): Attempt {
  return { ok: false, refusal: refusal(code, message) };
}

/**
 * The refusals that pass over a queued pick, which is then reported and left
 * out: it filled up, got a PR, or no longer takes claims, or its project
 * keeps the donor out. Any other refusal stops at the pick, which stays at
 * the head of the queue, like a CLA to confirm or a spent budget.
 */
const SKIPS = new Set<RefusalCode>([
  'project_not_open',
  'issue_not_eligible',
  'pr_exists',
  'issue_full',
  'not_found',
  'not_vouched',
  'open_pr_cap',
]);

function notOpen(project: ProjectRecord, issue: string): Attempt {
  const why =
    project.status === 'approved'
      ? `${project.repo} is on the do-not-list`
      : project.status === 'paused'
        ? `${project.repo} is paused`
        : `${project.repo} is ${project.status}`;
  return refused('project_not_open', `${why}, so ${issue} takes no claims. Pick another issue.`);
}

interface ClaimContext {
  donor: Donor;
  session: SessionRecord;
  reader: GitHubReader;
  /** The CLA link the donor confirmed they signed, if they did. */
  claConfirmed: string | undefined;
  now: number;
}

/**
 * Claims one issue for the donor, or resumes the claim they hold on it. The
 * checks run from the cheapest: the tagged-issue cache, the room's slots and
 * PRs, the donor's open PRs, then GitHub with the donor's token. The CLA
 * comes after them, and the room decides last, as the lock for the cap.
 */
async function claimOne(context: ClaimContext, issue: string): Promise<Attempt> {
  const { donor, session, now } = context;
  const found = await findIssue(env.DB, issue);
  if (found === null) {
    return refused('not_found', `${issue} isn't among the tagged issues of any project on Good First Token. Pick another issue.`);
  }
  const room = issueRoom(env.ISSUE_ROOM, issue);
  const snapshot = await room.snapshot();
  const holders = snapshot.claims.filter((claim) => holdsSlot(claim, now));
  const own = holders.find((claim) => claim.githubId === donor.githubId);
  if (own) {
    const project = await getProject(env.DB, own.project);
    if (project === null) return refused('not_found', `${own.project} is no longer a project on Good First Token.`);
    return {
      ok: true,
      claim: own,
      resumed: true,
      slotsTaken: holders.length,
      slots: project.settings.claimsPerIssue,
      project,
      issue: await readIssue(context.reader, own.issue),
    };
  }

  if ((await takeSessionIssue(env.DB, session.id, now)) === null) {
    return { ok: false, refusal: budgetSpent((await getSession(env.DB, session.id)) ?? session) };
  }
  let result: Attempt | undefined;
  try {
    result = await claimNew(context, issue, found.copies, holders.length, snapshot.prs[0]?.url ?? null);
    return result;
  } finally {
    // The issue counts against the budget only when a new claim was made.
    if (result === undefined || !result.ok || result.resumed) await returnSessionIssue(env.DB, session.id);
  }
}

async function claimNew(
  context: ClaimContext,
  issue: string,
  copies: NonNullable<Awaited<ReturnType<typeof findIssue>>>['copies'],
  taken: number,
  roomPr: string | null,
): Promise<Attempt> {
  const { donor, now, reader } = context;
  const issueRepo = splitIssue(issue).repo;
  const judged = await Promise.all(
    copies.map(async (copy) => ({ ...copy, closed: await closedBecause(env.DB, copy.project, copy, issueRepo) })),
  );
  const chosen = followedCopy(judged, taken);
  if (chosen === undefined) {
    return refused('issue_not_eligible', `${issue} isn't among a project's open tagged issues. Pick another issue.`);
  }
  const { project, copy } = chosen;
  if (chosen.closed === 'project') return notOpen(project, issue);
  if (chosen.closed === 'issue') {
    return refused(
      'issue_not_eligible',
      `${issue} doesn't carry a tag ${project.repo} marks work for outside help with, or carries one it keeps for people. Pick another issue.`,
    );
  }
  const pr = copy.linkedPr?.url ?? roomPr;
  if (pr !== null) return refused('pr_exists', `${issue} has an open PR, ${pr}, so it takes no new claims. Pick another issue.`);
  const slots = project.settings.claimsPerIssue;
  if (taken >= slots) {
    return refused(
      'issue_full',
      `${issue} has no open slot: ${String(taken)} of ${String(slots)} are taken. Pick another issue.`,
    );
  }

  const openPrs = (await countOpenPrsByProject(env.DB, donor.githubId)).get(lower(project.repo)) ?? 0;
  const capped = openPrRefusal(project, openPrs);
  if (capped) return { ok: false, refusal: capped };
  const facts = await readRepoFacts(reader, project.repo);
  if (facts === null) {
    return refused('project_not_open', `GitHub shows you no public repo named ${project.repo}, so ${issue} takes no claims.`);
  }
  const vouch = vouchRefusal(project, donor, facts);
  if (vouch) return { ok: false, refusal: vouch };
  const check = await checkIssueOnGitHub(reader, project, copy.issue, [facts.name]);
  if (!check.ok) return check;
  if (facts.head === null) {
    return refused('project_not_open', `${project.repo} has no commits on GitHub to start from, so ${issue} takes no claims.`);
  }
  // The CLA comes last, so a donor is asked to confirm one only for an issue
  // that would take their claim, and a queued pick that would be passed over
  // is passed over.
  const cla = await claRefusal(env.DB, project, donor, context.claConfirmed, now);
  if (cla) return { ok: false, refusal: cla };

  const result = await issueRoom(env.ISSUE_ROOM, copy.issue).claim({
    issue: copy.issue,
    project: project.repo,
    githubId: donor.githubId,
    login: donor.login,
    agent: context.session.agent,
    ownProject: facts.managed,
    startCommit: facts.head,
    slots,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    claim: result.claim,
    resumed: !result.created,
    slotsTaken: result.slotsTaken,
    slots: result.slots,
    project: (await getProject(env.DB, result.claim.project)) ?? project,
    issue: check.issue,
  };
}

/** The picks in order, each once, whatever the case of their repos, leaving out `claimed`. */
function queueOf(picks: readonly string[], claimed?: string): string[] {
  const seen = new Set(claimed === undefined ? [] : [lower(claimed)]);
  return picks.filter((pick) => {
    const key = lower(pick);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skippedText(skipped: readonly { issue: string; code: RefusalCode; message: string }[]): string {
  return skipped.map((s) => `${s.issue} (${s.code}): ${s.message}`).join('\n');
}

export async function claimIssue(
  caller: Caller,
  input: ToolInput<'claim_issue'>,
  origin: string,
  now: number,
): Promise<Answer> {
  const session = await ownSession(caller, input.sessionId);
  if (isRefusal(session)) return refuse(session);
  const donor = await donorOf(caller);
  const blocked = await blockedRefusal(env.DB, donor);
  if (blocked) return refuse(blocked);
  const context: ClaimContext = {
    donor,
    session,
    reader: donorReader(await tokenOf(caller)),
    claConfirmed: input.claConfirmed,
    now,
  };

  // Each change to the queue is an edit of the queue as it is stored then,
  // so a call at the same moment in the session keeps its own change.
  const edited =
    input.queue !== undefined || input.issue !== undefined
      ? await editSessionQueue(env.DB, session.id, (stored) => queueOf(input.queue ?? stored, input.issue))
      : session;
  let queue = (edited ?? session).queue;
  const skipped: { issue: string; code: RefusalCode; message: string }[] = [];
  let result: Attempt | undefined;
  if (input.issue !== undefined) {
    result = await claimOne(context, input.issue);
  } else {
    // The next pick is claimed only now that the agent reached it. One that
    // no longer takes the donor's claim is passed over and reported.
    const taken = new Set<string>();
    for (const next of queue) {
      // A CLA confirmation counts for the first pick reached alone, the one a
      // refusal asked about. A pick behind it has a project the donor hasn't
      // been asked about.
      const attempt = await claimOne({ ...context, claConfirmed: skipped.length === 0 ? context.claConfirmed : undefined }, next);
      if (!attempt.ok && SKIPS.has(attempt.refusal.code)) {
        skipped.push({ issue: next, code: attempt.refusal.code, message: attempt.refusal.message });
        taken.add(lower(next));
        continue;
      }
      if (attempt.ok) taken.add(lower(next));
      result = attempt;
      break;
    }
    const left = await editSessionQueue(env.DB, session.id, (stored) => stored.filter((pick) => !taken.has(lower(pick))));
    queue = left?.queue ?? [];
    if (result === undefined) {
      return refuse(
        refusal(
          'not_found',
          skipped.length === 0
            ? `No pick waits in session ${session.id}. Get suggestions with suggest_issues, then claim one.`
            : `No pick is left in session ${session.id}. Each one no longer takes your claim:\n${skippedText(skipped)}\nGet more with suggest_issues.`,
        ),
      );
    }
  }

  if (!result.ok) {
    const { code, message } = result.refusal;
    return refuse(
      refusal(code, skipped.length === 0 ? message : `${message}\nSkipped from the queue first:\n${skippedText(skipped)}`),
    );
  }
  const claim = result.claim;
  const left = budgetLeft((await getSession(env.DB, session.id)) ?? session, now);
  return answer(
    toolResult('claim_issue', {
      claim: summaryOf(claim, result.issue?.title ?? claim.issue, result.issue?.url || gitHubIssueUrl(claim.issue), origin),
      resumed: result.resumed,
      slotsTaken: result.slotsTaken,
      slots: result.slots,
      body: result.issue?.body ?? '',
      project: { repo: result.project.repo, settings: result.project.settings },
      clone: { url: `${gitHubUrls().web}/${result.project.repo}.git`, commit: claim.startCommit },
      skipped,
      queued: queue,
      budget: { issuesLeft: left.issuesLeft, endsAt: iso(left.endsAt) },
    }),
  );
}
