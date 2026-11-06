import { z } from 'zod';
import { crawlEvidenceUrlSchema, startsItsDate, storedTime, utcTime, xPostAuthor } from './crawl-priority';
import { epochMs, githubId, githubLogin, trimmedText } from './primitives';
import { mustParse } from './validation';

// A maintainer's post on X that welcomes AI help, for a project an admin
// lists from that post when the repo's docs have no AI policy. The policy's
// quote is the post's words, and its link is the post. The evidence says who
// posted it, that they maintain the repo, and that the X account is theirs.
// The Worker stores the sources and never fetches them. The rules are in
// docs/specs/maintainer-posts.md and docs/how-it-works.md.

/** The roles that let a person's post speak for the repo. */
export const maintainerPostRoles = ['owner', 'creator', 'maintainer'] as const;

export const maintainerPostFields = {
  /** The person who posted, by their GitHub login. */
  maintainerGitHubLogin: githubLogin,
  /** Their role for the repo or the organization that owns it. */
  role: z.enum(maintainerPostRoles, { error: 'must be owner, creator, or maintainer' }),
  /** A public page that states that role, like the repo's MAINTAINERS file or the org's people page. */
  roleSourceUrl: crawlEvidenceUrlSchema,
  /** An official GitHub profile, repo file, or project page that links the person to the X account. */
  identitySourceUrl: crawlEvidenceUrlSchema,
  xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'must be an X handle without the @'),
  publishedAt: utcTime,
  timePrecision: z.enum(['exact', 'date']),
  /** A quote post counts only when the person added their own words. A repost never counts. */
  postKind: z.enum(['authored', 'quote'], { error: 'must be authored or quote: a repost speaks for no one' }),
  /** When the role, the identity, and the post were checked. */
  evidenceCheckedAt: utcTime,
  note: trimmedText(500).optional(),
};

function postChecks(post: { publishedAt: string; timePrecision: string; evidenceCheckedAt: string }, ctx: z.RefinementCtx) {
  if (!startsItsDate(post.publishedAt, post.timePrecision)) {
    ctx.addIssue({ code: 'custom', path: ['publishedAt'], message: 'date precision must use the start of the UTC date' });
  }
  if (Date.parse(post.evidenceCheckedAt) < Date.parse(post.publishedAt)) {
    ctx.addIssue({ code: 'custom', path: ['evidenceCheckedAt'], message: 'must not be before the post was published' });
  }
}

/** What the admin's agent sends. The server adds who verified it. */
export const maintainerPostInputSchema = z.strictObject(maintainerPostFields).superRefine(postChecks);
export type MaintainerPostInput = z.input<typeof maintainerPostInputSchema>;

/** What a listing keeps. */
export const maintainerPostSchema = z
  .strictObject({ ...maintainerPostFields, publishedAt: storedTime, evidenceCheckedAt: storedTime, verifierGitHubId: githubId })
  .superRefine(postChecks);
export type MaintainerPost = z.infer<typeof maintainerPostSchema>;

/**
 * Checks that a policy from a maintainer's post links to that post: a
 * numeric status URL on X by the handle the evidence names.
 */
export function checkPostLink(policy: { url: string; maintainerPost?: { xHandle: string } | undefined }, ctx: z.RefinementCtx): void {
  if (policy.maintainerPost === undefined) {
    // A post on X is no docs policy. Without its evidence it lists nothing,
    // and listing it again to change a setting can't drop the evidence.
    if (xPostAuthor(policy.url) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['maintainerPost'],
        message: 'is required: a policy that links to a post on X needs maintainerPost, the evidence for the post',
      });
    }
    return;
  }
  if (xPostAuthor(policy.url)?.toLowerCase() !== policy.maintainerPost.xHandle.toLowerCase()) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: "must be the maintainer's post: a numeric status URL on X by the handle in maintainerPost",
    });
  }
}

/**
 * Checks the evidence against the action's clock, writes its times in one
 * form, and stamps the admin who verified it. Throws when a time is in the
 * future.
 */
export function verifyMaintainerPost(input: MaintainerPostInput, verifierGitHubId: number, now: number): MaintainerPost {
  const clock = mustParse(epochMs, now, 'now');
  const post = mustParse(maintainerPostInputSchema, input, 'maintainerPost');
  for (const field of ['publishedAt', 'evidenceCheckedAt'] as const) {
    if (Date.parse(post[field]) > clock) throw new FuturePostTime(field);
    post[field] = new Date(post[field]).toISOString();
  }
  return mustParse(maintainerPostSchema, { ...post, verifierGitHubId }, 'maintainerPost');
}

/** A time in the evidence is after the action's clock. */
export class FuturePostTime extends Error {
  constructor(readonly field: 'publishedAt' | 'evidenceCheckedAt') {
    super(`maintainerPost.${field}: must not be in the future`);
    this.name = 'FuturePostTime';
  }
}
