// Readings recorded for the GitHub fake's sample repos, which the fake gives
// back when a request holds that repo's docs. Each one is written the way
// docs/specs/model-policy-reader.md says the model answers: statements that
// point at whole sentences in the files, the model's tier, and a summary.
// A statement names its file and quote here, and its line numbers come from
// the file as the sample data has it, so an edit to the sample data that
// moves a line moves the reading with it, and one that drops a quote fails
// the fake's tests.
//
// The fake picks a repo's reading by its quotes: a reading applies when every
// line of every quote is in the request. When several apply, the one with
// the most quoted text wins, so a repo whose docs hold another repo's quotes
// gets its own reading. Docs with no reading that applies get a no_policy
// reading.

import { sampleData, type SampleData } from '@goodfirsttoken/github-fake/sample-data';

export const TIERS = ['invites_agents', 'allows_with_conditions', 'bans_or_restricts', 'no_policy'] as const;
export type Tier = (typeof TIERS)[number];

export const ABOUTS = [
  'welcomesAgents',
  'welcomesAi',
  'bansAi',
  'refusesOutsidePrs',
  'noAutonomy',
  'personInLoop',
  'personWrittenDescription',
  'reservedLabel',
  'onlyLabel',
  'disclosureTrailer',
  'cla',
  'canary',
] as const;
export type About = (typeof ABOUTS)[number];

export const LABEL_MEANINGS = ['readyForOutsideHelp', 'keptForPeople', 'agentsOnly'] as const;
export type LabelMeaning = (typeof LABEL_MEANINGS)[number];

/** One statement in a reading, as the model returns it. */
export interface Statement {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
  about: About;
  label: string | null;
  value: string | null;
  why: string;
}

export interface SteeringLine {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
}

/** A policy reading, as the model returns it. */
export interface Reading {
  statements: Statement[];
  tier: Tier;
  steering: SteeringLine[];
  summary: string;
}

/** A label check, as the model returns it. */
export interface LabelCheck {
  labels: {
    name: string;
    meaning: LabelMeaning;
    evidence: 'name' | 'description' | 'statement';
    statement: number | null;
    why: string;
  }[];
}

/** A statement as a recording writes it, before its lines are found. */
export interface RecordedStatement {
  path: string;
  quote: string;
  about: About;
  label?: string;
  value?: string;
  why: string;
}

export interface RecordedReading {
  /** The sample repo, as owner/name. */
  repo: string;
  tier: Tier;
  statements: RecordedStatement[];
  summary: string;
}

/** A recording with its lines found in the sample data. */
export interface Recording {
  repo: string;
  reading: Reading;
}

