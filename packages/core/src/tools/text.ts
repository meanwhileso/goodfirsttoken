import type { ProjectSettings, SettingKey } from '../projects';

// Helpers for the plain-text side of tool results.

/** A time as `2026-09-26 13:02 UTC`. */
export function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `1 issue`, `3 issues`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

/** Indents every line of `text`. */
export function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

/** Joins the parts that are present, one per line. */
export function lines(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string').join('\n');
}

/** A numbered list, with each item's first line after its number. */
export function numbered<T>(items: readonly T[], render: (item: T) => string): string {
  const width = String(items.length).length;
  return items
    .map((item, i) => {
      const [first = '', ...rest] = render(item).split('\n');
      const number = String(i + 1).padStart(width);
      return lines(`${number}  ${first}`, rest.length > 0 && indent(rest.join('\n'), width + 2));
    })
    .join('\n');
}

const SETTING_LABELS: Record<SettingKey, string> = {
  tags: 'Tags',
  excludedTags: 'Excluded tags',
  issueRepo: 'Issue repo',
  prMode: 'PR mode',
  whoCanClaim: 'Who can claim',
  disclosure: 'Disclosure',
  personWrittenDescription: 'Person-written PR description',
  claUrl: 'CLA',
  agentNotes: 'Notes for agents',
  claimsPerIssue: 'Claims per issue',
  openPrsPerDonor: 'Open PRs per donor',
};

export function describeDisclosure(settings: ProjectSettings): string {
  const { trailer, prBodyLine } = settings.disclosure;
  if (trailer !== null && prBodyLine) return `${trailer} trailer on each commit, and one line in the PR body`;
  if (trailer !== null) return `${trailer} trailer on each commit`;
  return 'one line in the PR body';
}

function settingValue(settings: ProjectSettings, key: SettingKey): string {
  switch (key) {
    case 'tags':
      return settings.tags.join(', ');
    case 'excludedTags':
      return listOrNone(settings.excludedTags);
    case 'issueRepo':
      return settings.issueRepo ?? 'same as the code repo';
    case 'prMode':
      return settings.prMode;
    case 'whoCanClaim':
      return settings.whoCanClaim === 'vouched' ? 'vouched donors only' : 'anyone';
    case 'disclosure':
      return describeDisclosure(settings);
    case 'personWrittenDescription':
      return settings.personWrittenDescription ? 'yes' : 'no';
    case 'claUrl':
      return settings.claUrl ?? 'none';
    case 'agentNotes':
      return settings.agentNotes ? 'below' : 'none';
    case 'claimsPerIssue':
      return String(settings.claimsPerIssue);
    case 'openPrsPerDonor':
      return String(settings.openPrsPerDonor);
  }
}

/** Every setting on its own line, with the reason for any the server proposed. */
export function renderSettings(
  settings: ProjectSettings,
  reasons: readonly { setting: SettingKey; reason: string }[] = [],
): string {
  const width = Math.max(...Object.values(SETTING_LABELS).map((label) => label.length)) + 2;
  const rows = (Object.keys(SETTING_LABELS) as SettingKey[]).map((key) => {
    const reason = reasons.find((r) => r.setting === key)?.reason;
    const value = settingValue(settings, key);
    return SETTING_LABELS[key].padEnd(width) + (reason ? `${value} (${reason})` : value);
  });
  return lines(
    ...rows,
    settings.agentNotes !== '' && `Notes for agents, word for word:\n${indent(settings.agentNotes, 2)}`,
  );
}
