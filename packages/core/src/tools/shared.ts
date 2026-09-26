import { z } from 'zod';
import { claimStateSchema, type ClaimState } from '../claims';
import { agentName, githubLogin, id, isoTime, issueRef, prRefSchema, webUrl } from '../primitives';
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
    `${claimStateLabel(claim.state)}${expires} · live at ${claim.liveUrl}`,
  );
}

export function renderFollowUp(followUp: FollowUp): string {
  return lines(
    `${followUp.pr.repo}#${String(followUp.pr.number)}  ${followUp.title}`,
    `@${followUp.reviewer} asked for changes: ${firstLine(followUp.comment)}`,
    followUp.commentUrl,
  );
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
