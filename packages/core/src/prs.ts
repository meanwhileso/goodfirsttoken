import { z } from 'zod';
import { epochMs, id, prRefSchema } from './primitives';

// The PR opened for a claim, followed until it merges or closes (spec
// sections 7 and 9). The leaderboard counts these.

/** `open`, `merged`, or `closed`. `closed` means closed without merging. */
export const prStates = ['open', 'merged', 'closed'] as const;
export const prStateSchema = z.enum(prStates);
export type PrState = z.infer<typeof prStateSchema>;

/**
 * A claim's PR. `closedAt` is when it stopped being open, by merging or by
 * closing, the way GitHub records it, so a merged PR has both times.
 */
export const prRecordSchema = z
  .object({
    claimId: id,
    pr: prRefSchema,
    state: prStateSchema,
    openedAt: epochMs,
    mergedAt: epochMs.nullable(),
    closedAt: epochMs.nullable(),
  })
  .superRefine((record, ctx) => {
    const problem = (field: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };
    const merged = record.state === 'merged';
    if (merged !== (record.mergedAt !== null)) {
      problem('mergedAt', merged ? 'is required for a merged PR' : 'must be null unless the PR merged');
    }
    const open = record.state === 'open';
    if (open !== (record.closedAt === null)) {
      problem('closedAt', open ? 'must be null for an open PR' : `is required for a ${record.state} PR`);
    }
    for (const field of ['mergedAt', 'closedAt'] as const) {
      const at = record[field];
      if (at !== null && at < record.openedAt) problem(field, 'must not be before openedAt');
    }
  });
export type PrRecord = z.infer<typeof prRecordSchema>;

/**
 * A pre-filled post on X about a claim's merged PR, for the donor to post
 * themselves, or not. Nothing is ever posted for them. It names only what
 * GitHub and the live feeds show anyone: the repo, the agent, and the PR's
 * link. The PR's title stays out, since the repo's text could mention
 * someone on X.
 * https://developer.x.com/en/docs/x-for-websites/tweet-button/guides/web-intent
 */
export function shareOnXUrl(merged: { pr: { repo: string; url: string }; agent: string }): string {
  const text = `My PR to ${merged.pr.repo} merged. ${merged.agent} wrote it with my spare tokens, through Good First Token.`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(merged.pr.url)}`;
}
