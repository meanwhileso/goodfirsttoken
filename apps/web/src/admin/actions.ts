import {
  invalidSettings,
  projectSettingsSchema,
  validate,
  type CrawlCandidate,
  type Policy,
  type PolicyChange,
  type ProjectRecord,
  type ProjectSettingsPatch,
  type ProjectStatus,
  type Refusal,
  type RemovalRequest,
  type RefusalCode,
  type ToolInput,
  type ToolName,
  type ToolOutputInput,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { requirePermission, type Caller } from '../auth/permissions';
import {
  addSeed,
  crawlerSkips,
  addToDoNotList,
  blockDonor,
  closeRemoval,
  createProject,
  decideCandidate,
  decidePolicyChange,
  doNotListWhenRejected,
  dropWaitingPolicyChange,
  findPersonByLogin,
  getCandidate,
  getDoNotListEntry,
  getIssueSync,
  getPendingProject,
  getPerson,
  getPolicyChange,
  getPolicyRead,
  getProject,
  getRemoval,
  getSelfPausedProject,
  getWaitingCandidate,
  getWaitingRemoval,
  leaveDoNotListWhenApproved,
  listCandidates,
  listPendingProjects,
  listPolicyChanges,
  listSelfPausedProjects,
  listWaitingRemovals,
  relistFromPolicy,
  setProjectStatusFrom,
  statusHistory,
  unblockDonor,
  type SelfPausedProject,
  withdrawnByOthers,
} from '../db';
import { GitHubError } from '../github';
import { readDelisting } from '../project/shown';
import { readRepo, readStanding, repoFacts, whyNotEligible, whyNotIssueRepo, type Standing } from '../projects/repo';
import { adminResume, pauseTakenOver, resumableBy } from '../projects/status';

// What an admin does, for the admin's MCP tools (src/mcp/admin.ts) and the
// admin pages (src/admin/page.ts) alike. Every action first checks the
// caller's permission with requirePermission, before it reads or writes
// anything. The rules are in docs/how-it-works.md, under The admin queue.

/** What an action gives back: the tool's output, or a refusal. */
export type Outcome<N extends ToolName> = { ok: true; value: ToolOutputInput<N> } | { ok: false; refusal: Refusal };

function refuse(code: RefusalCode, message: string): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message } };
}

/** The reason a project removed at its maintainers' request is rejected with. Its maintainers see it. */
export const REMOVED_REASON = "Removed at its maintainers' request.";

/** How many times a status change is decided again when the status changed while it ran. */
const STATUS_ATTEMPTS = 5;

/** A registration's queue ID names the status change that put it in the queue. */
const REGISTRATION_ID = /^reg_([1-9][0-9]{0,15})$/;

/** A request to be removed has its own ID, which admin_decide doesn't take. */
const REMOVAL_ID = /^rem_[A-Za-z0-9_-]+$/;

function registrationId(changeId: number): string {
  return `reg_${String(changeId)}`;
}

/** A pause Good First Token made on its own has the ID of the status change that paused it. */
const PAUSE_ID = /^pause_([1-9][0-9]{0,15})$/;

/** A listing's policy change has an ID the crawler gave it. */
const POLICY_CHANGE_ID = /^pchg_[A-Za-z0-9_-]+$/;

function pauseId(changeId: number): string {
  return `pause_${String(changeId)}`;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

type QueueItem = ToolOutputInput<'admin_queue'>['items'][number];

function factsOf(standing: Standing): QueueItem['facts'] {
  return {
    stars: standing.stars,
    createdAt: iso(standing.createdAt),
    pushedAt: iso(standing.pushedAt),
    ownerCreatedAt: iso(standing.ownerCreatedAt),
  };
}

/** A registration's facts, or why they are missing. */
type Facts = { standing: Standing } | { missing: 'not_public' | 'no_answer' };

/**
 * The repo's facts from GitHub, read with the admin's own token. Missing as
 * `not_public` when GitHub shows no public repo by that name, and as
 * `no_answer` when there is no token or GitHub fails another way, like a
 * rate limit, so a failed read never passes for a repo that isn't public. A
 * 401 goes on up, since it means GitHub stopped taking the token.
 */
async function factsFromGitHub(token: string | null, repo: string): Promise<Facts> {
  if (token === null) return { missing: 'no_answer' };
  try {
    const read = await readStanding(token, repo);
    return read === null ? { missing: 'not_public' } : { standing: read.standing };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) throw error;
    console.warn(`GitHub didn't give the facts of ${repo} for the admin queue.`, error);
    return { missing: 'no_answer' };
  }
}

