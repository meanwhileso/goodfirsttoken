import { toolRefusal, toolResult, type ToolInput } from '@goodfirsttoken/core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  adminAddProject,
  adminBlockDonor,
  adminDecide,
  adminPauseProject,
  adminQueue,
  adminRemoveProject,
  type Outcome,
} from '../admin/actions';
import type { Caller } from '../auth/permissions';

// The admin's tools, listed only for admins. Each runs an action in
// src/admin/actions.ts, which checks the caller's permission first, and
// answers with the tool's result or its refusal.

type AdminTool = 'admin_queue' | 'admin_decide' | 'admin_add_project' | 'admin_block_donor' | 'admin_pause_project' | 'admin_remove_project';

function answer<N extends AdminTool>(name: N, outcome: Outcome<N>): CallToolResult {
  return outcome.ok ? { ...toolResult(name, outcome.value) } : { ...toolRefusal(outcome.refusal) };
}

/** Each admin tool, by name, run as the caller at `now`. */
export const adminTools = {
  admin_queue: async (caller: Caller, input: ToolInput<'admin_queue'>) =>
    answer('admin_queue', await adminQueue(caller, input)),
  admin_decide: async (caller: Caller, input: ToolInput<'admin_decide'>, now: number) =>
    answer('admin_decide', await adminDecide(caller, input, now)),
  admin_add_project: async (caller: Caller, input: ToolInput<'admin_add_project'>, now: number) =>
    answer('admin_add_project', await adminAddProject(caller, input, now)),
  admin_block_donor: async (caller: Caller, input: ToolInput<'admin_block_donor'>, now: number) =>
    answer('admin_block_donor', await adminBlockDonor(caller, input, now)),
  admin_pause_project: async (caller: Caller, input: ToolInput<'admin_pause_project'>, now: number) =>
    answer('admin_pause_project', await adminPauseProject(caller, input, now)),
  admin_remove_project: async (caller: Caller, input: ToolInput<'admin_remove_project'>, now: number) =>
    answer('admin_remove_project', await adminRemoveProject(caller, input, now)),
};
