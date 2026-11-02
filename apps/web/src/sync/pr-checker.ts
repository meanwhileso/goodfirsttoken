import { DurableObject } from 'cloudflare:workers';
import { id, mustParse, type PrRecord } from '@goodfirsttoken/core';
import { getPr } from '../db';
import { ServiceGitHub, type Allowance } from './github';
import { BATCH, checkClaimPrs } from './prs';

// The checks donors ask for with check_pr (src/mcp/check.ts). The donor's
// agent reads their PRs on GitHub with the donor's own account, and asks
// for a check only when one changed: it merged, closed, or has new reviews.
// So the service token reads GitHub only when there is something to find.
// The server never takes the agent's word. It reads the PR with the
// service token and records only what GitHub shows, the way the PR job
// does (src/sync/prs.ts).
//
// One PrChecker serves the whole site, so its limits are global, and every
// check waits its turn in the same place:
//
// - One read at a time, and a read starts at most every 2 seconds. The
//   checks that come in while one waits or runs go together into the next,
//   up to 50 PRs in one GraphQL query.
// - At most 300 reads in any hour, counted in storage, so the count
//   survives the object being moved or restarted.
// - A read starts only while GitHub says at least half the token's hourly
//   budget is left, so the scheduled jobs always have theirs.
// - A PR read in the last 30 seconds isn't read again.
// - At most 200 PRs wait at a time.
//
// A check past these limits is answered `later`, and the PR job, which
// reads every open PR twice an hour, reads it then. The rules are in
// docs/how-it-works.md, under Checked on request in PRs.

/** How a check went: read now, read in the last 30 seconds and not again, or left for the PR job. */
export type CheckOutcome = 'now' | 'recently' | 'later';

/** The least time between the starts of two reads. */
export const CHECK_GAP_MS = 2_000;
/** The most reads in any hour. */
export const CHECK_READS_PER_HOUR = 300;
/** How long a PR just read isn't read again. */
export const CHECK_RECENT_MS = 30_000;
/** The most PRs that wait for a read at a time. */
export const CHECK_MAX_WAITING = 200;
/**
 * What one read may spend of the service token's budget: it leaves half the
 * hour's limit for the other jobs, and makes two calls, GitHub's rate limit,
 * which costs nothing, and the query.
 */
export const CHECK_ALLOWANCE: Allowance = { leave: 0.5, maxCalls: 2 };

const HOUR = 60 * 60 * 1000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS reads (at INTEGER NOT NULL) STRICT;`;

/** The one checker for the whole site. */
export function prChecker(namespace: DurableObjectNamespace<PrChecker>): DurableObjectStub<PrChecker> {
  return namespace.getByName('global');
}

export class PrChecker extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The claims whose PR waits for a read, in the order asked, each with the checks that wait for it. */
  private readonly waiting = new Map<string, ((outcome: CheckOutcome) => void)[]>();
  /** When each claim's PR was last read, while it counts as recent. */
  private readonly lastRead = new Map<string, number>();
  /** When the last read started. */
  private lastStart = 0;
  /** The loop that reads what waits, while it runs. */
  private draining: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /**
   * Reads the claim's PR on GitHub with the service token, with the next
   * read, and records what GitHub shows. The caller checked that the claim
   * is theirs and has a PR.
   */
  async check(claimId: string): Promise<CheckOutcome> {
    const claim = mustParse(id, claimId, 'claimId');
    const now = Date.now();
    for (const [read, at] of this.lastRead) if (now - at >= CHECK_RECENT_MS) this.lastRead.delete(read);
    if (this.lastRead.has(claim)) return 'recently';
    const waiters = this.waiting.get(claim);
    if (waiters === undefined && this.waiting.size >= CHECK_MAX_WAITING) return 'later';
    const outcome = new Promise<CheckOutcome>((resolve) => {
      if (waiters) waiters.push(resolve);
      else this.waiting.set(claim, [resolve]);
    });
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return outcome;
  }

  /** Reads what waits, a batch at a time, each read at least 2 seconds after the last one started. */
  private async drain(): Promise<void> {
    while (this.waiting.size > 0) {
      const wait = this.lastStart + CHECK_GAP_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const batch = [...this.waiting].slice(0, BATCH);
      for (const [claim] of batch) this.waiting.delete(claim);
      let outcomes = new Map<string, CheckOutcome>();
      try {
        outcomes = await this.read(batch.map(([claim]) => claim));
      } catch (error) {
        console.error('A check of PRs failed. The PR job reads them on its next run.', error);
      }
      for (const [claim, waiters] of batch) for (const resolve of waiters) resolve(outcomes.get(claim) ?? 'later');
    }
  }

  /** Reads the claims' PRs in one query, when the hour has a read left. Gives `now` for each PR GitHub gave. */
  private async read(claims: readonly string[]): Promise<Map<string, CheckOutcome>> {
    const token = this.env.GH_SERVICE_TOKEN ? this.env.GH_SERVICE_TOKEN : null;
    if (token === null) return new Map();
    const records = (await Promise.all(claims.map((claim) => getPr(this.env.DB, claim)))).filter(
      (record): record is PrRecord => record !== null,
    );
    if (records.length === 0) return new Map();
    const start = Date.now();
    if (!this.takeRead(start)) {
      console.warn(`A check of PRs was left for the PR job. ${String(CHECK_READS_PER_HOUR)} reads ran in the last hour.`);
      return new Map();
    }
    this.lastStart = start;
    const github = new ServiceGitHub(token, CHECK_ALLOWANCE);
    const { read } = await checkClaimPrs({ db: this.env.DB, rooms: this.env.ISSUE_ROOM, github, now: () => Date.now() }, records);
    for (const claim of read) this.lastRead.set(claim, start);
    return new Map([...read].map((claim) => [claim, 'now']));
  }

  /** Counts a read against the last hour, or says no when the hour's reads are spent. */
  private takeRead(now: number): boolean {
    this.sql.exec('DELETE FROM reads WHERE at <= ?', now - HOUR);
    const row = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reads').one();
    if (row.n >= CHECK_READS_PER_HOUR) return false;
    this.sql.exec('INSERT INTO reads (at) VALUES (?)', now);
    return true;
  }
}
