import {
  MAX_AI_PASSAGE,
  MAX_AI_SENTENCES,
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
// refuses, is a ban, unless the whole sentence is one of the few forms below
// known to say no to something else. A missed welcome costs a find. A missed
// ban would put a repo that said no in front of an admin.
//
// Plain rules can't know every way to say no. So the reading also keeps
// every sentence that names AI, for the admin to read before a repo is
// listed, and nothing is listed without an admin.
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
  /** Label names the docs keep away from AI or keep for people, as they spell them, each once, with its first line. */
  reserved: { name: string; source: SourceLine }[];
  /**
   * The first MAX_AI_SENTENCES sentences in the files that name AI, or that
   * the rules read for a ban, each with the rest of its paragraph as the
   * file has it, for the admin to read. A paragraph longer than
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

/** Any word that says no, limits, or refuses. */
const NEGATIVE = new RegExp(
  String.raw`\bnot\b|n't\b|\b(?:cannot|dont|doesnt|didnt|wont|cant|isnt|arent|wasnt|werent|shouldnt|mustnt|wouldnt|couldnt|hasnt|havent|no|never|none|nor|neither|nobody|nothing|unable|unwilling|refus\w*|reject\w*|ban|bans|banned|banning|prohibit\w*|forbid\w*|forbade|disallow\w*|declin\w*|deny|denied|denies|avoid\w*|refrain\w*|discourag\w*|stop|only|except|unless|restrict\w*|limit\w*|unwelcome|unacceptable|intolerable|close|closed|delet\w*|remov\w*|revert\w*|lock|locked|blocked|ignor\w*|spam|slop|against|instead|rather)\b|zero[- ]tolerance|${KEEPS_OUT}`,
  'i',
);

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
// A person-written PR description is a condition, under personWritten.
const ABOUT_DESCRIPTION = /\b(?:descriptions?|messages?|summary|summaries|titles?|explanations?)\b/i;
const AI_FREE = /\b(?:AI|A\.I\.|LLM|GenAI|gen[- ]AI)[- ]free\b/i;

/** Whether a sentence bans AI with no word that names it: it turns away generated work, asks for work only a person wrote, or calls the project AI-free. */
function bansWithoutNaming(text: string): boolean {
  return (GENERATED_WORK.test(text) && REFUSAL.test(text)) || (HUMAN_ONLY.test(text) && !ABOUT_DESCRIPTION.test(text)) || AI_FREE.test(text);
}

// ---------------------------------------------------------------------------
// The forms known to say no to something else. Each is tested both ways.
//
// Each form is a whole sentence: fixed words with a few slots, and each slot
// takes one of a closed set of words, a label in quotes, or a path. No form
// takes out part of a sentence and reads the rest, so a ban can't ride along
// with a form's words. A sentence that names AI and says no is a ban unless
// all of it, but for a list mark in front, is one of these.

// A list item's mark, a checkbox, an issue form's option, a heading's marks,
// or a quote's mark, before a sentence. An HTML comment's marks around it are
// taken off by plain string checks in bare, which know both ways a comment
// can close.
const MARKS_BEFORE = /^(?:-\s+label:\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]?\]\s*)?|#{1,6}\s+|>\s*)?/;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSES = ['-->', '--!>'];

/** The sentence without the marks around it. */
function bare(text: string): string {
  let rest = text;
  if (rest.startsWith(COMMENT_OPEN)) rest = rest.slice(COMMENT_OPEN.length).trimStart();
  rest = rest.replace(MARKS_BEFORE, '');
  const end = rest.trimEnd();
  const close = COMMENT_CLOSES.find((mark) => end.endsWith(mark));
  return close === undefined ? rest : end.slice(0, -close.length).trimEnd();
}

