# Add a repo from the site, and request one

Status: proposed on November 5, 2026.

This adds two ways for a repo to reach Good First Token from the site, and
one from a donor's agent:

- A maintainer registers their repo with a form on `/maintainers`, under
  the same rules `register_project` uses from their agent.
- A donor asks for a repo they want to work on, from the homepage, from
  `/request`, or by asking their agent, which calls a new tool,
  `request_repo`.

## What it changes in v1

- [Goal 2](v1.md#goals) has maintainers register and manage a project
  "entirely from their own agent". The agent path stays. The site becomes a
  second way to do both: register, change settings, pause and resume, read
  tagged issues now, and ask to be removed.
- [The principles](v1.md#principles) say the crawler finds projects "among
  popular GitHub projects", and [section 5](v1.md#5-the-policy-crawler)
  has "an admin-kept seed list". Requested repos are a second list the
  crawler reads, whatever their stars, kept by donors' requests.

Consent stays as it is. A request lists nothing. A project still needs its
maintainers' yes, in their docs or by registering, and an admin's approval.

## Why

Today the only ways in are a maintainer's agent with the MCP server
connected, and the crawler finding a repo with 1,000 stars or more whose
docs welcome AI help. That leaves out two groups:

- Maintainers who would say yes but haven't set up an agent with the
  server. `/maintainers` gives them install commands and a prompt, and no
  way to finish on the page.
- Donors who want to spend tokens on a repo that isn't listed. The give
  skill tells them it couldn't find the project, and stops there. The
  crawler doesn't read a repo under 1,000 stars.

## Choices

**A request lists nothing.** It records who asked for which repo. The
crawler reads requested repos after the admins' seeds, so a requested
repo's docs get read whatever its stars. From there the rules are the ones
that exist now. When the docs welcome AI help, the repo waits in the admin
queue as a find, and an admin decides. When they don't, it stays out, and
its maintainers can still register it.

**A request says only what the site already shows.** Its status is whether
the repo has a project page. Crawl results, admin decisions, pending
registrations, and the do-not-list stay private, as
[v1's non-goals](v1.md#non-goals-for-v1) and
[the project page](../how-it-works.md#the-project-page) keep them now.

**Requests stay private.** No public page or feed lists requested repos or
their counts. Good First Token writes nothing to GitHub for a request: no
issue, comment, or label. Maintainers are pushing back on unwanted AI pull
requests, and a public list of wanted repos would add to that pressure.
Admins see who asked. A maintainer registering the repo sees how many.

**The site and the agent share each rule.** The form on `/maintainers`
calls `register_project`'s proposal and save. `/request`, the homepage
form, and `request_repo` call one request action. The site words each
refusal for the person reading it, as `/me` does for `open_pr`.

**Reads use the person's own token.** Under
[Calls to GitHub](../how-it-works.md#calls-to-github), a call made for a
person runs with their token. A request reads the repo with the requester's
token. A signed-out visitor's page reads nothing.

**Sign-in comes back to the form.** Sign-in lands on `/me` today. It gains
a return path, limited to the two new forms.

## Requesting a repo

**Who.** Anyone signed in, on the site or through their agent. A blocked
donor is refused with `donor_blocked`, and their earlier requests leave
every count.

**Which repos.** `owner/repo`, a GitHub repo URL, or a Good First Token
project URL, read as `owner/repo`. The request reads the repo from GitHub
with the requester's token, and refuses with `repo_not_eligible`, naming
the reason, a repo that:

- GitHub doesn't show, or shows as private,
- is archived,
- has pull requests turned off, or
- lets only collaborators open pull requests.

A repo GitHub says nothing about on pull requests passes. A request lists
nothing, and `register_project` and the crawler check again before
anything is listed.

The request keeps the repo by its GitHub repo ID, under
[Repo IDs](../how-it-works.md#repo-ids), with the name GitHub gives at the
time. A renamed repo is the same request.

**Status.** Worked out when read, by the rule
[the project page](../how-it-works.md#the-project-page) uses for which
projects have a page. A project matches when its code repo or its issue
repo has the request's repo ID.

| Status | When | Words for the person |
|---|---|---|
| `listed` | A matching project has a page and is approved | "Listed. Find its issues on its project page." |
| `paused` | A matching project has a page and is paused | "Listed and paused. It takes no claims right now." |
| `not_listed` | No matching project has a page | "Not listed on Good First Token yet. Its maintainers can register it at /maintainers." |

**What it records.** One live request per person per repo. Asking again
while it's live records nothing and answers with the status. A request
keeps the person's GitHub ID and when they asked. The person can withdraw
it any time, from `/me` or with `request_repo` and `withdraw: true`, and
ask again later.

- A repo that is `listed` or `paused` when asked records nothing, and
  answers with the status and the project page.
- A repo that is `not_listed` records the request, whatever the reason.
  A repo on the do-not-list records one too, so the answer is the same
  for every unlisted repo.
- Every route that records or withdraws is a POST that checks the
  `Origin`, as `/me`'s forms do. A GET never records.

**Limits**, our choice, so they can change:

| What | Limit |
|---|---|
| New requests from one person, withdrawn ones included | 10 a UTC day |
| Live requests one person has | 50 |
| Requested repos the crawler reads | 5 a run, after the admins' seeds |
| Requesters an admin queue item lists | 5 logins, and a count of the rest |

A request over a limit is refused with `rate_limited`, a new refusal, which
names the limit and when the next request can go in.

### The crawler

The crawler reads requested repos the way it reads seeds, from their own
list, after the admins' seeds in each run.

- A repo is on the list while it has at least one live request from a
  donor who isn't blocked.
- Each run reads at most 5. Repos never read come first, oldest request
  first. Then each pass reads the rest again once, longest since read
  first.
- The seed list's rules for what it leaves out apply as they are: a repo
  on the do-not-list, a project already, or a find waiting or approved.
- `admin_seed_repo` on a requested repo adds an admin seed as it does
  today. The requested repo stays on its own list.

### The admin queue

A crawler find or a registration lists who asked for its repo: the first 5
logins and a count of the rest. An admin weighs it with the rest of the
item. A request approves nothing.

### The maintainer

`register_project`'s proposal answers `requests`, how many donors have a
live request for the repo. The form on `/maintainers` shows it. Neither
names anyone.

### `request_repo`

A donor tool, listed for every signed-in agent.

| Input | Type | Notes |
|---|---|---|
| `repo` | string | `owner/repo`, a GitHub repo URL, or a Good First Token project URL |
| `withdraw` | boolean, optional | Withdraws the person's request |

It answers with `repo` as GitHub names it now, `status`, `requested`
(whether this person has a live request), `projectUrl` when there is a
page, and `message`, the words in the status table. Refusals:
`donor_blocked`, `repo_not_eligible`, `rate_limited`, and `invalid_input`.
When GitHub doesn't answer, it says so the way the other donor tools do.

### The give skill

[Find a named project](../../skill-src/shared/donor-project.md) step 2 says
the agent couldn't find the project when no listing matches. Next, when
the donor named a repo, the agent offers to request it, and calls
`request_repo` only after the donor says yes. It tells the donor the
answer's `message`, and offers other projects to work on today. The give
skill's description adds requesting a repo, so "ask Good First Token to add
owner/repo" reaches the skill.

## Registering from the site

`/maintainers` gets a form at the top, beside the prompt. It goes to
`/maintainers/add`.

1. **The repo.** The maintainer types `owner/repo`. Signed out, the page
   reads nothing, and its button starts sign-in that comes back to
   `/maintainers/add?repo=owner/repo`.
2. **The proposal.** `/maintainers/add?repo=owner/repo` calls
   `registerProject` with no settings, as the person, with the token from
   their sign-in on the site, the way `/me` calls `open_pr`. A refusal
   shows in words for the person, with what to do next. Otherwise the page
   shows the proposed settings as a form, each with the proposal's reason
   under it.
3. **Saving.** The form posts every setting. The site runs the tool's
   input schema first, as `/me` does, so a malformed value shows under its
   field. Then it calls `registerProject` with settings. A setting that
   fails its check shows its problem under the field, with the person's
   values kept. A saved registration shows "Sent for review", whether the
   `goodfirsttoken` label was created, and a link to `/me`.

The proposal answers `replaces`: `listing` for a policy listing the save
would take over, `rejected` for a rejected registration it would register
again, or null. The page says which before the save. A repo that is
already a registered project shows its status, and links to its settings
page.

The tags field shows the proposal's suggested tags, checked, and a text
input for others. It doesn't list every label in the repo.

The form works without JavaScript, and `/maintainers/add` is sent with
`Cache-Control: no-store`, as `/me` is.

## Managing from the site

Every maintainer's tool gets a place on the site, at
`/<owner>/<repo>/settings`. The page calls the same functions the tools
call, as the person, with `siteCaller` and the token from their sign-in on
the site, so each rule in [Managing a project](../how-it-works.md#managing-a-project)
and [Asking to be removed](../how-it-works.md#asking-to-be-removed) holds as
it does from the agent.

| On the page | Calls |
|---|---|
| The status panel | `project_status` |
| Save changes | `update_project` |
| Pause and Resume | `pause_project` |
| Read issues now | `project_status` with `refresh` |
| Ask to be removed, and Withdraw | `request_removal` |

- **Who.** The page asks GitHub for the person's role on the repo on every
  load and every post, as the tools do. Signed out, the page reads nothing
  and offers sign-in that comes back to it. Someone who isn't an admin or
  maintainer of the repo sees "GitHub doesn't show you as an admin or
  maintainer of owner/repo." and nothing else about the project, since a
  pending or rejected project is private.
- **Which projects.** Any status: pending, approved, rejected, or paused.
  A repo that isn't a project links to `/maintainers/add?repo=<owner>/<repo>`.
- **The settings form** is the one `/maintainers/add` shows, filled with
  the project's settings. It sends only the settings the person changed
  from what the page loaded, so two maintainers changing different settings
  at once both keep their change, as `update_project` promises. A field
  error shows under its field, with the person's values kept.
- **A listing made from a policy** shows its settings read-only, with
  "An admin listed this repo from its AI policy. Take it over to change its
  settings." and a link to `/maintainers/add?repo=<owner>/<repo>`, since
  `update_project` refuses it with `listed_from_policy`.
- **Pause and resume** follow `pause_project`. A pause takes an optional
  reason. A pause only an admin can lift shows who paused it and no Resume.
- **Read issues now** follows `refresh`'s rules: at most once every 10
  minutes a project, and nothing while the sync reads it. The page shows
  what the read did, as the tool's answer says it.
- **Asking to be removed** takes a reason, shows a waiting request with who
  asked and when, and has Withdraw. While a request waits, the page offers
  to pause the project, as the maintain skill does.
- **Links.** The project page shows "settings" in its head to everyone,
  since the settings page checks the role. `/me`'s "your projects" links
  each row there, and `/maintainers/add` links a registered repo there.
- Every post checks the `Origin`. The page is sent with
  `Cache-Control: no-store`, works without JavaScript, and has no markdown
  version, since agents use the tools.

```
 sample-owner/tiny-lib · settings                         project page ↗

 ● status
   approved · registered by @owner on Oct 12
   14 tagged issues · 3 claims holding a slot · 2 open PRs · 9 merged
   The sync read every tagged issue 12 minutes ago.      [ read issues now ]
   [ pause ]  reason (optional) [                                  ]

 ● which issues
   Tags            [x] help wanted   [x] goodfirsttoken   other [            ]
   Excluded tags   [ good first issue                     ]
   Issue repo      [ same as the code repo                ]

 ● pull requests ... ● who and how many ... ● notes for agents
   (the /maintainers/add form, filled with the current settings)

 [ Save changes ]
 Saved. Your project page shows the change, with who made it.

 ● remove from Good First Token
   Ask Good First Token's admins to remove this repo. They remove it, and it
   stays off until a maintainer registers it again.
   reason [                                                   ]
   [ Ask to be removed ]
```

| State | What shows |
|---|---|
| Signed out | "Sign in with GitHub to manage owner/repo." Nothing is read |
| Not an admin or maintainer | "GitHub doesn't show you as an admin or maintainer of owner/repo." Nothing else |
| Not a project | "owner/repo isn't on Good First Token." and a link to add it |
| Pending | "Waiting for review." Settings can change, and the admin sees the change |
| Rejected | The reason, and a link to register it again |
| Listed from a policy | Settings read-only, with the takeover link |
| Paused by its maintainers | Who paused it, the reason, and Resume |
| Paused by an admin or Good First Token | Who paused it, the reason, and "Only an admin can resume it." |
| Delisted by the sync | The delisting text `project_status` gives |
| Read issues now within 10 minutes | "Issues were read 4 minutes ago. Try again in 6 minutes." |
| A removal request waits | Who asked and when, Withdraw, and the offer to pause |
| `invalid_settings` | Each problem under its field |
| `label_not_created` | GitHub's message, and "Create the goodfirsttoken label on GitHub, or pick another tag." |
| GitHub didn't answer, or the token stopped working | As `/me` says it: try again in a minute, or sign out and in again |

## Signing in and coming back

`POST /auth/sign-in` and `/sign-in` take an optional `next`. It is used
only when, as sent, it is exactly `/request?repo=<owner>/<repo>`,
`/maintainers/add?repo=<owner>/<repo>`, or `/<owner>/<repo>/settings`. Owner is 1 to 39 letters, digits,
and hyphens. Repo is 1 to 100 letters, digits, hyphens, dots, and
underscores, and isn't `.` or `..`. Anything else lands on `/me` as today.

- The page that offers sign-in builds `next` from the repo it already
  checked, with a plain slash, so a homepage form that sent `owner%2Frepo`
  still works. A `next` with an encoded slash is refused.
- `next` rides in Better Auth's `callbackURL`, kept in the state row that
  ties sign-in to the browser. GitHub never sees it.
- A sign-in that fails goes back to `/sign-in` with the same `next`, so
  trying again still comes back.

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
 │ Name a repo you want your agent to work  │ │ Get agent help on your     │
 │ on. Good First Token reads its docs.     │ │ issues. You pick the       │
 │ ┌───────────────────────────┐ ┌───────┐ │ │ issues and set the rules.  │
 │ │ owner/repo                │ │request│ │ │                            │
 │ └───────────────────────────┘ └───────┘ │ │ [ add your repo ↗ ]        │
 │ An admin lists it when its docs welcome  │ │                            │
 │ AI help or its maintainers register it.  │ │                            │
 └──────────────────────────────────────────┘ └────────────────────────────┘

 ● live ──────────── curl -N goodfirsttoken.org/live.txt
```

- Two cards side by side at 880px and up. Under 880px they stack, request
  first.
- Each card's title is a `Marker`. The input is mono, with the placeholder
  `owner/repo` and the accessible label "Repo to request". The button is
  `Button size="sm"`.
- The form is `GET /request` with `repo`, so the homepage still sets no
  cookie and writes nothing.
- "add your repo" is a `ButtonLink` with no variant, the white secondary
  button, linking to `/maintainers`. The `/maintainers` form item changes
  it to `/maintainers#add`.
- In "projects asking for help", the head keeps "add yours ↗" and adds
  "request one ↗", which links to `/request`.

### `/request`

Signed in, with a repo:

```
 Request a repo

 ┌───────────────────────────┐ ┌───────┐
 │ sample-owner/tiny-lib     │ │ check │
 └───────────────────────────┘ └───────┘

 sample-owner/tiny-lib                              ★ 312 · pushed 2 days ago
 Not listed on Good First Token yet. Good First Token reads its docs. An admin
 lists it when its docs welcome AI help, or when its maintainers register it.

 [ Request sample-owner/tiny-lib ]

 or ask your agent:
 ┌──────────────────────────────────────────────────────────────┐
 │ > Ask Good First Token to add sample-owner/tiny-lib.       ⧉ │
 └──────────────────────────────────────────────────────────────┘
```

Signed out, it reads nothing from GitHub and shows the repo as typed:

```
 Request a repo

 sample-owner/tiny-lib
 [ Sign in with GitHub to request it ]
```

| State | What shows |
|---|---|
| No `repo` | The input and check button only |
| `repo` isn't owner/repo or a GitHub link | "Type a repo as owner/repo, or paste its GitHub link." |
| Not eligible | The reason, like "This repo lets only collaborators open pull requests, so agents can't send PRs to it." No request button |
| `listed` or `paused` | The status words and a link to the project page. No request button |
| Requested by this person | The status, and "You asked for it on Nov 3." with Withdraw |
| Rate limited | "You've sent 10 requests today. Try again tomorrow." |
| GitHub didn't answer | "GitHub didn't answer. Try again in a minute." |
| Blocked donor | "Your account can't make requests." |
| Recorded | A notice styled as `/me`'s `.account__notice`, with the status words and a link to "your requests" on `/me` |

### `/maintainers`

The start section gets the form beside the prompt, with `id="add"`. At
880px and up, the prompt is on the left and the form on the right. Under
880px the form comes first, since it needs nothing installed.

```
 Get agent help on your [issues]
 You pick the issues and set the rules.

 ┌─ ● from your agent ───────────────────┐ ┌─ ● on this page ─────────────┐
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
   Tags            [x] help wanted   [x] goodfirsttoken   other [            ]
                   Good First Token adds the goodfirsttoken label to your repo
                   using your GitHub account if it's missing.
   Excluded tags   [ good first issue                     ]
   Issue repo      [ same as the code repo                ]

 ● pull requests
   PR mode         (•) reviewed   ( ) automatic
   Disclosure      trailer [ Assisted-by ]   PR body [ Written with a coding agent... ]
                   Your CONTRIBUTING.md asks for "Assisted-by:".   ← the proposal's reason
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
  page. Defaults show as the same `SplitBadge`s, and ranges come from
  `@goodfirsttoken/core`.
- A proposal's reason shows under its field in muted small text.
- A field error shows under its field in `--danger`, and the field gets
  `aria-invalid` and `aria-describedby`.

| State | What shows |
|---|---|
| Signed out | The repo, and "Sign in with GitHub to continue". Nothing is read |
| `not_maintainer` | "GitHub doesn't show you as an admin or maintainer of owner/repo. Ask someone who is to add it." |
| `repo_not_eligible` | The reason, and what to change on GitHub, like "Turn on pull requests in the repo's settings." |
| `already_registered` | The project's status, a link to its page when it has one, and a link to its settings page |
| `label_not_created` | GitHub's message, and "Create the goodfirsttoken label on GitHub, or pick another tag." |
| `replaces: listing` | "An admin listed this repo from its AI policy. Your settings replace the listing's." above the form |
| `replaces: rejected` | "An admin rejected this repo before. Registering again sends it back for review." above the form |
| GitHub didn't answer, or the token stopped working | As `/me` says it: try again in a minute, or sign out and in again |
| Saved | "Sent for review." The label, when created. A link to `/me` |

### `/me`

Two new sections, after the review queue:

```
 ● your projects
   sample-owner/tiny-lib     waiting for review                     registered Nov 5
   sample-owner/other        rejected   "No tagged issues yet."     Nov 1
                             Register it again ↗
   sample-owner/app ↗        approved                               Oct 12    settings ↗

 ● your requests
   acme/widgets              not listed yet         asked Nov 3     [withdraw]
   acme/gizmo ↗              listed                 asked Oct 28    [withdraw]
```

- Your projects lists the projects whose current "added by" is the person,
  newest first, with the status and its reason, from the database alone.
  These are the person's own registrations, so the reasons were written to
  them. It asks GitHub nothing. Each row links to its settings page. With
  none, the section doesn't show.
- Your requests lists the person's live requests, newest first, with the
  status words under each row. With none: "No requests yet." and a link
  to `/request`.

## Build items

| Issue | Item | Blocked by |
|---|---|---|
| [#152](https://github.com/meanwhileso/goodfirsttoken/issues/152) | Come back to the page after signing in | This spec |
| [#153](https://github.com/meanwhileso/goodfirsttoken/issues/153) | Record repo requests, and add `request_repo` | This spec |
| [#154](https://github.com/meanwhileso/goodfirsttoken/issues/154) | Read requested repos in the crawler | #153 |
| [#155](https://github.com/meanwhileso/goodfirsttoken/issues/155) | Show requesters to admins, and the count to maintainers | #153, #159 |
| [#156](https://github.com/meanwhileso/goodfirsttoken/issues/156) | Request a repo from the homepage and `/request` | #152, #153 |
| [#157](https://github.com/meanwhileso/goodfirsttoken/issues/157) | Show a person's requests on `/me` | #153 |
| [#158](https://github.com/meanwhileso/goodfirsttoken/issues/158) | Offer to request a repo in the give skill | #153 |
| [#159](https://github.com/meanwhileso/goodfirsttoken/issues/159) | Register a repo from `/maintainers` | #152 |
| [#160](https://github.com/meanwhileso/goodfirsttoken/issues/160) | Show a person's projects on `/me` | This spec |
| [#162](https://github.com/meanwhileso/goodfirsttoken/issues/162) | Change a project's settings on the site | #152, #159 |
| [#163](https://github.com/meanwhileso/goodfirsttoken/issues/163) | Pause, resume, and read tagged issues now on the site | #162 |
| [#164](https://github.com/meanwhileso/goodfirsttoken/issues/164) | Ask to be removed on the site | #162 |

Each item updates `docs/how-it-works.md` for the rules it builds, and
`brand/brief-website.md` for the pages it changes.

## Open questions

1. Should a request tell the donor more, like that a repo's maintainers
   asked to be removed? This spec says nothing beyond the project page,
   since the do-not-list, crawl results, and admin decisions are private
   today.
