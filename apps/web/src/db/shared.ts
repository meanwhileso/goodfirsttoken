import { epochMs, issueRef, mustParse, type PrRef } from '@goodfirsttoken/core';

// Helpers the table modules share. Every module checks what it writes and
// what it reads with the core schemas, so a bad value never reaches the
// database and a bad row never reaches the caller.

/** Checks a time passed in, in whole milliseconds since the epoch. */
export function checkTime(now: number, name = 'now'): number {
  return mustParse(epochMs, now, name);
}

/** Splits `owner/name#12` into its repo and number. */
export function splitIssue(issue: string): { repo: string; number: number } {
  const checked = mustParse(issueRef, issue, 'issue');
  const hash = checked.lastIndexOf('#');
  return { repo: checked.slice(0, hash), number: Number(checked.slice(hash + 1)) };
}

export function joinIssue(repo: string, number: number): string {
  return `${repo}#${String(number)}`;
}

/**
 * A PR from its three columns, which are all set or all null. The result goes
 * to a schema check, which names the field when only some are set.
 */
export function prFromColumns(repo: string | null, number: number | null, url: string | null): unknown {
  if (repo === null && number === null && url === null) return null;
  return { repo, number, url };
}

/** The three columns for a PR, or three nulls. */
export function prColumns(pr: PrRef | null): [string | null, number | null, string | null] {
  return pr === null ? [null, null, null] : [pr.repo, pr.number, pr.url];
}

/** JSON text from a column, or null for SQL NULL. */
export function fromJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

/** A new ID for a row, like `s_2x8Qm0vT4kLp9aZr1yWc`. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `${prefix}_${base64.replaceAll('+', '-').replaceAll('/', '_')}`;
}
