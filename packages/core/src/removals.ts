import { z } from 'zod';
import { foldLine, untrustedLine } from './characters';
import { epochMs, githubId, id, repoName } from './primitives';

// Maintainers' requests to be removed (spec section 4). A maintainer asks
// from their agent with request_removal, and the request waits in the admin
// queue until an admin removes the repo with admin_remove_project, or a
// maintainer of the repo withdraws it.

/** The longest reason a maintainer gives for asking to be removed. */
export const MAX_REMOVAL_REASON = 500;

/**
 * The most requests withdrawn by someone other than their asker that a
 * registration or crawler find in the admin queue lists. It counts the rest.
 */
export const MAX_REMOVALS_WITHDRAWN = 5;

/**
 * Why the maintainers want the repo removed, in their own words. Only Good
 * First Token's admins read it. It folds by foldLine to one line with only
 * what a person can see, so the queue can show it whole.
 */
export const removalReason = untrustedLine(MAX_REMOVAL_REASON);

/**
 * A reason as a request keeps it, folded again each time it is read. A
 * reason stored under the fold before this one could be only spaces of
 * another width, which fold to nothing now, so it isn't refused for that.
 */
export const keptRemovalReason = z.string().max(MAX_REMOVAL_REASON).overwrite(foldLine);

/**
 * `waiting` for an admin, then `removed` once an admin removed the repo, or
 * `withdrawn` once a maintainer of the repo took the request back.
 */
export const removalStatuses = ['waiting', 'removed', 'withdrawn'] as const;
export const removalStatusSchema = z.enum(removalStatuses);
export type RemovalStatus = z.infer<typeof removalStatusSchema>;

/** A maintainer's request to have a repo removed from Good First Token. */
export const removalRequestSchema = z
  .object({
    id,
    repo: repoName,
    reason: keptRemovalReason,
    /** The admin or maintainer of the repo who asked, as GitHub said when they asked. */
    requestedBy: githubId,
    requestedAt: epochMs,
    status: removalStatusSchema,
    /**
     * The admin who removed the repo, or the maintainer who withdrew the
     * request, or null while it waits.
     */
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
