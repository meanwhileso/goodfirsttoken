import { httpsUrl } from '@goodfirsttoken/core';
import { bare, linesOf, plain, scan, type PolicyFile, type Sentence, type SourceLine } from '../rules';
import type { Pointer, Statement } from './schemas';
import { MAX_STATEMENT_LINES } from './version';

// The checks on what the model points at. The model points at lines, and
// the Worker decides what they say: a claim is kept only when its file is
// one the Worker sent, its lines exist and span at most
// MAX_STATEMENT_LINES, and its quote is one or more whole sentences of
// those lines, as the word list's scan splits them for the checks, with
// both reduced the way it reduces text. A quote may also give a link's text
// without its target, leave out code marks, a checkbox, or a check mark or
// warning sign before a sentence, and the space beside a Chinese or
// Japanese character. These checks prove a line is in the file. They
// don't prove what it means: the admin's read, the eval, and for a pause a
// second reading cover that.

/** Why a claim was dropped. */
export type PointerFailure = 'path' | 'lines' | 'span' | 'quote' | 'sentences';
export type StatementFailure = PointerFailure | 'label' | 'file kind';

/** A claim that checks out: its file, its lines, and the whole sentences its quote matched. */
export interface CheckedPointer {
  file: PolicyFile;
  startLine: number;
  endLine: number;
  /** The lines, as the file has them. */
  lines: string;
  /** The sentences the quote matched, in order. */
  sentences: Sentence[];
  /** The line the first sentence starts on, trimmed and cut, as a source line is kept. */
  source: SourceLine;
}

export type PointerCheck = { ok: true; pointer: CheckedPointer } | { ok: false; failure: PointerFailure };

/** A file's line starts and sentences, worked out once for every claim on it. */
interface Scanned {
  starts: number[];
  paragraphs: { start: number; end: number }[];
  /** The file's text with each HTML comment blanked, line breaks kept, so offsets stay. */
  visible: string;
  sentences: Sentence[];
  /** Each sentence without its marks, as canonical reduces it. */
  bare: string[];
  /** Each sentence as loose reduces it. */
  loose: string[];
  sourceAt: (index: number) => SourceLine;
}

/** The most sentences one claim's check adds to its runs. Exported for the tests. */
export const MAX_CHECK_STEPS = 20_000;

/** Checks claims against the files the Worker sent. */
export class Files {
  readonly #byPath = new Map<string, PolicyFile>();
  readonly #scanned = new Map<string, Scanned>();

  readonly files: readonly PolicyFile[];

  constructor(files: readonly PolicyFile[]) {
    this.files = files;
    // The first file with a path wins, as the crawler sends each path once.
    for (const file of files) if (!this.#byPath.has(file.path)) this.#byPath.set(file.path, file);
  }

  #scan(file: PolicyFile): Scanned {
    let scanned = this.#scanned.get(file.path);
    if (scanned === undefined) {
      const starts = [0];
      for (let i = file.text.indexOf('\n'); i !== -1; i = file.text.indexOf('\n', i + 1)) starts.push(i + 1);
      const { paragraphs, sentences } = scan(file.text, { checks: true });
      const bared = sentences.map((s) => bare(s.text).trim());
      const visible = file.text.replace(COMMENTS, (comment) => comment.replace(/[^\n]/g, ' '));
      scanned = { starts, paragraphs, visible, sentences, bare: bared, loose: bared.map(loosePiece), sourceAt: linesOf(file) };
      this.#scanned.set(file.path, scanned);
    }
    return scanned;
  }

  /**
   * The https links the paragraphs a claim's lines are in hold, outside
   * HTML comments, as the file has them: each link, and each reference
   * link's target, as the file defines it. When the last of the paragraphs
   * ends with a colon, the paragraph after it counts too, as a lead-in
   * points at it.
   */
  linksNear(pointer: Pick<CheckedPointer, 'file' | 'startLine' | 'endLine'>): string[] {
    const { file } = pointer;
    const { starts, paragraphs, visible } = this.#scan(file);
    const from = starts[pointer.startLine - 1] ?? 0;
    const to = (starts[pointer.endLine] ?? file.text.length + 1) - 1;
    const near = paragraphs.filter((p) => p.end >= from && p.start <= to);
    const last = near.at(-1);
    const next = last === undefined ? undefined : paragraphs[paragraphs.indexOf(last) + 1];
    if (last !== undefined && next !== undefined && file.text.slice(last.start, last.end).trimEnd().endsWith(':')) near.push(next);
    const text = near.map((p) => visible.slice(p.start, p.end)).join('\n\n');
    const targets = referenceTargets(visible);
    const named = [...text.matchAll(REFERENCES)].flatMap((match) => targets.get(label(match[2] || match[1] || '')) ?? []);
    return [...linksIn(text), ...named];
  }

