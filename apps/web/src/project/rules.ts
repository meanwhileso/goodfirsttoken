import type { ProjectSettings } from '@goodfirsttoken/core';

// A project's settings as its page shows them: each rule as a split badge,
// like `PRs | automatic`. It imports only types, so it runs the same on the
// server and in the page.

/** One rule and its value. `strict` marks a value that holds agents back, drawn on ink. */
export interface RuleBadge {
  rule: string;
  value: string;
  strict: boolean;
}

/**
 * Every setting that says what an agent may do in the project, as badges.
 * Text too long for a badge, like the PR body's words or the notes for
 * agents, the page shows under them.
 */
export function ruleBadges(settings: ProjectSettings): RuleBadge[] {
  const badges: RuleBadge[] = [
    { rule: 'PRs', value: settings.prMode, strict: settings.prMode === 'reviewed' },
    { rule: 'claim', value: settings.whoCanClaim, strict: settings.whoCanClaim === 'vouched' },
  ];
  if (settings.disclosure.trailer !== null) {
    badges.push({ rule: 'disclose', value: settings.disclosure.trailer, strict: false });
  }
  if (settings.disclosure.prBody !== null) badges.push({ rule: 'disclose', value: 'in the PR body', strict: false });
  badges.push(
    settings.personWrittenDescription
      ? { rule: 'description', value: 'person writes', strict: true }
      : { rule: 'description', value: 'agent may write', strict: false },
    settings.claUrl === null ? { rule: 'CLA', value: 'none', strict: false } : { rule: 'CLA', value: 'required', strict: true },
    { rule: 'slots', value: String(settings.claimsPerIssue), strict: false },
    { rule: 'open PRs', value: `${String(settings.openPrsPerDonor)} each`, strict: false },
  );
  if (settings.issueRepo !== null) badges.push({ rule: 'issues in', value: settings.issueRepo, strict: false });
  for (const tag of settings.excludedTags) badges.push({ rule: 'left to people', value: tag, strict: true });
  return badges;
}
