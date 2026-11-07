-- repo requests
-- Created 2026-11-07T21:19:44.678Z

-- Donors' requests for a repo they want to work on (src/db/requests.ts),
-- made with request_repo (docs/specs/add-a-repo.md, under Requesting a
-- repo). docs/architecture.md describes the table.

-- A request keeps the repo by GitHub's ID, which it keeps through a rename,
-- with the name GitHub gave when the person asked. It stores no status: the
-- status is worked out from the projects when it is read. A withdrawn
-- request is kept, so it still counts toward the person's requests that day.
CREATE TABLE repo_requests (
  id TEXT PRIMARY KEY,
  repo_id INTEGER NOT NULL CHECK (repo_id > 0),
  repo TEXT NOT NULL COLLATE NOCASE,
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  requested_at INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;

-- At most one live request per person per repo.
CREATE UNIQUE INDEX repo_requests_live ON repo_requests (github_id, repo_id) WHERE withdrawn_at IS NULL;
-- A person's requests by when they asked, for the day's count and their list.
CREATE INDEX repo_requests_by_person ON repo_requests (github_id, requested_at);
-- A repo's live requests, for the crawler and the admin queue.
CREATE INDEX repo_requests_by_repo ON repo_requests (repo_id, requested_at) WHERE withdrawn_at IS NULL;
