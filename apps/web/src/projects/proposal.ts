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
const PERSON_WRITTEN = /\b(?:PR|pull request) description\b[^.\n]*\b(?:yourself|by hand|in your own words)\b/i;
const CLA = /\bCLA\b|contributor license agreement/i;
const LINK = /https:\/\/[^\s<>()[\]"'`]+/;

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
    const link = LINK.exec(line)?.[0].replace(/[.,;:!?]+$/, '');
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

  const personWritten = firstMatch(files, (text) => (PERSON_WRITTEN.test(text) ? true : null));
  if (personWritten !== null) {
    settings.personWrittenDescription = true;
    reasons.push({
      setting: 'personWrittenDescription',
      reason: `${personWritten.file.path} asks contributors to write the PR description themselves`,
    });
  }

  const cla = firstMatch(files, claLink);
  if (cla !== null) {
    settings.claUrl = cla.found;
    reasons.push({ setting: 'claUrl', reason: `${cla.file.path} links it` });
  }

  return { settings, reasons };
}
