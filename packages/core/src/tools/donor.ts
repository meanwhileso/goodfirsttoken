import { z } from 'zod';
import { claimStateSchema, releaseReason } from '../claims';
import { jobName, updateText } from '../feed';
import {
  agentName,
  commitSha,
  count,
  githubLogin,
  httpsUrl,
  id,
  isoTime,
  issueRef,
  labelName,
  modelName,
  prRefSchema,
  repoName,
  trimmedText,
  webUrl,
} from '../primitives';
import { interestsSchema, type Interests } from '../people';
import { prModes, projectSettingsSchema } from '../projects';
import { refusalCodeSchema } from '../refusals';
import { budgetSchema, queueSchema, type Budget } from '../sessions';
import { defineTool } from './spec';
import {
  claimantSchema,
  claimSummarySchema,
  followUpSchema,
  issueLinks,
  renderClaimSummary,
  renderFollowUp,
} from './shared';
import { indent, lines, numbered, plural, when } from './text';

// The donor's tools (spec section 7).

function describeBudget(budget: Budget): string {
  switch (budget.kind) {
    case 'issues':
      return plural(budget.count, 'issue');
    case 'time':
      return plural(budget.minutes, 'minute');
    case 'until_limit':
      return 'until the harness stops';
  }
}

function describeInterests(interests: Interests): string {
  const parts = [
    interests.languages.length > 0 && `languages: ${interests.languages.join(', ')}`,
    interests.projects.length > 0 && `projects: ${interests.projects.join(', ')}`,
    interests.kinds.length > 0 && `work: ${interests.kinds.join(', ')}`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join(' · ') : 'none';
}

const mergedPrSchema = z.object({
  issue: issueRef,
  title: z.string(),
  pr: prRefSchema,
  /** A pre-filled X post link. Nothing is ever posted for the donor. */
  shareUrl: webUrl,
});

export const startSession = defineTool({
  audience: 'donor',
  description:
    'Start a session for the signed-in donor. Call it first, with the harness name and the budget the donor chose. Returns saved interests, follow-ups from maintainers, unfinished claims, and PRs merged since the last session. Offer follow-ups and unfinished claims before new issues.',
  input: z.object({
    agent: agentName.describe('The harness, like claude-code, codex, opencode, grok, or cursor.'),
    budget: budgetSchema,
  }),
  output: z.object({
    sessionId: id,
    login: githubLogin,
    budget: budgetSchema,
    /** Null until the donor saves interests with set_interests. */
    interests: interestsSchema.nullable(),
    followUps: z.array(followUpSchema),
    /** Active and paused claims from earlier sessions. */
    unfinishedClaims: z.array(claimSummarySchema),
    mergedPrs: z.array(mergedPrSchema),
  }),
  text: (out) =>
    lines(
      `Signed in as @${out.login}. Session ${out.sessionId}. Budget: ${describeBudget(out.budget)}.`,
      out.interests
        ? `Interests: ${describeInterests(out.interests)}.`
        : 'No saved interests. Ask the donor which languages, projects, and kinds of work they like, then call set_interests.',
      out.followUps.length > 0 &&
        `Maintainers asked for changes (${String(out.followUps.length)}):\n${indent(numbered(out.followUps, renderFollowUp), 2)}`,
      out.unfinishedClaims.length > 0 &&
        `Unfinished claims (${String(out.unfinishedClaims.length)}):\n${indent(numbered(out.unfinishedClaims, renderClaimSummary), 2)}`,
      out.mergedPrs.length > 0 &&
        `Merged since the last session (${String(out.mergedPrs.length)}):\n${indent(
          numbered(out.mergedPrs, (m) =>
            lines(`${m.issue}  ${m.title}`, `PR #${String(m.pr.number)} merged. Share it: ${m.shareUrl}`),
          ),
          2,
        )}`,
      (out.followUps.length > 0 || out.unfinishedClaims.length > 0) &&
        'Offer the follow-ups and paused claims first, then the other unfinished claims, before new issues.',
      out.unfinishedClaims.length > 0 && 'Resume a claim with claim_issue and its issue.',
    ),
});

export const setInterests = defineTool({
  audience: 'donor',
  description:
    "Save the donor's interests: languages, projects, and kinds of work, like tests, docs, or bugs. Suggestions are ranked against them.",
  input: interestsSchema,
  output: z.object({ interests: interestsSchema }),
  text: (out) => `Saved interests: ${describeInterests(out.interests)}.`,
});

const suggestionSchema = z.object({
  ...issueLinks,
  /** The project's code repo. It differs from the issue's repo when the project keeps issues elsewhere. */
  project: repoName,
  /** The project tag the issue carries. */
  tag: labelName,
  prMode: z.enum(prModes),
  /** The project's CLA, which the donor confirms before claiming, or null. */
  claUrl: httpsUrl.nullable(),
  /** Everyone holding a slot now, with their agents. A blocked donor holding one isn't named. */
  claimants: z.array(claimantSchema),
  /** Slots taken now, a blocked donor's included. */
  slotsTaken: count,
  /** The project's claims per issue. */
  slots: z.int().min(1),
  /** How many times anyone has claimed it. */
  timesClaimed: count,
  /** Claimed often without a merged PR. */
  tough: z.boolean(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

function renderSuggestion(s: Suggestion): string {
  const named = s.claimants.map((c) => `@${c.login} (${c.agent})`).join(', ');
  const who =
    s.slotsTaken === 0
      ? 'nobody on it'
      : `${String(s.slotsTaken)} of ${String(s.slots)} slots taken${named === '' ? '' : `: ${named}`}`;
  const issueRepo = s.issue.slice(0, s.issue.indexOf('#'));
  return lines(
    `${s.issue}  ${s.title}`,
    issueRepo !== s.project && `project: ${s.project}`,
    `${s.tag} · ${who} · PRs ${s.prMode}`,
    s.tough && `tough: claimed ${plural(s.timesClaimed, 'time')} without a merged PR`,
    s.claUrl && `CLA: ${s.claUrl}. Ask the donor to confirm they signed it before claiming.`,
    s.url,
  );
}

export const suggestIssues = defineTool({
  audience: 'donor',
  description:
    "Suggest up to three issues that maintainers tagged for outside help, ranked against the donor's interests. Show the donor each issue's link and let them pick one or more. Claim the first pick with claim_issue, and pass the rest as its queue. For more, call it again with the issues already shown in exclude.",
  input: z.object({
    sessionId: id,
    exclude: z
      .array(issueRef)
      .max(100)
      .default(() => [])
      .describe('Issues already shown, to leave out.'),
  }),
  output: z.object({ suggestions: z.array(suggestionSchema).max(3) }),
  text: (out) =>
    out.suggestions.length === 0
      ? 'No eligible issues right now.'
      : lines(
          `Issues maintainers tagged for outside help (${String(out.suggestions.length)}):`,
          numbered(out.suggestions, renderSuggestion),
          'Pick one or more by number, or ask for more.',
        ),
});

/** A queued pick claim_issue passed over, and why. */
const skippedPickSchema = z.object({
  issue: issueRef,
  code: refusalCodeSchema,
  message: z.string(),
});

function describeBudgetLeft(budget: { issuesLeft: number | null; endsAt: string | null }): string {
  if (budget.issuesLeft !== null) return `Budget left: ${plural(budget.issuesLeft, 'issue')}.`;
  if (budget.endsAt !== null) return `Budget: new claims until ${when(budget.endsAt)}.`;
  return 'Budget: until the harness stops.';
}

export const claimIssue = defineTool({
  audience: 'donor',
  description:
    "Claim an issue the donor picked, or the next pick waiting in the session's queue. Returns the issue, the project's rules and notes for agents, the repo to clone, and the commit to start from. Pass the donor's other picks as queue: each waits in the session until you call claim_issue with no issue, and a pick that filled up or got a PR meanwhile is skipped and reported. If the project has a CLA, ask the donor to confirm they signed it, then call again with claConfirmed set to its link. Claiming an issue the donor already holds resumes that claim.",
  input: z.object({
    sessionId: id,
    issue: issueRef
      .optional()
      .describe("The issue to claim now. Leave it out to claim the next pick waiting in the session's queue."),
    queue: queueSchema
      .optional()
      .describe("The donor's other picks, in order. They replace the picks waiting in the session."),
    claConfirmed: httpsUrl
      .optional()
      .describe("The link of the project's CLA, which the donor confirmed they signed, as the refusal gave it."),
  }),
  output: z.object({
    claim: claimSummarySchema,
    /** The donor already held the issue, and this is that claim. */
    resumed: z.boolean(),
    /** Slots taken on the issue, this claim's included. */
    slotsTaken: z.int().min(1),
    slots: z.int().min(1),
    /** The issue's text on GitHub. */
    body: z.string(),
    project: z.object({ repo: repoName, settings: projectSettingsSchema }),
    clone: z.object({ url: webUrl, commit: commitSha }),
    /** Queued picks passed over on the way to this one: they filled up, got a PR, or no longer take claims. */
    skipped: z.array(skippedPickSchema),
    /** The picks still waiting in the session, in order. */
    queued: queueSchema,
    /** What is left of the session's budget after this claim. */
    budget: z.object({ issuesLeft: count.nullable(), endsAt: isoTime.nullable() }),
  }),
  text: (out) => {
    const { settings } = out.project;
    return lines(
      out.skipped.length > 0 &&
        `Skipped from the queue (${String(out.skipped.length)}):\n${indent(
          numbered(out.skipped, (s) => `${s.issue} (${s.code}): ${s.message}`),
          2,
        )}`,
      out.resumed
        ? `Resumed claim ${out.claim.claimId} on ${out.claim.issue} · ${String(out.slotsTaken)} of ${String(out.slots)} slots taken`
        : `Claimed ${out.claim.issue} as claim ${out.claim.claimId} · ${String(out.slotsTaken)} of ${String(out.slots)} slots taken`,
      out.claim.title,
      `Issue: ${out.claim.url}`,
      `Live: ${out.claim.liveUrl}`,
      '',
      `Clone ${out.clone.url} and start from commit ${out.clone.commit}.`,
      "Follow the repo's AGENTS.md and CONTRIBUTING. If either asks for a marker of unreviewed agent work, tell the donor and leave it in place.",
      `PRs: ${settings.prMode}.`,
      settings.disclosure.trailer !== null &&
        `Disclose AI use with the trailer ${settings.disclosure.trailer} on each commit.`,
      settings.disclosure.prBody !== null &&
        `Disclose AI use with this in the PR body, word for word:\n${indent(settings.disclosure.prBody, 2)}`,
      settings.personWrittenDescription &&
        'Ask the donor to write the PR description, and pass it to open_pr word for word.',
      settings.agentNotes !== '' &&
        `Notes from the maintainers, word for word:\n${indent(settings.agentNotes, 2)}`,
      'Post an update with post_update after each code change, test run, or decision: at least every 10 minutes, at most every 10 seconds. Never post local paths, environment contents, tokens, or secrets.',
      out.claim.expiresAt &&
        `Submit with submit_work before ${when(out.claim.expiresAt)}, or stop with release_claim and a reason.`,
      out.queued.length > 0 &&
        `Queued next (${String(out.queued.length)}): ${out.queued.join(', ')}. Once this claim is submitted or released, claim the next with claim_issue and no issue.`,
      describeBudgetLeft(out.budget),
      '',
      'Issue text:',
      indent(out.body || '(empty)', 2),
    );
  },
});

export const postUpdate = defineTool({
  audience: 'donor',
  description:
    'Post one short line about what you just did and where, like "fixed off-by-one in parseRange (src/range.ts)". Post after each code change, test run, or decision: at least every 10 minutes, at most every 10 seconds. Repo-relative paths are fine. Never post local paths, environment contents, tokens, or secrets.',
  input: z.object({
    claimId: id,
    text: updateText,
    job: jobName.optional().describe("A subagent's job, like tests. Leave it out for the main agent."),
  }),
  output: z.object({
    posted: z.boolean(),
    /** Set when the post came too soon: how long to wait. */
    waitSeconds: z.int().min(1).nullable(),
    claimId: id,
    state: claimStateSchema,
    /** A PR open on the issue, from anyone. */
    prOnIssue: prRefSchema.nullable(),
  }),
  text: (out) =>
    lines(
      out.posted
        ? `Posted to claim ${out.claimId}.`
        : `Not posted to claim ${out.claimId}: too soon. Wait ${String(out.waitSeconds ?? 10)}s, then fold this line into your next update.`,
      out.prOnIssue &&
        `A PR is open on this issue: ${out.prOnIssue.url}. Stop with release_claim, or finish and submit_work.`,
    ),
});

export const MAX_PATH = 4096;

const repoPath = z
  .string({ error: 'must be a path in the repo, like src/index.ts' })
  .max(MAX_PATH, `must be at most ${MAX_PATH.toLocaleString('en-US')} characters`)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'),
    'must be a path inside the repo, like src/index.ts',
  );

/**
 * The first pair of paths that can't both be files in one commit: the same
 * path twice, two paths that differ only in case, or a file and a path under
 * it. Case counts as the same because some filesystems ignore it.
 */
function firstClash(paths: readonly string[]): string | undefined {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const path of paths) {
    const lower = path.toLowerCase();
    const parts = lower.split('/');
    const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    const other =
      files.get(lower) ??
      dirs.get(lower) ??
      parents.map((parent) => files.get(parent)).find((found) => found !== undefined);
    if (other !== undefined) {
      return other === path ? `lists ${path} twice` : `lists ${other} and ${path}, which can't both be files`;
    }
    files.set(lower, path);
    for (const parent of parents) dirs.set(parent, path);
  }
  return undefined;
}

