import { z } from 'zod';
import { count, epochMs, githubId, githubLogin, isoTime, trimmedText } from './primitives';
import { mustParse } from './validation';

/** Discovery evidence stays on admin surfaces. No source URL is fetched by the Worker. */
export const CRAWL_METADATA_DAYS = 30;
export const CRAWL_POST_DAYS = 90;
const DAY = 86_400_000;

/** HTTPS sources with a public DNS hostname, no credentials, and a bounded length. */
export const crawlEvidenceUrlSchema = z.url({ protocol: /^https$/, hostname: /^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i }).max(2048).refine((value) => {
  const host = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1]?.toLowerCase();
  return host !== undefined && host.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.split('.').length >= 2 &&
    host.split('.').every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    !/^\d+(?:\.\d+)*$/.test(host) && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(host);
}, 'must be a public HTTPS source URL without credentials');

// The action clock uses whole milliseconds. Reject finer precision rather than rounding a future time down.
const utcTime = isoTime.max(24, 'must use UTC with at most millisecond precision');
const evidenceFields = {
  stars: count,
  public: z.boolean(),
  archived: z.boolean(),
  pushedAt: utcTime,
  metadataCheckedAt: utcTime,
  maintainerGitHubLogin: githubLogin,
  /** The source must state this person's role for the repo or its owning organization. */
  role: z.enum(['owner', 'creator', 'maintainer', 'unknown']),
  roleSourceUrl: crawlEvidenceUrlSchema,
  /** An official GitHub profile, repo file, or project page linking the person to X. */
  identitySourceUrl: crawlEvidenceUrlSchema,
  xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  postUrl: crawlEvidenceUrlSchema,
  publishedAt: utcTime,
  timePrecision: z.enum(['exact', 'date']),
  /** A quote counts only when the person added their own words. */
  postKind: z.enum(['authored', 'quote', 'repost', 'unknown']),
  /** When role, identity, and activity evidence were checked. */
  evidenceCheckedAt: utcTime,
  note: trimmedText(500).optional(),
};

function evidenceChecks(evidence: { postUrl: string; xHandle: string; publishedAt: string; timePrecision: string }, ctx: z.RefinementCtx) {
  const match = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,24})\/?(?:[?#].*)?$/i.exec(evidence.postUrl);
  if (match?.[1]?.toLowerCase() !== evidence.xHandle.toLowerCase()) {
    ctx.addIssue({ code: 'custom', path: ['postUrl'], message: 'must be the named X account\'s numeric status URL' });
  }
  if (evidence.timePrecision === 'date' && Number.isFinite(Date.parse(evidence.publishedAt)) && !new Date(evidence.publishedAt).toISOString().endsWith('T00:00:00.000Z')) {
    ctx.addIssue({ code: 'custom', path: ['publishedAt'], message: 'date precision must use the start of the UTC date' });
  }
}

/** The client supplies research facts. The server supplies the verifier ID. */
export const crawlPriorityInputSchema = z.strictObject(evidenceFields).superRefine(evidenceChecks);
const storedTime = utcTime.refine((time) => Number.isFinite(Date.parse(time)) && time === new Date(time).toISOString(), 'must be a canonical UTC timestamp');
export const crawlPrioritySchema = z.strictObject({ ...evidenceFields,
  pushedAt: storedTime, metadataCheckedAt: storedTime, publishedAt: storedTime, evidenceCheckedAt: storedTime,
  verifierGitHubId: githubId }).superRefine(evidenceChecks);
export type CrawlPriorityInput = z.input<typeof crawlPriorityInputSchema>;
export type CrawlPriority = z.infer<typeof crawlPrioritySchema>;

const timeFields = ['pushedAt', 'metadataCheckedAt', 'publishedAt', 'evidenceCheckedAt'] as const;

/** Validate evidence against the action's clock and stamp the authenticated admin. */
export function verifyCrawlPriority(input: CrawlPriorityInput, verifierGitHubId: number, now: number): CrawlPriority {
  const clock = mustParse(epochMs, now, 'now');
  const evidence = mustParse(crawlPriorityInputSchema, input, 'priority evidence');
  for (const field of timeFields) {
    if (Date.parse(evidence[field]) > clock) throw new Error(`priority evidence.${field}: must not be in the future`);
    evidence[field] = new Date(evidence[field]).toISOString();
  }
  return mustParse(crawlPrioritySchema, { ...evidence, verifierGitHubId }, 'priority evidence');
}

export const crawlPriorityReasons = ['no_evidence', 'stars_low', 'not_public', 'archived', 'role_unknown', 'post_not_authored', 'push_old', 'metadata_old', 'evidence_old', 'post_old', 'future'] as const;
export const crawlPriorityStatusSchema = z.object({ qualifies: z.boolean(), reasons: z.array(z.enum(crawlPriorityReasons)).max(crawlPriorityReasons.length) });
export type CrawlPriorityStatus = z.infer<typeof crawlPriorityStatusSchema>;

export const crawlPriorityReasonText: Record<CrawlPriorityStatus['reasons'][number], string> = {
  no_evidence: 'No discovery evidence.', stars_low: 'Fewer than 10,000 stars.', not_public: 'The repo is private.',
  archived: 'The repo is archived.', role_unknown: 'The maintainer role is unverified.', post_not_authored: 'No authored post was verified.',
  push_old: 'The last push is older than 30 days.', metadata_old: 'The repo metadata check is older than 30 days.',
  evidence_old: 'The role and activity check is older than 30 days.', post_old: 'The authored post is older than 90 days.',
  future: 'A recorded time is in the future.',
};

/** Pure qualification at the producer or reader's clock. Rechecking a post never renews it. */
export function qualifyCrawlPriority(evidence: CrawlPriority | null, now: number): CrawlPriorityStatus {
  const clock = mustParse(epochMs, now, 'now');
  if (evidence === null) return { qualifies: false, reasons: ['no_evidence'] };
  const reasons: CrawlPriorityStatus['reasons'] = [];
  if (evidence.stars < 10000) reasons.push('stars_low');
  if (!evidence.public) reasons.push('not_public');
  if (evidence.archived) reasons.push('archived');
  if (evidence.role === 'unknown') reasons.push('role_unknown');
  if (evidence.postKind !== 'authored' && evidence.postKind !== 'quote') reasons.push('post_not_authored');
  if (timeFields.some((field) => Date.parse(evidence[field]) > clock)) reasons.push('future');
  if (Date.parse(evidence.pushedAt) < clock - CRAWL_METADATA_DAYS * DAY) reasons.push('push_old');
  if (Date.parse(evidence.metadataCheckedAt) < clock - CRAWL_METADATA_DAYS * DAY) reasons.push('metadata_old');
  if (Date.parse(evidence.evidenceCheckedAt) < clock - CRAWL_METADATA_DAYS * DAY) reasons.push('evidence_old');
  if (Date.parse(evidence.publishedAt) < clock - CRAWL_POST_DAYS * DAY) reasons.push('post_old');
  return { qualifies: reasons.length === 0, reasons };
}
