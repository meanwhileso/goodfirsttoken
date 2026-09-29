import { newClaim, nextClaimState, type ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import {
  addCandidate,
  addPr,
  blockDonor,
  createProject,
  getBlock,
  getClaim,
  listIssueClaims,
  markEndedOffered,
  rereadDone,
  saveClaim,
  saveIssues,
  savePerson,
  setPrState,
} from '../db';
import { issueRoom } from '../rooms/issue-room';
import { devOnlyRequest } from './gate';
import {
  SAMPLE_BLOCKED,
  SAMPLE_CANDIDATES,
  SAMPLE_CLAIMS,
  SAMPLE_HISTORY,
  SAMPLE_PEOPLE,
  SAMPLE_PROJECTS,
  type SampleClaim,
  type SampleHistory,
} from './sample-work';

// POST /dev/seed, in local development only: gives the local site the sample
// projects and work in ./sample-work.ts, so `pnpm dev` shows a homepage with
// something on it. `pnpm seed` calls it. The route exists only in
// development, and only for a request to this machine by a loopback
// hostname, the gate in ./gate.ts.
//
// The work goes through the issue rooms, the way the MCP tools will make it,
// so the claims, their lines, and the feeds come out as they would for real.
// Seeding again adds what is missing, and a new line to each claim still
// being worked. PRs merge when they are first seeded, so they count as
// merged in the week they were seeded.
//
// The earlier work for the leaderboard, and the block on a sample donor, go
// to the database directly. Earlier work is done, so it has no room and no
// line, and it is dated back from the first seed.

// A sample commit to start the work from.
const START_COMMIT = '5a3e'.repeat(10);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${String(number)}`;
}

/** Answers every request to /dev/seed. */
export async function handleDevSeed(request: Request): Promise<Response> {
  if (!devOnlyRequest(request)) return text(404, 'Not Found');
  if (request.method !== 'POST') return text(405, 'Seed with POST.');
  // A page on another site can't seed someone's local site.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== siteOrigin(request)) return text(403, 'Seed from pnpm seed.');
  return Response.json(await seedSampleWork(), { headers: { 'cache-control': 'no-store' } });
}

/** Adds the sample people, projects, issues, crawler finds, and work. Returns what it made. */
export async function seedSampleWork(): Promise<{
  projects: number;
  candidates: number;
  claims: number;
  lines: number;
  merged: number;
  history: number;
}> {
  const now = Date.now();
  for (const person of Object.values(SAMPLE_PEOPLE)) await savePerson(env.DB, person, now);

  let projects = 0;
  for (const project of SAMPLE_PROJECTS) {
    const made = await createProject(
      env.DB,
      {
        repo: project.repo,
        status: project.status,
        source: project.policy ? 'policy' : 'registered',
        policy: project.policy ?? null,
        settings: {
          tags: project.tags,
          prMode: project.prMode,
          personWrittenDescription: project.personWrittenDescription ?? false,
          agentNotes: project.agentNotes ?? '',
        },
        addedBy: project.addedBy.githubId,
      },
      now,
    );
    if (made) projects += 1;
    await saveIssues(
      env.DB,
      project.issues.map((issue) => ({
        issue: `${project.repo}#${String(issue.number)}`,
        project: project.repo,
        title: issue.title,
        labels: issue.labels,
        linkedPr: null,
        syncedAt: now,
      })),
    );
  }

  let candidates = 0;
  for (const candidate of SAMPLE_CANDIDATES) {
    const year = 365 * DAY_MS;
    const found = await addCandidate(
      env.DB,
      {
        repo: candidate.repo,
        facts: {
          stars: candidate.stars,
          createdAt: now - candidate.createdYearsAgo * year,
          pushedAt: now - candidate.pushedHoursAgo * HOUR_MS,
          ownerCreatedAt: now - candidate.ownerYearsAgo * year,
        },
        policy: {
          quote: candidate.policy.quote,
          url: `https://github.com/${candidate.repo}/blob/main/${candidate.policy.path}`,
          tier: candidate.policy.tier,
        },
        settings: candidate.settings,
        suggestedTags: candidate.suggestedTags,
        sources: [],
      },
      now,
    );
    if (found) candidates += 1;
  }

  const made = { claims: 0, lines: 0, merged: 0 };
  for (const sample of SAMPLE_CLAIMS) {
    const result = await work(sample);
    made.claims += result.claimed ? 1 : 0;
    made.lines += result.posted ? 1 : 0;
    made.merged += result.merged ? 1 : 0;
  }
  if ((await getBlock(env.DB, SAMPLE_BLOCKED.githubId)) === null) {
    await blockDonor(env.DB, { githubId: SAMPLE_BLOCKED.githubId, reason: null, blockedBy: SAMPLE_PEOPLE.sampleAdmin.githubId }, now);
  }
  let history = 0;
  for (const sample of SAMPLE_HISTORY) history += (await addHistory(sample, now)) ? 1 : 0;
  return { projects, candidates, ...made, history };
}

