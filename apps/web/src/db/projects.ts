import {
  changedSettings,
  count,
  githubId,
  issueSyncSchema,
  mustParse,
  policySchema,
  projectRecordSchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusChangeSchema,
  projectStatusSchema,
  repoName,
  settingsVersionSchema,
  taggedIssueSchema,
  updateProjectSettings,
  type FieldProblem,
  type Policy,
  type ProjectRecord,
  type ProjectSettings,
  type ProjectSettingsInput,
  type ProjectSettingsPatch,
  type ProjectSource,
  type ProjectStatus,
  type ProjectStatusChange,
  type SettingKey,
  type SettingsVersion,
  type TaggedIssue,
} from '@goodfirsttoken/core';
import { getDoNotListEntry } from './do-not-list';
import { checkTime, fromJson, joinIssue } from './shared';
import { ASKING_FOR_HELP, DELISTED, ON_THE_DO_NOT_LIST, slotsTaken, takesClaims, waiting } from './waiting';

// The projects, project_settings, and project_status_changes tables. A
// project's row holds its current status and points at its current
// settings. Every save of its settings and every change of its status is
// kept, with who made it and when.

interface ProjectRow {
  repo: string;
  issue_repo: string;
  status: string;
  status_reason: string | null;
  status_changed_by: number | null;
  status_changed_at: number;
  source: string;
  policy_quote: string | null;
  policy_url: string | null;
  policy_tier: string | null;
  added_by: number;
  added_at: number;
  settings_version: number;
  /** From the current row of project_settings. */
  settings: string;
}

interface StatusChangeRow {
  id: number;
  repo: string;
  status: string;
  reason: string | null;
  changed_by: number | null;
  changed_at: number;
}

interface SettingsRow {
  repo: string;
  version: number;
  settings: string;
  changed_by: number;
  changed_at: number;
}

const delistedReason = issueSyncSchema.shape.delisted.unwrap();

const SELECT_PROJECT = `
  SELECT p.*, s.settings FROM projects p
  JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version`;

function toProject(row: ProjectRow): ProjectRecord {
  const policy =
    row.policy_quote === null && row.policy_url === null && row.policy_tier === null
      ? null
      : { quote: row.policy_quote, url: row.policy_url, tier: row.policy_tier };
  return mustParse(
    projectRecordSchema,
    {
      repo: row.repo,
      status: row.status,
      statusReason: row.status_reason,
      statusChangedBy: row.status_changed_by,
      statusChangedAt: row.status_changed_at,
      source: row.source,
      policy,
      addedBy: row.added_by,
      addedAt: row.added_at,
      settings: fromJson(row.settings),
      settingsVersion: row.settings_version,
    },
    'project',
  );
}

/** Where a project's tagged issues live. */
function issueRepoOf(repo: string, settings: ProjectSettings): string {
  return settings.issueRepo ?? repo;
}

export interface NewProject {
  repo: string;
  /** `pending` for a registration, `approved` for a project an admin lists. */
  status: ProjectStatus;
  source: ProjectSource;
  /** The policy it was listed from, or null for a registered project. */
  policy: Policy | null;
  /** Settings left out take their defaults. */
  settings: ProjectSettingsInput;
  /** The maintainer who registered it, or the admin who listed it. */
  addedBy: number;
}

/**
 * Saves a new project, the first version of its settings, and its first
 * status, all made by `addedBy` at `now`. Null when the repo is already a
 * project, in any case, since GitHub ignores case in repo names, and when a
 * project listed from its policy would be for a repo on the do-not-list,
 * checked in the same statement as the insert. A maintainer's registration
 * of a repo on the list is saved, and the repo stays on it until an admin
 * approves the registration.
 */
