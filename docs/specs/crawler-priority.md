# Prioritize popular projects with maintainers active on X

Status: approved on October 7, 2026. This changes discovery order. The policy and listing rules
in [v1](v1.md) still apply.

## Why

The crawler searches public repos with at least 1,000 stars and a push in the
30 days before a pass starts. It walks upward from the smallest star counts.
Popular projects arrive late in a pass. It has no evidence about a maintainer's
activity on X.

Keep that broad search. Add an early sample of popular repos, and give seeds
with verified maintainer activity priority over other seeds. Popularity and
X activity affect discovery order. Every listing still needs
the project's written AI policy and an admin's decision.

## Choices

Use a separate popular search and a small roster verified by the admin's agent.
This works with the existing GitHub token and public browser research. The
Worker can rank recorded evidence without a paid X API or a browser runtime.

A seed roster alone helps today, but does not discover new popular repos.
Requiring X activity for every repo would remove broad discovery and treat
unavailable evidence as a refusal. Keep both searches and make X an optional
priority signal.

## Priority evidence

A seed qualifies when all these facts hold at the time it is queued:

- Its latest checked GitHub metadata says it is public, unarchived, has at
  least 10,000 stars, and was pushed in the last 30 days.
- A named person is a maintainer, creator, or owner of this repo or its owning
  organization. Record a public source that states that relationship.
  A contributor count or an organization membership alone is insufficient.
- A public GitHub profile, repo file, or official project page links that
  person to the X account. Matching display names alone is insufficient.
- The account has an authored public post in the last 90 days. Record the
  post URL and its publication time. A quote post with the person's own
  words counts. A bare repost, a follower count, or an old pinned post does
  not count as evidence of recent activity.
- The repo and role evidence were checked within the last 30 days. Checking
  an old post again does not extend its 90-day window.

Compare timestamps with the run's clock. Reject future publication times.
Use exact UTC timestamps when available. If only a date is visible, use the
start of that UTC date, which expires conservatively. A relative date must
be resolved during research and saved as a timestamp with its precision.

One qualifying person is enough. The admin agent checks public profiles in
its normal research flow and records the evidence. The Worker does not claim
to verify X activity from GitHub's `twitter_username` field alone. That field
is an identity lead. Failed or blocked X reads mean unknown activity. They do
not remove a seed, exclude a search result, or affect an existing listing.

Store the evidence in D1 with the seed: repo metadata and checked time,
maintainer GitHub login, role source URL, identity source URL, X handle,
post URL, post time and precision, verifier admin, and evidence checked time.
Accept only public GitHub, X, or HTTPS source URLs. The Worker validates and
stores them without fetching arbitrary URLs. Store an optional short note
for the relationship. Keep operational evidence on admin surfaces.

Saving new evidence upserts the seed without erasing its handling history.
Evidence alone does not requeue a seed already handled in this pass. An admin
can clear the priority evidence while keeping the ordinary seed. Old seeds
migrate with no evidence and retain their current behavior.

## Producer order

Keep the hourly cron, queue consumer, monthly broad passes, weekly listed
project reads, and service token limits. The producer does these steps:

1. Queue due seeds, qualifying ones first. Within each group use the existing
   oldest-first order and repo name as the tie breaker.
2. Queue listed projects due for their weekly policy read.
3. Spend one search call advancing the broad pass when it has work left.
4. Spend at most four search calls advancing the popular sample.
5. Spend the remaining allowed search calls advancing the broad pass.

Both searches share the existing allowance of 20 GitHub calls per run and
leave the existing share of the token budget for other jobs. The rate-limit
check counts toward the allowance. If fewer calls are available, the broad
call comes first. A full popular sample or repeated priority evidence updates
cannot prevent broad progress or listed project reads.

The popular sample searches `stars:>=10000`, `archived:false`, `is:public`,
with the same pushed-since date rule. Sort by stars descending and request
100 repos per page. Save a separate checkpoint with the start time,
pushed-since date, next page, total count, queued count, and finish time.
Start the first popular sample on the next cron even if the broad pass is
already in progress. Start another only after the previous sample finishes
and at least 30 days have passed since it started.

