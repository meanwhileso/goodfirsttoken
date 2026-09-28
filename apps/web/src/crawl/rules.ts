import {
  defaultDisclosure,
  MAX_POLICY_QUOTE,
  MAX_TAGS,
  type PolicyTier,
  type ProjectSettingsPatch,
  type SuggestedTag,
} from '@goodfirsttoken/core';
import type { RepoFile } from '../projects/docs';
import { claLink, disclosureTrailer, firstMatch, keptForPeople, meansReady, personWritten } from '../projects/rules';

// The policy crawler's rules (spec section 5): what a repo's own docs say
// about AI help, sorted into a tier, and the settings and tags that follow
// from them. Plain rules over the text, with no model, each one written in
// docs/how-it-works.md under The policy crawler. The rules it shares with a
// maintainer's proposal are in src/projects/rules.ts.
//
// Every pattern here runs on one clause or sentence at a time, and none has
// more than a few words of slack, so the time a file takes grows with its
// length alone.

/** What a repo's docs say about AI help. Only the two tiers a listing can have reach the admin queue. */
export type CrawlTier = PolicyTier | 'bans_or_restricts' | 'no_policy';

/** The kind of file a text came from. */
export type PolicyFileKind = 'aiPolicy' | 'contributing' | 'agents' | 'claude' | 'prTemplate' | 'skill' | 'issueTemplate';

export interface PolicyFile extends RepoFile {
  kind: PolicyFileKind;
}

/**
 * Files written for the agents that work in the repo. Their rules for how an
 * agent works there, like "Claude should not use emojis", talk to an agent,
 * so in them an agent's name alone names no AI.
 */
const FOR_AGENTS: ReadonlySet<PolicyFileKind> = new Set(['agents', 'claude', 'skill']);

/** What the docs say, by the rules. */
export interface PolicyReading {
  tier: CrawlTier;
  /**
   * The first sentence that invites agents, or else the first that welcomes
   * AI help, in the order the files are read, with the text quoted around
   * it. Null unless the tier is one a listing can have.
   */
  welcome: { file: PolicyFile; sentence: string; quote: string } | null;
  /** A file that says agents may not work on their own, or null. */
  noAutonomy: PolicyFile | null;
  /** A file that asks for a person in the loop, or null. */
  personInLoop: PolicyFile | null;
  /** A file that asks contributors to write the PR description themselves, or null. */
  personWritten: PolicyFile | null;
  /** An agents' file with instructions for agents to prove they read it, or null. */
  canary: PolicyFile | null;
  /** Label names the docs keep away from AI or keep for people, as they spell them. */
  reserved: string[];
}

// The words that name AI. `AI` counts in capitals only, so a word like
// "ai" in a path doesn't.
const AI_ACRONYM = /\bAI\b/;
const AI_WORDS = /\b(?:LLMs?|large language models?|artificial intelligence|generative|machine[- ]generated|ChatGPT|Copilot)\b/i;
// A bot names no AI: "stale PRs are closed by a bot" is about something else.
const AGENT_WORDS = /\b(?:agents?|agentic|Claude|Codex|Gemini)\b/i;
const AGENT_PHRASES = /\b(?:(?:AI|coding|autonomous|LLM|software)[- ])?(?:agents?|bots?)\b/gi;

function namesAi(text: string, forAgents: boolean): boolean {
  return AI_ACRONYM.test(text) || AI_WORDS.test(text) || (!forAgents && AGENT_WORDS.test(text));
}

/** Whether the text starts with a word that names AI. */
function startsWithAi(text: string, forAgents: boolean): boolean {
  const first = /^\s*[\w-]+/.exec(text)?.[0] ?? '';
  return namesAi(first, forAgents) || /^\s*(?:large language|artificial intelligence)/i.test(text);
}

// Saying no. A negator, then within a word a verb of taking work in.
const TAKE = /(?:\bnot|n't|\bnever|\bno longer)\s+(?:[\w'-]+\s+)?(?:accept|allow|permit|welcom|tolerat|merg|review|consider|want)\w*/i;
// A negator, then within a word a verb of using, sending, or holding, or
// avoid or refrain from, with AI named after it.
const ACT =
  /(?:(?:\bnot|n't|\bnever)\s+(?:[\w'-]+\s+)?(?:use|using|submit|send|open|file|contribut|contain|includ|involv)\w*|\bavoid\w*|\brefrain from)\b/i;