export async function createProject(
  db: D1Database,
  project: NewProject,
  now: number,
): Promise<ProjectRecord | null> {
  const record = mustParse(
    projectRecordSchema,
    {
      repo: project.repo,
      status: mustParse(projectStatusSchema, project.status, 'status'),
      statusReason: null,
      statusChangedBy: project.addedBy,
      statusChangedAt: now,
      source: mustParse(projectSourceSchema, project.source, 'source'),
      policy: project.policy === null ? null : mustParse(policySchema, project.policy, 'policy'),
      addedBy: project.addedBy,
      addedAt: checkTime(now),
      settings: mustParse(projectSettingsSchema, project.settings, 'settings'),
      settingsVersion: 1,
    },
    'project',
  );
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO projects (repo, issue_repo, status, status_reason, status_changed_by, status_changed_at,
           source, policy_quote, policy_url, policy_tier, added_by, added_at, settings_version)
         SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1
         WHERE ?6 = 'registered' OR NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        record.repo,
        issueRepoOf(record.repo, record.settings),
        record.status,
        record.statusChangedBy,
        record.statusChangedAt,
        record.source,
        record.policy?.quote ?? null,
        record.policy?.url ?? null,
        record.policy?.tier ?? null,
        record.addedBy,
        record.addedAt,
      ),
    // A project that already existed has its first settings. A listing the
    // do-not-list kept out has no row, so these add nothing for it.
    db
      .prepare(
        `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
         SELECT ?1, 1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM projects WHERE repo = ?1)
         ON CONFLICT DO NOTHING`,
      )
      .bind(record.repo, JSON.stringify(record.settings), record.addedBy, record.addedAt),
    // A project that already existed has status changes, so this adds none.
    db
      .prepare(
        `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
         SELECT ?1, ?2, NULL, ?3, ?4
         WHERE NOT EXISTS (SELECT 1 FROM project_status_changes WHERE repo = ?1)
           AND EXISTS (SELECT 1 FROM projects WHERE repo = ?1)`,
      )
      .bind(record.repo, record.status, record.addedBy, record.addedAt),
  ]);
  return inserted?.meta.changes === 1 ? record : null;
}

/** The project whose code repo is `repo`, compared without case, or null. */
export async function getProject(db: D1Database, repo: string): Promise<ProjectRecord | null> {
  const row = await db
    .prepare(`${SELECT_PROJECT} WHERE p.repo = ?`)
    .bind(mustParse(repoName, repo, 'repo'))
    .first<ProjectRow>();
  return row === null ? null : toProject(row);
}

/** Every project with `status`, oldest first. */
export async function listProjects(db: D1Database, status: ProjectStatus): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(`${SELECT_PROJECT} WHERE p.status = ? ORDER BY p.added_at, p.repo`)
    .bind(mustParse(projectStatusSchema, status, 'status'))
    .all<ProjectRow>();
  return results.map(toProject);
}

/** A project asking for help, with how many of its tagged issues wait for an agent. */
export interface ProjectAskingForHelp {
  project: ProjectRecord;
  /**
   * Its cached issues a new agent could claim now: they carry one of its
   * tags and none of its excluded tags, have no open PR, and have fewer
   * claims holding a slot than its claims per issue.
   */
  waiting: number;
}

/**
 * The projects asking for help at `now`: every approved project, paused
 * ones left out, and any whose repo or issue repo is on the do-not-list.
 * The ones with the most issues waiting for an agent come first, then the
 * most recently added, then by repo. `total` is how many there are, and
 * `projects` the first `limit` of them.
 */
export async function listProjectsAskingForHelp(
  db: D1Database,
  limit: number,
  now: number,
): Promise<{ total: number; projects: ProjectAskingForHelp[] }> {
  // Which projects ask for help, and which of their issues wait for an
  // agent, is one rule in ./waiting.ts, which every list of them follows.
  const { results } = await db
    .prepare(
      `SELECT p.*, s.settings, COUNT(*) OVER () AS total,
         (SELECT COUNT(*) FROM tagged_issues t WHERE t.project = p.repo AND ${waiting('?2')}) AS waiting
       FROM projects p
       JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version
       WHERE ${ASKING_FOR_HELP}
       ORDER BY waiting DESC, p.added_at DESC, p.repo
       LIMIT ?1`,
    )
    .bind(mustParse(count, limit, 'limit'), checkTime(now))
    .all<ProjectRow & { total: number; waiting: number }>();
  return {
    total: mustParse(count, results[0]?.total ?? 0, 'total'),
    projects: results.map((row) => ({ project: toProject(row), waiting: mustParse(count, row.waiting, 'waiting') })),
  };
}

