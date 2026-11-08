import {
  describeProblems,
  MAX_ROUNDS,
  ROUNDS_PER_DAY,
  tools,
  validate,
  type FieldProblem,
  type Interests,
  type Refusal,
  type ToolInput,
  type ToolOutput,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { failureReason } from '../auth/auth';
import { backWithNotice, verifiedNotice } from '../auth/notice';
import type { NoticeParams } from '../auth/notice-params';
import { PermissionRefused, type Caller } from '../auth/permissions';
import { readSignedIn, siteCaller, type SignedIn } from '../auth/session';
import { siteOrigin } from '../auth/settings';
import { getPerson, listWakes, setInterests } from '../db';
import { GitHubError } from '../github';
import { endLapsedConnections, listConnections, type Connection } from '../mcp/connections';
import { setFollowThroughAs } from '../mcp/donor';
import { openPrAs, readyToOpen, type Opened, type ReviewItem } from '../mcp/submit';
import { readFollowThrough, type FollowThroughShown } from './follow';
import { HARNESS_NAMES, MODE_NAMES } from './follow-words';
import { ME_PATH } from './paths';
import { followRefusalText, openPrRefusalText } from './refusals';

// /me on the server: what the page reads, and the answer to its forms. The
// page's data and its forms both start from the signed-in person's web
// session, since the server function behind the page and the form's POST
// can each be called on their own, and each acts as that person alone. The
// review queue and Open PR are my_work's and open_pr's own, from
// src/mcp/submit.ts, run with the GitHub token from the person's sign-in on
// the site. The interests are set_interests' own schema and save. The
// follow-through forms are set_follow_through's own schema and rules, from
// src/mcp/donor.ts.

/** The donor's review queue, or why the page can't show it. */
export type Queue =
  | { state: 'ready'; items: ReviewItem[] }
  /** GitHub no longer takes the token the site holds for the person. */
  | { state: 'sign_in_again' }
  /** It couldn't be read, as when GitHub or the database didn't answer. */
  | { state: 'unreadable' };

export interface MePage {
  /** When the page was read, for how long work has left. */
  now: number;
  /** The person's login now, for their feed's link. */
  login: string;
  /**
   * Their open PRs, mode, and wakes, or null when the database couldn't
   * answer. A person with no open PR and no wake has nothing to follow.
   */
  follow: FollowThroughShown | null;
  agents: Connection[];
  queue: Queue;
  /** Null until the person saves some, here or with set_interests. */
  interests: Interests | null;
  /** What the last form did, when the page came back from one. */
  notice: string | null;
}

export type MePageResult = { state: 'ready'; page: MePage } | { state: 'signed_out' };

const SIGN_IN_AGAIN = 'GitHub no longer takes the token this site holds for you. Sign out and in again.';

/** What a notice on /me is signed for: the page, and the person it is for, so it shows to no one else. */
function noticePurpose(signedIn: SignedIn): string {
  return `me-notice:${String(signedIn.githubId)}`;
}

/**
 * The person's connected agents, the most recently used first. It first
 * ends any of their connections whose grant ran out, so the list shows
 * only agents that can still connect, apart from one whose token GitHub
 * couldn't revoke, which stays until a later try ends it.
 */
async function readAgents(origin: string, githubId: number, now: number): Promise<Connection[]> {
  try {
    await endLapsedConnections(origin, githubId, now);
  } catch (error) {
    console.error(`Connections whose grants ran out weren't ended: ${failureReason(error)}`);
  }
  return listConnections(githubId);
}

/** The person's work waiting for them to open its PR, as my_work lists it. */
async function readQueue(caller: Caller, origin: string, now: number): Promise<Queue> {
  try {
    return { state: 'ready', items: await readyToOpen(caller, origin, now) };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) return { state: 'sign_in_again' };
    console.error(`The review queue on /me wasn't read: ${failureReason(error)}`);
    return { state: 'unreadable' };
  }
}

/** The person's follow-through, or null when it couldn't be read. */
async function readFollow(person: number, now: number): Promise<FollowThroughShown | null> {
  try {
    return await readFollowThrough(env.DB, person, now);
  } catch (error) {
    console.error(`Follow-through on /me wasn't read: ${failureReason(error)}`);
    return null;
  }
}

