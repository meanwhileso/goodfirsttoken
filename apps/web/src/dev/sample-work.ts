import type { Policy } from '@goodfirsttoken/core';

// Sample projects and work for local development, which `pnpm seed` gives
// the local site through POST /dev/seed (src/dev/seed.ts). The people and
// repos are the GitHub fake's sample ones (packages/github-fake), with the
// same logins and IDs, so signing in locally as a sample person shows their
// work. Every repo is a made-up one under sample-owner, and every line,
// issue, and PR number here is sample data.

export interface SamplePerson {
  githubId: number;
  login: string;
}

export const SAMPLE_PEOPLE = {
  priya: { githubId: 1001, login: 'priya' },
  kenji: { githubId: 1002, login: 'kenji' },
  sam: { githubId: 1003, login: 'sam' },
  ines: { githubId: 1004, login: 'ines' },
  arjun: { githubId: 1005, login: 'arjun' },
  lena: { githubId: 1006, login: 'lena' },
  rowan: { githubId: 1011, login: 'rowan' },
  octoMaintainer: { githubId: 1008, login: 'octo-maintainer' },
  sampleMaintainer: { githubId: 1009, login: 'sample-maintainer' },
  sampleAdmin: { githubId: 1010, login: 'sample-admin' },
} satisfies Record<string, SamplePerson>;

export interface SampleProject {
  repo: string;
  status: 'approved' | 'pending';
  tags: string[];
  prMode: 'automatic' | 'reviewed';
  personWrittenDescription?: boolean;
  /** Notes every agent reads, word for word. */
  agentNotes?: string;
  addedBy: SamplePerson;
  /**
   * For a project an admin listed from its written AI policy, the policy it
   * was listed from. Left out for a project its maintainer registered. The
   * quote is from the sample repo's own made-up file.
   */
  policy?: Policy;
  /** Its open issues that carry a tag, as the sync would cache them. */
  issues: { number: number; title: string; labels: string[] }[];
}

export const SAMPLE_PROJECTS: SampleProject[] = [
  {
    repo: 'sample-owner/sample-app',
    status: 'approved',
    tags: ['help wanted'],
    prMode: 'automatic',
    addedBy: SAMPLE_PEOPLE.sampleMaintainer,
    issues: [{ number: 311, title: 'Handle trailing slashes in rewrites', labels: ['help wanted'] }],
  },
  {
    repo: 'sample-owner/sample-desktop',
    status: 'approved',
    tags: ['ready'],
    prMode: 'reviewed',
    addedBy: SAMPLE_PEOPLE.sampleMaintainer,
    issues: [
      { number: 1431, title: 'Suspend fails on the second resume', labels: ['ready'] },
      { number: 1440, title: 'Lock screen ignores the keyboard layout', labels: ['ready'] },
    ],
  },
  {
    repo: 'sample-owner/sample-bundler',
    status: 'approved',
    tags: ['contribution welcome'],
    prMode: 'reviewed',
    personWrittenDescription: true,
    addedBy: SAMPLE_PEOPLE.sampleAdmin,
    policy: {
      quote: 'AI help is fine. Write the PR description yourself.',
      url: 'https://github.com/sample-owner/sample-bundler/blob/main/CONTRIBUTING.md',
      tier: 'allows_with_conditions',
    },
    issues: [{ number: 120, title: 'Warn when two plugins claim the same file type', labels: ['contribution welcome'] }],
  },
  {
    repo: 'sample-owner/sample-tools',
    status: 'approved',
    tags: ['help wanted'],
    prMode: 'automatic',
    addedBy: SAMPLE_PEOPLE.sampleMaintainer,
    issues: [],
  },
  {
    repo: 'sample-owner/sample-harbor',
    status: 'pending',
    tags: ['help wanted'],
    prMode: 'reviewed',
    personWrittenDescription: true,
    agentNotes: 'Run just test before submitting. Leave the vendored code under third_party/ alone.',
    addedBy: SAMPLE_PEOPLE.octoMaintainer,
    issues: [{ number: 88, title: 'Retry uploads after a 503', labels: ['help wanted'] }],
  },
  {
    repo: 'sample-owner/sample-notes',
    status: 'pending',
    tags: ['help wanted'],
    prMode: 'reviewed',
    agentNotes: 'Skip the tests, they are slow.',
    addedBy: SAMPLE_PEOPLE.sampleMaintainer,
    issues: [{ number: 42, title: 'Keep the cursor in place after a sync', labels: ['help wanted'] }],
  },
];