/** An issue waiting for an agent, with its project, for suggestions. */
export interface WaitingIssue {
  project: ProjectRecord;
  /** The project's cached copy of the issue. */
  copy: TaggedIssue;
  /** Claims on the issue holding a slot now. */
  holding: number;
  /** The main language of the project's code repo as the sync last read it, or null. */
  language: string | null;
}

/**
 * Every cached issue waiting for an agent at `now`, in every project asking
 * for help, by the rule in ./waiting.ts that the homepage counts with: the
 * oldest project first, then by issue. Two projects that keep issues in one
 * repo each list their own copy.
 */
export async function listWaitingIssues(db: D1Database, now: number): Promise<WaitingIssue[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, s.settings, t.issue_repo AS copy_repo, t.number AS copy_number, t.title AS copy_title,
         t.labels AS copy_labels, t.synced_at AS copy_synced_at, ${slotsTaken('?1')} AS holding, y.language AS language
       FROM projects p
       JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version
       JOIN tagged_issues t ON t.project = p.repo
       LEFT JOIN issue_syncs y ON y.project = p.repo
       WHERE ${takesClaims('?1')}
       ORDER BY p.added_at, p.repo, t.issue_repo, t.number`,
    )
    .bind(checkTime(now))
    .all<
      ProjectRow & {
        copy_repo: string;
        copy_number: number;
        copy_title: string;
        copy_labels: string;
        copy_synced_at: number;
        holding: number;
        language: string | null;
      }
    >();
  return results.map((row) => {
    const project = toProject(row);
    return {
      project,
      copy: mustParse(
        taggedIssueSchema,
        {
          issue: joinIssue(row.copy_repo, row.copy_number),
          project: project.repo,
          title: row.copy_title,
          labels: fromJson(row.copy_labels),
          linkedPr: null,
          syncedAt: row.copy_synced_at,
        },
        'issue',
      ),
      holding: mustParse(count, row.holding, 'holding'),
      language: row.language,
    };
  });
}

/**
 * Who saved version `version` of a project's settings, by GitHub ID, and
 * when, or null when there is no such save.
 */
export async function getSettingsSave(
  db: D1Database,
  repo: string,
  version: number,
): Promise<{ changedBy: number; changedAt: number } | null> {
  const row = await db
    .prepare('SELECT changed_by, changed_at FROM project_settings WHERE repo = ? AND version = ?')
    .bind(mustParse(repoName, repo, 'repo'), mustParse(count, version, 'version'))
    .first<{ changed_by: number; changed_at: number }>();
  if (row === null) return null;
  return { changedBy: mustParse(githubId, row.changed_by, 'changedBy'), changedAt: checkTime(row.changed_at, 'changedAt') };
}

/** Whether the project asks for help now, by the rule in ./waiting.ts: approved, and off the do-not-list. */
export async function isAskingForHelp(db: D1Database, repo: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS yes FROM projects p WHERE p.repo = ? AND ${ASKING_FOR_HELP}`)
    .bind(mustParse(repoName, repo, 'repo'))
    .first<{ yes: number }>();
  return row !== null;
}

/**
 * Which of these projects are on the do-not-list, by the rule in
 * ./waiting.ts, each in lower case. The repos go in as one JSON array, so any
 * number of them takes one query.
 */
export async function doNotListedProjects(db: D1Database, repos: Iterable<string>): Promise<Set<string>> {
  const names = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (names.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT p.repo FROM projects p WHERE p.repo IN (SELECT value FROM json_each(?1)) AND ${ON_THE_DO_NOT_LIST}`)
    .bind(JSON.stringify(names))
    .all<{ repo: string }>();
  return new Set(results.map((row) => row.repo.toLowerCase()));
}

/**
 * Which of these projects the sync delisted, by the rule in ./waiting.ts,
 * each in lower case, with the reason GitHub gave, like
 * `sample-owner/app is archived on GitHub.` The repos go in as one JSON
 * array, so any number of them takes one query.
 */
export async function delistedProjects(db: D1Database, repos: Iterable<string>): Promise<Map<string, string>> {
  const names = [...new Set([...repos].map((repo) => mustParse(repoName, repo, 'repo').toLowerCase()))];
  if (names.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT p.repo, (SELECT y.delisted FROM issue_syncs y WHERE y.project = p.repo) AS delisted
       FROM projects p WHERE p.repo IN (SELECT value FROM json_each(?1)) AND ${DELISTED}`,
    )
    .bind(JSON.stringify(names))
    .all<{ repo: string; delisted: string }>();
  return new Map(results.map((row) => [row.repo.toLowerCase(), mustParse(delistedReason, row.delisted, 'delisted')]));
}

