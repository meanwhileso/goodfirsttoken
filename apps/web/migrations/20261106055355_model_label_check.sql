-- model label check
-- Created 2026-11-06T05:53:55.594Z

-- The model's label check (docs/specs/model-policy-reader.md, under The
-- label check). A seed's reading that would make a find stays pending after
-- it is collected, as the label check, which goes in the next batch. step
-- says which call the pending row waits on. reading_output is the model's
-- policy reading as JSON, kept while the label check waits, so the Worker
-- reads the same statements from the staged files when the check is sent
-- and when it comes back. The labels JSON now holds each label's
-- description too.
ALTER TABLE model_pending ADD COLUMN step TEXT NOT NULL DEFAULT 'reading' CHECK (step IN ('reading', 'labels'));
ALTER TABLE model_pending ADD COLUMN reading_output TEXT CHECK (reading_output IS NULL OR json_valid(reading_output));

-- The model's policy reading as JSON, beside the kept reading, so a seed
-- read again with the same docs gets a fresh label check from it, with no
-- new reading. Null for a reading kept before.
ALTER TABLE model_readings ADD COLUMN output TEXT CHECK (output IS NULL OR json_valid(output));