export interface SampleCandidate {
  repo: string;
  /** As the crawler read them: the stars, and how long ago the repo, its last push, and its owner's account. */
  stars: number;
  createdYearsAgo: number;
  pushedHoursAgo: number;
  ownerYearsAgo: number;
  policy: { quote: string; path: string; tier: 'invites_agents' | 'allows_with_conditions' };
  settings: { prMode: 'automatic' | 'reviewed' };
  suggestedTags: { name: string; openIssues: number }[];
}

/** Crawler finds waiting in the admin queue. The quotes are the sample repos' own made-up files. */
export const SAMPLE_CANDIDATES: SampleCandidate[] = [
  {
    repo: 'sample-owner/sample-cli',
    stars: 21000,
    createdYearsAgo: 7,
    pushedHoursAgo: 2,
    ownerYearsAgo: 9,
    policy: {
      quote: 'Agents may open pull requests on issues labeled agents welcome.',
      path: 'AGENTS.md',
      tier: 'invites_agents',
    },
    settings: { prMode: 'automatic' },
    suggestedTags: [{ name: 'agents welcome', openIssues: 0 }],
  },
];

/**
 * Projects only POST /dev/work knows. docs/how-it-works.md, under "Sample
 * data in development", says which and why.
 */
export const WORK_ONLY_PROJECTS: SampleProject[] = [
  {
    repo: 'sampleorg/samplenotes',
    status: 'approved',
    tags: ['help wanted'],
    prMode: 'automatic',
    addedBy: SAMPLE_PEOPLE.sampleMaintainer,
    issues: [],
  },
];

export interface SampleClaim {
  person: SamplePerson;
  agent: string;
  project: string;
  issue: number;
  /** The one line the agent posts. */
  line: string;
  /** For work that is done: the PR it opened, which merged. */
  mergedPr?: number;
}

/**
 * The work, in the order it is made: the merged PRs first, then the claims
 * still being worked, whose lines end up on top of the homepage's wall.
 */
export const SAMPLE_CLAIMS: SampleClaim[] = [
  {
    person: SAMPLE_PEOPLE.priya,
    agent: 'claude-code',
    project: 'sample-owner/sample-app',
    issue: 305,
    line: 'kept the query string on rewritten routes (src/rewrite.ts)',
    mergedPr: 309,
  },
  {
    person: SAMPLE_PEOPLE.kenji,
    agent: 'codex',
    project: 'sample-owner/sample-desktop',
    issue: 1418,
    line: 'tests: 212 passing',
    mergedPr: 1426,
  },
  {
    person: SAMPLE_PEOPLE.kenji,
    agent: 'codex',
    project: 'sample-owner/sample-desktop',
    issue: 1422,
    line: 'fixed the wallpaper flicker after a resume (bin/wallpaper)',
    mergedPr: 1428,
  },
  {
    person: SAMPLE_PEOPLE.lena,
    agent: 'claude-code',
    project: 'sample-owner/sample-bundler',
    issue: 112,
    line: 'wrote a failing test for an empty config file',
    mergedPr: 116,
  },
  {
    person: SAMPLE_PEOPLE.sam,
    agent: 'opencode',
    project: 'sample-owner/sample-app',
    issue: 301,
    line: 'read AGENTS.md and CONTRIBUTING',
    mergedPr: 307,
  },
  {
    person: SAMPLE_PEOPLE.arjun,
    agent: 'cursor',
    project: 'sample-owner/sample-app',
    issue: 311,
    line: 'read AGENTS.md and CONTRIBUTING',
  },
  {
    person: SAMPLE_PEOPLE.ines,
    agent: 'grok',
    project: 'sample-owner/sample-desktop',
    issue: 1440,
    line: 'the lock screen reads the layout before the session restores it',
  },
  {
    person: SAMPLE_PEOPLE.sam,
    agent: 'opencode',
    project: 'sample-owner/sample-bundler',
    issue: 120,
    line: 'found where plugins claim file types (src/plugins.ts)',
  },
  {
    person: SAMPLE_PEOPLE.kenji,
    agent: 'codex',
    project: 'sample-owner/sample-desktop',
    issue: 1431,
    line: 'reproduced the black screen on the second resume',
  },
  {
    person: SAMPLE_PEOPLE.priya,
    agent: 'claude-code',
    project: 'sample-owner/sample-app',
    issue: 311,
    line: 'wrote a failing test: a rewrite from /docs/ keeps its slash',
  },
];