// Stores a claim whose PR opened and then merged or closed `daysAgo` days
// before `now`, as the issue room and the PR job would have left it, once.
// Its end is marked offered, so no session offers it to the donor, and a
// closed one's issue isn't due to be read again.
async function addHistory(sample: SampleHistory, now: number): Promise<boolean> {
  if ((await getClaim(env.DB, sample.id)) !== null) return false;
  // Minutes apart, so work seeded this week was claimed and opened this week
  // too, unless the seed runs in the first minutes of a Monday.
  const ended = now - sample.daysAgo * DAY_MS;
  const opened = ended - MINUTE_MS;
  const pr = { repo: sample.project, number: sample.pr, url: prUrl(sample.project, sample.pr) };
  let claim: ClaimRecord = {
    id: sample.id,
    issue: `${sample.project}#${String(sample.issue)}`,
    project: sample.project,
    githubId: sample.person.githubId,
    login: sample.person.login,
    agent: sample.agent,
    ownProject: sample.ownProject ?? false,
    startCommit: START_COMMIT,
    tokenEstimate: sample.tokens ?? null,
    ...newClaim(opened - 2 * MINUTE_MS),
  };
  for (const [event, at] of [
    [{ kind: 'submit' }, opened - MINUTE_MS],
    [{ kind: 'open_pr', pr }, opened],
  ] as const) {
    const next = nextClaimState(claim, event, at);
    if (!next.ok) throw new Error(next.refusal.message);
    claim = next.claim;
  }
  await saveClaim(env.DB, claim, 1);
  await addPr(env.DB, { claimId: claim.id, pr, openedAt: opened });
  await setPrState(env.DB, claim.id, sample.outcome, ended);
  await rereadDone(env.DB, claim.id);
  await markEndedOffered(env.DB, [claim.id], now);
  return true;
}

// Claims the issue, posts the line, and for done work, submits it, opens
// the PR, and merges it. Work already done, or a claim that has moved on, is
// left as it is.
async function work(sample: SampleClaim): Promise<{ claimed: boolean; posted: boolean; merged: boolean }> {
  const issue = `${sample.project}#${String(sample.issue)}`;
  const room = issueRoom(env.ISSUE_ROOM, issue);
  const { githubId, login } = sample.person;
  // Done work is done once. Its PR belongs to the claim that opened it.
  if (sample.mergedPr !== undefined && (await listIssueClaims(env.DB, issue)).some((claim) => claim.pr !== null)) {
    return { claimed: false, posted: false, merged: false };
  }
  const claimed = await room.claim({
    issue,
    project: sample.project,
    githubId,
    login,
    agent: sample.agent,
    ownProject: false,
    startCommit: START_COMMIT,
    slots: 3,
  });
  if (!claimed.ok || !['active', 'paused'].includes(claimed.claim.state)) {
    return { claimed: false, posted: false, merged: false };
  }
  const claimId = claimed.claim.id;
  const post = await room.postUpdate({ claimId, githubId, text: sample.line });
  const posted = post.ok && post.posted;
  if (sample.mergedPr === undefined) return { claimed: claimed.created, posted, merged: false };

  const pr = { repo: sample.project, number: sample.mergedPr, url: prUrl(sample.project, sample.mergedPr) };
  const submitted = await room.submit({ claimId, githubId });
  const opened = submitted.ok && (await room.openPr({ claimId, githubId, pr }));
  if (!opened || !opened.ok) return { claimed: claimed.created, posted, merged: false };
  const now = Date.now();
  await addPr(env.DB, { claimId, pr, openedAt: now });
  await setPrState(env.DB, claimId, 'merged', now);
  // The PR merged, so it is no longer open on the issue.
  await room.prClosed(pr);
  return { claimed: claimed.created, posted, merged: true };
}
