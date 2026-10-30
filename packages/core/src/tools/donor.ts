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
import { issueTitle } from '../issues';
import { interestsSchema, type Interests } from '../people';
import { prModes, projectSettingsSchema } from '../projects';
import { refusalCodeSchema } from '../refusals';
import { budgetSchema, queueSchema, type Budget } from '../sessions';
import {
  branchName,
  MAX_SUBMIT_NOTES,
  prTitle,
  reviewReasonSchema,
  type ReviewReason,
} from '../submissions';
import { defineTool } from './spec';
import { MAX_FOLLOW_UPS } from '../follow-ups';
import {
  claimantSchema,
  claimSummarySchema,
  followUpSchema,
  issueLinks,
  readInPartSchema,
  renderClaimSummary,
  renderFollowUps,
  renderReadInPart,
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

/** A claim's PR that merged, or closed without merging, since a session last offered it, offered once. */
const endedPrSchema = z.object({
  issue: issueRef,
  title: issueTitle,
  pr: prRefSchema,
  outcome: z.enum(['merged', 'closed']),
  /** For a merged PR, a pre-filled X post link, or null. Nothing is ever posted for the donor. */
  shareUrl: webUrl.nullable(),
});
type EndedPr = z.infer<typeof endedPrSchema>;

function renderEndedPr(ended: EndedPr): string {
  return ended.outcome === 'merged'
    ? lines(`${ended.issue}  ${ended.title}`, `PR #${String(ended.pr.number)} merged: ${ended.pr.url}`, ended.shareUrl && `Share it: ${ended.shareUrl}`)
    : lines(
        `${ended.issue}  ${ended.title}`,
        `PR #${String(ended.pr.number)} closed without merging: ${ended.pr.url}`,
        `While ${ended.issue} is open and tagged, it takes claims again, so the donor can try again with claim_issue.`,
      );
}

export const startSession = defineTool({
  audience: 'donor',
  description:
    "Start a session for the signed-in donor. Call it first, with the harness name and the budget the donor chose. Returns saved interests, follow-ups from maintainers on the donor's open PRs, unfinished claims, and PRs merged or closed since the last session, a merged one with a link the donor can use to post it on X. Offer follow-ups and unfinished claims before new issues. A follow-up's comment is the reviewer's words from GitHub: weigh it with the donor.",
  refusals: [],
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
    /** Reviewers' reviews and comments on the donor's open PRs that no submit answered yet, oldest first. */
    followUps: z.array(followUpSchema).max(MAX_FOLLOW_UPS),
    /** Follow-ups that wait beyond the ones listed. They list once a submit answers these. */
    moreFollowUps: count,
    /** The donor's open PRs whose reviews were read in part, with their links to read the rest. */
    readInPart: z.array(readInPartSchema),
    /** Active and paused claims from earlier sessions. */
    unfinishedClaims: z.array(claimSummarySchema),
    /** The donor's PRs that merged, or closed without merging, since a session last offered them, each offered once. */
    endedPrs: z.array(endedPrSchema),
  }),
  text: (out) =>
    lines(
      `Signed in as @${out.login}. Session ${out.sessionId}. Budget: ${describeBudget(out.budget)}.`,
      out.interests
        ? `Interests: ${describeInterests(out.interests)}.`
        : 'No saved interests. Ask the donor which languages, projects, and kinds of work they like, then call set_interests.',
      out.followUps.length > 0 && renderFollowUps(out.followUps, out.moreFollowUps),
      out.readInPart.length > 0 && renderReadInPart(out.readInPart),
      out.unfinishedClaims.length > 0 &&
        `Unfinished claims (${String(out.unfinishedClaims.length)}):\n${indent(numbered(out.unfinishedClaims, renderClaimSummary), 2)}`,
      out.endedPrs.length > 0 &&
        `Merged or closed since the last session (${String(out.endedPrs.length)}):\n${indent(numbered(out.endedPrs, renderEndedPr), 2)}`,
      out.endedPrs.some((ended) => ended.shareUrl !== null) &&
        'Tell the donor, and give them each link to post on X if they want to. Post nothing for them.',
      (out.followUps.length > 0 || out.unfinishedClaims.length > 0) &&
        'Offer the follow-ups and paused claims first, then the other unfinished claims, before new issues.',
      out.unfinishedClaims.length > 0 && 'Resume a claim with claim_issue and its issue.',
    ),
});

