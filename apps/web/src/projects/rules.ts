import { httpsUrl } from '@goodfirsttoken/core';
import type { RepoFile } from './docs';

// The rules a maintainer's proposal (src/projects/proposal.ts) and the
// policy crawler (src/crawl/) share for what a repo's docs and labels say.
// Plain rules over the text, each one written in docs/how-it-works.md, under
// Registering a project.

/** The label Good First Token creates when a maintainer picks the tag. */
export const OUR_LABEL = {
  name: 'goodfirsttoken',
  color: '7057ff',
  description: 'Tagged for outside help through Good First Token',
};

/** Labels that mean ready for outside help, compared without case. */
const READY_LABELS = ['help wanted', 'contributor friendly', 'contribution welcome', OUR_LABEL.name];

/**
 * Labels that can mean ready for outside help, but that the plan names as
 * labels projects keep for people. A proposal leaves them out. The crawler
 * shows them to the admin.
 */
const KEPT_FOR_PEOPLE = ['good first issue'];

/** Whether a label means ready for outside help, compared without case. */
export function meansReady(label: string): boolean {
  const name = label.toLowerCase();
  return READY_LABELS.includes(name) || name.startsWith('.contrib/');
}

/** Whether a label is one the plan names as kept for people, compared without case. */
export function keptForPeople(label: string): boolean {
  return KEPT_FOR_PEOPLE.includes(label.toLowerCase());
}

// A trailer the files name for AI help, followed by a colon, as in
// "Disclose it with an Assisted-by: trailer".
const TRAILER = /(?<![A-Za-z0-9-])(assisted-by|generated-by):/i;
// Each pattern below is matched once per sentence or line, and none of them
// can try a start again after it fails, so the time a file takes grows with
// its length alone.
const DESCRIPTION = /\b(?:PR|pull request) description\b/i;
const BY_THE_CONTRIBUTOR = /\b(?:yourself|by hand|in your own words)\b/i;
const CLA = /\bCLA\b|contributor license agreement/i;
const LINK = /https:\/\/[^\s<>()[\]"'`]+/;
const CLOSING = '.,;:!?';

/** The trailer a text names for AI help, spelled as the text spells it, or null. */
export function disclosureTrailer(text: string): string | null {
  return TRAILER.exec(text)?.[1] ?? null;
}

/** Whether a sentence names the PR description, then says the contributor writes it. */
export function personWritten(text: string): true | null {
  for (const sentence of text.split(/[.\n]/)) {
    const named = DESCRIPTION.exec(sentence);
    if (named && BY_THE_CONTRIBUTOR.test(sentence.slice(named.index + named[0].length))) return true;
  }
  return null;
}

/** The link without the punctuation that closes the sentence around it. */
function trimClosing(link: string): string {
  let end = link.length;
  while (end > 0 && CLOSING.includes(link.charAt(end - 1))) end--;
  return link.slice(0, end);
}

/** The first https link on a line that names a CLA, or null. */
export function claLink(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!CLA.test(line)) continue;
    const found = LINK.exec(line)?.[0];
    const link = found === undefined ? undefined : trimClosing(found);
    if (link !== undefined && httpsUrl.safeParse(link).success) return link;
  }
  return null;
}

/** The first file, in the order the rules read them, whose text gives a match. */
export function firstMatch<F extends RepoFile, T>(
  files: readonly F[],
  find: (text: string) => T | null,
): { file: F; found: T } | null {
  for (const file of files) {
    const found = find(file.text);
    if (found !== null) return { file, found };
  }
  return null;
}
