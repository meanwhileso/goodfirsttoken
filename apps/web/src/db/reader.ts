import {
  docsHashSchema,
  modelReadingSchema,
  mustParse,
  policyFingerprintSchema,
  repoFactsSchema,
  repoName,
  type DocsHash,
  type ModelReading,
  type RepoFacts,
} from '@goodfirsttoken/core';
import type { DayUse, Share } from '../crawl/reader/budget';
import { noUse, SHARE_NAMES } from '../crawl/reader/budget';
import type { PolicyFile, PolicyFileKind, RepoLabel } from '../crawl/rules';
import { checkTime, fromJson, newId } from './shared';

// The model policy reader's tables (docs/specs/model-policy-reader.md, under
// Where it runs): the last reading of each repo's docs, the readings waiting
// to be sent or collected with their staged files, the batches in flight,
// each day's spend, and a little state between runs. The crawl consumer
// stages readings (src/crawl/model.ts), and the hourly run sends and
// collects them (src/crawl/batches.ts).

// ---------------------------------------------------------------------------
// The last reading of each repo.

export interface KeptReading {
  repo: string;
  docsHash: DocsHash;
  readerVersion: string;
  reading: ModelReading;
  fingerprint: string;
  readAt: number;
  /** The model's policy reading as JSON, which a label check reads its statements from, or null for a reading kept before. */
  output: unknown;
}

interface ReadingRow {
  repo: string;
  docs_hash: string;
  reader_version: string;
  reading: string;
  fingerprint: string;
  read_at: number;
  output: string | null;
}

function toKept(row: ReadingRow): KeptReading {
  return {
    repo: mustParse(repoName, row.repo, 'repo'),
    docsHash: mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
    readerVersion: row.reader_version,
    reading: mustParse(modelReadingSchema, fromJson(row.reading), 'reading'),
    fingerprint: mustParse(policyFingerprintSchema, row.fingerprint, 'fingerprint'),
    readAt: row.read_at,
    output: row.output === null ? null : fromJson(row.output),
  };
}

/** The last reading the model made of the repo's docs, or null. */
export async function getModelReading(db: D1Database, repo: string): Promise<KeptReading | null> {
  const row = await db
    .prepare('SELECT * FROM model_readings WHERE repo = ?')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<ReadingRow>();
  return row === null ? null : toKept(row);
}

/** The model's reading of the repo's docs with this docs hash, or null when its last reading was of other docs. */
export async function getModelReadingOf(db: D1Database, repo: string, hash: DocsHash | null): Promise<ModelReading | null> {
  if (hash === null) return null;
  const kept = await getModelReading(db, repo);
  return kept?.docsHash === hash ? kept.reading : null;
}

/** Keeps the model's reading of the repo's docs, in place of the last one. */
export async function keepModelReading(
  db: D1Database,
  read: { repo: string; reading: ModelReading; fingerprint: string; output?: unknown },
  now: number,
): Promise<void> {
  const reading = mustParse(modelReadingSchema, read.reading, 'reading');
  await db
    .prepare(
      `INSERT INTO model_readings (repo, docs_hash, reader_version, reading, fingerprint, read_at, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (repo) DO UPDATE SET docs_hash = ?2, reader_version = ?3, reading = ?4, fingerprint = ?5, read_at = ?6, output = ?7`,
    )
    .bind(
      mustParse(repoName, read.repo, 'repo'),
      reading.docsHash,
      reading.readerVersion,
      JSON.stringify(reading),
      mustParse(policyFingerprintSchema, read.fingerprint, 'fingerprint'),
      checkTime(now),
      read.output === undefined || read.output === null ? null : JSON.stringify(read.output),
    )
    .run();
}

/**
 * Keeps what the model's label check made of the repo's labels on its kept
 * reading of these docs. False when the kept reading is of other docs, or
 * there is none, so nothing changed.
 */
export async function keepModelLabels(db: D1Database, repo: string, hash: DocsHash, labels: ModelReading['labels']): Promise<boolean> {
  const kept = await getModelReading(db, repo);
  if (kept?.docsHash !== hash) return false;
  const reading = mustParse(modelReadingSchema, { ...kept.reading, labels }, 'reading');
  const result = await db
    .prepare('UPDATE model_readings SET reading = ? WHERE repo = ? AND docs_hash = ?')
    .bind(JSON.stringify(reading), mustParse(repoName, repo, 'repo'), hash)
    .run();
  return result.meta.changes === 1;
}

