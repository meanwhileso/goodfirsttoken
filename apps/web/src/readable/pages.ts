import {
  DEFAULT_CLAIMS_PER_ISSUE,
  DEFAULT_OPEN_PRS_PER_DONOR,
  DEFAULT_PR_MODE,
  DEFAULT_WHO_CAN_CLAIM,
  defaultDisclosure,
  MAX_CLAIMS_PER_ISSUE,
  MAX_OPEN_PRS_PER_DONOR,
  MIN_CLAIMS_PER_ISSUE,
  MIN_OPEN_PRS_PER_DONOR,
  type FeedEvent,
} from '@goodfirsttoken/core';
import type { AdminPage } from '../admin/page';
import { REPO_URL } from '../components/Nav';
import type { Rank } from '../components/Ranks';
import type { Tally } from '../db';
import type { HomeData } from '../home/load';
import type { IssuePage } from '../issue/load';
import {
  clockTime,
  dayAndTime,
  lanesInPlay,
  prFromText,
  prUrl,
  refName,
  slotsTaken,
  timesClaimed,
  type Lane,
} from '../issue/view';
import type { Board, LeaderboardPage } from '../leaderboard/load';
import { formatRate, formatTokens } from '../leaderboard/format';
import type { LivePage } from '../live/load';
import type { MePage } from '../me/page';
import type { PersonPage, WorkRow, WorkStatus } from '../person/load';
import type { ListedProject, ProjectPage } from '../project/load';
import { ruleBadges } from '../project/rules';
import { code, doc, link, list, numbered, text } from './markdown';

// The markdown version of each page, from the data its loader gives the
// HTML page, so the two say the same thing. Each function takes the site's
// origin for its links, since an agent reads the markdown on its own, away
// from the page's address. Every string from GitHub or an agent goes
// through `text` (./markdown.ts).

const REPO = 'meanwhileso/goodfirsttoken';

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(value: number, one: string, many: string): string {
  return `${n(value)} ${value === 1 ? one : many}`;
}

function personLink(origin: string, login: string): string {
  return link(`@${login}`, `${origin}/@${login}`);
}

function issuePath(repo: string, number: number): string {
  return `/${repo}/issues/${String(number)}`;
}

/** A feed event as a line of a list: the time in UTC, who, their agent, the issue, and the text. */
function feedLine(origin: string, event: FeedEvent): string {
  const hash = event.issue.lastIndexOf('#');
  const repo = event.issue.slice(0, hash);
  const number = Number(event.issue.slice(hash + 1));
  const job = event.job === null ? '' : ` ${text(`[${event.job}]`)}`;
  return `${clockTime(event.time)} ${personLink(origin, event.user)} ${text(event.agent)} ${link(event.issue, `${origin}${issuePath(repo, number)}`)}${job} ${text(event.text)}`;
}

/** A feed's newest lines, or what the page says in their place. */
function feedLines(origin: string, lines: readonly FeedEvent[] | null, quiet: string): string {
  if (lines === null) return "The live feed is unavailable right now.";
  return list(lines.map((event) => feedLine(origin, event))) ?? quiet;
}

function ranks(origin: string, rows: readonly Rank[], unit: string): string | null {
  return numbered(rows.map((rank) => `${personLink(origin, rank.login)} ${text(rank.agent)}: ${n(rank.score)} ${unit}`));
}

/** Links to the other markdown pages, at the end of each public one. */
function more(origin: string): string {
  return [
    '## More',
    list([
      link('Projects', `${origin}/projects.md`),
      link('Leaderboard', `${origin}/leaderboard.md`),
      link('Live', `${origin}/live.md`),
      link('Maintainers', `${origin}/maintainers.md`),
      `${link('llms.txt', `${origin}/llms.txt`)}: the site, the MCP server, the skills, the JSON data, and the streams`,
    ]),
  ].join('\n\n');
}

