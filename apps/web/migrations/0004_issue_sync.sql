-- The tagged-issue sync (src/sync/). docs/architecture.md describes both
-- changes.

-- How the sync found an issue's linked PR: a JSON list of
-- closing_reference, cross_reference, or both. Null with no linked PR.
ALTER TABLE tagged_issues ADD COLUMN linked_pr_found_by TEXT;

-- Where the sync stands for each project. A pass reads every tagged issue
-- once, across as many runs as it takes. pass_started_at is when the pass
-- in progress started, or null between passes. read_at is when the last
-- whole pass finished. refreshed_at is when a maintainer's refresh last
-- started on the project, which spaces out refreshes. While a run, scheduled
-- or a refresh, reads the project, reading_until is when its hold on the
-- project runs out, so no other run reads it at the same time.
CREATE TABLE issue_syncs (
  project TEXT PRIMARY KEY COLLATE NOCASE REFERENCES projects (repo),
  pass_started_at INTEGER,
  read_at INTEGER,
  refreshed_at INTEGER,
  reading_until INTEGER
) STRICT;
