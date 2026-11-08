-- Leases and rounds on each PR (docs/specs/follow-through.md, under Two
-- agents at once, Limits, and Waking up). docs/architecture.md describes
-- the columns.

-- When a run last checked the PR: took or renewed its lease with
-- follow_pr, or renewed it with check_pr. The PR's next check counts from it.
ALTER TABLE prs ADD COLUMN checked_at INTEGER;

-- The run that holds the PR's lease, by the ID it made up, and until when.
-- A lease whose time passed holds nothing, and the next run takes it.
ALTER TABLE prs ADD COLUMN lease_run TEXT;
ALTER TABLE prs ADD COLUMN lease_until INTEGER;

-- What the lease's run did: 1 once a round counted in it, once that round
-- has a push, and once it answered a review bot.
ALTER TABLE prs ADD COLUMN lease_round INTEGER NOT NULL DEFAULT 0 CHECK (lease_round IN (0, 1));
ALTER TABLE prs ADD COLUMN lease_pushed INTEGER NOT NULL DEFAULT 0 CHECK (lease_pushed IN (0, 1));
ALTER TABLE prs ADD COLUMN lease_bot INTEGER NOT NULL DEFAULT 0 CHECK (lease_bot IN (0, 1));

-- The PR's rounds in all, the UTC day of its last round as days since the
-- epoch, how many fell on that day, and how many answered review bots.
ALTER TABLE prs ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0 CHECK (rounds >= 0);
ALTER TABLE prs ADD COLUMN rounds_day INTEGER;
ALTER TABLE prs ADD COLUMN rounds_on_day INTEGER NOT NULL DEFAULT 0 CHECK (rounds_on_day >= 0);
ALTER TABLE prs ADD COLUMN bot_rounds INTEGER NOT NULL DEFAULT 0 CHECK (bot_rounds >= 0);
