import { httpsUrl } from '@goodfirsttoken/core';
import { bare, linesOf, plain, scan, type PolicyFile, type Sentence, type SourceLine } from '../rules';
import type { Pointer, Statement } from './schemas';
import { MAX_STATEMENT_LINES } from './version';

// The checks on what the model points at. The model points at lines, and
// the Worker decides what they say: a claim is kept only when its file is
// one the Worker sent, its lines exist and span at most
// MAX_STATEMENT_LINES, and its quote is one or more whole sentences of
// those lines, as the rules' scan splits them, with both reduced the way
// the rules reduce text. These checks prove a line is in the file. They
// don't prove what it means: the admin's read, the eval, and for a pause a
// second reading cover that.

/** Why a claim was dropped. */
export type PointerFailure = 'path' | 'lines' | 'span' | 'quote' | 'sentences';
export type StatementFailure = PointerFailure | 'label' | 'value' | 'file kind';

/** A claim that checks out: its file, its lines, and the whole sentences its quote matched. */
export interface CheckedPointer {
  file: PolicyFile;
  startLine: number;
  endLine: number;
  /** The lines, as the file has them. */
  lines: string;
  /** The sentences the quote matched, in order. */
  sentences: Sentence[];
  /** The line the first sentence starts on, trimmed and cut, as the rules keep a source line. */
  source: SourceLine;
}

export type PointerCheck = { ok: true; pointer: CheckedPointer } | { ok: false; failure: PointerFailure };

/** A file's line starts and sentences, worked out once for every claim on it. */
interface Scanned {
  starts: number[];
  sentences: Sentence[];
  sourceAt: (index: number) => SourceLine;
}

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
      scanned = { starts, sentences: scan(file.text).sentences, sourceAt: linesOf(file) };
      this.#scanned.set(file.path, scanned);
    }
    return scanned;
  }

  /** Whether a claim's lines exist and hold its quote as whole sentences. */
  check(pointer: Pointer): PointerCheck {
    const file = this.#byPath.get(pointer.path);
    if (file === undefined) return { ok: false, failure: 'path' };
    const { starts, sentences, sourceAt } = this.#scan(file);
    const { startLine, endLine } = pointer;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > starts.length) {
      return { ok: false, failure: 'lines' };
    }
    if (endLine - startLine + 1 > MAX_STATEMENT_LINES) return { ok: false, failure: 'span' };
    const from = starts[startLine - 1] ?? 0;
    const to = endLine < starts.length ? (starts[endLine] ?? file.text.length) - 1 : file.text.length;
    const lines = file.text.slice(from, to);

    const quote = canonical(scan(pointer.quote).sentences);
    if (quote === '') return { ok: false, failure: 'quote' };
    const within = sentences.filter((s) => s.start >= from && s.end <= to);
    for (let first = 0; first < within.length; first++) {
      for (let last = first; last < within.length; last++) {
        const run = within.slice(first, last + 1);
        const text = canonical(run);
        if (text === quote) {
          return { ok: true, pointer: { file, startLine, endLine, lines, sentences: run, source: sourceAt(run[0]?.start ?? from) } };
        }
        if (text.length > quote.length) break;
      }
    }
    // Found, but not as whole sentences: cut from one, like "AI help is
    // fine" from "We don't think AI help is fine."
    return { ok: false, failure: plain(lines).includes(plain(pointer.quote)) ? 'sentences' : 'quote' };
  }
}

/** Sentences as one text, each without the marks around it, so a quote with or without list and heading marks matches. */
function canonical(sentences: readonly { text: string }[]): string {
  return sentences
    .map((s) => bare(s.text).trim())
    .filter((text) => text !== '')
    .join(' ');
}

/** A trailer's name, like `Assisted-by`. */
const TRAILER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,49}$/;
/** An https link, without the punctuation that closes the sentence around it. */
const LINKS = /https:\/\/[^\s<>()[\]"'`]+/g;
/** A character that would make a label part of a longer name. */
const NAME_CHARACTER = /[\p{L}\p{N}_\-/]/u;

/** The links in a text, each without the punctuation, or the emphasis marks, that close the sentence around it. */
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
  /** The trailer's name as the docs spell it, or the CLA link. */
  value: string | null;
  why: string;
}

export type StatementCheck = { ok: true; statement: CheckedStatement } | { ok: false; failure: StatementFailure };

/**
 * Whether a statement checks out: its lines, then what it names. A label
 * appears whole in the quote. A trailer's name appears in the quote
 * followed by a colon, and is kept as the quote spells it. A CLA link is an
 * https link the quoted sentences hold, as the file has them. A canary is
 * in AGENTS.md or CLAUDE.md.
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
    case 'disclosureTrailer': {
      const name = statement.value?.trim() ?? '';
      if (!TRAILER_NAME.test(name)) return { ok: false, failure: 'value' };
      const at = quote.toLowerCase().indexOf(`${name.toLowerCase()}:`);
      if (at === -1 || (at > 0 && /[A-Za-z0-9-]/.test(quote.charAt(at - 1)))) return { ok: false, failure: 'value' };
      value = quote.slice(at, at + name.length);
      break;
    }
    case 'cla': {
      const link = statement.value?.trim() ?? '';
      const raw = pointer.sentences.map((s) => pointer.file.text.slice(s.start, s.end)).join(' ');
      if (!httpsUrl.safeParse(link).success || !linksIn(raw).includes(link)) return { ok: false, failure: 'value' };
      value = link;
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
