import { z } from 'zod';
import { epochMs, githubId, id, repoName } from './primitives';

// Maintainers' requests to be removed (spec section 4). A maintainer asks
// from their agent with request_removal, and the request waits in the admin
// queue until an admin removes the repo with admin_remove_project.

/** The longest reason a maintainer gives for asking to be removed. */
export const MAX_REMOVAL_REASON = 500;

/**
 * Why the maintainers want the repo removed, in their own words. Only Good
 * First Token's admins read it. Tabs and line breaks fold into single
 * spaces, so it is always one line, and the queue can quote it whole.
 */
export const removalReason = z
  .string({ error: 'must be text' })
  .overwrite((text) => text.replace(/\s*[\t\r\n]+\s*/g, ' '))
  .trim()
  .min(1, 'must not be empty')
  .max(MAX_REMOVAL_REASON, `must be at most ${String(MAX_REMOVAL_REASON)} characters`);

/** `waiting` for an admin, then `removed` once an admin removed the repo. */
export const removalStatuses = ['waiting', 'removed'] as const;
export const removalStatusSchema = z.enum(removalStatuses);
export type RemovalStatus = z.infer<typeof removalStatusSchema>;

/** A maintainer's request to have a repo removed from Good First Token. */
export const removalRequestSchema = z
  .object({
    id,
    repo: repoName,
    reason: removalReason,
    /** The admin or maintainer of the repo who asked, as GitHub said when they asked. */
    requestedBy: githubId,
    requestedAt: epochMs,
    status: removalStatusSchema,
    /** The admin who removed the repo, or null while the request waits. */
    closedBy: githubId.nullable(),
    closedAt: epochMs.nullable(),
  })
  .superRefine((request, ctx) => {
    const waiting = request.status === 'waiting';
    for (const field of ['closedBy', 'closedAt'] as const) {
      if (waiting && request[field] !== null) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'must be null while the request waits' });
      }
      if (!waiting && request[field] === null) {
        ctx.addIssue({ code: 'custom', path: [field], message: `is required once it is ${request.status}` });
      }
    }
  });
export type RemovalRequest = z.infer<typeof removalRequestSchema>;
