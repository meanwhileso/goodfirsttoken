import { beforeEach, describe, expect, test } from 'vitest';
import {
  addCandidate,
  addSeed,
  addToDoNotList,
  crawlerSkips,
  decideCandidate,
  getSeed,
  listSeedsToHandle,
  markSeedsHandled,
  saveSeedEvidence,
} from '../../src/db';
import { admin, DAY, db, emptyDatabase, HOUR, maintainer, refusal, registeredProject, signIn, t0 } from './helpers';

// The policy crawler's tables: its seed list, and what it leaves alone.
// Every repo here is made up.

/** A find of the repo in the admin queue, found at `at`. */
async function find(repo: string, at: number) {
  const found = await addCandidate(
    db,
    {
      repo,
      facts: { stars: 1200, createdAt: at - DAY, pushedAt: at, ownerCreatedAt: at - DAY },
      policy: { quote: 'AI help is fine.', url: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
      settings: {},
      suggestedTags: [],
    },
    at,
  );
  if (found === null) throw new Error(`${repo} has a find waiting already`);
  return found;
}

/** Seeds each repo at t0 and records the cron job handling it at `at`. */
async function handled(repos: string[], at: number) {
  for (const repo of repos) await addSeed(db, { repo, addedBy: admin.githubId }, t0);
  await markSeedsHandled(db, repos.map((repo) => ({ repo, outcome: 'queued' as const })), at);
}

const due = async (now: number) => (await listSeedsToHandle(db, 10, now)).map((seed) => seed.repo);

beforeEach(async () => {
  await emptyDatabase();
  await signIn(admin, maintainer);
});

describe('the seed list', () => {
  test('a repo is added once, whatever the case of its name, and keeps its first entry', async () => {
    const first = await addSeed(db, { repo: 'sample-owner/seeded', addedBy: admin.githubId }, t0);
    const again = await addSeed(db, { repo: 'Sample-Owner/Seeded', addedBy: maintainer.githubId }, t0 + HOUR);

    expect(first).toEqual({
      seed: { repo: 'sample-owner/seeded', addedBy: admin.githubId, addedAt: t0, handledAt: null, outcome: null, evidence: null },
      added: true,
    });
    expect(again).toEqual({ seed: first.seed, added: false });
  });

  test('the seeds to handle are the ones not handled yet, oldest first, and handling one again soon after keeps its first time and outcome', async () => {
    await addSeed(db, { repo: 'sample-owner/second', addedBy: admin.githubId }, t0 + HOUR);
    await addSeed(db, { repo: 'sample-owner/first', addedBy: admin.githubId }, t0);
    await addSeed(db, { repo: 'sample-owner/third', addedBy: admin.githubId }, t0 + 2 * HOUR);
    await addSeed(db, { repo: 'sample-owner/fourth', addedBy: admin.githubId }, t0 + 2 * HOUR);

    await markSeedsHandled(
      db,
      [
        { repo: 'Sample-Owner/Second', outcome: 'queued' },
        { repo: 'sample-owner/fourth', outcome: 'project' },
      ],
      t0 + 3 * HOUR,
    );
    await markSeedsHandled(db, [{ repo: 'sample-owner/second', outcome: 'proposed' }], t0 + 4 * HOUR);

    expect((await listSeedsToHandle(db, 10, t0 + 4 * HOUR)).map((seed) => seed.repo)).toEqual(['sample-owner/first', 'sample-owner/third']);
    expect((await listSeedsToHandle(db, 1, t0 + 4 * HOUR)).map((seed) => seed.repo)).toEqual(['sample-owner/first']);
    const { results } = await db.prepare('SELECT repo, handled_at, outcome FROM crawl_seeds WHERE handled_at IS NOT NULL ORDER BY repo').all();
    expect(results).toEqual([
      { repo: 'sample-owner/fourth', handled_at: t0 + 3 * HOUR, outcome: 'project' },
      { repo: 'sample-owner/second', handled_at: t0 + 3 * HOUR, outcome: 'queued' },
    ]);
  });

  test('a seed handled 30 days ago is due again, and one handled 29 days ago is not', async () => {
    await handled(['sample-owner/month'], t0);
    await handled(['sample-owner/later'], t0 + DAY);

    expect(await due(t0 + 30 * DAY - 1)).toEqual([]);
    expect(await due(t0 + 30 * DAY)).toEqual(['sample-owner/month']);
    expect(await due(t0 + 31 * DAY)).toEqual(['sample-owner/later', 'sample-owner/month']);
  });

  test('a seed handled again once it is due records the new time and outcome', async () => {
    await handled(['sample-owner/month'], t0);

    await markSeedsHandled(db, [{ repo: 'sample-owner/month', outcome: 'proposed' }], t0 + 30 * DAY - 1);
    const early = await getSeed(db, 'sample-owner/month');
    await markSeedsHandled(db, [{ repo: 'sample-owner/month', outcome: 'do_not_list' }], t0 + 30 * DAY);

    expect(early).toMatchObject({ handledAt: t0, outcome: 'queued' });
    expect(await getSeed(db, 'sample-owner/month')).toMatchObject({ handledAt: t0 + 30 * DAY, outcome: 'do_not_list' });
    expect(await due(t0 + 31 * DAY)).toEqual([]);
  });

  test('a handled seed whose repo is a project, or whose find waits in the admin queue, is never due again, and one whose find was rejected is', async () => {
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/project');
    await find('Sample-Owner/Waiting', t0);
    const rejected = await find('sample-owner/rejected', t0);
    await decideCandidate(db, rejected.id, { status: 'rejected', decidedBy: admin.githubId, reason: 'Not now.' }, t0 + HOUR);
    await handled(['sample-owner/project', 'sample-owner/waiting', 'sample-owner/rejected', 'sample-owner/plain'], t0);

    expect(await due(t0 + 60 * DAY)).toEqual(['sample-owner/plain', 'sample-owner/rejected']);
  });

  test('a seed never handled is due whatever its repo, so the cron job records why it leaves one alone', async () => {
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/project');
    await find('sample-owner/waiting', t0);
    await addSeed(db, { repo: 'sample-owner/project', addedBy: admin.githubId }, t0);
    await addSeed(db, { repo: 'sample-owner/waiting', addedBy: admin.githubId }, t0);

    expect(await due(t0 + HOUR)).toEqual(['sample-owner/project', 'sample-owner/waiting']);
  });

  test('adding a seed on the list already makes it due at the next run, and keeps who added it and when', async () => {
    await handled(['sample-owner/seeded'], t0 + HOUR);

    const again = await addSeed(db, { repo: 'Sample-Owner/Seeded', addedBy: maintainer.githubId }, t0 + 2 * HOUR);

    expect(again).toEqual({
      seed: { repo: 'sample-owner/seeded', addedBy: admin.githubId, addedAt: t0, handledAt: null, outcome: null, evidence: null },
      added: false,
    });
    expect(await due(t0 + 2 * HOUR)).toEqual(['sample-owner/seeded']);
  });

  test('saving evidence keeps a seed handled, unless the save asks for it to be due', async () => {
    await handled(['sample-owner/kept', 'sample-owner/due'], t0);

    await saveSeedEvidence(db, { repo: 'sample-owner/kept', addedBy: admin.githubId, evidence: null }, t0 + HOUR);
    const saved = await saveSeedEvidence(db, { repo: 'sample-owner/due', addedBy: admin.githubId, evidence: null, due: true }, t0 + HOUR);

    expect(saved?.seed).toMatchObject({ handledAt: null, outcome: null });
    expect(await due(t0 + HOUR)).toEqual(['sample-owner/due']);
  });

  test('only a numeric GitHub ID of someone who signed in can add a seed', async () => {
    expect(await refusal(addSeed(db, { repo: 'sample-owner/seeded', addedBy: 424242 }, t0))).toMatch(/FOREIGN KEY/);
    expect(await refusal(addSeed(db, { repo: 'not a repo', addedBy: admin.githubId }, t0))).toMatch(/repo/);
  });
});

describe('what the crawler leaves alone', () => {
  test('a repo on the do-not-list, a project, or one it proposed before, whatever the admin decided, with the do-not-list first', async () => {
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/listed');
    await addToDoNotList(db, { repo: 'sample-owner/listed', reason: null, addedBy: admin.githubId }, t0);
    await registeredProject({ tags: ['help wanted'] }, 'sample-owner/project');
    const found = await addCandidate(
      db,
      {
        repo: 'sample-owner/proposed',
        facts: { stars: 1200, createdAt: t0 - DAY, pushedAt: t0, ownerCreatedAt: t0 - DAY },
        policy: { quote: 'AI help is fine.', url: 'https://github.com/sample-owner/proposed/blob/main/CONTRIBUTING.md', tier: 'allows_with_conditions' },
        settings: {},
        suggestedTags: [],
      },
      t0,
    );
    await decideCandidate(db, found?.id ?? '', { status: 'rejected', decidedBy: admin.githubId, reason: 'Not now.' }, t0 + HOUR);

    const skips = await crawlerSkips(db, ['Sample-Owner/Listed', 'sample-owner/project', 'SAMPLE-OWNER/PROPOSED', 'sample-owner/new']);

    expect(skips).toEqual(
      new Map([
        ['sample-owner/listed', 'do_not_list'],
        ['sample-owner/project', 'project'],
        ['sample-owner/proposed', 'proposed'],
      ]),
    );
    expect(await crawlerSkips(db, [])).toEqual(new Map());
  });
});

describe("the search's records", () => {
  test('are gone: no pass checkpoints, no popular sample, and no record of repos queued in a pass', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('crawl_passes', 'popular_crawl_passes', 'crawl_queued_repos')")
      .all<{ name: string }>();

    expect(results).toEqual([]);
  });
});
