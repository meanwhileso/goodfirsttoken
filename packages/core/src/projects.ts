import { z } from 'zod';
import { epochMs, githubId, httpsUrl, labelName, repoName, trimmedText, wholeNumber } from './primitives';
import type { Refusal } from './refusals';
import { describeProblems, validate, type FieldProblem, type Validated } from './validation';

// Projects and their settings (spec section 4). Every setting is checked
// before it saves, and a problem names the setting it belongs to.

export const prModes = ['automatic', 'reviewed'] as const;
export type PrMode = (typeof prModes)[number];

export const claimPolicies = ['anyone', 'vouched'] as const;
export type ClaimPolicy = (typeof claimPolicies)[number];

/** Where a project is in the admin queue and after it. */
export const projectStatuses = ['pending', 'approved', 'rejected', 'paused'] as const;
export const projectStatusSchema = z.enum(projectStatuses);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** How a project got in: a maintainer registered it, or an admin listed it from its AI policy. */
export const projectSources = ['registered', 'policy'] as const;
export const projectSourceSchema = z.enum(projectSources);
export type ProjectSource = z.infer<typeof projectSourceSchema>;

/** What a project's own docs say about agent work, for a project listed from its policy. */
export const policyTiers = ['invites_agents', 'allows_with_conditions'] as const;
export const policyTierSchema = z.enum(policyTiers, {
  error: 'must be invites_agents or allows_with_conditions',
});

export const policySchema = z.object({
  quote: trimmedText(2000),
  url: httpsUrl,
  tier: policyTierSchema,
});
export type Policy = z.infer<typeof policySchema>;

export const MAX_TAGS = 20;
export const MAX_AGENT_NOTES = 2000;

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function firstRepeat(labels: readonly string[]): string | undefined {
  return labels.find((label, i) => labels.findIndex((other) => sameLabel(label, other)) !== i);
}

const labelList = z
  .array(labelName, {
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be a list of labels'),
  })
  .max(MAX_TAGS, `must list at most ${String(MAX_TAGS)} labels`)
  .superRefine((labels, ctx) => {
    const repeat = firstRepeat(labels);
    if (repeat !== undefined) ctx.addIssue({ code: 'custom', message: `lists "${repeat}" twice` });
  });

/**
 * The message for an object of the wrong type. Any other problem, like an
 * unknown field, keeps zod's own message, which names the field. The MCP SDK
 * reports those messages as they are.
 */
function wrongType(message: string) {
  return (issue: { code?: string }) => (issue.code === 'invalid_type' ? message : undefined);
}

/** A git trailer name, like `Assisted-by`. */
const trailerName = z
  .string({ error: 'must be a trailer name like Assisted-by, or null for none' })
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/, 'must be a trailer name like Assisted-by, or null for none');

export const MAX_PR_BODY_DISCLOSURE = 1000;

/**
 * How AI use is disclosed: a commit trailer, text the PR body must carry, or
 * both. The text is the project's own wording, like the line its PR template
 * asks for.
 */
export const disclosureSchema = z
  .strictObject(
    {
      trailer: trailerName.nullable(),
      prBody: trimmedText(MAX_PR_BODY_DISCLOSURE).nullable(),
    },
    { error: wrongType('must be an object with trailer and prBody') },
  )
  .refine((d) => d.trailer !== null || d.prBody !== null, {
    message: 'must use a commit trailer, text in the PR body, or both',
  });
export type Disclosure = z.infer<typeof disclosureSchema>;

