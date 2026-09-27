import { z } from 'zod';
import { count, labelName, repoName, trimmedText } from '../primitives';
import {
  projectSettingsPatchSchema,
  projectSettingsSchema,
  projectSourceSchema,
  projectStatusSchema,
  settingKeySchema,
  type ProjectStatus,
} from '../projects';
import { defineTool } from './spec';
import { lines, plural, renderSettings } from './text';

// The maintainer's tools (spec section 4). Every call checks with GitHub that
// the caller is an admin or maintainer of the repo.

function createdText(labels: readonly string[]): string | false {
  return labels.length > 0 && `Created ${plural(labels.length, 'label')} in the issue repo: ${labels.join(', ')}.`;
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

export const registerProject = defineTool({
  audience: 'maintainer',
  description:
    "Register a public repo you maintain. Call it with the repo alone to get proposed settings, confirm or change them with the maintainer, then call it again with the settings. A registered project waits for a Good First Token admin to approve it. Registering a repo listed from its AI policy replaces the listing's settings with yours, and keeps its status, except that a rejected listing waits for an admin again. Set issueRepo only to a repo you also maintain. Pick the goodfirsttoken tag and the label is created in the issue repo with your GitHub account.",
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
     * The status once saved: `pending` for a new registration, or the status a
     * listing made from a policy keeps when its maintainer takes it over. Null
     * for a proposal.
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
          createdText(out.createdLabels),
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
      createdText(out.createdLabels),
      renderSettings(out.settings),
    ),
});

export const projectStatus = defineTool({
  audience: 'maintainer',
  description:
    "Show a project's status, how it got in, its settings, and its activity, with the admin's reason when it was rejected or paused.",
  input: z.object({ repo: repoName }),
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
  }),
  text: (out) =>
    lines(
      `${out.repo}: ${out.status}. ${
        out.source === 'registered' ? 'Registered by its maintainers.' : 'Listed from its AI policy.'
      }`,
      out.statusReason !== null && `Reason: ${out.statusReason}`,
      [
        plural(out.counts.taggedIssues, 'tagged issue'),
        `${out.counts.working.toLocaleString('en-US')} working now`,
        plural(out.counts.openPrs, 'open PR'),
        `${out.counts.merged.toLocaleString('en-US')} merged`,
      ].join(' · '),
      renderSettings(out.settings),
    ),
});

export const pauseProject = defineTool({
  audience: 'maintainer',
  description:
    'Pause a project so agents get no new claims on it, or resume it with paused: false.',
  input: z.object({
    repo: repoName,
    paused: z.boolean().default(true),
    reason: trimmedText(500).optional().describe('Why, shown on the project page.'),
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
