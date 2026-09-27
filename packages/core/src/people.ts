import { z } from 'zod';
import { epochMs, githubId, githubLogin, httpsUrl, repoName, trimmedText } from './primitives';

// People (spec section 3). Everyone who signs in is a GitHub account: donors,
// maintainers, and admins alike. The numeric ID is who they are, and the
// login is how they are shown.

const interestList = z
  .array(trimmedText(50), { error: 'must be a list' })
  .max(20, 'must list at most 20')
  .default(() => []);

/** What the donor likes to work on. Suggestions are ranked against it. */
export const interestsSchema = z.object({
  languages: interestList,
  projects: interestList,
  /** Kinds of work, like tests, docs, or bugs. */
  kinds: interestList,
});
export type Interests = z.infer<typeof interestsSchema>;

/** A person who has signed in. */
export const personSchema = z.object({
  githubId,
  /** Their login when GitHub last told us. */
  login: githubLogin,
  /** Null until they save interests with set_interests. */
  interests: interestsSchema.nullable(),
  /** When they first signed in. */
  joinedAt: epochMs,
  /** When GitHub last told us their login. */
  seenAt: epochMs,
});
export type Person = z.infer<typeof personSchema>;

/** The longest reason an admin gives for blocking a donor. */
export const MAX_BLOCK_REASON = 500;

/** A donor an admin blocked. They get no new claims, and their live posts are hidden. */
export const donorBlockSchema = z.object({
  githubId,
  reason: trimmedText(MAX_BLOCK_REASON).nullable(),
  /** The admin who blocked them. */
  blockedBy: githubId,
  blockedAt: epochMs,
});
export type DonorBlock = z.infer<typeof donorBlockSchema>;

/**
 * A donor's word that they signed a project's CLA. It is asked once per
 * project, and again only when the project's CLA link changes.
 */
export const claConfirmationSchema = z.object({
  githubId,
  /** The project's code repo. */
  project: repoName,
  /** The CLA link the project had when the donor confirmed it. */
  claUrl: httpsUrl,
  confirmedAt: epochMs,
});
export type ClaConfirmation = z.infer<typeof claConfirmationSchema>;
