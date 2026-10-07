# Crawler priority implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement these tasks in order. Follow test-driven-development and verification-before-completion. A fresh reviewer checks spec compliance before a fresh reviewer checks code quality.

**Goal:** Discover popular projects early and prioritize seeds with verified maintainer activity on X while broad discovery keeps advancing.

**Architecture:** Keep the current producer and consumer. Add an independent bounded popular search checkpoint and a ledger of successfully queued repos keyed to the broad pass. Store admin-verified evidence with seeds and compute freshness when choosing due seeds or reading admin detail.

**Tech stack:** TypeScript, Zod, Cloudflare Workers, D1, Vitest in the Workers runtime, the GitHub fake, and the existing skill builder.

The approved requirements are in `docs/specs/crawler-priority.md`. The two implementation issues are #112 and #113. Keep one PR per issue. Leave the policy classifier unchanged.

## Task 1. Popular search, issue #112

Files:

- Add `apps/web/migrations/0014_popular_crawls.sql` for popular checkpoints and successful-send records.
- Add `apps/web/src/db/popular-crawls.ts` for the checkpoint and ledger. Export it from `apps/web/src/db/index.ts`.
- Change `apps/web/src/crawl/search.ts` to schedule the sample and share deduplication across all producer paths.
- Add behavior tests in `apps/web/test/crawl/crawl.test.ts` and `apps/web/test/db/crawl.test.ts`.
- Update the crawler sections in `docs/how-it-works.md`, `docs/architecture.md`, and the M7 row in `ROADMAP.md`.

- [ ] Write tests before production edits. Use the existing `fill`, `sent`, GitHub fake, real test D1, and fake clock. Assert an unfinished broad pass still permits a descending popular query, and a run with `maxCalls: 3` performs broad search before popular search. Test next-run resumption, cap at ten pages, incomplete responses, failed queue sends, concurrent CAS, same-name case folding, successful-send deduplication, failure-window redelivery, and existing consumer idempotence.

```ts
const run = await fill({ leave: 0.1, maxCalls: 3 });
expect(run.calls).toBeLessThanOrEqual(3);
const searches = record.filter((url) => url.includes('/search/repositories'));
expect(new URL(searches[0]!).searchParams.get('order')).toBe('asc');
expect(new URL(searches[1]!).searchParams.get('order')).toBe('desc');
expect(new URL(searches[1]!).searchParams.get('q')).toContain('stars:>=10000');
```

- [ ] Run `pnpm --filter @goodfirsttoken/web test test/crawl/crawl.test.ts test/db/crawl.test.ts`. Confirm the new assertions fail because the sample and ledger are absent.
- [ ] Add the checkpoint data interface and D1 migration. Follow `startCrawlPass` and `moveCrawlPass`: guard against concurrent unfinished starts, and CAS from page and queued count. Store start time, pushed-since time, pool count, page, queued count, and finish time. Ledger keys are broad pass start time and case-insensitive repo name. Insert only after `sendBatch` succeeds.

```ts
interface PopularCrawlPass {
  startedAt: number;
  pushedSince: number;
  pool: number | null;
  page: number;
  queued: number;
  finishedAt: number | null;
}
```

- [ ] Start or load both passes before producer work. Seed and weekly steps keep their order. Check GitHub's shared allowance once. Advance one broad search, at most four popular searches, then broad until the existing allowance stops it. Popular queries use descending stars, 10,000 minimum, the sample's fixed push date, and 100 results per page. Finish after ten pages or the actual result count.
- [ ] Filter previously recorded successful sends before seeds and each search send. Record the actual sent names under the latest broad pass. Preserve seed handling and existing skip checks. Retain the current at-least-once behavior if a send succeeds and later state recording fails. Cleanup only completed old scopes that no active popular work still uses.
- [ ] Run the focused tests again, then `pnpm check` and `pnpm test`. Update docs with limits and FIFO semantics. Have a fresh agent compare against issue #112 and the spec, then a fresh code reviewer inspect correctness and tests. Reproduce any confirmed bug with a failing test before fixing it.
- [ ] Commit with `Assisted-by: Codex (GPT-6)`, open a PR for #112, and include review findings, fixes, and any justified drops.

