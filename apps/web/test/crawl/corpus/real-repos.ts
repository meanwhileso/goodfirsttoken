import type { CrawlTier, PolicyFileKind } from '../../../src/crawl/rules';

// Real repos, by name and commit, with the verdict an admin gave. Their
// text isn't copied into this repo: the eval fetches each file from
// raw.githubusercontent.com at the commit when it runs. These start with
// the projects listed on goodfirsttoken.org on November 5, 2026, which are
// public, and Omarchy at a commit that holds the line that paused it. A
// rejected find joins only when an admin adds it.
//
// Each lists the files the crawler reads, in its order, apart from agent
// skills, which the eval leaves out to keep a run's cost down.

export interface RealRepo {
  repo: string;
  commit: string;
  files: { kind: PolicyFileKind; path: string }[];
  /** The tiers that match the admin's verdict. */
  tiers: readonly CrawlTier[];
  verdict: string;
}

/** A listed project must not read as a ban, which would pause it. */
const LISTED: readonly CrawlTier[] = ['invites_agents', 'allows_with_conditions', 'no_policy'];
const LISTED_VERDICT = 'Listed by an admin. It must not read as a ban, which would pause it.';

export const REAL_REPOS: RealRepo[] = [
  {
    repo: 'omacom/omarchy',
    commit: '09fa23e8291c7210c117867f5fd9c9fca51c5f09',
    files: [
      { kind: 'agents', path: 'AGENTS.md' },
      { kind: 'claude', path: 'CLAUDE.md' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/bug.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/config.yml' },
    ],
    tiers: LISTED,
    verdict: 'Approved by an admin, then paused by the rules over "does not run graphical acceptance tests", and resumed by hand.',
  },
  {
    repo: 'antirez/ds4',
    commit: 'b3f50180ec2c7324892be1f50bc83555ccb8d5e7',
    files: [{ kind: 'contributing', path: 'CONTRIBUTING.md' }],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
  {
    repo: 'gastownhall/beads',
    commit: 'ac3416ced777f1a25d6c910bce1781241ec1757b',
    files: [
      { kind: 'contributing', path: 'CONTRIBUTING.md' },
      { kind: 'agents', path: 'AGENTS.md' },
      { kind: 'claude', path: 'CLAUDE.md' },
      { kind: 'prTemplate', path: '.github/PULL_REQUEST_TEMPLATE.md' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/bug_report.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/config.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/feature_request.yml' },
    ],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
  {
    repo: 'meanwhileso/goodfirsttoken',
    commit: '322e64f1a887b9cd13633e23fda8ad118f44b2da',
    files: [
      { kind: 'contributing', path: 'CONTRIBUTING.md' },
      { kind: 'agents', path: 'AGENTS.md' },
      { kind: 'prTemplate', path: '.github/pull_request_template.md' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/bug.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/config.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/feature.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/harness.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/remove-my-project.yml' },
    ],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
  {
    repo: 'openclaw/openclaw',
    commit: '0947d02be82f53560936c656311acd43fb965f7c',
    files: [
      { kind: 'contributing', path: 'CONTRIBUTING.md' },
      { kind: 'agents', path: 'AGENTS.md' },
      { kind: 'prTemplate', path: '.github/pull_request_template.md' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/bug_report.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/config.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/docs_bug_report.yml' },
      { kind: 'issueTemplate', path: '.github/ISSUE_TEMPLATE/feature_request.yml' },
    ],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
  {
    repo: 'oven-sh/bun',
    commit: 'b1305ddc7ceebad383019d796d1367cc68f66ba0',
    files: [
      { kind: 'contributing', path: 'CONTRIBUTING.md' },
      { kind: 'agents', path: 'AGENTS.md' },
      { kind: 'claude', path: 'CLAUDE.md' },
      { kind: 'prTemplate', path: '.github/pull_request_template.md' },
    ],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
  {
    repo: 'tonyminibot/Vikey',
    commit: '350efb25f49f1462814f69532c55c6e80ab4eb90',
    files: [
      { kind: 'contributing', path: 'CONTRIBUTING.md' },
      { kind: 'prTemplate', path: '.github/pull_request_template.md' },
    ],
    tiers: LISTED,
    verdict: LISTED_VERDICT,
  },
];
