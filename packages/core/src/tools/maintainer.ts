import { z } from 'zod';
import { ISSUE_REFRESH_INTERVAL_MS } from '../issues';
import { count, githubLogin, isoTime, labelName, repoName, trimmedText } from '../primitives';
import {
  projectSettingsPatchSchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusSchema,
  settingKeySchema,
  type ProjectSettings,
  type ProjectStatus,
} from '../projects';
import { removalReason } from '../removals';
import { delistingSchema, delistingText } from './shared';
import { defineTool } from './spec';
import { lines, plural, renderSettings, when } from './text';

// The maintainer's tools (spec section 4). Every call checks with GitHub that
// the caller is an admin or maintainer of the repo.

/** The labels created, named with the repo they went into: the issue repo, or the code repo. */
function createdText(labels: readonly string[], repo: string, settings: ProjectSettings): string | false {
  const where = settings.issueRepo ?? repo;
  return labels.length > 0 && `Created ${plural(labels.length, 'label')} in ${where}: ${labels.join(', ')}.`;
}

function registeredText(repo: string, status: ProjectStatus): string {
  switch (status) {
    case 'pending':
      return `Registered ${repo}. Status: pending. A Good First Token admin reviews it before agents can claim its issues. See the result with project_status.`;
    case 'approved':
      return `Registered ${repo}. Status: approved. Your settings replace the ones it was listed with, and apply now.`;
    case 'paused':
      return `Registered ${repo}. Status: paused. Your settings replace the ones it was listed with. Agents get no new claims on it until the pause is lifted.`;
    case 'rejected':
      return `Registered ${repo}. Status: rejected. See the reason with project_status.`;
  }
}

/** Who can lift a pause. */
const resumers = ['maintainers', 'admins'] as const;

/**
 * What asking project_status to read the tagged issues again did: read them
 * all, read some before it stopped, paused the project because GitHub no
 * longer shows its repo as public and open, or read no issue. It reads none
 * when it stops before the first, as when little of the server's GitHub
 * budget is left, when an earlier refresh ran less than 10 minutes ago,
 * when a scheduled sync is reading the project, when the project isn't
 * approved, or when the server has no token for reading GitHub.
 */
export const refreshOutcomes = [
  'read',
  'partly_read',
  'not_read',
  'paused',
  'too_soon',
  'busy',
  'not_approved',
  'not_set_up',
] as const;
export type RefreshOutcome = (typeof refreshOutcomes)[number];

function refreshText(outcome: RefreshOutcome): string {
  const minutes = String(ISSUE_REFRESH_INTERVAL_MS / 60_000);
  switch (outcome) {
    case 'read':
      return 'Read its tagged issues from GitHub just now.';
    case 'partly_read':
      return 'Read some of its tagged issues from GitHub just now. The next scheduled sync reads the rest.';
    case 'not_read':
      return "Read none of its tagged issues from GitHub: little of the server's GitHub budget is left, or GitHub didn't answer as it should. The next scheduled sync reads them.";
    case 'paused':
      return "Reading GitHub showed its repo is no longer public and open, so Good First Token paused it. Only Good First Token's admins can resume it.";
    case 'too_soon':
      return `A refresh ran less than ${minutes} minutes ago, so this one read nothing from GitHub.`;
    case 'busy':
      return "A scheduled sync is reading its tagged issues from GitHub now, so they weren't read again. Ask again when it's done.";
    case 'not_approved':
      return "Only an approved project's tagged issues are read from GitHub, so they weren't read.";
    case 'not_set_up':
      return "This server has no token for reading GitHub, so its tagged issues weren't read.";
  }
}

export const registerProject = defineTool({
  audience: 'maintainer',
  description:
    "Register a public repo you maintain. Call it with the repo alone to get proposed settings, confirm or change them with the maintainer, then call it again with the settings. A registered project waits for a Good First Token admin to approve it. A rejected registration can be registered again, with new settings, and waits for an admin again. Registering a repo listed from its AI policy replaces the listing's settings with yours, and keeps its status, except that a rejected listing waits for an admin again. Set issueRepo only to a repo you also maintain. Pick the goodfirsttoken tag and the label is created in the issue repo with your GitHub account.",
  // not_maintainer and repo_not_eligible come from the code repo or the
  // issue repo, and label_not_created from the label.
  refusals: ['not_maintainer', 'repo_not_eligible', 'already_registered', 'label_not_created'],
  input: z.object({
    repo: repoName,
    settings: projectSettingsSchema
      .optional()
      .describe('The settings the maintainer confirmed. Leave out to get a proposal.'),
  }),
  output: z.object({
    repo: repoName,
    /** False for a proposal. Nothing is saved until the settings come back. */
    saved: z.boolean(),
    /**
     * The status once saved: `pending` for a new registration or one
     * registered again, or the status a listing made from a policy keeps when
     * its maintainer takes it over. Null for a proposal.
     */
    status: projectStatusSchema.nullable(),
    settings: projectSettingsSchema,
    /** Why the server proposed a value, from what it read in the repo. */
    reasons: z.array(z.object({ setting: settingKeySchema, reason: z.string() })),
    /** Labels created in the issue repo with the maintainer's own login. */
    createdLabels: z.array(labelName),
  }),
  text: (out) =>
    out.saved
      ? lines(
          registeredText(out.repo, out.status ?? 'pending'),
          createdText(out.createdLabels, out.repo, out.settings),
          renderSettings(out.settings),
        )
      : lines(
          `Proposed settings for ${out.repo}. Nothing is saved yet.`,
          renderSettings(out.settings, out.reasons),
          'Confirm or change them with the maintainer, then call register_project again with the settings.',
        ),
});