// The slots, each a closed set.
const END = String.raw`[.!]?$`;
const PLEASE = String.raw`(?:please\s+)?`;
const DONT = String.raw`(?:do not|don't|dont|never)`;
const PRODUCT = String.raw`(?:GitHub Copilot|Copilot|ChatGPT|Claude(?: Code)?|Codex|Gemini|Cursor)`;
const AI_THING = String.raw`(?:AI|LLMs?|AI tools?|AI assistants?|coding assistants?|an? (?:AI|LLM|agent|coding agent|AI tool|coding assistant|assistant)|agents?|coding agents?|${PRODUCT})`;
const AGENT_SUBJECT = String.raw`(?:(?:AI|coding|LLM)[- ])?(?:agents?|bots?|assistants?)`;
// "Using AI is fine, but" or "as long as you" before a form that asks for care.
const FINE_THEN = String.raw`(?:(?:using\s+)?${AI_THING}(?:\s+(?:help|use|assistance))?\s+(?:is|are)\s+(?:fine|welcome|okay|ok|allowed),?\s+(?:but|as long as|so long as|provided)\s+(?:you\s+)?)?`;

// 1. A checkbox a contributor ticks, like "- [ ] I did not use AI", in its
//    first sentence: they didn't use AI, or AI wasn't used.
const CHECKBOX = /^\s*(?:(?:[-*+]|\d+[.)])\s+\[[ xX]?\]|-\s+label:)/;
const FOR_THIS = String.raw`(?:\s+(?:to write|to make|for|in|on)\s+(?:this|it|this PR|this pull request|this issue|this change|the code|this code))?`;
const CHOICES = [
  new RegExp(String.raw`^(?:I|we)\s+(?:did not|didn't|have not|haven't|do not|don't)\s+(?:use|used)\s+(?:any\s+)?${AI_THING}${FOR_THIS}${END}`, 'i'),
  new RegExp(String.raw`^no\s+${AI_THING}\s+(?:was|were)\s+used${FOR_THIS}${END}`, 'i'),
  new RegExp(String.raw`^${AI_THING}\s+(?:was|were)\s+not\s+used${FOR_THIS}${END}`, 'i'),
];

// 2. Keeping AI off issues with one label, named in quotes or backticks. The
//    label becomes an excluded tag.
const AI_NAME = String.raw`(?:AI|LLMs?|agents?|coding agents?|AI agents?|AI assistants?|AI tools?)`;
const LABEL = String.raw`["\x60]([^"\x60]{1,50})["\x60]`;
const LABEL_SCOPES = [
  new RegExp(String.raw`^${PLEASE}${DONT}\s+use\s+(?:any\s+)?${AI_NAME}(?:\s+tools?)?\s+(?:on|for)\s+(?:issues?\s+)?(?:labell?ed|tagged|with the label)\s+${LABEL}(?:\s+issues?)?${END}`, 'i'),
  new RegExp(String.raw`^${PLEASE}${DONT}\s+use\s+(?:any\s+)?${AI_NAME}(?:\s+tools?)?\s+(?:on|for)\s+${LABEL}\s+issues?${END}`, 'i'),
  new RegExp(String.raw`^${AI_NAME}(?:\s+tools?)?\s+(?:may|must|should|can)\s*not\s+be\s+used\s+(?:on|for)\s+(?:issues?\s+)?(?:labell?ed|tagged|with the label)\s+${LABEL}(?:\s+issues?)?${END}`, 'i'),
];

// 3. Keeping agents from working on their own, like "Autonomous agents may
//    not open pull requests" or "Agents must not open PRs without a person".
const WORK = String.raw`(?:open|submit|create|send|file|make|merge|push)\s+(?:(?:a|any)\s+)?(?:PRs?|pull requests?|changes|commits?|patch(?:es)?)`;
const AUTONOMY_TAIL = String.raw`(?:on (?:its|their|your) own|autonomously|unsupervised|unattended|without (?:a |any )?(?:human review|human|person|people|review|supervision|oversight))`;
const AUTONOMY_FORMS = [
  new RegExp(String.raw`^(?:${AGENT_SUBJECT}|you)\s+(?:may|must|should|can|will)\s*(?:not|never)\s+(?:${WORK}|work|operate|run|contribute)\s+${AUTONOMY_TAIL}${END}`, 'i'),
  new RegExp(String.raw`^(?:autonomous|unsupervised|unattended|fully[- ]automated)\s+${AGENT_SUBJECT}\s+(?:may|must|should|can|will)\s*(?:not|never)\s+${WORK}${END}`, 'i'),
  new RegExp(String.raw`^${PLEASE}${DONT}\s+${WORK}\s+${AUTONOMY_TAIL}${END}`, 'i'),
];

