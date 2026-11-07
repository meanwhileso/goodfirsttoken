-- model decides
-- Created 2026-11-06T23:45:56.000Z

-- The model policy reader decides (docs/specs/model-policy-reader.md, under
-- Pausing a listing, In register_project, and The rules during the
-- rollout), with POLICY_READER=model.

-- Who made a find or a policy change: the crawler's rules, or the model
-- reader. rules_tier is what the rules read in the same docs, kept only when
-- it differs from the model's, so the admin sees it beside the model's.
-- why says why a policy change was sent: its policy changed, a move into a
-- ban that didn't check out or that a second reading didn't agree with, or
-- three weekly reads in a row with no verdict.
ALTER TABLE crawl_candidates ADD COLUMN made_by TEXT NOT NULL DEFAULT 'rules' CHECK (made_by IN ('rules', 'model'));
ALTER TABLE crawl_candidates ADD COLUMN rules_tier TEXT;
ALTER TABLE policy_changes ADD COLUMN made_by TEXT NOT NULL DEFAULT 'rules' CHECK (made_by IN ('rules', 'model'));
ALTER TABLE policy_changes ADD COLUMN rules_tier TEXT;
ALTER TABLE policy_changes ADD COLUMN why TEXT NOT NULL DEFAULT 'changed' CHECK (why IN ('changed', 'ban_unconfirmed', 'no_verdict'));

-- Whether a listed project's last model reading was kept while the model
-- decided, or in shadow. Null, as for every reading kept before, is shadow.
-- At a project's first weekly read with the model deciding, its last
-- verdict that was acted on, the rules', becomes the model's last read, so
-- a ban the model read in shadow is a move into one.
ALTER TABLE policy_reads ADD COLUMN model_read_in TEXT CHECK (model_read_in IS NULL OR model_read_in IN ('shadow', 'model'));

-- A second reading for a pause: the model's first reading of the same staged
-- files, as JSON, while the second waits. Null for every other pending
-- reading.
ALTER TABLE model_pending ADD COLUMN first_output TEXT CHECK (first_output IS NULL OR json_valid(first_output));

-- register_project's label checks, kept by a hash of the repo, its label
-- names and descriptions, and the reader version, so a second proposal for
-- the same labels makes no call. tags is the JSON list the check gave.
CREATE TABLE register_label_checks (
  key TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  tags TEXT NOT NULL CHECK (json_valid(tags)),
  checked_at INTEGER NOT NULL
) STRICT;

-- Each label check register_project made, by UTC day, caller, and repo, for
-- the limits of 10 a day per caller and 3 per repo.
CREATE TABLE register_label_uses (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  caller INTEGER NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX register_label_uses_by_caller ON register_label_uses (day, caller);
CREATE INDEX register_label_uses_by_repo ON register_label_uses (day, repo);
