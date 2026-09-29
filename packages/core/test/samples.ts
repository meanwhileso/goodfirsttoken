import type { z } from 'zod';
import type { ProjectSettingsInput, Tools } from '../src/index';

// One valid output for every tool, with text each rendering must include.

type Samples = { [N in keyof Tools]: { output: z.input<Tools[N]['output']>; mentions: string[] } };

const repo = 'meanwhileso/goodfirsttoken';
const issue = `${repo}#918`;
const title = 'Stream /live as NDJSON';
const url = `https://github.com/${repo}/issues/918`;
const liveUrl = `https://goodfirsttoken.test/${repo}/issues/918`;
const at = '2026-09-26T12:00:00.000Z';
const later = '2026-09-27T12:00:00.000Z';
const sha = '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
const pr = { repo, number: 957, url: `https://github.com/${repo}/pull/957` };

export const settings: ProjectSettingsInput = {
  tags: ['help wanted', 'goodfirsttoken'],
  prMode: 'automatic',
  agentNotes: 'Run pnpm test before submitting.',
};

const claim = {
  claimId: 'c_1',
  issue,
  title,
  url,
  liveUrl,
  state: 'active' as const,
  agent: 'claude-code',
  claimedAt: at,
  expiresAt: later,
};

const followUp = {
  claimId: 'c_0',
  issue: `${repo}#912`,
  title: 'Show each agent name in the live lanes',
  pr,
  reviewer: 'octo-maintainer',
  comment: 'Can the formatter skip events with an empty text field?',
  commentUrl: `${pr.url}#discussion_r1`,
};

const counts = { taggedIssues: 3, working: 2, openPrs: 1, merged: 14 };