const changedFile = z.object({
  path: repoPath,
  content: z
    .string()
    .nullable()
    .describe("The file's full new text, or null to delete it."),
});

export const reviewReasons = ['reviewed_mode', 'pr_exists', 'workflow_files'] as const;

function describeReviewReason(reason: (typeof reviewReasons)[number]): string {
  switch (reason) {
    case 'reviewed_mode':
      return 'the project reviews agent PRs';
    case 'pr_exists':
      return 'a PR is already open on the issue';
    case 'workflow_files':
      return 'the change touches CI workflow files';
  }
}

export const submitWork = defineTool({
  audience: 'donor',
  description:
    "Submit the finished work: every changed file relative to the start commit, a summary, what you checked, and the agent and model used. The server commits it as the donor, then opens the PR or puts the work in the donor's review queue.",
  input: z.object({
    claimId: id,
    files: z
      .array(changedFile)
      .min(1, 'must list at least one changed file')
      .max(300, 'must list at most 300 files')
      .superRefine((files, ctx) => {
        const clash = firstClash(files.map((file) => file.path));
        if (clash) ctx.addIssue({ code: 'custom', message: clash });
      }),
    summary: trimmedText(2000),
    checks: trimmedText(2000).describe('What you checked, like tests and lint runs, in your own words.'),
    agent: agentName,
    model: modelName,
    tokenEstimate: count
      .optional()
      .describe(
        'Tokens spent on this claim since its last submit, or since it was made, when the harness can estimate them. The server adds up the estimates of every submit.',
      ),
  }),
  output: z.object({
    claimId: id,
    issue: issueRef,
    state: claimStateSchema,
    commit: z.object({ sha: commitSha, url: webUrl }),
    branch: z.object({ repo: repoName, name: z.string().min(1), url: webUrl }),
    /** The PR the work is on, when one is open. */
    pr: prRefSchema.nullable(),
    /** Why the work went to the donor's review queue, or null when it didn't. */
    reviewReason: z.enum(reviewReasons).nullable(),
  }),
  text: (out) => {
    const committed = `Committed ${out.commit.sha.slice(0, 7)} to ${out.branch.repo}:${out.branch.name} for claim ${out.claimId}.`;
    if (out.pr) return lines(committed, `PR #${String(out.pr.number)}: ${out.pr.url}`);
    return lines(
      committed,
      `The work is in the donor's review queue${
        out.reviewReason ? ` because ${describeReviewReason(out.reviewReason)}` : ''
      }. Ask the donor to read the diff, then open the PR with open_pr.`,
      `Diff: ${out.branch.url}`,
    );
  },
});

