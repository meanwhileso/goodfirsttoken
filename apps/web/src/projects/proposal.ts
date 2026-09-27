import {
  defaultDisclosure,
  httpsUrl,
  MAX_TAGS,
  type ProjectSettingsInput,
  type SettingKey,
} from '@goodfirsttoken/core';
import { OUR_LABEL, type RepoDocs, type RepoFile } from './repo';

// The settings register_project proposes, from the repo's labels and the
// files it read. Plain rules over the text, each one written in
// docs/how-it-works.md under Registering a project. The maintainer confirms
// or changes every value before anything saves.

export interface Proposal {
  settings: ProjectSettingsInput;
  /** Why a value differs from its default, from what the repo says. */
  reasons: { setting: SettingKey; reason: string }[];
}

/** Labels that mean ready for outside help, compared without case. */
const READY_LABELS = ['help wanted', 'contributor friendly', 'contribution welcome', OUR_LABEL.name];

function meansReady(label: string): boolean {
  const name = label.toLowerCase();
  return READY_LABELS.includes(name) || name.startsWith('.contrib/');
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

/** Whether a sentence names the PR description, then says the contributor writes it. */
function personWritten(text: string): true | null {
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

/** The first file, in the order the rules read them, whose text gives a match. */
function firstMatch<T>(files: RepoFile[], find: (text: string) => T | null): { file: RepoFile; found: T } | null {
  for (const file of files) {
    const found = find(file.text);
    if (found !== null) return { file, found };
  }
  return null;
}

function claLink(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!CLA.test(line)) continue;
    const found = LINK.exec(line)?.[0];
    const link = found === undefined ? undefined : trimClosing(found);
    if (link !== undefined && httpsUrl.safeParse(link).success) return link;
  }
  return null;
}

export function proposeSettings(labels: readonly string[], docs: RepoDocs): Proposal {
  const reasons: Proposal['reasons'] = [];
  const files = [docs.contributing, docs.aiPolicy, docs.agents, docs.prTemplate].filter(
    (file): file is RepoFile => file !== null,
  );

  const ready = labels.filter(meansReady).slice(0, MAX_TAGS);
  const tags = ready.length > 0 ? ready : [OUR_LABEL.name];
  reasons.push({
    setting: 'tags',
    reason:
      ready.length > 0
        ? `${ready.length === 1 ? 'a label' : 'labels'} the repo has for outside help`
        : `the repo has no label for outside help, so Good First Token creates ${OUR_LABEL.name} if you keep it`,
  });

  const settings: ProjectSettingsInput = { tags };

  const trailer = firstMatch(files, (text) => TRAILER.exec(text)?.[1] ?? null);
  if (trailer !== null) {
    settings.disclosure = { ...defaultDisclosure, trailer: trailer.found };
    reasons.push({ setting: 'disclosure', reason: `${trailer.file.path} names the ${trailer.found} trailer` });
  }

  const written = firstMatch(files, personWritten);
  if (written !== null) {
    settings.personWrittenDescription = true;
    reasons.push({
      setting: 'personWrittenDescription',
      reason: `${written.file.path} asks contributors to write the PR description themselves`,
    });
  }

  const cla = firstMatch(files, claLink);
  if (cla !== null) {
    settings.claUrl = cla.found;
    reasons.push({ setting: 'claUrl', reason: `${cla.file.path} links it` });
  }

  return { settings, reasons };
}
