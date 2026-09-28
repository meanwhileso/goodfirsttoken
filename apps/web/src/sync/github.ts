import { GitHubError, gitHubQuery, gitHubRead, type GitHubPage, type GraphQLResult, type RateLimit } from '../github';

// The jobs' calls to GitHub, all with the read-only service token. The
// token's budget is GitHub's for its account, and every job that uses the
// token shares it. So a run first asks GitHub what is left, which costs
// nothing, keeps count of its calls, reads what GitHub says is left after
// each one, and stops before a call when less is left than its job leaves
// for the others. A job that stops early saves what it has done, and its
// next run picks up from there. The rules are under Tagged issues in
// docs/how-it-works.md.

/** Why a run stopped before it finished. */
export type StopReason =
  /** GitHub said less is left of the hour's budget than the job leaves for others. */
  | 'budget'
  /** The run made as many calls as one run may. */
  | 'calls'
  /** GitHub refused a call because the budget ran out, or asked to slow down. */
  | 'rate_limited'
  /** GitHub refused the service token. */
  | 'bad_token'
  /** GitHub couldn't be reached, answered with an error of its own, or answered in a form GitHub doesn't use. */
  | 'github_error';

export class SyncStopped extends Error {
  readonly reason: StopReason;
  /**
   * When the budget that stopped the run starts over, in milliseconds since
   * the epoch, when GitHub said. Null for any other stop.
   */
  readonly resetAt: number | null;

  constructor(reason: StopReason, message: string, resetAt: number | null = null) {
    super(message);
    this.name = 'SyncStopped';
    this.reason = reason;
    this.resetAt = resetAt;
  }
}

/** How much of the token's budget a job may spend in one run. */
export interface Allowance {
  /**
   * The share of the hour's limit the job leaves for the other jobs. Before
   * each call, the run stops when GitHub last said less than this is left.
   */
  leave: number;
  /** The most calls one run makes, which keeps it inside Cloudflare's limit on subrequests. */
  maxCalls: number;
}

/** GitHub's name for the budget REST calls count against. */
const REST = 'core';
/** GitHub's name for the budget GraphQL queries count against. */
const GRAPHQL = 'graphql';
/** GitHub's name for the budget search calls count against, which starts over each minute. */
const SEARCH = 'search';

// https://docs.github.com/en/rest/rate-limit/rate-limit#get-rate-limit-status-for-the-authenticated-user
interface RateLimitStatus {
  resources?: Record<string, { limit?: unknown; remaining?: unknown; reset?: unknown } | undefined>;
}

/** A GraphQL error that says GitHub is limiting the rate, primary or secondary. */
function limitsRate(error: { type?: string; message: string }): boolean {
  return error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message);
}

export class ServiceGitHub {
  /** Calls this run made. */
  calls = 0;
  private readonly budgets = new Map<string, RateLimit>();
  private readonly token: string;
  private readonly allowance: Allowance;
  private readonly now: () => number;

  constructor(token: string, allowance: Allowance, now: () => number = Date.now) {
    this.token = token;
    this.allowance = allowance;
    this.now = now;
  }

  /** What GitHub last said is left of each budget the run used, by resource. */
  left(): Record<string, number> {
    return Object.fromEntries([...this.budgets].map(([resource, budget]) => [resource, budget.remaining]));
  }

  /**
   * Asks GitHub what is left of the token's budgets, which costs none of
   * them, so the run knows before its first read. Stops the run when the
   * answer isn't one GitHub gives, so an API that isn't GitHub's, or a proxy
   * in front of it, never gets read as GitHub.
   */
  async checkGitHub(): Promise<void> {
    let data: RateLimitStatus;
    try {
      ({ data } = await this.read<RateLimitStatus>('/rate_limit'));
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      throw new SyncStopped('github_error', `GitHub's API answered ${String(error.status)} when asked its rate limit.`);
    }
    const budgetOf = (resource: string): RateLimit | null => {
      const found = data.resources?.[resource];
      const [limit, remaining, reset] = [found?.limit, found?.remaining, found?.reset];
      if (typeof limit !== 'number' || typeof remaining !== 'number' || typeof reset !== 'number') return null;
      return { resource, limit, remaining, resetAt: reset * 1000 };
    };
    const budgets = [REST, GRAPHQL].map(budgetOf);
    if (budgets.some((budget) => budget === null)) {
      throw new SyncStopped('github_error', "GitHub's API answered its rate limit in a form GitHub doesn't use.");
    }
    // Only the crawler searches, so a job reads on when GitHub leaves the
    // search budget out, and the first search's headers give it.
    for (const budget of [...budgets, budgetOf(SEARCH)]) this.note(budget);
  }

  /** Reads one page of a REST path, or stops the run. A search counts against the search budget. */
  async read<T>(path: string): Promise<GitHubPage<T>> {
    this.before(path.startsWith('/search/') ? SEARCH : REST);
    try {
      const page = await gitHubRead<T>(this.token, path);
      this.note(page.rateLimit);
      return page;
    } catch (error) {
      throw this.failed(error);
    }
  }

  /** Runs a GraphQL query, or stops the run. */
  async query<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResult<T>> {
    this.before(GRAPHQL);
    let result: GraphQLResult<T> & { rateLimit: RateLimit | null };
    try {
      result = await gitHubQuery<T>(this.token, query, variables);
    } catch (error) {
      throw this.failed(error);
    }
    this.note(result.rateLimit);
    const limited = result.errors.find(limitsRate);
    if (limited) {
      throw new SyncStopped(
        'rate_limited',
        `GitHub refused a query for the rate limit: ${limited.message}`,
        result.rateLimit?.resetAt ?? null,
      );
    }
    return { data: result.data, errors: result.errors };
  }

  private before(resource: string): void {
    if (this.calls >= this.allowance.maxCalls) {
      throw new SyncStopped('calls', `The run made ${String(this.calls)} calls to GitHub, as many as one run makes.`);
    }
    const budget = this.budgets.get(resource);
    // A budget whose time is up has started again.
    if (budget && budget.resetAt > this.now() && budget.remaining < budget.limit * this.allowance.leave) {
      throw new SyncStopped(
        'budget',
        `GitHub has ${String(budget.remaining)} of ${String(budget.limit)} ${resource} calls left until it starts over, and the run leaves the rest for other jobs.`,
        budget.resetAt,
      );
    }
    this.calls += 1;
  }

  private note(budget: RateLimit | null): void {
    if (budget) this.budgets.set(budget.resource, budget);
  }

  /**
   * What a failed call means for the run: it stops when GitHub refused the
   * token, limited the rate, or couldn't be reached. Any other refusal goes
   * back to the caller, who knows what a 404 means.
   */
  private failed(error: unknown): unknown {
    if (!(error instanceof GitHubError)) {
      const why = error instanceof Error ? error.message : String(error);
      return new SyncStopped('github_error', `GitHub could not be reached, or answered what isn't JSON: ${why}`);
    }
    this.note(error.rateLimit);
    if (error.status === 401) return new SyncStopped('bad_token', 'GitHub refused the service token (401).');
    if (error.rateLimited) {
      const wait = error.retryAfter === null ? null : this.now() + error.retryAfter * 1000;
      return new SyncStopped(
        'rate_limited',
        `GitHub refused a call for the rate limit: ${error.message}`,
        wait ?? error.rateLimit?.resetAt ?? null,
      );
    }
    if (error.status >= 500) return new SyncStopped('github_error', `GitHub answered ${String(error.status)}: ${error.message}`);
    return error;
  }
}
