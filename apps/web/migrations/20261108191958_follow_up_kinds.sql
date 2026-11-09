-- Follow-ups of every kind the PR job reads (docs/specs/follow-through.md,
-- under What comes back as a follow-up). docs/architecture.md describes the
-- change.

-- Each follow-up gains its kind: review, line, conversation, checks, or
-- conflict. author_kind is maintainer or bot, and reviewer the author's
-- login, a bot's with no [bot]. Checks and a conflict come from GitHub, so
-- both are null for them, and only for them. SQLite can't make a column
-- take null, so the table is made again. Every follow-up stored before was
-- a maintainer's review or comment on a line, the line ones those with a
-- path. The rows keep their order, which ties of written_at fall back on.
CREATE TABLE follow_ups_next (
  claim_id TEXT NOT NULL REFERENCES claims (id),
  comment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review', 'line', 'conversation', 'checks', 'conflict')),
  reviewer TEXT COLLATE NOCASE,
  author_kind TEXT CHECK (author_kind IN ('maintainer', 'bot')),
  body TEXT NOT NULL,
  path TEXT,
  url TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  shown_at INTEGER,
  answered_at INTEGER,
  PRIMARY KEY (claim_id, comment_id),
  CHECK ((kind IN ('checks', 'conflict')) = (reviewer IS NULL)),
  CHECK ((reviewer IS NULL) = (author_kind IS NULL)),
  CHECK ((kind = 'line') = (path IS NOT NULL))
) STRICT;

INSERT INTO follow_ups_next (claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, shown_at, answered_at)
  SELECT claim_id, comment_id, iif(path IS NULL, 'review', 'line'), reviewer, 'maintainer', body, path, url,
    written_at, read_at, shown_at, answered_at
  FROM follow_ups ORDER BY rowid;

DROP TABLE follow_ups;

ALTER TABLE follow_ups_next RENAME TO follow_ups;

-- The logins whose reviews on a PR in the repo showed push access, by
-- GitHub's authorCanPushToRepository, and when a read last saw it. A
-- comment in a PR's conversation shows no push access, so its author counts
-- as a maintainer when a read saw one of their reviews show it in the last
-- 90 days. repo is the PR's repo as the prs table names it.
CREATE TABLE repo_pushers (
  repo TEXT NOT NULL COLLATE NOCASE,
  login TEXT NOT NULL COLLATE NOCASE,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo, login)
) STRICT;

-- What the PR job's reads of an open PR's conversation covered, the way
-- reviews and reviews_read do for its reviews: how many comments GitHub
-- counted at the latest read, and how many of them some read took.
ALTER TABLE prs ADD COLUMN conversation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prs ADD COLUMN conversation_read INTEGER NOT NULL DEFAULT 0;