/**
 * What a registration or crawler find says of the repo's requests to be
 * removed: whether one waits, and the first few that someone other than
 * their asker withdrew since the repo was last removed, with who asked, who
 * withdrew each, and when, and how many more there are. Every such
 * withdrawal counts, so asking and withdrawing a request of one's own
 * afterwards hides none.
 */
async function removalsOf(
  repo: string,
): Promise<Pick<QueueItem, 'removalWaits' | 'removalsWithdrawn' | 'moreRemovalsWithdrawn'>> {
  const [waiting, withdrawn] = await Promise.all([getWaitingRemoval(env.DB, repo), withdrawnByOthers(env.DB, repo)]);
  return {
    removalWaits: waiting !== null,
    removalsWithdrawn: withdrawn.first.map((request) => ({ ...request, withdrawnAt: iso(request.withdrawnAt) })),
    moreRemovalsWithdrawn: withdrawn.more,
  };
}

async function registrationItem(token: string | null, project: ProjectRecord, changeId: number): Promise<QueueItem> {
  const [maintainer, facts, doNotList, removals] = await Promise.all([
    getPerson(env.DB, project.addedBy),
    factsFromGitHub(token, project.repo),
    getDoNotListEntry(env.DB, project.repo),
    removalsOf(project.repo),
  ]);
  if (maintainer === null) throw new Error(`${project.repo} was added by someone who isn't recorded.`);
  return {
    id: registrationId(changeId),
    kind: 'registration',
    repo: project.repo,
    requestedBy: maintainer.login,
    requestedAt: iso(project.statusChangedAt),
    facts: 'standing' in facts ? factsOf(facts.standing) : null,
    factsMissing: 'missing' in facts ? facts.missing : null,
    settings: project.settings,
    policy: project.policy,
    suggestedTags: [],
    onDoNotList: doNotList !== null,
    sources: [],
    aiSentences: [],
    moreAiSentences: 0,
    ...removals,
  };
}

/**
 * A maintainer's request to be removed, with the repo's facts read as a
 * registration's are, and what the repo is on Good First Token now. The
 * reason is the maintainer's words, which the queue quotes as theirs.
 */
async function removalItem(token: string | null, request: RemovalRequest): Promise<QueueItem> {
  const [maintainer, facts, doNotList, project] = await Promise.all([
    getPerson(env.DB, request.requestedBy),
    factsFromGitHub(token, request.repo),
    getDoNotListEntry(env.DB, request.repo),
    getProject(env.DB, request.repo),
  ]);
  if (maintainer === null) throw new Error(`${request.repo}'s request to be removed names someone who isn't recorded.`);
  return {
    id: request.id,
    kind: 'removal',
    repo: request.repo,
    requestedBy: maintainer.login,
    requestedAt: iso(request.requestedAt),
    facts: 'standing' in facts ? factsOf(facts.standing) : null,
    factsMissing: 'missing' in facts ? facts.missing : null,
    settings: {},
    policy: null,
    suggestedTags: [],
    onDoNotList: doNotList !== null,
    sources: [],
    aiSentences: [],
    moreAiSentences: 0,
    removal: {
      reason: request.reason,
      project: project === null ? null : { status: project.status, source: project.source },
    },
  };
}

async function candidateItem(candidate: CrawlCandidate): Promise<QueueItem> {
  const [doNotList, removals] = await Promise.all([
    getDoNotListEntry(env.DB, candidate.repo),
    removalsOf(candidate.repo),
  ]);
  return {
    id: candidate.id,
    kind: 'candidate',
    repo: candidate.repo,
    requestedBy: null,
    requestedAt: iso(candidate.foundAt),
    facts: factsOf(candidate.facts),
    factsMissing: null,
    settings: candidate.settings,
    policy: candidate.policy,
    suggestedTags: candidate.suggestedTags,
    onDoNotList: doNotList !== null,
    sources: candidate.sources,
    aiSentences: candidate.aiSentences,
    moreAiSentences: candidate.moreAiSentences,
    ...removals,
  };
}