export const updateProject = defineTool({
  audience: 'maintainer',
  description:
    "Change some of a registered project's settings. Settings left out keep their value. Changes apply at once and show on the project page with who made them. Set issueRepo only to a repo you also maintain. Pick the goodfirsttoken tag and the label is created in the issue repo with your GitHub account. A project listed from its AI policy is refused: take it over with register_project first.",
  refusals: [
    'not_maintainer',
    'not_found',
    'listed_from_policy',
    'invalid_settings',
    'repo_not_eligible',
    'label_not_created',
  ],
  input: z.object({ repo: repoName, settings: projectSettingsPatchSchema }),
  output: z.object({
    repo: repoName,
    status: projectStatusSchema,
    settings: projectSettingsSchema,
    /** The settings whose value changed. */
    changed: z.array(settingKeySchema),
    /** Labels created in the issue repo with the maintainer's own login. */
    createdLabels: z.array(labelName),
  }),
  text: (out) =>
    lines(
      out.changed.length > 0
        ? `Updated ${out.repo}: ${out.changed.join(', ')}. The changes apply now.`
        : `No settings changed on ${out.repo}.`,
      createdText(out.createdLabels, out.repo, out.settings),
      renderSettings(out.settings),
    ),
});

export const projectStatus = defineTool({
  audience: 'maintainer',
  description: `Show a project's status, how it got in, its settings, and its activity, with the admin's reason when it was rejected or paused. When Good First Token's sync delisted the project, because GitHub showed its repo or issue repo private, archived, blocked, or gone, it says which repo, what GitHub showed, and what brings the page back. The tagged issues are counted as the last sync read them from GitHub. Set refresh to read an approved project's tagged issues from GitHub first, at most once every ${String(ISSUE_REFRESH_INTERVAL_MS / 60_000)} minutes, and not while a scheduled sync is reading them.`,
  refusals: ['not_maintainer', 'not_found'],
  input: z.object({
    repo: repoName,
    refresh: z
      .boolean()
      .default(false)
      .describe('Read the tagged issues from GitHub before answering, after a maintainer tagged or untagged some.'),
  }),
  output: z.object({
    repo: repoName,
    status: projectStatusSchema,
    source: projectSourceSchema,
    /** Why it was rejected or paused, or null. */
    statusReason: z.string().nullable(),
    settings: projectSettingsSchema,
    counts: z.object({
      taggedIssues: count,
      working: count,
      openPrs: count,
      merged: count,
    }),
    /** When the sync last finished reading every tagged issue from GitHub, or null before it has. */
    issuesReadAt: isoTime.nullable(),
    /** What asking to read the tagged issues again did, or null when the call didn't ask. */
    refresh: z.enum(refreshOutcomes).nullable(),
    /**
     * Why the sync delisted an approved or paused project, so it has no page
     * and takes no claims, or null when it didn't.
     */
    delisted: delistingSchema.nullable().default(null),
  }),
  text: (out) =>
    lines(
      `${out.repo}: ${out.status}. ${
        out.source === 'registered' ? 'Registered by its maintainers.' : 'Listed from its AI policy.'
      }`,
      out.statusReason !== null && `Reason: ${out.statusReason}`,
      out.delisted !== null && delistingText(out.delisted),
      out.refresh !== null && refreshText(out.refresh),
      [
        plural(out.counts.taggedIssues, 'tagged issue'),
        `${out.counts.working.toLocaleString('en-US')} working now`,
        plural(out.counts.openPrs, 'open PR'),
        `${out.counts.merged.toLocaleString('en-US')} merged`,
      ].join(' · '),
      out.issuesReadAt === null
        ? "Its tagged issues haven't all been read from GitHub yet."
        : `Tagged issues last read from GitHub ${when(out.issuesReadAt)}.`,
      renderSettings(out.settings),
    ),
});