export const releaseClaim = defineTool({
  audience: 'donor',
  description: 'Give up a claim, with a short public reason. The slot opens for someone else.',
  input: z.object({
    claimId: id,
    reason: releaseReason.describe('Why you stopped. It is public.'),
  }),
  output: z.object({ claimId: id, issue: issueRef, state: claimStateSchema }),
  text: (out) => `Released claim ${out.claimId} on ${out.issue}. The slot is open again.`,
});

const reviewItemSchema = z.object({
  claimId: id,
  ...issueLinks,
  diffUrl: webUrl,
  additions: count,
  deletions: count,
  agent: agentName,
  model: z.string(),
  summary: z.string(),
  checks: z.string(),
  /** Why the work is waiting for the donor. */
  reviewReason: z.enum(reviewReasons),
  /** A PR already open on the issue, from anyone. The donor decides whether a second one helps. */
  prOnIssue: prRefSchema.nullable(),
  /** When the work expires unless its PR is opened. */
  expiresAt: isoTime,
  /** The project asks the donor to write the PR description. */
  personWrittenDescription: z.boolean(),
});
type ReviewItem = z.infer<typeof reviewItemSchema>;

function renderReviewItem(item: ReviewItem): string {
  return lines(
    `${item.issue}  ${item.title}`,
    `claim ${item.claimId} · +${String(item.additions)} -${String(item.deletions)} · ${item.agent} (${item.model}) · expires ${when(item.expiresAt)}`,
    `waiting because ${describeReviewReason(item.reviewReason)}`,
    `summary: ${item.summary}`,
    `checked: ${item.checks}`,
    `diff: ${item.diffUrl}`,
    item.prOnIssue &&
      `A PR is already open on the issue: ${item.prOnIssue.url}. Ask the donor whether a second PR helps.`,
    item.personWrittenDescription && 'Ask the donor to write the PR description.',
  );
}