// ---------------------------------------------------------------------------
// Pending readings and their staged files.

export type ReadingPurpose = 'seed' | 'reread';

/** Which call a pending reading waits on: the policy reading, a find's label check after it, or a second reading for a pause. */
export type PendingStep = 'reading' | 'labels' | 'second';

export interface NewPending {
  repo: string;
  purpose: ReadingPurpose;
  share: Share;
  docsHash: DocsHash;
  /** What the rules read in the same files, for the log. */
  rulesTier: string;
  commit: string;
  branch: string;
  facts: RepoFacts;
  vouch: string | null;
  labels: RepoLabel[];
  files: readonly PolicyFile[];
  /** A label check staged on its own, for docs whose kept reading would make a find, with that reading's output. */
  labelsFor?: { readingOutput: unknown };
  /** A second reading for a pause, staged on its own, for docs whose kept reading reads a move into a ban, with that reading's output. */
  secondFor?: { firstOutput: unknown };
}

export interface Pending extends Omit<NewPending, 'files' | 'labelsFor' | 'secondFor'> {
  id: string;
  stagedAt: number;
  batchId: string | null;
  sentAt: number | null;
  reservedUsd: number;
  reservedDay: string | null;
  /** True when a newer reading of the repo was staged after this one was sent. */
  replaced: boolean;
  step: PendingStep;
  /** The model's policy reading, as JSON that passed the checks, while the label check waits. */
  readingOutput: unknown;
  /** The model's first reading of the same files, as JSON that passed the checks, while a second reading for a pause waits. */
  firstOutput: unknown;
}

interface PendingRow {
  id: string;
  repo: string;
  purpose: string;
  share: string;
  docs_hash: string;
  rules_tier: string;
  commit_sha: string;
  branch: string;
  facts: string;
  vouch: string | null;
  labels: string;
  staged_at: number;
  batch_id: string | null;
  sent_at: number | null;
  reserved_usd: number;
  reserved_day: string | null;
  replaced: number;
  step: string;
  reading_output: string | null;
  first_output: string | null;
}

/** Labels as they were staged, each with its description, or a throw for a row in another form. */
function labelsOf(value: unknown): RepoLabel[] {
  if (!Array.isArray(value)) throw new TypeError('labels must be a list');
  return value.map((label: unknown) => {
    const { name, openIssues, description } = (label ?? {}) as { name?: unknown; openIssues?: unknown; description?: unknown };
    if (typeof name !== 'string' || typeof openIssues !== 'number' || !Number.isInteger(openIssues) || openIssues < 0) {
      throw new TypeError('each label must have a name and an open issue count');
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      throw new TypeError("a label's description must be text");
    }
    return { name, openIssues, description: description ?? null };
  });
}

function isShare(value: string): value is Share {
  return (SHARE_NAMES as readonly string[]).includes(value);
}

function shareOf(value: string): Share {
  if (!isShare(value)) throw new TypeError(`${value} is no share of the model's budget`);
  return value;
}

function toPending(row: PendingRow): Pending {
  return {
    id: row.id,
    repo: mustParse(repoName, row.repo, 'repo'),
    purpose: row.purpose === 'reread' ? 'reread' : 'seed',
    share: shareOf(row.share),
    docsHash: mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
    rulesTier: row.rules_tier,
    commit: row.commit_sha,
    branch: row.branch,
    facts: mustParse(repoFactsSchema, fromJson(row.facts), 'facts'),
    vouch: row.vouch,
    labels: labelsOf(fromJson(row.labels)),
    stagedAt: row.staged_at,
    batchId: row.batch_id,
    sentAt: row.sent_at,
    reservedUsd: row.reserved_usd,
    reservedDay: row.reserved_day,
    replaced: row.replaced === 1,
    step: row.step === 'labels' ? 'labels' : row.first_output !== null ? 'second' : 'reading',
    readingOutput: row.reading_output === null ? null : fromJson(row.reading_output),
    firstOutput: row.first_output === null ? null : fromJson(row.first_output),
  };
}

