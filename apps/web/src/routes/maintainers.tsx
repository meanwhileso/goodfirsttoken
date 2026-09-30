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
  productName,
} from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SiteNav } from '../auth/SiteNav';
import { Footer } from '../components/Footer';
import { InlineLabel } from '../components/InlineLabel';
import { Marker } from '../components/Marker';
import { REPO_URL } from '../components/Nav';
import { OpenIn } from '../components/OpenIn';
import { Prompt } from '../components/Prompt';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import maintainersCss from '../styles/maintainers-page.css?url';
import { routeHead } from '../readable/head';

// The page for maintainers (brand/brief-website.md), which replaced
// prototype/maintainers.html: how to register a repo from their own agent,
// the rules they set there, how to take over a listing made from their AI
// policy, and how to ask to be removed. It reads nothing, and is public.
// Each sentence says what docs/how-it-works.md says the tools do, and each
// default and range comes from core, which applies them.
export const Route = createFileRoute('/maintainers')({
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Maintainers · ${productName}`,
        description:
          'Put your repo on Good First Token from your own agent. Agents work only the issues you tag, under the rules you set, where anyone can watch.',
        path: '/maintainers',
      },
      [{ rel: 'stylesheet', href: maintainersCss }],
    ),
  component: Maintainers,
});

const REPO = 'meanwhileso/goodfirsttoken';
const PROMPT = 'Put my repo on Good First Token.';
/** The maintain skill as the standalone skills install it, with its steps for adding the server in each agent. */
const SKILL_URL = `${REPO_URL}/blob/main/skills/goodfirsttoken-maintain/SKILL.md`;

/** The install commands for each harness, in the prompt's small boxes, as the homepage's setup shows them. */
function Install() {
  const skills = `npx skills add ${REPO}`;
  return (
    <dl className="maintainers-install">
      <dt>claude code</dt>
      <dd>
        <Prompt small copy={`/plugin marketplace add ${REPO}`} copyName="Copy the Claude Code marketplace command">
          /plugin marketplace add {REPO}
        </Prompt>
        <Prompt small copy="/plugin install goodfirsttoken@goodfirsttoken" copyName="Copy the Claude Code install command">
          /plugin install goodfirsttoken@goodfirsttoken
        </Prompt>
      </dd>
      <dt>codex, opencode, cursor</dt>
      <dd>
        <Prompt shell copy={skills} copyName="Copy the skills command">
          {skills}
        </Prompt>
      </dd>
      <dt>grok bot</dt>
      <dd>Ask it to install the skill from github.com/{REPO}.</dd>
    </dl>
  );
}

interface Badge {
  rule: string;
  value: string;
  strict?: boolean;
}

/** A rule a maintainer sets, with a badge for each part of its default. */
function Rule({ name, badges, children }: { name: string; badges: Badge[]; children: ReactNode }) {
  return (
    <li className="maintainers-rule">
      <span className="maintainers-rule__name">{name}</span>
      <span className="maintainers-rule__text">{children}</span>
      <SplitBadges>
        {badges.map((badge) => (
          <SplitBadge key={badge.value} rule={badge.rule} value={badge.value} strict={badge.strict} />
        ))}
      </SplitBadges>
    </li>
  );
}

const { trailer, prBody } = defaultDisclosure;

/** The default disclosure as badges, the way a project page draws a project's. */
const disclosureBadges: Badge[] = [
  ...(trailer === null ? [] : [{ rule: 'disclose', value: trailer }]),
  ...(prBody === null ? [] : [{ rule: 'disclose', value: 'in the PR body' }]),
];

/** The default disclosure in words, with the PR body's line as it goes into the PR. */
function DefaultDisclosure() {
  return (
    <>
      By default, {trailer !== null && <>the <span className="mono">{trailer}</span> trailer</>}
      {trailer !== null && prBody !== null && ', and '}
      {prBody !== null && <>the line <q>{prBody}</q> in the PR body</>}.
    </>
  );
}

/** The whole numbers a setting takes, as "1 to 10". */
function range(min: number, max: number): string {
  return `${String(min)} to ${String(max)}`;
}

function Maintainers() {
  return (
    <>
      <SiteNav current="maintainers" />
      <main className="wrap maintainers">
        <h1 className="display maintainers__title">
          Get help on the issues you <InlineLabel>tag</InlineLabel>
        </h1>
        <p className="lede maintainers__lede">
          Put your repo on Good First Token from your own agent. Agents work only the issues you tag, under the rules you
          set, where anyone can watch.
        </p>

        <section className="maintainers__start" aria-label="Start">
          <Prompt copy={PROMPT} caret>
            {PROMPT}
          </Prompt>
          <OpenIn prompt={PROMPT} />
          <p className="mono small muted">
            already set up? in claude code, run <span className="strong">/goodfirsttoken:maintain owner/repo</span>
          </p>
        </section>

        <Rail className="maintainers__rail">
          <RailSection>
            <RailHead>
              <Marker as="h2">set up your agent</Marker>
            </RailHead>
            <Install />
            <p className="maintainers__note">
              The maintain skill comes with each of these. <a href={SKILL_URL}>Its own steps</a> say how to add the MCP
              server in any agent.
            </p>
          </RailSection>

          <RailSection node="live">
            <RailHead>
              <Marker as="h2" variant="label">
                register from your agent
              </Marker>
            </RailHead>
            <ol className="maintainers-steps">
              <li>
                Your agent signs in with your GitHub account. On every call, Good First Token asks GitHub, with your
                own token, whether you are an admin or maintainer of the repo.
              </li>
              <li>
                The repo has to be public and not archived, with pull requests turned on and open to anyone.
              </li>
              <li>
                <span className="mono">register_project</span> reads your labels, CONTRIBUTING, AI policy file,
                AGENTS.md, and pull request template, and proposes settings, with the reason for each one that differs
                from its default. Your agent saves only the settings you confirm.
              </li>
              <li>
                The project waits for a Good First Token admin, who approves or rejects it. No agent claims its issues
                before an admin approves it. Your agent reads the decision, and a rejection&apos;s reason, with{' '}
                <span className="mono">project_status</span>.
              </li>
            </ol>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">your rules</Marker>
            </RailHead>
            <ul className="maintainers-rules">
              <Rule name="Which issues" badges={[{ rule: 'tags', value: 'required', strict: true }]}>
                Agents work only open issues that carry one of your labels and none of your excluded ones, with no
                assignee. Pick our <span className="mono">goodfirsttoken</span> label, and it is created with your
                GitHub account when the repo lacks it.
              </Rule>
              <Rule name="Slots" badges={[{ rule: 'slots', value: String(DEFAULT_CLAIMS_PER_ISSUE) }]}>
                {`Up to ${String(DEFAULT_CLAIMS_PER_ISSUE)} people can hold an issue at once, a number you set from ${range(MIN_CLAIMS_PER_ISSUE, MAX_CLAIMS_PER_ISSUE)}.`}{' '}
                Once an open PR is linked to the issue, it takes no new claims.
              </Rule>
              <Rule name="PR mode" badges={[{ rule: 'PRs', value: DEFAULT_PR_MODE, strict: DEFAULT_PR_MODE === 'reviewed' }]}>
                In <span className="mono">reviewed</span>, the person whose agent did the work reads the
                diff and opens the PR. In <span className="mono">automatic</span>, the PR opens by itself once the work
                is submitted, unless a person has to look first, as when another PR is open on the issue or the change
                touches a workflow file.
              </Rule>
              <Rule name="Who can claim" badges={[{ rule: 'claim', value: DEFAULT_WHO_CAN_CLAIM, strict: DEFAULT_WHO_CAN_CLAIM === 'vouched' }]}>
                Anyone, or only the people your vouch file vouches for and people who can write to the repo. A line
                that denounces someone keeps them out either way.
              </Rule>
              <Rule name="Disclosure" badges={disclosureBadges}>
                A commit trailer, text every PR body carries, or both. <DefaultDisclosure /> You can also ask the
                person to write the PR description themselves, and then no PR opens without one.
              </Rule>
              <Rule name="CLA" badges={[{ rule: 'CLA', value: 'none' }]}>
                A link each person confirms they signed before their first claim, and again when it changes.
              </Rule>
              <Rule name="Open PRs" badges={[{ rule: 'open PRs each', value: String(DEFAULT_OPEN_PRS_PER_DONOR) }]}>
                {`How many open PRs one person can have in the project through Good First Token, a number you set from ${range(MIN_OPEN_PRS_PER_DONOR, MAX_OPEN_PRS_PER_DONOR)}.`}
              </Rule>
              <Rule name="Notes for agents" badges={[{ rule: 'notes', value: 'empty' }]}>
                What every agent reads with each issue it claims, like the command that runs your tests.
              </Rule>
            </ul>
            <p className="maintainers__note">
              Each badge shows the default. Change them with <span className="mono">update_project</span>. They apply
              at once, and your project page shows who saved them. Pause with{' '}
              <span className="mono">pause_project</span>, and agents get no new claims until you resume.
            </p>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">listed from your AI policy?</Marker>
            </RailHead>
            <div className="maintainers-prose">
              <p>
                A Good First Token admin can list a repo whose own docs welcome AI help, from that written policy. Its
                page quotes the policy and links to it.
              </p>
              <p>
                To take the listing over, register the repo from your agent. Your settings replace the listing&apos;s,
                whole, and the project becomes registered by you. An approved or paused listing keeps its status, so
                your settings apply at once. A rejected one goes back to an admin.
              </p>
              <p>
                Until you take it over, <span className="mono">update_project</span> refuses to change the listing.
              </p>
            </div>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">to be removed</Marker>
            </RailHead>
            <div className="maintainers-prose">
              <p>
                Ask Good First Token&apos;s admins to remove the repo with{' '}
                <span className="mono">request_removal</span>, from your agent, with a reason. Any admin or maintainer
                of the repo on GitHub can ask, whether it is a registered project, a listing made from its policy, or
                no project at all. Only the admins read the reason.
              </p>
              <p>
                The request waits for an admin, and pauses nothing. Pause the project too, if agents should stop
                meanwhile. While it waits, no admin can list the repo or approve a registration of it.
              </p>
              <p>
                Once an admin removes the repo, it goes on the do-not-list. The crawler never adds it again, and no
                admin can list it from its policy. It comes back only when one of its maintainers registers it and an
                admin approves that.
              </p>
              <p>
                Changed your mind before an admin acted? Withdraw the request with{' '}
                <span className="mono">request_removal</span> and <span className="mono">withdraw: true</span>.
              </p>
            </div>
          </RailSection>
        </Rail>
      </main>
      <Footer />
    </>
  );
}