/** A claim in progress, as my_work lists it, with whether the agent can go on with it. */
export const workingClaimSchema = claimSummarySchema.extend({
  /** False when no more work may go into it, as when its project's maintainers asked to be removed. */
  resumable: z.boolean(),
  /** Why it can't go on, and what to do instead, or null when it can. */
  reason: z.string().max(500).nullable(),
});
export type WorkingClaim = z.infer<typeof workingClaimSchema>;

function renderWorkingClaim(claim: WorkingClaim): string {
  return lines(
    renderClaimSummary(claim),
    !claim.resumable && `Can't go on: ${claim.reason ?? 'Release it with release_claim.'}`,
  );
}

export const myWork = defineTool({
  audience: 'donor',
  description:
    "List the donor's follow-ups from maintainers, submitted work ready to open as a PR, and claims in progress.",
  input: z.object({}),
  output: z.object({
    followUps: z.array(followUpSchema),
    readyToOpen: z.array(reviewItemSchema),
    /** Active and paused claims. */
    working: z.array(workingClaimSchema),
  }),
  text: (out) =>
    out.followUps.length + out.readyToOpen.length + out.working.length === 0
      ? 'Nothing waiting: no follow-ups, no work to open, and no claims in progress.'
      : lines(
          out.followUps.length > 0 &&
            `Maintainers asked for changes (${String(out.followUps.length)}):\n${indent(numbered(out.followUps, renderFollowUp), 2)}`,
          out.readyToOpen.length > 0 &&
            `Ready to open as a PR (${String(out.readyToOpen.length)}). Open one with open_pr after the donor reads its diff:\n${indent(numbered(out.readyToOpen, renderReviewItem), 2)}`,
          out.working.length > 0 &&
            `In progress (${String(out.working.length)}):\n${indent(numbered(out.working, renderWorkingClaim), 2)}`,
        ),
});

export const openPr = defineTool({
  audience: 'donor',
  description:
    "Open the PR for work in the donor's review queue, once the donor has read the diff. When the project asks for a person-written description, pass the description the donor wrote, word for word.",
  input: z.object({
    claimId: id,
    description: trimmedText(65_536)
      .optional()
      .describe('The PR description, when the donor wrote one.'),
  }),
  output: z.object({ claimId: id, issue: issueRef, state: claimStateSchema, pr: prRefSchema }),
  text: (out) =>
    `Opened PR #${String(out.pr.number)} on ${out.pr.repo} for ${out.issue}, claim ${out.claimId}: ${out.pr.url}`,
});
