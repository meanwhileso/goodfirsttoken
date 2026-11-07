-- requested reads
-- Created 2026-11-07T21:42:22.371Z


-- When the policy crawler last read each requested repo
-- (src/db/requested-reads.ts), under The policy crawler in
-- docs/how-it-works.md. docs/architecture.md describes the table.

-- A requested repo is kept by GitHub's ID, as its requests are. repo is the
-- name the run queued it under, and outcome what the run did with it:
-- queued it, or left it out, and why, as the seed list records. A requested
-- repo is due again 30 days after read_at.
CREATE TABLE requested_reads (
  repo_id INTEGER PRIMARY KEY CHECK (repo_id > 0),
  repo TEXT NOT NULL COLLATE NOCASE,
  read_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('queued', 'do_not_list', 'project', 'proposed'))
) STRICT;

-- The requested repos due again, longest since read first.
CREATE INDEX requested_reads_by_read ON requested_reads (read_at);