export function homeMarkdown(origin: string, data: HomeData): string {
  const prompt = `Read ${data.site}/start.md, then spend some of my tokens on open source.`;
  return doc([
    '# Spend your spare tokens on open source',
    'Your agent works on an issue a maintainer tagged for outside help. You can watch it work and review the pull request.',
    '## The prompt',
    `Paste it into your agent:\n\n\`\`\`text\n${prompt}\n\`\`\``,
    '## Set up your agent',
    list([
      `Claude Code: ${code(`/plugin marketplace add ${REPO}`)}, then ${code('/plugin install goodfirsttoken@goodfirsttoken')}`,
      `Codex, OpenCode, Cursor: ${code(`npx skills add ${REPO}`)}`,
      `Grok Bot: ask it to install the skill from ${link(`github.com/${REPO}`, REPO_URL)}.`,
      'T3 Code: set up Claude Code or Codex in T3 Code.',
    ]),
    'Then paste the prompt into your agent.',
    '## Live',
    `${code(`curl -N ${origin}/live.txt`)}${data.live === null ? '' : `, ${n(data.live.today)} today`}`,
    feedLines(origin, data.live?.lines ?? null, 'Quiet right now.'),
    `## Merged this week`,
    data.merged === null
      ? "This week's merged PRs can't be read right now."
      : (ranks(origin, data.merged, 'merged') ?? 'No PRs merged this week yet.'),
    `## Asking for help${data.help && data.help.total > 0 ? ` (${plural(data.help.total, 'project', 'projects')})` : ''}`,
    data.help === null
      ? "The projects can't be read right now."
      : (list(data.help.projects.map((project) => projectRow(origin, project))) ?? 'No projects yet.'),
    `Maintainers add theirs from ${link('their agent', `${origin}/maintainers.md`)}.`,
    more(origin),
  ]);
}

function projectRow(origin: string, project: Omit<ListedProject, 'source'> & { source?: ListedProject['source'] }): string {
  const got =
    project.source === undefined ? '' : project.source === 'policy' ? ', listed from its AI policy' : ', registered by its maintainers';
  return `${link(project.repo, `${origin}/${project.repo}`)}: tagged ${project.tags.map(text).join(', ')}, ${plural(project.waiting, 'issue', 'issues')} waiting, ${text(project.prMode)} PRs${got}`;
}

export function projectsMarkdown(
  origin: string,
  list_: { state: 'ready'; total: number; projects: ListedProject[] } | { state: 'unavailable' },
): string {
  if (list_.state === 'unavailable') {
    return doc(['# Every one said yes', "The projects can't be read right now. Try again in a moment."]);
  }
  const { total, projects } = list_;
  return doc([
    '# Every one said yes',
    'Open source projects that welcome agent help.',
    projects.length === 0 ? 'No projects yet.' : plural(total, 'project', 'projects'),
    list(projects.map((project) => projectRow(origin, project))),
    total > projects.length && `The first ${n(projects.length)} of ${n(total)}.`,
    `Project data and settings are available as JSON under CC0 at ${link(`${origin}/projects.json`, `${origin}/projects.json`)}.`,
    `Maintainers add theirs from ${link('their agent', `${origin}/maintainers.md`)}.`,
    more(origin),
  ]);
}

/** A policy link's words: its file and section, like CONTRIBUTING.md#ai, or its host, as the project page writes it. */
function policyFile(url: string): string {
  const parsed = new URL(url);
  const file = parsed.pathname.split('/').filter(Boolean).at(-1);
  if (!file) return parsed.host;
  try {
    return decodeURIComponent(file) + parsed.hash;
  } catch {
    return file + parsed.hash;
  }
}

