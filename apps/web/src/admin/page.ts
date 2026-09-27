import {
  describeProblems,
  tools,
  validate,
  type Policy,
  type ProjectStatus,
  type Refusal,
  type ToolName,
  type ToolOutputInput,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { PermissionRefused, requirePermission, type Caller } from '../auth/permissions';
import { readSignedIn, siteCaller } from '../auth/session';
import { authSecret, siteOrigin } from '../auth/settings';
import { getPerson, listBlocks, listPolicyListings } from '../db';
import { GitHubError } from '../github';
import { ADMIN_PATH } from './paths';
import {
  adminAddProject,
  adminBlockDonor,
  adminDecide,
  adminQueue,
  type Outcome,
} from './actions';

// The admin pages at /admin, on the server. The page's data and its forms
// both start from the signed-in person's web session, and check their
// permission before reading or writing anything, since the server function
// behind the page and the form's POST can each be called on their own. The
// forms go through the same actions as the admin's MCP tools.


type QueueItem = ToolOutputInput<'admin_queue'>['items'][number];

/** A project listed from its written AI policy. */
export interface PolicyListing {
  repo: string;
  status: ProjectStatus;
  policy: Policy;
}

/** A blocked donor, by their login now. */
export interface BlockedDonor {
  login: string;
  reason: string | null;
  blockedAt: number;
}

export interface AdminPage {
  /** When the page was read, for how long ago things happened. */
  now: number;
  candidates: QueueItem[];
  registrations: QueueItem[];
  listings: PolicyListing[];
  blocked: BlockedDonor[];
  /** What the last form did, when the page came back from one. */
  notice: string | null;
  /** True when GitHub no longer took the admin's token, so the queue has no facts. */
  signInAgain: boolean;
}

export type AdminPageResult = { state: 'ready'; page: AdminPage } | { state: 'signed_out' } | { state: 'not_found' };

/** A notice and its signature, from the address a form sent the admin back to. */
export interface NoticeParams {
  notice?: string;
  sig?: string;
}

const encoder = new TextEncoder();

// A notice rides in the address, signed with AUTH_SECRET, so the page shows
// only what one of its own forms said. A link someone else made shows none.
async function signature(notice: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(authSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`admin-notice:${notice}`)));
  return btoa(String.fromCharCode(...mac)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function verifiedNotice({ notice, sig }: NoticeParams): Promise<string | null> {
  if (typeof notice !== 'string' || typeof sig !== 'string' || notice.length > 2000) return null;
  const expected = await signature(notice);
  if (expected.length !== sig.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return difference === 0 ? notice : null;
}

/** True when the caller holds `permission`, which only admins do. */
async function holds(caller: Caller, permission: 'review_projects' | 'list_from_policy' | 'block_donors'): Promise<boolean> {
  try {
    await requirePermission(caller, permission);
    return true;
  } catch (error) {
    if (error instanceof PermissionRefused) return false;
    throw error;
  }
}

/** The admin behind the request, or why there is none. */
async function adminOf(request: Request): Promise<{ caller: Caller; setCookies: string[] } | 'signed_out' | 'not_found'> {
  const { signedIn, setCookies } = await readSignedIn(request);
  if (!signedIn) return 'signed_out';
  const caller = siteCaller(signedIn, siteOrigin(request));
  if (!(await holds(caller, 'review_projects'))) return 'not_found';
  return { caller, setCookies };
}

/**
 * What /admin shows: the admin queue, the projects listed from a policy, and
 * the blocked donors. Anyone who isn't signed in is sent to sign in, and
 * anyone else who isn't an admin gets a 404 with nothing read.
 */
export async function loadAdminPage(
  request: Request,
  params: NoticeParams,
): Promise<{ result: AdminPageResult; setCookies: string[] }> {
  const admin = await adminOf(request);
  if (admin === 'signed_out' || admin === 'not_found') return { result: { state: admin }, setCookies: [] };
  const { caller, setCookies } = admin;
  let signInAgain = false;
  let queue = await adminQueue(caller, { kind: 'all' }).catch((error: unknown) => {
    if (!(error instanceof GitHubError && error.status === 401)) throw error;
    signInAgain = true;
    return null;
  });
  // GitHub stopped taking the admin's token, so the queue shows no facts.
  queue ??= await adminQueue({ ...caller, gitHubToken: () => Promise.resolve(null) }, { kind: 'all' });
  if (!queue.ok) throw new Error(`The admin queue was refused: ${queue.refusal.message}`);
  const items = queue.value.items;
  const [listings, blocked, notice] = await Promise.all([
    readListings(caller),
    readBlocked(caller),
    verifiedNotice(params),
  ]);
  return {
    result: {
      state: 'ready',
      page: {
        now: Date.now(),
        candidates: items.filter((item) => item.kind === 'candidate'),
        registrations: items.filter((item) => item.kind === 'registration'),
        listings,
        blocked,
        notice,
        signInAgain,
      },
    },
    setCookies,
  };
}

async function readListings(caller: Caller): Promise<PolicyListing[]> {
  if (!(await holds(caller, 'list_from_policy'))) return [];
  return (await listPolicyListings(env.DB)).flatMap((project) =>
    project.policy === null ? [] : [{ repo: project.repo, status: project.status, policy: project.policy }],
  );
}

async function readBlocked(caller: Caller): Promise<BlockedDonor[]> {
  if (!(await holds(caller, 'block_donors'))) return [];
  const blocks = await listBlocks(env.DB);
  const people = await Promise.all(blocks.map((block) => getPerson(env.DB, block.githubId)));
  return blocks.map((block, i) => ({
    login: people[i]?.login ?? String(block.githubId),
    reason: block.reason,
    blockedAt: block.blockedAt,
  }));
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Back to the page, with a notice of what the form did. */
async function backWith(notice: string, setCookies: string[]): Promise<Response> {
  const query = new URLSearchParams({ notice, sig: await signature(notice) });
  const headers = new Headers({ location: `${ADMIN_PATH}?${query.toString()}`, 'cache-control': 'no-store' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Labels typed as a list separated by commas. */
function tagsFrom(form: FormData): string[] | undefined {
  const tags = field(form, 'tags')
    ?.split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
  return tags && tags.length > 0 ? tags : undefined;
}

function nothingChanged(problems: Parameters<typeof describeProblems>[0]): string {
  return `Nothing changed. ${describeProblems(problems).split('\n').join('. ')}.`;
}

type Said<N extends ToolName> = (value: ToolOutputInput<N>) => string;

function said<N extends ToolName>(outcome: Outcome<N>, success: Said<N>): string {
  return outcome.ok ? success(outcome.value) : (outcome.refusal satisfies Refusal).message;
}

/** Runs one of the page's forms as the admin, and says what it did. */
async function runForm(caller: Caller, form: FormData, now: number): Promise<string> {
  const action = field(form, 'action');
  if (action === 'decide') {
    const decision = field(form, 'decision');
    const input = validate(tools.admin_decide.input, {
      id: field(form, 'id'),
      decision,
      reason: field(form, 'reason'),
      tier: decision === 'approve' ? field(form, 'tier') : undefined,
      settings: decision === 'approve' && field(form, 'tags') !== undefined ? { tags: tagsFrom(form) } : undefined,
    });
    if (!input.ok) {
      return input.problems.some((p) => p.field === 'reason') && decision === 'reject'
        ? 'Nothing changed. A rejection needs a reason.'
        : nothingChanged(input.problems);
    }
    return said(await adminDecide(caller, input.value, now), (out) => {
      if (out.kind === 'registration') {
        return out.status === 'approved'
          ? `Approved ${out.repo}. It is listed now.`
          : `Rejected ${out.repo}. Its maintainers see the reason from their agent.`;
      }
      return out.status === 'rejected' ? `Skipped ${out.repo}.` : `Listed ${out.repo} from its AI policy.`;
    });
  }
  if (action === 'add') {
    const input = validate(tools.admin_add_project.input, {
      repo: field(form, 'repo'),
      policy: { quote: field(form, 'quote'), url: field(form, 'url'), tier: field(form, 'tier') },
      settings: { tags: tagsFrom(form) },
    });
    if (!input.ok) return nothingChanged(input.problems);
    return said(await adminAddProject(caller, input.value, now), (out) =>
      out.updated ? `Updated the listing of ${out.repo}.` : `Listed ${out.repo} from its AI policy.`,
    );
  }
  if (action === 'block' || action === 'unblock') {
    const input = validate(tools.admin_block_donor.input, {
      login: field(form, 'login')?.trim().replace(/^@/, ''),
      blocked: action === 'block',
      reason: action === 'block' ? field(form, 'reason') : undefined,
    });
    if (!input.ok) return nothingChanged(input.problems);
    return said(await adminBlockDonor(caller, input.value, now), (out) =>
      out.blocked ? `Blocked @${out.login}.` : `Unblocked @${out.login}.`,
    );
  }
  return 'Nothing changed. That form does nothing here.';
}

/**
 * Answers a form posted to /admin. It has to come from the site's own
 * pages, by its Origin, like the site's other forms, and from an admin.
 * Anyone else gets a 404, the answer the page gives them. The admin goes
 * back to the page, which says what the form did.
 */
export async function answerAdminForm(request: Request): Promise<Response> {
  if (request.headers.get('origin') !== siteOrigin(request)) {
    return text(403, 'Refused: this form was sent from another site.');
  }
  const admin = await adminOf(request);
  if (admin === 'signed_out' || admin === 'not_found') return text(404, 'Not Found');
  const form = await request.formData().catch(() => new FormData());
  let notice: string;
  try {
    notice = await runForm(admin.caller, form, Date.now());
  } catch (error) {
    // GitHub stopped taking the token from the admin's sign-in on the site.
    if (!(error instanceof GitHubError && error.status === 401)) throw error;
    notice = 'Nothing changed. GitHub no longer takes the token this site holds for you. Sign out and in again.';
  }
  return backWith(notice, admin.setCookies);
}
