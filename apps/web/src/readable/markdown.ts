import { foldLine } from '@goodfirsttoken/core';

// How the markdown versions of the pages write text. Every string that came
// from GitHub or an agent, like an issue's title, a label, a line an agent
// posted, or a maintainer's notes, goes through `text`, so it reads as the
// words it holds and adds nothing to the page: no heading, list, quote,
// link, image, HTML, or table cell. Links and code spans are built only
// from values the site checked, with `link` and `code`.

/** The longest text `text` takes before folding, so the fold's time stays short. */
const MAX_TEXT = 20_000;

// Characters that start or end an inline construct anywhere in a line:
// escapes, code spans, emphasis, strikethrough, links, images, HTML and
// autolinks, entities, table cells, and math and footnotes in the renderers
// that have them.
const INLINE = /[\\`*_~[\]!<>&|$^{}()]/g;

// Characters that start a block when they open a line, or a list item's
// content: headings, quotes, list markers, setext underlines, and ordered
// list numbers like `1.` or `2)`.
const BLOCK_MARK = /^[#+=-]/;
const LIST_NUMBER = /^(\d{1,9})([.)])/;

// The pieces of GFM's autolink literals: `www.`, a scheme's `://`, and an
// email's `@` after a character that could end its local part.
const WWW_DOT = /(^|[^A-Za-z0-9])(www)\./gi;
const SCHEME = /:(?=\/\/)/g;
const EMAIL_AT = /(?<=[A-Za-z0-9._+-])@/g;

/**
 * Untrusted text as one line of markdown that shows exactly its words:
 * folded to one line with only what a person can see, as the text streams
 * and tool answers fold it, then with every character that could start a
 * construct escaped with a backslash.
 */
export function text(value: string): string {
  const line = foldLine(value.slice(0, MAX_TEXT));
  const inline = line
    .replace(INLINE, '\\$&')
    .replace(WWW_DOT, '$1$2\\.')
    .replace(SCHEME, '\\:')
    .replace(EMAIL_AT, '\\@');
  // A block marker only counts at the start. Escaping it there is enough,
  // as in `\#` or `1\.`. The quote's `>` is escaped above.
  if (BLOCK_MARK.test(inline)) return `\\${inline}`;
  return inline.replace(LIST_NUMBER, '$1\\$2');
}

/**
 * A code span holding `value`, which the caller checked holds no backtick
 * or line break, like a command built from a repo name.
 */
export function code(value: string): string {
  if (/[`\r\n]/.test(value)) throw new Error('A code span was given a backtick or a line break.');
  return `\`${value}\``;
}

/**
 * A link destination the site can give out: an http or https URL, as the
 * URL parser writes it, with the characters that could end a destination
 * or a link percent-encoded. Null for anything else, so the caller shows
 * text.
 */
function destination(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.includes('[')) return null;
  return url.href.replace(/[()[\]<> \\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** A link with untrusted words, or the words alone when the URL isn't one a page may link to. */
export function link(words: string, href: string): string {
  const to = destination(href);
  const shown = text(words);
  return to === null ? shown : `[${shown}](${to})`;
}

/** A markdown document from its blocks, each separated by a blank line, ending in one line break. */
export function doc(blocks: readonly (string | null | false)[]): string {
  return `${blocks.filter((block): block is string => typeof block === 'string' && block !== '').join('\n\n')}\n`;
}

/** A bulleted list, one item a line, or null with no items. */
export function list(items: readonly string[]): string | null {
  return items.length === 0 ? null : items.map((item) => `- ${item}`).join('\n');
}

/** A numbered list, one item a line, or null with no items. */
export function numbered(items: readonly string[]): string | null {
  return items.length === 0 ? null : items.map((item, i) => `${String(i + 1)}. ${item}`).join('\n');
}
