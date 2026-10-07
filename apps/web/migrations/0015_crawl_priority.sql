-- Existing seeds keep their history and ordinary discovery order.
ALTER TABLE crawl_seeds ADD COLUMN priority_evidence TEXT
  CHECK (priority_evidence IS NULL OR json_valid(priority_evidence));
