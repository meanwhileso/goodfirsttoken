# Hold what fails a check, out of the admin queue

Status: approved on November 8, 2026. This changes the admin queue and the
hourly approval [#191](https://github.com/meanwhileso/goodfirsttoken/pull/191)
added. The listing rules in [v1](v1.md) and the
[model policy reader](model-policy-reader.md) still apply.

## Why

Since #191, a crawler find with more than 100 stars is listed on its own
when the model's reading of its docs has none of the reasons to wait. Every
other find still waits in the admin queue, and so does every policy change.
The admin reads them one by one, and most stay for the same reasons each
time: no tags, a statement that failed its check, or a line that keeps agents
from working on their own.

The admin's queue should hold only what needs a person: registrations,
requests to be removed, and the pauses Good First Token made. A find or a
policy change that fails a check is held out of the queue, and the crawler
checks it again each month.

## The checks

**A find** is listed on its own when all of these hold:

- Its repo had more than 100 stars when the crawler read it.
- The model read the docs it was found in, and its two tiers agree.
- No statement failed its check against the files.
- The docs have no lines that try to steer a reader, no canary, and no line
  that keeps agents from working on their own.
- It has tags.
- The repo is not a project already.
- Listing it from its policy succeeds, checked on GitHub with the service
  token, as an admin's approval checks it.

**A policy change** is applied on its own when all of these hold:

- The weekly read found a changed policy. A change for docs the reader
  couldn't read fails. A change for a ban a second reading didn't confirm
  is neither applied nor held. It stays in the admin queue, since its
  listing may now ban AI help, and a held change only changes when the
  docs do.
- The docs give a policy to list from.
- The model made it, and its reading passes the same checks as a find's.
- The repo had more than 100 stars when the crawler read it.
- Listing the project from its new policy succeeds, as an admin's approval
  of the change lists it. The tier is the one the model read, and the
  settings stay as they are.

## What happens

The approval runs on the crawler's hourly cron, after the model policy
reader's run, as it does since #191. It checks the finds and policy changes
that wait and aren't held, oldest first.

- One that passes is listed, or applied, named for the first admin in
  `ADMIN_GITHUB_IDS` who has signed in. Its reason says it was approved on its
  own.
- One that fails is held. It keeps its status, `waiting`, and records when
  it was held and why.
- A GitHub failure that is the token's, a rate limit, or GitHub's own error
  holds nothing. The run stops, and the next hour checks again.
- At most 50 a run are checked on GitHub, finds and policy changes
  together. One held before GitHub is asked uses none of the 50.

## Checking again each month

- **A held find** is dropped 30 days after it was held, and its repo goes
  back in the crawl queue. The crawler reads its facts, labels, and docs
  again, and a new find goes through the hourly approval. The model reads
  the docs again only when they changed, and checks the labels each time.
  While the model reads nothing, a held find stays held. A repo the crawler now leaves out,
  as archived, or docs that no longer welcome AI help, makes no new find.
- **A held policy change** stops being held 30 days after it was held, and
  the next hourly run checks it again. Its facts and reading are the ones
  the weekly read sent, so only a GitHub refusal that changed moves it. A weekly read that finds the docs
  changed replaces it, as it replaces any change that waits, and the new
  change is checked within the hour.

## What the admin sees

- `admin_queue` leaves held items out. With `held: true`, it lists only the
  held finds and policy changes, each with when it was held, why, and when
  the crawler checks it again.
- `admin_decide` approves or rejects a held item as it does any other. Its
  rejection is kept, so a find whose docs read the same doesn't come back.
- The `/admin` page shows the queue without held items, and says how many
  are held.

## What stays

- Registrations, requests to be removed, pauses, and policy changes for a
  ban a second reading didn't confirm wait for an admin as before. A ban the model reads, with a second reading that agrees, still
  pauses the listing at once.
- A listing whose policy change is held stays listed as it was, as it did
  while the change waited in the queue.
- No admin who has signed in means nothing is approved and nothing is held.

## Migration

One migration adds `held_at` and `held_why` to `crawl_candidates` and to
`policy_changes`. Both are null for an item that isn't held. At the first
hourly run after the deploy, every find and policy change that waits is
checked, and each is approved, applied, or held.
