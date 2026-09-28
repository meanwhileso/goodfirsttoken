import { env } from 'cloudflare:workers';
import { createProject, savePerson } from '../../src/db';
import type { ProjectRecord, ProjectSettingsInput } from '@goodfirsttoken/core';

// Shared setup for the data-access tests. Every person, repo, and policy here
// is made up.

export const db = env.DB;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const t0 = Date.UTC(2026, 8, 26, 12, 0, 0);

export const priya = { githubId: 1001, login: 'priya' };
export const kenji = { githubId: 1002, login: 'kenji' };
export const maintainer = { githubId: 2001, login: 'sample-maintainer' };
export const coMaintainer = { githubId: 2002, login: 'sample-co-maintainer' };
export const admin = { githubId: 9001, login: 'sample-admin' };

export const repo = 'sample-owner/sample-app';
export const sha = '4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';

/**
 * Empties every table the migrations made, so each test starts from nothing.
 * Storage is shared by the tests in one file.
 */
export async function emptyDatabase(): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT IN ('d1_migrations', 'sqlite_sequence') AND name NOT GLOB '_cf_*'`,
    )
    .all<{ name: string }>();
  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = on'),
    ...results.map(({ name }) => db.prepare(`DELETE FROM "${name}"`)),
  ]);
}

/** Signs in everyone who takes part in a test. */
export async function signIn(...people: { githubId: number; login: string }[]): Promise<void> {
  for (const person of people) await savePerson(db, person, t0);
}

/** An approved project registered by `maintainer`, who must be signed in. */
export async function registeredProject(
  settings: ProjectSettingsInput = { tags: ['help wanted'] },
  name = repo,
): Promise<ProjectRecord> {
  const project = await createProject(
    db,
    { repo: name, status: 'approved', source: 'registered', policy: null, settings, addedBy: maintainer.githubId },
    t0,
  );
  if (project === null) throw new Error(`${name} is already a project`);
  return project;
}

/**
 * Takes a repo off the do-not-list, whatever the case of its name, as an
 * admin's approval of its maintainer's registration does.
 */
export async function takeOffDoNotList(name: string): Promise<void> {
  await db.prepare('DELETE FROM do_not_list WHERE repo = ?').bind(name).run();
}

/** The message of the error a call throws, which fails the test if it doesn't throw. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the call to be refused.');
}
