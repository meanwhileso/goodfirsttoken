import type { z } from 'zod';
import { refusalSchema, type Refusal } from '../refusals';
import {
  adminAddProject,
  adminBlockDonor,
  adminDecide,
  adminPauseProject,
  adminQueue,
  adminRemoveProject,
  adminSeedRepo,
} from './admin';
import {
  claimIssue,
  myWork,
  openPr,
  postUpdate,
  releaseClaim,
  setInterests,
  startSession,
  submitWork,
  suggestIssues,
} from './donor';
import { pauseProject, projectStatus, registerProject, requestRemoval, updateProject } from './maintainer';
import type { ToolSpec } from './spec';

/** Every MCP tool in spec section 7, by name. */
export const tools = {
  start_session: startSession,
  suggest_issues: suggestIssues,
  claim_issue: claimIssue,
  post_update: postUpdate,
  submit_work: submitWork,
  release_claim: releaseClaim,
  my_work: myWork,
  open_pr: openPr,
  set_interests: setInterests,
  register_project: registerProject,
  update_project: updateProject,
  project_status: projectStatus,
  pause_project: pauseProject,
  request_removal: requestRemoval,
  admin_queue: adminQueue,
  admin_decide: adminDecide,
  admin_add_project: adminAddProject,
  admin_block_donor: adminBlockDonor,
  admin_pause_project: adminPauseProject,
  admin_remove_project: adminRemoveProject,
  admin_seed_repo: adminSeedRepo,
} as const;

export type Tools = typeof tools;
export type ToolName = keyof Tools;
/** A tool's input after checking, with defaults filled in. */
export type ToolInput<N extends ToolName> = z.output<Tools[N]['input']>;
/** A tool's structured result. */
export type ToolOutput<N extends ToolName> = z.output<Tools[N]['output']>;
/** A tool's structured result as a tool builds it, before its schema fills in defaults. */
export type ToolOutputInput<N extends ToolName> = z.input<Tools[N]['output']>;

export interface TextContent {
  type: 'text';
  text: string;
}

/** A tool's answer in the shape MCP sends: plain text next to the structured data. */
export interface ToolResult<T> {
  content: TextContent[];
  structuredContent: T;
}

/** A refusal in the shape MCP sends: an error result whose text says why. */
export interface ToolRefusal {
  content: TextContent[];
  isError: true;
}

/**
 * The result of a tool call. The output is checked against the tool's schema
 * first, which also drops any field the schema doesn't list, so nothing
 * leaves the server by accident.
 */
export function toolResult<N extends ToolName>(
  name: N,
  output: ToolOutputInput<N>,
): ToolResult<ToolOutput<N>> {
  const spec: ToolSpec = tools[name];
  const data = spec.output.parse(output) as ToolOutput<N>;
  return { content: [{ type: 'text', text: spec.text(data) }], structuredContent: data };
}

/**
 * A refusal as a tool result. It carries no structured data, because MCP
 * clients check structured data against the tool's output schema. The code
 * leads the text, so a skill can act on it.
 */
export function toolRefusal(refusal: Refusal): ToolRefusal {
  const { code, message } = refusalSchema.parse(refusal);
  return { content: [{ type: 'text', text: `Refused (${code}): ${message}` }], isError: true };
}

export type { Audience, ToolSpec } from './spec';
export { audiences } from './spec';
export {
  ADMIN_QUEUE_PAGE,
  doNotListNote,
  moreRemovalsWithdrawnNote,
  queuePlaceText,
  readQueuePlace,
  removalProjectNote,
  removalWaitsNote,
  removalWithdrawnNote,
} from './admin';
export { MAX_FILE_BYTES, MAX_PR_DESCRIPTION, MAX_SUBMIT_BYTES, utf8Length } from './donor';
export type { Suggestion } from './donor';
export type { QueuePlace } from './admin';
export { claimStateLabel } from './shared';
export type { ClaimSummary, Delisting, FollowUp, ReadInPart } from './shared';
