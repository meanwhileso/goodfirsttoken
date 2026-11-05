# Add a repo from the site, and request one

Status: proposed on November 5, 2026.

This adds two ways for a repo to reach Good First Token from the site, and
one from a donor's agent:

- A maintainer registers their repo with a form on `/maintainers`, under
  the same rules `register_project` uses from their agent.
- A donor asks for a repo they want to work on, from the homepage, from
  `/request`, or by asking their agent, which calls a new tool,
  `request_repo`.

It changes goal 2 of [v1](v1.md#goals), which has maintainers register
"entirely from their own agent". The agent path stays, and the form is a
second way in. The [principles](v1.md#principles) stay as they are: a
request lists nothing, and a project still needs its maintainers' yes in
writing and an admin's approval.

## Why

Today the only way in is a maintainer's agent with the MCP server
connected, or the crawler finding a popular repo whose docs welcome AI
help. That leaves out two groups:

- Maintainers who would say yes but haven't set up an agent with the
  server. `/maintainers` gives them install commands and a prompt, and no
  way to finish on the page.
- Donors who want to spend tokens on a repo that isn't listed. The give
  skill tells them it couldn't find the project, and the request ends
  there. The crawler reads only repos with at least 1,000 stars, so a
  smaller project a donor cares about is never read at all.

## Choices

**A request lists nothing.** It records who asked for which repo, and puts
the repo on the crawler's seed list, so the crawler reads its docs whatever
its stars. From there the rules are the ones that exist now:

- When the repo's docs welcome AI help, the crawler puts it in the admin
  queue as a find, and an admin decides.
- When they don't, it stays out. Its maintainers can still register it.

**Requests stay private.** No public page lists requested repos or their
counts, and Good First Token writes nothing to GitHub for a request: no
issue, comment, or label. Maintainers are pushing back on unwanted AI pull
requests, and a public "most wanted" list would push them too. The count
shows only to admins, and to a maintainer who registers the repo, as "12
people asked for this repo."

**One rule each, two doors.** The site and the MCP server call the same
code. The form on `/maintainers` runs `register_project`'s proposal and
save. `/request`, the homepage form, and `request_repo` run one request
action. The site's words for each refusal are written for the person
reading them, as `/me` does for `open_pr`.

**Sign-in comes back to the form.** Sign-in lands on `/me` today. It gains
a return path, limited to the two new forms, so someone signed out who
starts a request or a registration finishes it after GitHub sends them
back.

## Requesting a repo

**Who.** Anyone signed in, on the site or through their agent. A blocked
donor is refused with `donor_blocked`.

**Which repos.** `owner/repo`, a GitHub repo URL, or a Good First Token
project URL, read as `owner/repo`. The request reads the repo from GitHub
with the service token, and refuses with `repo_not_eligible`, naming the
reason, a repo that:

- GitHub doesn't show, or shows as private,
- is archived,
- has pull requests turned off, or
- lets only collaborators open pull requests.

These are the checks `register_project` makes, read with the service token
since the person asking isn't a maintainer. The request is saved under the
name GitHub gives, and its GitHub repo ID, under
[Repo IDs](../how-it-works.md#repo-ids).

**What it records.** One request per person per repo, compared without case.
Asking again changes nothing and answers with the status. A request keeps
the person's GitHub ID and when they asked. The person can withdraw it,
from `/me` or with `request_repo` and `withdraw: true`.

**The seed list.** A new request adds the repo to the crawler's seed list
as a seed from requests, which names no admin. The seed list's rules apply
as they are: a repo that is a project already, or that the crawler put in
the admin queue before, isn't added. The crawler reads admin seeds first,
then seeds from requests, oldest first, at most 5 of them a run, so
requests can't crowd out admin seeds or the search.

**Status.** A request's status is worked out when it is read, from what
Good First Token already keeps. Nothing stores it.

| Status | When | Words for the person |
|---|---|---|
| `listed` | An approved project has the repo | "Listed. Find its issues on its project page." |
| `paused` | The repo's project is paused | "Listed, and paused. It takes no claims right now." |
| `waiting` | The crawler hasn't read the repo yet, its find waits in the admin queue, or its registration waits for review | "Waiting. Good First Token reads its docs, and an admin decides." |
| `not_listed` | The crawler read the repo and its docs don't welcome AI help, or an admin rejected its find or its registration | "Not listed. Its docs don't welcome AI help yet. Its maintainers can register it at /maintainers." |
| `removed` | The repo is on the do-not-list | "Its maintainers asked Good First Token not to list it." |

A repo that is already `listed`, `paused`, or `removed` when someone asks
records no request, and answers with that status.

`not_listed` needs the crawler to keep the tier its rules read for a seed
from requests, as it keeps a hash of a rejected find. The crawler reads
the repo again on each pass, so a project whose docs change later can
still be found.

**Limits**, our choice, so they can change:

| What | Limit |
|---|---|
| New requests from one person | 10 a UTC day |
| Requests one person has waiting | 50 |
| Seeds from requests the crawler reads | 5 a run, after admin seeds |
| Requests the admin queue lists on an item | 5 logins, and a count of the rest |

**The admin queue.** A crawler find or a registration says how many people
asked for its repo, with the first five logins. Admins weigh it. It
approves nothing.

**The maintainer.** `register_project`'s proposal, `project_status`, and
the form on `/maintainers` say how many people asked for the repo. They
name no one.

### `request_repo`

A donor tool, listed for every signed-in agent.

| Input | Type | Notes |
|---|---|---|
| `repo` | string | `owner/repo`, a GitHub repo URL, or a Good First Token project URL |
| `withdraw` | boolean, optional | Withdraws the person's request |

It answers with `repo` as GitHub names it, `status` from the table above,
`requested` (whether this person has a request on it now), `projectUrl`
when there is a project page, and `message`, the words in the table.
Refusals: `donor_blocked`, `repo_not_eligible`, `rate_limited`,
`invalid_input`.

`rate_limited` is new. It names the limit that was hit and when the next
request can go in.

### The give skill

[Find a named project](../../skill-src/shared/donor-project.md) step 2 says
the agent couldn't find the project when no listing matches. Next, when
the donor named a repo, the agent offers to request it, and calls
`request_repo` only after the donor says yes. It tells the donor the
answer's `message`, and offers other projects to work on today. The give
skill's description adds requesting a repo, so "ask Good First Token to add
owner/repo" reaches the skill.

## Registering from the site

`/maintainers` gets a form at the top, beside the prompt, for a maintainer
who'd rather not set up an agent first. It goes to `/maintainers/add`.

1. **The repo.** The maintainer types `owner/repo`. Signed out, the button
   reads "Sign in with GitHub to continue", and sign-in comes back to
   `/maintainers/add?repo=owner/repo`.
2. **The proposal.** `/maintainers/add?repo=owner/repo` runs
   `register_project` with no settings, with the token from the person's
   sign-in on the site. A refusal shows in words for the person, with what
   to do next. Otherwise the page shows the proposed settings as a form,
   each with the proposal's reason under it, and how many people asked for
   the repo.
3. **Saving.** The form sends every setting to `register_project` with
   settings. A setting that fails its check shows its problem under the
   field, with the person's values kept. A saved registration shows "Sent
   for review", whether the `goodfirsttoken` label was created, and a link
   to the person's projects on `/me`.

Taking over a policy listing and registering a rejected repo again work on
the form as they do from the agent, and the page says which is happening
before the save. A repo that is already a registered project shows its
status, and says to change its settings from the agent with
`update_project`. Changing settings on the site is outside this spec.

The form is a plain form. It posts to its own route, checks the `Origin` as
the site's other forms do, and works without JavaScript.

## Signing in and coming back

`POST /auth/sign-in` takes an optional `next`. It is used only when it is
exactly `/request?repo=<owner>/<repo>` or `/maintainers/add?repo=<owner>/<repo>`,
where owner and repo are GitHub names: letters, digits, hyphens, and for
the repo also dots and underscores. Anything else, including other paths,
other hosts, encoded slashes, and backslashes, lands on `/me` as today.
The state that ties sign-in to the browser carries `next`, so GitHub never
sees it.

## Pages

### The homepage

The homepage gets a second action under the prompt: the request form, and a
link for maintainers. The prompt stays first.

```
 Spend your spare tokens on [open source]          ░░▓░░░░▒░░░░░░
 Your agent works on an issue a maintainer         ░▒░░░░░░░▓░░░░
 tagged for outside help. ...                      agent work, live  412 today

 ┌──────────────────────────────────────────────────────────────────────┐
 │ > Read goodfirsttoken.org/start.md, then spend some of my tokens ... ⧉│
 └──────────────────────────────────────────────────────────────────────┘
 open in: claude code · codex · cursor · t3 code      ▸ set up your agent

 ┌─ ● request a repo ──────────────────────┐ ┌─ ● maintainers ────────────┐
 │ Want your agent on a repo that isn't     │ │ Get agent help on your     │
 │ listed? Ask for it.                      │ │ issues. You pick the       │
 │ ┌───────────────────────────┐ ┌───────┐ │ │ issues and set the rules.  │
 │ │ owner/repo                │ │request│ │ │                            │
 │ └───────────────────────────┘ └───────┘ │ │ [ add your repo ↗ ]        │
 │ It's listed once its docs welcome AI     │ │                            │
 │ help or its maintainers register it.     │ │                            │
 └──────────────────────────────────────────┘ └────────────────────────────┘

 ● live ──────────── curl -N goodfirsttoken.org/live.txt
```

- Two cards side by side at 880px and up. Under 880px they stack, request
  first.
- Each card's title is a `Marker`. The input is mono, with the placeholder
  `owner/repo` and an accessible label "Repo to request". The button is the
  design system's `Button`, size `sm`.
- The form is `GET /request` with `repo`, so the homepage still sets no
  cookie and writes nothing.
- "add your repo" is a `ButtonLink` with no variant, the white secondary
  button, linking to `/maintainers#add`.
- In "projects asking for help", the head keeps "add yours ↗" and adds
  "request one ↗", which links to `/request`.

### `/request`

```
 Request a repo

 ┌───────────────────────────┐ ┌───────┐
 │ sample-owner/tiny-lib     │ │ check │
 └───────────────────────────┘ └───────┘

 sample-owner/tiny-lib                              ★ 312 · pushed 2 days ago
 Good First Token reads its docs. It's listed once its docs welcome
 AI help, or its maintainers register it.

 [ Request sample-owner/tiny-lib ]            signed out: [ Sign in with GitHub to request it ]

 or ask your agent:
 ┌──────────────────────────────────────────────┐
 │ > Ask Good First Token to add sample-owner/tiny-lib.         ⧉ │
 └──────────────────────────────────────────────┘
```

After the request, the page shows a notice styled as `/me`'s
`.account__notice`, with the status words, and a link to "your requests" on `/me`.

| State | What shows |
|---|---|
| No `repo` | The input and check button only |
| `repo` can't be read as owner/repo | "Type a repo as owner/repo, or paste its GitHub link." |
| Not eligible | The reason, like "This repo lets only collaborators open pull requests, so agents can't send PRs to it." No request button |
| Already listed or paused | The status words and a link to the project page. No request button |
| On the do-not-list | "Its maintainers asked Good First Token not to list it." No request button |
| Already requested by this person | The status, and "You asked for it on Nov 3." with Withdraw |
| Rate limited | "You've sent 10 requests today. Try again tomorrow." |
| GitHub didn't answer | "GitHub didn't answer. Try again in a minute." |

### `/maintainers`

The start section gets the form beside the prompt. At 880px and up, the
prompt is on the left and the form on the right. Under 880px the form
comes first, since it needs nothing installed.

```
 Get agent help on your [issues]
 You pick the issues and set the rules.

 ┌─ ● from your agent ───────────────────┐ ┌─ ● on this page ─────────────┐ id="add"
 │ > Put my repo on Good First Token.  ⧉ │ │ ┌───────────────────┐ ┌────┐ │
 │ open in: claude code · codex · ...    │ │ │ owner/repo        │ │next│ │
 │ already set up? in claude code, run   │ │ └───────────────────┘ └────┘ │
 │ /goodfirsttoken:maintain owner/repo   │ │ Sign in with GitHub. You     │
 └───────────────────────────────────────┘ │ need admin or maintain on    │
                                           │ the repo.                    │
                                           └──────────────────────────────┘
```

### `/maintainers/add?repo=owner/repo`

```
 Add sample-owner/tiny-lib

 12 people asked for this repo on Good First Token.

 ● which issues
   Tags            [x] help wanted   [ ] good first issue   [x] goodfirsttoken
                   Your labels that mean ready for outside help. goodfirsttoken
                   is added to your repo with your GitHub account if it's missing.
   Excluded tags   [ good first issue                     ]
   Issue repo      [ same as the code repo                ]

 ● pull requests
   PR mode         (•) reviewed   ( ) automatic
   Disclosure      trailer [ Assisted-by ]   PR body [ Written with a coding agent... ]
                   Your CONTRIBUTING.md asks for "Assisted-by:".   ← proposal's reason
   Person-written description  [ ]
   CLA             [ https://                              ]

 ● who and how many
   Who can claim   (•) anyone   ( ) vouched
   Claims per issue [ 3 ]  1 to 10      Open PRs per donor [ 2 ]  1 to 10

 ● notes for agents
   [ textarea, 2,000 characters                           ]

 [ Register sample-owner/tiny-lib ]
 A Good First Token admin reviews it before agents can claim issues.
```

- Sections use `Marker` and the rule rows of the current `/maintainers`
  page. Defaults show as the same `SplitBadge`s.
- A proposal reason shows under its field in muted small text.
- A field error shows under its field in `--danger`, and the field
  gets `aria-invalid` and `aria-describedby`.
- Takeover of a policy listing shows a notice above the form: "An admin
  listed this repo from its AI policy. Your settings replace the
  listing's."

| State | What shows |
|---|---|
| Signed out | The repo, and "Sign in with GitHub to continue" |
| `not_maintainer` | "GitHub doesn't show you as an admin or maintainer of owner/repo. Ask someone who is to add it." |
| `repo_not_eligible` | The reason, and what to change on GitHub, like "Turn on pull requests in the repo's settings." |
| `already_registered` | The project's status, a link to its page, and "Ask your agent to change its settings with update_project." |
| `label_not_created` | GitHub's message, and "Create the goodfirsttoken label on GitHub, or pick another tag." |
| Saved | "Sent for review." The label, when created. A link to your projects on `/me` |

### `/me`

Two new sections, after the review queue:

```
 ● your projects
   sample-owner/tiny-lib     waiting for review     registered Nov 5
   sample-owner/other        rejected               "No tagged issues yet."  Nov 1

 ● your requests
   acme/widgets              waiting                asked Nov 3        [withdraw]
   acme/gizmo                listed ↗               asked Oct 28
   acme/legacy               not listed             asked Oct 20       [withdraw]
```

- Your projects lists the projects the person registered, with their
  status and reason, as `project_status` gives them. With none, the
  section doesn't show.
- Your requests lists the person's requests, newest first, with the status
  words on hover and on small screens under the row. With none: "No
  requests yet." and a link to `/request`.

## Build items

| # | Item | Blocked by |
|---|---|---|
| 1 | Come back to the form after signing in | This spec |
| 2 | Record repo requests, and add `request_repo` | This spec |
| 3 | Request a repo from the homepage and `/request` | 1, 2 |
| 4 | Show a person's requests on `/me` | 2 |
| 5 | Offer to request a repo in the give skill | 2 |
| 6 | Register a repo from `/maintainers` | 1 |
| 7 | Show a person's projects on `/me` | 6 |

## Open questions

1. Should `removed` tell the person that the maintainers asked not to be
   listed? It saves a donor from asking again, or asking the maintainer.
   It also says something the do-not-list doesn't say anywhere public
   today. This spec says it. An admin can change the words.
2. Should a maintainer change settings on the site too? This spec leaves
   it to the agent, so the form stays one page. A settings page is the
   next step if maintainers ask for it.
