// What the fingerprints of a repo's docs share. A fingerprint is a hash of
// what a reading took from the docs, so a later read can tell whether they
// read the same: the weekly read of a listed project compares it with the
// last one, and a find keeps it, so a rejected find comes back only once its
// docs read differently. The model reader's fingerprint is in
// src/crawl/reader/fingerprint.ts. The rules are in docs/how-it-works.md,
// under Keeping listings current.

/**
 * The version of the last fingerprint the crawler's rules made, before the
 * model read policies. The reader's versions count up from it, so a
 * fingerprint the rules made, still kept for a listing or a rejected find,
 * compares with no reader's.
 */
export const FINGERPRINT_VERSION = 1;

/** The words of a text in lower case, one space between them, with every mark and break between them left out. */
export function wordsOf(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}
