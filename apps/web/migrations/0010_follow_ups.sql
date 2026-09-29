-- Following each claim's PR to the end (src/sync/prs.ts): the reviewers'
-- follow-ups, and the merged PRs a session offered to share.
-- docs/architecture.md describes the change.

-- One row per review or review comment a reviewer wrote on a claim's open
-- PR, as the PR job read it. comment_id is GitHub's node ID for it. body is
-- the reviewer's text folded to one line and cut, and path the file an
-- inline comment is on, or null. written_at is when GitHub says it was
-- written, and read_at when the job read it. shown_at is when
-- start_session or my_work first showed it, and answered_at when a submit
-- to the claim after that answered it.
CREATE TABLE follow_ups (
  claim_id TEXT NOT NULL REFERENCES claims (id),
  comment_id TEXT NOT NULL,
  reviewer TEXT NOT NULL COLLATE NOCASE,
  body TEXT NOT NULL,
  path TEXT,
  url TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  shown_at INTEGER,
  answered_at INTEGER,
  PRIMARY KEY (claim_id, comment_id)
) STRICT;

-- When a session first offered the donor a link to share their merged PR,
-- or null before that. A PR is offered once.
ALTER TABLE prs ADD COLUMN offered_at INTEGER;

-- 1 while the issue of a PR that closed without merging waits for the PR
-- job to read it again, and 0 otherwise. A read that can't run now waits
-- for the job's next run.
ALTER TABLE prs ADD COLUMN reread_due INTEGER NOT NULL DEFAULT 0;
-- The issues that wait to be read again, oldest close first.
CREATE INDEX prs_reread_due ON prs (closed_at) WHERE reread_due = 1;

-- A PR that merged before a session its donor started since had that
-- session as its next, and no link to offer then. It counts as offered, so
-- the first session after this change offers only the PRs that merged
-- since the donor's last session.
UPDATE prs SET offered_at = merged_at
  WHERE state = 'merged'
    AND merged_at < (SELECT MAX(s.started_at) FROM donor_sessions s JOIN claims c ON c.github_id = s.github_id
      WHERE c.id = prs.claim_id);