/**
 * A pause Good First Token made on its own, with its reason, why the sync
 * delisted the project when it did, the pause someone made that it took
 * over, and for the policy crawler's pause on a ban, the line its rules read
 * as one and the sentences that name AI, from the read that paused it. While
 * the sync has the project delisted, nothing read from its repo shows: no
 * ban line, no sentences, and no policy. It reads nothing from GitHub.
 */
async function pauseItem({ project, changeId }: SelfPausedProject): Promise<QueueItem> {
  const [sync, read, doNotList, history] = await Promise.all([
    getIssueSync(env.DB, project.repo),
    getPolicyRead(env.DB, project.repo),
    getDoNotListEntry(env.DB, project.repo),
    statusHistory(env.DB, project.repo),
  ]);
  const delisted = await readDelisting(env.DB, project, sync);
  // What the crawler kept belongs to this pause only when it made this one,
  // and shows only while GitHub shows the repo.
  const crawler = delisted === null && read?.pause?.pausedAt === project.statusChangedAt ? read.pause : null;
  const taken = pauseTakenOver(history);
  const takenBy = taken?.changedBy == null ? null : await getPerson(env.DB, taken.changedBy);
  return {
    id: pauseId(changeId),
    kind: 'pause',
    repo: project.repo,
    requestedBy: null,
    requestedAt: iso(project.statusChangedAt),
    facts: null,
    factsMissing: null,
    settings: project.settings,
    policy: delisted === null ? project.policy : null,
    suggestedTags: [],
    onDoNotList: doNotList !== null,
    sources: [],
    aiSentences: crawler?.aiSentences ?? [],
    moreAiSentences: crawler?.moreAiSentences ?? 0,
    pause: {
      reason: project.statusReason,
      delisted,
      ban: crawler?.ban ?? null,
      tookOver:
        taken === null || takenBy === null ? null : { by: takenBy.login, at: iso(taken.changedAt), reason: taken.reason },
    },
  };
}

/**
 * A listing whose policy the crawler reads differently now, with the facts,
 * lines, and sentences it read, beside the policy and settings the project
 * has now.
 */
async function policyChangeItem(change: PolicyChange): Promise<QueueItem> {
  const [project, doNotList, sync] = await Promise.all([
    getProject(env.DB, change.repo),
    getDoNotListEntry(env.DB, change.repo),
    getIssueSync(env.DB, change.repo),
  ]);
  if (project === null) throw new Error(`The policy change ${change.id} is for ${change.repo}, which isn't a project.`);
  // While the sync has the project delisted, nothing read from its repo shows.
  const delisted = await readDelisting(env.DB, project, sync);
  const shown = delisted === null;
  return {
    id: change.id,
    kind: 'policy_change',
    repo: project.repo,
    requestedBy: null,
    requestedAt: iso(change.foundAt),
    facts: factsOf(change.facts),
    factsMissing: null,
    settings: project.settings,
    policy: shown ? change.policy : null,
    suggestedTags: [],
    onDoNotList: doNotList !== null,
    sources: shown ? change.sources : [],
    aiSentences: shown ? change.aiSentences : [],
    moreAiSentences: shown ? change.moreAiSentences : 0,
    change: { listed: shown ? project.policy : null, status: project.status, delisted },
  };
}

/**
 * The admin queue: maintainers' registrations waiting for an admin, the
 * crawler's finds, maintainers' requests to be removed, the projects Good
 * First Token paused on its own, and the listings whose policy the crawler
 * reads differently now, the one that has waited longest first. The facts
 * of a registration and of a request come from GitHub now, read with the
 * admin's own token. A crawler find's and a policy change's are the ones
 * the crawler read. A pause has none.
 */
