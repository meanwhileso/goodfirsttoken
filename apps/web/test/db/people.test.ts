import { beforeEach, describe, expect, test } from 'vitest';
import { findPersonByLogin, getPerson, savePerson, setInterests } from '../../src/db';
import { DAY, db, emptyDatabase, kenji, priya, refusal, t0 } from './helpers';

beforeEach(emptyDatabase);

describe('people', () => {
  test('a person signing in for the first time joins with no interests', async () => {
    const saved = await savePerson(db, priya, t0);

    expect(saved).toEqual({ ...priya, interests: null, joinedAt: t0, seenAt: t0 });
    expect(await getPerson(db, priya.githubId)).toEqual(saved);
  });

  test('someone who never signed in is not found', async () => {
    expect(await getPerson(db, priya.githubId)).toBeNull();
    expect(await findPersonByLogin(db, 'priya')).toBeNull();
  });

  test('a person who renamed their account keeps their interests and join time under the new login', async () => {
    await savePerson(db, priya, t0);
    await setInterests(db, priya.githubId, { languages: ['rust'], projects: [], kinds: ['tests'] });

    const renamed = await savePerson(db, { githubId: priya.githubId, login: 'priya-dev' }, t0 + DAY);

    expect(renamed).toEqual({
      githubId: priya.githubId,
      login: 'priya-dev',
      interests: { languages: ['rust'], projects: [], kinds: ['tests'] },
      joinedAt: t0,
      seenAt: t0 + DAY,
    });
    expect(await findPersonByLogin(db, 'priya-dev')).toEqual(renamed);
  });

  test('a sign-in that GitHub answered earlier never replaces a newer login', async () => {
    await savePerson(db, priya, t0);
    const renamed = await savePerson(db, { githubId: priya.githubId, login: 'priya-dev' }, t0 + DAY);

    const late = await savePerson(db, priya, t0 + 1);

    expect(late).toEqual(renamed);
    expect(await findPersonByLogin(db, 'priya')).toBeNull();
  });

  test('a person is found by login whatever its case, the way GitHub compares logins', async () => {
    await savePerson(db, priya, t0);

    expect((await findPersonByLogin(db, 'PRIYA'))?.githubId).toBe(priya.githubId);
  });

  test('a freed login belongs to the account seen with it most recently', async () => {
    // priya renamed her account, and kenji took her old login.
    await savePerson(db, priya, t0);
    await savePerson(db, { githubId: kenji.githubId, login: 'priya' }, t0 + DAY);

    expect((await findPersonByLogin(db, 'priya'))?.githubId).toBe(kenji.githubId);
  });

  test('saved interests replace the old ones', async () => {
    await savePerson(db, priya, t0);
    await setInterests(db, priya.githubId, { languages: ['rust'], projects: [], kinds: [] });

    const saved = await setInterests(db, priya.githubId, { languages: [], projects: [], kinds: ['docs'] });

    expect(saved?.interests).toEqual({ languages: [], projects: [], kinds: ['docs'] });
    expect((await getPerson(db, priya.githubId))?.interests).toEqual(saved?.interests);
  });

  test('interests for someone who never signed in save nothing', async () => {
    expect(await setInterests(db, priya.githubId, { languages: ['go'], projects: [], kinds: [] })).toBeNull();
    expect(await getPerson(db, priya.githubId)).toBeNull();
  });

  test('a malformed login is refused before it reaches the database, naming the field', async () => {
    const message = await refusal(savePerson(db, { githubId: priya.githubId, login: 'not a login' }, t0));

    expect(message).toContain('login: must be a GitHub login');
    expect(await getPerson(db, priya.githubId)).toBeNull();
  });
});