Read at most 10 pages, or fewer when GitHub has fewer results. This is an
intentional sample of the first 1,000 popular results, matching
[GitHub's search limit](https://docs.github.com/en/rest/search/search#about-search).
Log the total and the sample cap separately. Do not claim full coverage of
repos above 10,000 stars. The broad band search continues to cover that pool.
The page order is subject to GitHub's changing search index, as today.

Incomplete results, malformed responses, rate limits, and queue send failures
leave the affected search checkpoint at the last successful page. Use the
existing compare-and-swap pattern for concurrent runs. Preserve the current
at-least-once queue behavior and consumer idempotence.

Record repos queued by either search or the seed step for the active broad
pass. Deduplicate by canonical repo name without case across those paths.
After a successful send is recorded, a later seed step or search page counts
the result as seen without sending it again. A crash after sending but before
recording, or concurrent sends before either is recorded, can still duplicate
messages. Keep at-least-once delivery and idempotent candidate insertion.
Deduplication avoids repeat work across recorded paths. Delivery remains
at least once. Keep records until
the broad pass finishes and the overlapping popular sample no longer needs
them. The consumer checks do-not-list, listed projects, and proposed finds
again, including messages queued before a maintainer asked for removal.
Rejected finds retain the existing reread behavior.

Use the latest broad pass's `startedAt` as the deduplication scope for all
three paths in a producer run, including when that pass has finished. If a
new broad pass starts during an unfinished popular sample, subsequent popular
pages use the new broad-pass scope. Keep the popular page checkpoint and its
pushed-since date. Retire the old scope's records once its broad pass is done
and the popular sample has finished or switched to the new scope.

The existing queue is FIFO. This changes the order of new work entering it.
It does not move messages already queued. Report backlog when showing how
soon a newly prioritized seed will be read.

## Admin research and review

Extend the seed tool with an optional evidence record and a way to clear it.
Require the existing admin permission. Validate lengths, timestamps, source
URLs, and the post URL's author against the X handle. Ordinary seed calls
continue to work.

An evidence-bearing call can also update a waiting candidate. Handle this
before the existing `leftAlone: proposed` return. Create a seed with handling
time set to now and outcome `proposed` when none exists, or preserve the
existing seed's handling history. Return the saved evidence and `leftAlone:
proposed`. Do not queue another policy read. Evidence writes for a repo on
the do-not-list are refused, including when a waiting candidate exists.
Ordinary seed calls keep their current skips. Already listed projects and
repos with only decided candidates retain their skips for evidence writes.

Show the evidence and its freshness in seed results and waiting candidate
detail. Store or reference evidence so a candidate can show why it was
prioritized after its seed was handled. Recompute current qualification when
reading the admin queue. Keep its existing chronological ordering, mixed-kind
ordering, page size, and cursors. Expiration changes the displayed priority
status. It does not reject a candidate or change its place in the admin queue.

Teach the admin skill to research popular results, verify role and identity,
read a recent authored post, save the evidence, and review AI policy separately.
A discovery priority never changes policy tiers, PR mode, issue tags, or the
need for an admin's listing decision. This task sends no outreach messages.

## Work order

Use two implementation issues after this spec is approved. Each owns its tests
and updates to how-it-works and architecture. ROADMAP.md places them in M7.

1. Add the bounded popular sample, its independent checkpoint, shared-budget
   scheduling, cross-path deduplication, and logs. This can proceed while the
   policy classifier fixes in #76 and #77 are open.
2. Add verified X evidence to seeds and admin results, seed priority ordering,
   freshness rules, and the admin research skill. Build generated skills and
   raise affected plugin versions under CONTRIBUTING.md. This follows item 1.

Classifier fixes #76 and #77 stay separate. Discovery can queue a repo whose
policy the classifier misses. Admin evidence about popularity and X activity
must never substitute for a correct policy verdict.

## Done when

- A popular sample starts while an older broad pass is unfinished, reads its
  highest-star results, and resumes at its saved page on the next run.
- A sample above 1,000 results stops at 10 pages, reports the cap, and still
  leaves the broad checkpoint advancing under a constrained call allowance.
- Failed queue sends and incomplete searches do not advance the checkpoint.
  Concurrent cron runs do not corrupt either checkpoint.
- Recorded seed, popular, and broad sends prevent later paths from sending
  the same repo in that broad pass. A failure after sending and before
  recording may redeliver it. Tests cover that window, concurrent runs, and
  idempotent candidate insertion. Listed projects, proposed finds, and
  do-not-list entries keep their skips.
- A recently checked repo with 10,000 stars and a verified maintainer's recent
  authored post receives priority. A repo with 9,999 stars does not.
- An old post, bare repost, mismatched author, future date, stale repo check,
  or unverified role does not confer priority. Unknown X activity keeps normal
  discovery. Boundary times and date-only precision expire as specified.
- Expiration and clearing evidence preserve seed handling history and do not
  change policy, candidate verdicts, or public listings.
- Evidence can be saved for an existing waiting candidate without another
  policy read. Ordinary seed calls still skip it. Do-not-list takes precedence.
- Admin queue detail shows evidence without exposing it on public project
  pages. Existing chronological pagination remains unchanged when evidence
  is added or expires. Unauthenticated and non-admin writes are refused.
- Behavior tests, `pnpm check`, and the relevant skill harness checks pass.
  A fresh agent reviews each implementation against this list.