export async function adminQueue(caller: Caller, input: ToolInput<'admin_queue'>): Promise<Outcome<'admin_queue'>> {
  await requirePermission(caller, 'review_projects');
  const token = await caller.gitHubToken();
  const wants = (kind: QueueItem['kind']) => input.kind === 'all' || input.kind === kind;
  const [pending, candidates, removals, paused, changes] = await Promise.all([
    wants('registration') ? listPendingProjects(env.DB) : [],
    wants('candidate') ? listCandidates(env.DB, 'waiting') : [],
    wants('removal') ? listWaitingRemovals(env.DB) : [],
    wants('pause') ? listSelfPausedProjects(env.DB) : [],
    wants('policy_change') ? listPolicyChanges(env.DB, 'waiting') : [],
  ]);
  const items = await Promise.all([
    ...pending.map(({ project, changeId }) => registrationItem(token, project, changeId)),
    ...candidates.map(candidateItem),
    ...removals.map((request) => removalItem(token, request)),
    ...paused.map(pauseItem),
    ...changes.map(policyChangeItem),
  ]);
  items.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.repo.localeCompare(b.repo));
  return { ok: true, value: { items } };
}

/** Settings left out of a patch, and sent as undefined, keep the value they had. */
function definedEntries(patch: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * Refuses to list or approve a repo whose maintainers' request to be removed
 * waits. GitHub vouched for whoever asked, so the request stands until an
 * admin removes the repo or a maintainer of it withdraws the request.
 */
function removalWaits(repo: string): { ok: false; refusal: Refusal } {
  return refuse(
    'repo_not_eligible',
    `A maintainer of ${repo} asked to have it removed, and that request waits in the admin queue. Remove the repo with admin_remove_project, or list it only once its maintainers withdraw the request.`,
  );
}

function onTheList(repo: string): { ok: false; refusal: Refusal } {
  return refuse(
    'repo_not_eligible',
    `${repo} is on the do-not-list, because its maintainers asked to be removed. Only they can list it again, by registering it.`,
  );
}

/**
 * Lists a repo from its written policy, or lists it again when it is already
 * listed that way, after checking it on GitHub with the admin's own token:
 * it has to be public, not archived, and take pull requests from anyone.
 * Its issue repo, when it has one of its own, has to be public and not
 * archived. A new listing takes the settings sent, with the rest at their
 * defaults, and a listing again changes only the settings sent. A repo on the
 * do-not-list, or one its maintainers registered, is refused. The
 * do-not-list is checked again in the same statement as each write, so a
 * removal that lands while this reads GitHub keeps the repo unlisted. The
 * caller has checked `list_from_policy`.
 */
async function listFromPolicy(
  caller: Caller,
  repo: string,
  policy: Policy,
  settings: ProjectSettingsPatch,
  now: number,
): Promise<Outcome<'admin_add_project'>> {
  if ((await getDoNotListEntry(env.DB, repo)) !== null) return onTheList(repo);
  if ((await getWaitingRemoval(env.DB, repo)) !== null) return removalWaits(repo);
  const token = await caller.gitHubToken();
  if (token === null) {
    return refuse('repo_not_eligible', `Good First Token holds no GitHub token for you, so it can't check ${repo}. Sign in again.`);
  }
  const found = await readRepo(token, repo);
  if (found === null) return refuse('repo_not_eligible', `GitHub shows no public repo named ${repo}. Only a public repo can be listed.`);
  const problem = whyNotEligible(repoFacts(found), 'list');
  if (problem !== null) return refuse('repo_not_eligible', problem);
  const name = found.full_name;

  const patch: ProjectSettingsPatch = { ...settings };
  if (typeof settings.issueRepo === 'string') {
    patch.issueRepo = null;
    if (settings.issueRepo.toLowerCase() !== name.toLowerCase()) {
      const issues = await readRepo(token, settings.issueRepo);
      if (issues === null) {
        return refuse('repo_not_eligible', `GitHub shows no public repo named ${settings.issueRepo} to keep the issues in.`);
      }
      const notIssueRepo = whyNotIssueRepo(repoFacts(issues));
      if (notIssueRepo !== null) return refuse('repo_not_eligible', notIssueRepo);
      if (issues.full_name.toLowerCase() !== name.toLowerCase()) patch.issueRepo = issues.full_name;
    }
  }

  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    if ((await getDoNotListEntry(env.DB, name)) !== null) return onTheList(name);
    if ((await getWaitingRemoval(env.DB, name)) !== null) return removalWaits(name);
    const existing = await getProject(env.DB, name);
    if (existing?.source === 'registered') {
      return refuse(
        'already_registered',
        `${existing.repo} is registered by its maintainers, and is ${existing.status}. Their settings stay.`,
      );
    }
    if (existing !== null) {
      const relisted = await relistFromPolicy(env.DB, existing.repo, { policy, settings: patch }, caller.githubId, now);
      if (relisted?.ok === false) return { ok: false, refusal: invalidSettings(relisted.problems) };
      if (relisted?.ok) {
        const { project } = relisted;
        return { ok: true, value: { repo: project.repo, status: project.status, source: project.source, updated: true } };
      }
    } else {
      const full = validate(projectSettingsSchema, definedEntries(patch), 'settings');
      if (!full.ok) return { ok: false, refusal: invalidSettings(full.problems) };
      const project = await createProject(
        env.DB,
        { repo: name, status: 'approved', source: 'policy', policy, settings: full.value, addedBy: caller.githubId },
        now,
      );
      if (project !== null) {
        return { ok: true, value: { repo: project.repo, status: project.status, source: project.source, updated: false } };
      }
    }
  }
  throw new Error(`${name} kept changing while it was listed.`);
}

