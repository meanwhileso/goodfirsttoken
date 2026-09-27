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
  // Posting, submitting, and opening a PR (spec sections 7 and 8).
  'not_claim_owner',
  'description_required',
  // Maintainers and admins (spec sections 3 and 4).
  'not_maintainer',
  'repo_not_eligible',
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
