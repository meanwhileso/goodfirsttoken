-- The model policy reader (docs/specs/model-policy-reader.md), read in
-- shadow first: the crawl consumer stages a repo's docs here, the hourly run
-- sends them to the Message Batches API and collects the readings, and each
-- day's spend is kept against the budget.

-- The last reading the model made of each repo's docs, with the docs hash
-- and the reader version it was made for, so docs that read the same cost no
-- model call. reading is JSON, as the admin queue shows it: the statements
-- that checked out with their lines as the files have them, the steering
-- lines, both tiers, and the model's notes. fingerprint is the reader's
-- outcome fingerprint (src/crawl/reader/fingerprint.ts).
CREATE TABLE model_readings (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  docs_hash TEXT NOT NULL,
  reader_version TEXT NOT NULL,
  reading TEXT NOT NULL CHECK (json_valid(reading)),
  fingerprint TEXT NOT NULL,
  read_at INTEGER NOT NULL
) STRICT;

-- A reading waiting to be sent or collected: the commit, branch, facts, and
-- vouch file the find or the policy change needs, and the labels, as JSON.
-- A repo has one at most, apart from one already sent that a newer one
-- replaced, which the collector drops when it comes back. share is the part
-- of the day's budget it spends from, and purpose is a seed or a weekly read.
-- rules_tier is what the rules read in the same files, for the log's count of
-- agreement. batch_id, sent_at, reserved_usd, and reserved_day are set while
-- it is in a batch.
CREATE TABLE model_pending (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('seed', 'reread')),
  share TEXT NOT NULL,
  docs_hash TEXT NOT NULL,
  rules_tier TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  facts TEXT NOT NULL CHECK (json_valid(facts)),
  vouch TEXT,
  labels TEXT NOT NULL CHECK (json_valid(labels)),
  staged_at INTEGER NOT NULL,
  batch_id TEXT,
  sent_at INTEGER,
  reserved_usd REAL NOT NULL DEFAULT 0,
  reserved_day TEXT,
  replaced INTEGER NOT NULL DEFAULT 0 CHECK (replaced IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX model_pending_one_per_repo ON model_pending (repo) WHERE replaced = 0;
CREATE INDEX model_pending_by_batch ON model_pending (batch_id);

-- The files a pending reading reads, one row each, in the order the crawler
-- read them. The text is the repo's public docs, held until the reading is
-- done, and at most 7 days.
CREATE TABLE model_staged_files (
  reading_id TEXT NOT NULL REFERENCES model_pending (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (reading_id, position)
) STRICT;

-- The batches the hourly run sent and hasn't collected yet.
CREATE TABLE model_batches (
  id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  requests INTEGER NOT NULL
) STRICT;

-- What the model spent each UTC day, by share of the budget, in US dollars:
-- what came back, and what is reserved for requests in flight.
CREATE TABLE model_spend (
  day TEXT NOT NULL,
  share TEXT NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, share)
) STRICT;

-- Small facts the reader keeps between runs, like when it may call the API
-- again after the API refused its key, and the last day it logged that it
-- has no key.
CREATE TABLE model_reader_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- The docs hash of what the crawler read when it found the repo, or found
-- the policy change, so the admin queue shows the model's reading of the
-- same docs. Null for one found before.
ALTER TABLE crawl_candidates ADD COLUMN docs_hash TEXT;
ALTER TABLE policy_changes ADD COLUMN docs_hash TEXT;

-- For a listed project's weekly read: the docs hash and reader version of
-- the last model reading that counted, its outcome fingerprint, and whether
-- it read a ban, and how many weekly reads in a row the model gave no
-- verdict, with whether that was already reported.
ALTER TABLE policy_reads ADD COLUMN docs_hash TEXT;
ALTER TABLE policy_reads ADD COLUMN reader_version TEXT;
ALTER TABLE policy_reads ADD COLUMN model_fingerprint TEXT;
ALTER TABLE policy_reads ADD COLUMN model_banned INTEGER;
ALTER TABLE policy_reads ADD COLUMN model_no_verdicts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_reads ADD COLUMN model_no_verdicts_reported INTEGER NOT NULL DEFAULT 0;