/** A whole-sentence form, what it means, and its number in docs/how-it-works.md. */
interface SafeForm {
  form: number;
  pattern: RegExp;
  means?: 'personInLoop';
}

const form = (number: number, source: string, means?: 'personInLoop'): SafeForm => ({
  form: number,
  pattern: new RegExp(`^${source}${END}`, 'i'),
  ...(means ? { means } : {}),
});

// Rules for how to work, in form 9: who may come first, the words that say
// no, a branch, a path, and the secrets.
const WHO = String.raw`${PLEASE}(?:(?:${AGENT_SUBJECT}|you|we|contributors|they|maintainers)\s+)?`;
const MUST_NOT = String.raw`(?:do not|don't|dont|never|must not|mustn't|must never|should not|shouldn't|should never|may not|cannot|can't|will not|won't|(?:are|is) not (?:allowed|permitted) to)`;
const BRANCH = String.raw`(?:the\s+)?(?:(?:protected|shared|upstream|release|default)\s+branch(?:es)?|[\x60"']?(?:main|master|trunk|develop|dev|release|stable|production|gh-pages)[\x60"']?(?:\s+branch)?)`;
// A branch a pull request may be kept from. Every pull request goes to the
// default branch, main, master, trunk, develop, or a protected or upstream
// one, so keeping a pull request from one of those keeps it out.
const SIDE_BRANCH = String.raw`(?:the\s+)?(?:release\s+branch(?:es)?|[\x60"']?(?:release|stable|production|gh-pages)[\x60"']?(?:\s+branch)?)`;
// A path, with at least one letter, digit, underscore, or hyphen in it, so
// "/" and "./", the whole repo, are no path.
const NAMED = String.raw`(?=[./]*[\w-])`;
const PATH = String.raw`(?:\x60${NAMED}[^\x60\s]{1,60}\x60|${NAMED}[\w.-]{0,40}\/[\w./-]{0,40})`;
const SECRET = String.raw`(?:secrets?|tokens?|credentials?|passwords?|API keys?|private keys?|keys|personal (?:data|information))`;
const PR = String.raw`(?:PRs?|pull requests?)`;