/** Every project whose tagged issues live in `issueRepo`, whatever its status. */
export async function listProjectsByIssueRepo(db: D1Database, issueRepo: string): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(`${SELECT_PROJECT} WHERE p.issue_repo = ? ORDER BY p.added_at, p.repo`)
    .bind(mustParse(repoName, issueRepo, 'issueRepo'))
    .all<ProjectRow>();
  return results.map(toProject);
}

/**
 * Sets a project's status and the reason for it, as changed by `changedBy` at
 * `now`. `changedBy` is null only for a pause Good First Token makes on its
 * own. An approval or rejection always names the admin who made it. A
 * rejection needs a reason, and pending or approved takes none. Each change is
 * kept. A change to the status and reason the project already has changes
 * nothing. Null when there's no such project.
 */
export async function setProjectStatus(
  db: D1Database,
  repo: string,
  change: { status: ProjectStatus; reason: string | null; changedBy: number | null },
  now: number,
): Promise<ProjectRecord | null> {
  const current = await getProject(db, repo);
  if (current === null) return null;
  const next = mustParse(
    projectStatusChangeSchema,
    { repo: current.repo, status: change.status, reason: change.reason, changedBy: change.changedBy, changedAt: now },
    'status change',
  );
  // One transaction. The history row and the update each apply only when
  // the status or reason differs from what is stored, and the project
  // returned is the one stored.
  const [, , stored] = await db.batch<ProjectRow>([
    db
      .prepare(
        `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM projects WHERE repo = ?1 AND status = ?2 AND status_reason IS ?3)`,
      )
      .bind(next.repo, next.status, next.reason, next.changedBy, next.changedAt),
    db
      .prepare(
        `UPDATE projects SET status = ?2, status_reason = ?3, status_changed_by = ?4, status_changed_at = ?5
         WHERE repo = ?1 AND NOT (status = ?2 AND status_reason IS ?3)`,
      )
      .bind(next.repo, next.status, next.reason, next.changedBy, next.changedAt),
    db.prepare(`${SELECT_PROJECT} WHERE p.repo = ?`).bind(next.repo),
  ]);
  const row = stored?.results[0];
  return row === undefined ? null : toProject(row);
}

/**
 * Sets a project's status as setProjectStatus does, but only while its
 * status is still the one in `read`: the same status, reason, who set it, and
 * when. So a change decided on what was read never lands over a change
 * someone made since. The project after the change, or null when its status
 * changed since the read or the project is gone. A change to the status and
 * reason it already has, by the person who set them, writes nothing and
 * returns `read`. The same status and reason from someone else is a change of
 * its own, so an admin's pause over a maintainer's names the admin.
 * `alongside` runs in the same transaction, after the change, for a write
 * that has to land with it, and checks for itself that the change landed. A
 * change that writes nothing, as above, runs nothing, `alongside` included.
 */
export async function setProjectStatusFrom(
  db: D1Database,
  read: ProjectRecord,
  change: { status: ProjectStatus; reason: string | null; changedBy: number | null },
  now: number,
  alongside: D1PreparedStatement[] = [],
): Promise<ProjectRecord | null> {
  const was = mustParse(projectRecordSchema, read, 'read');
  const next = mustParse(
    projectStatusChangeSchema,
    { repo: was.repo, status: change.status, reason: change.reason, changedBy: change.changedBy, changedAt: now },
    'status change',
  );
  if (next.status === was.status && next.reason === was.statusReason && next.changedBy === was.statusChangedBy) {
    return was;
  }
  const unchanged = `repo = ?1 AND status = ?6 AND status_reason IS ?7 AND status_changed_by IS ?8
    AND status_changed_at = ?9`;
  const values = [
    next.repo,
    next.status,
    next.reason,
    next.changedBy,
    next.changedAt,
    was.status,
    was.statusReason,
    was.statusChangedBy,
    was.statusChangedAt,
  ];
  // One transaction. The history row and the update each apply only while
  // the status is the one read.
  const results = await db.batch<ProjectRow>([
    db
      .prepare(
        `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE ${unchanged})`,
      )
      .bind(...values),
    db
      .prepare(
        `UPDATE projects SET status = ?2, status_reason = ?3, status_changed_by = ?4, status_changed_at = ?5
         WHERE ${unchanged}`,
      )
      .bind(...values),
    ...alongside,
    db.prepare(`${SELECT_PROJECT} WHERE p.repo = ?`).bind(next.repo),
  ]);
  const updated = results[1];
  const row = results.at(-1)?.results[0];
  return updated?.meta.changes === 1 && row !== undefined ? toProject(row) : null;
}

