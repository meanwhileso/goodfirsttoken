import { z } from 'zod';
import { count, githubLogin, id, isoTime, labelName, repoName, trimmedText } from '../primitives';
import {
  policySchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusSchema,
  type Policy,
} from '../projects';
import { defineTool } from './spec';
import { indent, lines, numbered, renderSettings, when } from './text';

// The admin tools (spec section 4), listed only for admins.

const queueItemKinds = ['registration', 'candidate'] as const;

const queueItemSchema = z.object({
  id,
  /** A maintainer's registration, or a crawler find. */
  kind: z.enum(queueItemKinds),
  repo: repoName,
  /** The maintainer who registered it, or null for a crawler find. */
  requestedBy: githubLogin.nullable(),
  requestedAt: isoTime,
  facts: z.object({
    stars: count,
    createdAt: isoTime,
    pushedAt: isoTime,
    ownerCreatedAt: isoTime,
  }),
  /** The settings the maintainer chose, or the ones the crawler suggests. */
  settings: projectSettingsSchema,
  /** The policy text that welcomes agent work, when there is one. */
  policy: policySchema.nullable(),
  /** Labels that could mean "ready for outside help", with their open issue counts. */
  suggestedTags: z.array(z.object({ name: labelName, openIssues: count })),
});
type QueueItem = z.infer<typeof queueItemSchema>;

function describePolicy(policy: Policy): string {
  const tier = policy.tier === 'invites_agents' ? 'invites agents' : 'allows with conditions';
  return `policy (${tier}): "${policy.quote}" ${policy.url}`;
}

function renderQueueItem(item: QueueItem): string {
  return lines(
    `${item.kind} · ${item.repo} · id ${item.id}`,
    item.requestedBy
      ? `from @${item.requestedBy} on ${when(item.requestedAt)}`
      : `found on ${when(item.requestedAt)}`,
    `${item.facts.stars.toLocaleString('en-US')} stars · created ${item.facts.createdAt.slice(0, 10)} · last push ${item.facts.pushedAt.slice(0, 10)} · owner account since ${item.facts.ownerCreatedAt.slice(0, 10)}`,
    item.policy && describePolicy(item.policy),
    item.suggestedTags.length > 0 &&
      `labels that could mean ready for help: ${item.suggestedTags
        .map((tag) => `${tag.name} (${tag.openIssues.toLocaleString('en-US')} open)`)
        .join(', ')}`,
    indent(renderSettings(item.settings), 2),
  );
}

export const adminQueue = defineTool({
  audience: 'admin',
  description: "List maintainers' registrations and crawler finds waiting for an admin.",
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
          'Decide each with admin_decide. A rejection needs a reason, which the maintainer sees.',
        ),
});

export const adminDecide = defineTool({
  audience: 'admin',
  description:
    'Approve or reject a queue item. A rejection needs a reason, which the maintainer sees. For a crawler find, pass the settings and tags you confirmed.',
  input: z
    .object({
      id,
      decision: z.enum(['approve', 'reject']),
      reason: trimmedText(500).optional(),
      settings: projectSettingsSchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (input.decision === 'reject' && input.reason === undefined) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'is required to reject' });
      }
    }),
  output: z.object({ repo: repoName, status: projectStatusSchema }),
  text: (out) =>
    out.status === 'approved'
      ? `Approved ${out.repo}. It is listed now.`
      : `${out.repo} is ${out.status}. The reason is kept with it.`,
});

export const adminAddProject = defineTool({
  audience: 'admin',
  description:
    "List a project from its written AI policy, with the quote, its link, the tier, the settings, and the project's own tags.",
  input: z.object({ repo: repoName, policy: policySchema, settings: projectSettingsSchema }),
  output: z.object({ repo: repoName, status: projectStatusSchema, source: projectSourceSchema }),
  text: (out) => `Listed ${out.repo} from its AI policy. Status: ${out.status}.`,
});

export const adminBlockDonor = defineTool({
  audience: 'admin',
  description:
    'Block a donor, or unblock one with blocked: false. A blocked donor gets no new claims, and their live posts are hidden.',
  input: z.object({
    login: githubLogin,
    blocked: z.boolean().default(true),
    reason: trimmedText(500).optional(),
  }),
  output: z.object({ login: githubLogin, blocked: z.boolean() }),
  text: (out) =>
    out.blocked
      ? `Blocked @${out.login}. They get no new claims, and their live posts are hidden.`
      : `Unblocked @${out.login}.`,
});

export const adminPauseProject = defineTool({
  audience: 'admin',
  description: 'Pause any project, with a reason its maintainers see, or resume it with paused: false.',
  input: z
    .object({
      repo: repoName,
      paused: z.boolean().default(true),
      reason: trimmedText(500).optional(),
    })
    .superRefine((input, ctx) => {
      if (input.paused && input.reason === undefined) {
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'is required to pause' });
      }
    }),
  output: z.object({ repo: repoName, status: projectStatusSchema }),
  text: (out) =>
    out.status === 'paused'
      ? `Paused ${out.repo}. Agents get no new claims on it.`
      : `Resumed ${out.repo}. Status: ${out.status}.`,
});