/**
 * Lists a project from its written policy, with the quote, its link, the
 * tier, the settings, and its tags, or lists it again with the settings that
 * change.
 */
export async function adminAddProject(
  caller: Caller,
  input: ToolInput<'admin_add_project'>,
  now: number,
): Promise<Outcome<'admin_add_project'>> {
  await requirePermission(caller, 'list_from_policy');
  return listFromPolicy(caller, input.repo, input.policy, input.settings, now);
}

function nothingWaits(id: string): { ok: false; refusal: Refusal } {
  return refuse(
    'not_found',
    `Nothing waits in the admin queue with the id ${id}. It may have been decided or changed since you read the queue. Read it again with admin_queue.`,
  );
}

async function decideRegistration(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  changeId: number,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  if (input.tier !== undefined || input.settings !== undefined) {
    return refuse(
      'invalid_settings',
      'A registration keeps the settings its maintainer chose. Approve or reject it with no tier and no settings.',
    );
  }
  const change: { status: ProjectStatus; reason: string | null } =
    input.decision === 'approve' ? { status: 'approved', reason: null } : { status: 'rejected', reason: input.reason ?? null };
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const pending = await getPendingProject(env.DB, changeId);
    if (pending === null) return nothingWaits(input.id);
    // A maintainer asked for it to be removed too, and that request stands
    // until an admin removes the repo or a maintainer withdraws it.
    if (change.status === 'approved' && (await getWaitingRemoval(env.DB, pending.project.repo)) !== null) {
      return removalWaits(pending.project.repo);
    }
    // A maintainer asked for it to be listed, so an approval takes the repo
    // off the do-not-list, in the same transaction. A rejection leaves it on.
    const alongside =
      change.status === 'approved' ? [leaveDoNotListWhenApproved(env.DB, pending.project.repo, caller.githubId, now)] : [];
    const decided = await setProjectStatusFrom(
      env.DB,
      pending.project,
      { ...change, changedBy: caller.githubId },
      now,
      alongside,
    );
    if (decided === null) continue;
    return { ok: true, value: { repo: decided.repo, kind: 'registration', status: decided.status } };
  }
  throw new Error(`${input.id} kept changing while it was decided.`);
}

async function decideCandidateItem(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  const candidate = await getCandidate(env.DB, input.id);
  if (candidate?.status !== 'waiting') return nothingWaits(input.id);
  if (input.decision === 'reject') {
    const decided = await decideCandidate(
      env.DB,
      candidate.id,
      { status: 'rejected', decidedBy: caller.githubId, reason: input.reason ?? null },
      now,
    );
    if (decided === null) return nothingWaits(input.id);
    return { ok: true, value: { repo: decided.repo, kind: 'candidate', status: 'rejected' } };
  }
  await requirePermission(caller, 'list_from_policy');
  const settings = validate(projectSettingsSchema, { ...candidate.settings, ...definedEntries(input.settings) }, 'settings');
  if (!settings.ok) return { ok: false, refusal: invalidSettings(settings.problems) };
  const policy = { ...candidate.policy, tier: input.tier ?? candidate.policy.tier };
  const listed = await listFromPolicy(caller, candidate.repo, policy, settings.value, now);
  if (!listed.ok) return listed;
  await decideCandidate(env.DB, candidate.id, { status: 'approved', decidedBy: caller.githubId, reason: null }, now);
  return { ok: true, value: { repo: listed.value.repo, kind: 'candidate', status: listed.value.status } };
}