/**
 * Stages a reading of the repo's docs, with its files, at `now`, in place of
 * the repo's older one. An older one not yet sent goes, with its files. One
 * already sent stays, marked as replaced and without its files, so the
 * collector settles its cost and drops it when it comes back. Returns the new
 * reading's ID, which is its custom_id in a batch.
 */
export async function stagePending(db: D1Database, pending: NewPending, now: number): Promise<string> {
  const id = newId('rdg');
  const repo = mustParse(repoName, pending.repo, 'repo');
  const facts = mustParse(repoFactsSchema, pending.facts, 'facts');
  const labels = labelsOf(pending.labels);
  const share = shareOf(pending.share);
  await db.batch([
    db.prepare(
      `DELETE FROM model_staged_files WHERE reading_id IN (SELECT id FROM model_pending WHERE repo = ?1)`,
    ).bind(repo),
    db.prepare('DELETE FROM model_pending WHERE repo = ?1 AND batch_id IS NULL').bind(repo),
    db.prepare('UPDATE model_pending SET replaced = 1 WHERE repo = ?1').bind(repo),
    db
      .prepare(
        `INSERT INTO model_pending (id, repo, purpose, share, docs_hash, rules_tier, commit_sha, branch, facts, vouch, labels, staged_at, step, reading_output, first_output)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        id,
        repo,
        pending.purpose === 'reread' ? 'reread' : 'seed',
        share,
        mustParse(docsHashSchema, pending.docsHash, 'docsHash'),
        pending.rulesTier,
        pending.commit,
        pending.branch,
        JSON.stringify(facts),
        pending.vouch,
        JSON.stringify(labels),
        checkTime(now),
        pending.labelsFor === undefined ? 'reading' : 'labels',
        pending.labelsFor === undefined ? null : JSON.stringify(pending.labelsFor.readingOutput),
        pending.secondFor === undefined ? null : JSON.stringify(pending.secondFor.firstOutput),
      ),
    ...pending.files.map((file, position) =>
      db
        .prepare('INSERT INTO model_staged_files (reading_id, position, path, kind, text) VALUES (?, ?, ?, ?, ?)')
        .bind(id, position, file.path, file.kind, file.text),
    ),
  ]);
  return id;
}

/**
 * Retires the repo's pending readings, as staging a newer one does, when a
 * weekly read finds docs it already read: one not sent goes, with its files,
 * and one sent stays, marked as replaced and without its files, so the
 * collector settles it and acts on nothing. So a reading of docs that are no
 * longer the repo's never decides.
 */
export async function retirePending(db: D1Database, repo: string): Promise<void> {
  const name = mustParse(repoName, repo, 'repo');
  await db.batch([
    db.prepare('DELETE FROM model_staged_files WHERE reading_id IN (SELECT id FROM model_pending WHERE repo = ?1)').bind(name),
    db.prepare('DELETE FROM model_pending WHERE repo = ?1 AND batch_id IS NULL').bind(name),
    db.prepare('UPDATE model_pending SET replaced = 1 WHERE repo = ?1').bind(name),
  ]);
}

/** A share's pending readings not in a batch, the one staged first first, at most `limit`. */
export async function listUnsent(db: D1Database, share: Share, limit: number): Promise<Pending[]> {
  const { results } = await db
    .prepare('SELECT * FROM model_pending WHERE batch_id IS NULL AND replaced = 0 AND share = ? ORDER BY staged_at, id LIMIT ?')
    .bind(shareOf(share), limit)
    .all<PendingRow>();
  return results.map(toPending);
}

/** How many pending readings wait to be sent. */
export async function countUnsent(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM model_pending WHERE batch_id IS NULL AND replaced = 0').first<number>('n')) ?? 0;
}

/** Every pending reading, for a test or the log. */
export async function listPending(db: D1Database): Promise<Pending[]> {
  const { results } = await db.prepare('SELECT * FROM model_pending ORDER BY staged_at, id').all<PendingRow>();
  return results.map(toPending);
}

/** The pending readings sent in a batch. */
export async function listPendingInBatch(db: D1Database, batchId: string): Promise<Pending[]> {
  const { results } = await db.prepare('SELECT * FROM model_pending WHERE batch_id = ?').bind(batchId).all<PendingRow>();
  return results.map(toPending);
}

/** The repo's pending reading that isn't replaced, or null. */
export async function getPendingFor(db: D1Database, repo: string): Promise<Pending | null> {
  const row = await db
    .prepare('SELECT * FROM model_pending WHERE repo = ? AND replaced = 0')
    .bind(mustParse(repoName, repo, 'repo'))
    .first<PendingRow>();
  return row === null ? null : toPending(row);
}

/** A pending reading's staged files, in the order the crawler read them. */
export async function stagedFiles(db: D1Database, readingId: string): Promise<PolicyFile[]> {
  const { results } = await db
    .prepare('SELECT path, kind, text FROM model_staged_files WHERE reading_id = ? ORDER BY position')
    .bind(readingId)
    .all<{ path: string; kind: string; text: string }>();
  return results.map((row) => ({ path: row.path, kind: row.kind as PolicyFileKind, text: row.text }));
}

/** Drops pending readings with their files. */
export async function dropPending(db: D1Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const list = JSON.stringify(ids);
  await db.batch([
    db.prepare('DELETE FROM model_staged_files WHERE reading_id IN (SELECT value FROM json_each(?))').bind(list),
    db.prepare('DELETE FROM model_pending WHERE id IN (SELECT value FROM json_each(?))').bind(list),
  ]);
}

/**
 * Records that a batch was sent with these readings, each with what it
 * reserved of the day, and adds the reservations to the day's spend.
 */
export async function markSent(
  db: D1Database,
  batch: { id: string; day: string; readings: readonly { id: string; share: Share; reservedUsd: number }[] },
  now: number,
): Promise<void> {
  const at = checkTime(now);
  await db.batch([
    db.prepare('INSERT INTO model_batches (id, sent_at, requests) VALUES (?, ?, ?)').bind(batch.id, at, batch.readings.length),
    ...batch.readings.map((reading) =>
      db
        .prepare('UPDATE model_pending SET batch_id = ?, sent_at = ?, reserved_usd = ?, reserved_day = ? WHERE id = ?')
        .bind(batch.id, at, reading.reservedUsd, batch.day, reading.id),
    ),
    ...batch.readings.map((reading) => addSpend(db, batch.day, reading.share, { reserved: reading.reservedUsd })),
  ]);
}

/** The statement that adds to a day's spend and reservations for a share. */
function addSpend(db: D1Database, day: string, share: Share, change: { spent?: number; reserved?: number }): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO model_spend (day, share, spent_usd, reserved_usd) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (day, share) DO UPDATE SET spent_usd = spent_usd + ?3, reserved_usd = MAX(reserved_usd + ?4, 0)`,
    )
    .bind(day, share, change.spent ?? 0, change.reserved ?? 0);
}

/**
 * Settles what a pending reading reserved, to what it cost, on the day it
 * reserved it. With `retry`, it goes back to wait for a later batch, and
 * otherwise it goes, with its files.
 */
export async function settlePending(db: D1Database, pending: Pending, cost: number, { retry }: { retry: boolean }): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (pending.reservedDay !== null) statements.push(addSpend(db, pending.reservedDay, pending.share, { spent: cost, reserved: -pending.reservedUsd }));
  if (retry && !pending.replaced) {
    statements.push(
      db
        .prepare('UPDATE model_pending SET batch_id = NULL, sent_at = NULL, reserved_usd = 0, reserved_day = NULL WHERE id = ?')
        .bind(pending.id),
    );
  } else {
    statements.push(db.prepare('DELETE FROM model_staged_files WHERE reading_id = ?').bind(pending.id));
    statements.push(db.prepare('DELETE FROM model_pending WHERE id = ?').bind(pending.id));
  }
  await db.batch(statements);
}

/**
 * Settles what a reading cost, on the day it reserved it, and keeps it
 * pending as the label check for its find, with the model's policy reading,
 * to go in the next batch. Its staged files stay, so the check reads the
 * same statements, until the check is done.
 */
export async function awaitLabelCheck(db: D1Database, pending: Pending, cost: number, readingOutput: unknown): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (pending.reservedDay !== null) statements.push(addSpend(db, pending.reservedDay, pending.share, { spent: cost, reserved: -pending.reservedUsd }));
  statements.push(
    db
      .prepare(
        `UPDATE model_pending SET step = 'labels', reading_output = ?, batch_id = NULL, sent_at = NULL, reserved_usd = 0, reserved_day = NULL
         WHERE id = ?`,
      )
      .bind(JSON.stringify(readingOutput), pending.id),
  );
  await db.batch(statements);
}

