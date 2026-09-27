// GitHub's search query language, for the qualifiers the app uses. A
// qualifier the fake doesn't know gets a 422 that says where to add it, so a
// test never passes on a query the fake quietly misread.

import {
  FakeError,
  closingReferences,
  findIssue,
  findRepoByFullName,
  fullName,
  key,
  type FakeState,
  type IssueRecord,
  type RepoRecord,
} from './state.ts';

interface Term {
  negate: boolean;
  qualifier: string | null;
  value: string;
}

// Each qualifier the fake knows, with the values it takes, or null for any.
type Grammar = Record<string, string[] | null>;

const ISSUE_GRAMMAR: Grammar = {
  in: null,
  repo: null,
  org: null,
  user: null,
  type: ['issue', 'pr', 'pull-request'],
  state: ['open', 'closed'],
  is: ['issue', 'pr', 'pull-request', 'open', 'closed', 'merged', 'unmerged', 'draft', 'public', 'private'],
  label: null,
  no: ['assignee', 'label'],
  author: null,
  assignee: null,
  linked: ['pr', 'issue'],
};

const REPO_GRAMMAR: Grammar = {
  fork: ['true', 'false', 'only'],
  repo: null,
  org: null,
  user: null,
  stars: null,
  pushed: null,
  created: null,
  archived: ['true', 'false'],
  is: ['public', 'private'],
  language: null,
};

