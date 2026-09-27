import type { FeedEvent } from '@goodfirsttoken/core';

// The two line formats of the text streams (spec section 9, "Readable by
// agents"). Each event is one line, whatever its text holds.

/**
 * A character that could break a line or a column, or change what a
 * terminal shows: a control character, tabs and line breaks among them, the
 * Unicode line and paragraph separators, and the marks that reorder text.
 */
function unsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** The text with each run of unsafe characters, and the spaces around it, made one space. */
function oneLine(text: string): string {
  let out = '';
  let gap = false;
  for (const char of text) {
    if (unsafe(char.codePointAt(0) ?? 0)) {
      gap = true;
      continue;
    }
    if (gap) {
      out = `${out.trimEnd()} `;
      gap = false;
      if (char === ' ') continue;
    }
    out += char;
  }
  return out.trim();
}

/**
 * One tab-separated line: time, user, agent, issue, and text. The first four
 * are checked by the feed event schema, which allows no tab, line break, or
 * control character in them. The text has each of those made a space.
 */
export function textLine(event: FeedEvent): string {
  return `${[event.time, event.user, event.agent, event.issue, oneLine(event.text)].join('\t')}\n`;
}

/**
 * The event as one line of JSON. JSON.stringify escapes the control
 * characters below 0x20. The other unsafe characters are escaped here too,
 * so the line reads the same in a terminal, and parses to the same event.
 */
export function ndjsonLine(event: FeedEvent): string {
  let out = '';
  for (const char of JSON.stringify(event)) {
    const code = char.codePointAt(0) ?? 0;
    out += unsafe(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return `${out}\n`;
}
