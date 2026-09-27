import {
  changedSettings,
  CLAIM_LIFETIME_MS,
  count,
  githubId,
  mustParse,
  policySchema,
  projectRecordSchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusChangeSchema,
  projectStatusSchema,
  repoName,
  REVIEW_WINDOW_MS,
  settingsVersionSchema,
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
} from '@goodfirsttoken/core';
import { checkTime, fromJson } from './shared';

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
 * status, all made by `addedBy` at `now`. Null when the
 * repo is already a project, in any case, since GitHub ignores case in repo
 * names.
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
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
    db
      .prepare(
        `INSERT INTO project_settings (repo, version, settings, changed_by, changed_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(record.repo, JSON.stringify(record.settings), record.addedBy, record.addedAt),
    // A project that already existed has status changes, so this adds none.
    db
      .prepare(
        `INSERT INTO project_status_changes (repo, status, reason, changed_by, changed_at)
         SELECT ?1, ?2, NULL, ?3, ?4
         WHERE NOT EXISTS (SELECT 1 FROM project_status_changes WHERE repo = ?1)`,
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
  // Labels compare without case. SQLite's lower() folds ASCII letters. An
  // issue has an open PR when the sync saw one linked to it, or when a claim
  // on it opened one that the PRs table doesn't show merged or closed, as
  // the issue's room counts it. A claim holds a slot as core's holdsSlot
  // says: working or paused until 24 hours after it was made, and awaiting
  // review until 7 days after its first submit, whether or not the room's
  // timer has run yet.
  const { results } = await db
    .prepare(
      `SELECT p.*, s.settings, COUNT(*) OVER () AS total,
         (SELECT COUNT(*) FROM tagged_issues t
          WHERE t.project = p.repo AND t.linked_pr_number IS NULL
            AND EXISTS (SELECT 1 FROM json_each(t.labels) l, json_each(s.settings, '$.tags') g
                        WHERE lower(l.value) = lower(g.value))
            AND NOT EXISTS (SELECT 1 FROM json_each(t.labels) l, json_each(s.settings, '$.excludedTags') x
                            WHERE lower(l.value) = lower(x.value))
            AND NOT EXISTS (SELECT 1 FROM claims c LEFT JOIN prs pr ON pr.claim_id = c.id
                            WHERE c.issue_repo = t.issue_repo AND c.issue_number = t.number
                              AND c.pr_number IS NOT NULL AND (pr.state IS NULL OR pr.state = 'open'))
            AND (SELECT COUNT(*) FROM claims c
                 WHERE c.issue_repo = t.issue_repo AND c.issue_number = t.number
                   AND ((c.state IN ('active', 'paused') AND c.claimed_at + ?2 > ?4)
                     OR (c.state = 'awaiting_review' AND c.submitted_at + ?3 > ?4)))
                < json_extract(s.settings, '$.claimsPerIssue')) AS waiting
       FROM projects p
       JOIN project_settings s ON s.repo = p.repo AND s.version = p.settings_version
       WHERE p.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM do_not_list d WHERE d.repo IN (p.repo, p.issue_repo))
       ORDER BY waiting DESC, p.added_at DESC, p.repo
       LIMIT ?1`,
    )
    .bind(mustParse(count, limit, 'limit'), CLAIM_LIFETIME_MS, REVIEW_WINDOW_MS, checkTime(now))
    .all<ProjectRow & { total: number; waiting: number }>();
  return {
    total: mustParse(count, results[0]?.total ?? 0, 'total'),
    projects: results.map((row) => ({ project: toProject(row), waiting: mustParse(count, row.waiting, 'waiting') })),
  };
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
