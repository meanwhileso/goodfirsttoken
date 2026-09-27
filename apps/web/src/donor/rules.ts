import type { ProjectRecord, Refusal } from '@goodfirsttoken/core';
import { confirmCla, getBlock, getClaConfirmation } from '../db';
import type { RepoFacts } from './github';
import { parseVouchFile, vouchStatus } from './vouch';

// The rules spec section 6 sets for the donor, beside the issue's own: not
// blocked, under the project's open-PR cap, the project's CLA confirmed, and
// on its vouch list when it keeps one. suggest_issues and claim_issue
// (src/mcp/donor.ts) both check them here. The rules are in
// docs/how-it-works.md, under The donor's tools.

/** The donor the rules are checked for. */
export interface Donor {
  githubId: number;
  /** Their login now, which the vouch file names them by. */
  login: string;
}

/** A refusal when an admin blocked the donor, who then gets no suggestions and no claims. */
export async function blockedRefusal(db: D1Database, donor: Donor): Promise<Refusal | null> {
  if ((await getBlock(db, donor.githubId)) === null) return null;
  return {
    code: 'donor_blocked',
    message: `A Good First Token admin blocked @${donor.login}, so Good First Token suggests no issues to them and takes no claims from them.`,
  };
}

/** A refusal when the donor has as many open PRs in the project as it allows. */
export function openPrRefusal(project: ProjectRecord, openPrs: number): Refusal | null {
  const cap = project.settings.openPrsPerDonor;
  if (openPrs < cap) return null;
  return {
    code: 'open_pr_cap',
    message: `You have ${String(openPrs)} open ${openPrs === 1 ? 'PR' : 'PRs'} in ${project.repo}, and it allows ${String(cap)} per donor. Pick an issue in another project, or wait for a PR of yours there to merge or close.`,
  };
}

/**
 * A refusal when the project has a CLA the donor hasn't confirmed at its
 * current link. When they confirm it now, the confirmation is kept, so they
 * are asked once per project, and again only when its link changes.
 */
export async function claRefusal(
  db: D1Database,
  project: ProjectRecord,
  donor: Donor,
  confirmedNow: boolean,
  now: number,
): Promise<Refusal | null> {
  const url = project.settings.claUrl;
  if (url === null) return null;
  const kept = await getClaConfirmation(db, donor.githubId, project.repo);
  if (kept?.claUrl === url) return null;
  if (confirmedNow) {
    await confirmCla(db, { githubId: donor.githubId, project: project.repo, claUrl: url }, now);
    return null;
  }
  return {
    code: 'cla_required',
    message: `${project.repo} asks contributors to sign its CLA first: ${url}. Ask the donor to confirm they signed it, then call claim_issue again with claConfirmed: true.`,
  };
}

/**
 * A refusal when the project's vouch file keeps the donor out: a line that
 * denounces them, whoever the project lets claim, or, for a project that
 * takes vouched donors only, no line that vouches for them.
 */
export function vouchRefusal(project: ProjectRecord, donor: Donor, facts: RepoFacts): Refusal | null {
  const file = facts.vouchFile;
  const status = file === null ? 'unknown' : vouchStatus(parseVouchFile(file.text), donor.login);
  if (status === 'denounced') {
    return {
      code: 'not_vouched',
      message: `${project.repo}'s vouch file, ${file?.path ?? ''}, denounces @${donor.login}, so its issues take no claims from them.`,
    };
  }
  if (project.settings.whoCanClaim !== 'vouched' || status === 'vouched') return null;
  return {
    code: 'not_vouched',
    message:
      file === null
        ? `${project.repo} takes claims only from donors its vouch file lists, and it has no vouch file.`
        : `${project.repo} takes claims only from donors its vouch file, ${file.path}, lists, and it doesn't list @${donor.login}.`,
  };
}
