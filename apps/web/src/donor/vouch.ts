// A project's vouch file, in the Trustdown (.td) format that
// github.com/mitchellh/vouch defines and Ghostty uses, at .github/VOUCHED.td.
// docs/architecture.md, under The donor's tools, cites what the format
// follows. In short:
//
// - Blank lines, and lines that start with #, are no entry.
// - Each other line names one person: a handle, then optional details after
//   a space. A handle is a login, or platform:login, like github:octocat.
// - A line that starts with - denounces that person.
// - Handles compare without case.

export type VouchStatus = 'vouched' | 'denounced' | 'unknown';

export interface VouchEntry {
  denounced: boolean;
  /** The platform the line names, in lower case, or null when it names none. */
  platform: string | null;
  /** The login, in lower case. */
  username: string;
}

/** The entries in a vouch file, in the order it lists them. */
export function parseVouchFile(text: string): VouchEntry[] {
  const entries: VouchEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const denounced = line.startsWith('-');
    const [handle = ''] = (denounced ? line.slice(1) : line).split(/\s/, 1);
    const lowered = handle.toLowerCase();
    const colon = lowered.indexOf(':');
    const platform = colon < 0 ? null : lowered.slice(0, colon);
    const username = colon < 0 ? lowered : lowered.slice(colon + 1);
    if (username !== '') entries.push({ denounced, platform, username });
  }
  return entries;
}

/**
 * Where a GitHub login stands in a vouch file. A line with no platform, or
 * with the github platform, names a GitHub login, and a line for another
 * platform names no one here. vouch's own check takes the first line that
 * names the person, and the files it writes name each person once. Here any
 * line that denounces the person counts over a line that vouches for them,
 * so a file that names someone both ways refuses them.
 */
export function vouchStatus(entries: readonly VouchEntry[], login: string): VouchStatus {
  const named = entries.filter(
    (entry) => entry.username === login.toLowerCase() && (entry.platform === null || entry.platform === 'github'),
  );
  if (named.some((entry) => entry.denounced)) return 'denounced';
  return named.length > 0 ? 'vouched' : 'unknown';
}
