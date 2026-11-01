import { env } from 'cloudflare:workers';
import { readSignedIn } from '../auth/session';
import { getProject, listOpenPrLinksByProject } from '../db';
import { repoFromPath } from '../issue/path';
import { hasPage } from './shown';

// What a project's page shows the signed-in person about their own work
// there: how many of their PRs in the project are open, against the
// project's open-PR cap, with their links. A donor at the cap gets no
// suggestions and no claims in the project, as suggest_issues and
// claim_issue say, so the page says it too. It is read for the signed-in
// person alone, and for no one signed out.

export interface OwnOpenPrs {
  /** The person's open PRs in the project, as the cap counts them. */
  openPrs: number;
  /** The project's open PRs per donor. */
  cap: number;
  /** The links of those PRs, oldest first. */
  prs: string[];
}

/** The person's open PRs in the project against its cap, or null when the project has no page. */
export async function ownOpenPrs(person: number, asked: string): Promise<OwnOpenPrs | null> {
  const project = await getProject(env.DB, asked);
  if (project === null || !(await hasPage(env.DB, project))) return null;
  const prs = (await listOpenPrLinksByProject(env.DB, person)).get(project.repo.toLowerCase()) ?? [];
  return { openPrs: prs.length, cap: project.settings.openPrsPerDonor, prs };
}

/**
 * The signed-in person's open PRs in the project at owner/name, or null for
 * someone signed out or a path that names no project with a page. Any
 * cookie Better Auth set while it checked the session comes back to set.
 */
export async function loadOwnOpenPrs(
  request: Request,
  owner: string,
  name: string,
): Promise<{ own: OwnOpenPrs | null; setCookies: string[] }> {
  const asked = repoFromPath(owner, name);
  if (asked === null) return { own: null, setCookies: [] };
  const { signedIn, setCookies } = await readSignedIn(request);
  if (!signedIn) return { own: null, setCookies };
  return { own: await ownOpenPrs(signedIn.githubId, asked), setCookies };
}
