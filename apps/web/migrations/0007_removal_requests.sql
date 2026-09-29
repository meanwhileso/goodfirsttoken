-- Maintainers' requests to be removed (src/db/removals.ts), made with
-- request_removal and closed when an admin removes the repo.
-- docs/architecture.md describes the table.

-- Each request is kept once closed, with who asked, when, and why, and the
-- admin who removed the repo. The reason is the maintainer's own words, and
-- only admins read it.
CREATE TABLE removal_requests (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  reason TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES people (github_id),
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  closed_by INTEGER REFERENCES people (github_id),
  closed_at INTEGER
) STRICT;

-- A repo has at most one request waiting, and a repo's waiting request is
-- found by its name.
CREATE UNIQUE INDEX removal_requests_waiting ON removal_requests (repo) WHERE status = 'waiting';
-- The admin queue's requests, oldest first.
CREATE INDEX removal_requests_queue ON removal_requests (requested_at) WHERE status = 'waiting';
-- A repo's last request, and a maintainer's last request for a repo, to say
-- who withdrew it.
CREATE INDEX removal_requests_by_repo ON removal_requests (repo, requested_at);