// Each setting's own check, with no default, so a partial update never fills
// in a default over a value the project already has.
const settingFields = {
  tags: labelList.min(1, 'must list at least one label'),
  excludedTags: labelList,
  issueRepo: repoName.nullable(),
  prMode: z.enum(prModes, { error: 'must be automatic or reviewed' }),
  whoCanClaim: z.enum(claimPolicies, { error: 'must be anyone or vouched' }),
  disclosure: disclosureSchema,
  personWrittenDescription: z.boolean({ error: 'must be true or false' }),
  claUrl: httpsUrl.nullable(),
  agentNotes: z
    .string({ error: 'must be text' })
    .trim()
    .max(MAX_AGENT_NOTES, `must be at most ${MAX_AGENT_NOTES.toLocaleString('en-US')} characters`),
  claimsPerIssue: wholeNumber(1, 10),
  openPrsPerDonor: wholeNumber(1, 10),
};

export const settingKeys = Object.keys(settingFields) as (keyof typeof settingFields)[];
export const settingKeySchema = z.enum(settingKeys as [SettingKey, ...SettingKey[]]);
export type SettingKey = keyof typeof settingFields;

export const defaultDisclosure: Disclosure = {
  trailer: 'Assisted-by',
  prBody: 'Written with a coding agent through Good First Token.',
};

/**
 * A project's settings. Every one but `tags` has a default. `issueRepo` is
 * null when tagged issues live in the code repo, and `claUrl` is null when
 * the project has no CLA.
 */
export const projectSettingsSchema = z
  .strictObject(
    {
      tags: settingFields.tags,
      excludedTags: settingFields.excludedTags.default(() => []),
      issueRepo: settingFields.issueRepo.default(null),
      prMode: settingFields.prMode.default('reviewed'),
      whoCanClaim: settingFields.whoCanClaim.default('anyone'),
      disclosure: settingFields.disclosure.default(() => ({ ...defaultDisclosure })),
      personWrittenDescription: settingFields.personWrittenDescription.default(false),
      claUrl: settingFields.claUrl.default(null),
      agentNotes: settingFields.agentNotes.default(''),
      claimsPerIssue: settingFields.claimsPerIssue.default(3),
      openPrsPerDonor: settingFields.openPrsPerDonor.default(2),
    },
    { error: wrongType('must be an object of settings') },
  )
  .superRefine((settings, ctx) => {
    const both = settings.excludedTags.find((ex) => settings.tags.some((tag) => sameLabel(tag, ex)));
    if (both !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['excludedTags'],
        message: `lists "${both}", which is also a tag`,
      });
    }
  });

/** Settings as a maintainer or an agent sends them, with defaults left out. */
export type ProjectSettingsInput = z.input<typeof projectSettingsSchema>;
/** Settings as stored, with every default filled in. */
export type ProjectSettings = z.output<typeof projectSettingsSchema>;

/** A change to some settings. Settings left out keep their current value. */
export const projectSettingsPatchSchema = z
  .strictObject(settingFields, { error: wrongType('must be an object of settings') })
  .partial();
export type ProjectSettingsPatch = z.output<typeof projectSettingsPatchSchema>;

/** Checks a full set of settings and fills in the defaults. */
export function parseProjectSettings(input: unknown): Validated<ProjectSettings> {
  return validate(projectSettingsSchema, input, 'settings');
}

/**
 * Applies a change to a project's current settings and checks the result as a
 * whole, so a change can't leave a tag that is also excluded.
 */
export function updateProjectSettings(
  current: ProjectSettings,
  patch: unknown,
): Validated<ProjectSettings> {
  const checked = validate(projectSettingsPatchSchema, patch, 'settings');
  if (!checked.ok) return checked;
  // A key sent as undefined keeps its current value, like a key left out.
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checked.value) as [string, unknown][]) {
    if (value !== undefined) changes[key] = value;
  }
  return validate(projectSettingsSchema, { ...current, ...changes }, 'settings');
}

/** A refusal that names every setting that failed its check. */
export function invalidSettings(problems: readonly FieldProblem[]): Refusal {
  return { code: 'invalid_settings', message: `Settings not saved.\n${describeProblems(problems)}` };
}

/**
 * The settings whose value differs between two saves, in the order of the
 * settings table. With no earlier save, every setting counts as changed.
 */