/** Every change of a project's status, newest first, with who made it and when. */
export async function statusHistory(db: D1Database, repo: string): Promise<ProjectStatusChange[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_status_changes WHERE repo = ? ORDER BY id DESC')
    .bind(mustParse(repoName, repo, 'repo'))
    .all<StatusChangeRow>();
  return results.map((row) =>
    mustParse(
      projectStatusChangeSchema,
      {
        repo: row.repo,
        status: row.status,
        reason: row.reason,
        changedBy: row.changed_by,
        changedAt: row.changed_at,
      },
      'status change',
    ),
  );
}

export type SettingsChange =
  | { ok: true; project: ProjectRecord; changed: SettingKey[] }
  | { ok: false; problems: FieldProblem[] };

/** How many times a save is tried when other saves keep landing first. */
const SAVE_ATTEMPTS = 5;

/**
 * Applies a change to some of a project's settings, checks the result as a
 * whole, and saves it as a new version with who made it and when. The
 * change applies to the settings as they are when it saves, so two
 * maintainers changing different settings at once both keep their change.
 * A change that changes nothing saves nothing. Null when there's no such
 * project.
 */
export async function changeSettings(
  db: D1Database,
  repo: string,
  patch: ProjectSettingsPatch,
  changedBy: number,
  now: number,
): Promise<SettingsChange | null> {
  const by = mustParse(githubId, changedBy, 'changedBy');
  const at = checkTime(now);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const current = await getProject(db, repo);
    if (current === null) return null;
    const result = updateProjectSettings(current.settings, patch);
    if (!result.ok) return result;
    const settings = result.value;
    const changed = changedSettings(current.settings, settings);
    if (changed.length === 0) return { ok: true, project: current, changed };

    const version = current.settingsVersion + 1;
    // Both statements check that no other save landed since the read. The
    // batch runs as one transaction, so they both apply or neither does.
    const [, updated] = await db.batch([
      db
        .prepare(
          `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
           SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS
             (SELECT 1 FROM projects WHERE repo = ?1 AND settings_version = ?6)`,
        )
        .bind(current.repo, version, JSON.stringify(settings), by, at, current.settingsVersion),
      db
        .prepare(
          'UPDATE projects SET settings_version = ?, issue_repo = ? WHERE repo = ? AND settings_version = ?',
        )
        .bind(version, issueRepoOf(current.repo, settings), current.repo, current.settingsVersion),
    ]);
    if (updated?.meta.changes === 1) {
      return { ok: true, project: { ...current, settings, settingsVersion: version }, changed };
    }
  }
  throw new Error(`Settings for ${repo} changed ${String(SAVE_ATTEMPTS)} times during one save.`);
}

/**
 * A maintainer registers a repo an admin listed from its AI policy. Their
 * settings replace the listing's, saved as a new version by `by` at `now`,
 * with settings they left out at their defaults. The project becomes
 * registered: its policy goes, and it names them as who added it. It keeps
 * the time it was listed, since it has been listed since then. Its status
 * stays as it was, except that a rejected listing goes back to `pending`,
 * changed by them, so an admin reviews it again. Settings the same as the
 * listing's save no new version. Null when the repo isn't a project listed
 * from its policy when it saves.
 */
