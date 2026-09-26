import type { z } from 'zod';
import type { ProjectSettingsInput, Tools } from '../src/index';

// One valid output for every tool, with text each rendering must include.

type Samples = { [N in keyof Tools]: { output: z.input<Tools[N]['output']>; mentions: string[] } };

const repo = 'meanwhileso/goodfirsttoken';
const issue = `${repo}#18`;
const title = 'Stream /live as NDJSON';
const url = `https://github.com/${repo}/issues/18`;
const liveUrl = `https://goodfirsttoken.test/${repo}/issues/18`;
const at = '2026-09-26T12:00:00.000Z';
const later = '2026-09-27T12:00:00.000Z';
const sha = '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
const pr = { repo, number: 57, url: `https://github.com/${repo}/pull/57` };

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
  issue: `${repo}#12`,
  title: 'Show each agent name in the live lanes',
  pr,
  reviewer: 'jdconley',
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
    mentions: ['@priya', '3 issues', 'typescript', '@jdconley asked for changes', 'paused', 'Share it'],
  },
  suggest_issues: {
    output: {
      suggestions: [
        {
          issue,
          title,
          url,
          liveUrl,
          tag: 'help wanted',
          prMode: 'automatic',
          claimants: [{ login: 'kenji', agent: 'codex', state: 'active' }],
          slots: 3,
          timesClaimed: 6,
          tough: true,
        },
      ],
    },
    mentions: [issue, url, '1 of 3 slots taken: @kenji (codex)', 'tough: claimed 6 times'],
  },
  claim_issue: {
    output: {
      claim,
      slotsTaken: 2,
      slots: 3,
      body: 'The live feed should also stream as NDJSON.',
      project: { repo, settings },
      clone: { url: `https://github.com/${repo}.git`, commit: sha },
    },
    mentions: [issue, sha, 'Run pnpm test before submitting.', 'Disclose AI use: Assisted-by trailer on each commit, and one line in the PR body.', 'NDJSON'],
  },
  post_update: {
    output: { posted: true, waitSeconds: null, claimId: 'c_1', state: 'active', prOnIssue: null },
    mentions: ['Posted.'],
  },
  submit_work: {
    output: {
      claimId: 'c_1',
      issue,
      state: 'pr_opened',
      commit: { sha, url: `https://github.com/priya/goodfirsttoken/commit/${sha}` },
      branch: { repo: 'priya/goodfirsttoken', name: 'gft-18', url: 'https://github.com/priya/goodfirsttoken/tree/gft-18' },
      pr,
      reviewReason: null,
    },
    mentions: ['4f2a91c', 'priya/goodfirsttoken:gft-18', pr.url],
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
          diffUrl: `https://github.com/${repo}/compare/main...priya:gft-18`,
          additions: 23,
          deletions: 4,
          agent: 'codex',
          model: 'gpt-5.5-codex',
          summary: 'Adds the NDJSON formatter.',
          checks: 'pnpm test (412 passing)',
          expiresAt: later,
          personWrittenDescription: true,
        },
      ],
      working: [claim],
    },
    mentions: ['asked for changes', '+23 -4', 'pnpm test (412 passing)', 'The donor writes the PR description', 'working'],
  },
  open_pr: {
    output: { claimId: 'c_2', issue, state: 'pr_opened', pr },
    mentions: ['PR #57', pr.url],
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
    output: { repo, status: 'approved', settings, changed: ['prMode'] },
    mentions: ['Updated', 'prMode'],
  },
  project_status: {
    output: {
      repo,
      status: 'rejected',
      source: 'registered',
      statusReason: 'The notes ask agents to skip tests.',
      settings,
      counts,
    },
    mentions: ['rejected', 'The notes ask agents to skip tests.', '3 tagged issues', '14 merged'],
  },
  pause_project: {
    output: { repo, status: 'paused' },
    mentions: ['Paused', 'paused: false'],
  },
  admin_queue: {
    output: {
      items: [
        {
          id: 'q_1',
          kind: 'candidate',
          repo: 'vitejs/vite',
          requestedBy: null,
          requestedAt: at,
          facts: { stars: 83000, createdAt: at, pushedAt: at, ownerCreatedAt: at },
          settings: { tags: ['contribution welcome'] },
          policy: {
            quote: 'Never let an LLM speak for you.',
            url: 'https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#ai-policy',
            tier: 'allows_with_conditions',
          },
          suggestedTags: [{ name: 'contribution welcome', openIssues: 8 }],
        },
      ],
    },
    mentions: ['vitejs/vite', 'q_1', '83,000 stars', 'Never let an LLM speak for you.', 'contribution welcome (8 open)'],
  },
  admin_decide: {
    output: { repo, status: 'approved' },
    mentions: ['Approved', repo],
  },
  admin_add_project: {
    output: { repo, status: 'approved', source: 'policy' },
    mentions: ['AI policy', repo],
  },
  admin_block_donor: {
    output: { login: 'spammer', blocked: true },
    mentions: ['@spammer', 'hidden'],
  },
  admin_pause_project: {
    output: { repo, status: 'paused' },
    mentions: ['Paused', repo],
  },
};