// A negator, then work made or used, as in "must not be AI-generated" or "must not be used".
const MADE = /(?:\bnot|n't|\bnever)\s+(?:be\s+|been\s+)?(?:[\w]+-)?(?:generated|written|produced|created|made|used)\b/i;
const REFUSAL_WORDS =
  /\b(?:prohibited|forbidden|banned|ban|disallowed|unwelcome|unacceptable|zero[- ]tolerance|no-(?:AI|LLM)|(?:AI|LLM)-free)\b/i;
const CLOSED =
  /\b(?:will be|are|is|get|gets|will get)\s+(?:closed|rejected|deleted|removed|locked|banned|blocked|declined|ignored)\b|\bwe(?:'ll| will)?\s+(?:close|reject|delete|lock|ban|block|decline|ignore)\b|\bright to (?:close|reject|delete|lock|ban|block|decline|ignore)\b/i;
const NO = /\bno\s+/gi;
// A checkbox a contributor ticks in a PR or issue template, like "I did not
// use AI", is a choice they make. It says no to AI only when it asks them to
// confirm or promise something. Markdown's task list items, and the labels
// of an issue form's options.
const CHECKBOX = /^\s*(?:(?:[-*+]|\d+[.)])\s+\[[ xX]?\]|-\s+label:)/;
const PLEDGE = /\b(?:confirm|certify|agree|attest|declare|promise|affirm)\b/i;

// Saying no to agents working on their own, which is a condition the
// listing keeps.
const AUTONOMY =
  /\b(?:autonomous(?:ly)?|unsupervised|unattended|fully[- ]automated|on (?:its|their) own|without (?:a |any )?(?:human|person|people|review|supervision|oversight))\b/i;
const NEGATOR = /\b(?:no|not|never|none)\b|n't\b/i;
const AGENTS_NO_PRS =
  /\b(?:agents?|bots?)\b[^.;]{0,40}?(?:\bnot|n't|\bnever)\s+(?:[\w'-]+\s+)?(?:open|submit|create|send|file)\w*\s+(?:[\w'-]+\s+){0,2}?(?:pull requests?|PRs?)\b/i;
const NO_PRS_FOR_AGENTS =
  /^\s*(?:please\s+)?(?:do not|don't|never|you (?:must|may|should) not)\s+(?:open|submit|create|send|file)\s+(?:a\s+|any\s+)?(?:pull requests?|PRs?)\b/i;

// Keeping labels away from AI, or for people.
const LABEL_SCOPE = /\bon\s+(?:issues?\s+)?(?:labell?ed|tagged|with the label)\s+["`]|\bon\s+["`][^"`\n]{1,50}["`]\s+issues?\b/i;
const FOR_PEOPLE =
  /\b(?:(?:reserved|kept|set aside|saved|meant|intended|only)\s+for|(?:is|are)\s+for)\s+(?:people|humans|human contributors|newcomers|new contributors|first[- ]time contributors|beginners|people new)\b/i;
const QUOTED = /["`]([^"`\n]{1,50})["`]/g;

// Refusing outside pull requests altogether.
const NO_OUTSIDE_PRS =
  /\b(?:(?:do|does|will|can) not|don't|doesn't|won't|can't|cannot)\s+accept\s+(?:any\s+)?(?:outside\s+|external\s+|unsolicited\s+|community\s+|third[- ]party\s+)?(?:pull requests|PRs|contributions|patches|code contributions)(?:\s+from\s+(?:outside(?:\s+the\s+(?:team|project|core team))?|outsiders|external contributors|the (?:public|community)|non-members|anyone(?:\s+else)?))?(?:\s+at\s+(?:this|the)\s+(?:time|moment))?\s*[.!]?\s*$/i;
const NOT_ACCEPTING =
  /\bnot\s+(?:currently\s+)?(?:accepting|taking)\s+(?:outside\s+|external\s+)?(?:pull requests|PRs|contributions)(?:\s+at\s+(?:this|the)\s+(?:time|moment))?\s*[.!]?\s*$/i;

// Welcoming agents that work on their own.
const INVITES = [
  /\b(?:(?:AI|coding|autonomous|LLM)[- ])?agents\s+(?:may|can|are (?:welcome|invited|encouraged|free|allowed) to)\s+(?:open|submit|send|make|create|file|contribute|work)\b/i,
  /\ban? (?:(?:AI|coding|autonomous)[- ])?agent\s+(?:may|can|is (?:welcome|invited|encouraged|free|allowed) to)\s+(?:open|submit|send|make|create|file|contribute|work)\b/i,
  /\b(?:(?:AI|coding)[- ])?agent[- ]?(?:made |written |opened |authored )?(?:pull requests|PRs|contributions|patches)\s+(?:are|is)\s+(?:welcome|accepted|encouraged|fine|allowed)\b/i,
  /\b(?:we|this project|this repo(?:sitory)?|maintainers)\s+(?:welcome|welcomes|accept|accepts|invite|invites|encourage|encourages)\s+(?:pull requests|PRs|contributions|patches)\s+(?:from|by|made by|opened by)\s+(?:(?:AI|coding|autonomous)[- ])?agents\b/i,
  /\b(?:we|this project|this repo(?:sitory)?)\s+(?:welcome|welcomes|invite|invites)\s+(?:(?:AI|coding|autonomous)[- ])?agents\b/i,
];

// Welcoming AI help.
const ALLOWS = [
  /\b(?:AI|LLM)[- ](?:assisted|generated|written|made|aided)\s+(?:code|contributions?|pull requests|PRs|changes|patches|work|commits)\s+(?:is|are)\s+(?:fine|welcome|allowed|accepted|okay|ok|permitted|encouraged)\b/i,
  /\b(?:AI|LLM|agent)\s+(?:help|assistance|tools?|use|usage)\s+(?:is|are)\s+(?:fine|welcome|allowed|accepted|okay|ok|permitted|encouraged)\b/i,
  /\b(?:AI|LLMs?)\s+(?:is|are)\s+(?:fine|welcome|allowed|okay|ok|permitted)\b/i,
  /\b(?:using|use of)\s+(?:AI|LLMs?|(?:AI |coding )?(?:agents|assistants|tools))\s+(?:is|are)\s+(?:fine|welcome|allowed|okay|ok|permitted|encouraged)\b/i,
  /\b(?:you may|you can|feel free to|you're welcome to|you are welcome to|it's fine to|it is fine to)\s+use\s+(?:AI|LLMs?|an? (?:AI|LLM|coding)|coding agents|agents|AI tools)\b/i,
  /\b(?:we|this project|this repo(?:sitory)?)\s+(?:welcome|welcomes|accept|accepts|allow|allows|encourage|encourages)\s+(?:AI|LLM)[- ](?:assisted|generated|written|made|aided)\b/i,
];

// A person in the loop.
const PERSON_IN_LOOP =
  /\b(?:a (?:person|human)|you)\s+(?:must|should|need to|have to)\s+(?:(?:fully|personally)\s+)?(?:review|understand|explain|stand behind|take responsibility)\b|\bhuman[- ]in[- ]the[- ]loop\b|\b(?:human|person|manual) review (?:is )?required\b/i;

// A canary: instructions that single out an agent reading the file.
const CANARY =
  /\b(?:if|when)\s+you(?:'re|\s+are)\s+(?:an?\s+)?(?:AI|LLM|large language model|language model|coding agent|AI agent|agent|AI assistant|coding assistant|assistant|bot)\b[^.]{0,120}?\b(?:include|add|put|mention|say|write|start|end|begin|use|append|prefix|sign)\b/i;

// Where one clause ends and the next starts inside a sentence.
const CLAUSE_BREAK = /;|\b(?:but|however|unless|except|although|though|as long as|so long as|provided)\b/i;

/** Curly quotes as straight ones, and Markdown's emphasis and strike marks left out, for matching. */
function plain(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[*~]/g, '');
}

interface Paragraph {
  start: number;
  end: number;
}

interface Sentence {
  text: string;
  paragraph: number;
  /** Part of a checkbox a contributor ticks. */
  choice: boolean;
}

// A line that starts a block of its own: a list item, a heading, a quote, or
// a table row. Any other line goes on the one before it, since text is often
// wrapped in the middle of a sentence.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;

/**
 * The file's paragraphs, runs of lines with no blank line between them, and
 * its sentences. A sentence ends at a period, question mark, or exclamation
 * mark followed by a space, or where a paragraph or a block ends, and runs on
 * over a wrapped line.
 */
function scan(text: string): { paragraphs: Paragraph[]; sentences: Sentence[] } {
  const paragraphs: Paragraph[] = [];
  const sentences: Sentence[] = [];
  let block: string[] = [];
  const endBlock = () => {
    const joined = block.join(' ');
    block = [];
    const choice = CHECKBOX.test(joined);
    for (const sentence of plain(joined).split(/(?<=[.!?])\s+/)) {
      if (sentence.trim() !== '') sentences.push({ text: sentence, paragraph: paragraphs.length, choice });
    }
  };
  let offset = 0;
  let open: Paragraph | null = null;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    if (line.trim() === '') {
      endBlock();
      if (open) paragraphs.push(open);
      open = null;
    } else {
      if (BLOCK_START.test(line)) endBlock();
      block.push(line.trim());
      open ??= { start: offset, end };
      open.end = end;
    }
    offset = end + 1;
  }
  endBlock();
  if (open) paragraphs.push(open);
  return { paragraphs, sentences };
}

/**
 * The exact text to quote for a sentence: its paragraph, and the paragraph
 * after it too when its own is a Markdown heading. When that is longer than
 * a quote may be, the sentence alone, cut at the limit.
 */
function quoteOf(text: string, paragraphs: readonly Paragraph[], sentence: Sentence): string {
  const own = paragraphs[sentence.paragraph];
  if (!own) return sentence.text.trim().slice(0, MAX_POLICY_QUOTE).trim();
  const next = paragraphs[sentence.paragraph + 1];
  const heading = /^#{1,6}\s/.test(text.slice(own.start, own.end)) && !text.slice(own.start, own.end).includes('\n');
  const quote = text.slice(own.start, heading && next ? next.end : own.end).trim();
  if (quote.length <= MAX_POLICY_QUOTE) return quote;
  return sentence.text.trim().slice(0, MAX_POLICY_QUOTE).trim();
}

/** Names in quotes or backticks, as the text spells them. */
function quotedNames(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => (m[1] ?? '').trim()).filter((name) => name !== '');
}

/** Whether a clause says no to AI. A contributor's choice says no only when it pledges. */
function refuses(clause: string, forAgents: boolean, choice: boolean): boolean {
  if (!namesAi(clause, forAgents)) return false;
  if (choice && !PLEDGE.test(clause)) return false;
  if (TAKE.test(clause) || REFUSAL_WORDS.test(clause) || CLOSED.test(clause)) return true;
  const act = ACT.exec(clause);
  if (act && namesAi(clause.slice(act.index + act[0].length).slice(0, 60), forAgents)) return true;
  if (MADE.test(clause) && namesAi(clause, true)) return true;
  for (const no of clause.matchAll(NO)) {
    if (startsWithAi(clause.slice(no.index + no[0].length), forAgents)) return true;
  }
  return false;
}

/** Whether a clause says no to agents working on their own, and names no AI but agents. */
function refusesAutonomyOnly(clause: string, forAgents: boolean): boolean {
  const autonomy =
    (AUTONOMY.test(clause) && NEGATOR.test(clause)) ||
    AGENTS_NO_PRS.test(clause) ||
    (forAgents && NO_PRS_FOR_AGENTS.test(clause));
  return autonomy && !namesAi(clause.replace(AGENT_PHRASES, ' '), true);
}

/** Whether a clause keeps AI off issues with a label it names. */
function keepsLabelFromAi(clause: string): boolean {
  return LABEL_SCOPE.test(clause) && NEGATOR.test(clause);
}

/**
 * Reads the files in the order given, and sorts the repo into a tier. A
 * sentence that says no to AI anywhere makes it a ban, whatever else the
 * files say. So does one that says the project takes no pull requests.
 * Otherwise a sentence that invites agents makes it invite agents, unless a
 * file keeps agents from working on their own, asks for a person in the
 * loop, or asks for a person-written PR description, and then, like a
 * sentence that welcomes AI help, it allows AI with conditions. With none of
 * these, it has no policy the crawler can use.
 */
export function readPolicy(files: readonly PolicyFile[]): PolicyReading {
  let refused = false;
  let invites: { file: PolicyFile; sentence: Sentence; quote: string } | null = null;
  let allows: { file: PolicyFile; sentence: Sentence; quote: string } | null = null;
  let noAutonomy: PolicyFile | null = null;
  let personInLoop: PolicyFile | null = null;
  let canary: PolicyFile | null = null;
  const reserved: string[] = [];

  for (const file of files) {
    const forAgents = FOR_AGENTS.has(file.kind);
    const { paragraphs, sentences } = scan(file.text);
    for (const sentence of sentences) {
      const text = sentence.text;
      if (NO_OUTSIDE_PRS.test(text) || NOT_ACCEPTING.test(text)) refused = true;
      for (const clause of text.split(CLAUSE_BREAK)) {
        if (refusesAutonomyOnly(clause, forAgents)) {
          noAutonomy ??= file;
        } else if (keepsLabelFromAi(clause) && namesAi(clause, forAgents)) {
          reserved.push(...quotedNames(clause));
        } else if (refuses(clause, forAgents, sentence.choice)) {
          refused = true;
        }
      }
      if (FOR_PEOPLE.test(text)) reserved.push(...quotedNames(text));
      if (PERSON_IN_LOOP.test(text)) personInLoop ??= file;
      if (forAgents && file.kind !== 'skill' && CANARY.test(text)) canary ??= file;
      if (!invites && INVITES.some((pattern) => pattern.test(text))) {
        invites = { file, sentence, quote: quoteOf(file.text, paragraphs, sentence) };
      }
      if (!allows && ALLOWS.some((pattern) => pattern.test(text))) {
        allows = { file, sentence, quote: quoteOf(file.text, paragraphs, sentence) };
      }
    }
  }

  const written = firstMatch(files, personWritten)?.file ?? null;
  const welcome = invites ?? allows;
  let tier: CrawlTier;
  if (refused) tier = 'bans_or_restricts';
  else if (invites && !noAutonomy && !personInLoop && !written) tier = 'invites_agents';
  else if (welcome) tier = 'allows_with_conditions';
  else tier = 'no_policy';
  return {
    tier,
    welcome:
      welcome && (tier === 'invites_agents' || tier === 'allows_with_conditions')
        ? { file: welcome.file, sentence: welcome.sentence.text, quote: welcome.quote }
        : null,
    noAutonomy,
    personInLoop,
    personWritten: written,
    canary,
    reserved,
  };
}

/** A label with its open issue count, as GitHub gave it. */
export interface RepoLabel {
  name: string;
  openIssues: number;
}

const lower = (text: string) => text.toLowerCase();

/** Whether the sentence names the label after `labeled`, `label`, or `tagged`, or in quotes. */
function names(sentence: string, label: string): boolean {
  const text = lower(sentence);
  const name = lower(label);
  const quoted = quotedNames(sentence).some((q) => lower(q) === name);
  return quoted || ['labeled ', 'labelled ', 'label ', 'tagged '].some((word) => text.includes(`${word}${name}`));
}

function unique(labels: readonly RepoLabel[]): RepoLabel[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = lower(label.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The settings and tags the crawler suggests for a repo it read, for an
 * admin to confirm. `vouched` is true when the repo has a vouch file.
 */
export function suggestSettings(
  reading: PolicyReading,
  files: readonly PolicyFile[],
  labels: readonly RepoLabel[],
  vouched: boolean,
): { settings: ProjectSettingsPatch; suggestedTags: SuggestedTag[] } {
  const reserved = new Set(reading.reserved.map(lower));
  const excluded = unique(labels.filter((label) => reserved.has(lower(label.name))));
  const open = labels.filter((label) => !reserved.has(lower(label.name)));
  const sentence = reading.welcome?.sentence ?? '';
  const named = open.filter((label) => names(sentence, label.name));
  const tags = unique([...named, ...open.filter((label) => meansReady(label.name))]).slice(0, MAX_TAGS);
  const suggested = unique([...named, ...open.filter((label) => meansReady(label.name) || keptForPeople(label.name))]).slice(
    0,
    MAX_TAGS,
  );

  const settings: ProjectSettingsPatch = {
    prMode: reading.tier === 'invites_agents' ? 'automatic' : 'reviewed',
  };
  if (tags.length > 0) settings.tags = tags.map((label) => label.name);
  if (excluded.length > 0) settings.excludedTags = excluded.slice(0, MAX_TAGS).map((label) => label.name);
  if (vouched) settings.whoCanClaim = 'vouched';
  const trailer = firstMatch(files, disclosureTrailer);
  if (trailer !== null) settings.disclosure = { ...defaultDisclosure, trailer: trailer.found };
  if (reading.personWritten !== null) settings.personWrittenDescription = true;
  const cla = firstMatch(files, claLink);
  if (cla !== null) settings.claUrl = cla.found;
  if (reading.canary !== null) {
    settings.agentNotes = `Read ${reading.canary.path} before you start, and follow what it tells agents to do.`;
  }
  return { settings, suggestedTags: suggested.map((label) => ({ name: label.name, openIssues: label.openIssues })) };
}