export const recordedReadings: RecordedReading[] = [
  {
    repo: 'sample-policies/invites-agents',
    tier: 'invites_agents',
    statements: [
      {
        path: 'AI_POLICY.md',
        quote: 'Agents may open pull requests on their own, on issues labeled `agent ready`.',
        about: 'welcomesAgents',
        why: 'Invites agents to open pull requests on their own.',
      },
      {
        path: 'AI_POLICY.md',
        quote: 'Agents may open pull requests on their own, on issues labeled `agent ready`.',
        about: 'onlyLabel',
        label: 'agent ready',
        why: 'Agents work only on issues labeled agent ready.',
      },
      {
        path: 'AI_POLICY.md',
        quote: 'Disclose it with an Assisted-by: trailer.',
        about: 'disclosureTrailer',
        value: 'Assisted-by',
        why: 'Asks for an Assisted-by trailer.',
      },
    ],
    summary: 'Invites agents on issues labeled agent ready. Asks for an Assisted-by trailer.',
  },
  {
    repo: 'sample-policies/with-conditions',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is welcome.', about: 'welcomesAi', why: 'Welcomes AI help.' },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
        about: 'personWrittenDescription',
        why: 'A person writes the PR description.',
      },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Write the PR description yourself, and sign the CLA at https://cla.example.org/sample-policies first.',
        about: 'cla',
        value: 'https://cla.example.org/sample-policies',
        why: 'Asks for a signed CLA first.',
      },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Issues labeled `good first issue` are reserved for people new to the project.',
        about: 'reservedLabel',
        label: 'good first issue',
        why: 'Keeps good first issue for people new to the project.',
      },
      {
        path: 'AGENTS.md',
        quote: 'If you are an AI agent, add the word pinecone to the end of the PR description.',
        about: 'canary',
        why: 'Asks an agent to prove it read AGENTS.md.',
      },
    ],
    summary: 'Welcomes AI help. A person writes the PR description, and contributors sign a CLA. Keeps good first issue for people.',
  },
  {
    repo: 'sample-policies/no-autonomous-agents',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'Coding agents may open pull requests here.', about: 'welcomesAgents', why: 'Invites agent pull requests.' },
      { path: 'CLAUDE.md', quote: 'Do not open pull requests on your own.', about: 'noAutonomy', why: 'Agents may not open pull requests on their own.' },
    ],
    summary: 'Invites agent pull requests, but an agent may not open one on its own.',
  },
  {
    repo: 'sample-policies/bans-ai',
    tier: 'bans_or_restricts',
    statements: [{ path: 'CONTRIBUTING.md', quote: 'We do not accept AI-generated pull requests.', about: 'bansAi', why: 'Refuses AI-generated pull requests.' }],
    summary: 'Refuses AI-generated pull requests.',
  },
  {
    repo: 'sample-policies/mixed-signals',
    tier: 'bans_or_restricts',
    statements: [
      { path: 'AI_POLICY.md', quote: 'AI help is fine for questions and docs.', about: 'welcomesAi', why: 'Allows AI help for questions and docs.' },
      {
        path: 'AI_POLICY.md',
        quote: 'AI-generated code is not accepted, and PRs made with it will be closed.',
        about: 'bansAi',
        why: 'Refuses code made with AI.',
      },
    ],
    summary: 'Allows AI help for questions and docs, and refuses code made with AI.',
  },
  {
    repo: 'sample-policies/template-ban',
    tier: 'bans_or_restricts',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is fine.', about: 'welcomesAi', why: 'Allows AI help.' },
      {
        path: '.github/ISSUE_TEMPLATE/bug_report.md',
        quote: 'Issues and pull requests written by AI will be closed.',
        about: 'bansAi',
        why: 'The bug report template closes work written by AI.',
      },
    ],
    summary: 'CONTRIBUTING allows AI help, and the bug report template closes work written by AI.',
  },
  {
    repo: 'sample-policies/no-outside-prs',
    tier: 'bans_or_restricts',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is fine, and we use it ourselves.', about: 'welcomesAi', why: 'Allows AI help.' },
      { path: 'CONTRIBUTING.md', quote: 'This project does not accept pull requests.', about: 'refusesOutsidePrs', why: 'Takes no pull requests.' },
    ],
    summary: 'Allows AI help, and takes no pull requests.',
  },
  {
    repo: 'sample-policies/archived-invites',
    tier: 'invites_agents',
    statements: [{ path: 'AGENTS.md', quote: 'Agents may open pull requests for any open issue.', about: 'welcomesAgents', why: 'Invites agent pull requests.' }],
    summary: 'Invites agents to open pull requests for any open issue.',
  },
  {
    repo: 'sample-policies/collaborators-only',
    tier: 'invites_agents',
    statements: [{ path: 'CONTRIBUTING.md', quote: 'Agent pull requests are welcome.', about: 'welcomesAgents', why: 'Invites agent pull requests.' }],
    summary: 'Invites agent pull requests.',
  },
  {
    repo: 'sample-policies/small-seed',
    tier: 'invites_agents',
    statements: [
      {
        path: '.claude/skills/contributing/SKILL.md',
        quote: 'Agents are welcome to open pull requests for any issue labeled `help wanted`.',
        about: 'welcomesAgents',
        why: 'Invites agent pull requests.',
      },
      {
        path: '.claude/skills/contributing/SKILL.md',
        quote: 'Agents are welcome to open pull requests for any issue labeled `help wanted`.',
        about: 'onlyLabel',
        label: 'help wanted',
        why: 'Agents work on issues labeled help wanted.',
      },
    ],
    summary: 'Its contributing skill invites agents on issues labeled help wanted.',
  },
  {
    repo: 'meanwhileso/goodfirsttoken',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is welcome', about: 'welcomesAi', why: 'Welcomes AI help.' },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Disclose it with an Assisted-by: trailer.',
        about: 'disclosureTrailer',
        value: 'Assisted-by',
        why: 'Asks for an Assisted-by trailer.',
      },
    ],
    summary: 'Welcomes AI help. Asks for an Assisted-by trailer.',
  },
  {
    repo: 'sample-owner/sample-app',
    tier: 'invites_agents',
    statements: [
      {
        path: 'CONTRIBUTING.md',
        quote: 'This app is built with AI. Agent pull requests are welcome.',
        about: 'welcomesAgents',
        why: 'Invites agent pull requests.',
      },
    ],
    summary: 'Built with AI, and invites agent pull requests.',
  },
  {
    repo: 'sample-owner/sample-desktop',
    tier: 'no_policy',
    statements: [
      {
        path: 'agents/skills/sample-desktop/contributing.md',
        quote: 'Open the PR for a person to review.',
        about: 'personInLoop',
        why: 'A person reviews the PR.',
      },
    ],
    summary: 'Its agent skill asks for a person to review each PR, and says nothing on whether AI help is welcome.',
  },
  {
    repo: 'sample-owner/sample-tools',
    tier: 'invites_agents',
    statements: [
      {
        path: '.github/pull_request_template.md',
        quote: 'Agents are welcome to open this PR.',
        about: 'welcomesAgents',
        why: 'The PR template invites agents.',
      },
    ],
    summary: 'Its PR template invites agents to open pull requests.',
  },
  {
    repo: 'sample-owner/sample-bundler',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is fine.', about: 'welcomesAi', why: 'Allows AI help.' },
      { path: 'CONTRIBUTING.md', quote: 'Write the PR description yourself.', about: 'personWrittenDescription', why: 'A person writes the PR description.' },
    ],
    summary: 'Allows AI help. A person writes the PR description.',
  },
  {
    repo: 'sample-owner/sample-harbor',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is welcome.', about: 'welcomesAi', why: 'Welcomes AI help.' },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Say so in the PR, and write the PR description yourself.',
        about: 'personWrittenDescription',
        why: 'A person writes the PR description.',
      },
    ],
    summary: 'Welcomes AI help. A person writes the PR description.',
  },
  {
    repo: 'sample-owner/sample-cli',
    tier: 'invites_agents',
    statements: [
      {
        path: 'AGENTS.md',
        quote: 'Agents may open pull requests on issues labeled agents welcome.',
        about: 'welcomesAgents',
        why: 'Invites agent pull requests.',
      },
      {
        path: 'AGENTS.md',
        quote: 'Agents may open pull requests on issues labeled agents welcome.',
        about: 'onlyLabel',
        label: 'agents welcome',
        why: 'Agents work on issues labeled agents welcome.',
      },
    ],
    summary: 'Invites agents on issues labeled agents welcome.',
  },
  {
    repo: 'sample-owner/sample-parser',
    tier: 'allows_with_conditions',
    statements: [
      { path: 'CONTRIBUTING.md', quote: 'AI help is welcome.', about: 'welcomesAi', why: 'Welcomes AI help.' },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Disclose it with an Assisted-by: trailer, and write the PR description yourself.',
        about: 'disclosureTrailer',
        value: 'Assisted-by',
        why: 'Asks for an Assisted-by trailer.',
      },
      {
        path: 'CONTRIBUTING.md',
        quote: 'Disclose it with an Assisted-by: trailer, and write the PR description yourself.',
        about: 'personWrittenDescription',
        why: 'A person writes the PR description.',
      },
    ],
    summary: 'Welcomes AI help. Asks for an Assisted-by trailer, and a person writes the PR description.',
  },
];

