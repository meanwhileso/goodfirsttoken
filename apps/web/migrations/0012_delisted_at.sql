-- When the sync delisted each project, for its maintainers' project_status
-- and the admins' admin_pause_project. docs/architecture.md describes the
-- change.

-- delisted_at is when the mark in delisted went from none to set. It stays
-- while the mark does, whatever words later reads give it, and goes when the
-- mark comes off. repos_read_at moves with every read, so it can't say this.
-- A mark set before this migration gets none, since that time wasn't kept.
ALTER TABLE issue_syncs ADD COLUMN delisted_at INTEGER;
