import { issueRef, validate, type ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import { getPerson, getProject } from '../db';
import { siteAddress } from '../home/load';
import { issueRoom } from '../rooms/issue-room';
import { findIssue } from './find';
import { foldEvents, samePr, type IssueView } from './view';

// What the issue page shows when it loads. It runs on the server only: the
// route calls it through the server function in ./data.ts.
//
// The claims, their lines, the timeline, and the open PRs come from the
// issue's room, which holds them: its snapshot, which first applies any
// pause or expiry that is due, then its history, which leaves out blocked
// donors. D1 says whether the issue is on the site at all, with the check
// the issue's text stream uses (./find.ts), so a page never makes a room
// that nothing could fill. It also gives the issue's title and labels from
// the tagged issues cache, the project's claims per issue, and each
// claimant's login now.

/**
 * Owners whose paths belong to the site: sign-in and the MCP server. The
 * Worker answers them before any page, and the page answers 404 for them too.
 */
const RESERVED_OWNERS = new Set(['auth', 'mcp', 'oauth']);

export interface IssuePage {
  state: 'ready';
  /** The issue, like `owner/name#12`, spelled as the site first saw it. */
  issue: string;
  repo: string;
  number: number;
  /** The title from the tagged issues cache, or null when the issue isn't in it. */
  title: string | null;
  labels: string[];
  /** How the site names itself, as on the homepage, and its origin. */
  site: string;
  origin: string;
  /** The project's claims per issue, or null when the project isn't known. */
  slots: number | null;
  /** True when the project is approved, so it takes claims. */
  takingClaims: boolean;
  view: IssueView;
}

export type IssuePageResult =
  | IssuePage
  | { state: 'not_found' }
  /** The database or the room couldn't answer. */
  | { state: 'unavailable'; issue: string };

/** The issue a page's path names, like `owner/name#12`, or null when it names none. */
export function issueFromPath(owner: string, repo: string, number: string): string | null {
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const issue = `${owner}/${repo}#${number}`;
  return validate(issueRef, issue).ok ? issue : null;
}

function splitIssue(issue: string): { repo: string; number: number } {
  const hash = issue.lastIndexOf('#');
  return { repo: issue.slice(0, hash), number: Number(issue.slice(hash + 1)) };
}

const HOLDS_SLOT = new Set<ClaimRecord['state']>(['active', 'paused', 'awaiting_review']);

/** Everything the issue page shows when it loads. */
export async function loadIssue(request: Request, owner: string, repo: string, number: string): Promise<IssuePageResult> {
  const asked = issueFromPath(owner, repo, number);
  if (asked === null) return { state: 'not_found' };
  try {
    return await read(request, asked);
  } catch (error) {
    console.warn(`The issue page for ${asked} could not be read.`, error);
    return { state: 'unavailable', issue: asked };
  }
}

async function read(request: Request, asked: string): Promise<IssuePageResult> {
  const found = await findIssue(env.DB, asked);
  if (!found) return { state: 'not_found' };
  const { claims: mirrored, copies } = found;

  const room = issueRoom(env.ISSUE_ROOM, asked);
  // The snapshot first, so a pause or expiry that is due is in the history.
  const snapshot = await room.snapshot();
  const events = await room.history();
  const view = foldEvents(events);

  const tagged = copies[0];
  const latest = snapshot.claims.at(-1) ?? mirrored.at(-1);
  const project = tagged?.project ?? (latest ? await getProject(env.DB, latest.project) : null);

  // Blocked donors' claims have no event in the history, so no lane. One
  // that holds a slot still takes it.
  const visible = new Set(view.lanes.map((lane) => lane.claim));
  const hidden = snapshot.claims.filter((claim) => !visible.has(claim.id));
  view.hidden = { claims: hidden.length, holding: hidden.filter((claim) => HOLDS_SLOT.has(claim.state)).length };

  // Each lane names its claimant by their login now, since a login can
  // change and a freed one can go to someone else. The room's own record of
  // each claim's PR has its link.
  const claims = new Map(snapshot.claims.map((claim) => [claim.id, claim]));
  const people = await Promise.all(
    view.lanes.map(async (lane) => {
      const claim = claims.get(lane.claim);
      return claim ? getPerson(env.DB, claim.githubId) : null;
    }),
  );
  view.lanes = view.lanes.map((lane, i) => {
    const pr = claims.get(lane.claim)?.pr ?? null;
    return {
      ...lane,
      login: people[i]?.login ?? lane.login,
      pr: lane.pr && pr && samePr(lane.pr, pr) ? pr : lane.pr,
    };
  });
  const logins = new Map(view.lanes.map((lane) => [lane.claim, lane.login]));
  view.timeline = view.timeline.map((entry) => ({ ...entry, login: logins.get(entry.claim) ?? entry.login }));
  view.openPrs = snapshot.prs;

  const issue = tagged?.copy.issue ?? snapshot.issue ?? mirrored[0]?.issue ?? asked;
  const { repo, number } = splitIssue(issue);
  return {
    state: 'ready',
    issue,
    repo,
    number,
    title: tagged?.copy.title ?? null,
    labels: tagged?.copy.labels ?? [],
    site: siteAddress(request),
    origin: siteOrigin(request),
    slots: project?.settings.claimsPerIssue ?? null,
    takingClaims: project?.status === 'approved',
    view,
  };
}