/**
 * Settles what a reading cost, on the day it reserved it, and keeps it
 * pending as the second reading of the same staged files, for a pause, with
 * the model's first reading, to go in the next batch.
 */
export async function awaitSecondReading(db: D1Database, pending: Pending, cost: number, firstOutput: unknown): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (pending.reservedDay !== null) statements.push(addSpend(db, pending.reservedDay, pending.share, { spent: cost, reserved: -pending.reservedUsd }));
  statements.push(
    db
      .prepare('UPDATE model_pending SET first_output = ?, batch_id = NULL, sent_at = NULL, reserved_usd = 0, reserved_day = NULL WHERE id = ?')
      .bind(JSON.stringify(firstOutput), pending.id),
  );
  await db.batch(statements);
}

/**
 * Reserves `cost` from a share of a UTC day's budget, in one statement, so
 * two calls at once can't both take the last of it: only when what every
 * share used that day, with the cost, stays within `budget`, and what this
 * share used stays within `shareBudget`. True when it reserved it.
 */
export async function reserveSpend(
  db: D1Database,
  reservation: { day: string; share: Share; cost: number; budget: number; shareBudget: number },
): Promise<boolean> {
  const share = shareOf(reservation.share);
  const result = await db
    .prepare(
      `INSERT INTO model_spend (day, share, spent_usd, reserved_usd)
       SELECT ?1, ?2, 0, ?3
       WHERE (SELECT COALESCE(SUM(spent_usd + reserved_usd), 0) FROM model_spend WHERE day = ?1) + ?3 <= ?4
         AND (SELECT COALESCE(SUM(spent_usd + reserved_usd), 0) FROM model_spend WHERE day = ?1 AND share = ?2) + ?3 <= ?5
       ON CONFLICT (day, share) DO UPDATE SET reserved_usd = reserved_usd + excluded.reserved_usd`,
    )
    .bind(reservation.day, share, reservation.cost, reservation.budget, reservation.shareBudget)
    .run();
  return result.meta.changes === 1;
}

