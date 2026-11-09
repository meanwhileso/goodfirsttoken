import {
  budgetLeft,
  claimDeadlines,
  foldIssueTitle,
  followThroughOf,
  takesTrigger,
  holdsSlot,
  MAX_FOLLOW_UPS,
  MAX_WAKES,
  nextClaimState,
  shareOnXUrl,
  toolRefusal,
  toolResult,
  type ClaimRecord,
  type ClaimState,
  type ClaimSummary,
  type FollowMode,
  type FollowUp,
  type Interests,
  type ProjectRecord,
  type RunContext,
  type Refusal,
  type RefusalCode,
  type SessionRecord,
  type Suggestion,
  type ToolInput,
  type ToolOutput,
  type ToolRefusal,
  type ToolResult,
  type WakeRecord,
} from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { requirePermission, type Caller } from '../auth/permissions';
import {
  blockedAmong,
  countRound,
  countUnshownFollowUps,
  countOpenPrsByProject,
  createSession,
  delistedProjects,
  doNotListedProjects,
  editSessionQueue,
  getClaim,
  getFollowMode,
  getWake,
  getIssue,
  giveBackLease,
  getPerson,
  getPr,
  getProject,
  getSession,
  giveToWake,
  listClaimFollowUps,
  listClaimsOn,
  listOpenPrLinksByProject,
  listEndedToOffer,
  listFollowFacts,
  listOpenPrsOf,
  listPersonClaims,
  listPrFollowModes,
  listReadInPart,
  listStoppedWakes,
  listWaitingFollowUps,
  listWaitingIssues,
  listWakes,
  markEndedOffered,
  markFollowUpsShown,
  noteFollowThrough,
  recordWakeRun,
  renewLease,
  saveFollowThrough,
  returnSessionIssue,
  savePerson,
  setInterests as saveInterests,
  sortFollowUps as sortStoredFollowUps,
  takeLease,
  takeSessionIssue,
  unknownFollowUps,
  type ClaimWithPr,
  type EndedToOffer,
  type OpenPrOf,
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
import { branchFor } from '../donor/work';
import { gitHubRest, gitHubUrls } from '../github';
import { findIssue, followedCopy, type JudgedCopy } from '../issue/find';
import { issueRoom } from '../rooms/issue-room';
import { prChecker } from '../sync/pr-checker';
import { isFollowed } from '../sync/prs';
import { ME_PATH } from '../me/paths';
import type { GitHubReader } from '../sync/github';
import plugins from '../../../../skill-src/plugins.json';
import { requestRepo as makeRequest } from '../requests/request';
import { readyToOpen } from './submit';

// The donor's tools: start_session, set_interests, suggest_issues,
// claim_issue, post_update, release_claim, my_work, check_pr,
// follow_pr, sort_follow_ups, set_follow_through, and request_repo. submit_work and
// open_pr are in ./submit.ts. Each acts only as the caller, and reads GitHub
// only with the caller's own token. Claims go through the issue's room,
// which holds them and is the lock for the cap. The rules are in
// docs/how-it-works.md, under The donor's tools.

/** A tool's answer, as the MCP SDK takes it. */
export type Answer = CallToolResult;

export function answer(result: ToolResult<unknown> | ToolRefusal): Answer {
  return { ...result };
}

export function refuse(refusal: Refusal): Answer {
  return answer(toolRefusal(refusal));
}

export function refusal(code: RefusalCode, message: string): Refusal {
  return { code, message };
}

/** The caller's GitHub token, from their agent's grant. */
export async function tokenOf(caller: Caller): Promise<string> {
  return (await caller.gitHubToken()) ?? '';
}

export const lower = (text: string) => text.toLowerCase();

function splitIssue(issue: string): { repo: string; number: number } {
  const hash = issue.lastIndexOf('#');
  return { repo: issue.slice(0, hash), number: Number(issue.slice(hash + 1)) };
}

/** The issue on GitHub, where the GitHub the Worker calls serves pages. */
export function gitHubIssueUrl(issue: string): string {
  const { repo, number } = splitIssue(issue);
  return `${gitHubUrls().web}/${repo}/issues/${String(number)}`;
}

/** The issue's live page on the site. */
export function liveUrl(origin: string, issue: string): string {
  const { repo, number } = splitIssue(issue);
  return `${origin}/${repo}/issues/${String(number)}`;
}

export function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

/** The claim's state at `now`, with its timers applied, as its room would give it. */
export function stateAt(claim: ClaimRecord, now: number): ClaimState {
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
export async function donorOf(caller: Caller): Promise<Donor & { interests: Interests | null }> {
  const person = await getPerson(env.DB, caller.githubId);
  return { githubId: caller.githubId, login: person?.login ?? caller.login, interests: person?.interests ?? null };
}

/** The caller's session, or a refusal. Someone else's session is as good as none. */
async function ownSession(caller: Caller, sessionId: string): Promise<SessionRecord | Refusal> {
  const session = await getSession(env.DB, sessionId);
  if (session?.githubId === caller.githubId) return session;
  return refusal('not_found', `There is no session ${sessionId} for you. Start one with start_session.`);
}

export function isRefusal(value: object): value is Refusal {
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

/** A claim's summary, titled from its project's cached copy of the issue. */
async function summaryFor(claim: ClaimRecord, origin: string): Promise<ClaimSummary> {
  const copy = await getIssue(env.DB, claim.project, claim.issue);
  return summaryOf(claim, copy?.title ?? claim.issue, gitHubIssueUrl(claim.issue), origin);
}

/**
 * The projects on the do-not-list among the claims', by the rule in
 * src/db/waiting.ts. Their maintainers asked Good First Token to stop, so no
 * more work goes into those claims: none is offered to resume, and resuming
 * one is refused. The donor can still post to one and release it.
 */
async function stoppedProjects(claims: readonly ClaimRecord[]): Promise<Set<string>> {
  return doNotListedProjects(
    env.DB,
    claims.map((claim) => claim.project),
  );
}

/**
 * The projects the sync delisted among the claims', with the reason GitHub
 * gave, by the rule in src/db/waiting.ts. GitHub no longer shows their repo
 * or issue repo public and open, so no more work goes into those claims, as
 * for the do-not-list, and nothing cached from the repos titles them.
 */
async function delistedAmong(claims: readonly ClaimRecord[]): Promise<Map<string, string>> {
  return delistedProjects(
    env.DB,
    claims.map((claim) => claim.project),
  );
}

export async function startSession(
  caller: Caller,
  input: ToolInput<'start_session'>,
  origin: string,
  now: number,
): Promise<Answer> {
  const person = await signedIn(caller, now);
  const session = await createSession(env.DB, { githubId: caller.githubId, agent: input.agent, budget: input.budget }, now);
  const followUps = await followUpsFor(caller.githubId);
  const readInPart = await listReadInPart(env.DB, caller.githubId);
  const unfinishedClaims = await offeredToResume(caller.githubId, origin, now);
  const ended = await listEndedToOffer(env.DB, caller.githubId);
  const modes = await followModesOf(caller.githubId);
  const open = await listOpenPrsOf(env.DB, caller.githubId);
  const followThrough = await followThroughFor(caller.githubId, modes, open, { level: null, newForWake: new Set() }, now);
  const openPrs = openPrsOf(open, modes, followThrough);
  const stoppedWakes = (await listStoppedWakes(env.DB, caller.githubId, now)).map((each) => wakeOut(each, origin));
  const wakes = (await listWakes(env.DB, caller.githubId)).map((each) => wakeOut(each, origin));
  const resultWith = (offered: readonly EndedToOffer[]) =>
    toolResult('start_session', {
      sessionId: session.id,
      login: person.login,
      budget: session.budget,
      interests: person.interests,
      followUps: followUps.followUps,
      moreFollowUps: followUps.moreFollowUps,
      readInPart,
      unfinishedClaims,
      endedPrs: offered.map(endedPrOf),
      openPrs,
      followMode: modes.choice,
      stoppedWakes,
      wakes,
      followThrough,
      skillUpdate: skillUpdateFor(input.skillVersion),
    });
  const result = resultWith(ended);
  // Marked only once the answer is made, so an answer that fails leaves the
  // follow-ups unshown, for a submit not to answer, and the ended PRs for
  // the next session to offer.
  await followUps.markShown(now);
  const taken = await markEndedOffered(
    env.DB,
    ended.map((pr) => pr.claimId),
    now,
  );
  // A session that started at the same moment marked the others first, and offers them.
  return answer(taken.size === ended.length ? result : resultWith(ended.filter((pr) => taken.has(pr.claimId))));
}

/** The caller as GitHub gives them now, with their own token, recorded under People. */
async function signedIn(caller: Caller, now: number) {
  const profile = await gitHubRest<{ id: number; login: string }>(await tokenOf(caller), 'GET', '/user');
  if (profile.id !== caller.githubId) throw new Error("GitHub says the grant's token is someone else's.");
  return savePerson(env.DB, { githubId: caller.githubId, login: profile.login }, now);
}

/** The donor's mode for all their PRs, and the mode of each PR that has its own. */
interface FollowModes {
  choice: { mode: FollowMode; chosen: boolean };
  own: Map<string, 'go_ahead' | 'ask_first' | 'off'>;
  /** How the claim's PR is followed: its own mode, or else the donor's. */
  of: (claimId: string) => 'go_ahead' | 'ask_first' | 'off';
}

async function followModesOf(person: number): Promise<FollowModes> {
  const [choice, own] = await Promise.all([getFollowMode(env.DB, person), listPrFollowModes(env.DB, person)]);
  return { choice, own, of: (claimId) => own.get(claimId) ?? choice.mode };
}

/**
 * The donor's open PRs, as start_session and my_work list them, each with
 * how it is followed: the stalled ones first, then oldest first.
 */
function openPrsOf(open: readonly OpenPrOf[], modes: FollowModes, followThrough: FollowThroughOut) {
  const stalled = new Set(followThrough.prs.filter((pr) => pr.state === 'stalled').map((pr) => pr.claimId));
  const listed = open.map((pr) => ({ ...pr, followMode: modes.of(pr.claimId) }));
  return [...listed.filter((pr) => stalled.has(pr.claimId)), ...listed.filter((pr) => !stalled.has(pr.claimId))];
}

type FollowThroughOut = ToolOutput<'my_work'>['followThrough'];

/**
 * Follow-through across the donor's open PRs, as listOpenPrsOf lists
 * them, for the run asking at `now`, by the rules in packages/core's
 * followThroughOf.
 */
async function followThroughFor(
  person: number,
  modes: FollowModes,
  open: readonly OpenPrOf[],
  run: RunContext,
  now: number,
): Promise<FollowThroughOut> {
  const facts = new Map((await listFollowFacts(env.DB, person)).map((pr) => [pr.claimId, pr]));
  const listed = open.flatMap((pr) => {
    const found = facts.get(pr.claimId);
    return found === undefined ? [] : [{ pr, facts: found }];
  });
  const byClaim = new Map(listed.map((one) => [one.pr.claimId, one]));
  const ft = followThroughOf(
    listed.map((one) => ({ ...one.facts, mode: modes.of(one.pr.claimId) })),
    run,
    now,
  );
  return {
    dueNow: ft.dueNow,
    nextCheckAt: iso(ft.nextCheckAt),
    prs: ft.prs.flatMap((pr) => {
      const one = byClaim.get(pr.claimId);
      if (one === undefined) return [];
      return [
        {
          claimId: pr.claimId,
          issue: one.pr.issue,
          pr: one.pr.pr,
          followMode: modes.of(pr.claimId),
          state: pr.state,
          due: pr.due,
          reportOnly: pr.reportOnly,
          open: one.facts.open,
          waitingDonor: one.facts.waitingDonor,
          lease: pr.lease === null ? null : { runId: pr.lease.runId, until: new Date(pr.lease.until).toISOString() },
          rounds: pr.rounds,
          roundLimit: pr.roundLimit,
          botLimit: pr.botLimit,
          lastPushAt: iso(one.facts.lastPushAt),
          lastReviewerActivityAt: iso(one.facts.lastReviewerAt),
          nextCheckAt: iso(pr.nextCheckAt),
          schedule: pr.schedule,
          stalledSince: iso(pr.stalledSince),
          tellDonorWaiting: pr.tellDonorWaiting,
          waitingToldAt: iso(pr.waitingToldAt),
          reviewAskedAt: iso(pr.reviewAskedAt),
        },
      ];
    }),
  };
}

/** Where on /me the donor saves a wake's trigger: the wake's own place on the page. */
export function triggerSetUpUrl(origin: string, wakeId: string): string {
  return `${origin}${ME_PATH}#wake-${wakeId}`;
}

/**
 * A wake's trigger as the tools give it, never its key, or null for a wake
 * whose harness takes none or that runs only in a session.
 */
function triggerOut(wake: WakeRecord, origin: string) {
  if (!takesTrigger(wake.harness) || wake.level === 'session') return null;
  const trigger = wake.trigger;
  return {
    state: trigger === null ? ('none' as const) : trigger.on ? ('on' as const) : ('off' as const),
    host: trigger?.host ?? null,
    lastFiredAt: iso(trigger?.firedAt ?? null),
    off: trigger === null || trigger.on ? null : (trigger.off ?? 'failures'),
    setUpAt: triggerSetUpUrl(origin, wake.id),
  };
}

/** A wake as the tools give it. */
function wakeOut(wake: WakeRecord, origin: string) {
  return {
    wakeId: wake.id,
    harness: wake.harness,
    level: wake.level,
    intervalMinutes: wake.intervalMinutes,
    createdAt: new Date(wake.createdAt).toISOString(),
    lastRunAt: iso(wake.lastRunAt),
    trigger: triggerOut(wake, origin),
  };
}

/**
 * Whether a newer donor skill is out than the one that started the session,
 * against the version this server was built with, from skill-src/. A skill
 * that sends no version is older than the field, so it is told too.
 */
function skillUpdateFor(yours: string | undefined): ToolOutput<'start_session'>['skillUpdate'] {
  const latest = plugins.goodfirsttoken.version;
  if (yours === undefined) return { latest, yours: null };
  return compareVersions(yours, latest) < 0 ? { latest, yours } : null;
}

/** Compares two versions like 0.6.7, part by part. */
function compareVersions(a: string, b: string): number {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    const diff = (pa?.[i] ?? 0) - (pb?.[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * What maintainers and review bots wrote on the donor's open PRs, and their
 * failed checks and conflicts, that are open or wait for the donor, as
 * start_session and my_work list them, and how many more wait.
 * `markShown` marks the ones listed shown, once the answer is made, or
 * only those on the claims `onClaim` names. A submit to the claim with no
 * `answers` settles the ones shown before it.
 * Only a follow-up submit_work could take a fix for shows: its PR open,
 * its project asking for help, and the donor not blocked.
 */
async function followUpsFor(
  person: number,
): Promise<{
  followUps: FollowUp[];
  moreFollowUps: number;
  markShown: (now: number, onClaim?: (claimId: string) => boolean) => Promise<void>;
}> {
  const { followUps: waiting, waiting: all } = await listWaitingFollowUps(env.DB, person, MAX_FOLLOW_UPS);
  const titles = new Map<string, string>();
  for (const { project, issue } of waiting) {
    if (!titles.has(lower(issue))) titles.set(lower(issue), (await getIssue(env.DB, project, issue))?.title ?? issue);
  }
  const markShown = (now: number, onClaim: (claimId: string) => boolean = () => true) =>
    markFollowUpsShown(
      env.DB,
      waiting.flatMap(({ record }) => (onClaim(record.claimId) ? [{ claimId: record.claimId, commentId: record.commentId }] : [])),
      now,
    );
  const followUps = waiting.map(({ record, issue, pr, branch }) => ({
    claimId: record.claimId,
    followUpId: record.commentId,
    issue,
    title: titles.get(lower(issue)) ?? issue,
    pr,
    kind: record.kind,
    reviewer: record.reviewer,
    authorKind: record.authorKind,
    comment: record.body,
    path: record.path,
    commentUrl: record.url,
    writtenAt: new Date(record.writtenAt).toISOString(),
    branch,
    // Only open ones and those that wait for the donor list.
    state: record.state === 'waiting_donor' ? ('waiting_donor' as const) : ('open' as const),
    question: record.question,
  }));
  return { followUps, moreFollowUps: all - followUps.length, markShown };
}

/**
 * A donor's PR that merged or closed without merging, as start_session
 * offers it. A merged one comes with a pre-filled X post link. Nothing is
 * posted for the donor.
 */
function endedPrOf({ issue, title, pr, outcome, agent }: EndedToOffer) {
  return {
    issue,
    // The PR's title, which can be the issue's own, folded as every title a tool shows is.
    title: title === null ? issue : foldIssueTitle(title),
    pr,
    outcome,
    shareUrl: outcome === 'merged' ? shareOnXUrl({ pr, agent }) : null,
  };
}

/** The donor's unfinished claims that can go on, for start_session to offer. */
async function offeredToResume(person: number, origin: string, now: number): Promise<ClaimSummary[]> {
  const claims = await unfinishedClaims(person, now);
  const [stopped, delisted] = await Promise.all([stoppedProjects(claims), delistedAmong(claims)]);
  const goesOn = (claim: ClaimRecord) => !stopped.has(lower(claim.project)) && !delisted.has(lower(claim.project));
  return Promise.all(claims.filter(goesOn).map((claim) => summaryFor(claim, origin)));
}

export async function setInterests(caller: Caller, input: ToolInput<'set_interests'>): Promise<Answer> {
  const person = await saveInterests(env.DB, caller.githubId, input);
  if (person === null) return refuse(refusal('not_found', 'Call start_session first, then save interests.'));
  return answer(toolResult('set_interests', { interests: person.interests ?? input }));
}

/**
 * my_work. A call with a wake's ID gives the wake the follow-ups it lists
 * that the wake wasn't given, on PRs the donor still follows, and records
 * the wake's run once the answer is made, so a run that fails leaves the
 * wake to show as stopped. A run that only reports marks no follow-up
 * shown, so a submit with no answers can't settle one the donor never saw:
 * a notify wake marks none, and a full or session wake marks only those
 * on PRs that follow go_ahead. A call with no wake ID is a session the
 * donor is in, and marks every one it lists.
 */
export async function myWork(caller: Caller, input: ToolInput<'my_work'>, origin: string, now: number): Promise<Answer> {
  const wake = input.wakeId === undefined ? null : await getWake(env.DB, caller.githubId, input.wakeId);
  if (input.wakeId !== undefined && wake === null) {
    return refuse(
      refusal(
        'not_found',
        `There is no wake ${input.wakeId} for you, so nothing is listed. It may have been removed. Tell the donor to turn its schedule off in the harness.`,
      ),
    );
  }
  // The login as the donor's last sign-in or session recorded it, so a run
  // reads GitHub no more than before. A run checks it against gh api user.
  const { login } = await donorOf(caller);
  // Every unfinished claim is the donor's own record, so each is listed, and
  // one on a project on the do-not-list says to release it.
  const claims = await unfinishedClaims(caller.githubId, now);
  const [stopped, delisted] = await Promise.all([stoppedProjects(claims), delistedAmong(claims)]);
  const working = await Promise.all(
    claims.map(async (claim) => {
      const gone = delisted.get(lower(claim.project));
      const reason = stopped.has(lower(claim.project))
        ? `${claim.project} is on the do-not-list, since its maintainers asked Good First Token to stop. Release the claim with release_claim.`
        : gone === undefined
          ? null
          : `${gone} So the claim can't go on. Release it with release_claim.`;
      // A delisted project's claim goes by its issue alone, with no cached title.
      const summary =
        gone === undefined ? await summaryFor(claim, origin) : summaryOf(claim, claim.issue, gitHubIssueUrl(claim.issue), origin);
      return { ...summary, resumable: reason === null, reason };
    }),
  );
  const followUps = await followUpsFor(caller.githubId);
  const modes = await followModesOf(caller.githubId);
  const readInPart = await listReadInPart(env.DB, caller.githubId);
  const ready = await readyToOpen(caller, origin, now);
  const open = await listOpenPrsOf(env.DB, caller.githubId);
  // This run is the wake's latest, so the wake isn't among those that stopped.
  const stoppedWakes = (await listStoppedWakes(env.DB, caller.githubId, now)).filter((stoppedWake) => stoppedWake.id !== wake?.id);
  const followed = followUps.followUps
    .filter((followUp) => modes.of(followUp.claimId) !== 'off')
    .map((followUp) => ({ claimId: followUp.claimId, followUpId: followUp.followUpId }));
  // Given in one statement, so two runs of the wake at once don't both
  // report one. The same run's next call is given its own again.
  // A run with no ID yet gets one no other run has, so two runs of a wake
  // that start at once never share a lease or newForWake.
  const runId = input.runId ?? `run-${crypto.randomUUID()}`;
  const newForWake = wake === null ? null : await giveToWake(env.DB, wake.id, followed, now, runId);
  const followThrough = await followThroughFor(
    caller.githubId,
    modes,
    open,
    { level: wake?.level ?? null, newForWake: new Set((newForWake ?? []).map((given) => given.claimId)) },
    now,
  );
  const openPrs = openPrsOf(open, modes, followThrough);
  const result = toolResult('my_work', {
    login,
    runId,
    followUps: followUps.followUps,
    moreFollowUps: followUps.moreFollowUps,
    readInPart,
    readyToOpen: ready,
    working,
    openPrs,
    followMode: modes.choice,
    wake: wake === null ? null : wakeOut({ ...wake, lastRunAt: Math.max(wake.lastRunAt ?? now, now) }, origin),
    newForWake,
    stoppedWakes: stoppedWakes.map((each) => wakeOut(each, origin)),
    // The wake this run is shows the run, as recorded once the answer is made.
    wakes: (await listWakes(env.DB, caller.githubId)).map((each) =>
      wakeOut(each.id === wake?.id ? { ...each, lastRunAt: Math.max(each.lastRunAt ?? now, now) } : each, origin),
    ),
    followThrough,
  });
  // Marked, and the run recorded, only once the answer is made.
  if (wake === null) await followUps.markShown(now);
  else if (wake.level !== 'notify') await followUps.markShown(now, (claimId) => modes.of(claimId) === 'go_ahead');
  if (wake !== null) await recordWakeRun(env.DB, caller.githubId, wake.id, now);
  return answer(result);
}

/** What set_follow_through made of a change, or why it changed nothing. */
export type FollowThroughSet = { ok: true; value: ToolOutput<'set_follow_through'> } | { ok: false; refusal: Refusal };

/**
 * set_follow_through: saves the donor's mode for all their PRs or one,
 * saves or removes their wakes, and lets a PR go on past its round limits
 * once the donor says to. Every check comes first, and the change is made
 * in one batch, so a refusal changes nothing. A PR takes a mode, or goes
 * on, only while it is open, on the donor's own claim. A wake is removed
 * only when it is the donor's. /me's forms make their changes through this
 * too (src/me/page.ts). Another donor's claim throws PermissionRefused.
 */
export async function setFollowThroughAs(
  caller: Caller,
  input: ToolInput<'set_follow_through'>,
  now: number,
  origin: string,
): Promise<FollowThroughSet> {
  const refused = (why: Refusal): FollowThroughSet => ({ ok: false, refusal: why });
  if ((await getPerson(env.DB, caller.githubId)) === null) {
    return refused(refusal('not_found', 'Call start_session first, then save follow-through.'));
  }
  if (input.claimId !== undefined) {
    const claim = await ownClaim(caller, input.claimId);
    if (isRefusal(claim)) return refused(claim);
    const pr = await getPr(env.DB, claim.id);
    if (pr === null) {
      return refused(
        refusal('not_found', `Claim ${claim.id} has no PR recorded, so it has no PR to follow. Once its PR is open on GitHub, record it with record_pr. Nothing changed.`),
      );
    }
    if (pr.state !== 'open') {
      const ended = pr.state === 'merged' ? 'merged' : 'closed without merging';
      return refused(refusal('pr_closed', `Claim ${claim.id}'s PR, ${pr.pr.url}, ${ended}, so there is nothing to follow. Nothing changed.`));
    }
  }
  const wakes = await listWakes(env.DB, caller.githubId);
  if (input.removeWake !== undefined && !wakes.some((wake) => wake.id === input.removeWake)) {
    return refused(refusal('not_found', `There is no wake ${input.removeWake} for you, so nothing changed.`));
  }
  const full = refusal(
    'rate_limited',
    `The donor has ${String(MAX_WAKES)} wakes, the most one donor keeps, so nothing changed. Remove one with removeWake in the same call.`,
  );
  const kept = wakes.length - (input.removeWake === undefined ? 0 : 1);
  if (input.wake !== undefined && kept >= MAX_WAKES) return refused(full);
  const changed = await saveFollowThrough(
    env.DB,
    caller.githubId,
    {
      mode: input.mode === undefined ? undefined : { mode: input.mode, claimId: input.claimId },
      remove: input.removeWake,
      save: input.wake,
      goOn: input.goOn === undefined ? undefined : input.claimId,
    },
    now,
  );
  // Another call saved a wake meanwhile and took the last place, so the batch changed nothing.
  if (input.wake !== undefined && changed.saved === null) return refused(full);
  const modes = await followModesOf(caller.githubId);
  const prs = (await listOpenPrsOf(env.DB, caller.githubId)).map((open) => ({
    claimId: open.claimId,
    issue: open.issue,
    pr: open.pr,
    followMode: modes.of(open.claimId),
    own: modes.own.has(open.claimId),
  }));
  return {
    ok: true,
    value: {
      followMode: modes.choice,
      prs,
      savedWake: changed.saved === null ? null : wakeOut(changed.saved, origin),
      removedWake: changed.removed ? (input.removeWake ?? null) : null,
      wentOn: changed.wentOn ? (input.claimId ?? null) : null,
      wakes: (await listWakes(env.DB, caller.githubId)).map((each) => wakeOut(each, origin)),
    },
  };
}

/** set_follow_through, as setFollowThroughAs makes the change. */
export async function setFollowThrough(
  caller: Caller,
  input: ToolInput<'set_follow_through'>,
  origin: string,
  now: number,
): Promise<Answer> {
  const set = await setFollowThroughAs(caller, input, now, origin);
  return set.ok ? answer(toolResult('set_follow_through', set.value)) : refuse(set.refusal);
}

/**
 * Reads a claim's PR on GitHub now, with the service token, when the
 * donor's agent read on GitHub with the donor's account that it changed.
 * The agent's word decides only that a read is worth making. What is
 * recorded is what the read finds, through the one checker for the whole
 * site (src/sync/pr-checker.ts), which holds the global limits. A merged PR
 * never changes, and one closed more than 14 days ago is no longer read, so
 * neither is read. A PR that merged or closed and that no session offered
 * yet is offered here, once. The follow-ups it counts are those my_work
 * would list that no tool showed yet.
 */
export async function checkPr(caller: Caller, input: ToolInput<'check_pr'>, now: () => number = Date.now): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const blocked = await blockedRefusal(env.DB, await donorOf(caller));
  if (blocked) return refuse(blocked);
  const before = await getPr(env.DB, claim.id);
  if (before === null) {
    return refuse(
      refusal('not_found', `Claim ${claim.id} has no PR recorded. Once its PR is open on GitHub, record it with record_pr.`),
    );
  }
  // The run's own lease is renewed, and this call is its check.
  if (input.runId !== undefined) await renewLease(env.DB, claim.id, input.runId, now(), true);
  // A merged PR never changes, and one closed more than 14 days ago is no
  // longer read, so neither is read now.
  const read = isFollowed(before, now()) ? await prChecker(env.PR_CHECKER).check(claim.id, caller.githubId) : 'final';
  const after = (await getPr(env.DB, claim.id)) ?? before;
  const newFollowUps = await countUnshownFollowUps(env.DB, claim.id);
  const ended = after.state === 'open' ? [] : (await listEndedToOffer(env.DB, caller.githubId)).filter((pr) => pr.claimId === claim.id);
  const followThrough = await followThroughFor(
    caller.githubId,
    await followModesOf(caller.githubId),
    await listOpenPrsOf(env.DB, caller.githubId),
    { level: null, runId: input.runId, newForWake: new Set() },
    now(),
  );
  const result = (offered: readonly EndedToOffer[]) =>
    toolResult('check_pr', {
      claimId: claim.id,
      issue: claim.issue,
      pr: after.pr,
      state: after.state,
      read,
      newFollowUps,
      endedPr: offered.length > 0 ? endedPrOf(offered[0] as EndedToOffer) : null,
      followThrough,
    });
  const answered = result(ended);
  // Marked once the answer is made, as start_session marks them. A session
  // that marked it first offers it there instead.
  const taken = await markEndedOffered(
    env.DB,
    ended.map((pr) => pr.claimId),
    now(),
  );
  return answer(taken.size === ended.length ? answered : result([]));
}

/**
 * sort_follow_ups: sets where the named follow-ups on the caller's claim
 * stand, as the agent sorted them. Every ID must name a follow-up on the
 * claim, or nothing changes. A follow-up a submit settled as fixed, or a
 * read superseded, stays as it is. The claim's PR must be open, as it is
 * for its follow-ups to list.
 */
export async function sortFollowUps(caller: Caller, input: ToolInput<'sort_follow_ups'>, now: number): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const blocked = await blockedRefusal(env.DB, await donorOf(caller));
  if (blocked) return refuse(blocked);
  const pr = await getPr(env.DB, claim.id);
  if (pr === null) {
    return refuse(refusal('not_found', `Claim ${claim.id} has no PR recorded, so it has no follow-ups. Once its PR is open on GitHub, record it with record_pr.`));
  }
  if (pr.state !== 'open') {
    const ended = pr.state === 'merged' ? 'merged' : 'closed without merging';
    return refuse(refusal('pr_closed', `Claim ${claim.id}'s PR, ${pr.pr.url}, ${ended}, so its follow-ups need nothing more. Nothing changed.`));
  }
  const ids = input.followUps.map((sort) => sort.followUpId);
  const unknown = await unknownFollowUps(env.DB, claim.id, ids);
  if (unknown.length > 0) {
    return refuse(
      refusal('not_found', `Claim ${claim.id} has no follow-up ${unknown.join(', ')}, so nothing changed. Sort the follow-ups start_session or my_work lists, by their IDs.`),
    );
  }
  const before = new Map((await listClaimFollowUps(env.DB, claim.id)).map((record) => [record.commentId, record]));
  const changed = await sortStoredFollowUps(env.DB, claim.id, input.followUps, now);
  const byId = new Map((await listClaimFollowUps(env.DB, claim.id)).map((record) => [record.commentId, record]));
  // A sort that records a new reply's link, whatever its state, is a reply
  // in its run's round, when the run names itself and holds the PR's live
  // lease. A sort with no link, or the link recorded before, is no reply.
  const replies = input.followUps.flatMap((sort) => {
    const record = byId.get(sort.followUpId);
    const was = before.get(sort.followUpId);
    const fresh = sort.replyUrl !== undefined && changed.has(sort.followUpId) && was?.replyUrl !== sort.replyUrl;
    return fresh && record !== undefined ? [record] : [];
  });
  if (replies.length > 0 && input.runId !== undefined) {
    await countRound(env.DB, claim.id, input.runId, { push: false, bot: replies.some((record) => record.authorKind === 'bot') }, now);
  }
  const followUps = ids.flatMap((key) => {
    const record = byId.get(key);
    return record === undefined
      ? []
      : [
          {
            followUpId: key,
            kind: record.kind,
            state: record.state,
            outcome: record.outcome,
            question: record.question,
            replyUrl: record.replyUrl,
            changed: changed.has(key),
          },
        ];
  });
  return answer(toolResult('sort_follow_ups', { claimId: claim.id, issue: claim.issue, pr: pr.pr, followUps }));
}

/**
 * follow_pr: takes or gives back the lease on the caller's claim's open PR
 * for the run that names itself, so one agent follows a PR at a time. A
 * lease another run holds stays, and the answer says until when. The
 * lease is taken in one statement, so two runs at once never both hold it.
 */
export async function followPr(caller: Caller, input: ToolInput<'follow_pr'>, now: number): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const blocked = await blockedRefusal(env.DB, await donorOf(caller));
  if (blocked) return refuse(blocked);
  const pr = await getPr(env.DB, claim.id);
  if (pr === null) {
    return refuse(refusal('not_found', `Claim ${claim.id} has no PR recorded, so it has no lease. Once its PR is open on GitHub, record it with record_pr.`));
  }
  const closed = refusal(
    'pr_closed',
    `Claim ${claim.id}'s PR, ${pr.pr.url}, ${pr.state === 'merged' ? 'merged' : 'closed without merging'}, so there is nothing to follow. No lease was taken.`,
  );
  let lease: 'held' | 'following' | 'given_back';
  let until: number | null;
  if (input.action === 'take') {
    if (pr.state !== 'open') return refuse(closed);
    const took = await takeLease(env.DB, claim.id, input.runId, now);
    // The PR merged or closed since it was read.
    if (took === null) {
      const ended = (await getPr(env.DB, claim.id))?.state === 'merged' ? 'merged' : 'closed without merging';
      return refuse(refusal('pr_closed', `Claim ${claim.id}'s PR, ${pr.pr.url}, ${ended}, so there is nothing to follow. No lease was taken.`));
    }
    lease = took.taken ? 'held' : 'following';
    until = took.lease?.until ?? null;
  } else {
    // What the run did once is recorded whether or not it still held the lease.
    await noteFollowThrough(env.DB, claim.id, input.noted ?? [], now);
    const back = await giveBackLease(env.DB, claim.id, input.runId);
    const other = back.lease !== null && back.lease.until > now ? back.lease : null;
    lease = other === null ? 'given_back' : 'following';
    until = other?.until ?? null;
  }
  const followThrough = await followThroughFor(
    caller.githubId,
    await followModesOf(caller.githubId),
    await listOpenPrsOf(env.DB, caller.githubId),
    { level: null, runId: input.runId, newForWake: new Set() },
    now,
  );
  return answer(
    toolResult('follow_pr', {
      claimId: claim.id,
      issue: claim.issue,
      pr: pr.pr,
      runId: input.runId,
      lease,
      until: iso(until),
      followThrough: followThrough.prs.find((one) => one.claimId === claim.id) ?? null,
    }),
  );
}

/**
 * request_repo: records the caller's request for a repo, or withdraws it,
 * through the request the site makes too (src/requests/request.ts).
 */
export async function requestRepo(caller: Caller, input: ToolInput<'request_repo'>, origin: string, now: number): Promise<Answer> {
  const made = await makeRequest(env.DB, caller, input, origin, now);
  if (isRefusal(made)) return refuse(made);
  return answer(toolResult('request_repo', made));
}

/** The claim, found by its ID in the claims table, once the caller is the one who made it. */
export async function ownClaim(caller: Caller, claimId: string): Promise<ClaimRecord | Refusal> {
  const claim = await getClaim(env.DB, claimId);
  if (claim === null) return refusal('not_found', `There is no claim ${claimId}.`);
  await requirePermission(caller, 'work_claim', { claimantGithubId: claim.githubId });
  return claim;
}

export async function postUpdate(caller: Caller, input: ToolInput<'post_update'>, now: number = Date.now()): Promise<Answer> {
  const claim = await ownClaim(caller, input.claimId);
  if (isRefusal(claim)) return refuse(claim);
  const result = await issueRoom(env.ISSUE_ROOM, claim.issue).postUpdate({
    claimId: claim.id,
    githubId: caller.githubId,
    text: input.text,
    job: input.job ?? null,
  });
  if (!result.ok) return refuse(result.refusal);
  // The run's own lease on the claim's PR is renewed.
  if (input.runId !== undefined) await renewLease(env.DB, claim.id, input.runId, now, false);
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

type Suggestions = ToolOutput<'suggest_issues'>;

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
    listOpenPrLinksByProject(env.DB, caller.githubId),
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
  // The projects left out for the open-PR cap, which the answer names with
  // the donor's open PRs there, so an empty list says why.
  const atCap = new Map<string, Suggestions['atCap'][number]>();
  for (const entry of waiting) {
    const key = lower(entry.copy.issue);
    if (leftOut.has(key) || seen.has(key)) continue;
    seen.add(key);
    const repo = lower(entry.project.repo);
    const prs = openPrs.get(repo) ?? [];
    if (openPrRefusal(entry.project, prs.length) !== null) {
      if (!atCap.has(repo)) {
        atCap.set(repo, { project: entry.project.repo, openPrs: prs.length, cap: entry.project.settings.openPrsPerDonor, prs });
      }
      continue;
    }
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

  // The walk draws each issue as it goes. Each issue's project is read on
  // GitHub with the donor's token, once, and a project GitHub doesn't show
  // them, whose code repo has no commits, or whose vouch file keeps them
  // out, is left out whole, as a claim would be refused. Then each issue is
  // checked on GitHub, and one that no longer takes claims gives way to the
  // next draw, which can reach the whole ranking.
  const reader = donorReader(await tokenOf(caller));
  const facts = new Map<string, RepoFacts | null>();
  const picked: { entry: WaitingIssue; issue: GitHubIssue }[] = [];
  let checks = 0;
  for (const { entry } of order) {
    const repo = lower(entry.project.repo);
    if (!facts.has(repo)) {
      if (facts.size === MAX_REPOS) continue;
      const read = await readRepoFacts(reader, entry.project.repo);
      facts.set(repo, read !== null && read.head !== null && vouchRefusal(entry.project, donor, read) === null ? read : null);
    }
    const repoFacts = facts.get(repo);
    if (!repoFacts) continue;
    checks += 1;
    const check = await checkIssueOnGitHub(env.DB, reader, entry.project, entry.copy.issue, [repoFacts.name]);
    if (check.ok) picked.push({ entry, issue: check.issue });
    // Stopping here draws no issue the walk won't use.
    if (picked.length === SUGGESTIONS || checks === MAX_CHECKS) break;
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
  return answer(toolResult('suggest_issues', { suggestions, atCap: [...atCap.values()] }));
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
  /** The donor can push to the code repo, so the claim's branch goes there, and else in their fork. */
  canPush: boolean;
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

async function notOpen(project: ProjectRecord, issue: string): Promise<Attempt> {
  // An approved project takes no claims when it is on the do-not-list, or
  // when the sync delisted it, which says why.
  const gone =
    project.status === 'approved' ? (await delistedProjects(env.DB, [project.repo])).get(lower(project.repo)) : undefined;
  if (gone !== undefined) return refused('project_not_open', `${gone} So ${issue} takes no claims. Pick another issue.`);
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
    // The refusal a project not asking for help gets, since no more work
    // goes into a claim on a project on the do-not-list, or one the sync
    // delisted.
    if ((await stoppedProjects([own])).size > 0) {
      return refused(
        'project_not_open',
        `${own.project} is on the do-not-list, so your claim on ${issue} can't go on. Release it with release_claim.`,
      );
    }
    const gone = (await delistedAmong([own])).get(lower(own.project));
    if (gone !== undefined) {
      return refused('project_not_open', `${gone} So your claim on ${issue} can't go on. Release it with release_claim.`);
    }
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
      canPush: (await readRepoFacts(context.reader, project.repo))?.writer ?? false,
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
  copies: readonly JudgedCopy[],
  taken: number,
  roomPr: string | null,
): Promise<Attempt> {
  const { donor, now, reader } = context;
  // Each copy comes judged by the rule the homepage counts with, less the
  // slots and PRs, which the room holds.
  const chosen = followedCopy(copies, taken);
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
  const check = await checkIssueOnGitHub(env.DB, reader, project, copy.issue, [facts.name]);
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
    canPush: facts.writer,
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
      // A CLA confirmation names its link, so it counts for any pick whose
      // project keeps its CLA there, which is the one the donor signed.
      const attempt = await claimOne(context, next);
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
      branch: { name: branchFor(claim), canPush: result.canPush },
      skipped,
      queued: queue,
      budget: { issuesLeft: left.issuesLeft, endsAt: iso(left.endsAt) },
    }),
  );
}
