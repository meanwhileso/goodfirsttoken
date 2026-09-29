import { z } from 'zod';
import { claimStateSchema, type ClaimState } from '../claims';
import { delistedShowingSchema, issueSyncSchema } from '../issues';
import { agentName, githubLogin, id, isoTime, issueRef, prRefSchema, repoName, webUrl } from '../primitives';
import { lines, when } from './text';

// Pieces that more than one tool returns.

/** An issue, with its GitHub link and its live page on the site. */
export const issueLinks = {
  issue: issueRef,
  title: z.string(),
  /** The issue on GitHub. */
  url: webUrl,
  /** The issue's live page on the site. */
  liveUrl: webUrl,
};

/** Someone holding a slot on an issue. */
export const claimantSchema = z.object({
  login: githubLogin,
  agent: agentName,
  state: claimStateSchema,
});

/** One of the donor's own claims. */
export const claimSummarySchema = z.object({
  claimId: id,
  ...issueLinks,
  state: claimStateSchema,
  agent: agentName,
  claimedAt: isoTime,
  /** When the claim expires if nothing happens, or null once it no longer can. */
  expiresAt: isoTime.nullable(),
});
export type ClaimSummary = z.infer<typeof claimSummarySchema>;

/** A maintainer asked for changes on one of the donor's PRs. */
export const followUpSchema = z.object({
  claimId: id,
  issue: issueRef,
  title: z.string(),
  pr: prRefSchema,
  reviewer: githubLogin,
  comment: z.string(),
  commentUrl: webUrl,
});
export type FollowUp = z.infer<typeof followUpSchema>;

/**
 * Why the sync delisted a project: GitHub showed its code repo or its issue
 * repo private, archived, blocked, or gone. While it is delisted, the project
 * has no page, and agents get no claims on it, whatever its status. Of the
 * repo, it shows only its name and what GitHub showed.
 */
export const delistingSchema = z.object({
  /** The repo GitHub showed that way: the code repo, or the issue repo. Null when the reason doesn't name one. */
  repo: repoName.nullable(),
  /** What GitHub showed of it. Null when the reason doesn't say. */
  showed: delistedShowingSchema.nullable(),
  /** The sync's reason, like `sample-owner/app is archived on GitHub.` */
  reason: issueSyncSchema.shape.delisted.unwrap(),
  /** When the sync last read the repos and GitHub showed this, or null when it hasn't read them since the mark was set. */
  readAt: isoTime.nullable(),
});
export type Delisting = z.infer<typeof delistingSchema>;

/**
 * What a delisting says, to a project's maintainers and to Good First
 * Token's admins alike: why, when the sync last read the repos, and what
 * brings the page back.
 */
export function delistingText(delisted: Delisting): string {
  const read = delisted.readAt === null ? '' : ` The sync last read the repos on ${when(delisted.readAt)}.`;
  return `Delisted by the sync: ${delisted.reason}${read} It has no page, and agents get no claims on it, whatever its status. The page comes back by itself once the sync reads its repos public and open again. A resume doesn't bring it back. While the repos stay this way, the sync's next check pauses an approved project again, and only Good First Token's admins can resume that pause.`;
}

/** A claim state as the site shows it. */
export function claimStateLabel(state: ClaimState): string {
  switch (state) {
    case 'active':
      return 'working';
    case 'paused':
      return 'paused';
    case 'awaiting_review':
      return 'awaiting review';
    case 'pr_opened':
      return 'PR opened';
    case 'released':
      return 'released';
    case 'expired':
      return 'expired';
  }
}

export function renderClaimSummary(claim: ClaimSummary): string {
  const expires = claim.expiresAt ? ` · expires ${when(claim.expiresAt)}` : '';
  return lines(
    `${claim.issue}  ${claim.title}`,
    `claim ${claim.claimId} · ${claimStateLabel(claim.state)}${expires} · live at ${claim.liveUrl}`,
  );
}

export function renderFollowUp(followUp: FollowUp): string {
  return lines(
    `${followUp.pr.repo}#${String(followUp.pr.number)}  ${followUp.title}`,
    `claim ${followUp.claimId} · @${followUp.reviewer} asked for changes: ${firstLine(followUp.comment)}`,
    followUp.commentUrl,
  );
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