export function changedSettings(before: ProjectSettings | null, after: ProjectSettings): SettingKey[] {
  if (before === null) return [...settingKeys];
  return settingKeys.filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]));
}

/** A value as JSON with every object's fields sorted, so equal values always match. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

/** The longest reason for rejecting or pausing a project. */
export const MAX_STATUS_REASON = 500;

/**
 * What a status needs with it. A rejection needs a reason, a pending or
 * approved project has none, and a pause may have one. Only a pause can name
 * no person, since Good First Token pauses on its own and never lists or
 * rejects a project without an admin.
 */
function checkStatus(
  change: { status: ProjectStatus; reason: string | null; changedBy: number | null },
  fields: { reason: string; changedBy: string },
  ctx: z.RefinementCtx,
): void {
  const { status, reason, changedBy } = change;
  if (status === 'rejected' && reason === null) {
    ctx.addIssue({ code: 'custom', path: [fields.reason], message: 'is required for a rejected project' });
  }
  if ((status === 'pending' || status === 'approved') && reason !== null) {
    ctx.addIssue({ code: 'custom', path: [fields.reason], message: `must be null for a project that is ${status}` });
  }
  if (status !== 'paused' && changedBy === null) {
    ctx.addIssue({ code: 'custom', path: [fields.changedBy], message: 'is required unless the project is paused' });
  }
}

/**
 * A stored project with its current settings. `settingsVersion` counts the
 * saves of its settings, starting at 1, and every save is kept.
 */
export const projectRecordSchema = z
  .object({
    /** The code repo. */
    repo: repoName,
    status: projectStatusSchema,
    /** Why it was rejected or paused. */
    statusReason: trimmedText(MAX_STATUS_REASON).nullable(),
    /** Who gave the project its current status, or null for a pause Good First Token made on its own. */
    statusChangedBy: githubId.nullable(),
    statusChangedAt: epochMs,
    source: projectSourceSchema,
    /** The policy it was listed from. Null for a registered project. */
    policy: policySchema.nullable(),
    /** The maintainer who registered it, or the admin who listed it. */
    addedBy: githubId,
    addedAt: epochMs,
    settings: projectSettingsSchema,
    settingsVersion: z.int().min(1),
  })
  .superRefine((project, ctx) => {
    const problem = (field: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [field], message });
    };
    if (project.source === 'policy' && project.policy === null) {
      problem('policy', 'is required for a project listed from its policy');
    }
    if (project.source === 'registered' && project.policy !== null) {
      problem('policy', 'must be null for a registered project');
    }
    checkStatus(
      { status: project.status, reason: project.statusReason, changedBy: project.statusChangedBy },
      { reason: 'statusReason', changedBy: 'statusChangedBy' },
      ctx,
    );
  });
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

/**
 * One change of a project's status, with who made it and when. Adding the
 * project is the first. `changedBy` is null for a pause Good First Token
 * made on its own.
 */
export const projectStatusChangeSchema = z
  .object({
    repo: repoName,
    status: projectStatusSchema,
    reason: trimmedText(MAX_STATUS_REASON).nullable(),
    changedBy: githubId.nullable(),
    changedAt: epochMs,
  })
  .superRefine((change, ctx) => {
    checkStatus(change, { reason: 'reason', changedBy: 'changedBy' }, ctx);
  });
export type ProjectStatusChange = z.infer<typeof projectStatusChangeSchema>;

/** One save of a project's settings: who saved them, when, and what changed. */
export const settingsVersionSchema = z.object({
  repo: repoName,
  version: z.int().min(1),
  /** The settings as this save left them. */
  settings: projectSettingsSchema,
  /** The settings this save changed from the one before. The first save sets every one. */
  changed: z.array(settingKeySchema),
  changedBy: githubId,
  changedAt: epochMs,
});
export type SettingsVersion = z.infer<typeof settingsVersionSchema>;