  /** Whether a claim's lines exist and hold its quote as whole sentences. */
  check(pointer: Pointer): PointerCheck {
    const file = this.#byPath.get(pointer.path);
    if (file === undefined) return { ok: false, failure: 'path' };
    const scanned = this.#scan(file);
    const { starts, sentences, sourceAt } = scanned;
    const { startLine, endLine } = pointer;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > starts.length) {
      return { ok: false, failure: 'lines' };
    }
    if (endLine - startLine + 1 > MAX_STATEMENT_LINES) return { ok: false, failure: 'span' };
    const from = starts[startLine - 1] ?? 0;
    const to = endLine < starts.length ? (starts[endLine] ?? file.text.length) - 1 : file.text.length;
    const lines = file.text.slice(from, to);

    // The quote matches with each sentence's marks off, or with each
    // sentence's marks kept or left out, one sentence at a time, and line
    // breaks folded, or loosely, as `loose` reduces both. The second is for
    // a numbered list folded onto one line, as "lead-in: 1. First 2.
    // Second", where the quote's own scan can't tell the numbers from
    // sentence ends.
    const quoteSentences = scan(pointer.quote, { checks: true }).sentences;
    const quote = canonical(quoteSentences);
    if (quote === '') return { ok: false, failure: 'quote' };
    const loosely = loose(quoteSentences);
    const asWritten = plain(pointer.quote);
    const within: number[] = [];
    sentences.forEach((s, index) => {
      if (s.start >= from && s.end <= to) within.push(index);
    });
    // Each run grows a sentence at a time, and each way of matching keeps
    // only how much of the quote it has matched so far, so a run stops
    // growing once no way can still match. A run can't start on a sentence
    // of no words, like a comment's mark, since the run after it reads the
    // same. A claim takes at most MAX_CHECK_STEPS sentences added, across
    // its runs, so a file of one long line can't make a check slow: a
    // claim on at most MAX_STATEMENT_LINES lines of real docs takes a few
    // thousand.
    let steps = 0;
    for (let first = 0; first < within.length && steps < MAX_CHECK_STEPS; first++) {
      if (scanned.bare[within[first] ?? 0] === '') continue;
      const exact = new Prefix(quote, () => ' ');
      const looseMatch = new Prefix(loosely, looseSeparator);
      const spelling = new Spelling(asWritten);
      for (let last = first; last < within.length; last++) {
        if (++steps > MAX_CHECK_STEPS) break;
        const at = within[last] ?? 0;
        exact.add(scanned.bare[at] ?? '');
        looseMatch.add(scanned.loose[at] ?? '');
        spelling.add(sentences[at]?.text ?? '', scanned.bare[at] ?? '');
        if (exact.whole() || looseMatch.whole() || spelling.whole()) {
          // A comment's mark at the end, matched as a sentence of no words, is left off.
          const kept = trimMarks(within.slice(first, last + 1).map((index) => sentences[index] as Sentence));
          return { ok: true, pointer: { file, startLine, endLine, lines, sentences: kept, source: sourceAt(kept[0]?.start ?? from) } };
        }
        if (!exact.alive && !looseMatch.alive && !spelling.alive) break;
      }
    }
    // Found, but not as whole sentences: cut from one, like "AI help is
    // fine" from "We don't think AI help is fine."
    return { ok: false, failure: plain(lines).includes(plain(pointer.quote)) ? 'sentences' : 'quote' };
  }
}

/**
 * A text matched against sentences joined one at a time, each one's
 * reduced form after a separator, as long as what is joined so far starts
 * the text. A sentence that reduces to nothing adds nothing.
 */
class Prefix {
  #at = 0;
  #last = '';
  alive = true;

  constructor(
    readonly text: string,
    readonly separator: (before: string, after: string) => string,
  ) {}

  add(piece: string): void {
    if (!this.alive || piece === '') return;
    const next = this.#last === '' ? piece : this.separator(this.#last, piece) + piece;
    if (this.text.startsWith(next, this.#at)) {
      this.#at += next.length;
      this.#last = piece;
    } else this.alive = false;
  }

  /** Whether the sentences joined so far are the whole text. */
  whole(): boolean {
    return this.alive && this.#last !== '' && this.#at === this.text.length;
  }
}

/**
 * Whether a text is the sentences in order, each as the file has it or
 * without its marks, joined by single spaces, as the sentences are added
 * one at a time. Each sentence is whole: the text can't stop partway
 * through one. It keeps every place in the text the sentences so far can
 * reach.
 */
class Spelling {
  /** Where the sentences so far can end in the text, with 0 for none added. */
  #reach = new Set<number>([0]);
  #added = false;

  constructor(readonly text: string) {}

  get alive(): boolean {
    return this.#reach.size > 0;
  }

