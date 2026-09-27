import {
  githubId,
  githubLogin,
  interestsSchema,
  mustParse,
  personSchema,
  type Interests,
  type Person,
} from '@goodfirsttoken/core';
import { checkTime, fromJson } from './shared';

// The people table: everyone who has signed in.

interface PersonRow {
  github_id: number;
  login: string;
  interests: string | null;
  joined_at: number;
  seen_at: number;
}

function toPerson(row: PersonRow): Person {
  return mustParse(
    personSchema,
    {
      githubId: row.github_id,
      login: row.login,
      interests: fromJson(row.interests),
      joinedAt: row.joined_at,
      seenAt: row.seen_at,
    },
    'person',
  );
}

const personIdentity = personSchema.pick({ githubId: true, login: true });

/**
 * Records a person as GitHub showed them at `now`. A new person joins then.
 * Someone already known keeps their interests and join time, and takes the
 * login GitHub gave, since logins can change. A sighting older than the one
 * stored changes nothing, so a slow sign-in never brings back an old login.
 */
export async function savePerson(
  db: D1Database,
  person: { githubId: number; login: string },
  now: number,
): Promise<Person> {
  const { githubId: id, login } = mustParse(personIdentity, person, 'person');
  const row = await db
    .prepare(
      `INSERT INTO people (github_id, login, interests, joined_at, seen_at) VALUES (?1, ?2, NULL, ?3, ?3)
       ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, seen_at = excluded.seen_at
         WHERE excluded.seen_at >= people.seen_at
       RETURNING *`,
    )
    .bind(id, login, checkTime(now))
    .first<PersonRow>();
  if (row !== null) return toPerson(row);
  const stored = await getPerson(db, id);
  if (stored === null) throw new Error(`Person ${String(id)} was not saved.`);
  return stored;
}

export async function getPerson(db: D1Database, id: number): Promise<Person | null> {
  const row = await db
    .prepare('SELECT * FROM people WHERE github_id = ?')
    .bind(mustParse(githubId, id, 'githubId'))
    .first<PersonRow>();
  return row === null ? null : toPerson(row);
}

/**
 * The person with `login`, compared without case. A freed login can go to a
 * new account, so the person seen with it most recently has it.
 */
export async function findPersonByLogin(db: D1Database, login: string): Promise<Person | null> {
  const row = await db
    .prepare('SELECT * FROM people WHERE login = ? ORDER BY seen_at DESC LIMIT 1')
    .bind(mustParse(githubLogin, login, 'login'))
    .first<PersonRow>();
  return row === null ? null : toPerson(row);
}

/** Saves what a person likes to work on. Null when there's no such person. */
export async function setInterests(
  db: D1Database,
  id: number,
  interests: Interests,
): Promise<Person | null> {
  const row = await db
    .prepare('UPDATE people SET interests = ? WHERE github_id = ? RETURNING *')
    .bind(
      JSON.stringify(mustParse(interestsSchema, interests, 'interests')),
      mustParse(githubId, id, 'githubId'),
    )
    .first<PersonRow>();
  return row === null ? null : toPerson(row);
}