export const pauseProject = defineTool({
  audience: 'maintainer',
  description:
    'Pause a project so agents get no new claims on it, or resume it with paused: false.',
  // A resume needs the issue repo too, so it can be refused for it.
  refusals: ['not_maintainer', 'not_found', 'project_not_open', 'not_admin', 'repo_not_eligible'],
  input: z.object({
    repo: repoName,
    paused: z.boolean().default(true),
    reason: trimmedText(500).optional().describe('Why, which project_status shows.'),
  }),
  output: z.object({
    repo: repoName,
    status: projectStatusSchema,
    /** Whether this call paused or resumed the project. False when it was already as asked. */
    changed: z.boolean(),
    /**
     * Who can resume a paused project: its maintainers, or only Good First
     * Token's admins, for a pause an admin or Good First Token made. Null
     * when the project isn't paused.
     */
    resumableBy: z.enum(resumers).nullable(),
  }),
  text: (out) => {
    if (out.status !== 'paused') {
      return out.changed
        ? `Resumed ${out.repo}. Status: ${out.status}.`
        : `${out.repo} isn't paused, so nothing changed. Status: ${out.status}.`;
    }
    const until =
      out.resumableBy === 'admins'
        ? "Agents get no new claims on it until one of Good First Token's admins resumes it."
        : 'Agents get no new claims on it until you resume it with pause_project and paused: false.';
    return `${out.changed ? `Paused ${out.repo}.` : `${out.repo} was already paused.`} ${until}`;
  },
});

/** What request_removal says it did, from what it answered. */
function removalText(out: {
  repo: string;
  waiting: boolean;
  onDoNotList: boolean;
  requestedBy: string | null;
  requestedAt: string | null;
  changed: boolean;
  lastWithdrawn: { by: string; at: string } | null;
}): string {
  return lines(
    removalOutcome(out),
    out.lastWithdrawn !== null &&
      `@${out.lastWithdrawn.by} withdrew your last request to remove ${out.repo}, on ${when(out.lastWithdrawn.at)}.`,
  );
}

function removalOutcome(out: Parameters<typeof removalText>[0]): string {
  const who = out.requestedBy === null ? 'A maintainer' : `@${out.requestedBy}`;
  const on = out.requestedAt === null ? '' : ` on ${when(out.requestedAt)}`;
  if (out.waiting) {
    return out.changed
      ? `Asked Good First Token's admins to remove ${out.repo}. The request waits for an admin. Once one removes it, it is on the do-not-list, and nothing lists it again unless one of its maintainers registers it. Until then an approved project takes new claims: pause it with pause_project to stop them now.`
      : `${who} asked to remove ${out.repo}${on}, and that request still waits for an admin. Nothing changed.`;
  }
  if (out.changed) {
    return `Withdrew the request ${who} made${on} to remove ${out.repo}. It leaves the admin queue, and nothing else changed.`;
  }
  return out.onDoNotList
    ? `${out.repo} is on the do-not-list already, so it was removed before, and nothing lists it again unless one of its maintainers registers it. No request waits, and nothing changed.`
    : `No request to remove ${out.repo} waits, so nothing changed.`;
}

export const requestRemoval = defineTool({
  audience: 'maintainer',
  description:
    "Ask Good First Token's admins to remove a repo you maintain, with your reason, which only they read, or withdraw a request that waits with withdraw: true. It works for a public repo you are an admin or maintainer of on GitHub, whether or not it is a project: registered, listed from its AI policy, pending, approved, paused, or rejected. Name a project as project_status names it. The request waits for an admin, who removes the repo: it goes on the do-not-list, its project is rejected, and nothing lists it again unless one of its maintainers registers it. While it waits, no admin can list the repo or approve a registration of it. While one request waits, another changes nothing. Any maintainer of the repo can withdraw it, and when someone else withdrew your last request, the answer says who and when. A repo on the do-not-list already needs no request, unless a registration of it waits, since approving that would take it off the list: then the request is made. The request pauses nothing: pause an approved project with pause_project to stop new claims now.",
  // A repo GitHub doesn't show the caller, or blocks, is refused with
  // not_maintainer by the permission check, like every maintainer's tool.
  // Asking and withdrawing take the same check.
  refusals: ['not_maintainer'],
  input: z
    .object({
      repo: repoName,
      reason: removalReason
        .optional()
        .describe(
          "Why the maintainers want the repo removed, in a sentence or two. Only Good First Token's admins read it. Needed to ask.",
        ),
      withdraw: z
        .boolean()
        .default(false)
        .describe('True to withdraw the request that waits for the repo. It needs no reason.'),
    })
    .superRefine((input, ctx) => {
      if (!input.withdraw && input.reason === undefined) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'is required to ask' });
      }
    }),
  output: z.object({
    repo: repoName,
    /** Whether a request to remove the repo waits for an admin now. */
    waiting: z.boolean(),
    /** Whether the repo is on the do-not-list, because it was removed before. */
    onDoNotList: z.boolean(),
    /**
     * Who asked for the request that waits, or for the one this call
     * withdrew, and when. Null when there is none.
     */
    requestedBy: githubLogin.nullable(),
    requestedAt: isoTime.nullable(),
    /** True when this call made or withdrew a request. False when nothing changed. */
    changed: z.boolean(),
    /**
     * When the caller's last request for the repo, before this call, was
     * withdrawn by someone else: who withdrew it, and when. Null otherwise.
     */
    lastWithdrawn: z.object({ by: githubLogin, at: isoTime }).nullable().default(null),
  }),
  text: removalText,
});