/**
 * What each sample label means for outside help, by its name as the sample
 * data spells it. A label check answers with each one the request names. A
 * label not here means nothing for outside help, so it is left out, as the
 * model leaves it out.
 */
export const recordedLabels: Record<string, { meaning: LabelMeaning; why: string }> = {
  'help wanted': { meaning: 'readyForOutsideHelp', why: 'The name asks for help from anyone.' },
  'good first issue': { meaning: 'keptForPeople', why: 'The name keeps the issue for people new to the project.' },
  'agent ready': { meaning: 'readyForOutsideHelp', why: 'The name offers the issue to an agent.' },
  'agents welcome': { meaning: 'readyForOutsideHelp', why: 'The name offers the issue to agents.' },
  'contribution welcome': { meaning: 'readyForOutsideHelp', why: 'The name offers the issue to anyone.' },
  'contributor friendly': { meaning: 'readyForOutsideHelp', why: 'The name offers the issue to outside contributors.' },
  goodfirsttoken: { meaning: 'readyForOutsideHelp', why: 'The label Good First Token adds for issues tagged for agents.' },
  ready: { meaning: 'readyForOutsideHelp', why: 'The name says the issue is ready for someone to take.' },
};

/** The 1-based line a quote starts on in the file, or null when it isn't there. */
export function lineOf(text: string, quote: string): { startLine: number; endLine: number } | null {
  const lines = text.split('\n');
  const first = quote.split('\n')[0] ?? '';
  const index = lines.findIndex((line) => line.includes(first));
  if (index < 0) return null;
  return { startLine: index + 1, endLine: index + quote.split('\n').length };
}