  /** Adds a sentence, as the file has it and without its marks. */
  add(sentence: string, bared: string): void {
    this.#added = true;
    if (this.#reach.size === 0) return;
    const options = [...new Set([sentence, bared])].filter((form) => form !== '');
    // A sentence that is only marks may be left out whole.
    if (options.length === 0) return;
    const next = new Set<number>();
    for (const at of this.#reach) {
      if (at !== 0 && this.text.charAt(at) !== ' ') continue;
      const start = at === 0 ? 0 : at + 1;
      for (const form of options) if (this.text.startsWith(form, start)) next.add(start + form.length);
    }
    this.#reach = next;
  }

  whole(): boolean {
    return this.#added && this.text.length > 0 && this.#reach.has(this.text.length);
  }
}

/** Sentences as one text, each without the marks around it, so a quote with or without list and heading marks matches. */
function canonical(sentences: readonly { text: string }[]): string {
  return sentences
    .map((s) => bare(s.text).trim())
    .filter((text) => text !== '')
    .join(' ');
}

/** The run without the sentences of no words at its end, like a comment's mark alone. */
function trimMarks<T extends { text: string }>(run: readonly T[]): T[] {
  let end = run.length;
  while (end > 1 && bare((run[end - 1] as T).text).trim() === '') end -= 1;
  return run.slice(0, end);
}

// What a loose match leaves out. A check mark or a warning sign before a
// sentence affirms or flags it, so leaving one out keeps its meaning. A
// cross or a stop sign says no, so it stays.
const LEAD_MARKS = /^(?:\[[ xX]?\]\s*)?(?:[✅✔☑⚠ℹ]\uFE0F?\s*)?/u;
// A Markdown link, `[text](target "title")`, or a reference link,
// `[text][name]`, but not an image, whose text a reader doesn't see. No part can hold the bracket or parenthesis that opens
// one, so a try from each bracket stops at the next.
const LINK = /(?<!!)\[([^[\]\n]*)\]\([^()\s]*(?:\s+"[^"\n]*")?\)/g;
const REFERENCE_LINK = /(?<!!)\[([^[\]\n]+)\]\[[^[\]\n]*\]/g;
// Space beside a Chinese or Japanese character or mark, where a line break
// folds to nothing.
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF`;
const CJK_SPACE = new RegExp(String.raw`\s+(?=[${CJK}])|(?<=[${CJK}])\s+`, 'gu');

const CJK_EDGE_END = new RegExp(String.raw`[${CJK}]$`, 'u');
const CJK_EDGE_START = new RegExp(String.raw`^[${CJK}]`, 'u');

/**
 * A sentence, already without its marks, reduced further than canonical
 * reduces it: without a checkbox or a check mark or warning sign before it,
 * every link as its text alone, no code marks, and no space beside a
 * Chinese or Japanese character, and no backslash that breaks the line
 * after it. The words are the file's, so a quote
 * can't change one.
 */
function loosePiece(bared: string): string {
  if (!LOOSE_CHANGES.test(bared)) return bared;
  return bared
    .replace(LEAD_MARKS, '')
    .replace(LINK, '$1')
    .replace(REFERENCE_LINK, '$1')
    .replace(/`/g, '')
    .replace(CJK_SPACE, '')
    .replace(/\s+/g, ' ')
    .replace(/\\$/, '')
    .trim();
}

/** A character loosePiece changes, or space it takes out, folds, or trims. */
const LOOSE_CHANGES = /[[`✅✔☑⚠ℹ\\\s]/u;

/** What goes between two loose pieces: a space, or none beside a Chinese or Japanese character. */
function looseSeparator(before: string, after: string): string {
  return CJK_EDGE_END.test(before) || CJK_EDGE_START.test(after) ? '' : ' ';
}

/** Sentences as one loose text, as the checks read a quote, joined as Prefix joins them. */
function loose(sentences: readonly { text: string }[]): string {
  const parts: string[] = [];
  let last = '';
  for (const s of sentences) {
    const piece = loosePiece(bare(s.text).trim());
    if (piece === '') continue;
    if (last !== '') parts.push(looseSeparator(last, piece));
    parts.push(piece);
    last = piece;
  }
  return parts.join('');
}

/** A trailer's name, like `Assisted-by`. */
const TRAILER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,49}$/;
/** An https link, without the punctuation that closes the sentence around it. */
const LINKS = /https:\/\/[^\s<>()[\]"'`]+/g;
/** A character that would make a label part of a longer name. */
const NAME_CHARACTER = /[\p{L}\p{N}_\-/]/u;

/** The https links in a text, each without the punctuation, or the emphasis marks, that close the sentence around it. */
function linksIn(text: string): string[] {
  return [...text.matchAll(LINKS)].map((match) => match[0].replace(/[.,;:!?*]+$/, ''));
}

/** Whether a text holds a name whole, without case, and not inside a longer name, as `bug` is inside `debugging`. */
function holdsName(text: string, name: string): boolean {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack.charAt(at - 1);
    const after = haystack.charAt(at + needle.length);
    if ((at === 0 || !NAME_CHARACTER.test(before)) && (after === '' || !NAME_CHARACTER.test(after))) return true;
  }
  return false;
}

/** A statement that checks out, with what it names as the files spell it. */
export interface CheckedStatement extends CheckedPointer {
  /** Its place in the model's list. */
  index: number;
  about: Statement['about'];
  /** The label, for reservedLabel and onlyLabel, as the docs spell it. */
  label: string | null;
  /** The trailer's name as the docs spell it, or the CLA link, or null when the model's didn't check out. */
  value: string | null;
  why: string;
}

export type StatementCheck = { ok: true; statement: CheckedStatement } | { ok: false; failure: StatementFailure };

/**
 * A trailer's name as the quote spells it, when the quote gives it as a
 * trailer: followed by a colon, or, for a name with a hyphen, like
 * `Co-authored-by`, followed by the word trailer, tag, or footer, in code
 * marks or not. Not inside a longer name, as `by` is in `Assisted-by`.
 */
function trailerIn(quote: string, name: string): string | null {
  if (!TRAILER_NAME.test(name)) return null;
  const haystack = quote.toLowerCase();
  const needle = name.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (at > 0 && /[A-Za-z0-9-]/.test(quote.charAt(at - 1))) continue;
    const after = quote.slice(at + name.length, at + name.length + 20);
    const coded = quote.charAt(at - 1) === '`' && after.startsWith('`');
    const named = name.includes('-') && /^\s+(?:trailers?|tags?|footers?)\b/i.test(coded ? after.slice(1) : after);
    if (after.startsWith(':') || named) return quote.slice(at, at + name.length);
  }
  return null;
}

