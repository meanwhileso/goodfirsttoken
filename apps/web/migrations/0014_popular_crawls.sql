-- A monthly sample of GitHub's highest-star search results. Its page and
-- push date advance independently of the broad crawl_passes checkpoint.
CREATE TABLE popular_crawl_passes (
  started_at INTEGER PRIMARY KEY,
  pushed_since INTEGER NOT NULL,
  pool INTEGER,
  page INTEGER NOT NULL,
  queued INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

-- Successful seed, broad, and popular queue sends in a broad pass. Record
-- after sending, so a crash between the two can still deliver twice.
CREATE TABLE crawl_queued_repos (
  broad_started_at INTEGER NOT NULL REFERENCES crawl_passes (started_at),
  repo TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (broad_started_at, repo)
) STRICT;
