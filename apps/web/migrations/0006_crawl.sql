-- The policy crawler (src/crawl/). docs/architecture.md describes both
-- tables, the index, and the new column.

-- Repos an admin asked the crawler to read, whatever their stars or last
-- push. handled_at is when the crawler's cron job handled the seed, and
-- outcome what it did: queued it for the crawler to read, or left it alone,
-- as on the do-not-list, a project, or proposed before. Both are null until
-- then.
CREATE TABLE crawl_seeds (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  added_by INTEGER NOT NULL REFERENCES people (github_id),
  added_at INTEGER NOT NULL,
  handled_at INTEGER,
  outcome TEXT
) STRICT;

-- Each pass of the crawler's search over the pool of repos, and where it
-- stands. The search reads the pool in bands of star counts: low is the
-- fewest stars in the band it reads now, width how many star counts the band
-- spans, open 1 while the band has no upper end, and page the page of the
-- band to read next. pool is how many repos GitHub's search counted in the
-- whole pool, and queued how many the pass has put in the crawl queue.
-- finished_at is null while the pass goes on.
CREATE TABLE crawl_passes (
  started_at INTEGER PRIMARY KEY,
  pushed_since INTEGER NOT NULL,
  pool INTEGER,
  low INTEGER NOT NULL,
  width INTEGER NOT NULL,
  open INTEGER NOT NULL,
  page INTEGER NOT NULL,
  queued INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

-- Every crawler find for a repo, waiting or decided, which the crawler looks
-- for before it reads the repo.
CREATE INDEX crawl_candidates_by_repo ON crawl_candidates (repo);

-- The line in the repo's files behind each setting the crawler suggests,
-- and any canary, as JSON. A find stored before has none.
ALTER TABLE crawl_candidates ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
