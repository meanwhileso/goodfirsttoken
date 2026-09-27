import { issueRef, validate } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import { createProject, getIssue, getProject, saveIssues, savePerson } from '../db';
import { issueRoom } from '../rooms/issue-room';
import { devOnlyRequest } from './gate';
import { SAMPLE_PEOPLE, SAMPLE_PROJECTS, type SampleProject } from './sample-work';

// POST /dev/work, in local development only: works an issue as one of the
// GitHub fake's sample people, through the issue's room, the way the MCP
// tools will. It claims, posts a line, submits, opens the PR, or releases, so
// a local issue page can be watched with several agents on it, and the
// end-to-end tests can drive real rooms. The route exists only in
// development, and only for a request to this machine by a loopback
// hostname, the gate in ./gate.ts that /dev/seed uses too.
//
//   { "login": "priya", "issue": "sample-owner/sample-app#311", "action": "claim", "agent": "claude-code" }
//   { "login": "priya", "issue": "sample-owner/sample-app#311", "action": "post", "text": "...", "job": "tests" }
//   { "login": "priya", "issue": "sample-owner/sample-app#311", "action": "submit" }
//   { "login": "priya", "issue": "sample-owner/sample-app#311", "action": "open_pr", "pr": 312 }
//   { "login": "priya", "issue": "sample-owner/sample-app#311", "action": "release", "reason": "..." }
//
// The issue has to be in an approved sample project's repo, which is added
// with its sample issues when it isn't there yet. Nothing checks the issue
// on GitHub, so any number works. A claim on an issue the project hasn't
// cached caches it first, as a sync would, with the project's first tag and
// the `title` given, so the issue takes claims. Every action but a claim
// works the person's newest claim on the issue. The answer is the room's.

const ACTIONS = ['claim', 'post', 'submit', 'open_pr', 'release'] as const;
/** The title a claim caches an issue with when the request gives none. */
const SAMPLE_TITLE = 'A sample issue';
type Action = (typeof ACTIONS)[number];

// A sample commit to start the work from.
const START_COMMIT = '5a3e'.repeat(10);

interface Work {
  login: string;
  issue: string;
  action: Action;
  agent: string;
  text: string;
  job: string | null;
  pr: number;
  reason: string;
  title: string;
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function readWork(body: unknown): Work | string {
  if (typeof body !== 'object' || body === null) return 'Send the work as a JSON object.';
  const work = body as Record<string, unknown>;
  const field = (name: string, fallback: string) => (typeof work[name] === 'string' ? work[name] : fallback);
  const action = ACTIONS.find((a) => a === work.action);
  if (!action) return `action has to be one of ${ACTIONS.join(', ')}.`;
  const issue = field('issue', '');
  if (!validate(issueRef, issue).ok) return 'issue has to be an issue, like sample-owner/sample-app#311.';
  return {
    login: field('login', ''),
    issue,
    action,
    agent: field('agent', 'claude-code'),
    text: field('text', ''),
    job: typeof work.job === 'string' ? work.job : null,
    pr: typeof work.pr === 'number' ? work.pr : 0,
    reason: field('reason', ''),
    title: field('title', SAMPLE_TITLE),
  };
}

// Adds the sample project as /dev/seed does, with its sample issues, when it
// isn't a project yet. The person who added it has to be recorded first.
async function addProject(project: SampleProject, now: number): Promise<void> {
  if (await getProject(env.DB, project.repo)) return;
  await savePerson(env.DB, project.addedBy, now);
  await createProject(
    env.DB,
    {
      repo: project.repo,
      status: project.status,
      source: 'registered',
      policy: null,
      settings: {
        tags: project.tags,
        prMode: project.prMode,
        personWrittenDescription: project.personWrittenDescription ?? false,
      },
      addedBy: project.addedBy.githubId,
    },
    now,
  );
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

/** Answers every request to /dev/work. */
export async function handleDevWork(request: Request): Promise<Response> {
  if (!devOnlyRequest(request)) return text(404, 'Not Found');
  if (request.method !== 'POST') return text(405, 'Send work with POST.');
  // A page on another site can't work an issue on someone's local site.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== siteOrigin(request)) return text(403, 'Send work from this machine.');

  const work = readWork(await request.json().catch(() => null));
  if (typeof work === 'string') return text(400, work);
  const person = Object.values(SAMPLE_PEOPLE).find((p) => p.login === work.login);
  if (!person) return text(422, `login has to be one of the sample people: ${Object.values(SAMPLE_PEOPLE).map((p) => p.login).join(', ')}.`);
  const repo = work.issue.slice(0, work.issue.lastIndexOf('#'));
  const sample = SAMPLE_PROJECTS.find((p) => p.status === 'approved' && p.repo.toLowerCase() === repo.toLowerCase());
  if (!sample) return text(422, `The issue has to be in one of the approved sample projects' repos.`);

  const now = Date.now();
  await savePerson(env.DB, person, now);
  await addProject(sample, now);
  const project = await getProject(env.DB, sample.repo);
  if (!project) throw new Error(`${sample.repo} was not added.`);
  const room = issueRoom(env.ISSUE_ROOM, work.issue);

  if (work.action === 'claim') {
    if (!(await getIssue(env.DB, project.repo, work.issue))) {
      await saveIssues(env.DB, [
        {
          issue: work.issue,
          project: project.repo,
          title: work.title,
          labels: project.settings.tags.slice(0, 1),
          linkedPr: null,
          syncedAt: now,
        },
      ]);
    }
    return Response.json(
      await room.claim({
        issue: work.issue,
        project: project.repo,
        githubId: person.githubId,
        login: person.login,
        agent: work.agent,
        ownProject: false,
        startCommit: START_COMMIT,
        slots: project.settings.claimsPerIssue,
      }),
    );
  }
  const claim = (await room.snapshot()).claims.filter((c) => c.githubId === person.githubId).at(-1);
  if (!claim) return text(409, `@${person.login} has no claim on ${work.issue}. Claim it first.`);
  const { githubId } = person;
  const claimId = claim.id;
  switch (work.action) {
    case 'post':
      return Response.json(await room.postUpdate({ claimId, githubId, text: work.text, job: work.job }));
    case 'submit':
      return Response.json(await room.submit({ claimId, githubId }));
    case 'open_pr':
      return Response.json(
        await room.openPr({
          claimId,
          githubId,
          pr: { repo: project.repo, number: work.pr, url: `https://github.com/${project.repo}/pull/${String(work.pr)}` },
        }),
      );
    case 'release':
      return Response.json(await room.release({ claimId, githubId, reason: work.reason }));
  }
}
