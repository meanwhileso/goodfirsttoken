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
// A line that says the CLA must be signed, and nothing that says there is none.
const MUST_SIGN = /\bsign(?:s|ed|ing)?\b|\brequire[sd]?\b|\bmust\b|\bneeds? to\b/i;
const NONE = /\b(?:no|not|never|none|without|dont|doesnt)\b|n['’]t\b/i;
const LINK = /https:\/\/[^\s<>()[\]"'`]+/;
const CLOSING = '.,;:!?';

/** What a rule found in a text, and where. */
export interface Found<T> {
  found: T;
  /** Where in the text it was found. */
  index: number;
}

/** The trailer a text names for AI help, spelled as the text spells it, and where, or null. */
export function findTrailer(text: string): Found<string> | null {
  const match = TRAILER.exec(text);
  return match?.[1] === undefined ? null : { found: match[1], index: match.index };
}

/** The trailer a text names for AI help, spelled as the text spells it, or null. */
export function disclosureTrailer(text: string): string | null {
  return findTrailer(text)?.found ?? null;
}

/** Where a sentence names the PR description, then says the contributor writes it, or null. */
export function findPersonWritten(text: string): Found<true> | null {
  let offset = 0;
  for (const sentence of text.split(/[.\n]/)) {
    const named = DESCRIPTION.exec(sentence);
    if (named && BY_THE_CONTRIBUTOR.test(sentence.slice(named.index + named[0].length))) {
      return { found: true, index: offset + named.index };
    }
    offset += sentence.length + 1;
  }
  return null;
}

/** Whether a sentence names the PR description, then says the contributor writes it. */
export function personWritten(text: string): true | null {
  return findPersonWritten(text)?.found ?? null;
}

/** The link without the punctuation that closes the sentence around it. */
function trimClosing(link: string): string {
  let end = link.length;
  while (end > 0 && CLOSING.includes(link.charAt(end - 1))) end--;
  return link.slice(0, end);
}

/**
 * The first https link on a line that names a CLA and says it must be
 * signed, and where, or null. A line that says there is no CLA, or that it
 * isn't needed, gives none, whatever link it has.
 */
export function findClaLink(text: string): Found<string> | null {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (CLA.test(line) && MUST_SIGN.test(line) && !NONE.test(line)) {
      const match = LINK.exec(line);
      const link = match === null ? undefined : trimClosing(match[0]);
      if (match !== null && link !== undefined && httpsUrl.safeParse(link).success) {
        return { found: link, index: offset + match.index };
      }
    }
    offset += line.length + 1;
  }
  return null;
}

/** The first https link on a line that says a CLA must be signed, or null. */
export function claLink(text: string): string | null {
  return findClaLink(text)?.found ?? null;
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
