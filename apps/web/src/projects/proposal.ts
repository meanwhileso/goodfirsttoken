import { defaultDisclosure, MAX_TAGS, type ProjectSettingsInput, type SettingKey } from '@goodfirsttoken/core';
import type { RepoDocs, RepoFile } from './docs';
import { claLink, disclosureTrailer, firstMatch, meansReady, OUR_LABEL, personWritten } from './rules';

// The settings register_project proposes, from the repo's labels and the
// files it read. Plain rules over the text, each one written in
// docs/how-it-works.md under Registering a project, and shared with the
// policy crawler in src/projects/rules.ts. The maintainer confirms or
// changes every value before anything saves.

export interface Proposal {
  settings: ProjectSettingsInput;
  /** Why a value differs from its default, from what the repo says. */
  reasons: { setting: SettingKey; reason: string }[];
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

  const trailer = firstMatch(files, disclosureTrailer);
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
