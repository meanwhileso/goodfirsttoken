-- Delisting any project whose repo GitHub no longer shows public and open,
-- paused ones included (src/sync/issues.ts). docs/architecture.md describes
-- the change.

-- What the sync last saw of each project's code repo and issue repo.
-- delisted is why GitHub showed one of them private, archived, blocked, or
-- gone, or null when it showed both public and open. While it is set, the
-- project has no page and asks for no help, whatever its status.
-- repos_read_at is when the sync last read the two repos, which orders the
-- checks of paused projects.
ALTER TABLE issue_syncs ADD COLUMN delisted TEXT;
ALTER TABLE issue_syncs ADD COLUMN repos_read_at INTEGER;

-- Until now, a pause that names no one was the sync's delisting, and it hid
-- the project's page. The mark takes that job over, so each such project
-- starts marked, with its pause's reason, and stays hidden until the sync
-- reads its repos again.
INSERT INTO issue_syncs (project, pass_started_at, read_at, refreshed_at, reading_until, delisted)
  SELECT repo, NULL, NULL, NULL, NULL,
    COALESCE(status_reason, 'GitHub showed its repo private, archived, blocked, or gone.')
  FROM projects WHERE status = 'paused' AND status_changed_by IS NULL
  ON CONFLICT (project) DO UPDATE SET delisted = excluded.delisted;