const SAFE_FORMS: SafeForm[] = [
  // 4. Opening a pull request only once it's ready: "Never open a PR without
  //    running the tests."
  form(
    4,
    String.raw`${PLEASE}${DONT}\s+(?:open|submit|create|send|file)\s+(?:a\s+|any\s+|your\s+)?(?:${PR}|patch(?:es)?)\s+(?:before|without|until)\s+(?:you\s+(?:have\s+)?)?(?:running|run|passing|pass|checking|testing|reading|read|updating|updated|adding|added|discussing|opening|opened|filing|filed|signing|signed)\s+(?:(?:the|a|an|our|your)\s+)?(?:tests?|test suite|linter|lint|CI|checks|build|contributing guide|CONTRIBUTING(?:\.md)?|docs|documentation|changelog|CHANGELOG(?:\.md)?|issue|CLA|style guide|code of conduct)(?:\s+(?:first|locally))?`,
  ),
  // 5. "Don't submit code you don't understand": a person in the loop.
  form(
    5,
    String.raw`${FINE_THEN}${PLEASE}${DONT}\s+(?:submit|open|send|contribute|push|commit|post|paste)\s+(?:(?:any|large|big|long|whole)\s+)?(?:blocks? of\s+)?(?:code|changes|work|anything|output|text|a PR|PRs|pull requests|a pull request|a change)\s+(?:that\s+)?you\s+(?:do not|don't|dont|can't|cannot|could not|couldn't|have not|haven't|did not|didn't)\s+(?:fully\s+|yet\s+)?(?:understand|explain|stand behind|vouch for|review|reviewed|read|tested|test|run|checked|check)(?:\s+(?:yourself|fully|line by line))?(?:\s+(?:into|in)\s+(?:issues|pull requests|a pull request|the PR|comments))?`,
    'personInLoop',
  ),
  // 6. A reminder or a request: "Don't forget to disclose AI help", "There
  //    is no need to mention it", "You don't need to ask first", "We only
  //    ask that you disclose it."
  form(
    6,
    String.raw`${PLEASE}${DONT}\s+(?:forget|hesitate|be afraid)\s+to\s+(?:ask(?:\s+(?:questions|for help|us))?(?:\s+about\s+${AI_THING})?|(?:disclose|mention|note)\s+(?:it|that|AI help|AI use|which tools you used)|say so|tell us|reach out|open an issue)`,
  ),
  form(6, String.raw`(?:there is\s+|there's\s+)?no need to\s+(?:ask|mention|disclose|label|mark|note|say so|tell us|sign anything)(?:\s+(?:it|them|this|that|first))?`),
  form(6, String.raw`no problem`),
  form(
    6,
    String.raw`(?:you|agents|they|contributors)\s+(?:do not|don't|dont|does not|doesn't)\s+need\s+to\s+(?:ask|wait|check with us|tell us|sign anything|get permission|ask permission|request access|open an issue)(?:\s+(?:first|before\s+(?:using|you use|opening)\s+(?:it|them|a pull request|a PR|${AI_THING})))?`,
  ),
  form(
    6,
    String.raw`(?:we|I)\s+only\s+ask\s+that\s+(?:you|contributors|agents)\s+(?:disclose|mention|note|label|mark|flag)\s+(?:it|them|this|that|AI use|AI help|(?:the|which)\s+(?:tools?|models?)\s+you\s+used)(?:\s+in\s+the\s+(?:PR|pull request)(?:\s+description)?)?`,
  ),
  form(6, String.raw`(?:we|I)\s+only\s+ask\s+that\s+you\s+(?:test|review|read|check)\s+(?:it|them|your changes?|your code|your work)(?:\s+first)?`),
  // 7. Keeping a template whole: "Don't delete this section."
  form(
    7,
    String.raw`${PLEASE}${DONT}\s+(?:delete|remove|edit|change|modify|skip)\s+(?:this|the|these|any of the|any)\s+(?:section|template|line|lines|heading|headings|checklist|checkbox(?:es)?|box(?:es)?|comment|comments|questions?)(?:\s+(?:below|above|of the template|in this template))?`,
  ),
  // 8. A rule to disclose: "Don't submit AI-assisted code without disclosing
  //    it", "Undisclosed AI use is not allowed."
  form(
    8,
    String.raw`${FINE_THEN}${PLEASE}${DONT}\s+(?:submit|open|send|use|contribute|post)\s+(?:${AI_THING}|(?:AI|LLM|agent)[- ](?:assisted|generated|written|made)\s+(?:code|changes|work|pull requests|PRs|contributions|patches|commits)|(?:AI|LLM)\s+(?:output|help|code|changes)|(?:code|changes|work|pull requests|PRs|contributions|anything)\s+(?:written|made|generated)\s+(?:with|by)\s+${AI_THING})\s+without\s+(?:first\s+)?(?:disclosing|disclosure|saying so|mentioning|noting|telling us|marking|labell?ing)(?:\s+(?:it|that|this|so|them))?`,
  ),
  form(
    8,
    String.raw`undisclosed\s+(?:AI|LLM|agent)(?:[- ](?:assisted|generated|written))?(?:\s+(?:use|usage|help|code|contributions|changes|pull requests|PRs|work))?\s+(?:is|are)\s+not\s+(?:allowed|accepted|permitted|welcome|ok|okay)`,
  ),
  // 9. A rule for how to work, with nothing about AI: secrets, a branch,
  //    where a pull request goes, how many are open, whose issue it is, a
  //    folder, whom to tag, build output, and a pull request that fails.
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:include|commit|share|post|paste|expose|leak|add|put|push|upload|check in)\s+(?:any\s+|your\s+)?${SECRET}(?:\s+or\s+${SECRET})?(?:\s+(?:in|into|to)\s+(?:a|any|your|the)\s+(?:PRs?|pull requests?|commits?|issues?|repo|repository))?`,
  ),
  form(9, String.raw`${WHO}${MUST_NOT}\s+(?:force[- ])?(?:push|commit|merge)\s+(?:(?:directly|changes|code|commits)\s+)?(?:to|into|on|onto)\s+${BRANCH}(?:\s+directly)?`),
  form(9, String.raw`${WHO}${MUST_NOT}\s+(?:open|submit|send|create|file|target)\s+(?:a\s+|any\s+|your\s+)?${PR}\s+(?:against|to|into|on|at)\s+${SIDE_BRANCH}`),
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:open|submit|have|keep|send)\s+more than\s+(?:one|two|three|four|five|[1-9]\d?)\s+(?:open\s+)?(?:${PR}|issues)(?:\s+(?:at a time|at once|open|per issue|per day|per week))?`,
  ),
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:open|submit|send)\s+(?:a\s+|any\s+)?${PR}\s+(?:for|on)\s+(?:an?\s+|the\s+)?(?:issues?|tickets?)\s+(?:that\s+)?(?:someone else|somebody else|another (?:person|contributor))\s+(?:has\s+|is\s+)?(?:already\s+)?(?:claimed|working on|assigned to|took)`,
  ),
  form(9, String.raw`${WHO}${MUST_NOT}\s+(?:edit|modify|change|touch)\s+(?:any\s+|the\s+)?(?:files?|anything|code)\s+(?:in|under|inside)\s+(?:the\s+)?${PATH}(?:\s+(?:folder|directory))?`),
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:ping|tag|mention|@-?mention|email|DM|message)\s+(?:the\s+|individual\s+)?(?:maintainers?|reviewers?|us|team members?)(?:\s+(?:directly|individually))?`,
  ),
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:commit|edit|modify|check in)\s+(?:the\s+|any\s+)?(?:build|compiled|vendored|minified)\s+(?:build\s+)?(?:files?|output|artifacts?|assets?|bundles?|lockfiles?)`,
  ),
  form(
    9,
    String.raw`${WHO}${MUST_NOT}\s+(?:merge|accept|review)\s+(?:a\s+|any\s+|your\s+)?(?:${PR}|changes|patch(?:es)?)\s+(?:that|which)\s+(?:fails?|breaks?)\s+(?:CI|the build|the tests|tests|its checks|checks|lint)`,
  ),
  // 10. A rule to read what AI wrote: "Do not use AI to write commit
  //     messages without reading them." A person in the loop.
  form(
    10,
    String.raw`${FINE_THEN}${PLEASE}${DONT}\s+(?:use|paste|submit|commit|post|send)\s+(?:${AI_THING}|it|them|(?:AI|its|their|the)\s+output|AI-generated code|generated code)(?:\s+to\s+(?:write|draft|generate)\s+(?:commit messages|code|tests|docs|documentation|comments|PR descriptions|pull request descriptions|issues|changes))?\s+without\s+(?:first\s+)?(?:reading|reviewing|checking|testing|understanding|verifying|running)(?:\s+(?:it|them|the output|the result|each line|every line|the code|the changes))?(?:\s+yourself)?`,
    'personInLoop',
  ),
  // 11. A condition: "If an agent cannot run the tests, say so in the pull
  //     request."
  form(
    11,
    String.raw`if\s+(?:you|an?\s+agent|the\s+agent|your\s+agent)\s+(?:cannot|can't|can not|could not|couldn't)\s+(?:run|reproduce|build|test|fix|finish)\s+(?:the tests|the test suite|the build|it|the bug|the issue|the project|the change)(?:\s+locally)?,\s+${PLEASE}(?:say so|mention it|note it|tell us|explain why|ask for help|leave a comment)(?:\s+in\s+the\s+(?:pull request|PR|issue|PR description|pull request description))?`,
  ),
  // 12. A label that scopes where agents work: "Agents may only work on
  //     issues labeled `agent ready`."
  form(
    12,
    String.raw`(?:${AGENT_SUBJECT}|AI tools?|you)\s+(?:may|should|can|must)\s+only\s+(?:work\s+on|pick\s+up|take|claim|open\s+pull\s+requests\s+for|be\s+used\s+(?:on|for))\s+(?:open\s+)?(?:issues|tickets)\s+(?:(?:that are|which are)\s+)?(?:labell?ed|tagged|with\s+the\s+label)\s+["\x60][^"\x60]{1,50}["\x60]`,
  ),
];

