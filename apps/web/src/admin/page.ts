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
import { backWithNotice, verifiedNotice } from '../auth/notice';
import type { NoticeParams } from '../auth/notice-params';
import { siteOrigin } from '../auth/settings';
import { listBlocks, listPolicyListings } from '../db';
import { GitHubError } from '../github';
import { ADMIN_PATH } from './paths';
import {
  adminAddProject,
  adminBlockDonor,
  adminDecide,
  adminRemoveProject,
  queuePage,
  type KindCounts,
  type Outcome,
  type QueuePage,
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
  /** Maintainers' requests to be removed, waiting for an admin. */
  removals: QueueItem[];
  listings: PolicyListing[];
  blocked: BlockedDonor[];
  /** What the last form did, when the page came back from one. */
  notice: string | null;
  /** True when GitHub no longer took the admin's token, so the queue has no facts. */
  signInAgain: boolean;
  /** How many more wait after this page of the queue. */
  more: number;
  /** How many of each kind the page shows wait in the whole queue. */
  waiting: Record<PageKind, number>;
  /** How many of each kind the page shows wait after this page. */
  later: Record<PageKind, number>;
  /** The `after` of the next page, or null when none waits. */
  next: string | null;
  /** True on a page after the first. */
  laterPage: boolean;
  /** Why no page of the queue shows, when the address asked for one that isn't. */
  badPage: string | null;
}

/** What /admin's address can carry: a notice, and the page of the queue. */
export interface AdminPageParams extends NoticeParams {
  /** Where the page before ended, as `admin_queue`'s `after` takes it. */
  after?: string;
}

/** The kinds of item /admin shows. The admin's agent reads the others with `admin_queue`. */
const PAGE_KINDS = ['removal', 'candidate', 'registration'] as const;

/** A kind of item /admin shows. */
export type PageKind = (typeof PAGE_KINDS)[number];

/** The counts of the kinds /admin shows. */
function pageKinds(counts: KindCounts): Record<PageKind, number> {
  return { removal: counts.removal, candidate: counts.candidate, registration: counts.registration };
}

export type AdminPageResult = { state: 'ready'; page: AdminPage } | { state: 'signed_out' } | { state: 'not_found' };

export type { NoticeParams } from '../auth/notice-params';

/** What a notice on /admin is signed for, so it shows on no other page. */
const NOTICE_PURPOSE = 'admin-notice';

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
 * What /admin shows: a page of the admin queue, with maintainers' requests to be
 * removed, the projects listed from a policy, and the blocked donors. Anyone who isn't signed in is sent to sign in, and
 * anyone else who isn't an admin gets a 404 with nothing read. The page of
 * the queue is the one `after` names, or the first.
 */
export async function loadAdminPage(
  request: Request,
  params: AdminPageParams,
): Promise<{ result: AdminPageResult; setCookies: string[] }> {
  const admin = await adminOf(request);
  if (admin === 'signed_out' || admin === 'not_found') return { result: { state: admin }, setCookies: [] };
  const { caller, setCookies } = admin;
  // The page of the queue is checked as admin_queue checks its input, and
  // one that isn't a page shows no queue, with the tool's words for why.
  const place = validate(tools.admin_queue.input, { after: params.after });
  const badPage = place.ok ? null : `No page of the queue shows. ${describeProblems(place.problems).split('\n').join('. ')}.`;
  const after = place.ok ? place.value.after : undefined;
  let signInAgain = false;
  const none: KindCounts = { registration: 0, candidate: 0, removal: 0, pause: 0, policy_change: 0 };
  const nothing: QueuePage = { ok: true, value: { items: [], more: 0, next: null }, waiting: none, later: none };
  let queue =
    badPage !== null
      ? nothing
      : await queuePage(caller, { kinds: PAGE_KINDS, after }).catch((error: unknown) => {
          if (!(error instanceof GitHubError && error.status === 401)) throw error;
          signInAgain = true;
          return null;
        });
  // GitHub stopped taking the admin's token, so the queue shows no facts.
  queue ??= await queuePage({ ...caller, gitHubToken: () => Promise.resolve(null) }, { kinds: PAGE_KINDS, after });
  const items = queue.value.items;
  const [listings, blocked, notice] = await Promise.all([
    readListings(caller),
    readBlocked(caller),
    verifiedNotice(NOTICE_PURPOSE, params),
  ]);
  return {
    result: {
      state: 'ready',
      page: {
        now: Date.now(),
        candidates: items.filter((item) => item.kind === 'candidate'),
        registrations: items.filter((item) => item.kind === 'registration'),
        removals: items.filter((item) => item.kind === 'removal'),
        listings,
        blocked,
        notice,
        signInAgain,
        more: queue.value.more ?? 0,
        waiting: pageKinds(queue.waiting),
        later: pageKinds(queue.later),
        next: queue.value.next ?? null,
        laterPage: after !== undefined,
        badPage,
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
  return (await listBlocks(env.DB)).map((block) => ({
    login: block.login,
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
  if (action === 'remove') {
    const input = validate(tools.admin_remove_project.input, { repo: field(form, 'repo') });
    if (!input.ok) return nothingChanged(input.problems);
    return said(await adminRemoveProject(caller, input.value, now), (out) => `Removed ${out.repo} at its maintainers' request.`);
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
  return backWithNotice(ADMIN_PATH, NOTICE_PURPOSE, notice, admin.setCookies);
}
