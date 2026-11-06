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
}

interface ReadingRow {
  repo: string;
  docs_hash: string;
  reader_version: string;
  reading: string;
  fingerprint: string;
  read_at: number;
}

function toKept(row: ReadingRow): KeptReading {
  return {
    repo: mustParse(repoName, row.repo, 'repo'),
    docsHash: mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
    readerVersion: row.reader_version,
    reading: mustParse(modelReadingSchema, fromJson(row.reading), 'reading'),
    fingerprint: mustParse(policyFingerprintSchema, row.fingerprint, 'fingerprint'),
    readAt: row.read_at,
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
  read: { repo: string; reading: ModelReading; fingerprint: string },
  now: number,
): Promise<void> {
  const reading = mustParse(modelReadingSchema, read.reading, 'reading');
  await db
    .prepare(
      `INSERT INTO model_readings (repo, docs_hash, reader_version, reading, fingerprint, read_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (repo) DO UPDATE SET docs_hash = ?2, reader_version = ?3, reading = ?4, fingerprint = ?5, read_at = ?6`,
    )
    .bind(
      mustParse(repoName, read.repo, 'repo'),
      reading.docsHash,
      reading.readerVersion,
      JSON.stringify(reading),
      mustParse(policyFingerprintSchema, read.fingerprint, 'fingerprint'),
      checkTime(now),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Pending readings and their staged files.

export type ReadingPurpose = 'seed' | 'reread';

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
}

export interface Pending extends Omit<NewPending, 'files'> {
  id: string;
  stagedAt: number;
  batchId: string | null;
  sentAt: number | null;
  reservedUsd: number;
  reservedDay: string | null;
  /** True when a newer reading of the repo was staged after this one was sent. */
  replaced: boolean;
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
}

/** Labels as they were staged, or a throw for a row in another form. */
function labelsOf(value: unknown): RepoLabel[] {
  if (!Array.isArray(value)) throw new TypeError('labels must be a list');
  return value.map((label: unknown) => {
    const { name, openIssues } = (label ?? {}) as { name?: unknown; openIssues?: unknown };
    if (typeof name !== 'string' || typeof openIssues !== 'number' || !Number.isInteger(openIssues) || openIssues < 0) {
      throw new TypeError('each label must have a name and an open issue count');
    }
    return { name, openIssues };
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
        `INSERT INTO model_pending (id, repo, purpose, share, docs_hash, rules_tier, commit_sha, branch, facts, vouch, labels, staged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
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
      ),
    ...pending.files.map((file, position) =>
      db
        .prepare('INSERT INTO model_staged_files (reading_id, position, path, kind, text) VALUES (?, ?, ?, ?, ?)')
        .bind(id, position, file.path, file.kind, file.text),
    ),
  ]);
  return id;
}

/** The pending readings not in a batch, the one staged first first, at most `limit`. */
export async function listUnsent(db: D1Database, limit: number): Promise<Pending[]> {
  const { results } = await db
    .prepare('SELECT * FROM model_pending WHERE batch_id IS NULL AND replaced = 0 ORDER BY staged_at, id LIMIT ?')
    .bind(limit)
    .all<PendingRow>();
  return results.map(toPending);
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
}

/** Where the model stands with a listed project's weekly reads, or null before the crawler first queued it. */
export async function getModelRead(db: D1Database, project: string): Promise<ModelRead | null> {
  const row = await db
    .prepare(
      `SELECT docs_hash, reader_version, model_fingerprint, model_banned, model_no_verdicts, model_no_verdicts_reported
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
    }>();
  if (row === null) return null;
  return {
    docsHash: row.docs_hash === null ? null : mustParse(docsHashSchema, row.docs_hash, 'docsHash'),
    readerVersion: row.reader_version,
    fingerprint: row.model_fingerprint,
    banned: row.model_banned === null ? null : row.model_banned === 1,
    noVerdicts: row.model_no_verdicts,
    noVerdictsReported: row.model_no_verdicts_reported === 1,
  };
}

/** Keeps a model reading of a listed project's docs that counted, and starts the count of no verdicts over. */
export async function keepModelRead(
  db: D1Database,
  project: string,
  read: { docsHash: DocsHash; readerVersion: string; fingerprint: string; banned: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE policy_reads SET docs_hash = ?2, reader_version = ?3, model_fingerprint = ?4, model_banned = ?5,
         model_no_verdicts = 0, model_no_verdicts_reported = 0
       WHERE project = ?1`,
    )
    .bind(mustParse(repoName, project, 'project'), read.docsHash, read.readerVersion, read.fingerprint, read.banned ? 1 : 0)
    .run();
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