export async function takeOverListing(
  db: D1Database,
  repo: string,
  settings: ProjectSettingsInput,
  by: number,
  now: number,
): Promise<{ project: ProjectRecord; changed: SettingKey[] } | null> {
  const next = mustParse(projectSettingsSchema, settings, 'settings');
  const addedBy = mustParse(githubId, by, 'by');
  const at = checkTime(now);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const current = await getProject(db, repo);
    if (current?.source !== 'policy') return null;
    const changed = changedSettings(current.settings, next);
    const version = changed.length > 0 ? current.settingsVersion + 1 : current.settingsVersion;
    const reopened = current.status === 'rejected';
    const status = reopened
      ? { status: 'pending' as const, statusReason: null, statusChangedBy: addedBy, statusChangedAt: at }
      : {};
    const project = mustParse(
      projectRecordSchema,
      {
        ...current,
        ...status,
        source: 'registered',
        policy: null,
        addedBy,
        settings: next,
        settingsVersion: version,
      },
      'project',
    );
    // Every statement checks that the project is still the listing that was
    // read, with no other save or status change since, and the batch runs as
    // one transaction. The update runs last, since it changes what they check.
    const listing = `repo = ?1 AND source = 'policy' AND settings_version = ?2 AND status = ?3
      AND status_reason IS ?4 AND status_changed_at = ?5`;
    const read = [current.repo, current.settingsVersion, current.status, current.statusReason, current.statusChangedAt];
    const statements: D1PreparedStatement[] = [];
    if (changed.length > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
             SELECT ?1, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM projects WHERE ${listing})`,
          )
          .bind(...read, version, JSON.stringify(next), addedBy, at),
      );
    }
    if (reopened) {
      statements.push(
        db
          .prepare(
            `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
             SELECT ?1, 'pending', NULL, ?6, ?7 WHERE EXISTS (SELECT 1 FROM projects WHERE ${listing})`,
          )
          .bind(...read, addedBy, at),
      );
    }
    // The status columns change only for a rejected listing going back to
    // pending. Every other takeover leaves them to whoever sets the status.
    const reopen = reopened
      ? `, status = 'pending', status_reason = NULL, status_changed_by = ?6, status_changed_at = ?9`
      : '';
    statements.push(
      db
        .prepare(
          `UPDATE projects SET source = 'registered', policy_quote = NULL, policy_url = NULL, policy_tier = NULL,
             added_by = ?6, settings_version = ?7, issue_repo = ?8${reopen}
           WHERE ${listing}`,
        )
        .bind(...read, addedBy, version, issueRepoOf(current.repo, next), ...(reopened ? [at] : [])),
    );
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes === 1) return { project, changed };
  }
  throw new Error(`${repo} changed ${String(SAVE_ATTEMPTS)} times during one save.`);
}

/** Every save of a project's settings, newest first, each with what it changed. */
export async function settingsHistory(db: D1Database, repo: string): Promise<SettingsVersion[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_settings WHERE repo = ? ORDER BY version')
    .bind(mustParse(repoName, repo, 'repo'))
    .all<SettingsRow>();
  let before: ProjectSettings | null = null;
  const history: SettingsVersion[] = [];
  for (const row of results) {
    const settings = mustParse(projectSettingsSchema, fromJson(row.settings), 'settings');
    history.push(
      mustParse(
        settingsVersionSchema,
        {
          repo: row.repo,
          version: row.version,
          settings,
          changed: changedSettings(before, settings),
          changedBy: row.changed_by,
          changedAt: row.changed_at,
        },
        'settings version',
      ),
    );
    before = settings;
  }
  return history.reverse();
}

/** A project waiting for an admin, with the ID of the status change that put it in the queue. */
export interface PendingProject {
  project: ProjectRecord;
  /** The project's latest status change, which made it pending. */
  changeId: number;
}

/**
 * Every pending project, the one that has waited longest first, each with
 * the ID of the status change that made it pending. A new status change
 * gives it a new ID, so an ID names one wait in the queue.
 */
export async function listPendingProjects(db: D1Database): Promise<PendingProject[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, s.settings,
         (SELECT MAX(c.id) FROM project_status_changes c WHERE c.repo = p.repo) AS change_id
       FROM projects p
       JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version
       WHERE p.status = 'pending'
       ORDER BY p.status_changed_at, p.repo`,
    )
    .all<ProjectRow & { change_id: number }>();
  return results.map((row) => ({ project: toProject(row), changeId: mustParse(count, row.change_id, 'changeId') }));
}

