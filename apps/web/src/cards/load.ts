import { githubLogin, validate } from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { findPersonByLogin, getBlock, getProject, latestMergedOnIssue, tally } from '../db';
import { siteAddress } from '../home/load';
import { issueFromPath, repoFromPath } from '../issue/path';
import { hasPage } from '../project/shown';
import { defaultCard, mergedCard, personCard, projectCard, type Card } from './cards';

// What each share card shows, read the way its page reads it, on the server
// only. The numbers come from the leaderboard's tally, which every page's
// counts come from too. A card shows what its page shows and no more: where
// the page answers 404, so does its card, and an issue with no merged PR the
// site shows gets the default card. docs/how-it-works.md, under Share cards,
// has the rules.

/**
 * A card, or no card where the page has no page to show. `isDefault` marks
 * the default card, which is the same for every path on one site.
 */
export type CardResult = { state: 'ready'; card: Card; isDefault?: true } | { state: 'not_found' };

/** The UTC month `now` falls in, from its first moment up to the next month's, and its name, like september 2026. */
export function monthOf(now: number): { from: number; until: number; name: string } {
  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const name = at.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).toLowerCase();
  return { from: Date.UTC(year, month, 1), until: Date.UTC(year, month + 1, 1), name };
}

/** The card for every page without one of its own. */
export function siteCard(request: Request): Card {
  return defaultCard({ site: siteAddress(request) });
}

/**
 * A person's month so far, for their page at /@<login>. No card for a login
 * no one signed in with, a blocked donor, or a path no login fits, as their
 * page has none.
 */
export async function loadPersonCard(request: Request, login: string, now = Date.now()): Promise<CardResult> {
  if (!validate(githubLogin, login).ok) return { state: 'not_found' };
  const person = await findPersonByLogin(env.DB, login);
  if (person === null || (await getBlock(env.DB, person.githubId)) !== null) return { state: 'not_found' };
  const month = monthOf(now);
  const {
    rows: [row],
  } = await tally(env.DB, 'person', { person: person.githubId, range: month }, { limit: 1 });
  return {
    state: 'ready',
    card: personCard({
      site: siteAddress(request),
      login: person.login,
      month: month.name,
      merged: row?.merged ?? 0,
      opened: row?.opened ?? 0,
      projects: row?.projects ?? 0,
    }),
  };
}

/** A project's totals of all time, for its page. No card for a project without a page. */
export async function loadProjectCard(request: Request, owner: string, name: string): Promise<CardResult> {
  const asked = repoFromPath(owner, name);
  if (asked === null) return { state: 'not_found' };
  const project = await getProject(env.DB, asked);
  if (project === null || !(await hasPage(env.DB, project))) return { state: 'not_found' };
  const {
    rows: [row],
  } = await tally(env.DB, 'project', { project: project.repo }, { limit: 1 });
  return {
    state: 'ready',
    card: projectCard({
      site: siteAddress(request),
      repo: project.repo,
      // As the page's merged count: others' PRs and its own maintainers'.
      merged: (row?.merged ?? 0) + (row?.ownMerged ?? 0),
      people: row?.people ?? 0,
      issues: row?.issues ?? 0,
    }),
  };
}

/**
 * The issue's merged PR, for its page, or the default card when no PR on it
 * merged that the site shows. No card for a path no issue fits.
 */
export async function loadIssueCard(request: Request, owner: string, repo: string, number: string): Promise<CardResult> {
  const asked = issueFromPath(owner, repo, number);
  if (asked === null) return { state: 'not_found' };
  const merged = await latestMergedOnIssue(env.DB, asked);
  if (merged === null) return { state: 'ready', card: siteCard(request), isDefault: true };
  const hash = merged.issue.lastIndexOf('#');
  return {
    state: 'ready',
    card: mergedCard({
      site: siteAddress(request),
      repo: merged.issue.slice(0, hash),
      number: Number(merged.issue.slice(hash + 1)),
      login: merged.login,
      agent: merged.agent,
    }),
  };
}