/**
 * What /me shows the signed-in person: their connected agents, their review
 * queue, their open PRs and how each is followed, and their interests. Anyone else is sent to sign in, with nothing
 * read. Each part is read on its own, so a queue GitHub can't answer for
 * still leaves Disconnect on the page.
 */
export async function loadMePage(
  request: Request,
  params: NoticeParams,
): Promise<{ result: MePageResult; setCookies: string[] }> {
  const { signedIn, setCookies } = await readSignedIn(request);
  if (!signedIn) return { result: { state: 'signed_out' }, setCookies };
  const origin = siteOrigin(request);
  const now = Date.now();
  const [agents, queue, person, follow, notice] = await Promise.all([
    readAgents(origin, signedIn.githubId, now),
    readQueue(siteCaller(signedIn, origin), origin, now),
    getPerson(env.DB, signedIn.githubId),
    readFollow(signedIn.githubId, now),
    verifiedNotice(noticePurpose(signedIn), params),
  ]);
  const page = { now, login: signedIn.login, agents, queue, follow, interests: person?.interests ?? null, notice };
  return { result: { state: 'ready', page }, setCookies };
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function seeOther(location: string, setCookies: string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function problemsText(problems: readonly FieldProblem[]): string {
  return `${describeProblems(problems).split('\n').join('. ')}.`;
}

/** A refusal in the page's words, from src/me/refusals.ts, or as the tool says it for a code open_pr doesn't list. */
function refusalText(refusal: Refusal): string {
  return openPrRefusalText(refusal) ?? refusal.message;
}

function openedText(opened: Extract<Opened, { ok: true }>['value']): string {
  const { issue, prOnIssue } = opened;
  const also = prOnIssue === null ? '' : ` Another PR is open on the issue too: ${prOnIssue.url}`;
  // The work is cleared, and the donor opens its PR on GitHub. The queue
  // item links GitHub's form from the clearance itself, since a notice is
  // cut short and the link can run to thousands of characters.
  return `The PR for ${issue} is ready to open. Open it on GitHub from your queue.${also}`;
}

/**
 * Clears the work of a claim in the person's review queue to open as a PR,
 * by open_pr's rules, as open_pr takes its input. A description left blank is none,
 * which open_pr refuses for a project that asks for one. A browser sends
 * each line break in a form as CR LF, and it goes to the PR as LF, like the
 * rest of the PR's description.
 */
async function openPrForm(caller: Caller, form: FormData, now: number): Promise<string> {
  const claimId = form.get('claim');
  const written = form.get('description');
  const input = validate(tools.open_pr.input, {
    claimId: typeof claimId === 'string' ? claimId : undefined,
    description: typeof written === 'string' && written.trim() !== '' ? written.replaceAll('\r\n', '\n') : undefined,
  });
  if (!input.ok) return `No PR opened. ${problemsText(input.problems)}`;
  let opened: Opened;
  try {
    opened = await openPrAs(caller, input.value, now);
  } catch (error) {
    // Someone else's claim is refused before anything is read or written.
    if (error instanceof PermissionRefused) return `No PR opened. ${openPrRefusalText(error) ?? error.message}`;
    if (!(error instanceof GitHubError)) throw error;
    if (error.status === 401) return `No PR opened. ${SIGN_IN_AGAIN}`;
    // A spent rate limit, or GitHub down, as the queue's read says it.
    console.error(`Open PR on /me didn't reach GitHub: ${failureReason(error)}`);
    return "No PR opened. GitHub didn't answer. Try again in a minute.";
  }
  return opened.ok ? openedText(opened.value) : `No PR opened. ${refusalText(opened.refusal)}`;
}

/** A list typed with commas between its items. */
function listOf(form: FormData, name: string): string[] {
  const value = form.get(name);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Saves the person's interests, as set_interests does. */
async function interestsForm(caller: Caller, form: FormData): Promise<string> {
  const input = validate(tools.set_interests.input, {
    languages: listOf(form, 'languages'),
    projects: listOf(form, 'projects'),
    kinds: listOf(form, 'kinds'),
  });
  if (!input.ok) return `Nothing saved. ${problemsText(input.problems)}`;
  const saved = await setInterests(env.DB, caller.githubId, input.value);
  return saved === null ? 'Nothing saved. Sign out and in again.' : 'Saved your interests.';
}

/** A form field's text, or undefined when the form has none. */
function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** The PR a claim has, by its number, in what set_follow_through gave back, or the claim's ID. */
function prName(set: ToolOutput<'set_follow_through'>, claimId: string | undefined): string {
  const pr = set.prs.find((one) => one.claimId === claimId);
  return pr === undefined ? 'The PR' : `PR #${String(pr.pr.number)}`;
}

/** What a follow-through form changed, in the page's words. */
function followText(input: ToolInput<'set_follow_through'>, set: ToolOutput<'set_follow_through'>, removed: string | null): string {
  if (input.goOn !== undefined) {
    return set.wentOn === null
      ? 'Nothing changed. The PR is no longer open.'
      : `${prName(set, input.claimId)} goes on. Your agent can take ${String(ROUNDS_PER_DAY)} more rounds on it today, and ${String(MAX_ROUNDS)} more in all.`;
  }
  if (input.removeWake !== undefined) {
    return set.removedWake === null
      ? 'Nothing changed. That wake was already removed.'
      : `Removed the ${removed ?? 'harness'} wake. Turn its schedule off in the harness too.`;
  }
  if (input.mode === 'off') return `Your agent stops following ${prName(set, input.claimId)}.`;
  if (input.mode !== undefined && input.claimId !== undefined) {
    return `${prName(set, input.claimId)} follows ${MODE_NAMES[input.mode]} now.`;
  }
  return `Your PRs follow ${MODE_NAMES[set.followMode.mode]} now.`;
}

/**
 * Changes how the person's PRs are followed, by set_follow_through's
 * schema and rules: their mode for all their PRs, one PR's mode or off,
 * going on past a round limit, or removing a wake. Another donor's claim
 * or wake changes nothing.
 */
async function followForm(caller: Caller, form: FormData, now: number): Promise<string> {
  const action = form.get('action');
  const claimId = field(form, 'claim');
  const mode = field(form, 'mode');
  const removeWake = field(form, 'wake');
  const raw =
    action === 'follow_mode'
      ? { mode }
      : action === 'pr_follow_mode'
        ? { mode, claimId }
        : action === 'go_on'
          ? { claimId, goOn: true }
          : { removeWake };
  const input = validate(tools.set_follow_through.input, raw);
  if (!input.ok) return `Nothing changed. ${problemsText(input.problems)}`;
  // The wake's harness, named in the notice once it is gone.
  const wakes = removeWake === undefined ? [] : await listWakes(env.DB, caller.githubId);
  const harness = wakes.find((wake) => wake.id === removeWake)?.harness;
  let set;
  try {
    set = await setFollowThroughAs(caller, input.value, now);
  } catch (error) {
    if (error instanceof PermissionRefused) return `Nothing changed. ${followRefusalText(error) ?? error.message}`;
    throw error;
  }
  if (!set.ok) return `Nothing changed. ${followRefusalText(set.refusal) ?? set.refusal.message}`;
  return followText(input.value, set.value, harness === undefined ? null : HARNESS_NAMES[harness]);
}

const FOLLOW_ACTIONS = new Set(['follow_mode', 'pr_follow_mode', 'go_on', 'remove_wake']);

async function runForm(caller: Caller, form: FormData, now: number): Promise<string> {
  const action = form.get('action');
  if (action === 'open_pr') return openPrForm(caller, form, now);
  if (action === 'interests') return interestsForm(caller, form);
  if (typeof action === 'string' && FOLLOW_ACTIONS.has(action)) return followForm(caller, form, now);
  return 'Nothing changed. That form does nothing here.';
}

/**
 * Answers a form posted to /me, the way the Disconnect form is answered: it
 * has to come from the site's own pages, by its Origin, and anyone signed
 * out goes to sign in. It acts only as the signed-in person, and only on
 * their own claims. They go back to the page, which says what the form did.
 */
export async function answerMeForm(request: Request): Promise<Response> {
  const origin = siteOrigin(request);
  if (request.headers.get('origin') !== origin) return text(403, 'Refused: this form was sent from another site.');
  const { signedIn, setCookies } = await readSignedIn(request);
  if (!signedIn) return seeOther('/sign-in', setCookies);
  const form = await request.formData().catch(() => new FormData());
  const notice = await runForm(siteCaller(signedIn, origin), form, Date.now());
  return backWithNotice(ME_PATH, noticePurpose(signedIn), notice, setCookies);
}