/**
 * The pending project whose latest status change is `changeId`, or null when
 * there is none: no such change, a project that isn't pending, or one whose
 * status changed since.
 */
export async function getPendingProject(db: D1Database, changeId: number): Promise<PendingProject | null> {
  const change = mustParse(count, changeId, 'changeId');
  const row = await db
    .prepare(
      `${SELECT_PROJECT}
       WHERE p.status = 'pending'
         AND p.repo = (SELECT repo FROM project_status_changes WHERE id = ?1)
         AND ?1 = (SELECT MAX(c.id) FROM project_status_changes c WHERE c.repo = p.repo)`,
    )
    .bind(change)
    .first<ProjectRow>();
  return row === null ? null : { project: toProject(row), changeId: change };
}

/** Every project listed from its written AI policy, whatever its status, the oldest listing first. */
export async function listPolicyListings(db: D1Database): Promise<ProjectRecord[]> {
  const { results } = await db
    .prepare(`${SELECT_PROJECT} WHERE p.source = 'policy' ORDER BY p.added_at, p.repo`)
    .all<ProjectRow>();
  return results.map(toProject);
}

/** A do-not-list entry for the repo keeps it out of a listing, checked in the same statement as a write. */
const NOT_ON_DO_NOT_LIST = 'NOT EXISTS (SELECT 1 FROM do_not_list WHERE repo = ?1)';

export type Relisting = { ok: true; project: ProjectRecord; changed: SettingKey[] } | { ok: false; problems: FieldProblem[] };

/**
 * An admin lists a repo from its policy again, when it is already listed
 * that way: the new policy replaces the old, and the settings sent replace
 * the listing's, saved as a new version by `by` at `now`. Settings left out
 * keep their value. Its status, who added it, and when stay. A change that
 * changes no setting saves no new version. Null when the repo isn't a
 * project listed from its policy when it saves, or is on the do-not-list,
 * checked in the same statements as the writes.
 */
export async function relistFromPolicy(
  db: D1Database,
  repo: string,
  listing: { policy: Policy; settings: ProjectSettingsPatch },
  by: number,
  now: number,
): Promise<Relisting | null> {
  const policy = mustParse(policySchema, listing.policy, 'policy');
  const changedBy = mustParse(githubId, by, 'by');
  const at = checkTime(now);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const current = await getProject(db, repo);
    if (current?.source !== 'policy' || (await getDoNotListEntry(db, current.repo)) !== null) return null;
    const result = updateProjectSettings(current.settings, listing.settings);
    if (!result.ok) return result;
    const next = result.value;
    const changed = changedSettings(current.settings, next);
    const version = changed.length > 0 ? current.settingsVersion + 1 : current.settingsVersion;
    const project = mustParse(
      projectRecordSchema,
      { ...current, policy, settings: next, settingsVersion: version },
      'project',
    );
    // Both statements check that the project is still the listing read,
    // with no other save since, and that the repo isn't on the do-not-list,
    // and the batch runs as one transaction. The update runs last, since it
    // changes what they check.
    const still = `repo = ?1 AND source = 'policy' AND settings_version = ?2 AND ${NOT_ON_DO_NOT_LIST}`;
    const read = [current.repo, current.settingsVersion];
    const statements: D1PreparedStatement[] = [];
    if (changed.length > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
             SELECT ?1, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM projects WHERE ${still})`,
          )
          .bind(...read, version, JSON.stringify(next), changedBy, at),
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE projects SET policy_quote = ?3, policy_url = ?4, policy_tier = ?5, settings_version = ?6,
             issue_repo = ?7
           WHERE ${still}`,
        )
        .bind(...read, policy.quote, policy.url, policy.tier, version, issueRepoOf(current.repo, next)),
    );
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes === 1) return { ok: true, project, changed };
  }
  throw new Error(`${repo} changed ${String(SAVE_ATTEMPTS)} times during one save.`);
}

/**
 * A maintainer registers again a repo whose registration was rejected, or
 * that was removed at its maintainers' request. Their settings replace the
 * project's, whole, as a new save made by `by` at `now`, with settings they
 * left out at their defaults, and it goes back to `pending`, changed by them,
 * so an admin reviews it again. It names them as who added it, and keeps the
 * time it was first added. A repo on the do-not-list stays on it until an
 * admin approves the registration. Null when the repo isn't a rejected
 * registration when it saves.
 */
