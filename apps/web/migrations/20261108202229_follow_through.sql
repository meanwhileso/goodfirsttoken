-- The donor's choice and their wakes (docs/specs/follow-through.md, under
-- The donor's choice and Harnesses). docs/architecture.md describes the
-- tables.

-- The mode a donor chose for all their PRs. A donor with no row hasn't
-- chosen, and follows go_ahead.
CREATE TABLE follow_modes (
  github_id INTEGER PRIMARY KEY REFERENCES people (github_id),
  mode TEXT NOT NULL CHECK (mode IN ('go_ahead', 'ask_first')),
  chosen_at INTEGER NOT NULL
) STRICT;

-- The mode a donor chose for one PR, by its claim, which takes the place
-- of their own. off stops following the PR.
CREATE TABLE pr_follow_modes (
  claim_id TEXT PRIMARY KEY REFERENCES claims (id),
  mode TEXT NOT NULL CHECK (mode IN ('go_ahead', 'ask_first', 'off')),
  chosen_at INTEGER NOT NULL
) STRICT;

-- What starts a donor's follow-through runs in one harness, at a level,
-- every interval_minutes. last_run_at is when a run last called my_work
-- with the wake's ID, or null before the first.
CREATE TABLE wakes (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  harness TEXT NOT NULL CHECK (harness IN ('claude-code-desktop', 'claude-code-terminal', 'claude-code-cloud',
    'codex-desktop', 'grok-bot', 'cursor-automations', 'codex-cli', 'cursor-editor', 'opencode', 'grok-build',
    'chatgpt', 'grok-automations')),
  level TEXT NOT NULL CHECK (level IN ('full', 'notify', 'session')),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 1440),
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
) STRICT;

CREATE INDEX wakes_by_person ON wakes (github_id, created_at);

-- The follow-ups my_work gave each wake as newForWake, so a wake is given
-- each one once. No foreign key to follow_ups, which a migration can make
-- again.
CREATE TABLE wake_follow_ups (
  wake_id TEXT NOT NULL REFERENCES wakes (id),
  claim_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  given_at INTEGER NOT NULL,
  PRIMARY KEY (wake_id, claim_id, comment_id)
) STRICT, WITHOUT ROWID;