export function projectMarkdown(origin: string, page: ProjectPage): string {
  const { settings } = page;
  const here = `${origin}/${page.repo}`;
  const issues = page.issues.rows.map((row) => {
    const slots = settings.claimsPerIssue;
    const state =
      row.openPr !== null
        ? `PR ${text(refName(row.openPr, row.repo))} open`
        : page.status !== 'approved'
          ? 'claims closed'
          : `${n(Math.min(row.taken, slots))} of ${plural(slots, 'slot', 'slots')} taken`;
    const labels = row.labels.length === 0 ? '' : `, labels ${row.labels.map(text).join(', ')}`;
    return `${link(row.title, `${origin}${issuePath(row.repo, row.number)}`)} (${text(refName(row, page.repo))}${labels}): ${state}`;
  });
  const merged = page.merged.rows.map((row) => {
    const hash = row.issue.lastIndexOf('#');
    const issue = { repo: row.issue.slice(0, hash), number: Number(row.issue.slice(hash + 1)) };
    return `${link(`PR ${refName(row.pr, page.repo)}`, prUrl(row.pr))} for ${link(refName(issue, page.repo), `${origin}${issuePath(issue.repo, issue.number)}`)} by ${personLink(origin, row.login)} ${text(row.agent)}, merged ${row.mergedAt.slice(0, 10)}`;
  });
  const rules = [
    ...ruleBadges(settings).map((badge) => `${text(badge.rule)}: ${text(badge.value)}`),
    settings.disclosure.prBody !== null && `the PR body says: ${text(settings.disclosure.prBody)}`,
    settings.claUrl !== null && `CLA: ${link(settings.claUrl, settings.claUrl)}`,
    settings.agentNotes !== '' && `notes for agents: ${text(settings.agentNotes)}`,
  ].filter((rule): rule is string => typeof rule === 'string');
  const set =
    page.rulesSet &&
    `Set ${page.rulesSet.login === null ? '' : `by ${personLink(origin, page.rulesSet.login)} `}on ${page.rulesSet.at.slice(0, 10)}.`;
  const policy = page.policy;
  const how =
    page.source === 'policy'
      ? [
          policy && `> “${text(policy.quote)}” ${link(policyFile(policy.url), policy.url)}`,
          `Listed from its AI policy. Maintainer? ${link('Take it over or remove it', `${origin}/maintainers.md`)}.`,
        ]
      : [`Registered by ${page.addedBy === null ? 'its maintainers' : personLink(origin, page.addedBy)}.`];

  return doc([
    `# ${text(page.repo)}`,
    page.status === 'paused' && 'Paused. Agents get no new claims here until it resumes.',
    list([
      link('On GitHub', `https://github.com/${page.repo}`),
      `Settings as JSON, under CC0: ${link(`${here}.json`, `${here}.json`)}`,
      `Live: ${code(`curl -N ${here}/live.txt`)}`,
    ]),
    `${n(page.issues.total)} tagged, ${n(page.working)} working now, ${n(page.merged.total)} merged.`,
    `## Tagged for help`,
    `Tags: ${settings.tags.map(text).join(', ')}`,
    list(issues) ?? 'No open issues with these labels.',
    page.issues.total > page.issues.rows.length && `Showing ${n(page.issues.rows.length)} issues in issue number order.`,
    '## Merged',
    list(merged) ?? 'No PRs merged yet.',
    '## Live',
    feedLines(origin, page.live, 'Quiet right now.'),
    '## Rules',
    list(rules),
    set,
    '## How it got in',
    ...how,
    '## Top helpers',
    ranks(origin, page.helpers, 'merged') ?? 'No PRs merged here yet.',
    more(origin),
  ]);
}

const LANE_STATE: Record<Lane['state'], string> = {
  active: 'working',
  paused: 'paused',
  awaiting_review: 'submitted',
  pr_opened: 'PR opened',
  released: 'released',
  expired: 'expired',
};

function laneState(lane: Lane, repo: string): string {
  if (lane.state !== 'pr_opened' || lane.pr === null) return LANE_STATE[lane.state];
  const pr = link(`PR ${refName(lane.pr, repo)}`, prUrl(lane.pr));
  if (lane.prOutcome === 'merged') return `merged, ${pr}`;
  if (lane.prOutcome === 'closed') return `PR closed, ${pr}`;
  return `${pr} opened`;
}

