import { GitHubError, gitHubQuery, gitHubRead, type GitHubPage, type GraphQLResult, type RateLimit } from '../github';

// The jobs' calls to GitHub, all with the read-only service token. The
// token's budget is GitHub's for its account, 5,000 REST calls and 5,000
// GraphQL points an hour, and every job that uses the token shares it. So a
// run keeps count of its calls, reads what GitHub says is left after each
// one, and stops before a call when less is left than its job leaves for
// the others. A job that stops early saves what it has done, and its next
// run picks up from there.

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
  /** GitHub couldn't be reached, or answered with an error of its own. */
  | 'github_error';

export class SyncStopped extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason, message: string) {
    super(message);
    this.name = 'SyncStopped';
    this.reason = reason;
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

  /** Reads one page of a REST path, or stops the run. */
  async read<T>(path: string): Promise<GitHubPage<T>> {
    this.before(REST);
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
    const limited = result.errors.find((error) => error.type === 'RATE_LIMITED');
    if (limited) throw new SyncStopped('rate_limited', `GitHub refused a query for the rate limit: ${limited.message}`);
    return { data: result.data, errors: result.errors };
  }

  private before(resource: string): void {
    if (this.calls >= this.allowance.maxCalls) {
      throw new SyncStopped('calls', `The run made ${String(this.calls)} calls to GitHub, as many as one run makes.`);
    }
    const budget = this.budgets.get(resource);
    // A budget whose hour is over has started again.
    if (budget && budget.resetAt > this.now() && budget.remaining < budget.limit * this.allowance.leave) {
      throw new SyncStopped(
        'budget',
        `GitHub has ${String(budget.remaining)} of ${String(budget.limit)} ${resource} calls left this hour, and the run leaves the rest for other jobs.`,
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
      return new SyncStopped('github_error', `GitHub could not be reached: ${why}`);
    }
    this.note(error.rateLimit);
    if (error.status === 401) return new SyncStopped('bad_token', 'GitHub refused the service token (401).');
    if (error.rateLimited) return new SyncStopped('rate_limited', `GitHub refused a call for the rate limit: ${error.message}`);
    if (error.status >= 500) return new SyncStopped('github_error', `GitHub answered ${String(error.status)}: ${error.message}`);
    return error;
  }
}
