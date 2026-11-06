import type { CrawlTier, PolicyFile, PolicyFileKind } from '../../../src/crawl/rules';

// The shape of the policy corpus's cases, which the rules tests in
// rules.test.ts and the model reader's eval (scripts/eval-policy.ts) both
// read. A case is a repo's files, sometimes its labels, and what a reading
// of them must find. The design is in docs/specs/model-policy-reader.md,
// under Evals. Every line of policy text in the cases is made up and says
// nothing about a real project, apart from the real repos in
// real-repos.ts, whose text is fetched when the eval runs.

/** Where a file of each kind sits when a case doesn't say. */
export const DEFAULT_PATHS: Record<PolicyFileKind, string> = {
  aiPolicy: 'AI_POLICY.md',
  contributing: 'CONTRIBUTING.md',
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
  prTemplate: '.github/pull_request_template.md',
  skill: '.claude/skills/contributing/SKILL.md',
  issueTemplate: '.github/ISSUE_TEMPLATE/bug_report.md',
};

/** A file of a kind, at its usual path unless one is given. */
export function file(kind: PolicyFileKind, text: string, path?: string): PolicyFile {
  return { kind, path: path ?? DEFAULT_PATHS[kind], text };
}

/** A CONTRIBUTING.md with a heading and the text under it. */
export const contributing = (text: string, path?: string): PolicyFile => file('contributing', `# Contributing\n\n${text}\n`, path);

/** A label as the label check reads it. */
export interface CaseLabel {
  name: string;
  description: string | null;
  openIssues: number;
}

/** The lines of a file a statement must cover, 1-based and inclusive. */
export interface LineSpan {
  path: string;
  lines: readonly [number, number];
}

/** What the label check must make of a case's labels, by name as the repo spells them. */
export interface ExpectedLabels {
  ready: readonly string[];
  keptForPeople: readonly string[];
  agentsOnly: readonly string[];
}

/** What a reading of a case must find. A field left out isn't checked. */
export interface Expected {
  /** The tier, or the tiers any of which passes. */
  tier: CrawlTier | readonly CrawlTier[];
  /** For a ban, a kept ban statement must cover at least one of these lines. */
  ban?: LineSpan;
  /**
   * Which conditions hold. When given, each must match: a condition the case
   * doesn't name must not be read.
   */
  conditions?: { noAutonomy: boolean; personInLoop: boolean; personWritten: boolean };
  /** Label names the docs keep away from AI or for people, each of which must be found. */
  reserved?: readonly string[];
  /** Label names the docs keep agents to, each of which must be found. */
  only?: readonly string[];
  trailer?: string;
  cla?: string;
  canary?: boolean;
  /** Lines that try to steer the reader, each of which must be found. */
  steering?: readonly LineSpan[];
  /**
   * What the check reading for a requested repo must say: `flags` when it
   * must find a reason not to list the repo at once, `clears` when it must
   * find none.
   */
  check?: 'flags' | 'clears';
  /** What the label check must make of the case's labels. */
  labels?: ExpectedLabels;
}

/** The groups of cases, as the eval reports them and the pass bar counts them. */
export type CaseGroup =
  | 'ban'
  | 'welcoming'
  | 'heldOut'
  | 'formSafe'
  | 'formBan'
  | 'settings'
  | 'model'
  | 'noPolicy'
  | 'injection'
  | 'labels'
  | 'realRepo';

/** A decision by the project's owner that a case's expectation was wrong. Only the owner relabels a case. */
export interface Relabel {
  /** The day the owner decided, as YYYY-MM-DD. */
  on: string;
  why: string;
  /** What the case expected before. */
  was: Expected;
}

export interface PolicyCase {
  /** Stable across runs and edits, so a summary's failed IDs still name the case. */
  id: string;
  group: CaseGroup;
  files: readonly PolicyFile[];
  /**
   * The repo's labels, for the label check. With `files` empty, the check
   * reads them alone, as register_project sends them.
   */
  labels?: readonly CaseLabel[];
  /** The path of the repo's vouch file, or null. */
  vouch?: string | null;
  expect: Expected;
  /** The tier the crawler's rules read today, which the rules tests hold them to. */
  rules?: CrawlTier;
  /** A note for whoever reads a failure, like a reason the owner may want to relabel it. It changes nothing. */
  note?: string;
  relabeled?: Relabel;
}

export const LISTING_TIERS: readonly CrawlTier[] = ['invites_agents', 'allows_with_conditions'];

/** Every line of a file, 1-based, for a ban that is the whole file. */
export function allLines(path: string, text: string): LineSpan {
  return { path, lines: [1, text.split('\n').length] };
}