## Task 2. Verified X evidence, issue #113

Files:

- Add `packages/core/src/crawl-priority.ts`, exported from `packages/core/src/index.ts`, for the evidence schema and pure qualification function.
- Change `packages/core/src/crawl.ts` and `packages/core/src/tools/admin.ts` for seed and candidate evidence results and evidence-bearing seed inputs.
- Add `apps/web/migrations/0015_crawl_priority.sql`; change `apps/web/src/db/seeds.ts` for evidence storage and due-seed ordering.
- Change `apps/web/src/admin/actions.ts` and the candidate component under `apps/web/src/components/` to save and display evidence with admin permission. Preserve queue comparators and cursors.
- Pass the producer clock into due-seed selection in `apps/web/src/crawl/search.ts`.
- Add schema tests under `packages/core/test/`, D1 tests under `apps/web/test/db/`, and permission, waiting-candidate, detail, and cursor tests under `apps/web/test/mcp/` and `apps/web/test/admin/`.
- Change `skill-src/admin.md`, `skill-src/plugins.json`, and generated skill outputs. Update how-it-works, architecture, and ROADMAP.

- [ ] Write a fixture and failing boundary tests before production edits. Evidence includes repo stars, public/archive state, push time, repo metadata check time, maintainer GitHub login, role source URL, identity source URL, X handle, authored post URL, publication time and precision, evidence check time, optional relationship note, and the verifier set by the server.

```ts
const checked = Date.UTC(2026, 9, 7);
const day = 86_400_000;
const qualifies = (evidence: CrawlPriorityEvidence) =>
  qualifiesForCrawlPriority(evidence, checked);
expect(qualifies({ ...evidence, stars: 10000 })).toBe(true);
expect(qualifies({ ...evidence, stars: 9999 })).toBe(false);
expect(qualifies({ ...evidence, postAt: checked - 90 * day - 1 })).toBe(false);
expect(qualifies({ ...evidence, metadataCheckedAt: checked - 30 * day - 1 })).toBe(false);
```

- [ ] Run the focused core and Worker tests. Confirm missing evidence behavior produces failing assertions.
- [ ] Implement a strict bounded Zod input schema. Validate HTTPS source URLs, safe public hostnames, no embedded credentials, X handles, post author and numeric status ID, authored post kind, date-only UTC midnight, and time ordering. Reject future publication and checked timestamps against the action clock. The server stamps the verifier. Store URLs without fetching them.
- [ ] Store evidence as validated JSON with the seed. Old rows have null evidence. Preserve `addedBy`, `addedAt`, `handledAt`, and `outcome` on updates and clear. For a waiting candidate with no seed, create a handled seed with outcome `proposed`. Refuse do-not-list evidence writes, retain other ordinary skips, and make no policy read.
- [ ] Select due seeds with fresh qualifying evidence first, then current oldest-first order and repo tie breaker. Apply the limit after qualification sorting. Treat expired, insufficient, or absent evidence as ordinary. Recompute qualification on admin reads. Show evidence in seed results and candidate detail without changing chronological pagination or public project data.
- [ ] Test non-admin and unauthenticated refusal, malformed evidence, waiting-candidate writes, no arbitrary fetches, history preservation, clear behavior, priority ordering, expiry, and unchanged cursor pages. Add an admin page rendering check for evidence links and status.
- [ ] Teach the skill to verify a person's project role, follow an official identity link to X, inspect a recent authored public post, save date precision, and keep policy eligibility separate. Build generated artifacts with `pnpm skills:build` after raising affected plugin versions.
- [ ] Run focused tests, `pnpm check`, `pnpm test`, and relevant skill harness checks. Review spec compliance, then code quality with fresh agents. Confirm findings and fix real bugs with failing tests. Commit and open a separate PR closing #113 with the review report and AI disclosure.

## Finish

- [ ] Check both PR diffs and checks against the approved Done-when list.
- [ ] Keep production policy and listing decisions separate from discovery priority.
- [ ] Report precisely what is implemented, tested, awaiting merge, and deployed.
