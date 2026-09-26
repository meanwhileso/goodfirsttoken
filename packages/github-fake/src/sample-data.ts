// The sample people and repos, in one place. Tests, the local GitHub fake,
// and `pnpm seed` all start from this. The names come from the prototype in
// prototype/. Every ID, number, date, issue, and file below is made up for
// tests and local development, and says nothing about the real accounts or
// projects that share a name.
//
// Times are written as how long ago they happened, like '2h' or '9y', so the
// data stays recent whenever it is loaded.

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
  { login: 'jdconley', id: 1007, name: 'JD Conley', created: '12y' },
  { login: 'octo-maintainer', id: 1008, name: 'Octo Maintainer', created: '10y' },
];

export const orgs: SampleAccount[] = [
  { login: 'meanwhileso', id: 2001, name: 'Meanwhile', created: '1y' },
  { login: 'cloudflare', id: 2002, name: 'Cloudflare', created: '14y' },
  { login: 'omacom', id: 2003, name: 'omacom', created: '2y' },
  { login: 'vitejs', id: 2004, name: 'Vite', created: '6y' },
  { login: 'harbor-dev', id: 2005, name: 'Harbor', created: '9y' },
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
    owner: 'meanwhileso',
    name: 'goodfirsttoken',
    description: 'The site, MCP server, and agent skills behind Good First Token.',
    language: 'TypeScript',
    license: 'MIT',
    stars: 240,
    created: '30d',
    pushed: '1h',
    collaborators: { jdconley: 'admin', 'octo-maintainer': 'admin', kenji: 'write' },
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
        number: 12,
        title: "Show each agent's name in the live lanes",
        body: 'Each lane on an issue page should say which agent is working, next to the person.',
        author: 'jdconley',
        labels: ['goodfirsttoken'],
        created: '6d',
      },
      {
        number: 18,
        title: 'Stream /live as NDJSON',
        body: 'The live feed has a plain-text stream at /live.txt. Programs would rather read JSON. Add /live.ndjson that emits one JSON object per event, with the same fields and the same ?since= backfill.',
        author: 'jdconley',
        labels: ['help wanted'],
        created: '5d',
      },
      {
        number: 21,
        title: 'Explain the tough badge on hover',
        body: 'Say what the tough badge means when someone hovers over it.',
        author: 'jdconley',
        labels: ['goodfirsttoken'],
        created: '4d',
      },
      {
        number: 25,
        title: 'Add Cursor to the install tabs',
        body: 'The setup list on the homepage has no tab for Cursor yet.',
        author: 'jdconley',
        labels: ['goodfirsttoken'],
        created: '4d',
      },
    ],
    pulls: [
      {
        number: 49,
        title: 'Reduced-motion support for the feed',
        body: 'The live feed stops typing lines out when the reader asks for reduced motion.',
        author: 'ines',
        branch: 'reduced-motion',
        files: { 'apps/web/src/feed/motion.ts': 'export const typeLines = !reducedMotion;\n' },
        created: '3d',
        merged: { by: 'jdconley', at: '3d' },
      },
      {
        number: 52,
        title: 'Copy button on every command',
        body: 'Every command on the site gets a copy button.',
        author: 'kenji',
        branch: 'copy-buttons',
        files: { 'apps/web/src/copy.ts': 'export const copy = (text: string) => text;\n' },
        created: '2d',
        merged: { by: 'jdconley', at: '1d' },
      },
      {
        number: 57,
        title: 'Stream /live as NDJSON',
        body: 'Closes #18\n\nAdds /live.ndjson, one JSON object per event.\n\nAssisted-by: Claude Code',
        author: 'priya',
        branch: 'live-ndjson',
        files: {
          'apps/web/src/feed/format.ts':
            'export function toNdjson(event: { text: string }) {\n  return `${JSON.stringify(event)}\\n`;\n}\n',
        },
        created: '2h',
        reviews: [
          {
            author: 'jdconley',
            state: 'CHANGES_REQUESTED',
            body: 'Can the formatter skip events with an empty text field? Otherwise looks good.',
            comments: [{ path: 'apps/web/src/feed/format.ts', line: 2, body: 'This writes events with empty text too.' }],
            submitted: '1h',
          },
        ],
      },
      {
        number: 58,
        title: 'Add Cursor to the install tabs',
        body: 'Closes #25\n\nAssisted-by: Cursor',
        author: 'arjun',
        branch: 'cursor-tab',
        files: { 'README.md': '# Good First Token\n\nSpend your spare tokens on open source. Works in Cursor.\n' },
        created: '1h',
      },
    ],
  },
  {
    owner: 'cloudflare',
    name: 'vinext',
    description: null,
    language: null,
    license: null,
    stars: 5000,
    created: '1y',
    pushed: '3h',
    labels: defaultLabels,
    files: { 'README.md': '# vinext\n\nSample repo for tests.\n' },
    issues: [
      {
        number: 311,
        title: 'Handle trailing slashes in rewrites',
        body: 'Sample issue for tests.',
        author: 'octo-maintainer',
        labels: ['help wanted'],
        created: '9d',
      },
    ],
    pulls: [
      {
        number: 309,
        title: 'Keep query strings on rewritten routes',
        body: 'Sample pull request for tests.',
        author: 'priya',
        branch: 'keep-query',
        files: { 'src/rewrite.ts': 'export const keepQuery = true;\n' },
        created: '2d',
        merged: { by: 'octo-maintainer', at: '1d' },
      },
    ],
  },
  {
    owner: 'omacom',
    name: 'omarchy',
    description: null,
    language: null,
    license: null,
    stars: 8000,
    created: '2y',
    pushed: '5h',
    labels: [...defaultLabels, { name: 'ready', color: 'e244c0', description: null }],
    files: { 'README.md': '# omarchy\n\nSample repo for tests.\n' },
    issues: [
      {
        number: 1431,
        title: 'Suspend fails on the second resume',
        body: 'Sample issue for tests.',
        author: 'octo-maintainer',
        labels: ['ready'],
        created: '20d',
      },
      {
        number: 1440,
        title: 'Lock screen ignores the keyboard layout',
        body: 'Sample issue for tests.',
        author: 'octo-maintainer',
        labels: ['ready'],
        created: '12d',
      },
    ],
  },
  {
    // Listed, with nothing tagged yet.
    owner: 'cloudflare',
    name: 'workers-sdk',
    description: null,
    language: null,
    license: null,
    stars: 3000,
    created: '6y',
    pushed: '2h',
    labels: defaultLabels,
    files: { 'README.md': '# workers-sdk\n\nSample repo for tests.\n' },
  },
  {
    // Found by the crawler and waiting for an admin.
    owner: 'vitejs',
    name: 'vite',
    description: null,
    language: null,
    license: null,
    stars: 83000,
    created: '6y',
    pushed: '2h',
    labels: [...defaultLabels, { name: 'contribution welcome', color: 'a9fcd9', description: null }],
    files: { 'README.md': '# vite\n\nSample repo for tests.\n' },
  },
  {
    // A registration waiting for an admin. Its default branch is not main.
    owner: 'harbor-dev',
    name: 'harbor',
    description: 'A sample project for tests and local development.',
    language: 'Go',
    license: 'MIT',
    stars: 4200,
    created: '5y',
    pushed: '3h',
    defaultBranch: 'develop',
    collaborators: { 'octo-maintainer': 'admin' },
    labels: defaultLabels,
    files: {
      'README.md': '# Harbor\n\nA sample project for tests and local development.\n',
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
];

export const sampleData: SampleData = { people, orgs, repos, oauthApps: [localOAuthApp] };