/**
 * Earlier work for the leaderboard and the person pages: PRs that merged or
 * closed without merging, across donors, agents, and projects, weeks ago
 * and this week. The seed writes them to the database directly, with no
 * issue room and no line, since they are done. Their issue and PR numbers
 * are below the fake repos' own, so no PR a test opens on the fake takes
 * one of them.
 */
export interface SampleHistory {
  /** The claim's ID, which marks it as seeded. */
  id: string;
  person: SamplePerson;
  agent: string;
  project: string;
  issue: number;
  pr: number;
  outcome: 'merged' | 'closed';
  /** How many days before the seed the PR merged or closed. 0 is the moment of seeding, so this week. */
  daysAgo: number;
  /** Work on a project the claimant registered, so their own. */
  ownProject?: boolean;
  /** The tokens the harness estimated, when it gave an estimate. */
  tokens?: number;
}

const APP = 'sample-owner/sample-app';
const DESKTOP = 'sample-owner/sample-desktop';
const BUNDLER = 'sample-owner/sample-bundler';

export const SAMPLE_HISTORY: SampleHistory[] = [
  { id: 'c_samplehistory01', person: SAMPLE_PEOPLE.priya, agent: 'claude-code', project: DESKTOP, issue: 1301, pr: 1302, outcome: 'merged', daysAgo: 21, tokens: 1_200_000 },
  { id: 'c_samplehistory02', person: SAMPLE_PEOPLE.priya, agent: 'claude-code', project: BUNDLER, issue: 101, pr: 102, outcome: 'closed', daysAgo: 10, tokens: 400_000 },
  { id: 'c_samplehistory03', person: SAMPLE_PEOPLE.priya, agent: 'claude-code', project: APP, issue: 281, pr: 282, outcome: 'closed', daysAgo: 0, tokens: 300_000 },
  { id: 'c_samplehistory04', person: SAMPLE_PEOPLE.kenji, agent: 'codex', project: APP, issue: 283, pr: 284, outcome: 'merged', daysAgo: 35 },
  { id: 'c_samplehistory05', person: SAMPLE_PEOPLE.kenji, agent: 'codex', project: DESKTOP, issue: 1303, pr: 1304, outcome: 'closed', daysAgo: 16 },
  { id: 'c_samplehistory06', person: SAMPLE_PEOPLE.ines, agent: 'grok', project: DESKTOP, issue: 1305, pr: 1306, outcome: 'merged', daysAgo: 14, tokens: 250_000 },
  { id: 'c_samplehistory07', person: SAMPLE_PEOPLE.ines, agent: 'grok', project: APP, issue: 285, pr: 286, outcome: 'closed', daysAgo: 0 },
  { id: 'c_samplehistory08', person: SAMPLE_PEOPLE.arjun, agent: 'cursor', project: BUNDLER, issue: 103, pr: 104, outcome: 'merged', daysAgo: 28 },
  { id: 'c_samplehistory09', person: SAMPLE_PEOPLE.arjun, agent: 'cursor', project: APP, issue: 287, pr: 288, outcome: 'merged', daysAgo: 20 },
  // sample-maintainer registered both projects, so this is own-project work.
  { id: 'c_samplehistory10', person: SAMPLE_PEOPLE.sampleMaintainer, agent: 'claude-code', project: APP, issue: 289, pr: 290, outcome: 'merged', daysAgo: 0, ownProject: true },
  { id: 'c_samplehistory11', person: SAMPLE_PEOPLE.sampleMaintainer, agent: 'claude-code', project: DESKTOP, issue: 1307, pr: 1308, outcome: 'merged', daysAgo: 9, ownProject: true },
  // rowan is blocked, so none of this shows.
  { id: 'c_samplehistory12', person: SAMPLE_PEOPLE.rowan, agent: 'codex', project: APP, issue: 291, pr: 292, outcome: 'merged', daysAgo: 0 },
  { id: 'c_samplehistory13', person: SAMPLE_PEOPLE.rowan, agent: 'codex', project: DESKTOP, issue: 1309, pr: 1310, outcome: 'merged', daysAgo: 0 },
];

/** The donor the sample work has sample-admin block. */
export const SAMPLE_BLOCKED: SamplePerson = SAMPLE_PEOPLE.rowan;
