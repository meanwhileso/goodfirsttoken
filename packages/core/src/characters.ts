// Characters that don't belong in text shown as one line, like a line of a
// text stream or a maintainer's words quoted in a tool's answer.

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
 */
export const HIDDEN_CHARACTER = /[\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/u;