/**
 * The number of the form a whole sentence is, or null. `choice` says the
 * sentence is the first of a checkbox a contributor ticks. Exported for the
 * tests, which check that no ban in their corpus is one.
 */
export function safeForm(sentence: string, choice = false): number | null {
  const text = bare(sentence);
  if (choice && CHOICES.some((pattern) => pattern.test(text))) return 1;
  if (LABEL_SCOPES.some((pattern) => pattern.test(text))) return 2;
  if (AUTONOMY_FORMS.some((pattern) => pattern.test(text))) return 3;
  return SAFE_FORMS.find(({ pattern }) => pattern.test(text))?.form ?? null;
}

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
  /\b(?:(?:AI|coding|autonomous|LLM)[- ])?agents\s+(?:may|can|are (?:welcome|invited|encouraged|free|allowed) to)\s+(?:only\s+)?(?:open|submit|send|make|create|file|contribute|work)\b/i,
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
  new RegExp(
    String.raw`\b(?:we|this project|this repo(?:sitory)?)\s+(?:welcome|welcomes|accept|accepts|(?:are|is) happy to (?:take|accept|review)|take|takes)\s+(?:contributions|pull requests|PRs|changes|patches)\s+(?:made|written|created|built|drafted)\s+(?:with|using)\s+(?:the help of\s+)?${TOOLS}`,
    'i',
  ),
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
const PRONOUN = /\b(?:it|its|that|them|these|those|they|such)\b/i;

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
  /** Part of a list: a list item, a checkbox, or an issue form's option. */
  item: boolean;
  /** The first sentence of a checkbox a contributor ticks. */
  choice: boolean;
}

