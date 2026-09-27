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
    addedBy: SAMPLE_PEOPLE.octoMaintainer,
    issues: [{ number: 88, title: 'Retry uploads after a 503', labels: ['help wanted'] }],
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
