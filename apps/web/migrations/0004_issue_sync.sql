-- The tagged-issue sync (src/sync/). docs/architecture.md describes both
-- changes.

-- How the sync found an issue's linked PR: a JSON list of
-- closing_reference, cross_reference, or both. Null with no linked PR.
ALTER TABLE tagged_issues ADD COLUMN linked_pr_found_by TEXT;

-- Where the sync stands for each project. A pass reads every tagged issue
-- once, across as many runs as it takes. pass_started_at is when the pass
-- in progress started, or null between passes. read_at is when the last
-- whole pass finished. tried_at is when a run, scheduled or asked for, last
-- started on the project, which spaces out the reads a maintainer asks for.
CREATE TABLE issue_syncs (
  project TEXT PRIMARY KEY COLLATE NOCASE REFERENCES projects (repo),
  pass_started_at INTEGER,
  read_at INTEGER,
  tried_at INTEGER NOT NULL
) STRICT;