/** Settles a reservation made with reserveSpend, on the day it was made, to what the call cost. */
export async function settleSpend(db: D1Database, settled: { day: string; share: Share; reserved: number; spent: number }): Promise<void> {
  await addSpend(db, settled.day, shareOf(settled.share), { spent: settled.spent, reserved: -settled.reserved }).run();
}

/**
 * The pending readings that have waited since before `before` and aren't
 * waiting on a batch sent since `sentAfter`: the ones that kept failing.
 */
export async function listStale(db: D1Database, before: number, sentAfter: number): Promise<Pending[]> {
  const { results } = await db
    .prepare('SELECT * FROM model_pending WHERE staged_at < ? AND (batch_id IS NULL OR sent_at < ?) ORDER BY staged_at, id')
    .bind(checkTime(before), checkTime(sentAfter))
    .all<PendingRow>();
  return results.map(toPending);
}

// ---------------------------------------------------------------------------
// Batches in flight.

/** The batches sent and not yet collected, the oldest first. */
export async function listBatches(db: D1Database): Promise<{ id: string; sentAt: number; requests: number }[]> {
  const { results } = await db
    .prepare('SELECT id, sent_at, requests FROM model_batches ORDER BY sent_at, id')
    .all<{ id: string; sent_at: number; requests: number }>();
  return results.map((row) => ({ id: row.id, sentAt: row.sent_at, requests: row.requests }));
}

/** Forgets a batch once its results are collected. */
export async function dropBatch(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM model_batches WHERE id = ?').bind(id).run();
}

// ---------------------------------------------------------------------------
// The day's spend.