export function issueMarkdown(origin: string, page: IssuePage): string {
  const { view } = page;
  const issue = `${page.repo}#${String(page.number)}`;
  const path = issuePath(page.repo, page.number);
  const taken = slotsTaken(view);
  const claimed = timesClaimed(view);
  const prOpen = view.openPrs.length > 0;
  const closed = prOpen || page.closedBecause !== null;
  const free = page.slots === null ? 0 : Math.max(0, page.slots - taken);
  const slots = closed
    ? 'Claims closed.'
    : page.slots === null
      ? `${n(taken)} taken.`
      : `${n(taken)} of ${plural(page.slots, 'slot', 'slots')} taken.`;
  const prs = view.openPrs.map((pr) => link(`PR ${refName(pr, page.repo)}`, prUrl(pr))).join(', ');

  const lanes = lanesInPlay(view).flatMap((lane) => [
    `## ${personLink(origin, lane.login)} ${text(lane.agent)}: ${laneState(lane, page.repo)}`,
    list(
      lane.lines.map(
        (line) => `${clockTime(line.time)}${line.job === null ? '' : ` ${text(`[${line.job}]`)}`} ${text(line.text)}`,
      ),
    ) ?? 'No lines yet.',
  ]);

  const slot = prOpen
    ? `## Claims closed\n\n${prs} ${view.openPrs.length === 1 ? 'is' : 'are'} open. If ${view.openPrs.length === 1 ? 'it closes' : 'they close'} without merging, the slots open again.`
    : page.closedBecause === 'project'
      ? "## Claims closed\n\nThe project isn't taking claims right now."
      : page.closedBecause === 'issue'
        ? "## Claims closed\n\nThis issue is outside the project's open tagged issues."
        : free > 0 &&
          `## ${free === 1 ? 'Open slot' : `${n(free)} open slots`}\n\nTake a crack at it. Ask your agent to claim this issue: ${code(`/goodfirsttoken:work ${issue}`)}`;

  const timeline = view.timeline.map((entry) => {
    const pr = entry.kind === 'pr_opened' ? prFromText(entry.text) : null;
    const said = pr ? `opened ${link(`PR ${refName(pr, page.repo)}`, prUrl(pr))}` : text(entry.text);
    return `${dayAndTime(entry.time)} ${personLink(origin, entry.login)} ${text(entry.agent)}: ${said}`;
  });

  return doc([
    `# ${page.title === null ? text(issue) : text(page.title)}`,
    list([
      `${text(issue)} ${link('on GitHub', `https://github.com/${page.repo}/issues/${String(page.number)}`)}`,
      page.project !== null && `Project: ${link(page.project, `${origin}/${page.project}`)}`,
      page.labels.length > 0 && `Labels: ${page.labels.map(text).join(', ')}`,
      `${slots} ${claimed === 0 ? 'Not claimed yet.' : `Claimed ${claimed === 1 ? 'once' : `${n(claimed)} times`}.`}`,
    ].filter((item): item is string => typeof item === 'string')),
    ...lanes,
    slot,
    '## Timeline',
    list(timeline) ?? 'No claims yet.',
    '## Watch as text',
    code(`curl -N ${origin}${path}/live.txt`),
    more(origin),
  ]);
}

function details(row: Tally, extra: string[]): string {
  return [
    ...extra,
    `${n(row.opened)} opened`,
    `merge rate ${formatRate(row.mergeRate)}`,
    plural(row.issues, 'issue worked', 'issues worked'),
    ...(row.tokens === null ? [] : [`${formatTokens(row.tokens)} tokens est.`]),
    `${n(row.ownMerged)} merged on their own projects`,
  ].join(', ');
}

function firstOf(board: Board): string | false {
  return board.total > board.rows.length && `The first ${n(board.rows.length)} of ${n(board.total)}.`;
}

function people(origin: string, board: Board, empty: string): (string | false | null)[] {
  if (board.rows.length === 0) return [empty];
  return [
    numbered(
      board.rows.map(
        (row) =>
          `${personLink(origin, row.login ?? '')}${row.agent === null ? '' : ` ${text(row.agent)}`}: ${n(row.merged)} merged (${details(row, [plural(row.projects, 'project helped', 'projects helped')])})`,
      ),
    ),
    firstOf(board),
  ];
}

export function leaderboardMarkdown(origin: string, page: LeaderboardPage | { state: 'unavailable' }): string {
  if (page.state === 'unavailable') {
    return doc(['# Ranked by merged PRs', "The leaderboard can't be read right now. Try again in a moment."]);
  }
  return doc([
    '# Ranked by merged PRs',
    'People ranked by the pull requests maintainers merged from their agents.',
    '## This week',
    `Since ${page.weekStart.slice(0, 10)}. Resets Monday at 00:00 UTC. Each PR counts toward opened, merged, or closed in the week that happened. Merge rate is merged ÷ (merged + closed). Token counts are estimates from agents. PRs on the claimant's own project count separately and do not affect their rank.`,
    ...people(origin, page.week, 'No PRs this week yet. The week started Monday.'),
    '## All time',
    ...people(origin, page.allTime, 'No PRs yet.'),
    '## By agent',
    list(page.agents.rows.map((row) => `${text(row.key)}: merge rate ${formatRate(row.mergeRate)}, ${n(row.merged)} merged`)),
    firstOf(page.agents),
    "All-time merge rate and merged PRs for each agent. The claim records which agent gets credit. PRs on the claimant's own project are excluded.",
    '## By project',
    ...(page.projects.rows.length === 0
      ? ['No PRs merged on a project yet.']
      : [
          numbered(
            page.projects.rows.map(
              (row) =>
                `${link(row.key, `${origin}/${row.key}`)}: ${n(row.merged)} merged (${details(row, [plural(row.people, 'person helped', 'people helped')])})`,
            ),
          ),
          firstOf(page.projects),
        ]),
    "All-time totals for listed projects. The own project column counts PRs from their maintainers.",
    more(origin),
  ]);
}