export const samples: Samples = {
  start_session: {
    output: {
      sessionId: 's_1',
      login: 'priya',
      budget: { kind: 'issues', count: 3 },
      interests: { languages: ['typescript'], kinds: ['tests'] },
      followUps: [followUp],
      unfinishedClaims: [{ ...claim, state: 'paused' }],
      mergedPrs: [{ issue, title, pr, shareUrl: 'https://x.com/intent/post?text=merged' }],
    },
    mentions: [
      '@priya',
      '3 issues',
      'typescript',
      '@octo-maintainer asked for changes',
      'paused',
      'Share it',
      'Offer the follow-ups and paused claims first',
      'Resume a claim with claim_issue and its issue.',
    ],
  },
  suggest_issues: {
    output: {
      suggestions: [
        {
          issue,
          title,
          url,
          liveUrl,
          project: repo,
          tag: 'help wanted',
          prMode: 'automatic',
          claUrl: null,
          claimants: [{ login: 'kenji', agent: 'codex', state: 'active' }],
          slotsTaken: 1,
          slots: 3,
          timesClaimed: 6,
          tough: true,
        },
        {
          issue: 'sample-owner/sample-issues#7',
          title: 'Retry uploads after a 503',
          url: 'https://github.com/sample-owner/sample-issues/issues/7',
          liveUrl: 'https://goodfirsttoken.test/sample-owner/sample-issues/issues/7',
          project: 'sample-owner/sample-app',
          tag: 'ready',
          prMode: 'reviewed',
          claUrl: 'https://sample-owner.test/cla',
          claimants: [],
          slotsTaken: 0,
          slots: 3,
          timesClaimed: 0,
          tough: false,
        },
      ],
    },
    mentions: [
      issue,
      url,
      '1 of 3 slots taken: @kenji (codex)',
      'tough: claimed 6 times',
      'project: sample-owner/sample-app',
      'nobody on it',
      'CLA: https://sample-owner.test/cla',
    ],
  },
  claim_issue: {
    output: {
      claim,
      slotsTaken: 2,
      slots: 3,
      body: 'The live feed should also stream as NDJSON.',
      project: { repo, settings },
      clone: { url: `https://github.com/${repo}.git`, commit: sha },
      resumed: false,
      skipped: [
        {
          issue: `${repo}#921`,
          code: 'issue_full',
          message: `${repo}#921 has no open slot: 3 of 3 are taken. Pick another issue.`,
        },
      ],
      queued: [`${repo}#925`],
      budget: { issuesLeft: 2, endsAt: null },
    },
    mentions: [
      issue,
      sha,
      'Run pnpm test before submitting.',
      'Disclose AI use with the trailer Assisted-by on each commit.',
      'Disclose AI use with this in the PR body, word for word:\n  Written with a coding agent through Good First Token.',
      'NDJSON',
      `Skipped from the queue (1):\n  1  ${repo}#921 (issue_full)`,
      `Queued next (1): ${repo}#925.`,
      'claim the next with claim_issue and no issue',
      'Budget left: 2 issues.',
    ],
  },
  post_update: {
    output: { posted: true, waitSeconds: null, claimId: 'c_1', state: 'active', prOnIssue: null },
    mentions: ['Posted to claim c_1.'],
  },
  submit_work: {
    output: {
      claimId: 'c_1',
      issue,
      state: 'pr_opened',
      commit: { sha, url: `https://github.com/priya/goodfirsttoken/commit/${sha}` },
      branch: { repo: 'priya/goodfirsttoken', name: 'gft-918', url: 'https://github.com/priya/goodfirsttoken/tree/gft-918' },
      diffUrl: `https://github.com/priya/goodfirsttoken/compare/${sha}...gft-918`,
      pr,
      reviewReason: null,
    },
    mentions: ['4f2a91c', 'priya/goodfirsttoken:gft-918', pr.url],
  },
  release_claim: {
    output: { claimId: 'c_1', issue, state: 'released' },
    mentions: [issue, 'slot is open'],
  },
  my_work: {
    output: {
      followUps: [followUp],
      readyToOpen: [
        {
          claimId: 'c_2',
          issue,
          title,
          url,
          liveUrl,
          diffUrl: `https://github.com/${repo}/compare/main...priya:gft-918`,
          additions: 23,
          deletions: 4,
          agent: 'codex',
          model: 'gpt-5.5-codex',
          summary: 'Adds the NDJSON formatter.',
          checks: 'pnpm test (412 passing)',
          reviewReason: 'pr_exists',
          prOnIssue: { ...pr, number: 960, url: `https://github.com/${repo}/pull/960` },
          expiresAt: later,
          personWrittenDescription: true,
          openable: true,
          reason: null,
        },
      ],
      working: [{ ...claim, resumable: true, reason: null }],
    },
    mentions: [
      'asked for changes',
      '+23 -4',
      'codex (gpt-5.5-codex)',
      'waiting because a PR is already open on the issue',
      'summary: Adds the NDJSON formatter.',
      'pnpm test (412 passing)',
      `pull/960. Ask the donor whether a second PR helps.`,
      'Ask the donor to write the PR description.',
      'working',
    ],
  },
  open_pr: {
    output: { claimId: 'c_2', issue, state: 'pr_opened', pr, prOnIssue: null },
    mentions: ['PR #957', pr.url],
  },
  set_interests: {
    output: { interests: { languages: ['rust'], projects: [repo], kinds: ['docs'] } },
    mentions: ['rust', repo, 'docs'],
  },
  register_project: {
    output: {
      repo,
      saved: false,
      status: null,
      settings,
      reasons: [{ setting: 'prMode', reason: 'your CONTRIBUTING welcomes agent PRs' }],
      createdLabels: [],
    },
    mentions: ['Nothing is saved yet', 'automatic (your CONTRIBUTING welcomes agent PRs)', 'help wanted, goodfirsttoken'],
  },
  update_project: {
    output: { repo, status: 'approved', settings, changed: ['prMode', 'tags'], createdLabels: ['goodfirsttoken'] },
    mentions: ['Updated', 'prMode', `Created 1 label in ${repo}: goodfirsttoken.`],
  },
  project_status: {
    output: {
      repo,
      status: 'rejected',
      source: 'registered',
      statusReason: 'The notes ask agents to skip tests.',
      settings,
      counts,
      issuesReadAt: at,
      refresh: 'partly_read',
    },
    mentions: [
      'rejected',
      'The notes ask agents to skip tests.',
      '3 tagged issues',
      '14 merged',
      'Tagged issues last read from GitHub 2026-09-26 12:00 UTC.',
      'The next scheduled sync reads the rest.',
    ],
  },
  pause_project: {
    output: { repo, status: 'paused', changed: true, resumableBy: 'maintainers' },
    mentions: ['Paused', 'paused: false'],
  },
  admin_queue: {
    output: {
      items: [
        {
          id: 'cand_1',
          kind: 'candidate',
          repo: 'sample-owner/sample-app',
          requestedBy: null,
          requestedAt: at,
          facts: { stars: 1200, createdAt: at, pushedAt: at, ownerCreatedAt: at },
          factsMissing: null,
          settings: { prMode: 'reviewed' },
          policy: {
            quote: 'Agent pull requests are welcome once a person has read the diff.',
            url: 'https://github.com/sample-owner/sample-app/blob/main/CONTRIBUTING.md',
            tier: 'allows_with_conditions',
          },
          suggestedTags: [{ name: 'ready for help', openIssues: 8 }],
          onDoNotList: false,
        },
        {
          id: 'reg_7',
          kind: 'registration',
          repo: 'sample-owner/sample-harbor',
          requestedBy: 'octo-maintainer',
          requestedAt: later,
          facts: null,
          factsMissing: 'not_public',
          settings: { ...settings, tags: ['help wanted'] },
          policy: null,
          suggestedTags: [],
          onDoNotList: true,
        },
      ],
    },
    mentions: [
      'sample-owner/sample-app',
      'cand_1',
      '1,200 stars',
      'Agent pull requests are welcome once a person has read the diff.',
      'ready for help (8 open)',
      'reg_7',
      'from @octo-maintainer',
      'GitHub showed no public repo named sample-owner/sample-harbor when asked.',
      'on the do-not-list',
    ],
  },
  admin_decide: {
    output: { repo, kind: 'registration', status: 'approved' },
    mentions: ['Approved', repo],
  },
  admin_add_project: {
    output: { repo, status: 'approved', source: 'policy', updated: false },
    mentions: ['AI policy', repo],
  },
  admin_block_donor: {
    output: { login: 'spammer', blocked: true },
    mentions: ['@spammer', 'hidden'],
  },
  admin_pause_project: {
    output: { repo, status: 'paused', changed: true },
    mentions: ['Paused', repo, 'until an admin resumes it'],
  },
  admin_remove_project: {
    output: { repo, status: 'rejected' },
    mentions: ['Removed', repo, 'do-not-list'],
  },
};
