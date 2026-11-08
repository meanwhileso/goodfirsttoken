import type { PolicyFingerprint } from '@goodfirsttoken/core';
import { FINGERPRINT_VERSION, wordsOf } from '../fingerprint';
import { forAgents, namesAiByWordList, type PolicyFile } from '../rules';
import { toPolicyReading, type ModelReading, type PolicyReading } from './reading';

// The fingerprint of what a model reading decided, so a later read can tell
// whether the policy changed. The docs hash decides whether the model
// reads. This decides whether the policy changed. It covers outcomes: the
// tier, which conditions hold, the reserved and only label names, the
// trailer, the CLA link, whether there is a vouch file or a canary, and the
// passages with a sentence that names AI by the word list. In a file
// written for agents, that is as the word list reads it there, plus each
// passage that holds a kept statement, like the welcome. It leaves
// out which lines the model cited and the welcome's quote, since a new
// reading can cite other lines for the same policy. An edit to the welcome
// still shows, since the welcome names AI and its paragraph is one of those
// passages. It also leaves out the passages the admin's net keeps only because
// they talk about contributing in a file for agents, like Omarchy's
// "does not run graphical acceptance tests", which the admin still sees. So
// a build step added to AGENTS.md costs one model call and sends nothing to
// the admin queue. The design is in docs/specs/model-policy-reader.md,
// under What the Worker does with it.

/**
 * One more than the rules' FINGERPRINT_VERSION, and one more with every
 * reader version after it, so no listing's fingerprint reads as changed for
 * a new reader, and a listing whose policy now reads as a ban is a move into one.
 * Reader p1 was one past the rules, and each prompt version after it one more, up to p7.
 */
export const READER_FINGERPRINT_VERSION = FINGERPRINT_VERSION + 7;

/** Label names, each once, in lower case and in order, as GitHub compares them. */
function names(labels: readonly { name: string }[]): string[] {
  return [...new Set(labels.map((label) => label.name.toLowerCase()))].sort();
}

/** Whether a passage the admin's net kept goes in the fingerprint. */
function counts(passage: PolicyReading['aiSentences'][number], reading: ModelReading): boolean {
  if (!forAgents(passage.file.kind)) return namesAiByWordList(passage.text);
  if (namesAiByWordList(passage.text, true)) return true;
  return reading.statements.some(
    (s) => s.file.path === passage.file.path && s.sentences.some((sentence) => passage.text.includes(s.file.text.slice(sentence.start, sentence.end))),
  );
}

/** What the fingerprint covers, before it is hashed. Exported for the tests. */
export function fingerprintContent(files: readonly PolicyFile[], reading: ModelReading, vouch: string | null) {
  const policy: PolicyReading = toPolicyReading(files, reading);
  const value = (about: 'disclosureTrailer' | 'cla') => reading.statements.find((s) => s.about === about)?.value ?? null;
  return {
    tier: policy.tier,
    noAutonomy: policy.noAutonomy !== null,
    personInLoop: policy.personInLoop !== null,
    personWritten: policy.personWritten !== null,
    reserved: names(policy.reserved),
    only: names(policy.onlyLabels),
    trailer: value('disclosureTrailer'),
    cla: value('cla'),
    vouched: vouch !== null,
    canary: policy.canary !== null,
    // Sorted, so moving a section reads the same.
    passages: [...new Set(policy.aiSentences.filter((passage) => counts(passage, reading)).map((passage) => wordsOf(passage.text)))].sort(),
  };
}

/** The fingerprint of what a model reading decided for the files, with the path of the repo's vouch file, or null. */
export async function readerFingerprint(files: readonly PolicyFile[], reading: ModelReading, vouch: string | null): Promise<PolicyFingerprint> {
  const content = JSON.stringify(fingerprintContent(files, reading, vouch));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v${String(READER_FINGERPRINT_VERSION)}:${hex}`;
}
