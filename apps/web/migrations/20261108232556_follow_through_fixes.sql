-- What follow-through keeps beside the columns before it
-- (docs/specs/follow-through.md). docs/architecture.md describes the
-- columns.

-- The run that was given each follow-up, by the ID it made up, so the
-- same run's next my_work lists it under newForWake again. Null for a run
-- that named no ID.
ALTER TABLE wake_follow_ups ADD COLUMN run_id TEXT;

-- When the newest read of the PR's head and merge was made, by the PR job
-- or a check. A read made before it adds no checks or conflict.
ALTER TABLE prs ADD COLUMN head_read_at INTEGER;

-- When a run told the donor the PR waited 14 days with no reviewer
-- activity, and when a run asked a maintainer to review it again.
ALTER TABLE prs ADD COLUMN waiting_told_at INTEGER;
ALTER TABLE prs ADD COLUMN review_asked_at INTEGER;