export const setInterests = defineTool({
  audience: 'donor',
  description:
    "Save the donor's interests: languages, projects, and kinds of work, like tests, docs, or bugs. Suggestions are ranked against them.",
  // The agent's sign-in records its person. A caller with no record is
  // refused: "Call start_session first, then save interests."
  refusals: ['not_found'],
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
  refusals: ['not_found', 'budget_spent', 'donor_blocked'],
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
  // The issue's room refuses a claim on another issue with invalid_input,
  // and claim_issue always asks the issue's own room.
  refusals: [
    'not_found',
    'donor_blocked',
    'budget_spent',
    'project_not_open',
    'issue_not_eligible',
    'pr_exists',
    'issue_full',
    'open_pr_cap',
    'not_vouched',
    'cla_required',
  ],
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
    /** The claim's branch, and whether the donor can push to the code repo, where it goes then, or else to their fork. */
    branch: z.object({ name: branchName, canPush: z.boolean() }),
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
      `Commit on the branch ${out.branch.name}, and push it to ${out.branch.canPush ? out.project.repo : `the donor's fork of ${out.project.repo}`}.`,
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
  refusals: ['not_found', 'not_claim_owner', 'claim_released', 'claim_expired', 'pr_closed'],
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

/**
 * A PR cleared to open, for the agent to open with the donor's own tools
 * (docs/specs/agent-submits.md): where it goes, from where, and its title
 * and body, with the GitHub CLI command and the compare page that open it.
 */
const prToOpenSchema = z.object({
  repo: repoName,
  /** The branch the PR comes from, as `owner:branch`. */
  head: z.string().min(1),
  base: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  /** The GitHub CLI command, which reads the body on standard input. */
  command: z.string().min(1),
  /** GitHub's form for the PR, with its title filled in, and its body too when `bodyInLink`. */
  compareUrl: webUrl,
  /**
   * False when the body would make the link longer than GitHub takes. The
   * link then fills in the title alone, and the donor pastes the body.
   */
  bodyInLink: z.boolean(),
});
type PrToOpen = z.infer<typeof prToOpenSchema>;

/** How the agent opens a cleared PR, and records it. */
function toOpenText(claimId: string, open: PrToOpen): string {
  const form = open.bodyInLink
    ? `When gh can't open it, give the donor this link, which opens GitHub's form filled in: ${open.compareUrl}`
    : `When gh can't open it, give the donor this link, which opens GitHub's form with the title filled in: ${open.compareUrl}\nThe body is too long for the link, so give the donor the body below to paste.`;
  return lines(
    `Cleared claim ${claimId} to open as a PR. Run this, with the body below on its standard input, word for word:`,
    indent(open.command, 2),
    form,
    `Then call record_pr with the PR's link.`,
    `Title: ${open.title}`,
    `Body, in the fenced block. The fence lines aren't part of it:`,
    fenced(open.body),
  );
}

/**
 * Text in a fenced block whose fence of backticks is longer than any run of
 * backticks in it, so no line of the text can end the block.
 */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return lines(fence, text, fence);
}

/** A claim's branch as the donor's agent pushed it (docs/specs/agent-submits.md). */
const pushedBranch = z.object({
  repo: repoName.describe("The repo you pushed the branch to: the project's code repo, or the donor's fork of it."),
  name: branchName.describe("The claim's branch, as claim_issue named it."),
  head: commitSha.describe("The commit at the branch's head, as you pushed it."),
});

function describeReviewReason(reason: ReviewReason): string {
  switch (reason) {
    case 'pr_exists':
      return 'a PR is already open on the issue';
    case 'workflow_files':
      return 'the change touches GitHub Actions workflow files';
    case 'too_many_files':
      return "GitHub's comparison of the branch lists 300 files, its most, or leaves commits out, so not every file and commit could be checked";
    case 'comparison_unread':
      return "GitHub gave no comparison of the branch, so its files and commits couldn't be checked";
    case 'reviewed_mode':
      return 'the project reviews agent PRs';
    case 'person_written_description':
      return 'the project asks the donor to write the PR description';
    case 'open_pr_cap':
      return 'the donor has as many open PRs in the project as it allows';
    case 'pr_refused':
      return "GitHub didn't open the PR";
    case 'ready_to_open':
      return 'the work is cleared to open as a PR, and no PR is recorded yet';
  }
}

/** What the agent does next with work in the review queue. */
function nextStep(reason: ReviewReason): string {
  switch (reason) {
    case 'person_written_description':
      return 'Ask the donor to read the diff and write the PR description. Pass it to open_pr word for word.';
    case 'open_pr_cap':
      return 'Ask the donor to read the diff. Clear it with open_pr once one of their PRs in the project merges or closes.';
    case 'pr_refused':
      return 'Ask the donor to read the diff, then clear it with open_pr.';
    case 'ready_to_open':
      return 'Clear it with open_pr, then open the PR as its answer says.';
    default:
      return 'Ask the donor to read the diff, then clear it with open_pr, and open the PR as its answer says.';
  }
}

export const submitWork = defineTool({
  audience: 'donor',
  description:
    "Submit the finished work, with a summary, what you checked, and the agent and model used. Send branch: commit on the claim's branch from the start commit, with the project's trailer on each commit, push it to the code repo or the donor's fork, and name its repo, name, and head. The server checks the branch on GitHub and puts the work in the donor's review queue. Submitting again with a new head records the new commits, and the fixes on a PR once one is open.",
  // not_found, not_claim_owner, and the claim's own refusals come from the
  // claims table, the permission, or the claim's room.
  refusals: [
    'not_found',
    'not_claim_owner',
    'donor_blocked',
    'project_not_open',
    'claim_released',
    'claim_expired',
    'pr_closed',
    'issue_not_eligible',
    'skill_outdated',
    'no_changes',
    'github_refused',
    'branch_not_found',
    'branch_elsewhere',
    'not_from_start',
    'trailer_missing',
  ],
  input: z
    .object({
      claimId: id,
      branch: pushedBranch.optional().describe("The claim's branch as you pushed it."),
      // Older skills sent each changed file whole. The server reads none of
      // it, and refuses the submit with skill_outdated, whose message names
      // the update, so an older skill gets that in place of a schema error.
      files: z
        .array(z.unknown())
        .optional()
        .describe("Refused: older skills sent the changed files here. Push the claim's branch, and send branch."),
      title: prTitle
        .optional()
        .describe("The PR's title, as the repo's own rules want it. Leave it out to use the issue's title."),
      summary: trimmedText(MAX_SUBMIT_NOTES).describe('What the change does. It starts the PR description.'),
      checks: trimmedText(MAX_SUBMIT_NOTES).describe('What you checked, like tests and lint runs, in your own words.'),
      agent: agentName,
      model: modelName,
      tokenEstimate: count
        .optional()
        .describe(
          'Tokens spent on this claim since its last submit, or since it was made, when the harness can estimate them. The server adds up the estimates of every submit.',
        ),
    })
    .superRefine((input, ctx) => {
      if (input.branch === undefined && input.files === undefined) {
        ctx.addIssue({ code: 'custom', path: ['branch'], message: "must name the claim's branch as you pushed it" });
      }
    }),
  output: z.object({
    claimId: id,
    issue: issueRef,
    state: claimStateSchema,
    commit: z.object({ sha: commitSha, url: webUrl }),
    branch: z.object({ repo: repoName, name: branchName, url: webUrl }),
    /** The change from the start commit, on GitHub. */
    diffUrl: webUrl,
    /** The PR the work is on, when one is open. */
    pr: prRefSchema.nullable(),
    /** Why the work went to the donor's review queue, or null when it didn't. */
    reviewReason: reviewReasonSchema.nullable(),
    /** In automatic mode, work with nothing to hold it is cleared to open: how to open it. */
    toOpen: prToOpenSchema.nullable(),
  }),
  text: (out) => {
    const took = `Took ${out.commit.sha.slice(0, 7)} on ${out.branch.repo}:${out.branch.name} for claim ${out.claimId}.`;
    if (out.pr) return lines(took, `PR #${String(out.pr.number)}: ${out.pr.url}`);
    if (out.toOpen) return lines(took, toOpenText(out.claimId, out.toOpen), `Diff: ${out.diffUrl}`);
    const reason = out.reviewReason ?? 'pr_refused';
    return lines(
      took,
      `The work is in the donor's review queue because ${describeReviewReason(reason)}. ${nextStep(reason)}`,
      `Diff: ${out.diffUrl}`,
    );
  },
});

export const releaseClaim = defineTool({
  audience: 'donor',
  description: 'Give up a claim, with a short public reason. The slot opens for someone else.',
  // A claim with a PR, open or ended, is refused with pr_already_opened, since
  // it holds no slot.
  refusals: ['not_found', 'not_claim_owner', 'claim_released', 'claim_expired', 'pr_already_opened'],
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
  /** The change from the start commit, on GitHub. */
  diffUrl: webUrl,
  /** Lines added and removed, as GitHub counts them, or null when it didn't say. */
  additions: count.nullable(),
  deletions: count.nullable(),
  agent: agentName,
  model: z.string(),
  summary: z.string(),
  checks: z.string(),
  /** Why the work is waiting for the donor. Cleared work waits as `ready_to_open`. */
  reviewReason: reviewReasonSchema,
  /**
   * For pushed work open_pr cleared, with no PR recorded yet: how to open its
   * PR, with the compare page link. Null for work that isn't cleared, for
   * cleared work that can't open now, which `reason` explains, and for
   * cleared work whose PR is open already, in `prFromBranch`.
   */
  toOpen: prToOpenSchema.nullable(),
  /**
   * For cleared work, a PR open on GitHub from the claim's own branch that
   * isn't recorded yet: the donor's own PR, which record_pr records.
   */
  prFromBranch: prRefSchema.nullable(),
  /** A PR already open on the issue, from anyone else. The donor decides whether a second one helps. */
  prOnIssue: prRefSchema.nullable(),
  /** When the work expires unless its PR is opened. */
  expiresAt: isoTime,
  /** The project asks the donor to write the PR description. */
  personWrittenDescription: z.boolean(),
  /** False when its PR can't be opened now, as when the project is paused. */
  openable: z.boolean(),
  /** Why its PR can't be opened now, and what to do instead, or null when it can. */
  reason: z.string().max(500).nullable(),
});
type ReviewItem = z.infer<typeof reviewItemSchema>;

function renderReviewItem(item: ReviewItem): string {
  const size =
    item.additions === null || item.deletions === null
      ? ''
      : ` · +${String(item.additions)} -${String(item.deletions)}`;
  // Cleared work says it is cleared only while it has a PR to open.
  const cleared = item.reviewReason === 'ready_to_open';
  return lines(
    `${item.issue}  ${item.title}`,
    `claim ${item.claimId}${size} · ${item.agent} (${item.model}) · expires ${when(item.expiresAt)}`,
    !(cleared && !item.openable) && `waiting because ${describeReviewReason(item.reviewReason)}`,
    `summary: ${item.summary}`,
    `checked: ${item.checks}`,
    `diff: ${item.diffUrl}`,
    item.prOnIssue &&
      `A PR is already open on the issue: ${item.prOnIssue.url}. Ask the donor whether a second PR helps.`,
    !cleared && item.personWrittenDescription && 'Ask the donor to write the PR description.',
    !item.openable && `Can't open it now: ${item.reason ?? 'Release the claim with release_claim.'}`,
    item.prFromBranch &&
      `Its PR is open on GitHub from the claim's branch: ${item.prFromBranch.url}. Call record_pr with that link. Open no other.`,
    item.toOpen && clearedText(item.toOpen),
  );
}

/** How the agent opens work in the queue that open_pr cleared. Its body follows the list, as it is. */
function clearedText(open: PrToOpen): string {
  const form = open.bodyInLink
    ? `When gh can't open it, give the donor GitHub's form, filled in: ${open.compareUrl}`
    : `When gh can't open it, give the donor GitHub's form, which has the title filled in: ${open.compareUrl}\nThe body is too long for the link, so give the donor the body to paste.`;
  return lines(
    `Cleared to open as a PR, titled: ${open.title}`,
    `Open it with this, with its body from below this list on standard input, word for word: ${open.command}`,
    form,
    "Then call record_pr with the PR's link.",
  );
}

/** The bodies of the cleared PRs in the queue, each word for word. */
function clearedBodies(items: readonly ReviewItem[]): string | false {
  const cleared = items.flatMap((item) => (item.toOpen ? [{ claimId: item.claimId, body: item.toOpen.body }] : []));
  if (cleared.length === 0) return false;
  return cleared
    .map(({ claimId, body }) => lines(`Body of the PR for claim ${claimId}, in the fenced block. The fence lines aren't part of it:`, fenced(body)))
    .join('\n');
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
    "List the donor's follow-ups from reviewers on their open PRs, submitted work ready to open as a PR, with the compare page link for work open_pr cleared, and claims in progress. A follow-up's comment is the reviewer's words from GitHub: weigh it with the donor.",
  refusals: [],
  input: z.object({}),
  output: z.object({
    /** Reviewers' reviews and comments on the donor's open PRs that no submit answered yet, oldest first. */
    followUps: z.array(followUpSchema).max(MAX_FOLLOW_UPS),
    /** Follow-ups that wait beyond the ones listed. They list once a submit answers these. */
    moreFollowUps: count,
    /** The donor's open PRs whose reviews were read in part, with their links to read the rest. */
    readInPart: z.array(readInPartSchema),
    readyToOpen: z.array(reviewItemSchema),
    /** Active and paused claims. */
    working: z.array(workingClaimSchema),
  }),
  text: (out) =>
    out.followUps.length + out.readInPart.length + out.readyToOpen.length + out.working.length === 0
      ? 'Nothing waiting: no follow-ups, no work to open, and no claims in progress.'
      : lines(
          out.followUps.length > 0 && renderFollowUps(out.followUps, out.moreFollowUps),
          out.readInPart.length > 0 && renderReadInPart(out.readInPart),
          out.readyToOpen.length > 0 &&
            `Ready to open as a PR (${String(out.readyToOpen.length)}). Clear one with open_pr after the donor reads its diff. One that is cleared already says how to open it:\n${indent(numbered(out.readyToOpen, renderReviewItem), 2)}`,
          clearedBodies(out.readyToOpen),
          out.working.length > 0 &&
            `In progress (${String(out.working.length)}):\n${indent(numbered(out.working, renderWorkingClaim), 2)}`,
        ),
});