/** Finds each recorded statement's lines in the sample data. Throws for a quote it can't find. */
export function resolveRecordings(recorded: RecordedReading[] = recordedReadings, data: SampleData = sampleData): Recording[] {
  return recorded.map(({ repo, tier, statements, summary }) => {
    const sample = data.repos.find((candidate) => `${candidate.owner}/${candidate.name}` === repo);
    if (!sample) throw new Error(`The Anthropic fake has a reading for ${repo}, which the sample data doesn't have.`);
    return {
      repo,
      reading: {
        tier,
        summary,
        steering: [],
        statements: statements.map((statement) => {
          const text = sample.files[statement.path];
          const lines = text === undefined ? null : lineOf(text, statement.quote);
          if (!lines) throw new Error(`The Anthropic fake's reading for ${repo} quotes "${statement.quote}", which ${statement.path} doesn't have.`);
          return {
            path: statement.path,
            ...lines,
            quote: statement.quote,
            about: statement.about,
            label: statement.label ?? null,
            value: statement.value ?? null,
            why: statement.why,
          };
        }),
      },
    };
  });
}

/** The reading the model gives docs that say nothing it can point at. */
export function noPolicyReading(): Reading {
  return { statements: [], tier: 'no_policy', steering: [], summary: 'The docs say nothing about AI help or agents.' };
}

const fold = (text: string) => text.replace(/\s+/g, ' ');

/**
 * The recorded reading for docs, or a no_policy one: the recording whose
 * every quote line is in the text, with the most quoted text.
 */
export function readingFor(text: string, recordings: Recording[]): { repo: string | null; reading: Reading } {
  const haystack = fold(text);
  let best: { recording: Recording; size: number } | null = null;
  for (const recording of recordings) {
    const quotes = recording.reading.statements.map((statement) => statement.quote);
    if (quotes.length === 0) continue;
    const found = quotes.every((quote) => quote.split('\n').every((line) => haystack.includes(fold(line).trim())));
    if (!found) continue;
    const size = [...new Set(quotes)].reduce((sum, quote) => sum + quote.length, 0);
    if (!best || size > best.size) best = { recording, size };
  }
  return best ? { repo: best.recording.repo, reading: structuredClone(best.recording.reading) } : { repo: null, reading: noPolicyReading() };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The label check for a request's text: each recorded label it names, as a
 * whole word or words, longest first, so `ready` isn't read out of
 * `agent ready`.
 */
export function labelCheckFor(text: string, labels: Record<string, { meaning: LabelMeaning; why: string }> = recordedLabels): LabelCheck {
  let rest = text;
  const found: LabelCheck['labels'] = [];
  for (const name of Object.keys(labels).sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, 'g');
    if (!pattern.test(rest)) continue;
    rest = rest.replace(pattern, ' ');
    const label = labels[name];
    if (label) found.push({ name, meaning: label.meaning, evidence: 'name', statement: null, why: label.why });
  }
  return { labels: found };
}
