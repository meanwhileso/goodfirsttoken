import { MAX_AI_PASSAGE, MAX_AI_SENTENCES, MAX_POLICY_QUOTE, MAX_SOURCE_LINE, type PolicyTier } from '@goodfirsttoken/core';
import type { RepoFile } from '../projects/docs';

// The word list the policy crawler keeps beside the model policy reader
// (docs/specs/model-policy-reader.md, under The rules during the rollout).
// It decides nothing: the model reads every policy. It finds the sentences
// in a repo's docs that name AI, each with the rest of its paragraph, for
// the admin to read whatever the model said (the admin's net), and the
// passages the reader's fingerprint covers. It also splits a file into
// sentences and paragraphs the way the reader's checks need. Each piece is
// written in docs/how-it-works.md under The policy crawler.
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
 * so in them the words that name the reader name no AI unless the sentence
 * refuses.
 */
const FOR_AGENTS: ReadonlySet<PolicyFileKind> = new Set(['agents', 'claude', 'skill']);

/** A line in a file, as the file has it, behind something the crawler found. */
export interface SourceLine {
  file: PolicyFile;
  line: string;
}

/** The sentences in the files that name AI, each with the rest of its paragraph, for the admin to read. */
export interface AiPassages {
  /**
   * The first MAX_AI_SENTENCES sentences in the files that name AI, or that
   * read as about AI or about contributing in a file for agents, each with
   * the rest of its paragraph as the file has it. A paragraph longer than
   * MAX_AI_PASSAGE characters is cut around the sentence, and says where.
   * A sentence in a paragraph already kept is not kept again.
   */
  aiSentences: { file: PolicyFile; text: string; cutBefore: boolean; cutAfter: boolean }[];
  /** How many more such sentences the files have, in no paragraph kept. */
  moreAiSentences: number;
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
// In a file written for agents, words for work AI made name AI.
const AI_MADE =
  /\b(?:AI|A\.I\.|LLM|GPT|ChatGPT|Copilot|Claude|Codex|Gemini|Cursor|agent|model)[- ](?:generated|written|made|assisted|authored|created|produced|aided)\b|\bvibe[- ]?cod\w*/i;

/** Whether the text names AI, leaving out agents. */
function namesAiItself(text: string): boolean {
  return AI_ACRONYM.test(text) || AI_COMPOUND.test(text) || AI_WORDS.test(text) || AI_PRODUCTS.test(text) || CURSOR.test(text);
}

/**
 * Whether the text names AI. In a file written for agents, work AI made
 * does, and so does any AI word or agent in a sentence that refuses, like
 * "AI coding assistants are not allowed to modify this repository".
 */
function namesAi(text: string, forAgents: boolean): boolean {
  if (!forAgents) return namesAiItself(text) || AGENT_WORDS.test(text);
  return AI_MADE.test(text) || ((namesAiItself(text) || AGENT_WORDS.test(text)) && AGENT_REFUSAL.test(text));
}

// ---------------------------------------------------------------------------
// Words that say no.

// Phrases that keep something out without a word like "not".
const KEEPS_OUT = String.raw`\boff[- ]limits\b|\boff the table\b|\bat the door\b|\bkeep\s+(?:[\w'-]+\s+){0,3}?out\b|\bhard (?:no|pass)\b`;

/** The words that refuse outright, beyond a plain negative. */
const REFUSAL = new RegExp(
  String.raw`\b(?:refus\w*|reject\w*|ban|bans|banned|banning|prohibit\w*|forbid\w*|forbade|disallow\w*|declin\w*|unwelcome|unacceptable|intolerable|closed|deleted|removed|reverted|locked|blocked|ignored|spam|slop)\b|zero[- ]tolerance|${KEEPS_OUT}|\bnot\s+(?:be\s+|being\s+)?(?:accepted|allowed|permitted|welcome|welcomed|tolerated|merged|reviewed|considered|wanted)\b|(?:\bnot|n't|\bnever|\bcannot)\s+(?:[\w'-]+\s+)?(?:accept|allow|permit|welcome|tolerate|merge|review|consider|take|want)\b`,
  'i',
);

/** In a file written for agents, the words that make an AI word or an agent name AI: a refusal of AI itself. */
const AGENT_REFUSAL = new RegExp(
  String.raw`\b(?:prohibit\w*|forbid\w*|forbade|banned|disallow\w*|unwelcome|refus\w*|reject\w*|declin\w*)\b|${KEEPS_OUT}|\bnot\s+(?:be\s+|being\s+)?(?:allowed|permitted|welcome|welcomed|wanted|accepted|tolerated)\b|(?:\bnot|n't|\bnever|\bcannot)\s+(?:[\w'-]+\s+)?(?:allow|permit|welcome|want|accept|tolerate)\b`,
  'i',
);

// Bans with no AI word of their own: generated work turned away, work only a
// person may write, and a project free of AI.
const GENERATED_WORK =
  /\b(?:fully\s+|auto[- ]?|machine[- ]|tool[- ])?generated\s+(?:code|pull requests?|PRs?|contributions?|patch(?:es)?|issues?|changes|commits?|content|text|comments?|reviews?)\b|\b(?:code|pull requests?|PRs?|contributions?|patch(?:es)?|issues|changes|content|output|text)\s+(?:(?:that|which)\s+(?:was|were|is|are)\s+)?generated\s+by\s+(?:a\s+|an\s+|any\s+)?(?:tools?|models?|machines?|assistants?)\b/i;
const HUMAN_ONLY =
  /\b100\s?%\s+(?:human|hand)[- ]?(?:written|made|authored|crafted|coded)\b|\b(?:human|hand)[- ](?:written|made|authored|crafted|coded)\s+only\b|\bonly\s+(?:[\w'-]+\s+){0,2}?(?:human|hand)[- ](?:written|made|authored|crafted|coded)\b|\b(?:written|made|authored|created|typed|coded)\s+(?:entirely|only|solely|fully|completely|wholly|exclusively)\s+by\s+(?:a\s+)?(?:humans?|persons?|people|hand)\b|\b(?:must|should|has to|have to|needs? to)\s+be\s+(?:written|made|authored|created|typed|coded)\s+by\s+(?:a\s+)?(?:humans?|persons?|people|hand)\b/i;
// Asking for a PR description a person wrote is a condition, not a ban.
const ABOUT_DESCRIPTION = /\b(?:descriptions?|messages?|summary|summaries|titles?|explanations?)\b/i;
const AI_FREE = /\b(?:AI|A\.I\.|LLM|GenAI|gen[- ]AI)[- ]free\b/i;

/** Whether a sentence bans AI with no word that names it: it turns away generated work, asks for work only a person wrote, or calls the project AI-free. */
function bansWithoutNaming(text: string): boolean {
  return (GENERATED_WORK.test(text) && REFUSAL.test(text)) || (HUMAN_ONLY.test(text) && !ABOUT_DESCRIPTION.test(text)) || AI_FREE.test(text);
}

/**
 * Whether a text names AI by the word list, or bans it with no word for it.
 * In a file written for agents, it names AI only as namesAi reads it there,
 * so "Claude, run the tests" doesn't. The model reader's fingerprint keeps
 * the passages that do, and leaves out the ones the admin's net keeps only
 * because they talk about contributing in a file for agents.
 */
export function namesAiByWordList(text: string, forAgents = false): boolean {
  return namesAi(text, forAgents) || bansWithoutNaming(text);
}

/** Whether a file is one written for the agents that work in the repo. */
export function forAgents(kind: PolicyFileKind): boolean {
  return FOR_AGENTS.has(kind);
}

// ---------------------------------------------------------------------------
// The marks around a sentence.

// A list item's mark, a checkbox, an issue form's option, a heading's marks,
// or a quote's mark, before a sentence. An HTML comment's marks around it are
// taken off by plain string checks in bare, which know both ways a comment
// can close.
const MARKS_BEFORE = /^(?:-\s+label:\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]?\]\s*)?|#{1,6}\s+|>\s*)?/;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSES = ['-->', '--!>'];

/** The sentence without the marks around it. Exported for the model reader's checks. */
export function bare(text: string): string {
  let rest = text;
  if (rest.startsWith(COMMENT_OPEN)) rest = rest.slice(COMMENT_OPEN.length).trimStart();
  rest = rest.replace(MARKS_BEFORE, '');
  const end = rest.trimEnd();
  const close = COMMENT_CLOSES.find((mark) => end.endsWith(mark));
  return close === undefined ? rest : end.slice(0, -close.length).trimEnd();
}

// A checkbox a contributor ticks, or an issue form's option, which is a list item.
const CHECKBOX = /^\s*(?:(?:[-*+]|\d+[.)])\s+\[[ xX]?\]|-\s+label:)/;