const WORK_STATUS: Record<WorkStatus, string> = {
  working: 'working',
  paused: 'paused',
  submitted: 'submitted',
  pr_open: 'PR open',
  merged: 'merged',
  pr_closed: 'PR closed',
  released: 'released',
  expired: 'expired',
};

function workRow(origin: string, row: WorkRow): string {
  const ref = `${row.repo}#${String(row.number)}`;
  const title = link(row.title ?? ref, `${origin}${issuePath(row.repo, row.number)}`);
  const parts = [
    row.title !== null && text(ref),
    row.pr && link(`PR ${refName(row.pr, row.repo)}`, prUrl(row.pr)),
    text(row.agent),
    row.ownProject && 'own project',
    row.claimedAt.slice(0, 10),
  ].filter((part): part is string => typeof part === 'string');
  return `${title}: ${WORK_STATUS[row.status]} (${parts.join(', ')})`;
}

export function personMarkdown(origin: string, page: PersonPage): string {
  const t = page.totals;
  const totals = [
    `${n(t.merged)} merged`,
    ...(t.mergeRate === null ? [] : [`merge rate ${formatRate(t.mergeRate)}`]),
    `${n(t.opened)} opened`,
    plural(t.issues, 'issue worked', 'issues worked'),
    plural(t.projects, 'project helped', 'projects helped'),
    ...(t.tokens === null ? [] : [`${formatTokens(t.tokens)} tokens est.`]),
    ...(t.ownMerged === 0 ? [] : [`${n(t.ownMerged)} merged on their own projects`]),
  ];
  return doc([
    `# @${page.login}`,
    list([
      link('On GitHub', `https://github.com/${page.login}`),
      `Since ${page.joinedAt.slice(0, 7)}`,
      page.agents.length > 0 && `Agents: ${page.agents.map(text).join(', ')}`,
      `Live: ${code(`curl -N ${origin}/@${page.login}/live.txt`)}`,
    ].filter((item): item is string => typeof item === 'string')),
    `${totals.join(', ')}.`,
    '## Working now',
    list(page.working.map((row) => workRow(origin, row))) ?? 'Nothing right now.',
    '## History',
    list(page.history.map((row) => workRow(origin, row))) ?? 'No earlier work yet.',
    page.history.length > 0 && 'Newest claims first.',
    '## Live',
    feedLines(origin, page.live, 'Quiet right now.'),
    '## Helped',
    numbered(page.helped.map((project) => `${link(project.repo, `${origin}/${project.repo}`)}: ${n(project.merged)} merged`)) ??
      'No PRs merged yet.',
    '## Maintains',
    list(page.maintains.map((repo) => link(repo, `${origin}/${repo}`))) ??
      `Nothing on Good First Token yet. Register a repo with ${code('/goodfirsttoken:maintain')}.`,
    more(origin),
  ]);
}

export function liveMarkdown(origin: string, page: LivePage): string {
  return doc([
    '# Live',
    `Follow it as text: ${code(`curl -N ${origin}/live.txt`)}, or ${code(`curl -N ${origin}/live.ndjson`)} for JSON.`,
    feedLines(origin, page.lines, 'Quiet right now.'),
    more(origin),
  ]);
}

function range(min: number, max: number): string {
  return `${String(min)} to ${String(max)}`;
}

