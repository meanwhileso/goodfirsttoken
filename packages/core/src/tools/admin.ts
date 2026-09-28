import { z } from 'zod';
import { MAX_CRAWL_REASON, suggestedTagSchema } from '../crawl';
import { MAX_BLOCK_REASON } from '../people';
import { count, githubLogin, id, isoTime, repoName, trimmedText } from '../primitives';
import {
  MAX_STATUS_REASON,
  policySchema,
  policyTierSchema,
  projectSettingsPatchSchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusSchema,
  type Policy,
  type ProjectSettings,
  type ProjectSettingsPatch,
} from '../projects';
import { defineTool } from './spec';
import { indent, lines, numbered, renderSettings, when } from './text';

// The admin tools (spec section 4), listed only for admins.

const queueItemKinds = ['registration', 'candidate'] as const;

/** What GitHub says about a repo, for an admin to weigh. */
const repoFactsSchema = z.object({
  stars: count,
  createdAt: isoTime,
  pushedAt: isoTime,
  /** When the repo owner's account was made. */
  ownerCreatedAt: isoTime,
});

const queueItemSchema = z.object({
  id,
  /** A maintainer's registration, or a crawler find. */
  kind: z.enum(queueItemKinds),
  repo: repoName,
  /** The maintainer who registered it, or null for a crawler find. */
  requestedBy: githubLogin.nullable(),
  requestedAt: isoTime,
  /** The repo's facts from GitHub, or null when GitHub didn't give them. */
  facts: repoFactsSchema.nullable(),
  /**
   * Why the facts are null: `not_public` when GitHub showed no public repo by
   * that name, and `no_answer` when GitHub didn't answer, as on a rate limit.
   * Null when the facts are there.
   */
  factsMissing: z.enum(['not_public', 'no_answer']).nullable(),
  /**
   * The settings the maintainer chose, or the ones the crawler suggests. A
   * crawler find can leave out any setting, tags included, and the admin
   * picks the tags.
   */
  settings: projectSettingsPatchSchema,
  /** The policy text that welcomes agent work, when there is one. */
  policy: policySchema.nullable(),
  /** Labels that could mean "ready for outside help", with their open issue counts. */
  suggestedTags: z.array(suggestedTagSchema),
  /** True when the repo is on the do-not-list, because its maintainers asked to be removed. */
  onDoNotList: z.boolean(),
});
type QueueItem = z.infer<typeof queueItemSchema>;

function describePolicy(policy: Policy): string {
  const tier = policy.tier === 'invites_agents' ? 'invites agents' : 'allows with conditions';
  return `policy (${tier}): "${policy.quote}" ${policy.url}`;
}

/** Suggested settings with every one left out at its default, and no tags when none were suggested. */
function withDefaults(settings: ProjectSettingsPatch): ProjectSettings {
  const defaults = projectSettingsSchema.parse({ tags: ['none'] });
  // A setting sent as undefined keeps its default, like one left out.
  const entries: [string, unknown][] = Object.entries(settings);
  const given = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  return { ...defaults, tags: [], ...given };
}

/**
 * What an item on the do-not-list says. A registration of one waits on the
 * list, and approving it takes the repo off.
 */
export function doNotListNote(kind: QueueItem['kind']): string {
  const then =
    kind === 'registration' ? 'Approving this registration takes it off.' : 'Only they can list it again, by registering it.';
  return `Its maintainers asked to be removed, so it is on the do-not-list. ${then}`;
}

function renderQueueItem(item: QueueItem): string {
  const facts = item.facts;
  return lines(
    `${item.kind} · ${item.repo} · id ${item.id}`,
    item.requestedBy
      ? `from @${item.requestedBy} on ${when(item.requestedAt)}`
      : `found on ${when(item.requestedAt)}`,
    facts
      ? `${facts.stars.toLocaleString('en-US')} stars · created ${facts.createdAt.slice(0, 10)} · last push ${facts.pushedAt.slice(0, 10)} · owner account since ${facts.ownerCreatedAt.slice(0, 10)}`
      : item.factsMissing === 'no_answer'
        ? `GitHub didn't answer when asked about ${item.repo}. Read the queue again for its facts.`
        : `GitHub showed no public repo named ${item.repo} when asked.`,
    item.onDoNotList && doNotListNote(item.kind),
    item.policy && describePolicy(item.policy),
    item.suggestedTags.length > 0 &&
      `labels that could mean ready for help: ${item.suggestedTags
        .map((tag) => `${tag.name} (${tag.openIssues.toLocaleString('en-US')} open)`)
        .join(', ')}`,
    item.kind === 'candidate'
      ? lines('suggested settings, the rest at their defaults:', indent(renderSettings(withDefaults(item.settings)), 2))
      : indent(renderSettings(withDefaults(item.settings)), 2),
  );
}

export const adminQueue = defineTool({
  audience: 'admin',
  description:
    "List maintainers' registrations and crawler finds waiting for an admin, with each repo's facts from GitHub.",
  refusals: ['not_admin'],
  input: z.object({
    kind: z.enum(['all', ...queueItemKinds]).default('all'),
  }),
  output: z.object({ items: z.array(queueItemSchema) }),
  text: (out) =>
    out.items.length === 0
      ? 'Nothing waiting.'
      : lines(
          `${String(out.items.length)} waiting:`,
          numbered(out.items, renderQueueItem),
          'Decide each with admin_decide. A rejection needs a reason, which a registering maintainer sees.',
        ),
});

