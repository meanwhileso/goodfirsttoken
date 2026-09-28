// The sample people and repos, in one place. Tests, the local GitHub fake,
// and `pnpm seed` all start from this. They take the shapes of the
// prototype's sample data in prototype/: a project with tagged issues, one
// with nothing tagged yet, a popular repo that invites contributions,
// registrations waiting for an admin, and a repo the crawler finds.
//
// Every account and repo here is made up, except this project's own repo,
// meanwhileso/goodfirsttoken, and its owner. Its sample issues and PRs are
// numbered from 900 up, clear of its real ones. Every ID, number, date, and
// file below is sample data.
//
// Times are written as how long ago they happened, like '2h' or '9y', so the
// data stays recent whenever it is loaded.

import { policyOrgs, policyRepos } from './policy-samples.ts';

export type Ago = `${number}${'m' | 'h' | 'd' | 'y'}`;

export type SampleRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read';

export interface SampleAccount {
  login: string;
  id: number;
  name: string;
  created: Ago;
}

export interface SampleIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  created: Ago;
}

export interface SampleReview {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  comments?: { path: string; line: number; body: string }[];
  submitted: Ago;
}

// A PR from a branch in the repo when its author can push there, and from
// the author's fork when they can't.
export interface SamplePull {
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  files: Record<string, string>;
  created: Ago;
  merged?: { by: string; at: Ago };
  reviews?: SampleReview[];
}

export interface SampleRepo {
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  license: 'MIT' | null;
  stars: number;
  created: Ago;
  pushed: Ago;
  defaultBranch?: string;
  // Only the owner and collaborators see a private repo, through a token with
  // the repo scope.
  private?: boolean;
  archived?: boolean;
  hasPullRequests?: boolean;
  pullRequestCreationPolicy?: 'all' | 'collaborators_only';
  collaborators?: Record<string, SampleRole>;
  labels: { name: string; color: string; description: string | null; default?: boolean }[];
  files: Record<string, string>;
  issues?: SampleIssue[];
  pulls?: SamplePull[];
}

export interface SampleOAuthApp {
  name: string;
  clientId: string;
  clientSecret: string;
  // GitHub sends people back only to this URL or a path under it. A
  // localhost callback allows any port, like GitHub's loopback rule.
  callbackUrl: string;
}

export interface SampleData {
  people: SampleAccount[];
  orgs: SampleAccount[];
  repos: SampleRepo[];
  oauthApps: SampleOAuthApp[];
}

// Four of the labels GitHub gives every new repo.
const defaultLabels = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working", default: true },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation', default: true },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers', default: true },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed', default: true },
];


export const people: SampleAccount[] = [
  // Donors: they spend tokens on other people's issues.
  { login: 'priya', id: 1001, name: 'Priya', created: '6y' },
  { login: 'kenji', id: 1002, name: 'Kenji', created: '8y' },
  { login: 'sam', id: 1003, name: 'Sam', created: '4y' },
  { login: 'ines', id: 1004, name: 'Ines', created: '5y' },
  { login: 'arjun', id: 1005, name: 'Arjun', created: '3y' },
  { login: 'lena', id: 1006, name: 'Lena', created: '7y' },
  // Maintainers: they register projects and tag issues.
  { login: 'octo-maintainer', id: 1008, name: 'Octo Maintainer', created: '10y' },
  { login: 'sample-maintainer', id: 1009, name: 'Sample Maintainer', created: '9y' },
  // An admin of the site itself, who listed a project from its written AI
  // policy in the sample work. Local development makes this account an
  // admin (apps/web/src/auth/settings.ts), so the admin pages can be tried.
  { login: 'sample-admin', id: 1010, name: 'Sample Admin', created: '8y' },
];

export const orgs: SampleAccount[] = [
  { login: 'meanwhileso', id: 2001, name: 'Meanwhile', created: '1y' },
  { login: 'sample-owner', id: 2002, name: 'Sample Owner', created: '9y' },
];