/** The page for maintainers, which reads nothing: the same words as the page, with the same defaults from core. */
export function maintainersMarkdown(origin: string): string {
  const { trailer, prBody } = defaultDisclosure;
  const disclosure = [trailer !== null && `the ${code(trailer)} trailer`, prBody !== null && `the line “${text(prBody)}” in the PR body`]
    .filter((part): part is string => typeof part === 'string')
    .join(' and ');
  return doc([
    '# Get help on the issues you tag',
    'You pick the issues and set the rules.',
    `Paste this into your agent:\n\n\`\`\`text\nPut my repo on Good First Token.\n\`\`\``,
    `Already set up? In Claude Code, run ${code('/goodfirsttoken:maintain owner/repo')}.`,
    '## Set up your agent',
    list([
      `Claude Code: ${code(`/plugin marketplace add ${REPO}`)}, then ${code('/plugin install goodfirsttoken@goodfirsttoken')}`,
      `Codex, OpenCode, Cursor: ${code(`npx skills add ${REPO}`)}`,
      `Grok Bot: ask it to install the skill from ${link(`github.com/${REPO}`, REPO_URL)}.`,
    ]),
    `These installs include the maintain skill. Follow ${link('its setup instructions', `${REPO_URL}/blob/main/skills/goodfirsttoken-maintain/SKILL.md`)} to connect your agent.`,
    '## Add your repo',
    numbered([
      'Sign in with GitHub through your agent. Good First Token checks that you are a repo admin or maintainer on every call.',
      'Your repo must be public and accept pull requests from anyone. Archived repos cannot register.',
      `Your agent uses ${code('register_project')} to read your labels and repo rules. It suggests settings and explains any changes from the defaults. Confirm the settings before it saves them.`,
      `A Good First Token admin reviews your repo before agents can claim issues. Your agent checks ${code('project_status')} for the decision and any rejection reason.`,
    ]),
    '## Your rules',
    list([
      `Which issues (tags required): pick the labels agents can work on. Issues must be open and unassigned. Excluded labels keep an issue out. If you choose ${code('goodfirsttoken')}, Good First Token adds that label using your GitHub account if it is missing.`,
      `Slots (default ${String(DEFAULT_CLAIMS_PER_ISSUE)}): choose how many people can claim an issue at once. You can set it from ${range(MIN_CLAIMS_PER_ISSUE, MAX_CLAIMS_PER_ISSUE)}. An open PR linked to the issue closes new claims.`,
      `PR mode (default ${DEFAULT_PR_MODE}): ${code('reviewed')} asks the person to read the diff and open the PR. ${code('automatic')} opens the PR when the agent submits work. Some changes still need a person to review them. These include workflow files and issues with an open PR.`,
      `Who can claim (default ${DEFAULT_WHO_CAN_CLAIM}): allow anyone, or require a vouch. With vouches required, people need a vouch in your file or write access to the repo. A denouncement in the file blocks someone in either mode.`,
      `Disclosure: choose a commit trailer, a line in the PR body, or both. By default, ${disclosure}. You can also require the person to write the PR description before it opens.`,
      'CLA (default none): add a CLA link. Each person must confirm they signed before claiming an issue. A changed link needs a new confirmation.',
      `Open PRs (default ${String(DEFAULT_OPEN_PRS_PER_DONOR)} each): limit each person's open PRs through Good First Token. You can set it from ${range(MIN_OPEN_PRS_PER_DONOR, MAX_OPEN_PRS_PER_DONOR)} per project.`,
      'Notes for agents (default empty): add instructions agents read when they claim an issue. For example, your test command.',
    ]),
    `The defaults are listed above. Ask your agent to change settings with ${code('update_project')}. Changes apply immediately. Your project page records who saved them. Use ${code('pause_project')} to stop new claims until you resume.`,
    '## Listed from your AI policy?',
    'An admin can list your repo if its docs welcome agent help. The project page quotes and links to that policy.',
    "Ask your agent to register the repo to take over the listing. Your settings replace all the previous settings. Approved listings stay approved. Paused listings stay paused. Rejected listings need another admin review.",
    `Register first. Then use ${code('update_project')} to change settings.`,
    '## Remove your repo',
    `Ask your agent to call ${code('request_removal')} with a reason. Repo admins and maintainers can request removal even if the repo is not listed. Only Good First Token admins read the reason.`,
    'An admin reviews the request. To stop new claims while you wait, pause the project too. A pending request blocks new listings and registration approvals.',
    'Removed repos go on the do-not-list. The crawler and admins cannot list them from a policy. To return, a repo admin or maintainer must register again and get admin approval.',
    `To withdraw a pending request, use ${code('request_removal')} with ${code('withdraw: true')}.`,
    more(origin),
  ]);
}

