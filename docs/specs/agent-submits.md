# Submit work with the donor's own tools

Status: approved on October 29, 2026. This changes how a donor's work
reaches GitHub. It replaces step 5 of
[the donor's flow](v1.md#7-the-donors-flow) in v1, the Open PR step in
step 6, and the reason
[section 3](v1.md#3-identity-permissions-and-token-storage) gives for the
`public_repo` scope. It adds one claim transition. The claim rules, the
review queue, and the PR job stay as they are.

## Why

Today `submit_work` takes the full text of each changed file. The server
makes the fork or the branch, commits with `createCommitOnBranch`, and opens
the PR. Every one of those writes uses the donor's token through Good First
Token's OAuth app. That causes three problems:

- An organization that restricts OAuth apps refuses every write from an app
  it hasn't approved, on public repos too. Donors can't submit to its
  projects, and the server can't open a PR there from a fork either
  ([#121](https://github.com/meanwhileso/goodfirsttoken/issues/121)).
- The agent sends each changed file whole, in one tool call. A change to a
  large file, like this repo's 320 KB docs, is more than an agent can send
  that way. A submit also has to stop whenever someone else pushed to the
  branch.
- GitHub takes a change under `.github/workflows/` only from a token with the
  `workflow` scope, which the site doesn't ask for.

The agent already has the repo. The skills tell it to clone the repo and
check out the start commit, and to release the claim when it can't. Git on
the donor's machine can push the branch, and GitHub's own tools can open the
PR. The server then reads what is on GitHub and checks it.

## Choices

The agent pushes the claim's branch and opens the PR with the donor's own
tools: `git push`, then `gh pr create`, GitHub's API, or the compare page on
github.com. Good First Token reads the branch and the PR, checks them
against the project's rules, and records them on the claim. Once the move is
done, the server makes no write to GitHub for a donor's work.

The server still decides when work may become a PR. `open_pr` checks the
project's rules, as it does today, and saves a clearance for the branch's
head commit. A PR counts on the site only when it comes from that commit.
A PR opened without a clearance stays on GitHub, and the server doesn't
record it on the claim.

There is one way to submit. A second path through the server, for
organizations that approved the app, would double the rules and the tests.
The server's write path goes in the last build item. A harness without the
donor's GitHub credentials has the donor push from their own terminal, as
[open question 1](#open-questions) records.

The donor's tools can meet limits of their own. GitHub CLI is an OAuth app
too, so an organization that hasn't approved it may refuse its writes. An
organization can also limit personal access tokens, or require single
sign-on for SSH keys and tokens. A push over SSH and the compare page on
github.com cover most donors, and the skill names each option.

## The flow

1. **Claim.** `claim_issue` also returns the claim's branch name,
   `goodfirsttoken/issue-<number>-<claim ID>`, and whether the donor can push
   to the code repo. It already returns the project's disclosure settings,
   with the commit trailer.
2. **Work and commit.** The agent commits on the claim's branch, starting at
   the start commit. When the project names a commit trailer, each commit
   carries it, as `<trailer>: <agent> (<model>)`. The agent may merge the
   default branch into the claim's branch, or rebase onto it.
3. **Push.** The agent pushes the branch to the code repo when the donor can
   push there, and to a fork of it otherwise. When the donor has no fork,
   the agent makes one with `gh repo fork`, or the donor makes one on
   github.com.
4. **Submit.** `submit_work` takes the branch's repo, its name, and its head
   commit, with the title, summary, checks, agent, model, and token estimate
   it takes today. The server checks the branch, as
   [below](#what-the-server-checks), and records the submit. The work goes to
   the review queue, as today. In automatic mode with no reason to review,
   the submit also clears the work to open, and answers as `open_pr` does.
5. **Clear.** `open_pr` checks the rules it checks today, and saves a
   clearance: the head commit, the PR's title and body, and the time. It
   answers with the title, the body, the PR's head as `<owner>:<branch>`, its
   base, the command to open it, and a compare page link. The body is the
   one the server writes today: the donor's description, or the summary and
   checks, then the closing line and the project's disclosure text. A later
   submit with a new head ends the clearance.
6. **Open.** The agent opens the PR with that title and body, as
   `gh pr create --repo <code repo> --head <head> --base <base> --title <title> --body-file <file>`.
   When `gh` can't, the agent gives the donor the compare page link, which
   opens GitHub's form with the title and body filled in.
7. **Record.** `record_pr` takes the claim and the PR's link. The server
   reads the PR and checks it. When the PR passes, the claim's room records
   it, as `open_pr` records a PR today, and the PR job follows it.
8. **Find PRs nobody recorded.** A job looks up each cleared claim's branch
   on GitHub, with GitHub's list of PRs filtered by head, and records a PR
   that passes. So a PR the donor opens on github.com counts, even when the
   agent stops before `record_pr`.
9. **Fixes.** The agent pushes fixes for a review to the same branch. Then
   `submit_work` with the new head records them and answers the follow-ups,
   as today. A claim whose PR is open needs no clearance for a fix.

In reviewed mode, the donor's word to the agent, or a click on /me, is the
review, as it is today. Either one leads to a clearance.

## What the server checks

At `submit_work`:

- The branch is in the code repo, or in a fork of it.
- The branch has the claim's name, and its head is the commit the agent
  named.
- The start commit is an ancestor of the head.
- The branch has commits that aren't on the default branch. When it has
  none, the submit is refused with `no_changes`.
- When the project names a commit trailer, each of those commits carries
  it, apart from merge commits. On a fix after the PR opens, the check
  covers the commits since the last submit, apart from those GitHub names
  another person as the author of. Maintainers may push to the PR's branch.
- The review reasons apply as today: another PR on the issue, a change to a
  workflow file, the open-PR cap, a description the donor must write, and
  reviewed mode. A comparison too long to list every file or every commit
  sends the work to review. GitHub lists at most 250 commits in one.
- A PR already open from the claim's branch doesn't count as another PR on
  the issue. It can be recorded once its head is cleared.

The server doesn't check who wrote each commit. A local commit's email may
not be linked to the donor's GitHub account, and GitHub then names no user
for it. The PR's author ties the work to the donor.

At `open_pr`, the checks are today's. The issue is open, tagged, and
assigned to no one but the donor. The donor is under the project's open-PR
cap. The cap now counts the donor's recorded open PRs and their cleared
claims that have no PR yet. A cleared claim stops counting when it records
a PR, or when it is released or expires.

At `record_pr`, and in the job that finds PRs:

- The PR is in the code repo, aimed at its default branch, and open or
  merged.
- Its head is the claim's branch, in the repo the submit named, at the
  cleared commit.
- Its author has the claim's GitHub ID.
- Its body has the closing line, and the project's disclosure text word for
  word when the project sets one.
- The server's secret scrubber finds nothing in its title or body.

The issue's labels and assignees aren't checked again. Maintainers often
relabel or assign an issue once a PR is on it, so `open_pr`'s check of the
issue stands. Another PR on the issue doesn't stop a record either.

When a check fails, `record_pr` refuses and names the fix, like
`gh pr edit <link> --body-file <file>`. The job checks the PR again on its
next run. A PR that never passes stays on GitHub with no credit. While it is
open, it keeps the issue from taking new claims, as any linked PR does.

A second record of the same PR, by `record_pr` or by the job, changes
nothing and answers with the PR. The claim's room already answers that case
with `pr_already_opened`.

**Deadlines.** A claim waiting in the review queue expires 7 days after its
first submit, as today. A PR made before the claim expired, from its cleared
commit, is recorded after it expires too. That is the new transition, from
`expired` to `pr_opened`. A merged PR is recorded like an open one, so a
merge between two runs of the job still counts.

**What it costs.** A submit costs about eight GitHub calls, all reads: the
repo, the issue, the branch's repo, the branch, a comparison with the start
commit, a comparison with the default branch, and the issue's closing
references and timeline. Today's first submit to a fork makes about 14. The
job costs one call a run for each cleared claim with no PR yet, and runs on
the PR job's schedule. While the agent calls, reads use the donor's token.
The job reads with the service token, as the PR job does.

## Tools, refusals, and pages

- `submit_work` takes `branch`, with its repo, name, and head. While the move
  lasts, it takes `files` too, as today.
- `open_pr` takes `description` as today. For a submit with `branch`, it saves
  the clearance and opens nothing on GitHub. For a submit with `files`, it
  opens the PR, as today.
- `record_pr` is new. It takes `claimId` and the PR's link.
- `my_work` shows cleared work with its compare page link, and a new review
  reason, `ready_to_open`, for work cleared with no PR yet.
- New refusals name what to fix: a branch GitHub doesn't show, a branch in
  another repo, a head that doesn't come from the start commit, a commit
  without the trailer, and a PR that fails a check. The build picks their
  codes.
- On /me and in the MCP Apps review queue, Open PR saves the clearance and
  shows the compare page link for work submitted with `branch`. The job
  records the PR the donor opens there.

The compare page link is
`https://github.com/<code repo>/compare/<base>...<owner>:<branch>?quick_pull=1&title=<title>&body=<body>`.
GitHub documents those query parameters in
[Using query parameters to create a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/using-query-parameters-to-create-a-pull-request).
GitHub refuses a link that is too long. What to do with a long body is
[open question 4](#open-questions).

## Tokens and scope

The maintainer tools still write. `register_project` adds the project's
label with the maintainer's token. So the site keeps asking everyone for
`public_repo` for now. /start.md, and the site's pages that explain the
scope, stop saying the site forks and commits for the donor. Asking donors
for no scope is [open question 3](#open-questions).

What the server gives up:

- **GitHub's signature.** GitHub signs a commit made with
  `createCommitOnBranch`, so today's commits satisfy projects that require
  signed commits. A local commit is signed only when the donor's git signs
  it. The skill tells the agent to keep the donor's signing setup.
- **Scrubbing before GitHub sees the text.** The server writes the PR body
  from the scrubbed summary and checks, and checks what is posted. It can't
  take back text that is already on GitHub. The skill's rule against posting
  secrets covers commit messages, the PR's title, and its body.
- **Stopping a PR against the rules.** The server can refuse to record a PR,
  and admins can block a donor with `admin_block_donor`. Only GitHub can
  stop a donor from opening a PR.

## Moving over

1. `submit_work` takes `files` or `branch`. A submit with `files` works as
   today, from the commit to the PR, so old skills, /me, and the MCP Apps
   review queue keep working.
2. The plugin's version goes up when the skills send `branch`. Skills
   installed with `npx skills add` or from GitHub have no version to check,
   so the tool descriptions say to send `branch`, and the refusal in step 3
   names the update.
3. In item 6, `files` goes. A submit with files is
   then refused with a message that tells the agent to update the skill and
   push the branch.
4. Claims submitted with `files` keep the branches the server made. Those
   branches have the claim's name, so a clearance, the compare page link,
   and the job work for them after step 3.
5. With `files` go `commitWork`, `planChange`, and the push checks in
   `src/mcp/submit.ts`, the writes in `src/donor/writes.ts`, and the file
   limits in `packages/core`. The fork fallback in
   [#122](https://github.com/meanwhileso/goodfirsttoken/pull/122) isn't
   needed. Its model of OAuth app restrictions in the GitHub fake is, and
   item 1 below takes it.

The GitHub fake can't take a `git push`. Tests put a branch in place with
the fake's `commitFiles`, which commits to any branch as any person, and
check the compare page link as a URL.

## Work order

Six implementation issues follow once this spec is approved. Each owns its
tests and its updates to how-it-works.md and architecture.md. ROADMAP.md
places them in their own milestone.

1. Accept a pushed branch in `submit_work`, and check it. Return the branch
   name and push access from `claim_issue`. Keep `files`. Take the fake's
   OAuth app restrictions from #122.
2. Save a clearance in `open_pr` for work submitted with `branch`, count
   cleared claims toward the cap, and return the PR's text and compare page
   link. Add `record_pr`, the `ready_to_open` reason, and the transition
   from `expired`. This follows item 1.
3. Add the job that finds and records PRs from cleared claims' branches.
   This follows item 2.
4. Show cleared work with its compare page link in `my_work`, on /me, and in
   the MCP Apps review queue. This follows item 2.
5. Teach the skills and /start.md to commit with the trailer, push, open the
   PR, and record it. Raise the plugin's version. This follows items 3 and 4.
6. Remove `files` and the server's write path. This follows item 5.

## Done when

- An agent that pushed the claim's branch to a fork or to the code repo
  submits it, and the server checks it with GitHub reads alone.
- A branch with the wrong name, in another repo, not from the start commit,
  with no new commits, or with a commit other than a merge missing the
  project's trailer is refused, and the message names the fix.
- `open_pr` saves a clearance and returns a title and body with the closing
  line and the disclosure text. It writes nothing to GitHub for work
  submitted with `branch`.
- The open-PR cap counts cleared claims, so a donor at the cap can't clear
  another one.
- `record_pr` records a PR from the cleared commit. It refuses one from
  another commit, another branch, another fork, another author, or another
  base, or with a body missing the closing line or the disclosure text. A
  refused PR records once it is fixed.
- A PR still records after the maintainers relabel or assign the issue, and
  when another PR is on it.
- The job records a PR the donor opened on github.com from a cleared
  claim's branch, including one merged before the job ran, and one made
  just before the claim expired. A second record of the same PR changes
  nothing.
- A submit with `files` works from the commit to the PR, as today, until
  item 6 merges.
- In an organization that restricts OAuth apps, work goes from claim to a
  recorded PR, with the PR opened on the compare page. A test with the
  GitHub fake's restriction covers it.
- After item 6, no donor tool makes a write to GitHub, and a test fails
  when one does.
- Behavior tests, `pnpm check`, and the skill harness checks pass. A fresh
  agent reviews each implementation against this list.

## Open questions

1. Which supported harnesses can push with the donor's credentials. Claude
   Code, Codex, OpenCode, and Cursor usually run on the donor's machine,
   with the donor's git and GitHub CLI. Grok Bot runs on its own cloud
   computer, and cloud sessions of other harnesses push through their own
   GitHub integrations. Answered when the spec was approved: the server's
   write path goes without waiting for that check. In a harness that can't
   push, the donor pushes the branch from their own terminal, and the
   skill says so.
2. Whether an organization that restricts OAuth apps refuses GitHub CLI's
   writes to its public repos, as it refuses the site's. Check on real
   GitHub with an organization that hasn't approved GitHub CLI.
3. Whether a donor can sign in with no scope, with maintainers granting
   `public_repo` when they register a project. A GitHub OAuth app can ask
   for more scopes in a later sign-in.
4. How long a compare page link GitHub takes, and what the link should do
   with a body that is longer.
