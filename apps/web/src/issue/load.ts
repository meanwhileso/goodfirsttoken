import type { ClaimRecord } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { siteOrigin } from '../auth/settings';
import { getPerson, getProject, isAskingForHelp, type ClosedBecause } from '../db';
import { siteAddress } from '../home/load';
import { hasPage } from '../project/shown';
import { issueRoom } from '../rooms/issue-room';
import { findIssue, followedCopy } from './find';
import { issueFromPath } from './path';
import { foldEvents, samePr, slotsTaken, type IssueView, type PrLink } from './view';

export { issueFromPath } from './path';

// What the issue page shows when it loads. It runs on the server only: the
// route calls it through the server function in ./data.ts.
//
// The claims, their lines, the timeline, and the open PRs come from the
// issue's room, which holds them, in one glance of one moment: the room
// first applies any pause or expiry that is due, and leaves out blocked
// donors' events. D1 says whether the issue is on the site at all, with the
// check the issue's text stream uses (./find.ts), so a page never makes a
// room that nothing could fill. It also gives the issue's title, labels, and
// linked PR from the tagged issues cache, the project and its claims per
// issue, and each claimant's login now.

export interface IssuePage {
  state: 'ready';
  /** The issue, like `owner/name#12`, spelled as the site first saw it. */
  issue: string;
  repo: string;
  number: number;
  /**
   * The code repo of the project the page follows, when that project has a
   * page of its own, for the breadcrumb. It differs from `repo` when the
   * project keeps its issues in another repo.
   */
  project: string | null;
  /** The title from the tagged issues cache, or null when the issue isn't in it. */
  title: string | null;
  labels: string[];
  /** How the site names itself, as on the homepage, and its origin. */
  site: string;
  origin: string;
  /** The project's claims per issue, or null when the project isn't known. */
  slots: number | null;
  /**
   * Why the issue takes no claims, whatever its slots: the project isn't
   * asking for help, or the issue isn't among its open tagged issues. Null
   * when it takes them while a slot is free and no PR is open.
   */
  closedBecause: ClosedBecause;
  view: IssueView;
}

export type IssuePageResult =
  | IssuePage
  | { state: 'not_found' }
  /** The database or the room couldn't answer. */
  | { state: 'unavailable'; issue: string };

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

  const glance = await issueRoom(env.ISSUE_ROOM, asked).glance();
  if (glance === null) throw new Error('The room could not say which donors are blocked.');
  const view = foldEvents(glance.events);

  // Blocked donors' claims have no event the page may see, so no lane. One
  // that holds a slot still takes it.
  const visible = new Set(view.lanes.map((lane) => lane.claim));
  const hidden = glance.claims.filter((claim) => !visible.has(claim.id));
  view.hidden = { claims: hidden.length, holding: hidden.filter((claim) => HOLDS_SLOT.has(claim.state)).length };

  // Each project that keeps its issues in the repo judges its own copy, by
  // the rule the homepage counts with (src/db/waiting.ts), less the open PRs
  // and the free slot, which the page follows live. The page follows the
  // oldest whose copy waits for an agent, with a free slot under its claims
  // per issue, then the oldest that would but for a PR the sync saw or a
  // full cap, then the oldest.
  const judged = await Promise.all(
    copies.map(async (copy) => ({ ...copy, withPage: await hasPage(env.DB, copy.project) })),
  );
  const tagged = followedCopy(judged, slotsTaken(view));
  const latest = glance.claims.at(-1) ?? mirrored.at(-1);
  const project = tagged?.project ?? (latest ? await getProject(env.DB, latest.project) : null);
  // What the site cached from GitHub, the title, the labels, and the linked
  // PR, shows only while that project has a page (src/project/shown.ts). So
  // once the sync delists it, or it goes on the do-not-list, the page shows
  // the room alone.
  const withPage = project !== null && (tagged ? tagged.withPage : await hasPage(env.DB, project));
  const cached = withPage ? tagged?.copy : undefined;

  // Each lane, and the timeline, names its claimant by their login now,
  // since a login can change and a freed one can go to someone else. One
  // read for each person who claimed it.
  const claimants = new Map(glance.claims.map((claim) => [claim.id, claim.githubId]));
  const shown = [...new Set(view.lanes.flatMap((lane) => claimants.get(lane.claim) ?? []))];
  const logins = new Map(
    await Promise.all(shown.map(async (id) => [id, (await getPerson(env.DB, id))?.login] as const)),
  );
  const loginOf = (claim: string, fallback: string) => logins.get(claimants.get(claim) ?? 0) ?? fallback;
  view.lanes = view.lanes.map((lane) => ({ ...lane, login: loginOf(lane.claim, lane.login) }));
  view.timeline = view.timeline.map((entry) => ({ ...entry, login: loginOf(entry.claim, entry.login) }));

  // The open PRs: the room's, and the one the last sync saw linked to the
  // issue, as the homepage counts them. Each by its repo and number only.
  // The sync tells the room of the PR it saw linked too, so while the
  // project has no page, the room's PRs shown are the claims' own.
  const linked = cached?.linkedPr;
  const claimed = glance.claims.flatMap((claim) => (claim.pr === null ? [] : [claim.pr]));
  const held = withPage ? glance.prs : glance.prs.filter((pr) => claimed.some((own) => samePr(own, pr)));
  const open: PrLink[] = [];
  for (const pr of [...held, ...(linked ? [linked] : [])]) {
    if (!open.some((known) => samePr(known, pr))) open.push({ repo: pr.repo, number: pr.number });
  }
  view.openPrs = open;

  const issue = tagged?.copy.issue ?? glance.issue ?? mirrored[0]?.issue ?? asked;
  const { repo, number } = splitIssue(issue);
  return {
    state: 'ready',
    issue,
    repo,
    number,
    project: withPage ? project.repo : null,
    title: cached?.title ?? null,
    labels: cached?.labels ?? [],
    site: siteAddress(request),
    origin: siteOrigin(request),
    slots: project?.settings.claimsPerIssue ?? null,
    // With no copy, the issue isn't among the project's open tagged issues,
    // unless the project isn't asking for help at all.
    closedBecause: tagged
      ? tagged.closed
      : project !== null && (await isAskingForHelp(env.DB, project.repo))
        ? 'issue'
        : 'project',
    view,
  };
}
