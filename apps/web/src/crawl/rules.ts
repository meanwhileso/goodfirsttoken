import {
  MAX_POLICY_QUOTE,
  MAX_SOURCE_LINE,
  MAX_TAGS,
  defaultDisclosure,
  type CandidateSource,
  type PolicyTier,
  type ProjectSettingsPatch,
  type SuggestedTag,
} from '@goodfirsttoken/core';
import type { RepoFile } from '../projects/docs';
import { findClaLink, findPersonWritten, findTrailer, keptForPeople, meansReady, type Found } from '../projects/rules';

// The policy crawler's rules (spec section 5): what a repo's own docs say
// about AI help, sorted into a tier, and the settings and tags that follow
// from them. Plain rules over the text, with no model, each one written in
// docs/how-it-works.md under The policy crawler. The rules it shares with a
// maintainer's proposal are in src/projects/rules.ts.
//
// The rules err toward a ban. A sentence that names AI, or sits under a
// heading or in a file that does, and has any word that says no, limits, or
// refuses, is a ban, unless it has one of the few forms below known to say
// no to something else. A missed welcome costs a find. A missed ban would put
// a repo that said no in front of an admin.
//
// Every pattern runs on one sentence at a time, with a few words of slack at
// most, and none ends in a run of optional space, so the time a file takes
// grows with its length alone.

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
 * so in them the words that name the reader name no AI.
 */
const FOR_AGENTS: ReadonlySet<PolicyFileKind> = new Set(['agents', 'claude', 'skill']);

/** A line in a file, as the file has it, behind something the crawler found. */
export interface SourceLine {
  file: PolicyFile;
  line: string;
}

/** What the docs say, by the rules. */
export interface PolicyReading {
  tier: CrawlTier;
  /**
   * The first sentence that invites agents, or else the first that welcomes
   * AI help, in the order the files are read, with the text quoted around
   * it. Null unless the tier is one a listing can have.
   */
  welcome: { file: PolicyFile; sentence: string; quote: string } | null;
  /** The first line that says no, when the tier is a ban. */
  ban: SourceLine | null;
  /** A line that keeps agents from working on their own, or null. */
  noAutonomy: SourceLine | null;
  /** A line that asks for a person in the loop, or null. */
  personInLoop: SourceLine | null;
  /** A line that asks contributors to write the PR description themselves, or null. */
  personWritten: SourceLine | null;
  /** A line in AGENTS.md or CLAUDE.md with instructions for an agent to prove it read the file, or null. */
  canary: SourceLine | null;
  /** Label names the docs keep away from AI or keep for people, as they spell them, with their lines. */
  reserved: { name: string; source: SourceLine }[];
}

// ---------------------------------------------------------------------------
// Words that name AI.

// `AI` counts in capitals, or as A.I., so "ai" in a word or a path doesn't.
const AI_ACRONYM = /\bA\.?Is?\b/;
// "ai-generated" and the like count in any case.
const AI_COMPOUND =
  /\bai[- ](?:generated|assisted|written|made|powered|based|driven|aided|authored|created|produced|tools?|models?|agents?|assistants?|coding|code|contributions?|slop|use|usage|help)\b/i;
// Bots and machine-made files aren't AI here: "Don't edit machine-generated
// files" and a stale bot's rules say no to something else.
const AI_WORDS =
  /\b(?:LLMs?|large language models?|language models?|artificial intelligence|gen[- ]?AI|generative|neural networks?|chat ?bots?|vibe[- ]?cod\w*)\b/i;
const AI_PRODUCTS =
  /\b(?:ChatGPT|GPT(?:-?\d[\w.]*|s)?|OpenAI|Copilot|Claude|Codex|Gemini|Bard|Llama|Mistral|Grok|DeepSeek|Qwen|Anthropic|Devin|Aider|Tabnine|Windsurf)\b/i;
// Cursor, the editor, only with its capital, since a cursor is a word too.
const CURSOR = /\bCursor\b/;
const AGENT_WORDS = /\b(?:agents?|agentic|AI assistants?|coding assistants?)\b/i;
// In a file written for agents, only words for work AI made name AI.
const AI_MADE =
  /\b(?:AI|A\.I\.|LLM|GPT|ChatGPT|Copilot|Claude|Codex|Gemini|Cursor|agent|model)[- ](?:generated|written|made|assisted|authored|created|produced|aided)\b|\bvibe[- ]?cod\w*/i;
const AGENT_PHRASES = /\b(?:(?:AI|coding|autonomous|LLM|software)[- ])?(?:agents?|bots?|assistants?)\b/gi;

