import { productName, toolRefusal, tools, type ToolSpec } from '@goodfirsttoken/core';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { PermissionRefused, requirePermission, type Caller } from '../auth/permissions';
import { siteOrigin } from '../auth/settings';
import { GitHubError } from '../github';
import { adminTools } from './admin';
import { disconnect, markConnectionUsed } from './connections';
import * as donor from './donor';
import { pauseProject, projectStatus, registerProject, updateProject } from './maintainer';
import { MCP_PATH } from './paths';
import type { AgentProps } from './provider';

// The MCP server at /mcp, over streamable HTTP. The OAuth provider checks the
// access token first and hands this handler the grant's props: who the
// person is, and their GitHub token from the agent's sign-in. Each request
// gets a fresh server, with the caller built from those props, so no call
// can see another person's token.

/** The caller of a tool, from their agent's grant. */
export function callerOf(props: AgentProps): Caller {
  return { githubId: props.githubId, login: props.login, gitHubToken: () => Promise.resolve(props.gitHubToken) };
}

type Answer = CallToolResult;

function answer(text: string, isError = false): Answer {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

/**
 * Runs a tool as the connection's person. A permission check that says no
 * becomes the tool's refusal. When GitHub stops accepting the connection's
 * token, because the person revoked the app or GitHub revoked the token to
 * keep them at 10, the connection can't work again. So it ends, and the
 * agent's next call gets a 401 and signs in.
 */
async function asCaller(props: AgentProps, origin: string, tool: () => Promise<Answer>): Promise<Answer> {
  try {
    return await tool();
  } catch (error) {
    if (error instanceof PermissionRefused) return { ...toolRefusal({ code: error.code, message: error.message }) };
    if (error instanceof GitHubError && error.status === 401) {
      await disconnect(origin, props.githubId, props.connectionId, { revoke: false });
      return answer(
        `GitHub no longer accepts this connection's token, so ${productName} disconnected it. Reconnect the MCP server to sign in again.`,
        true,
      );
    }
    throw error;
  }
}

/** A tool's description and schemas, as packages/core defines them. */
function specOf<I extends ToolSpec['input'], O extends ToolSpec['output']>(spec: ToolSpec<I, O>) {
  return { description: spec.description, inputSchema: spec.input, outputSchema: spec.output };
}

/**
 * True when the caller is one of Good First Token's admins, by the
 * permission check the admin's tools make, read on each request.
 */
async function isAdmin(caller: Caller): Promise<boolean> {
  try {
    await requirePermission(caller, 'review_projects');
    return true;
  } catch (error) {
    if (error instanceof PermissionRefused) return false;
    throw error;
  }
}

async function buildServer(props: AgentProps, origin: string): Promise<McpServer> {
  const server = new McpServer({ name: productName, version: '0.1.0' });
  const caller = callerOf(props);
  const run = (tool: () => Promise<Answer>) => asCaller(props, origin, tool);
  // The donor's tools. Each acts as the caller alone, and reads GitHub with
  // their own token.
  server.registerTool('start_session', specOf(tools.start_session), (input) =>
    run(() => donor.startSession(caller, input, origin, Date.now())),
  );
  server.registerTool('set_interests', specOf(tools.set_interests), (input) =>
    run(() => donor.setInterests(caller, input)),
  );
  server.registerTool('suggest_issues', specOf(tools.suggest_issues), (input) =>
    run(() => donor.suggestIssues(caller, input, origin, Date.now())),
  );
  server.registerTool('claim_issue', specOf(tools.claim_issue), (input) =>
    run(() => donor.claimIssue(caller, input, origin, Date.now())),
  );
  server.registerTool('post_update', specOf(tools.post_update), (input) =>
    run(() => donor.postUpdate(caller, input)),
  );
  server.registerTool('release_claim', specOf(tools.release_claim), (input) =>
    run(() => donor.releaseClaim(caller, input)),
  );
  server.registerTool('my_work', specOf(tools.my_work), () => run(() => donor.myWork(caller, origin, Date.now())));
  // The maintainer's tools. Each asks GitHub for the caller's permission on
  // the repo, with their own token, on every call.
  server.registerTool('register_project', specOf(tools.register_project), (input) =>
    run(() => registerProject(caller, input, Date.now())),
  );
  server.registerTool('update_project', specOf(tools.update_project), (input) =>
    run(() => updateProject(caller, input, Date.now())),
  );
  server.registerTool('project_status', specOf(tools.project_status), (input) =>
    run(() => projectStatus(caller, input, Date.now())),
  );
  server.registerTool('pause_project', specOf(tools.pause_project), (input) =>
    run(() => pauseProject(caller, input, Date.now())),
  );
  // The admin's tools are listed only for admins. Each also checks the
  // caller's permission first, whenever it runs.
  if (await isAdmin(caller)) {
    server.registerTool('admin_queue', specOf(tools.admin_queue), (input) =>
      run(() => adminTools.admin_queue(caller, input)),
    );
    server.registerTool('admin_decide', specOf(tools.admin_decide), (input) =>
      run(() => adminTools.admin_decide(caller, input, Date.now())),
    );
    server.registerTool('admin_add_project', specOf(tools.admin_add_project), (input) =>
      run(() => adminTools.admin_add_project(caller, input, Date.now())),
    );
    server.registerTool('admin_block_donor', specOf(tools.admin_block_donor), (input) =>
      run(() => adminTools.admin_block_donor(caller, input, Date.now())),
    );
    server.registerTool('admin_pause_project', specOf(tools.admin_pause_project), (input) =>
      run(() => adminTools.admin_pause_project(caller, input, Date.now())),
    );
    server.registerTool('admin_remove_project', specOf(tools.admin_remove_project), (input) =>
      run(() => adminTools.admin_remove_project(caller, input, Date.now())),
    );
    server.registerTool('admin_seed_repo', specOf(tools.admin_seed_repo), (input) =>
      run(() => adminTools.admin_seed_repo(caller, input, Date.now())),
    );
  }
  return server;
}

interface Session {
  props: AgentProps;
  origin: string;
}

const mcp = createMcpHandler(({ authInfo }) => {
  const session = authInfo?.extra?.session as Session | undefined;
  if (!session) throw new Error('An MCP request reached the server without a grant.');
  return buildServer(session.props, session.origin);
});

function refused(status: number, error: string, description: string, origin: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="OAuth", error="${error}", error_description="${description}", resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`,
    },
  });
}

/**
 * Answers a request to /mcp that carries a valid access token. Each person
 * gets 120 calls a minute across their agents. An agent that was
 * disconnected gets a 401, even when its grant hasn't gone yet.
 */
export async function handleMcpRequest(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
  // The OAuth provider set these from the grant, after it checked the token.
  const props = ctx.props as AgentProps;
  const origin = siteOrigin(request);
  const { success } = await env.MCP_LIMITER.limit({ key: String(props.githubId) });
  if (!success) {
    return new Response('Too many calls to the MCP server. Try again in a minute.\n', {
      status: 429,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
  if (!(await markConnectionUsed(props.connectionId, props.githubId, Date.now()))) {
    return refused(401, 'invalid_token', 'This agent was disconnected', origin);
  }
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const session: Session = { props, origin };
  return mcp.fetch(request, { authInfo: { token, clientId: '', scopes: [], extra: { session } } });
}