/** HTML comments, which a reader of the rendered docs doesn't see. */
const COMMENTS = /<!--[\s\S]*?(?:-->|--!>|$)/g;
/** A reference link, `[text][name]`, `[text][]`, or `[name]`, which may wrap over a line. */
const REFERENCES = /\[([^[\]]+)\](?:\[([^[\]]*)\]|(?![(:]))/g;
/** A reference link's definition, `[name]: https://...`, on a line of its own. */
const DEFINITIONS = /^ {0,3}\[([^[\]\n]+)\]:[ \t]*<?(https:\/\/[^\s>]+)>?/gm;

/** A reference link's name, as Markdown compares them: without case, with space folded. */
function label(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Each reference link name a text defines with an https link, and its target, the first definition winning. */
function referenceTargets(text: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const match of text.matchAll(DEFINITIONS)) {
    const name = label(match[1] ?? '');
    const target = (match[2] ?? '').replace(/[.,;:!?*]+$/, '');
    if (!targets.has(name)) targets.set(name, target);
  }
  return targets;
}

/**
 * Whether a statement checks out: its lines, then what it names. A label
 * appears whole in the quote. A trailer's name is kept, as the quote spells
 * it, when the quote gives it as a trailer, as trailerIn reads it. A CLA
 * link is kept when it is an https link near the statement's lines, as
 * Files.linksNear finds them. A trailer or CLA statement whose name or link doesn't check
 * out is kept without one, since its lines still say a trailer or a CLA is
 * asked for: the settings take nothing from it. A canary is in AGENTS.md or
 * CLAUDE.md.
 */
export function checkStatement(files: Files, statement: Statement, index: number): StatementCheck {
  const checked = files.check(statement);
  if (!checked.ok) return checked;
  const { pointer } = checked;
  const quote = plain(pointer.sentences.map((s) => s.text).join(' '));
  let label: string | null = null;
  let value: string | null = null;
  switch (statement.about) {
    case 'reservedLabel':
    case 'onlyLabel': {
      const name = plain(statement.label ?? '');
      if (name === '' || !holdsName(quote, name)) return { ok: false, failure: 'label' };
      label = statement.label?.trim() ?? null;
      break;
    }
    case 'disclosureTrailer':
      value = trailerIn(quote, statement.value?.trim() ?? '');
      break;
    case 'cla': {
      const link = statement.value?.trim() ?? '';
      value = httpsUrl.safeParse(link).success && files.linksNear(pointer).includes(link) ? link : null;
      break;
    }
    case 'canary':
      if (pointer.file.kind !== 'agents' && pointer.file.kind !== 'claude') return { ok: false, failure: 'file kind' };
      break;
    default:
      break;
  }
  return { ok: true, statement: { ...pointer, index, about: statement.about, label, value, why: statement.why } };
}