// In a file written for agents, a sentence about contributing talks about
// the agent reading it, so the admin's net keeps it.
const ABOUT_CONTRIBUTING =
  /\bcontribut\w*|\baccept\w*|\b(?:open|submit|create|send|file|make)\w*\s+(?:a\s+|any\s+|new\s+)?(?:pull requests?|PRs?|patch(?:es)?)\b|\b(?:pull requests?|PRs?|patch(?:es)?)\s+(?:from|by)\b|\bwrite\s+(?:any\s+)?(?:code|changes|patches)\s+(?:for|in|to)\s+this\b/i;

// A sentence that points back, which takes its AI naming from the one before.
const PRONOUN = /\b(?:it|its|that|them|these|those|they|such)\b/i;

// ---------------------------------------------------------------------------
// Reading a file.

/**
 * A sentence as the word list reads it: its text with Markdown's emphasis and
 * strike marks left out, curly quotes straightened, and space folded, with
 * where it is in the file.
 */
export interface Sentence {
  text: string;
  start: number;
  end: number;
  paragraph: number;
  /** Whether a heading the sentence sits under names AI. */
  underAi: boolean;
  /** Part of a list: a list item, a checkbox, or an issue form's option. */
  item: boolean;
}

// A line that starts a block of its own: a list item, a heading, a quote, or
// a table row. Any other line goes on the one before it, since text is often
// wrapped in the middle of a sentence.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;
const LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/;
const NUMBERED_MARK = /^\s*\d+[.)]\s/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
// A sentence ends at the last of its closing marks, before a space. One
// mark at a time, so a long run of them takes one step each.
const SENTENCE_END = /[.!?](?=\s)/g;
// The model reader's checks split finer, so a quote of a sentence the file
// marks up still matches it whole. There a sentence also ends after the
// marks that close it, like `.**`, `."`, or `.\` before a hard line break,
// when the next sentence starts with a capital letter or a Chinese or
// Japanese character, so `"AI is welcome." *isn't* our policy` stays whole.
// Struck text, `~~`, and a closing parenthesis close nothing. A Chinese or
// Japanese full stop, question mark, or exclamation mark ends one with no
// space after it, unless a closing bracket or quote follows, since what
// comes after the brackets may reject what is inside. An HTML comment's
// opening mark at the start of a line, and its closing mark at the end of
// one, stand alone, so a line inside a comment starts a sentence, unless
// the text after the comment goes on in lower case, as a sentence the
// comment interrupts does.
const CHECK_CUTS = /[.!?]["'’”*_\\]*(?=\s)|[。！？](?![」』”’）)\]"'])|(?<=(?:^|\n)[ \t]*)<!--|--!?>(?=[ \t]*(?:\r?\n|$))/g;
// After a sentence end with closing marks, the space and a letter that starts a sentence.
const NEXT_START = /\s*[\p{Lu}\p{Lt}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/uy;
const COMMENT_CLOSE = /--!?>/g;
// After a comment's closing mark, text that goes on in lower case, past any marks.
const GOES_ON = /\s*[*_~`"'([\-–]*\p{Ll}/uy;
// The HTML tags that mark emphasis, as they are spelled. Nothing is taken
// out of the text the admin sees: this is for matching alone.
const EMPHASIS_TAGS = /<\/?(?:strong|em|b|i|u|s|del|ins|mark|strike)>/gi;

/** A character plain changes, or space it folds or trims. */
const PLAIN_CHANGES = /[<’‘“”*~_\s]/;

/** Text for matching: emphasis gone, curly quotes straight, and space folded. Exported for the model reader's checks. */
export function plain(text: string): string {
  // Most short pieces have nothing to change, and a file can hold many.
  if (!PLAIN_CHANGES.test(text)) return text;
  return text
    .replace(EMPHASIS_TAGS, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*~]/g, '')
    .replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The file's paragraphs, runs of lines with no blank line between them, and
 * its sentences. Exported for the model reader's checks, which pass
 * `checks` for the finer split CHECK_CUTS gives, with a heading found on a
 * line that ends in a carriage return too. The paragraphs are the same
 * either way. The word list keeps the split it has, so its passages and the
 * reader's fingerprint read as they did.
 */
export function scan(text: string, { checks = false }: { checks?: boolean } = {}): { paragraphs: { start: number; end: number }[]; sentences: Sentence[] } {
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
    const item = CHECKBOX.test(original) || LIST_ITEM.test(original);
    const underAi = headings.some((h) => h.ai);
    let from = 0;
    const add = (to: number) => {
      const piece = original.slice(from, to);
      const lead = piece.length - piece.trimStart().length;
      const trimmed = piece.trim();
      if (trimmed !== '') {
        const s = start + from + lead;
        sentences.push({ text: plain(trimmed), start: s, end: s + trimmed.length, paragraph: paragraphs.length, underAi, item });
      }
    };
    // A numbered item's mark, like "1. ", isn't the end of a sentence.
    const mark = NUMBERED_MARK.exec(original)?.[0].length ?? 0;
    // Where the next comment's closing mark ends, found once for every opening mark before it.
    let closeAt = -2;
    const goesOn = (at: number) => {
      GOES_ON.lastIndex = at;
      return GOES_ON.test(original);
    };
    for (const match of original.matchAll(checks ? CHECK_CUTS : SENTENCE_END)) {
      if (match.index < mark) continue;
      const after = match.index + match[0].length;
      if (checks && /^[.!?]./.test(match[0])) {
        NEXT_START.lastIndex = after;
        if (!NEXT_START.test(original)) continue;
      }
      if (checks && match[0].startsWith('<')) {
        if (closeAt !== -1 && closeAt < match.index) {
          COMMENT_CLOSE.lastIndex = match.index;
          const close = COMMENT_CLOSE.exec(original);
          closeAt = close === null ? -1 : close.index + close[0].length;
        }
        if (closeAt !== -1 && goesOn(closeAt)) continue;
      }
      if (checks && match[0].startsWith('-') && goesOn(after)) continue;
      if (match[0].startsWith('<') || match[0].startsWith('-')) {
        // A comment's mark is a piece of its own.
        add(match.index);
        from = match.index;
      }
      add(after);
      from = after;
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
      const heading = HEADING.exec(checks ? line.replace(/\r$/, '') : line);
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

/** The word list's sentences of each file, found once. */
const wordListSentences = new WeakMap<PolicyFile, Sentence[]>();

/**
 * The word list's sentences that hold the pieces the model reader's checks
 * split finer, each once, in order, so what the admin sees and the reader's
 * fingerprint read whole sentences as the word list splits them. Every
 * piece is inside one, as the checks only split more. Exported for the
 * model reader.
 */
export function holdingSentences(file: PolicyFile, pieces: readonly Sentence[]): Sentence[] {
  let sentences = wordListSentences.get(file);
  if (sentences === undefined) {
    sentences = scan(file.text).sentences;
    wordListSentences.set(file, sentences);
  }
  const held: Sentence[] = [];
  for (const piece of pieces) {
    let [low, high] = [0, sentences.length - 1];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((sentences[middle]?.start ?? 0) <= piece.start) low = middle;
      else high = middle - 1;
    }
    const found = sentences[low];
    // A piece no sentence holds stands for itself, though none should.
    const holder = found !== undefined && found.start <= piece.start && piece.end <= found.end ? found : piece;
    if (held.at(-1) !== holder) held.push(holder);
  }
  return held;
}

/**
 * The exact text to quote for a sentence: its paragraph, and the paragraph
 * after it too when its own is a Markdown heading. When that is longer than
 * a quote may be, the sentence alone, as the file has it, cut at the limit.
 */
export function quoteOf(text: string, paragraphs: readonly { start: number; end: number }[], sentence: Sentence): string {
  const alone = () => text.slice(sentence.start, sentence.end).slice(0, MAX_POLICY_QUOTE).trim();
  const own = paragraphs[sentence.paragraph];
  if (!own) return alone();
  const next = paragraphs[sentence.paragraph + 1];
  const ownText = text.slice(own.start, own.end);
  const heading = /^#{1,6}\s/.test(ownText) && !ownText.includes('\n');
  const quote = text.slice(own.start, heading && next ? next.end : own.end).trim();
  return quote.length <= MAX_POLICY_QUOTE ? quote : alone();
}

/** Where a passage is in its file, and whether its paragraph goes on before or after it. */
interface Passage {
  start: number;
  end: number;
  cutBefore: boolean;
  cutAfter: boolean;
}

// The words a passage centers on: those that name AI, or ban it with no
// name for it. A sentence with none of them centers on its start.
const CENTER_ON = [AI_ACRONYM, AI_COMPOUND, AI_WORDS, AI_PRODUCTS, CURSOR, AGENT_WORDS, GENERATED_WORK, HUMAN_ONLY, AI_FREE];
/** How far a cut moves to fall between words. */
const WORD_SLACK = 30;

/** Where in the file the first word of a sentence that names AI is, or where the sentence starts. */
function centerOf(text: string, sentence: Sentence): number {
  const own = text.slice(sentence.start, sentence.end);
  let at = own.length;
  for (const pattern of CENTER_ON) {
    const match = pattern.exec(own);
    if (match !== null && match.index < at) at = match.index;
  }
  return sentence.start + (at === own.length ? 0 : at);
}

/**
 * The passage around a sentence: its whole paragraph, or when that is longer
 * than MAX_AI_PASSAGE characters, MAX_AI_PASSAGE characters of it centered
 * on the words that name AI, each cut moved to fall between words.
 */
function passageOf(text: string, paragraph: { start: number; end: number }, center: number): Passage {
  if (paragraph.end - paragraph.start <= MAX_AI_PASSAGE) return { ...paragraph, cutBefore: false, cutAfter: false };
  let start = Math.max(paragraph.start, Math.min(center - MAX_AI_PASSAGE / 2, paragraph.end - MAX_AI_PASSAGE));
  if (start > paragraph.start) {
    const space = text.slice(start, Math.min(start + WORD_SLACK, center)).search(/\s/);
    if (space !== -1) start += space + 1;
  }
  let end = Math.min(paragraph.end, start + MAX_AI_PASSAGE);
  if (end < paragraph.end) {
    const from = Math.max(end - WORD_SLACK, center + 1);
    const space = text.slice(from, end).search(/\s\S*$/);
    if (space !== -1) end = from + space;
  }
  return { start, end, cutBefore: start > paragraph.start, cutAfter: end < paragraph.end };
}

/**
 * The whole line of the file a position is on, trimmed, cut to
 * MAX_SOURCE_LINE characters. Each file's lines are found once, and each
 * line is cut once, however many positions are asked about.
 */
export function linesOf(file: PolicyFile): (index: number) => SourceLine {
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

/** A sentence's words, without its list mark, so "1. Never push to main" has four, as "- Never push to main" does. */
function words(text: string): number {
  return bare(text).split(' ').filter((word) => /\w/.test(word)).length;
}

/**
 * The admin's net: the sentences in the files that name AI, in the order the
 * files are read, each with the rest of its paragraph. A sentence names AI
 * when the word list finds a word for AI in it, or a ban with no word for
 * AI. Outside a file for agents, it also counts as about AI when it is in an
 * AI policy file, under a heading that names AI, in a list after a lead-in
 * that names AI and ends with a colon, or short or pointing back with a
 * pronoun after a sentence in its paragraph that names AI. In a file for
 * agents, a sentence about contributing counts too. It decides nothing.
 */
export function aiPassages(files: readonly PolicyFile[]): AiPassages {
  const aiSentences: AiPassages['aiSentences'] = [];
  const seenPassages = new Set<string>();
  let moreAiSentences = 0;

  for (const file of files) {
    const forAgents = FOR_AGENTS.has(file.kind);
    const aboutAi = file.kind === 'aiPolicy';
    const { paragraphs, sentences } = scan(file.text);
    // Whether a sentence before, in the paragraph, names AI, and whether a
    // lead-in that names AI and ends with a colon carries to the list after it.
    let paragraph = -1;
    let paragraphNamed = false;
    let listCarry = false;
    // The last passage kept from this file.
    let kept: Passage | null = null;
    for (const sentence of sentences) {
      const text = sentence.text;
      if (sentence.paragraph !== paragraph) {
        paragraph = sentence.paragraph;
        paragraphNamed = false;
        if (!sentence.item) listCarry = false;
      }
      const own = namesAi(text, forAgents);
      const inherited = paragraphNamed && (words(text) <= 4 || PRONOUN.test(text));
      const underAi = !forAgents && sentence.underAi;
      const listed = listCarry && sentence.item;
      const named: boolean = own || aboutAi || underAi || inherited || listed;
      if (named) paragraphNamed = true;
      if (named && /:$/.test(text)) listCarry = true;
      // A sentence about AI, or one about contributing in a file for agents.
      const topic = named || (forAgents && ABOUT_CONTRIBUTING.test(text));

      // Each such sentence, and each that names AI, with the rest of its paragraph, once.
      const covered = kept !== null && sentence.start >= kept.start && sentence.end <= kept.end;
      if (covered || !(topic || bansWithoutNaming(text) || namesAiItself(text) || AGENT_WORDS.test(text))) continue;
      if (aiSentences.length >= MAX_AI_SENTENCES) {
        moreAiSentences += 1;
        continue;
      }
      const passage = passageOf(file.text, paragraphs[sentence.paragraph] ?? sentence, centerOf(file.text, sentence));
      kept = passage;
      const whole = file.text.slice(passage.start, passage.end).trim();
      const key = `${file.path}\n${whole}`;
      if (!seenPassages.has(key)) {
        seenPassages.add(key);
        aiSentences.push({ file, text: whole, cutBefore: passage.cutBefore, cutAfter: passage.cutAfter });
      }
    }
  }
  return { aiSentences, moreAiSentences };
}

/** A label with its open issue count, as GitHub gave it, and its description, which the model's label check reads. */
export interface RepoLabel {
  name: string;
  openIssues: number;
  /** The repo's text. Null when the label has none, and left out where only the name and count matter. */
  description?: string | null;
}
