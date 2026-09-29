// Characters that don't belong in text shown as one line, like a line of a
// text stream or a maintainer's words quoted in a tool's answer.

/**
 * A character that could break a line or a column, or change what a
 * terminal shows: a control character, tabs and line breaks among them, a
 * Unicode line or paragraph separator, or a mark that reorders text.
 */
export const UNSAFE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