/** Whether the text names AI, leaving out agents. */
function namesAiItself(text: string): boolean {
  return AI_ACRONYM.test(text) || AI_COMPOUND.test(text) || AI_WORDS.test(text) || AI_PRODUCTS.test(text) || CURSOR.test(text);
}

/** Whether the text names AI. In a file written for agents, only work AI made does. */
function namesAi(text: string, forAgents: boolean): boolean {
  return forAgents ? AI_MADE.test(text) : namesAiItself(text) || AGENT_WORDS.test(text);
}

// ---------------------------------------------------------------------------
// Words that say no.

/** Any word that says no, limits, or refuses. */
const NEGATIVE =
  /\bnot\b|n't\b|\b(?:cannot|dont|doesnt|didnt|wont|cant|isnt|arent|wasnt|werent|shouldnt|mustnt|wouldnt|couldnt|hasnt|havent|no|never|none|nor|neither|nobody|nothing|unable|unwilling|refus\w*|reject\w*|ban|bans|banned|banning|prohibit\w*|forbid\w*|forbade|disallow\w*|declin\w*|deny|denied|denies|avoid\w*|refrain\w*|discourag\w*|stop|only|except|unless|restrict\w*|limit\w*|unwelcome|unacceptable|intolerable|close|closed|delet\w*|remov\w*|revert\w*|lock|locked|blocked|ignor\w*|spam|slop|against|instead|rather)\b|zero[- ]tolerance/i;

/** The words that refuse outright, beyond a plain negative. */
const REFUSAL =
  /\b(?:refus\w*|reject\w*|ban|bans|banned|banning|prohibit\w*|forbid\w*|forbade|disallow\w*|declin\w*|unwelcome|unacceptable|intolerable|closed|deleted|removed|reverted|locked|blocked|ignored|spam|slop)\b|zero[- ]tolerance|\bnot\s+(?:be\s+|being\s+)?(?:accepted|allowed|permitted|welcome|welcomed|tolerated|merged|reviewed|considered|wanted)\b|(?:\bnot|n't|\bnever|\bcannot)\s+(?:[\w'-]+\s+)?(?:accept|allow|permit|welcome|tolerate|merge|review|consider|take|want)\b/i;

// ---------------------------------------------------------------------------
// The forms known to say no to something else. Each is tested both ways.

// 1. A checkbox a contributor ticks, like "- [ ] I did not use AI", is their
//    choice, unless it asks them to confirm or promise, or refuses outright.
const CHECKBOX = /^\s*(?:(?:[-*+]|\d+[.)])\s+\[[ xX]?\]|-\s+label:)/;
const PLEDGE = /\b(?:confirm|certify|agree|attest|declare|promise|affirm|understand|acknowledge|accept|will|shall|must)\b|\bam aware\b|\bhave read\b/i;

// 2. A negative that keeps AI off issues with a label named in quotes or
//    backticks: the whole sentence has to be one of these.
const AI_NAME = String.raw`(?:AI|LLMs?|agents?|coding agents?|AI agents?|AI assistants?|AI tools?)`;
const LABEL = String.raw`["\x60]([^"\x60]{1,50})["\x60]`;
const LABEL_SCOPES = [
  new RegExp(String.raw`^(?:please\s+)?(?:do not|don't|dont|never)\s+use\s+(?:any\s+)?${AI_NAME}(?:\s+tools?)?\s+(?:on|for)\s+(?:issues?\s+)?(?:labell?ed|tagged|with the label)\s+${LABEL}(?:\s+issues?)?[.!]?$`, 'i'),
  new RegExp(String.raw`^(?:please\s+)?(?:do not|don't|dont|never)\s+use\s+(?:any\s+)?${AI_NAME}(?:\s+tools?)?\s+(?:on|for)\s+${LABEL}\s+issues?[.!]?$`, 'i'),
  new RegExp(String.raw`^${AI_NAME}(?:\s+tools?)?\s+(?:may|must|should|can)\s*not\s+be\s+used\s+(?:on|for)\s+(?:issues?\s+)?(?:labell?ed|tagged|with the label)\s+${LABEL}(?:\s+issues?)?[.!]?$`, 'i'),
];

// 3. A negative that keeps agents from working on their own. The sentence
//    names no AI but agents, and refuses nothing outright.
const AUTONOMY =
  /\b(?:autonomous(?:ly)?|unsupervised|unattended|fully[- ]automated|on (?:its|their|your) own|without (?:a |any )?(?:human|person|people|review|supervision|oversight))\b/gi;