/** What each share spent and reserved on a UTC day. */
export async function dayUse(db: D1Database, day: string): Promise<DayUse> {
  const { results } = await db
    .prepare('SELECT share, spent_usd, reserved_usd FROM model_spend WHERE day = ?')
    .bind(day)
    .all<{ share: string; spent_usd: number; reserved_usd: number }>();
  const use = noUse();
  for (const row of results) {
    if (isShare(row.share)) use[row.share] += row.spent_usd + row.reserved_usd;
  }
  return use;
}

/** What the model spent on a UTC day, with what is reserved, for a test or the log. */
export async function daySpend(db: D1Database, day: string): Promise<{ spent: number; reserved: number }> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(spent_usd), 0) AS spent, COALESCE(SUM(reserved_usd), 0) AS reserved FROM model_spend WHERE day = ?')
    .bind(day)
    .first<{ spent: number; reserved: number }>();
  return { spent: row?.spent ?? 0, reserved: row?.reserved ?? 0 };
}

// ---------------------------------------------------------------------------
// State between runs.

export async function getReaderState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM model_reader_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setReaderState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO model_reader_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2')
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------------------
// A listed project's weekly reads, as the model reads them.

export interface ModelRead {
  docsHash: DocsHash | null;
  readerVersion: string | null;
  fingerprint: string | null;
  banned: boolean | null;
  noVerdicts: number;
  noVerdictsReported: boolean;
  /** Whether the last reading was kept while the model decided, or in shadow, as for every one kept before. */
  readIn: 'shadow' | 'model';
}

/** Where the model stands with a listed project's weekly reads, or null before the crawler first queued it. */
export async function getModelRead(db: D1Database, project: string): Promise<ModelRead | null> {
  const row = await db
    .prepare(
      `SELECT docs_hash, reader_version, model_fingerprint, model_banned, model_no_verdicts, model_no_verdicts_reported, model_read_in
       FROM policy_reads WHERE project = ?`,
    )
    .bind(mustParse(repoName, project, 'project'))
    .first<{
      docs_hash: string | null;
      reader_version: string | null;
      model_fingerprint: string | null;
      model_banned: number | null;
      model_no_verdicts: number;
      model_no_verdicts_reported: number;
      model_read_in: string | null;
    }>();
  if (row === null) return null;
  return {
    docsHash: row.docs_hash === null ? null : mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
    readerVersion: row.reader_version,
    fingerprint: row.model_fingerprint,
    banned: row.model_banned === null ? null : row.model_banned === 1,
    noVerdicts: row.model_no_verdicts,
    noVerdictsReported: row.model_no_verdicts_reported === 1,
    readIn: row.model_read_in === 'model' ? 'model' : 'shadow',
  };
}

/**
 * Keeps a model reading of a listed project's docs that counted, and starts
 * the count of no verdicts over. `readIn` says whether the model decided
 * when it was read, or read in shadow.
 */
export async function keepModelRead(
  db: D1Database,
  project: string,
  read: { docsHash: DocsHash; readerVersion: string; fingerprint: string; banned: boolean; readIn: 'shadow' | 'model' },
): Promise<void> {
  await db
    .prepare(
      `UPDATE policy_reads SET docs_hash = ?2, reader_version = ?3, model_fingerprint = ?4, model_banned = ?5,
         model_no_verdicts = 0, model_no_verdicts_reported = 0, model_read_in = ?6
       WHERE project = ?1`,
    )
    .bind(mustParse(repoName, project, 'project'), read.docsHash, read.readerVersion, read.fingerprint, read.banned ? 1 : 0, read.readIn)
    .run();
}

/**
 * At a listed project's first weekly read with the model deciding, makes
 * the last verdict that was acted on, the rules', the model's last read: its
 * fingerprint, which compares with no model reading, and whether it read a
 * ban. The docs hash goes, so the model reads, or uses its kept reading,
 * and decides. Nothing the model read in shadow carries over.
 */
export async function adoptRulesRead(db: D1Database, project: string, read: { fingerprint: string | null; banned: boolean | null }): Promise<void> {
  await db
    .prepare(
      `UPDATE policy_reads SET docs_hash = NULL, reader_version = NULL, model_fingerprint = ?2, model_banned = ?3,
         model_no_verdicts = 0, model_no_verdicts_reported = 0, model_read_in = 'model'
       WHERE project = ?1`,
    )
    .bind(mustParse(repoName, project, 'project'), read.fingerprint, read.banned === null ? null : read.banned ? 1 : 0)
    .run();
}

