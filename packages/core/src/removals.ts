import { z } from 'zod';
import { UNSAFE_CHARACTER } from './characters';
import { epochMs, githubId, id, repoName } from './primitives';

// Maintainers' requests to be removed (spec section 4). A maintainer asks
// from their agent with request_removal, and the request waits in the admin
// queue until an admin removes the repo with admin_remove_project, or a
// maintainer of the repo withdraws it.

/** The longest reason a maintainer gives for asking to be removed. */
export const MAX_REMOVAL_REASON = 500;

/**
 * A character a person reading the text doesn't see, which an agent reading
 * it could: a format character, like a zero-width space, a word joiner, or a
 * Unicode tag character, a private-use character, an unassigned one, or one
 * Unicode says to ignore when it can't be shown, like a variation selector,
 * a combining grapheme joiner, or a Hangul filler.
 */
const HIDDEN_CHARACTER = /[\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/u;

/**
 * The text as one line, with only what a person can see: each run of
 * characters that could break a line or change what a terminal shows, with
 * the plain spaces around it, becomes one space, and a run at either end
 * goes. Every hidden character goes. One pass over the text, so a long text
 * takes time in proportion to its length.
 */
function oneLine(text: string): string {
  const parts: string[] = [];
  let spaces = 0;
  let gap = false;
  for (const char of text) {
    if (UNSAFE_CHARACTER.test(char)) {
      gap = true;
    } else if (HIDDEN_CHARACTER.test(char)) {
      continue;
    } else if (char === ' ') {
      spaces += 1;
    } else {
      if (parts.length > 0) parts.push(gap ? ' ' : ' '.repeat(spaces));
      parts.push(char);
      spaces = 0;
      gap = false;
    }
  }
  return parts.join('');
}

/**
 * Why the maintainers want the repo removed, in their own words. Only Good
 * First Token's admins read it. It is always one line, under oneLine above,
 * so the queue can show it whole.
 */
export const removalReason = z
  .string({ error: 'must be text' })
  .overwrite(oneLine)
  .trim()
  .min(1, 'must not be empty')
  .max(MAX_REMOVAL_REASON, `must be at most ${String(MAX_REMOVAL_REASON)} characters`);

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
    reason: removalReason,
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