// 4. Opening a pull request only once it's ready, like "Never open a PR
//    without running the tests". The rest of the sentence names no AI and
//    has no negative.
const PR_PREP =
  /^(?:please\s+)?(?:do not|don't|dont|never)\s+(?:open|submit|create|send|file)\s+(?:a\s+|any\s+|your\s+)?(?:PR|PRs|pull requests?|patch(?:es)?)\s+(?:before|without|until)\s+(?:you\s+(?:have\s+)?)?(?:running|run|passing|checking|testing|reading|updating|adding|writing|discussing|opening|filing|signing)\b/i;

// Phrases taken out before the rest of the sentence is looked at again. Each
// holds a negative that says no to something else, and none is taken out
// when the words it spans hold another, beyond the words it `owns`.
const SAFE_PHRASES: { name: string; pattern: RegExp; owns?: RegExp; means?: 'personInLoop' }[] = [
  // 5. Code you don't understand: a person in the loop.
  {
    name: 'understanding',
    pattern:
      /\b(?:please\s+)?(?:do not|don't|dont|never)\s+(?:submit|open|send|contribute|push|commit|post)\s+(?:any\s+)?(?:code|changes|work|anything|a PR|PRs|pull requests|a pull request|a change)\s+(?:that\s+)?you\s+(?:do not|don't|dont|can't|cannot|could not|couldn't)\s+(?:fully\s+)?(?:understand|explain|stand behind|vouch for|review)\b/gi,
    owns: /\byou\s+(?:do not|don't|dont|can't|cannot|could not|couldn't)\b/gi,
    means: 'personInLoop',
  },
  // 6. Reminders: "don't forget to", "don't hesitate to", "no need to".
  { name: 'reminder', pattern: /\b(?:do not|don't|dont|never)\s+(?:forget|hesitate|be afraid)\s+to\b|\bno need to\b|\bno problem\b/gi },
  // 7. Keeping a template whole: "don't delete this section".
  {
    name: 'template',
    pattern:
      /\b(?:please\s+)?(?:do not|don't|dont|never)\s+(?:delete|remove|edit|change|modify|skip)\s+(?:this|the|these|any of the|any)\s+(?:section|template|line|lines|heading|headings|checklist|checkbox(?:es)?|box(?:es)?|comment|comments|questions?)\b/gi,
    owns: /\b(?:delete|remove)\b/gi,
  },
  // 8. Disclosure: "don't submit AI-assisted code without disclosing it",
  //    "undisclosed AI use is not allowed".
  {
    name: 'disclosure',
    pattern:
      /\b(?:please\s+)?(?:do not|don't|dont|never)\s+(?:submit|open|send|use|contribute|post)\b[^.!?]{0,80}?\bwithout\s+(?:first\s+)?(?:disclosing|disclosure|saying so|mentioning|noting|telling us|marking|labell?ing)(?:\s+(?:it|that|this|so))?|\bundisclosed\b[^.!?]{0,60}?\b(?:is|are)\s+not\s+(?:allowed|accepted|permitted|welcome|ok|okay)\b/gi,
  },
];

// ---------------------------------------------------------------------------
// Refusing pull requests altogether, whatever the reason.

const PRS = String.raw`(?:pull requests?|PRs?|contributions|patch(?:es)?|code contributions)`;
// A refusal that names what kind of pull request it refuses, like "without
// tests", is about how to contribute, and refuses no one.
// "For" and "to" qualify a refusal unless what follows is the project, or a
// time, as in "for this repo" or "for now".
const THE_PROJECT = String.raw`(?:(?:this|the|our|my)\s+(?:project|repo|repository|codebase|code|library|package)|now|the\s+(?:time\s+being|moment)|any\s+reason|anything)\b`;
const QUALIFIER = new RegExp(
  String.raw`^(?:without|that|which|who|unless|if|until|containing|whose|lacking|missing|before|except|with|where|when|against|targeting|touching|changing|larger|bigger|over|autonomously|on\s+(?:its|their|your)\s+own|on\s+(?:issues?|tickets?)|(?:for|to)\s+(?!${THE_PROJECT}))\b`,
  'i',
);
// Each pattern ends at the pull requests it refuses. The words after them
// say whether the refusal is qualified.
const REFUSES_PRS: RegExp[] = [
  new RegExp(
    String.raw`(?:\bnot|n't|\bnever|\bno longer|\bcannot|\bunable to|\brefuse to)\s+(?:[\w'-]+\s+)?(?:accept|take|merge|review|consider|want|welcome)\w*\s+(?:(?:any|outside|external|unsolicited|community|third[- ]party|public|new|more|further)\s+)*${PRS}\b`,
    'gi',
  ),
  new RegExp(
    String.raw`\bnot\s+(?:currently\s+|yet\s+)?(?:accepting|taking|reviewing|merging|looking for|open to|interested in)\s+(?:(?:any|outside|external|new)\s+)*${PRS}\b`,
    'gi',
  ),
  new RegExp(String.raw`\bno\s+(?:outside\s+|external\s+|unsolicited\s+)?${PRS}\b`, 'gi'),
  new RegExp(String.raw`(?:\bdo not|\bdon't|\bdont|\bnever)\s+(?:open|submit|send|file|create)\s+(?:a\s+|any\s+)?(?:pull requests?|PRs?|patch(?:es)?)\b`, 'gi'),
];
// Pull requests, then up to four words, then that they aren't taken. The
// first of the words says whether the refusal is qualified.
const PRS_NOT_TAKEN = new RegExp(
  String.raw`${PRS}((?:\s+[\w'-]+){0,4}?)\s+(?:(?:are|is|will be)\s+(?:not|no longer)|(?:won't|will not|can't|cannot)\s+be|aren't|isn't)\s+(?:being\s+)?(?:accepted|taken|merged|reviewed|considered|welcome)\b`,
  'gi',
);
const CLOSED_TO = /\bclosed\s+to\s+(?:outside\s+|external\s+)?(?:contributions|pull requests|PRs)\b/i;
/** The most of the words after a refusal that are read for a qualifier. */
const QUALIFIER_SPAN = 80;

/** Whether the words after a refusal say which pull requests it refuses, after any comma or parenthesis. */
function qualified(after: string): boolean {
  return QUALIFIER.test(after.replace(/^[\s,(]+/, ''));
}

/** Whether a sentence says the project takes no pull requests, or no contributions, anywhere in it. */
function refusesPullRequests(text: string): boolean {
  for (const pattern of REFUSES_PRS) {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (!qualified(text.slice(end, end + QUALIFIER_SPAN))) return true;
    }
  }
  for (const match of text.matchAll(PRS_NOT_TAKEN)) {
    if (!qualified(match[1] ?? '')) return true;
  }
  return CLOSED_TO.test(text);
}

// In a file written for agents, a sentence that says no about contributing
// talks about the agent reading it.
const ABOUT_CONTRIBUTING =
  /\bcontribut\w*|\baccept\w*|\b(?:open|submit|create|send|file|make)\w*\s+(?:a\s+|any\s+|new\s+)?(?:pull requests?|PRs?|patch(?:es)?)\b|\b(?:pull requests?|PRs?|patch(?:es)?)\s+(?:from|by)\b|\bwrite\s+(?:any\s+)?(?:code|changes|patches)\s+(?:for|in|to)\s+this\b/i;

// ---------------------------------------------------------------------------
// Welcomes.

const WELCOMES_ANY = /\b(?:AI|LLMs?|agents?|agent|ai)\b|\b(?:Claude|Codex|Copilot|ChatGPT|Cursor|Gemini)\b/i;
const INVITES = [
  /\b(?:(?:AI|coding|autonomous|LLM)[- ])?agents\s+(?:may|can|are (?:welcome|invited|encouraged|free|allowed) to)\s+(?:open|submit|send|make|create|file|contribute|work)\b/i,
  /\ban? (?:(?:AI|coding|autonomous)[- ])?agent\s+(?:may|can|is (?:welcome|invited|encouraged|free|allowed) to)\s+(?:open|submit|send|make|create|file|contribute|work)\b/i,
  /\b(?:(?:AI|coding)[- ])?agent[- ]?(?:made |written |opened |authored )?(?:pull requests|PRs|contributions|patches)\s+(?:are|is)\s+(?:welcome|accepted|encouraged|fine|allowed)\b/i,
  /\b(?:pull requests|PRs|contributions|patches)\s+(?:from|by)\s+(?:(?:AI|coding|autonomous)[- ])?agents\s+(?:are|is)\s+(?:welcome|accepted|encouraged|fine|allowed)\b/i,
  /\b(?:we|this project|this repo(?:sitory)?|maintainers)\s+(?:welcome|welcomes|accept|accepts|invite|invites|encourage|encourages)\s+(?:pull requests|PRs|contributions|patches)\s+(?:from|by|made by|opened by)\s+(?:(?:AI|coding|autonomous)[- ])?agents\b/i,
  /\b(?:we|this project|this repo(?:sitory)?)\s+(?:welcome|welcomes|invite|invites)\s+(?:(?:AI|coding|autonomous)[- ])?agents\b/i,
  /\b(?:(?:AI|coding)[- ])?agents\s+are\s+welcome\b/i,
];
const TOOLS = String.raw`(?:AI|LLMs?|an? (?:AI|LLM|coding)|coding agents|agents|AI tools|Claude(?: Code)?|Codex|Copilot|ChatGPT|Cursor|Gemini)`;
const ALLOWS = [
  /\b(?:AI|LLM)[- ](?:assisted|generated|written|made|aided)\s+(?:code|contributions?|pull requests|PRs|changes|patches|work|commits)\s+(?:is|are)\s+(?:fine|welcome|allowed|accepted|okay|ok|permitted|encouraged)\b/i,
  /\b(?:AI|LLM|agent)\s+(?:help|assistance|tools?|use|usage)\s+(?:is|are)\s+(?:fine|welcome|allowed|accepted|okay|ok|permitted|encouraged)\b/i,
  /\b(?:AI|LLMs?)\s+(?:is|are)\s+(?:fine|welcome|allowed|okay|ok|permitted)\b/i,
  /\b(?:using|use of)\s+(?:AI|LLMs?|(?:AI |coding )?(?:agents|assistants|tools))\s+(?:is|are)\s+(?:fine|welcome|allowed|okay|ok|permitted|encouraged)\b/i,
  new RegExp(String.raw`\b(?:you may|you can|feel free to|you're welcome to|you are welcome to|it's fine to|it is fine to)\s+use\s+${TOOLS}`, 'i'),
  /\b(?:we|this project|this repo(?:sitory)?)\s+(?:welcome|welcomes|accept|accepts|allow|allows|encourage|encourages)\s+(?:AI|LLM)[- ](?:assisted|generated|written|made|aided)\b/i,
];

// A person in the loop.
const PERSON_IN_LOOP =
  /\b(?:a (?:person|human)|you)\s+(?:must|should|need to|have to)\s+(?:(?:fully|personally)\s+)?(?:review|understand|explain|stand behind|take responsibility)\b|\bhuman[- ]in[- ]the[- ]loop\b|\b(?:human|person|manual) review (?:is )?required\b/i;

// A canary: instructions that single out an agent reading the file.
const CANARY =
  /\b(?:if|when)\s+you(?:'re|\s+are)\s+(?:an?\s+)?(?:AI|LLM|large language model|language model|coding agent|AI agent|agent|AI assistant|coding assistant|assistant|bot)\b[^.]{0,120}?\b(?:include|add|put|mention|say|write|start|end|begin|use|append|prefix|sign)\b/i;

// Labels kept for people.
const FOR_PEOPLE =
  /\b(?:(?:reserved|kept|set aside|saved|meant|intended|only)\s+for|(?:is|are)\s+for)\s+(?:people|humans|human contributors|newcomers|new contributors|first[- ]time contributors|beginners|people new)\b/i;
const QUOTED = /["`]([^"`\n]{1,50})["`]/g;
const PRONOUN = /\b(?:it|them|these|those|they|such)\b/i;

// ---------------------------------------------------------------------------
// Reading a file.

/**
 * A sentence as the rules read it: its text with Markdown's emphasis and
 * strike marks left out, curly quotes straightened, and space folded, with
 * where it is in the file.
 */
interface Sentence {
  text: string;
  start: number;
  end: number;
  paragraph: number;
  /** Whether a heading the sentence sits under names AI. */
  underAi: boolean;
  /** Part of a checkbox a contributor ticks. */
  choice: boolean;
}

// A line that starts a block of its own: a list item, a heading, a quote, or
// a table row. Any other line goes on the one before it, since text is often
// wrapped in the middle of a sentence.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
// A sentence ends at the last of its closing marks, before a space. One
// mark at a time, so a long run of them takes one step each.
const SENTENCE_END = /[.!?](?=\s)/g;
// The HTML tags that mark emphasis, as they are spelled. Nothing is taken
// out of the text the admin sees: this is for matching alone.
const EMPHASIS_TAGS = /<\/?(?:strong|em|b|i|u|s|del|ins|mark|strike)>/gi;

/** Text for matching: emphasis gone, curly quotes straight, and space folded. */
function plain(text: string): string {
  return text
    .replace(EMPHASIS_TAGS, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*~]/g, '')
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The file's paragraphs, runs of lines with no blank line between them, and its sentences. */
function scan(text: string): { paragraphs: { start: number; end: number }[]; sentences: Sentence[] } {
  const paragraphs: { start: number; end: number }[] = [];
  const sentences: Sentence[] = [];
  const headings: { level: number; ai: boolean }[] = [];
  let block: { start: number; end: number } | null = null;
  let paragraph: { start: number; end: number } | null = null;

  const endBlock = () => {
    if (block === null) return;
    const { start, end } = block;
    block = null;
    const original = text.slice(start, end);
    const choice = CHECKBOX.test(original);
    const underAi = headings.some((h) => h.ai);
    let from = 0;
    const add = (to: number) => {
      const piece = original.slice(from, to);
      const lead = piece.length - piece.trimStart().length;
      const trimmed = piece.trim();
      if (trimmed !== '') {
        const s = start + from + lead;
        sentences.push({ text: plain(trimmed), start: s, end: s + trimmed.length, paragraph: paragraphs.length, underAi, choice });
      }
    };
    for (const match of original.matchAll(SENTENCE_END)) {
      add(match.index + match[0].length);
      from = match.index + match[0].length;
    }
    add(original.length);
  };

  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    if (line.trim() === '') {
      endBlock();
      if (paragraph) paragraphs.push(paragraph);
      paragraph = null;
    } else {
      const heading = HEADING.exec(line);
      if (BLOCK_START.test(line)) endBlock();
      if (block === null) block = { start: offset, end };
      else block.end = end;
      paragraph ??= { start: offset, end };
      paragraph.end = end;
      if (heading) {
        // A heading is a block of its own, under the headings above it.
        endBlock();
        const level = heading[1]?.length ?? 1;
        while (headings.length > 0 && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
        headings.push({ level, ai: namesAi(plain(heading[2] ?? ''), false) });
      }
    }
    offset = end + 1;
  }
  endBlock();
  if (paragraph) paragraphs.push(paragraph);
  return { paragraphs, sentences };
}

/**
 * The exact text to quote for a sentence: its paragraph, and the paragraph
 * after it too when its own is a Markdown heading. When that is longer than
 * a quote may be, the sentence alone, as the file has it, cut at the limit.
 */
function quoteOf(text: string, paragraphs: readonly { start: number; end: number }[], sentence: Sentence): string {
  const alone = () => text.slice(sentence.start, sentence.end).slice(0, MAX_POLICY_QUOTE).trim();
  const own = paragraphs[sentence.paragraph];
  if (!own) return alone();
  const next = paragraphs[sentence.paragraph + 1];
  const ownText = text.slice(own.start, own.end);
  const heading = /^#{1,6}\s/.test(ownText) && !ownText.includes('\n');
  const quote = text.slice(own.start, heading && next ? next.end : own.end).trim();
  return quote.length <= MAX_POLICY_QUOTE ? quote : alone();
}

/**
 * The whole line of the file a position is on, trimmed, cut to
 * MAX_SOURCE_LINE characters. Each file's lines are found once, and each
 * line is cut once, however many positions are asked about.
 */
function linesOf(file: PolicyFile): (index: number) => SourceLine {
  const starts = [0];
  for (let i = file.text.indexOf('\n'); i !== -1; i = file.text.indexOf('\n', i + 1)) starts.push(i + 1);
  const cut = new Map<number, SourceLine>();
  return (index) => {
    let [low, high] = [0, starts.length - 1];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    const start = starts[low] ?? 0;
    let line = cut.get(start);
    if (line === undefined) {
      const end = starts[low + 1] === undefined ? file.text.length : (starts[low + 1] ?? 0) - 1;
      line = { file, line: file.text.slice(start, end).trim().slice(0, MAX_SOURCE_LINE).trim() };
      cut.set(start, line);
    }
    return line;
  };
}

/** Names in quotes or backticks, as the text spells them. */
function quotedNames(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => (m[1] ?? '').trim()).filter((name) => name !== '');
}

/** The sentence with every safe phrase taken out, unless the words a phrase spans hold another negative. */
function withoutSafePhrases(text: string): { rest: string; personInLoop: boolean } {
  let rest = text;
  let personInLoop = false;
  for (const { pattern, owns, means } of SAFE_PHRASES) {
    rest = rest.replace(pattern, (phrase: string) => {
      // The phrase's negative is its first, and the words it owns. Another one inside it stays.
      const own = owns === undefined ? phrase : phrase.replace(owns, ' ');
      const first = NEGATIVE.exec(own);
      if (first !== null && NEGATIVE.test(own.slice(first.index + first[0].length))) return phrase;
      if (means === 'personInLoop') personInLoop = true;
      return ' ';
    });
  }
  return { rest, personInLoop };
}

/** What one sentence says, when it says no. */
type Judgement = { ban: true } | { ban: false; noAutonomy?: true; personInLoop?: true; reserved?: string[] };

/**
 * Whether a sentence that names AI, or talks about contributing in a file
 * written for agents, says no, and what it means when a safe form holds the
 * negative.
 */
function judge(sentence: Sentence, forAgents: boolean): Judgement {
  const text = sentence.text;
  if (sentence.choice && !PLEDGE.test(text) && !REFUSAL.test(text)) return { ban: false };
  for (const scope of LABEL_SCOPES) {
    const match = scope.exec(text);
    if (match?.[1] !== undefined) return { ban: false, reserved: [match[1].trim()] };
  }
  if (new RegExp(AUTONOMY.source, 'i').test(text) && !REFUSAL.test(text)) {
    const rest = text.replace(AGENT_PHRASES, ' ').replace(AUTONOMY, ' ');
    if (!namesAiItself(rest)) return { ban: false, noAutonomy: true };
  }
  const prep = PR_PREP.exec(text);
  if (prep) {
    const rest = text.slice(prep.index + prep[0].length);
    if (!NEGATIVE.test(rest) && !namesAi(rest, forAgents)) return { ban: false };
  }
  const { rest, personInLoop } = withoutSafePhrases(text);
  if (NEGATIVE.test(rest)) return { ban: true };
  return personInLoop ? { ban: false, personInLoop: true } : { ban: false };
}

function words(text: string): number {
  return text.split(' ').filter((word) => /\w/.test(word)).length;
}

/**
 * Reads the files in the order given, and sorts the repo into a tier.
 *
 * - A sentence that names AI, or sits under a heading or in a file that
 *   does, and says no, makes it a ban, whatever else the files say. So does
 *   one that says the project takes no pull requests.
 * - Otherwise a sentence that invites agents makes it invite agents, unless
 *   a file keeps agents from working on their own, asks for a person in the
 *   loop, or asks for a person-written PR description. Then, like a sentence
 *   that welcomes AI help, it allows AI with conditions.
 * - With none of these, it has no policy the crawler can use.
 */
export function readPolicy(files: readonly PolicyFile[]): PolicyReading {
  let ban: SourceLine | null = null;
  let invites: { file: PolicyFile; sentence: Sentence; quote: string } | null = null;
  let allows: { file: PolicyFile; sentence: Sentence; quote: string } | null = null;
  let noAutonomy: SourceLine | null = null;
  let personInLoop: SourceLine | null = null;
  let canary: SourceLine | null = null;
  const reserved: PolicyReading['reserved'] = [];

  for (const file of files) {
    const forAgents = FOR_AGENTS.has(file.kind);
    const aboutAi = file.kind === 'aiPolicy';
    const { paragraphs, sentences } = scan(file.text);
    const lineAt = linesOf(file);
    let previous: { paragraph: number; named: boolean } | null = null;
    for (const sentence of sentences) {
      const text = sentence.text;
      const source = lineAt(sentence.start);
      const own = namesAi(text, forAgents);
      const inherited: boolean =
        previous !== null && previous.paragraph === sentence.paragraph && previous.named && (words(text) <= 4 || PRONOUN.test(text));
      const underAi = !forAgents && sentence.underAi;
      const named: boolean = own || aboutAi || underAi || inherited;
      previous = { paragraph: sentence.paragraph, named };

      if (refusesPullRequests(text)) ban ??= source;
      const topic = named || (forAgents && ABOUT_CONTRIBUTING.test(text));
      if (topic && NEGATIVE.test(text)) {
        const judged = judge(sentence, forAgents);
        if (judged.ban) ban ??= source;
        else {
          if (judged.noAutonomy) noAutonomy ??= source;
          if (judged.personInLoop) personInLoop ??= source;
          for (const name of judged.reserved ?? []) reserved.push({ name, source });
        }
      }
      if (FOR_PEOPLE.test(text)) for (const name of quotedNames(text)) reserved.push({ name, source });
      if (PERSON_IN_LOOP.test(text)) personInLoop ??= source;
      if (forAgents && file.kind !== 'skill' && CANARY.test(text)) canary ??= source;
      if (WELCOMES_ANY.test(text)) {
        if (!invites && INVITES.some((pattern) => pattern.test(text))) {
          invites = { file, sentence, quote: quoteOf(file.text, paragraphs, sentence) };
        }
        if (!allows && ALLOWS.some((pattern) => pattern.test(text))) {
          allows = { file, sentence, quote: quoteOf(file.text, paragraphs, sentence) };
        }
      }
    }
  }

  const written = firstFound(files, findPersonWritten);
  const welcome = invites ?? allows;
  let tier: CrawlTier;
  if (ban) tier = 'bans_or_restricts';
  else if (invites && !noAutonomy && !personInLoop && !written) tier = 'invites_agents';
  else if (welcome) tier = 'allows_with_conditions';
  else tier = 'no_policy';
  return {
    tier,
    welcome:
      welcome && (tier === 'invites_agents' || tier === 'allows_with_conditions')
        ? { file: welcome.file, sentence: welcome.sentence.text, quote: welcome.quote }
        : null,
    ban,
    noAutonomy,
    personInLoop,
    personWritten: written === null ? null : written.source,
    canary,
    reserved,
  };
}

/** The first file whose text gives a match, with the line it is on. */
function firstFound<T>(files: readonly PolicyFile[], find: (text: string) => Found<T> | null): { found: T; source: SourceLine } | null {
  for (const file of files) {
    const hit = find(file.text);
    if (hit !== null) return { found: hit.found, source: linesOf(file)(hit.index) };
  }
  return null;
}

/** A label with its open issue count, as GitHub gave it. */
export interface RepoLabel {
  name: string;
  openIssues: number;
}

const lower = (text: string) => text.toLowerCase();

/**
 * Which labels the sentence names after `labeled`, `label`, or `tagged`, or
 * in quotes, in its first MAX_POLICY_QUOTE characters, the most a quote
 * holds.
 */
function namedLabels(sentence: string, labels: readonly RepoLabel[]): RepoLabel[] {
  const text = lower(sentence.slice(0, MAX_POLICY_QUOTE));
  const quoted = new Set(quotedNames(sentence.slice(0, MAX_POLICY_QUOTE)).map(lower));
  return labels.filter((label) => {
    const name = lower(label.name);
    return quoted.has(name) || ['labeled ', 'labelled ', 'label ', 'tagged '].some((word) => text.includes(`${word}${name}`));
  });
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

function source(about: CandidateSource['about'], line: SourceLine): CandidateSource {
  return { about, path: line.file.path, line: line.line };
}

/**
 * The settings and tags the crawler suggests for a repo it read, for an
 * admin to confirm, with the line behind each one the docs gave. `vouch` is
 * the path of the repo's vouch file, or null.
 */
export function suggestSettings(
  reading: PolicyReading,
  files: readonly PolicyFile[],
  labels: readonly RepoLabel[],
  vouch: string | null,
): { settings: ProjectSettingsPatch; suggestedTags: SuggestedTag[]; sources: CandidateSource[] } {
  const sources: CandidateSource[] = [];
  const reservedNames = new Set(reading.reserved.map((r) => lower(r.name)));
  const excluded = unique(labels.filter((label) => reservedNames.has(lower(label.name))));
  const open = labels.filter((label) => !reservedNames.has(lower(label.name)));
  const sentence = reading.welcome?.sentence ?? '';
  const named = namedLabels(sentence, open);
  const tags = unique([...named, ...open.filter((label) => meansReady(label.name))]).slice(0, MAX_TAGS);
  const suggested = unique([...named, ...open.filter((label) => meansReady(label.name) || keptForPeople(label.name))]).slice(
    0,
    MAX_TAGS,
  );

  const settings: ProjectSettingsPatch = {
    prMode: reading.tier === 'invites_agents' ? 'automatic' : 'reviewed',
  };
  if (tags.length > 0) settings.tags = tags.map((label) => label.name);
  if (excluded.length > 0) {
    settings.excludedTags = excluded.slice(0, MAX_TAGS).map((label) => label.name);
    for (const kept of reading.reserved) {
      if (excluded.some((label) => lower(label.name) === lower(kept.name))) sources.push(source('excludedTags', kept.source));
    }
  }
  if (vouch !== null) {
    settings.whoCanClaim = 'vouched';
    sources.push({ about: 'whoCanClaim', path: vouch, line: null });
  }
  const trailer = firstFound(files, findTrailer);
  if (trailer !== null) {
    settings.disclosure = { ...defaultDisclosure, trailer: trailer.found };
    sources.push(source('disclosure', trailer.source));
  }
  if (reading.personWritten !== null) {
    settings.personWrittenDescription = true;
    sources.push(source('personWrittenDescription', reading.personWritten));
  }
  const cla = firstFound(files, findClaLink);
  if (cla !== null) {
    settings.claUrl = cla.found;
    sources.push(source('claUrl', cla.source));
  }
  if (reading.noAutonomy !== null) sources.push(source('prMode', reading.noAutonomy));
  if (reading.personInLoop !== null) sources.push(source('prMode', reading.personInLoop));
  if (reading.canary !== null) sources.push(source('canary', reading.canary));
  return {
    settings,
    suggestedTags: suggested.map((label) => ({ name: label.name, openIssues: label.openIssues })),
    sources: dedupe(sources),
  };
}

function dedupe(sources: readonly CandidateSource[]): CandidateSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.about}\n${s.path}\n${s.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
