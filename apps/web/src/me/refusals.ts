import type { RefusalCode } from '@goodfirsttoken/core';

// The words /me shows when Open PR is refused. open_pr's own messages are
// written for an agent and can name tools a person on the page doesn't
// have, so each code open_pr lists gets words here for the person: what
// happened, and what they can do on the site or ask their agent to do.

const openPrRefusalWords: Partial<Record<RefusalCode, string>> = {
  not_found: 'Good First Token has no record of this work. Reload the page to see what waits in your queue.',
  not_claim_owner: 'Only the person who made the claim can open its PR.',
  donor_blocked: "Good First Token's admins blocked you, so you can't open PRs through the site.",
  project_not_open:
    "The project doesn't take work through Good First Token now, or GitHub doesn't show you its repo. If the project is paused, open the PR once it resumes. Otherwise, ask your agent to release the claim.",
  claim_released: "The claim was released, so this work can't open as a PR. Ask your agent to claim the issue again.",
  claim_expired:
    'The claim expired before its PR opened. Ask your agent to claim the issue again, if the issue still takes claims.',
  not_submitted: "Your agent hasn't submitted work on this claim yet. Ask your agent to finish the work and submit it.",
  pr_already_opened: 'This work already has a PR. Find it on the issue on GitHub.',
  description_required: 'This project asks you to write the PR description yourself. Write it, then open the PR.',
  open_pr_cap:
    'You have as many PRs open or ready to open in this project as it allows. Open this one once one of them merges or closes. Work in your queue expires 7 days after its first submit.',
  issue_not_eligible:
    'The issue no longer takes work from Good First Token. Read the issue on GitHub to see why, and ask your agent to release the claim.',
  branch_moved:
    "The claim's branch changed or is gone since your agent submitted it, so the work wasn't cleared. Ask your agent to push the branch and submit it again, then read the new diff and open the PR.",
};

/** The page's words for an Open PR refusal, or undefined for a code open_pr doesn't list. */
export function openPrRefusalText(refusal: { code: RefusalCode }): string | undefined {
  return openPrRefusalWords[refusal.code];
}

// The words /me shows when a follow-through form is refused, by
// set_follow_through's rules. Its own messages name tools and fields.

const followRefusalWords: Partial<Record<RefusalCode, string>> = {
  not_found: 'Good First Token has no record of that PR or wake now. Reload the page to see what you follow.',
  not_claim_owner: 'Only the person who made the claim can change how its PR is followed.',
  pr_closed: 'That PR merged or closed, so there is nothing to follow.',
  rate_limited: 'You have as many wakes as one person keeps. Remove one first.',
};

/** The page's words for a follow-through refusal, or undefined for a code set_follow_through doesn't list. */
export function followRefusalText(refusal: { code: RefusalCode }): string | undefined {
  return followRefusalWords[refusal.code];
}