function parseQuery(q: string, grammar: Grammar): Term[] {
  const terms: Term[] = [];
  for (const m of q.matchAll(/(-?)(?:([a-z-]+):("[^"]*"|\S+)|"([^"]*)"|(\S+))/gi)) {
    const negate = m[1] === '-';
    if (m[2] === undefined) {
      terms.push({ negate, qualifier: null, value: m[4] ?? m[5] ?? '' });
      continue;
    }
    const term = { negate, qualifier: m[2].toLowerCase(), value: (m[3] ?? '').replace(/^"|"$/g, '') };
    const values = grammar[term.qualifier];
    if (values === undefined || (values !== null && !values.includes(term.value.toLowerCase()))) {
      throw new FakeError('invalid', 'Validation Failed', [
        {
          resource: 'Search',
          field: 'q',
          code: 'invalid',
          message: `The GitHub fake does not support "${term.qualifier}:${term.value}" yet. Add it in packages/github-fake/src/search.ts.`,
        },
      ]);
    }
    terms.push(term);
  }
  return terms;
}

// Numbers and dates take GitHub's forms: 10, >10, >=10, <10, <=10, 10..50,
// 10..*, and the same with YYYY-MM-DD dates.
function inRange(actual: number, spec: string, parse: (s: string) => [number, number]): boolean {
  const range = /^(.+)\.\.(.+)$/.exec(spec);
  if (range) {
    const lo = range[1] === '*' ? -Infinity : parse(range[1] ?? '')[0];
    const hi = range[2] === '*' ? Infinity : parse(range[2] ?? '')[1];
    return actual >= lo && actual < hi;
  }
  const op = /^(>=|<=|>|<)?(.+)$/.exec(spec);
  const [start, end] = parse(op?.[2] ?? spec);
  switch (op?.[1]) {
    case '>=':
      return actual >= start;
    case '>':
      return actual >= end;
    case '<=':
      return actual < end;
    case '<':
      return actual < start;
    default:
      return actual >= start && actual < end;
  }
}

const number = (s: string): [number, number] => [Number(s), Number(s) + 1];

const date = (s: string): [number, number] => {
  const start = Date.parse(s);
  if (Number.isNaN(start)) throw new FakeError('invalid', `"${s}" is not a date.`);
  return [start, s.includes('T') ? start + 1 : start + 86_400_000];
};

function hasText(word: string, fields: (string | null)[]): boolean {
  return fields.join('\n').toLowerCase().includes(word.toLowerCase());
}

// An issue is linked to a PR when an open or merged PR says it closes it.
function linkedToPull(state: FakeState, repo: RepoRecord, issue: IssueRecord): boolean {
  return Object.values(state.repos).some((r) =>
    Object.values(r.issues).some(
      (pr) =>
        pr.pull !== null &&
        (pr.state === 'open' || pr.pull.mergedAt !== null) &&
        closingReferences(pr.body ?? '', fullName(r)).some(
          (ref) => findRepoByFullName(state, ref.repo) === repo && findIssue(repo, ref.number) === issue,
        ),
    ),
  );
}

function issueMatches(state: FakeState, repo: RepoRecord, issue: IssueRecord, term: Term, inFields: string[]) {
  const value = term.value.toLowerCase();
  switch (term.qualifier) {
    case null:
      return hasText(term.value, inFields.map((f) => (f === 'title' ? issue.title : f === 'body' ? issue.body : null)));
    case 'repo':
      return key(fullName(repo)) === value;
    case 'org':
    case 'user':
      return key(repo.owner) === value;
    case 'type':
      return value === 'issue' ? issue.pull === null : issue.pull !== null;
    case 'state':
      return issue.state === value;
    case 'is':
      if (value === 'issue') return issue.pull === null;
      if (value === 'pr' || value === 'pull-request') return issue.pull !== null;
      if (value === 'open' || value === 'closed') return issue.state === value;
      if (value === 'merged') return issue.pull !== null && issue.pull.mergedAt !== null;
      if (value === 'unmerged') return issue.pull !== null && issue.state === 'closed' && issue.pull.mergedAt === null;
      if (value === 'draft') return issue.pull?.draft === true;
      return value === 'public';
    case 'label':
      return value.split(',').some((name) => issue.labels.some((l) => key(l) === name));
    case 'no':
      return value === 'assignee' ? issue.assignees.length === 0 : issue.labels.length === 0;
    case 'author':
      return key(issue.user) === value;
    case 'assignee':
      return issue.assignees.some((a) => key(a) === value);
    case 'linked':
      return value === 'pr'
        ? issue.pull === null && linkedToPull(state, repo, issue)
        : issue.pull !== null && closingReferences(issue.body ?? '', fullName(repo)).length > 0;
    default:
      return true;
  }
}

// https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
export function searchIssues(state: FakeState, q: string): { repo: RepoRecord; issue: IssueRecord }[] {
  const terms = parseQuery(q, ISSUE_GRAMMAR);
  const kind = terms.some(
    (t) =>
      !t.negate &&
      (t.qualifier === 'is' || t.qualifier === 'type') &&
      ISSUE_GRAMMAR.type?.includes(t.value.toLowerCase()),
  );
  if (!kind) throw new FakeError('invalid', "Query must include 'is:issue' or 'is:pull-request'");
  const inFields = terms.find((t) => t.qualifier === 'in')?.value.toLowerCase().split(',') ?? ['title', 'body'];
  const results: { repo: RepoRecord; issue: IssueRecord }[] = [];
  for (const repo of Object.values(state.repos)) {
    for (const issue of Object.values(repo.issues)) {
      if (terms.every((term) => issueMatches(state, repo, issue, term, inFields) !== term.negate)) {
        results.push({ repo, issue });
      }
    }
  }
  return results;
}

function repoMatches(repo: RepoRecord, term: Term): boolean {
  const value = term.value.toLowerCase();
  switch (term.qualifier) {
    case null:
      return hasText(term.value, [repo.name, repo.description]);
    case 'repo':
      return key(fullName(repo)) === value;
    case 'org':
    case 'user':
      return key(repo.owner) === value;
    case 'stars':
      return inRange(repo.stars, value, number);
    case 'pushed':
      return inRange(Date.parse(repo.pushedAt), value, date);
    case 'created':
      return inRange(Date.parse(repo.createdAt), value, date);
    case 'archived':
      return repo.archived === (value === 'true');
    case 'is':
      return value === 'public';
    case 'language':
      return key(repo.language ?? '') === value;
    default:
      return true;
  }
}

// https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories
// Forks are left out unless the query asks for them, as on GitHub.
export function searchRepos(state: FakeState, q: string): RepoRecord[] {
  const terms = parseQuery(q, REPO_GRAMMAR);
  const forks = terms.find((t) => t.qualifier === 'fork')?.value.toLowerCase() ?? 'false';
  return Object.values(state.repos).filter((repo) => {
    if (forks === 'false' && repo.forkOf !== null) return false;
    if (forks === 'only' && repo.forkOf === null) return false;
    return terms.every((term) => repoMatches(repo, term) !== term.negate);
  });
}
