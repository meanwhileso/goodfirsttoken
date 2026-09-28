import { CLAIM_LIFETIME_MS, REVIEW_WINDOW_MS } from '@goodfirsttoken/core';

// The rule for an issue waiting for an agent, as SQL, for every query that
// applies it: the homepage's projects asking for help (./projects.ts) and a
// project page's tagged issues (./issues.ts). Each piece reads a project's
// cached copy of an issue as `t`, a tagged_issues row, and the project's
// current settings as `s`, a project_settings row. The index.ts barrel leaves
// this module out, since nothing outside src/db/ builds SQL.
//
// Labels compare without case. SQLite's lower() folds ASCII letters. A
// claim holds a slot as core's holdsSlot says: working or paused until 24
// hours after it was made, and awaiting review until 7 days after its first
// submit, whether or not the room's timer has run yet.

/** True when the copy carries one of the project's tags and none of its excluded tags. */
export const CARRIES_A_TAG = `(
  EXISTS (SELECT 1 FROM json_each(t.labels) l, json_each(s.settings, '$.tags') g
          WHERE lower(l.value) = lower(g.value))
  AND NOT EXISTS (SELECT 1 FROM json_each(t.labels) l, json_each(s.settings, '$.excludedTags') x
                  WHERE lower(l.value) = lower(x.value)))`;

// The claims on the copy's issue whose PR is open: opened, and not shown
// merged or closed in the PRs table, as the issue's room counts them.
const OPEN_CLAIM_PRS = `FROM claims c LEFT JOIN prs pr ON pr.claim_id = c.id
  WHERE c.issue_repo = t.issue_repo AND c.issue_number = t.number
    AND c.pr_number IS NOT NULL AND (pr.state IS NULL OR pr.state = 'open')`;

/** The first open PR a claim on the issue opened, as `owner/name#57`, or NULL. */
export const OPEN_CLAIM_PR = `(SELECT c.pr_repo || '#' || c.pr_number ${OPEN_CLAIM_PRS}
  ORDER BY c.claimed_at, c.id LIMIT 1)`;

/**
 * How many claims on the issue hold a slot at the time bound to `now`, a
 * placeholder like `?2`. Blocked donors' claims count, since they hold
 * their slots.
 */
export function slotsTaken(now: string): string {
  return `(SELECT COUNT(*) FROM claims c
    WHERE c.issue_repo = t.issue_repo AND c.issue_number = t.number
      AND ((c.state IN ('active', 'paused') AND c.claimed_at + ${String(CLAIM_LIFETIME_MS)} > ${now})
        OR (c.state = 'awaiting_review' AND c.submitted_at + ${String(REVIEW_WINDOW_MS)} > ${now})))`;
}

/**
 * True when a new agent could claim the issue at the time bound to `now`, as
 * far as the copy goes: it carries one of the project's tags and none of its
 * excluded tags, has no open PR, from the last sync or a claim, and has fewer
 * claims holding a slot than the project's claims per issue. Whether the
 * project is approved, and off the do-not-list, is up to the query around it.
 */
export function waiting(now: string): string {
  return `(${CARRIES_A_TAG} AND t.linked_pr_number IS NULL AND NOT EXISTS (SELECT 1 ${OPEN_CLAIM_PRS})
    AND ${slotsTaken(now)} < json_extract(s.settings, '$.claimsPerIssue'))`;
}
