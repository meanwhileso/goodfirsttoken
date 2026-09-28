import { claConfirmationSchema, mustParse, type ClaConfirmation } from '@goodfirsttoken/core';
import { checkTime } from './shared';

// The cla_confirmations table: each donor's word that they signed a
// project's CLA, with the link they confirmed.

interface ConfirmationRow {
  github_id: number;
  project: string;
  cla_url: string;
  confirmed_at: number;
}

function toConfirmation(row: ConfirmationRow): ClaConfirmation {
  return mustParse(
    claConfirmationSchema,
    { githubId: row.github_id, project: row.project, claUrl: row.cla_url, confirmedAt: row.confirmed_at },
    'CLA confirmation',
  );
}

const confirmationInput = claConfirmationSchema.pick({ githubId: true, project: true, claUrl: true });

/**
 * Records that the donor signed the project's CLA at `claUrl`, at `now`. A
 * donor has one confirmation per project, so confirming a new link replaces
 * the old one.
 */
export async function confirmCla(
  db: D1Database,
  confirmation: { githubId: number; project: string; claUrl: string },
  now: number,
): Promise<ClaConfirmation> {
  const input = mustParse(confirmationInput, confirmation, 'CLA confirmation');
  const row = await db
    .prepare(
      `INSERT INTO cla_confirmations (github_id, project, cla_url, confirmed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (github_id, project) DO UPDATE SET cla_url = excluded.cla_url, confirmed_at = excluded.confirmed_at
       RETURNING *`,
    )
    .bind(input.githubId, input.project, input.claUrl, checkTime(now))
    .first<ConfirmationRow>();
  if (row === null) throw new Error(`The CLA confirmation for ${input.project} was not saved.`);
  return toConfirmation(row);
}

/** The donor's confirmation for the project, whatever link it names, or null. Projects compare without case. */
export async function getClaConfirmation(
  db: D1Database,
  person: number,
  project: string,
): Promise<ClaConfirmation | null> {
  const { githubId, project: repo } = mustParse(
    confirmationInput.pick({ githubId: true, project: true }),
    { githubId: person, project },
    'CLA confirmation',
  );
  const row = await db
    .prepare('SELECT * FROM cla_confirmations WHERE github_id = ? AND project = ?')
    .bind(githubId, repo)
    .first<ConfirmationRow>();
  return row === null ? null : toConfirmation(row);
}