// The OAuth app the fake knows. Local sign-in uses its client ID and secret.
export const localOAuthApp: SampleOAuthApp = {
  name: 'Good First Token (local)',
  clientId: 'goodfirsttoken-local',
  clientSecret: 'local-only-not-a-real-secret',
  callbackUrl: 'http://localhost/',
};

export const repos: SampleRepo[] = [
  {
    // This project, with tagged issues, open PRs, and merged ones. kenji can
    // push here, so his PRs come from branches in the repo.
    owner: 'meanwhileso',
    name: 'goodfirsttoken',
    description: 'The site, MCP server, and agent skills behind Good First Token.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 240,
    created: '30d',
    pushed: '1h',
    collaborators: { 'octo-maintainer': 'admin', kenji: 'write' },
    labels: [
      ...defaultLabels,
      { name: 'goodfirsttoken', color: '7057ff', description: 'Tagged for agents through Good First Token' },
    ],
    files: {
      'README.md': '# Good First Token\n\nSpend your spare tokens on open source.\n',
      'AGENTS.md': '# AGENTS.md\n\nRun pnpm test before you call it done. No em dashes.\n',
      'CONTRIBUTING.md':
        '# Contributing\n\n## AI help is welcome\n\nDisclose it with an Assisted-by: trailer.\n',
      '.github/pull_request_template.md': '## What changed\n\n## AI disclosure\n',
      '.github/workflows/ci.yml': 'name: CI\non: [pull_request]\n',
      'package.json': '{ "name": "goodfirsttoken", "private": true }\n',
      'apps/web/src/feed/live-text.ts':
        'export function toText(event: { text: string }) {\n  return event.text;\n}\n',
    },
    issues: [
      {
        number: 912,
        title: "Show each agent's name in the live lanes",
        body: 'Each lane on an issue page should say which agent is working, next to the person.',
        author: 'octo-maintainer',
        labels: ['goodfirsttoken'],
        created: '6d',
      },
      {
        number: 918,
        title: 'Stream /live as NDJSON',
        body: 'The live feed has a plain-text stream at /live.txt. Programs would rather read JSON. Add /live.ndjson that emits one JSON object per event, with the same fields and the same ?since= backfill.',
        author: 'octo-maintainer',
        labels: ['help wanted'],
        created: '5d',
      },
      {
        number: 921,
        title: 'Explain the tough badge on hover',
        body: 'Say what the tough badge means when someone hovers over it.',
        author: 'octo-maintainer',
        labels: ['goodfirsttoken'],
        created: '4d',
      },
      {
        number: 925,
        title: 'Add Cursor to the install tabs',
        body: 'The setup list on the homepage has no tab for Cursor yet.',
        author: 'octo-maintainer',
        labels: ['goodfirsttoken'],
        created: '4d',
      },
    ],
    pulls: [
      {
        number: 949,
        title: 'Reduced-motion support for the feed',
        body: 'The live feed stops typing lines out when the reader asks for reduced motion.',
        author: 'ines',
        branch: 'reduced-motion',
        files: { 'apps/web/src/feed/motion.ts': 'export const typeLines = !reducedMotion;\n' },
        created: '3d',
        merged: { by: 'octo-maintainer', at: '3d' },
      },
      {
        number: 952,
        title: 'Copy button on every command',
        body: 'Every command on the site gets a copy button.',
        author: 'kenji',
        branch: 'copy-buttons',
        files: { 'apps/web/src/copy.ts': 'export const copy = (text: string) => text;\n' },
        created: '2d',
        merged: { by: 'octo-maintainer', at: '1d' },
      },
      {
        number: 957,
        title: 'Stream /live as NDJSON',
        body: 'Closes #918\n\nAdds /live.ndjson, one JSON object per event.\n\nAssisted-by: Claude Code',
        author: 'priya',
        branch: 'live-ndjson',
        files: {
          'apps/web/src/feed/format.ts':
            'export function toNdjson(event: { text: string }) {\n  return `${JSON.stringify(event)}\\n`;\n}\n',
        },
        created: '2h',
        reviews: [
          {
            author: 'octo-maintainer',
            state: 'CHANGES_REQUESTED',
            body: 'Can the formatter skip events with an empty text field? Otherwise looks good.',
            comments: [{ path: 'apps/web/src/feed/format.ts', line: 2, body: 'This writes events with empty text too.' }],
            submitted: '1h',
          },
        ],
      },
      {
        number: 958,
        title: 'Add Cursor to the install tabs',
        body: 'Closes #925\n\nAssisted-by: Cursor',
        author: 'arjun',
        branch: 'cursor-tab',
        files: { 'README.md': '# Good First Token\n\nSpend your spare tokens on open source. Works in Cursor.\n' },
        created: '1h',
      },
    ],
  },
  {
    // A project whose docs welcome agent PRs, with a tagged issue and a PR
    // priya got merged.
    owner: 'sample-owner',
    name: 'sample-app',
    description: 'A sample app for tests and local development.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 5000,
    created: '1y',
    pushed: '3h',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: defaultLabels,
    files: {
      'README.md': '# sample-app\n\nA sample app for tests and local development.\n',
      'CONTRIBUTING.md': '# Contributing\n\n## AI\n\nThis app is built with AI. Agent pull requests are welcome.\n',
    },
    issues: [
      {
        number: 311,
        title: 'Handle trailing slashes in rewrites',
        body: 'A rewrite from /docs/ drops the trailing slash.',
        author: 'sample-maintainer',
        labels: ['help wanted'],
        created: '9d',
      },
    ],
    pulls: [
      {
        number: 309,
        title: 'Keep query strings on rewritten routes',
        body: 'Rewrites keep the query string.',
        author: 'priya',
        branch: 'keep-query',
        files: { 'src/rewrite.ts': 'export const keepQuery = true;\n' },
        created: '2d',
        merged: { by: 'sample-maintainer', at: '1d' },
      },
    ],
  },
  {
    // A project with its own label for work ready for outside help, an agent
    // skill that says how to contribute, and a vouch file in the format of
    // github.com/mitchellh/vouch: it vouches for kenji and lena, names priya
    // on another platform only, and denounces arjun.
    owner: 'sample-owner',
    name: 'sample-desktop',
    description: 'A sample desktop setup for tests and local development.',
    language: 'Shell',
    license: 'MIT',
    stars: 8000,
    created: '2y',
    pushed: '5h',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: [...defaultLabels, { name: 'ready', color: 'e244c0', description: null }],
    files: {
      'README.md': '# sample-desktop\n\nA sample desktop setup for tests and local development.\n',
      'agents/skills/sample-desktop/contributing.md':
        '# Contributing with an agent\n\nOpen the PR for a person to review.\n',
      '.github/VOUCHED.td': [
        '# People vouched for, or denounced, in this sample repo.',
        '#',
        '# One handle per line, without @, as platform:login or login.',
        '# A handle that starts with - is denounced. Details follow a space.',
        '-arjun opened agent PRs nobody had read',
        'github:kenji',
        'gitlab:priya',
        'lena',
        '',
      ].join('\n'),
    },
    issues: [
      {
        number: 1431,
        title: 'Suspend fails on the second resume',
        body: 'The second resume after a suspend leaves the screen black.',
        author: 'sample-maintainer',
        labels: ['ready'],
        created: '20d',
      },
      {
        number: 1440,
        title: 'Lock screen ignores the keyboard layout',
        body: 'The lock screen switches to the default layout after a resume.',
        author: 'sample-maintainer',
        labels: ['ready'],
        created: '12d',
      },
    ],
  },
  {
    // A project with nothing tagged yet.
    owner: 'sample-owner',
    name: 'sample-tools',
    description: 'Sample tools for tests and local development.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 3000,
    created: '6y',
    pushed: '2h',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: defaultLabels,
    files: {
      'README.md': '# sample-tools\n\nSample tools for tests and local development.\n',
      '.github/pull_request_template.md': '## What changed\n\nAgents are welcome to open this PR.\n',
    },
  },
  {
    // A popular repo with its own label for outside help, and a CONTRIBUTING
    // that allows AI help with conditions.
    owner: 'sample-owner',
    name: 'sample-bundler',
    description: 'A sample bundler for tests and local development.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 12000,
    created: '6y',
    pushed: '2h',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: [...defaultLabels, { name: 'contribution welcome', color: 'a9fcd9', description: null }],
    files: {
      'README.md': '# sample-bundler\n\nA sample bundler for tests and local development.\n',
      'CONTRIBUTING.md': '# Contributing\n\n## AI policy\n\nAI help is fine. Write the PR description yourself.\n',
    },
    issues: [
      {
        number: 120,
        title: 'Warn when two plugins claim the same file type',
        body: 'Two plugins can both claim .md files, and the second wins without a word.',
        author: 'sample-maintainer',
        labels: ['contribution welcome'],
        created: '15d',
      },
    ],
  },
  {
    // A project its maintainer registered, waiting for an admin. Its default
    // branch is develop.
    owner: 'sample-owner',
    name: 'sample-harbor',
    description: 'A sample upload service for tests and local development.',
    language: 'Go',
    license: 'MIT',
    stars: 4200,
    created: '5y',
    pushed: '3h',
    defaultBranch: 'develop',
    collaborators: { 'octo-maintainer': 'admin' },
    labels: defaultLabels,
    files: {
      'README.md': '# sample-harbor\n\nA sample upload service for tests and local development.\n',
      'CONTRIBUTING.md':
        '# Contributing\n\n## AI\n\nAI help is welcome. Say so in the PR, and write the PR description yourself.\n',
      justfile: 'test:\n\tgo test ./...\n',
    },
    issues: [
      {
        number: 88,
        title: 'Retry uploads after a 503',
        body: 'Uploads give up on the first 503. Retry them with a backoff.',
        author: 'octo-maintainer',
        labels: ['help wanted'],
        created: '8d',
      },
    ],
  },
  {
    // A second registration waiting for an admin.
    owner: 'sample-owner',
    name: 'sample-notes',
    description: 'A sample notes app for tests and local development.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 900,
    created: '3y',
    pushed: '1d',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: defaultLabels,
    files: {
      'README.md': '# sample-notes\n\nA sample notes app for tests and local development.\n',
    },
    issues: [
      {
        number: 42,
        title: 'Keep the cursor in place after a sync',
        body: 'A sync moves the cursor to the end of the note.',
        author: 'sample-maintainer',
        labels: ['help wanted'],
        created: '6d',
      },
    ],
  },
  {
    // A popular repo whose AGENTS.md invites agent pull requests, which the
    // crawler finds and an admin reviews.
    owner: 'sample-owner',
    name: 'sample-cli',
    description: 'A sample command line tool for tests and local development.',
    language: 'Rust',
    license: 'MIT',
    stars: 21000,
    created: '7y',
    pushed: '2h',
    collaborators: { 'sample-maintainer': 'admin' },
    labels: [...defaultLabels, { name: 'agents welcome', color: '0e8a16', description: null }],
    files: {
      'README.md': '# sample-cli\n\nA sample command line tool for tests and local development.\n',
      'AGENTS.md': '# AGENTS.md\n\nAgents may open pull requests on issues labeled agents welcome.\n',
    },
  },
];

// The policy crawler's made-up repos live in policy-samples.ts, under
// sample-policies.
export const sampleData: SampleData = {
  people,
  orgs: [...orgs, ...policyOrgs],
  repos: [...repos, ...policyRepos],
  oauthApps: [localOAuthApp],
};
