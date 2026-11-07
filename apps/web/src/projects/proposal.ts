import { defaultDisclosure, MAX_TAGS, type ProjectSettingsInput, type SettingKey } from '@goodfirsttoken/core';
import type { RepoDocs, RepoFile } from './docs';
import type { LabelCheckOutcome } from './label-check';
import { claLink, disclosureTrailer, firstMatch, meansReady, OUR_LABEL, personWritten } from './rules';

// The settings register_project proposes, from the repo's labels and the
// files it read. The tags come from the model reader's label check when it
// runs, and otherwise from plain rules over the labels' names. The rest are
// plain rules over the text. Each one is written in docs/how-it-works.md
// under Registering a project, and shared with the policy crawler in
// src/projects/rules.ts. The maintainer confirms or changes every value
// before anything saves.

export interface Proposal {
  settings: ProjectSettingsInput;
  /** Why a value differs from its default, from what the repo says. */
  reasons: { setting: SettingKey; reason: string }[];
}

/**
 * The settings to propose. The tags come from the model reader's label
 * check, when it ran (src/projects/label-check.ts), and otherwise from the
 * labels' names by meansReady. With `checked` a fallback, the reason says
 * the labels were read by name, and why.
 */
export function proposeSettings(labels: readonly string[], docs: RepoDocs, checked?: LabelCheckOutcome): Proposal {
  const reasons: Proposal['reasons'] = [];
  const files = [docs.contributing, docs.aiPolicy, docs.agents, docs.prTemplate].filter(
    (file): file is RepoFile => file !== null,
  );

  const byModel = checked !== undefined && 'tags' in checked;
  const ready = byModel ? checked.tags.slice(0, MAX_TAGS) : labels.filter(meansReady).slice(0, MAX_TAGS);
  const tags = ready.length > 0 ? ready : [OUR_LABEL.name];
  const byName = checked !== undefined && 'fallback' in checked ? `, read by name, since ${checked.fallback}` : '';
  reasons.push({
    setting: 'tags',
    reason: byModel
      ? ready.length > 0
        ? `${ready.length === 1 ? 'a label' : 'labels'} the model reader read as ready for outside help, from their names and descriptions`
        : `the model reader read no label as ready for outside help, so Good First Token creates ${OUR_LABEL.name} if you keep it`
      : ready.length > 0
        ? `${ready.length === 1 ? 'a label' : 'labels'} the repo has for outside help${byName}`
        : `the repo has no label for outside help${byName}, so Good First Token creates ${OUR_LABEL.name} if you keep it`,
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