/**
 * Resumes a project Good First Token paused on its own, putting back the
 * status it had before the pause, or keeps it paused as the admin's own
 * pause, with the reason they give, which its maintainers read. When the
 * pause took over one a maintainer or an admin made, approving puts that
 * one back as they made it, for them to lift, by `adminResume`, as
 * admin_pause_project's resume does. Either way it leaves the
 * queue. It lands only on the pause the ID names, and is decided again when
 * the status changed while it ran.
 */
async function decidePause(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  changeId: number,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  await requirePermission(caller, 'pause_any_project');
  if (input.tier !== undefined || input.settings !== undefined) {
    return refuse(
      'invalid_settings',
      'A pause is resumed or kept with no tier and no settings. Change the settings of a listing with admin_add_project.',
    );
  }
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const paused = await getSelfPausedProject(env.DB, changeId);
    if (paused === null) return nothingWaits(input.id);
    const change: { status: ProjectStatus; reason: string | null; changedBy: number | null } =
      input.decision === 'reject'
        ? { status: 'paused', reason: input.reason ?? null, changedBy: caller.githubId }
        : adminResume(await statusHistory(env.DB, paused.project.repo), caller.githubId);
    const decided = await setProjectStatusFrom(env.DB, paused.project, change, now);
    if (decided === null) continue;
    const delisted = await readDelisting(env.DB, decided);
    return { ok: true, value: { repo: decided.repo, kind: 'pause', status: decided.status, decision: input.decision, delisted } };
  }
  throw new Error(`${input.id} kept changing while it was decided.`);
}

/**
 * Approving a policy change lists the project from the policy its docs give
 * now, as admin_add_project lists a repo again: the new policy replaces the
 * old, with the tier the admin confirms, and only the settings they send
 * change. The project keeps its status. Rejecting it keeps the listing as it
 * is, with a reason only admins see. Either way it leaves the queue. A change
 * whose docs give no policy has none to list the project from.
 */
async function decidePolicyChangeItem(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  const change = await getPolicyChange(env.DB, input.id);
  if (change?.status !== 'waiting') return nothingWaits(input.id);
  if (input.decision === 'reject') {
    const decided = await decidePolicyChange(
      env.DB,
      change.id,
      { status: 'rejected', decidedBy: caller.githubId, reason: input.reason ?? null },
      now,
    );
    const project = await getProject(env.DB, change.repo);
    if (decided === null || project === null) return nothingWaits(input.id);
    return { ok: true, value: { repo: project.repo, kind: 'policy_change', status: project.status, decision: 'reject' } };
  }
  await requirePermission(caller, 'list_from_policy');
  if (change.policy === null) {
    return refuse(
      'repo_not_eligible',
      `The crawler's rules read no policy in the docs of ${change.repo} that welcomes AI help, so there is none to list it from. Reject this change to keep the listing as it is, or pause or remove the project.`,
    );
  }
  const policy = { ...change.policy, tier: input.tier ?? change.policy.tier };
  const listed = await listFromPolicy(caller, change.repo, policy, input.settings ?? {}, now);
  if (!listed.ok) return listed;
  await decidePolicyChange(env.DB, change.id, { status: 'approved', decidedBy: caller.githubId, reason: null }, now);
  return { ok: true, value: { repo: listed.value.repo, kind: 'policy_change', status: listed.value.status, decision: 'approve' } };
}

/**
 * Approves or rejects what waits in the queue. A registration is approved or
 * rejected with the settings its maintainer chose, and the reason for a
 * rejection is theirs to read with project_status. Approving a crawler find
 * lists it from its policy, with the tier and settings the admin confirmed.
 * A pause Good First Token made is resumed or kept, and a policy change
 * lists the project from its new policy or keeps the listing as it is.
 */