/**
 * The listed projects whose last model reading was kept in shadow, each with
 * the model's kept reading of its docs, if any, and whether the rules' last
 * read was a ban, for the list of what the switch to the model would pause.
 */
export async function listShadowReads(
  db: D1Database,
): Promise<{ project: string; source: string; status: string; rulesBanned: boolean | null; reading: ModelReading | null; docsMatch: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.repo, p.source, p.status, r.banned, m.reading, (m.docs_hash IS NOT NULL AND m.docs_hash = r.docs_hash) AS docs_match
       FROM projects p
       JOIN policy_reads r ON r.project = p.repo
       LEFT JOIN model_readings m ON m.repo = p.repo
       WHERE p.status IN ('approved', 'paused') AND (r.model_read_in IS NULL OR r.model_read_in = 'shadow')
       ORDER BY p.repo`,
    )
    .all<{ repo: string; source: string; status: string; banned: number | null; reading: string | null; docs_match: number }>();
  return results.map((row) => ({
    project: mustParse(repoName, row.repo, 'project'),
    source: row.source,
    status: row.status,
    rulesBanned: row.banned === null ? null : row.banned === 1,
    reading: row.reading === null ? null : mustParse(modelReadingSchema, fromJson(row.reading), 'reading'),
    docsMatch: row.docs_match === 1,
  }));
}

// ---------------------------------------------------------------------------
// register_project's label checks.

/** The tags a label check gave for this key, or null when none was kept. */
export async function getRegisterLabelCheck(db: D1Database, key: string): Promise<string[] | null> {
  const row = await db.prepare('SELECT tags FROM register_label_checks WHERE key = ?').bind(key).first<{ tags: string }>();
  if (row === null) return null;
  const tags = fromJson(row.tags);
  return Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? tags : null;
}

/** Keeps the tags a label check gave, by its key. */
export async function keepRegisterLabelCheck(db: D1Database, check: { key: string; repo: string; tags: readonly string[] }, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO register_label_checks (key, repo, tags, checked_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET tags = ?3, checked_at = ?4`,
    )
    .bind(check.key, mustParse(repoName, check.repo, 'repo'), JSON.stringify(check.tags), checkTime(now))
    .run();
}

/**
 * Counts one label check for the caller and the repo on a UTC day, in one
 * statement, only when the caller made fewer than `perCaller` that day and
 * the repo had fewer than `perRepo`. True when it counted it.
 */
export async function countRegisterLabelCheck(
  db: D1Database,
  use: { day: string; caller: number; repo: string; perCaller: number; perRepo: number },
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO register_label_uses (id, day, caller, repo, at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM register_label_uses WHERE day = ?2 AND caller = ?3) < ?6
         AND (SELECT COUNT(*) FROM register_label_uses WHERE day = ?2 AND repo = ?4) < ?7`,
    )
    .bind(newId('rlc'), use.day, use.caller, mustParse(repoName, use.repo, 'repo'), checkTime(now), use.perCaller, use.perRepo)
    .run();
  return result.meta.changes === 1;
}

/** Counts one more weekly read in a row with no verdict from the model, and returns the count and whether it was reported. */
export async function countNoVerdict(db: D1Database, project: string): Promise<{ count: number; reported: boolean }> {
  const row = await db
    .prepare(
      `UPDATE policy_reads SET model_no_verdicts = model_no_verdicts + 1 WHERE project = ?
       RETURNING model_no_verdicts, model_no_verdicts_reported`,
    )
    .bind(mustParse(repoName, project, 'project'))
    .first<{ model_no_verdicts: number; model_no_verdicts_reported: number }>();
  return { count: row?.model_no_verdicts ?? 0, reported: row?.model_no_verdicts_reported === 1 };
}

/** Records that a run of no verdicts was reported, so it is reported once. */
export async function markNoVerdictsReported(db: D1Database, project: string): Promise<void> {
  await db
    .prepare('UPDATE policy_reads SET model_no_verdicts_reported = 1 WHERE project = ?')
    .bind(mustParse(repoName, project, 'project'))
    .run();
}