// A line that starts a block of its own: a list item, a heading, a quote, or
// a table row. Any other line goes on the one before it, since text is often
// wrapped in the middle of a sentence.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;
const LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/;
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
    const checkbox = CHECKBOX.test(original);
    const item = checkbox || LIST_ITEM.test(original);
    const underAi = headings.some((h) => h.ai);
    let from = 0;
    let first = true;
    const add = (to: number) => {
      const piece = original.slice(from, to);
      const lead = piece.length - piece.trimStart().length;
      const trimmed = piece.trim();
      if (trimmed !== '') {
        const s = start + from + lead;
        sentences.push({ text: plain(trimmed), start: s, end: s + trimmed.length, paragraph: paragraphs.length, underAi, item, choice: checkbox && first });
        first = false;
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

/** A text's sentences as the rules read them, and whether each is a checkbox's first. Exported for the tests. */
export function sentencesOf(text: string): { text: string; choice: boolean }[] {
  return scan(text).sentences.map((sentence) => ({ text: sentence.text, choice: sentence.choice }));
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

/** What one sentence says, when it says no. */
type Judgement = { ban: true } | { ban: false; noAutonomy?: true; personInLoop?: true; reserved?: string[] };

/**
 * What a sentence that names AI, or talks about contributing in a file
 * written for agents, and says no, means: a ban, unless the whole sentence
 * is one of the forms.
 */
function judge(sentence: Sentence): Judgement {
  const text = bare(sentence.text);
  if (sentence.choice && CHOICES.some((pattern) => pattern.test(text))) return { ban: false };
  for (const scope of LABEL_SCOPES) {
    const match = scope.exec(text);
    if (match?.[1] !== undefined) return { ban: false, reserved: [match[1].trim()] };
  }
  if (AUTONOMY_FORMS.some((pattern) => pattern.test(text))) return { ban: false, noAutonomy: true };
  const safe = SAFE_FORMS.find(({ pattern }) => pattern.test(text));
  if (safe === undefined) return { ban: true };
  return safe.means === 'personInLoop' ? { ban: false, personInLoop: true } : { ban: false };
}

function words(text: string): number {
  return text.split(' ').filter((word) => /\w/.test(word)).length;
}

/**
 * Reads the files in the order given, and sorts the repo into a tier.
 *
 * - A sentence that names AI, or sits under a heading or in a file that
 *   does, and says no, makes it a ban, whatever else the files say. So does
 *   one that says the project takes no pull requests, one that turns away
 *   generated work, one that asks for work only a person wrote, and one
 *   that calls the project AI-free.
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
  const reserved = new Map<string, { name: string; source: SourceLine }>();
  const keep = (name: string, source: SourceLine) => {
    const key = name.toLowerCase();
    if (!reserved.has(key)) reserved.set(key, { name, source });
  };
  const aiSentences: PolicyReading['aiSentences'] = [];
  const seenPassages = new Set<string>();
  let moreAiSentences = 0;

  for (const file of files) {
    const forAgents = FOR_AGENTS.has(file.kind);
    const aboutAi = file.kind === 'aiPolicy';
    const { paragraphs, sentences } = scan(file.text);
    const lineAt = linesOf(file);
    // Whether a sentence before, in the paragraph, names AI, and whether a
    // lead-in that names AI and ends with a colon carries to the list after it.
    let paragraph = -1;
    let paragraphNamed = false;
    let listCarry = false;
    // The last passage kept from this file.
    let kept: Passage | null = null;
    for (const sentence of sentences) {
      const text = sentence.text;
      const source = lineAt(sentence.start);
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
      // What the rules read for a ban: a sentence about AI, or one about contributing in a file for agents.
      const topic = named || (forAgents && ABOUT_CONTRIBUTING.test(text));

      // The admin sees each sentence the rules read for a ban, and each that
      // names AI, with the rest of its paragraph, once.
      const covered = kept !== null && sentence.start >= kept.start && sentence.end <= kept.end;
      if (!covered && (topic || bansWithoutNaming(text) || namesAiItself(text) || AGENT_WORDS.test(text))) {
        if (aiSentences.length < MAX_AI_SENTENCES) {
          const passage = passageOf(file.text, paragraphs[sentence.paragraph] ?? sentence, centerOf(file.text, sentence));
          kept = passage;
          const whole = file.text.slice(passage.start, passage.end).trim();
          const key = `${file.path}\n${whole}`;
          if (!seenPassages.has(key)) {
            seenPassages.add(key);
            aiSentences.push({ file, text: whole, cutBefore: passage.cutBefore, cutAfter: passage.cutAfter });
          }
        } else moreAiSentences += 1;
      }

      if (refusesPullRequests(text) || bansWithoutNaming(text)) ban ??= source;
      if (topic && NEGATIVE.test(text)) {
        const judged = judge(sentence);
        if (judged.ban) ban ??= source;
        else {
          if (judged.noAutonomy) noAutonomy ??= source;
          if (judged.personInLoop) personInLoop ??= source;
          for (const name of judged.reserved ?? []) keep(name, source);
        }
      }
      if (FOR_PEOPLE.test(text)) for (const name of quotedNames(text)) keep(name, source);
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
    reserved: [...reserved.values()],
    aiSentences,
    moreAiSentences,
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
    const kept = excluded.slice(0, MAX_TAGS);
    settings.excludedTags = kept.map((label) => label.name);
    const keptNames = new Set(kept.map((label) => lower(label.name)));
    for (const reason of reading.reserved) {
      if (keptNames.has(lower(reason.name))) sources.push(source('excludedTags', reason.source));
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