export async function adminDecide(
  caller: Caller,
  input: ToolInput<'admin_decide'>,
  now: number,
): Promise<Outcome<'admin_decide'>> {
  await requirePermission(caller, 'review_projects');
  if (input.decision === 'reject' && input.reason === undefined) {
    return refuse('invalid_input', 'A rejection needs a reason.');
  }
  const registration = REGISTRATION_ID.exec(input.id);
  if (registration) return decideRegistration(caller, input, Number(registration[1]), now);
  const pause = PAUSE_ID.exec(input.id);
  if (pause) return decidePause(caller, input, Number(pause[1]), now);
  if (POLICY_CHANGE_ID.test(input.id)) return decidePolicyChangeItem(caller, input, now);
  if (REMOVAL_ID.test(input.id)) {
    // A request that waits is in the queue, but isn't admin_decide's to
    // decide. Any other ID is nothing that waits.
    const request = await getRemoval(env.DB, input.id);
    if (request?.status !== 'waiting') return nothingWaits(input.id);
    return refuse(
      'invalid_input',
      `${input.id} is a request to remove ${request.repo}, which admin_decide doesn't decide. Remove the repo with admin_remove_project, which closes the request.`,
    );
  }
  return decideCandidateItem(caller, input, now);
}

/** Blocks a donor, found by their login now, or lifts their block. */
export async function adminBlockDonor(
  caller: Caller,
  input: ToolInput<'admin_block_donor'>,
  now: number,
): Promise<Outcome<'admin_block_donor'>> {
  await requirePermission(caller, 'block_donors');
  const person = await findPersonByLogin(env.DB, input.login);
  if (person === null) return refuse('not_found', `No one has signed in to Good First Token as @${input.login}.`);
  if (input.blocked) {
    await blockDonor(env.DB, { githubId: person.githubId, reason: input.reason ?? null, blockedBy: caller.githubId }, now);
  } else {
    await unblockDonor(env.DB, person.githubId);
  }
  return { ok: true, value: { login: person.login, blocked: input.blocked } };
}

function notOpen(project: ProjectRecord): { ok: false; refusal: Refusal } {
  return refuse(
    'project_not_open',
    `${project.repo} is ${project.status}, so agents can't claim its issues. Only an approved project can be paused.`,
  );
}

/**
 * The answer to an admin's pause or resume: the project's status now, whether
 * the call changed it, whether a resume put back a pause Good First Token's
 * took over, and why the sync delisted it, when it did, since a resume
 * doesn't bring back the page of a project the sync delisted.
 */
async function pauseAnswer(project: ProjectRecord, changed: boolean, restored = false): Promise<Outcome<'admin_pause_project'>> {
  const delisted = await readDelisting(env.DB, project);
  return { ok: true, value: { repo: project.repo, status: project.status, changed, restored, delisted } };
}

/**
 * Pauses an approved project, or resumes a paused one, whoever paused it. A
 * pause by an admin stays until an admin lifts it. An admin pausing a project
 * its maintainers paused takes the pause over, even with the same reason, so
 * they can't lift it. A resume of a pause Good First Token made over someone
 * else's puts theirs back, as approving it in the admin queue does. Each
 * change lands only on the status it was decided on, and is decided again
 * when someone else changed the status first.
 */
export async function adminPauseProject(
  caller: Caller,
  input: ToolInput<'admin_pause_project'>,
  now: number,
): Promise<Outcome<'admin_pause_project'>> {
  await requirePermission(caller, 'pause_any_project');
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const project = await getProject(env.DB, input.repo);
    if (project === null) return refuse('not_found', `${input.repo} is not a project on Good First Token.`);
    let change: { status: ProjectStatus; reason: string | null; changedBy: number | null; restored: boolean };
    if (input.paused) {
      const reason = input.reason ?? null;
      if (project.status === 'paused') {
        if (resumableBy(project) === 'admins' && project.statusReason === reason) return pauseAnswer(project, false);
      } else if (project.status !== 'approved') {
        return notOpen(project);
      }
      change = { status: 'paused', reason, changedBy: caller.githubId, restored: false };
    } else {
      if (project.status !== 'paused') return pauseAnswer(project, false);
      change = adminResume(await statusHistory(env.DB, project.repo), caller.githubId);
    }
    const { restored, ...next } = change;
    const updated = await setProjectStatusFrom(env.DB, project, next, now);
    if (updated !== null) return pauseAnswer(updated, true, restored);
  }
  throw new Error(`${input.repo} kept changing status while an admin paused or resumed it.`);
}