export async function reopenRegistration(
  db: D1Database,
  repo: string,
  settings: ProjectSettingsInput,
  by: number,
  now: number,
): Promise<ProjectRecord | null> {
  const next = mustParse(projectSettingsSchema, settings, 'settings');
  const addedBy = mustParse(githubId, by, 'by');
  const at = checkTime(now);
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const current = await getProject(db, repo);
    if (current?.source !== 'registered' || current.status !== 'rejected') return null;
    const changed = changedSettings(current.settings, next);
    const version = changed.length > 0 ? current.settingsVersion + 1 : current.settingsVersion;
    const project = mustParse(
      projectRecordSchema,
      {
        ...current,
        status: 'pending',
        statusReason: null,
        statusChangedBy: addedBy,
        statusChangedAt: at,
        addedBy,
        settings: next,
        settingsVersion: version,
      },
      'project',
    );
    // Every statement checks that the project is still the rejection that
    // was read, with no other save or status change since, and the batch
    // runs as one transaction. The update runs after them, since it changes
    // what they check.
    const rejected = `repo = ?1 AND source = 'registered' AND status = 'rejected' AND settings_version = ?2
      AND status_changed_at = ?3`;
    const read = [current.repo, current.settingsVersion, current.statusChangedAt];
    const statements: D1PreparedStatement[] = [];
    if (changed.length > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
             SELECT ?1, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM projects WHERE ${rejected})`,
          )
          .bind(...read, version, JSON.stringify(next), addedBy, at),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
           SELECT ?1, 'pending', NULL, ?4, ?5 WHERE EXISTS (SELECT 1 FROM projects WHERE ${rejected})`,
        )
        .bind(...read, addedBy, at),
      db
        .prepare(
          `UPDATE projects SET status = 'pending', status_reason = NULL, status_changed_by = ?4,
             status_changed_at = ?5, added_by = ?4, settings_version = ?6, issue_repo = ?7
           WHERE ${rejected}`,
        )
        .bind(...read, addedBy, at, version, issueRepoOf(current.repo, next)),
    );
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes === 1) return project;
  }
  throw new Error(`${repo} changed ${String(SAVE_ATTEMPTS)} times during one save.`);
}

/** A project Good First Token paused on its own, with the ID of the status change that paused it. */
export interface SelfPausedProject {
  project: ProjectRecord;
  /** The project's latest status change, which paused it. */
  changeId: number;
}

/** A pause that names no one, made by Good First Token on its own. */
const SELF_PAUSED = "p.status = 'paused' AND p.status_changed_by IS NULL";

/**
 * Every project Good First Token paused on its own, the sync's pauses and
 * the policy crawler's, the one paused longest ago first, each with the ID
 * of the status change that paused it. A new status change gives it a new
 * ID, so an ID names one pause.
 */
export async function listSelfPausedProjects(db: D1Database): Promise<SelfPausedProject[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, s.settings,
         (SELECT MAX(c.id) FROM project_status_changes c WHERE c.repo = p.repo) AS change_id
       FROM projects p
       JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version
       WHERE ${SELF_PAUSED}
       ORDER BY p.status_changed_at, p.repo`,
    )
    .all<ProjectRow & { change_id: number }>();
  return results.map((row) => ({ project: toProject(row), changeId: mustParse(count, row.change_id, 'changeId') }));
}

/**
 * The project Good First Token paused on its own whose latest status change
 * is `changeId`, or null when there is none: no such change, a project that
 * isn't paused that way, or one whose status changed since.
 */
export async function getSelfPausedProject(db: D1Database, changeId: number): Promise<SelfPausedProject | null> {
  const change = mustParse(count, changeId, 'changeId');
  const row = await db
    .prepare(
      `${SELECT_PROJECT}
       WHERE ${SELF_PAUSED}
         AND p.repo = (SELECT repo FROM project_status_changes WHERE id = ?1)
         AND ?1 = (SELECT MAX(c.id) FROM project_status_changes c WHERE c.repo = p.repo)`,
    )
    .bind(change)
    .first<ProjectRow>();
  return row === null ? null : { project: toProject(row), changeId: change };
}
