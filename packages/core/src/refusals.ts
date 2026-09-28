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
  // The submitted files leave the branch as it is, so there is nothing to
  // commit.
  'no_changes',
  // GitHub makes a new fork in the background, and hadn't finished it.
  'fork_not_ready',
  // GitHub refused a write the server made with the donor's token: the fork,
  // the branch, the commit, or the PR.
  'github_refused',
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
