import type { FeedEvent } from '@goodfirsttoken/core';

// The two line formats of the text streams (spec section 9, "Readable by
// agents"). Each event is one line, whatever its text holds.

/**
 * A character that could break a line or a column, or change what a
 * terminal shows: a control character, tabs and line breaks among them, a
 * Unicode line or paragraph separator, or a mark that reorders text.
 */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/** `text` without the plain spaces at its end. */
function trimSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ' ') end -= 1;
  return text.slice(0, end);
}

/**
 * The text with each run of unsafe characters, and the plain spaces around
 * it, made one space. A run at either end of the text is dropped, so a text
 * of nothing but unsafe characters becomes empty.
 */
function oneLine(text: string): string {
  let out = '';
  let gap = false;
  for (const char of text) {
    if (UNSAFE.test(char)) {
      gap = true;
    } else if (!gap) {
      out += char;
    } else if (char !== ' ') {
      const before = trimSpaces(out);
      out = before === '' ? char : `${before} ${char}`;
      gap = false;
    }
  }
  return gap ? trimSpaces(out) : out;
}

/**
 * One tab-separated line: time, event ID, kind, user, agent, job, issue, and
 * text. The job is empty for the main agent's lines and for changes of state.
 * The time, ID, kind, user, agent, and issue are checked by the feed event
 * schema, which allows no tab, line break, or control character in them. The
 * job and the text have each of those made a space.
 */
export function textLine(event: FeedEvent): string {
  const columns = [
    event.time,
    event.id,
    event.kind,
    event.user,
    event.agent,
    event.job === null ? '' : oneLine(event.job),
    event.issue,
    oneLine(event.text),
  ];
  return `${columns.join('\t')}\n`;
}

/**
 * The event as one line of JSON. JSON.stringify escapes the control
 * characters below 0x20. The other unsafe characters are escaped here too,
 * so the line reads the same in a terminal, and parses to the same event.
 */
export function ndjsonLine(event: FeedEvent): string {
  let out = '';
  for (const char of JSON.stringify(event)) {
    out += UNSAFE.test(char) ? `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}` : char;
  }
  return `${out}\n`;
}
