import type { PolicyFingerprint } from '@goodfirsttoken/core';
import { suggestSettings, type PolicyFile, type PolicyReading } from './rules';

// What the policy crawler's rules read in a repo's docs, as a hash, so a
// later read can tell whether they read the same. The weekly read of a
// listed project compares it with the last one (src/crawl/reread.ts), and a
// crawler find keeps it, so a rejected find comes back only once its docs
// read differently (src/crawl/queue.ts). The rules are in
// docs/how-it-works.md, under Keeping listings current.
//
// It covers what the rules take from the docs: the tier, the quote and the
// file it is in, the first MAX_AI_SENTENCES sentences that name AI, each
// with the rest of its paragraph, how many more there are, and the
// conditions the settings follow. Each text is reduced to its words, so a
// reformat, like wrapping a line, bold text, a list mark, or a heading's
// level, reads the same. A file the rules take nothing from, and a
// paragraph in one where no sentence names AI or sets anything, like a
// build step of its own in CONTRIBUTING, aren't in it. The hash is all
// that is kept of the repo's text.

/**
 * Raised when what the fingerprint covers changes, like a change to the
 * rules that changes what they read in most repos. A fingerprint of another
 * version compares with nothing, so the next read takes a new one, and no
 * listed project reads as changed for it. Whether the last read was a ban
 * is kept apart from the hash, so a move into a ban still pauses.
 */
export const FINGERPRINT_VERSION = 1;

/** The words of a text in lower case, one space between them, with every mark and break between them left out. */
export function wordsOf(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

/** Label names, each once, in lower case and in order, as GitHub compares them. */
function names(labels: readonly { name: string }[]): string[] {
  return [...new Set(labels.map((label) => label.name.toLowerCase()))].sort();
}

/** The fingerprint of what the rules read in the files, with the path of the repo's vouch file, or null. */
export async function policyFingerprint(
  reading: PolicyReading,
  files: readonly PolicyFile[],
  vouch: string | null,
): Promise<PolicyFingerprint> {
  // The conditions that don't depend on the repo's labels.
  const { settings } = suggestSettings(reading, files, [], vouch);
  const read = {
    tier: reading.tier,
    quote: reading.welcome === null ? null : wordsOf(reading.welcome.quote),
    // The file the quote is in, which a listing links to.
    quoteFile: reading.welcome?.file.path ?? null,
    // Sorted, so moving a section reads the same.
    passages: [...new Set(reading.aiSentences.map((passage) => wordsOf(passage.text)))].sort(),
    more: reading.moreAiSentences,
    trailer: settings.disclosure?.trailer ?? null,
    personWritten: settings.personWrittenDescription === true,
    cla: settings.claUrl ?? null,
    vouched: settings.whoCanClaim === 'vouched',
    reserved: names(reading.reserved),
    only: names(reading.onlyLabels),
    noAutonomy: reading.noAutonomy !== null,
    personInLoop: reading.personInLoop !== null,
    canary: reading.canary === null ? null : wordsOf(reading.canary.line),
  };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(read))));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v${String(FINGERPRINT_VERSION)}:${hex}`;
}

/** Whether a stored fingerprint was made the way this version makes them, so it can be compared with a new one. */
export function comparable(fingerprint: string | null): fingerprint is string {
  return fingerprint?.startsWith(`v${String(FINGERPRINT_VERSION)}:`) === true;
}