/**
 * Adds a repo to the crawler's seed list, for the crawler to read whatever
 * its stars or last push. A repo on the do-not-list is refused, since the
 * crawler never reads one. A repo that is a project already, or one the
 * crawler put in the admin queue before, isn't added, and the answer says
 * why: the crawler reads a listed project each week, and an earlier find
 * again as its passes find it. Nothing is read from GitHub: the crawler
 * reads the repo when it queues it.
 */
export async function adminSeedRepo(
  caller: Caller,
  input: ToolInput<'admin_seed_repo'>,
  now: number,
): Promise<Outcome<'admin_seed_repo'>> {
  await requirePermission(caller, 'review_projects');
  const skip = (await crawlerSkips(env.DB, [input.repo])).get(input.repo.toLowerCase());
  if (skip === 'do_not_list') {
    return refuse(
      'repo_not_eligible',
      `${input.repo} is on the do-not-list, because its maintainers asked to be removed, so the crawler never reads it.`,
    );
  }
  if (skip !== undefined) return { ok: true, value: { repo: input.repo, added: false, leftAlone: skip } };
  const { seed, added } = await addSeed(env.DB, { repo: input.repo, addedBy: caller.githubId }, now);
  return { ok: true, value: { repo: seed.repo, added, leftAlone: null } };
}

/**
 * The do-not-list note for a removal: the admin's own, or else who asked
 * with request_removal and when, from the request that waits.
 */
async function removalNote(note: string | undefined, request: RemovalRequest | null): Promise<string | null> {
  if (note !== undefined) return note;
  if (request === null) return null;
  const asker = await getPerson(env.DB, request.requestedBy);
  const who = asker === null ? 'a maintainer' : `@${asker.login}`;
  return `Asked by ${who} with request_removal on ${iso(request.requestedAt)}.`;
}

/**
 * Removes a repo at its maintainers' request. It goes on the do-not-list
 * first. Every listing checks the list in the same statement as its write,
 * so from then on nothing lists the repo unless its maintainers register it.
 * A crawler find for it waiting in the queue is rejected, and its project is
 * rejected, with a reason its maintainers see. The rejection puts the repo on
 * the list again in the same transaction, so an approval that took it off
 * before the rejection landed leaves it on. A maintainer's request for it
 * waiting in the queue closes last, once the rejection landed, so a removal
 * that fails partway leaves the request waiting for the next try.
 */
export async function adminRemoveProject(
  caller: Caller,
  input: ToolInput<'admin_remove_project'>,
  now: number,
): Promise<Outcome<'admin_remove_project'>> {
  await requirePermission(caller, 'review_projects');
  const known = await getProject(env.DB, input.repo);
  const repo = known?.repo ?? input.repo;
  const request = await getWaitingRemoval(env.DB, repo);
  const entry = { repo, reason: await removalNote(input.note, request), addedBy: caller.githubId };
  await addToDoNotList(env.DB, entry, now);
  const waiting = await getWaitingCandidate(env.DB, repo);
  if (waiting !== null) {
    await decideCandidate(env.DB, waiting.id, { status: 'rejected', decidedBy: caller.githubId, reason: REMOVED_REASON }, now);
  }
  // A policy change for its listing has nothing left to list again from.
  await dropWaitingPolicyChange(env.DB, repo);
  const removed = await rejectAsRemoved(caller, repo, entry, now);
  await closeRemoval(env.DB, repo, { status: 'removed', by: caller.githubId }, now);
  return { ok: true, value: removed };
}

/** Rejects the repo's project, when it has one, with the reason its maintainers see, and answers with its status now. */
async function rejectAsRemoved(
  caller: Caller,
  repo: string,
  entry: { repo: string; reason: string | null; addedBy: number },
  now: number,
): Promise<{ repo: string; status: ProjectStatus | null }> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const project = await getProject(env.DB, repo);
    if (project === null) return { repo, status: null };
    if (project.status === 'rejected' && project.statusReason === REMOVED_REASON) {
      return { repo: project.repo, status: project.status };
    }
    const change = { status: 'rejected' as const, reason: REMOVED_REASON, changedBy: caller.githubId };
    const updated = await setProjectStatusFrom(env.DB, project, change, now, [
      doNotListWhenRejected(env.DB, { ...entry, repo: project.repo }, now),
    ]);
    if (updated !== null) return { repo: updated.repo, status: updated.status };
  }
  throw new Error(`${repo} kept changing status while it was removed.`);
}
