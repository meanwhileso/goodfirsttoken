import { CLAIM_LIFETIME_MS, REVIEW_WINDOW_MS } from '@goodfirsttoken/core';

// The rule for an issue waiting for an agent, as SQL, in one place for every
// query that applies it:
//
// - the homepage's projects asking for help, listProjectsAskingForHelp in
//   ./projects.ts,
// - a project page's tagged issues, listProjectIssues in ./issues.ts,
// - the issues suggest_issues starts from, listWaitingIssues in
//   ./projects.ts,
// - the copies of one issue that the issue page and claim_issue judge,
//   listJudgedCopies in ./issues.ts. Those two follow the slots and the open
//   PRs live, from the issue's room,
// - the labels an issue carries on GitHub now, which suggest_issues and
//   claim_issue check, judgeLabels in ./issues.ts,
// - and the projects on the do-not-list among a donor's claims, which
//   start_session, my_work, and claim_issue stop work on,
//   doNotListedProjects in ./projects.ts.
//
// Each piece reads the project as `p`, a projects row, its current settings
// as `s`, a project_settings row, and a project's cached copy of an issue as
// `t`, a tagged_issues row, or labels from GitHub in its place. The index.ts
// barrel leaves this module out, since nothing outside src/db/ builds SQL.
//
// Labels compare without case. SQLite's lower() folds ASCII letters. A
// claim holds a slot as core's holdsSlot says: working or paused until 24
// hours after it was made, and awaiting review until 7 days after its first
// submit, whether or not the room's timer has run yet.

/**
 * True when the project's repo or the repo where it keeps its issues is on
 * the do-not-list, by their own entries, as hasPage (src/project/shown.ts)
 * reads the list. For an approved project, doNotListedAmong says the same of
 * its issue repo, as hasPage's comment explains. Its maintainers asked Good
 * First Token to stop, so no agent does more work there through it.
 */
export const ON_THE_DO_NOT_LIST = `EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo IN (p.repo, p.issue_repo))`;

/** True when the project asks for help: it is approved, and not on the do-not-list. */
export const ASKING_FOR_HELP = `(p.status = 'approved' AND NOT ${ON_THE_DO_NOT_LIST})`;

/** The first of the copy's labels that is one of the project's excluded tags, or NULL. */
export const EXCLUDED_LABEL = `(SELECT l.value FROM json_each(t.labels) l, json_each(s.settings, '$.excludedTags') x
  WHERE lower(l.value) = lower(x.value) ORDER BY l.key LIMIT 1)`;

/** True when the copy carries one of the project's tags and none of its excluded tags. */
export const CARRIES_A_TAG = `(
  EXISTS (SELECT 1 FROM json_each(t.labels) l, json_each(s.settings, '$.tags') g
          WHERE lower(l.value) = lower(g.value))
  AND ${EXCLUDED_LABEL} IS NULL)`;

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
 * project asks for help is ASKING_FOR_HELP, which takesClaims adds.
 */
export function waiting(now: string): string {
  return `(${CARRIES_A_TAG} AND t.linked_pr_number IS NULL AND NOT EXISTS (SELECT 1 ${OPEN_CLAIM_PRS})
    AND ${slotsTaken(now)} < json_extract(s.settings, '$.claimsPerIssue'))`;
}

/** True when a new agent could claim the issue at `now`: its project asks for help, and the copy waits. */
export function takesClaims(now: string): string {
  return `(${ASKING_FOR_HELP} AND ${waiting(now)})`;
}

/**
 * Why a new agent can't claim the copy, whatever its slots and open PRs:
 * 'project' when the project isn't asking for help, 'issue' when the copy
 * doesn't carry one of its tags or carries an excluded one, and NULL when
 * it can, as far as those go.
 */
export const CLOSED_BECAUSE = `(CASE WHEN NOT ${ASKING_FOR_HELP} THEN 'project' WHEN NOT ${CARRIES_A_TAG} THEN 'issue' END)`;
