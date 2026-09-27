-- The structured records: people, projects and their settings, the
-- tagged-issue cache, claims, PRs, sessions, blocks, the do-not-list, and
-- crawl candidates. docs/architecture.md describes each table.
--
-- Every time is whole milliseconds since the epoch. Lists and small objects
-- are JSON text. Repos and logins compare without case, as they do on
-- GitHub. The core schemas check every row on its way in and out, so the
-- tables hold keys, types, and references, and no CHECK constraints, which
-- SQLite can only change by rebuilding the table.
--
-- No table holds a GitHub token. Tokens stay in the encrypted grant store.

-- Everyone who has signed in. The numeric GitHub ID is who they are.
CREATE TABLE people (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL COLLATE NOCASE,
  interests TEXT,
  joined_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
) STRICT;

-- /@<login> pages and admin blocks find a person by login. A freed login can
-- go to someone else, so the person seen with it most recently has it.
CREATE INDEX people_by_login ON people (login, seen_at);

CREATE TABLE projects (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  -- Where tagged issues live: the issueRepo setting, or the code repo.
  issue_repo TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL,
  status_reason TEXT,
  -- Who gave the project its current status, and when. Null when Good First
  -- Token changed it on its own.
  status_changed_by INTEGER REFERENCES people (github_id),
  status_changed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  policy_quote TEXT,
  policy_url TEXT,
  policy_tier TEXT,
  added_by INTEGER NOT NULL REFERENCES people (github_id),
  added_at INTEGER NOT NULL,
  -- The current row in project_settings.
  settings_version INTEGER NOT NULL
) STRICT;

-- The list of approved projects and the admin queue of pending ones, oldest
-- first.
CREATE INDEX projects_by_status ON projects (status, added_at);
-- The projects whose tagged issues live in a repo, for a claim or a sync.
CREATE INDEX projects_by_issue_repo ON projects (issue_repo);

-- Every save of a project's settings, kept. The project page shows who
-- changed what, and when.
CREATE TABLE project_settings (
  repo TEXT NOT NULL COLLATE NOCASE REFERENCES projects (repo),
  version INTEGER NOT NULL,
  settings TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES people (github_id),
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, version)
) STRICT;

-- Every change of a project's status, kept, with who made it and when. Adding
-- the project is the first.
CREATE TABLE project_status_changes (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE REFERENCES projects (repo),
  status TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER REFERENCES people (github_id),
  changed_at INTEGER NOT NULL
) STRICT;

-- A project's status changes, newest first, for its page.
CREATE INDEX project_status_changes_by_repo ON project_status_changes (repo, id);

-- Open issues carrying a project's tag, as the last sync saw them. Two
-- projects can keep issues in the same repo, so each project has its own copy
-- of an issue. The key leads with the project, which serves a project's
-- issues, suggestions across approved projects, and pruning after a sync.
-- An issue with an assignee isn't eligible, and the sync leaves it out, so
-- there is no assignee column.
CREATE TABLE tagged_issues (
  project TEXT NOT NULL COLLATE NOCASE REFERENCES projects (repo),
  issue_repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  labels TEXT NOT NULL,
  linked_pr_repo TEXT COLLATE NOCASE,
  linked_pr_number INTEGER,
  linked_pr_url TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (project, issue_repo, number)
) STRICT;

-- A mirror of each issue room's claims. The room is the source of truth, and
-- numbers each version it saves in revision, so an older save never lands
-- over a newer one. project has no reference to projects, because a claim's
-- history outlives a listing. login is the claimant's login when they
-- claimed.
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  issue_repo TEXT NOT NULL COLLATE NOCASE,
  issue_number INTEGER NOT NULL,
  project TEXT NOT NULL COLLATE NOCASE,
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  login TEXT NOT NULL COLLATE NOCASE,
  agent TEXT NOT NULL,
  own_project INTEGER NOT NULL,
  start_commit TEXT NOT NULL,
  token_estimate INTEGER,
  state TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  last_update_at INTEGER NOT NULL,
  submitted_at INTEGER,
  release_reason TEXT,
  pr_repo TEXT COLLATE NOCASE,
  pr_number INTEGER,
  pr_url TEXT,
  revision INTEGER NOT NULL
) STRICT;

-- The claims on one issue: its lanes, its slots, how many times it was
-- claimed, and the tough badge.
CREATE INDEX claims_by_issue ON claims (issue_repo, issue_number, claimed_at);
-- A person's claims: my_work, their page, and their leaderboard row. It
-- also covers issues worked per person this week, read in person order.
CREATE INDEX claims_by_person ON claims (github_id, claimed_at);
-- A project's claims: its page and the leaderboard by project.
CREATE INDEX claims_by_project ON claims (project, claimed_at);

-- The PR opened for a claim, followed until it merges or closes.
CREATE TABLE prs (
  claim_id TEXT PRIMARY KEY REFERENCES claims (id),
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  merged_at INTEGER,
  closed_at INTEGER
) STRICT;

-- A PR belongs to one claim.
CREATE UNIQUE INDEX prs_by_number ON prs (repo, number);
-- The PRs still open, oldest first, for the job that follows them.
CREATE INDEX prs_open ON prs (opened_at) WHERE state = 'open';
-- PRs opened in a time range: PRs opened this week.
CREATE INDEX prs_by_opened ON prs (opened_at);
-- PRs that merged or closed in a time range: merged PRs and merge rate this
-- week.
CREATE INDEX prs_by_closed ON prs (closed_at) WHERE closed_at IS NOT NULL;

-- A donor's sessions, each with its budget.
CREATE TABLE donor_sessions (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  agent TEXT NOT NULL,
  budget TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  issues_claimed INTEGER NOT NULL
) STRICT;

-- A donor's latest session, for what merged since then.
CREATE INDEX donor_sessions_by_person ON donor_sessions (github_id, started_at);

-- Donors an admin blocked. The leaderboard hides them.
CREATE TABLE donor_blocks (
  github_id INTEGER PRIMARY KEY REFERENCES people (github_id),
  reason TEXT,
  blocked_by INTEGER NOT NULL REFERENCES people (github_id),
  blocked_at INTEGER NOT NULL
) STRICT;

-- Repos whose maintainers asked to be removed. The crawler honors it.
CREATE TABLE do_not_list (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT,
  added_by INTEGER NOT NULL REFERENCES people (github_id),
  added_at INTEGER NOT NULL
) STRICT;

-- Repos the crawler found whose docs welcome AI help, for the admin queue.
CREATE TABLE crawl_candidates (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL COLLATE NOCASE,
  found_at INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  repo_created_at INTEGER NOT NULL,
  repo_pushed_at INTEGER NOT NULL,
  owner_created_at INTEGER NOT NULL,
  policy_quote TEXT NOT NULL,
  policy_url TEXT NOT NULL,
  policy_tier TEXT NOT NULL,
  settings TEXT NOT NULL,
  suggested_tags TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by INTEGER REFERENCES people (github_id),
  decided_at INTEGER,
  reason TEXT
) STRICT;

-- A repo waits in the admin queue at most once.
CREATE UNIQUE INDEX crawl_candidates_waiting ON crawl_candidates (repo) WHERE status = 'waiting';
-- The admin queue, oldest first.
CREATE INDEX crawl_candidates_by_status ON crawl_candidates (status, found_at);