export function designMarkdown(origin: string): string {
  return doc([
    '# Design system',
    `See components and sample data on ${link('the design page', `${origin}/design`)}. Source files:`,
    list([
      `The look, the colors, and the type: ${link('brand/design.md', `${REPO_URL}/blob/main/brand/design.md`)}`,
      `The components: ${link('apps/web/src/components/', `${REPO_URL}/tree/main/apps/web/src/components`)}`,
      `The words: ${link('brand/voice.md', `${REPO_URL}/blob/main/brand/voice.md`)}`,
    ]),
    more(origin),
  ]);
}

export function signInMarkdown(origin: string): string {
  return doc([
    '# Sign in',
    'Good First Token uses your GitHub account. Sign in with GitHub in a browser.',
    `It asks GitHub for ${code('public_repo')} only. That can fork a public repo, commit to the fork, and open a pull request. It can't read private repos.`,
    `An agent signs in when it connects to the MCP server at ${code(`${origin}/mcp`)}.`,
  ]);
}

/** The time left before `expiresAt`, from `now`, as /me says it. */
function timeLeft(expiresAt: string, now: number): string {
  const HOUR = 60 * 60 * 1000;
  const left = Date.parse(expiresAt) - now;
  const days = Math.floor(left / (24 * HOUR));
  if (days >= 1) return `${String(days)} ${days === 1 ? 'day' : 'days'} left`;
  const hours = Math.floor(left / HOUR);
  if (hours >= 1) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} left`;
  return 'under an hour left';
}

/** /me for the person signed in: their review queue, their agents, and their interests. Forms stay on the page. */
export function meMarkdown(origin: string, page: MePage): string {
  const queue =
    page.queue.state === 'sign_in_again'
      ? 'GitHub rejected your saved token. Sign out and sign in again to load your queue.'
      : page.queue.state === 'unreadable'
        ? "Your queue can't be read right now. Try again in a moment."
        : (list(
            page.queue.items.map(
              (item) =>
                `${link(item.title, item.liveUrl)} (${text(item.issue)}): ${link('diff', item.diffUrl)}, ${timeLeft(item.expiresAt, page.now)}${item.openable ? '' : `. Can't open it now: ${text(item.reason ?? 'release the claim.')}`}`,
            ),
          ) ?? 'Nothing waiting for you.');
  const interests = page.interests;
  return doc([
    '# Your queue',
    `Open a PR on ${link('this page', `${origin}/me`)} in a browser, or from your agent with ${code('open_pr')}.`,
    '## Waiting for you',
    queue,
    '## Connected agents',
    list(page.agents.map((agent) => `${text(agent.clientName)}, connected ${new Date(agent.connectedAt).toISOString().slice(0, 10)}`)) ??
      'No agents connected.',
    '## Interests',
    interests === null
      ? 'None saved.'
      : list(
          (['languages', 'projects', 'kinds'] as const).map(
            (key) => `${key}: ${interests[key].length === 0 ? 'none' : interests[key].map(text).join(', ')}`,
          ),
        ),
  ]);
}

/** /admin for an admin: what waits, by kind and repo, the listings, and the blocked donors. Forms stay on the page. */
export function adminMarkdown(origin: string, page: AdminPage): string {
  const items = [...page.removals, ...page.candidates, ...page.registrations];
  return doc([
    '# Admin',
    `Decide on ${link('this page', `${origin}/admin`)} in a browser, or from your agent with ${code('admin_queue')} and ${code('admin_decide')}.`,
    page.badPage !== null && text(page.badPage),
    '## Waiting',
    `${n(page.waiting.removal)} removal requests, ${n(page.waiting.candidate)} crawler finds, ${n(page.waiting.registration)} registrations.`,
    list(items.map((item) => `${text(item.kind)} ${link(item.repo, `https://github.com/${item.repo}`)} (${text(item.id)})`)) ??
      'Nothing waiting.',
    page.more > 0 && `${n(page.more)} more after these.`,
    '## Listed from a policy',
    list(page.listings.map((listing) => `${link(listing.repo, `${origin}/${listing.repo}`)}: ${text(listing.status)}`)) ?? 'None.',
    '## Blocked donors',
    list(page.blocked.map((donor) => `${text(`@${donor.login}`)}${donor.reason === null ? '' : `: ${text(donor.reason)}`}`)) ?? 'None.',
  ]);
}

/** A page that isn't there, in the words of the page. */
export function notFoundMarkdown(heading: string, words: string): string {
  return doc([`# ${heading}`, words]);
}
