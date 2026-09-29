-- Keeping listings current (src/crawl/reread.ts): the policy crawler reads
-- each listed project's docs again every week, and each crawler find keeps
-- what its docs read as, so a rejected find comes back only once they read
-- differently. docs/architecture.md describes both tables and the column.

-- Each listed project the crawler reads again. queued_at is when its cron
-- job last put the project in the crawl queue, which spaces the reads a
-- week apart. fingerprint is a hash of what the crawler's rules read in the
-- project's docs the last time it read them whole, or null before. The
-- docs' text isn't kept. pause is the crawler's last pause of the project,
-- as JSON: when it was made, and for a ban, the line its rules read as one
-- and the sentences that name AI, which the admin queue shows.
CREATE TABLE policy_reads (
  project TEXT PRIMARY KEY COLLATE NOCASE REFERENCES projects (repo),
  queued_at INTEGER NOT NULL,
  fingerprint TEXT,
  pause TEXT
) STRICT;

-- Listed projects whose policy, as the crawler's rules read it, changed,
-- waiting in the admin queue or decided by an admin. facts and policy are
-- JSON: the repo's facts, and the policy that welcomes AI help now, or null
-- when the rules read none. sources and ai_sentences are JSON too, as on a
-- crawler find.
CREATE TABLE policy_changes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL COLLATE NOCASE REFERENCES projects (repo),
  found_at INTEGER NOT NULL,
  facts TEXT NOT NULL,
  policy TEXT,
  sources TEXT NOT NULL,
  ai_sentences TEXT NOT NULL,
  more_ai_sentences INTEGER NOT NULL,
  status TEXT NOT NULL,
  decided_by INTEGER REFERENCES people (github_id),
  decided_at INTEGER,
  reason TEXT
) STRICT;

-- A project's policy change waits in the admin queue at most once.
CREATE UNIQUE INDEX policy_changes_waiting ON policy_changes (project) WHERE status = 'waiting';
-- The admin queue, oldest first.
CREATE INDEX policy_changes_by_status ON policy_changes (status, found_at);

-- What the crawler's rules read in the repo's docs when it found the repo,
-- as a policy_reads fingerprint is. A find stored before has none.
ALTER TABLE crawl_candidates ADD COLUMN fingerprint TEXT;
