-- The trigger a wake can have (docs/specs/follow-through.md, under Waking
-- a run when a follow-up comes): a URL in the donor's harness that the PR
-- job calls when a follow-up comes. docs/architecture.md describes the
-- columns.

-- The trigger's URL, as /me checked it against its harness's pattern, and
-- its key, encrypted with AUTH_SECRET. A wake with no trigger has neither.
ALTER TABLE wakes ADD COLUMN trigger_url TEXT;
ALTER TABLE wakes ADD COLUMN trigger_key TEXT;

-- 1 while the PR job calls it. 0 once Good First Token turned it off,
-- with why in trigger_off: key, gone, or failures.
ALTER TABLE wakes ADD COLUMN trigger_on INTEGER NOT NULL DEFAULT 0 CHECK (trigger_on IN (0, 1));
ALTER TABLE wakes ADD COLUMN trigger_off TEXT CHECK (trigger_off IN ('key', 'gone', 'failures'));

-- When the donor saved it, when it was last called, and when a call last
-- started a run.
ALTER TABLE wakes ADD COLUMN trigger_saved_at INTEGER;
ALTER TABLE wakes ADD COLUMN trigger_called_at INTEGER;
ALTER TABLE wakes ADD COLUMN trigger_fired_at INTEGER;

-- Its failed calls in a row, and until when a 429 holds its calls.
ALTER TABLE wakes ADD COLUMN trigger_failures INTEGER NOT NULL DEFAULT 0 CHECK (trigger_failures >= 0);
ALTER TABLE wakes ADD COLUMN trigger_held_until INTEGER;

-- The UTC day of its last call, as days since the epoch, and how many
-- calls fell on that day.
ALTER TABLE wakes ADD COLUMN trigger_day INTEGER;
ALTER TABLE wakes ADD COLUMN trigger_calls_on_day INTEGER NOT NULL DEFAULT 0 CHECK (trigger_calls_on_day >= 0);

-- The follow-ups a call of each wake's trigger was made for, so each
-- brings one call. No foreign key to follow_ups, which a migration can
-- make again.
CREATE TABLE trigger_follow_ups (
  wake_id TEXT NOT NULL REFERENCES wakes (id),
  claim_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  called_at INTEGER NOT NULL,
  PRIMARY KEY (wake_id, claim_id, comment_id)
) STRICT, WITHOUT ROWID;
