-- Follow-up states (docs/specs/follow-through.md, under Follow-up states).
-- docs/architecture.md describes the change.

-- Each follow-up gains its state: open until an agent sorts it,
-- waiting_reviewer, waiting_donor with the agent's question for the donor,
-- or settled with an outcome. The outcome is fixed, replied with the
-- reply's link, no_change, resolved, or superseded, which only checks and a
-- conflict can be. answered_at stays, as when it settled. A follow-up a
-- submit answered before is settled as fixed, and every other one is open.
-- A CHECK across columns is the table's own, which ALTER TABLE can't add,
-- so the table is made again, with the rows in their order.
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
  state TEXT NOT NULL CHECK (state IN ('open', 'waiting_reviewer', 'waiting_donor', 'settled')),
  outcome TEXT CHECK (outcome IN ('fixed', 'replied', 'no_change', 'resolved', 'superseded')),
  question TEXT,
  reply_url TEXT,
  PRIMARY KEY (claim_id, comment_id),
  CHECK ((kind IN ('checks', 'conflict')) = (reviewer IS NULL)),
  CHECK ((reviewer IS NULL) = (author_kind IS NULL)),
  CHECK ((kind = 'line') = (path IS NOT NULL)),
  CHECK ((state = 'settled') = (outcome IS NOT NULL)),
  CHECK ((state = 'settled') = (answered_at IS NOT NULL)),
  CHECK ((state = 'waiting_donor') = (question IS NOT NULL)),
  CHECK (outcome IS NOT 'replied' OR reply_url IS NOT NULL),
  CHECK (outcome IS NOT 'superseded' OR kind IN ('checks', 'conflict'))
) STRICT;

INSERT INTO follow_ups_next (claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, shown_at,
    answered_at, state, outcome, question, reply_url)
  SELECT claim_id, comment_id, kind, reviewer, author_kind, body, path, url, written_at, read_at, shown_at, answered_at,
    iif(answered_at IS NULL, 'open', 'settled'), iif(answered_at IS NULL, NULL, 'fixed'), NULL, NULL
  FROM follow_ups ORDER BY rowid;

DROP TABLE follow_ups;

ALTER TABLE follow_ups_next RENAME TO follow_ups;
