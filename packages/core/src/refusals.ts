import { z } from 'zod';

/**
 * Why the server said no. The agent reads the message, then tells the donor
 * or tries something else.
 */
export const refusalCodes = [
  // One claim's own rules (spec section 6), from nextClaimState.
  'claim_expired',
  'claim_released',
  'pr_already_opened',
  'not_submitted',
  // The claim's PR merged or closed, so the claim takes no more updates or
  // fixes. The code that tracks PRs decides this, since nextClaimState has no
  // PR state.
  'pr_closed',
  // Claiming an issue (spec section 6, eligible issues).
  'project_not_open',
  'issue_not_eligible',
  'pr_exists',
  'issue_full',
  'donor_blocked',
  'not_vouched',
  'cla_required',
  'open_pr_cap',
  // The session's budget of issues or time is spent (spec section 7, budget).
  'budget_spent',
  // Posting, submitting, and opening a PR (spec sections 7 and 8).
  'not_claim_owner',
  'description_required',
  // A submit with files, which older skills sent. The server takes a pushed
  // branch alone, so the agent updates the skill and pushes the branch.
  'skill_outdated',
  // The pushed branch changes no file past the default branch, or a fix
  // names the last submit's head, so there is nothing new to take.
  'no_changes',
  // The claim's branch moved from the head its submit checked, so open_pr
  // clears nothing, or my_work shows no link to open it.
  'branch_moved',
  // GitHub didn't give a read the server needed, like a comparison of the
  // pushed branch, or refused it.
  'github_refused',
  // A pushed branch: GitHub shows no such branch in the repo the agent
  // named, or its head isn't the commit the agent named.
  'branch_not_found',
  // A pushed branch is in a repo other than the code repo or a fork of it,
  // or other than the one the claim's branch is already in.
  'branch_elsewhere',
  // The claim's start commit isn't an ancestor of a pushed branch's head.
  'not_from_start',
  // A commit on a pushed branch lacks the disclosure trailer the project
  // asks for.
  'trailer_missing',
  // Recording a PR for work open_pr hasn't cleared to open.
  'not_cleared',
  // A PR to record isn't the one the clearance allows: another repo, base,
  // branch, commit, or author, or a body without the closing line or the
  // disclosure text.
  'pr_mismatch',
  // Maintainers and admins (spec sections 3 and 4).
  'not_maintainer',
  'repo_not_eligible',
  'already_registered',
  'listed_from_policy',
  'label_not_created',
  'invalid_settings',
  'not_admin',
  'not_found',
  // A malformed claim, event, or time reached the claim state machine, or a
  // malformed argument reached an issue room.
  'invalid_input',
] as const;

export const refusalCodeSchema = z.enum(refusalCodes);
export type RefusalCode = z.infer<typeof refusalCodeSchema>;

export const refusalSchema = z.object({
  code: refusalCodeSchema,
  message: z.string().min(1),
});
export type Refusal = z.infer<typeof refusalSchema>;
