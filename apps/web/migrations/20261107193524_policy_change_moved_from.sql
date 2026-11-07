-- policy change moved from
-- Created 2026-11-07T19:35:24.654Z

-- For a policy change sent because the welcome a listing was made from moved
-- to another file (docs/how-it-works.md, under Keeping listings current), the
-- link the listing had. An admin who rejects that change keeps the listing
-- as it is, and the same move, from that link to the change's, isn't sent
-- again. Null for any other change.
ALTER TABLE policy_changes ADD COLUMN moved_from TEXT;
