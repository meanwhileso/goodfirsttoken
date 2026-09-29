import { z } from 'zod';
import { cutGraphemes } from './primitives';

// Characters that don't belong in text shown as one line, like a line of a
// text stream or a maintainer's words quoted in a tool's answer, and the one
// fold for text from someone else, which drops them.

/**
 * A character that could break a line or a column, or change what a
 * terminal shows: a control character, tabs and line breaks among them, a
 * Unicode line or paragraph separator, or a mark that reorders text.
 */
export const UNSAFE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/**
 * A character a person reading the text doesn't see, which an agent reading
 * it could: a format character, like a zero-width space, a word joiner, or a
 * Unicode tag character, a private-use character, an unassigned one, or one
 * Unicode says to ignore when it can't be shown, like a variation selector,
 * a combining grapheme joiner, or a Hangul filler. The marks that reorder
 * text are format characters too, and are unsafe above.
 *
 * A lone surrogate, half of a character with no other half next to it, is
 * one too. Text in JSON can hold one, and two halves with a hidden character
 * between them would join into one character, like a tag, once the fold drops
 * what is between them. A pair of halves next to each other is one
 * character, and never matches.
 */
export const HIDDEN_CHARACTER = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** A space between words, of any width. */
const SPACE = /\p{Zs}/u;

/**
 * A run of the characters above, unsafe and hidden, and of spaces. Each
 * choice is one character, so a match never goes back over what it read,
 * and the fold takes time in proportion to the text's length. A run of
 * millions of characters can still overflow the pattern engine's stack, so
 * every caller caps the text first.
 */
const RUN = new RegExp(`(?:${UNSAFE_CHARACTER.source}|${HIDDEN_CHARACTER.source}|${SPACE.source})+`, 'gu');

/**
 * A run with an unsafe character or a space in it becomes one space, and a
 * run of hidden characters alone goes. A mark that reorders text is both
 * unsafe and hidden, so it becomes a space.
 */
function foldRun(run: string): string {
  return UNSAFE_CHARACTER.test(run) || SPACE.test(run) ? ' ' : '';
}

/**
 * Text from someone else as one line, with only what a person can see:
 * every hidden character goes, each run of unsafe characters and spaces
 * becomes one space, and the ends are trimmed. It takes time in proportion
 * to the text's length. Its callers cap the text before it runs.
 */
export function foldLine(text: string): string {
  return text.replace(RUN, foldRun).trim();
}

/**
 * Text from someone else, folded by foldLine, as at most `max` graphemes.
 * Longer text is cut, whole graphemes only, and ends in `...`, so a hidden
 * character counts for nothing. So a reviewer's comment or an issue's title
 * can't add a line that reads as the server's own, or words only an agent
 * reads.
 */
export function foldUntrusted(text: string, max: number): string {
  return cutGraphemes(foldLine(text), max);
}

/**
 * Text someone gives a tool, as one line under foldLine, of at most `max`
 * characters once folded. Longer text than four times that is refused
 * before it folds, so checking it takes a short time whatever a request
 * carries, and text of nothing a person sees is refused as empty.
 */
export function untrustedLine(max: number, typeError = 'must be text') {
  const raw = 4 * max;
  return z
    .string({ error: typeError })
    .max(raw, {
      error: `must be at most ${raw.toLocaleString('en-US')} characters before its spaces and line breaks fold`,
      abort: true,
    })
    .overwrite(foldLine)
    .min(1, 'must not be empty')
    .max(max, `must be at most ${max.toLocaleString('en-US')} characters`);
}
