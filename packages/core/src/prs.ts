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