export const adminDecide = defineTool({
  audience: 'admin',
  description:
    "Approve or reject a queue item by its id. A rejection needs a reason, which the maintainer sees with project_status. A registration keeps the settings its maintainer chose. For a crawler find, pass the policy tier and the settings you confirmed: settings left out take the crawler's suggestion, then their default, and the tags are required.",
  // A crawler find is approved by listing it from its policy, so it can be
  // refused the way admin_add_project is.
  refusals: ['not_admin', 'invalid_input', 'not_found', 'invalid_settings', 'repo_not_eligible', 'already_registered'],
  input: z
    .object({
      id,
      decision: z.enum(['approve', 'reject']),
      reason: trimmedText(MAX_STATUS_REASON).optional(),
      tier: policyTierSchema
        .optional()
        .describe('For a crawler find, the policy tier you confirmed or changed.'),
      settings: projectSettingsPatchSchema
        .optional()
        .describe("For a crawler find, the settings you confirmed. Left out, a setting takes the crawler's suggestion."),
    })
    .superRefine((input, ctx) => {
      if (input.decision === 'reject' && input.reason === undefined) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'is required to reject' });
      }
    }),
  output: z.object({ repo: repoName, kind: z.enum(queueItemKinds), status: projectStatusSchema }),
  text: (out) => {
    if (out.status === 'rejected') {
      return out.kind === 'registration'
        ? `Rejected ${out.repo}. Its maintainers see the reason with project_status.`
        : `Rejected the crawler find ${out.repo}. It leaves the queue.`;
    }
    return out.status === 'approved'
      ? `Approved ${out.repo}. It is listed now.`
      : `Approved ${out.repo}. Its listing is ${out.status}.`;
  },
});

export const adminAddProject = defineTool({
  audience: 'admin',
  description:
    "List a public repo from its written AI policy, with the quote, its link, the tier, the settings, and the project's own tags. It is listed at once, with the settings sent and the rest at their defaults, and it needs its tags. Listing a repo already listed from its policy replaces that listing's policy, changes only the settings sent, and keeps its status. A repo its maintainers registered, or one on the do-not-list, is refused.",
  refusals: ['not_admin', 'repo_not_eligible', 'already_registered', 'invalid_settings'],
  input: z.object({
    repo: repoName,
    policy: policySchema,
    settings: projectSettingsPatchSchema.describe(
      'The settings to list it with. A new listing needs its tags. Listing it again, settings left out keep their value.',
    ),
  }),
  output: z.object({
    repo: repoName,
    status: projectStatusSchema,
    source: projectSourceSchema,
    /** True when it listed the repo again, over an earlier listing from its policy. */
    updated: z.boolean(),
  }),
  text: (out) =>
    out.updated
      ? `Updated the listing of ${out.repo} from its AI policy. Status: ${out.status}.`
      : `Listed ${out.repo} from its AI policy. Status: ${out.status}.`,
});

export const adminBlockDonor = defineTool({
  audience: 'admin',
  description:
    'Block a donor, or unblock one with blocked: false. A blocked donor gets no new claims, and their live posts are hidden.',
  refusals: ['not_admin', 'not_found'],
  input: z.object({
    login: githubLogin,
    blocked: z.boolean().default(true),
    reason: trimmedText(MAX_BLOCK_REASON).optional(),
  }),
  output: z.object({ login: githubLogin, blocked: z.boolean() }),
  text: (out) =>
    out.blocked
      ? `Blocked @${out.login}. They get no new claims, and their live posts are hidden.`
      : `Unblocked @${out.login}.`,
});

export const adminPauseProject = defineTool({
  audience: 'admin',
  description:
    'Pause an approved project, with a reason its maintainers see, or resume any paused project with paused: false. A pause by an admin stays until an admin lifts it, and pausing a project its maintainers paused makes it yours.',
  refusals: ['not_admin', 'not_found', 'project_not_open'],
  input: z
    .object({
      repo: repoName,
      paused: z.boolean().default(true),
      reason: trimmedText(MAX_STATUS_REASON).optional(),
    })
    .superRefine((input, ctx) => {
      if (input.paused && input.reason === undefined) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'is required to pause' });
      }
    }),
  output: z.object({
    repo: repoName,
    status: projectStatusSchema,
    /** Whether this call paused or resumed the project. False when it was already as asked. */
    changed: z.boolean(),
  }),
  text: (out) => {
    if (out.status === 'paused') {
      return out.changed
        ? `Paused ${out.repo}. Agents get no new claims on it until an admin resumes it.`
        : `${out.repo} was already paused by an admin, with that reason. Nothing changed.`;
    }
    return out.changed
      ? `Resumed ${out.repo}. Status: ${out.status}.`
      : `${out.repo} isn't paused, so nothing changed. Status: ${out.status}.`;
  },
});

export const adminRemoveProject = defineTool({
  audience: 'admin',
  description:
    "Remove a repo at its maintainers' request. It goes on the do-not-list, its project is rejected with a reason its maintainers see, and a crawler find for it waiting in the queue is rejected. Nothing lists it again unless a maintainer registers it.",
  refusals: ['not_admin'],
  input: z.object({
    repo: repoName,
    note: trimmedText(MAX_CRAWL_REASON)
      .optional()
      .describe('Where and how the maintainers asked, for the record. Only admins see it.'),
  }),
  output: z.object({
    repo: repoName,
    /** The project's status now, or null when the repo wasn't a project. */
    status: projectStatusSchema.nullable(),
  }),
  text: (out) =>
    lines(
      `Removed ${out.repo} at its maintainers' request. It is on the do-not-list, so nothing lists it again unless a maintainer registers it.`,
      out.status === null && `${out.repo} wasn't a project, so the do-not-list is all that changed.`,
    ),
});