/**
 * The longest PR description a donor can write. It leaves room in GitHub's
 * 65,536 characters for the closing line and the project's disclosure.
 */
export const MAX_PR_DESCRIPTION = 60_000;

export const openPr = defineTool({
  audience: 'donor',
  description:
    "Clear the work in the donor's review queue to open as a PR, once the donor has read the diff. The answer gives the PR's title and body, the command that opens it with the donor's own tools, and GitHub's form for it. Then record the PR with record_pr. When the project asks for a person-written description, ask the donor to write it and pass it word for word. Don't draft it.",
  // A claim with a PR is refused with pr_already_opened before its PR's
  // state is read, so open_pr never gives pr_closed.
  refusals: [
    'not_found',
    'not_claim_owner',
    'donor_blocked',
    'project_not_open',
    'claim_released',
    'claim_expired',
    'not_submitted',
    'pr_already_opened',
    'description_required',
    'open_pr_cap',
    'issue_not_eligible',
    'branch_moved',
  ],
  input: z.object({
    claimId: id,
    description: trimmedText(MAX_PR_DESCRIPTION)
      .optional()
      .describe("The PR description the donor wrote, word for word. It takes the place of the agent's summary."),
  }),
  output: z.object({
    claimId: id,
    issue: issueRef,
    state: claimStateSchema,
    /** How to open the PR the server cleared, with the donor's own tools. */
    toOpen: prToOpenSchema,
    /** Another PR open on the issue on GitHub when the work was cleared, from anyone, or null. */
    prOnIssue: prRefSchema.nullable(),
  }),
  text: (out) =>
    lines(
      toOpenText(out.claimId, out.toOpen),
      out.prOnIssue && `Another PR is open on the issue too: ${out.prOnIssue.url}.`,
    ),
});

export const recordPr = defineTool({
  audience: 'donor',
  description:
    "Record the PR you opened for work open_pr cleared, by its link on GitHub. The server reads it and checks that it is the cleared one: in the code repo, aimed at its default branch, from the claim's branch at the cleared commit, opened by the donor, with the closing line and the project's disclosure text in its body. Then the claim has its PR, which the server follows until it merges or closes.",
  refusals: [
    'not_found',
    'not_claim_owner',
    'donor_blocked',
    'project_not_open',
    'claim_released',
    'claim_expired',
    'not_cleared',
    'pr_mismatch',
    'pr_already_opened',
  ],
  input: z.object({
    claimId: id,
    pr: webUrl.describe("The PR's link on GitHub, like https://github.com/owner/repo/pull/12."),
  }),
  output: z.object({
    claimId: id,
    issue: issueRef,
    state: claimStateSchema,
    pr: prRefSchema,
  }),
  text: (out) => `Recorded PR #${String(out.pr.number)} on ${out.pr.repo} for ${out.issue}, claim ${out.claimId}: ${out.pr.url}`,
});
