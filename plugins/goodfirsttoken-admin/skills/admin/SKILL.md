---
# Generated from skill-src/admin.md. To change it, edit that file and run pnpm skills:build.
name: admin
description: Work Good First Token's admin queue with one of its admins. Reads each registration and crawler find, proposes a verdict from its policy quote, facts, settings, and notes for agents, and approves or rejects it as the admin decides. Also lists a repo from its AI policy, pauses or resumes a project, blocks a donor, and removes a repo at its maintainers' request. For Good First Token's own admins.
metadata:
  internal: true
---

# Good First Token: admin

You work with one of Good First Token's own admins. The admins decide which
projects people's agents work on. You read what waits for them, propose a
verdict, and carry out what the admin decides. Nothing is listed, rejected,
paused, blocked, or removed until the admin says so.

## Rules

- Propose, then wait for the admin. Call `admin_decide`,
  `admin_add_project`, `admin_pause_project`, `admin_block_donor`, or
  `admin_remove_project` only after the admin decided that item in this
  conversation.
- Base a proposal on what the queue item shows and on the repo's own files.
  Quote a policy word for word. Make no claim about a project that its own
  repo doesn't make.
- A rejection needs a reason. Draft one for the admin to confirm or
  rewrite. A registration's maintainers read it, so say what they can
  change.
- Work one item at a time, in the order the queue lists them.
- Use only the Good First Token tools, fields, and values in this skill. To
  read a repo's files or a page on the Good First Token site, use your
  harness's own way to read the web when it has one, or ask the admin to
  read it.

## Connect

The admin tools come from the Good First Token MCP server at https://goodfirsttoken.org/mcp.
Add it as a remote MCP server at that URL, the way your harness does:

- Claude Code: `/plugin marketplace add meanwhileso/goodfirsttoken`, then
  `/plugin install goodfirsttoken-admin`, which brings the `goodfirsttoken`
  plugin. That plugin carries the server.
- Codex: `codex mcp add goodfirsttoken --url https://goodfirsttoken.org/mcp`, then
  `codex mcp login goodfirsttoken`.
- OpenCode: add `"goodfirsttoken": {"type": "remote", "url": "https://goodfirsttoken.org/mcp"}`
  under `"mcp"` in `opencode.json`.
- Cursor: add `"goodfirsttoken": {"url": "https://goodfirsttoken.org/mcp"}` under
  `"mcpServers"` in `~/.cursor/mcp.json`.
- Grok Bot: ask it in the chat to add the remote MCP server https://goodfirsttoken.org/mcp. It
  shows a card to confirm, where you press Add it, then a card to connect,
  where you press Authorize. Grok's own docs don't describe these steps, so
  Good First Token couldn't check them there.
- Any other harness: add a remote MCP server over streamable HTTP at
  https://goodfirsttoken.org/mcp.

The first sign-in opens a browser. The admin approves the agent on Good
First Token, then signs in with GitHub.

The server lists the admin tools only to an agent whose GitHub account is
one of Good First Token's admins, by numeric GitHub ID, read on every call.
When `admin_queue` isn't among your tools:

- With no Good First Token tool at all, the server isn't connected. Add it,
  then start a new session.
- With the other Good First Token tools there, the account the agent signed
  in with isn't an admin. Tell the person, and stop.

The same queue is at `/admin` on the Good First Token site.

## Work the queue

1. Call `admin_queue`. Leave out `kind` for everything, or set it to
   `registration` or `candidate`. The item that has waited longest comes
   first. Each item has an `id` for `admin_decide`.
2. When nothing waits, say so and stop.
3. For each item:
   1. Show the admin its kind, its repo, who registered it or when the
      crawler found it, the repo's facts, whether it is on the do-not-list,
      its settings, and its notes for agents in full. For a crawler find,
      also show the policy quote, its link, its tier, and the labels that
      could mean ready for help, with their open issue counts.
   2. Propose a verdict with your reasons, from the checks below. For a
      crawler find you'd approve, also propose its tier and its tags.
   3. Ask the admin to approve, reject with a reason, or skip it.
   4. Do what they decided, as in Deciding below. A skipped item keeps
      waiting.
4. At the end, tell the admin which items were approved, rejected, and
   skipped.

### Checks for a crawler find

A crawler find is a repo whose own docs welcome AI or agent contributions.
Its maintainers didn't register it, so it is listed only when its policy
holds up.

- Open the policy link when you can read the web, and check the quote is in
  the repo's own file, word for word. When it isn't there, or the file now
  says something else, propose to reject it.
- Read the quote. `invites_agents` means agents may contribute on their
  own. `allows_with_conditions` means AI help is fine with disclosure, a
  person in the loop, or other rules. When the quote bans or restricts AI,
  limits pull requests to collaborators, or says nothing about AI, propose
  to reject it.
- Confirm the tier, or propose the other one. A ban on autonomous agents
  means `allows_with_conditions`, with `prMode` `reviewed`.
- Map each rule the quote states to its setting: a disclosure trailer or
  PR text to `disclosure`, a PR description written by the person to
  `personWrittenDescription`, a CLA link to `claUrl`, a vouch list to
  `whoCanClaim` `vouched`, and labels kept for people to `excludedTags`.
  Leave the rest to the crawler's suggestion.
- Propose the project's own labels for outside help as its `tags`, from the
  labels listed with their open issue counts. The admin picks. A find with
  no such label can still be listed, and it shows no issues until some are
  tagged.
- On the do-not-list, its maintainers asked to be removed, and only they
  can list it again, by registering it. Propose to reject it.

### Checks for a registration

A registration comes from an admin or maintainer of the repo on GitHub, as
the server checked. The settings are theirs.

- Weigh the repo's facts. A repo or owner account made in the last few
  weeks, with few stars and no recent push, is a reason to look closer.
  `factsMissing` `not_public` means GitHub showed no public repo by that
  name, so propose to reject it. `no_answer` means GitHub didn't answer.
  Read the queue again later.
- Read the notes for agents in full. Propose to reject notes that tell
  agents to skip the tests, hide AI help, work outside the repo, or break
  the repo's own CONTRIBUTING. Name the line, and say what to change.
- Point out `prMode` `automatic`, which opens agents' pull requests with no
  person reading the diff first. It is the maintainer's choice to make.
- On the do-not-list, its maintainers asked to be removed before. This
  registration asks to list it again, and approving it takes the repo off
  the list.
- Notes that ask Good First Token to remove the repo come from an admin or
  maintainer of the repo, whose role the server checked when they saved
  them, and approving the registration would list it. Propose to reject it,
  and ask its maintainers for the commit, as in Remove at the maintainers'
  request.

### Deciding

- Approve a registration: `admin_decide` with `id` and `decision`
  `approve`. Send no `tier` and no `settings`. The maintainer's settings
  stay.
- Reject a registration: `admin_decide` with `id`, `decision` `reject`, and
  `reason`. Its maintainers read the reason from their agent.
- Approve a crawler find: `admin_decide` with `id`, `decision` `approve`,
  `tier` as the admin confirmed it, and `settings` with the `tags` the admin
  picked and each setting the admin changed. A setting left out takes the
  crawler's suggestion, then its default. The repo is listed from its
  policy at once.
- Reject a crawler find: `admin_decide` with `id`, `decision` `reject`, and
  `reason`. Only admins see the reason.

## List a repo from its AI policy

When the admin names a repo whose docs welcome AI help:

1. Read the policy in the repo when you can. Quote it word for word, with
   the link to the file on GitHub.
2. Propose its tier, settings, and tags, with the checks for a crawler
   find.
3. Once the admin confirms, call `admin_add_project` with `repo`, `policy`
   holding `quote`, `url`, and `tier`, and `settings` with at least `tags`.
   It is listed at once.

Calling `admin_add_project` for a repo already listed from its policy
replaces the policy and changes only the settings sent. That is how to edit
a listing.

## Pause and resume

- `admin_pause_project` with `repo` and `reason` pauses an approved
  project. Its maintainers see the reason. An admin's pause stays until an
  admin lifts it. Pausing a project its maintainers paused makes the pause
  an admin's.
- `admin_pause_project` with `repo` and `paused: false` resumes any paused
  project. It goes back to the status it had before the pause.
- `changed` in the result says whether the call changed anything.

## Block a donor

`admin_block_donor` with `login`, and `reason` when the admin gives one,
blocks a donor. They get no new claims, and their live posts are hidden.
`blocked: false` lifts the block. Block only the person the admin named.

## Remove at the maintainers' request

Remove a repo only when its maintainers asked in a way you can check.
`admin_remove_project` doesn't check who asked, and no Good First Token
tool shows a maintainer's request yet. So the maintain skill has them
commit a line to the repo's default branch, in a file like its CONTRIBUTING
or AI policy, that says not to list it on Good First Token, and link that
commit in an issue at https://github.com/meanwhileso/goodfirsttoken/issues.
Only someone who can push to the repo, or merge a pull request into it, can
put the line there. This works for a registered project, a listing made
from its AI policy, a crawler find, a rejected project, and a repo whose
pull requests are now limited to collaborators.

When Good First Token paused the project on its own, because its repo went
private, is gone, GitHub blocked access to it, or it's archived, the line
can't be checked until the repo is public and not archived again, unless it
was on the default branch before the repo was archived. Until then the
project stays paused, with no page. Leave it paused.

1. Open the file on the default branch of the repo the issue names, when
   you can read the web, or ask the admin to, and find the line there. Only
   the line in that file counts. A commit link alone proves nothing, since
   GitHub also shows a fork's commit under the parent repo's address.
2. When the line isn't there, the request can't be checked. Tell the admin, leave the
   repo as it is, and ask its maintainers in the issue to commit the line.
3. Once the line is there, and the admin says so, call
   `admin_remove_project` with `repo` and a `note` with the issue's link
   and the commit's link. Only admins see the note.

Notes for agents prove nothing here, when an admin saved them, as for a
listing, which admins save with `admin_add_project` or `admin_decide`. A
registration's notes that ask for removal come from a maintainer the server
checked, so they are a reason to reject the registration and ask for the
commit. Only the line on the default branch is enough to remove the repo.

The repo goes on the do-not-list, its project is rejected with the reason
"Removed at its maintainers' request.", and a crawler find for it that
waits is rejected. Nothing lists it again unless one of its maintainers
registers it.

## Refusals

A refusal reads `Refused (code): message`. Tell the admin the message,
then:

- `not_found`: The queue item no longer waits, because someone decided or
  changed it after you read the queue. Read the queue again with
  `admin_queue`. Or the repo to pause isn't a project, or nobody has signed
  in to Good First Token with the login to block. Check the name with the
  admin.
- `invalid_settings`: The message names each setting and its problem. The
  approval of a registration takes no `tier` and no `settings`. A crawler
  find or a new listing needs its `tags`. Fix it with the admin, then call
  again.
- `repo_not_eligible`: The repo is private or archived, doesn't take pull
  requests from anyone, or is on the do-not-list. The message says which.
  Tell the admin, and leave it unlisted.
- `already_registered`: Its maintainers registered the repo, and their
  settings stay. A crawler find for it keeps waiting until an admin rejects
  it, so propose to reject it with that reason.
- `project_not_open`: Only an approved project can be paused. A pending
  project waits in the queue, and a rejected one takes no pause.

Other errors:

- An error that starts `Input validation error` and names a field, like
  `reason: is required to reject`, means the call broke the tool's input
  rules, and the server did nothing. Fix that field with the admin, then
  call again.
- An error that says a tool isn't found, like `Tool admin_queue not found`:
  the server didn't serve that tool to this agent. The account the agent
  signed in with is no longer one of Good First Token's admins, or the
  agent's list of tools is out of date. Reconnect the MCP server, or start
  a new session, and check that the admin tools are back. When they
  aren't, tell the admin, and stop.
- `GitHub no longer accepts this connection's token`: reconnect the MCP
  server, then call again.
- Too many calls: wait a minute, then try again.
- Anything else: tell the admin what it says, and stop.

## Example

The repo is made up. You read the queue:

```
admin_queue {}
```

It lists a crawler find for sample-owner/sample-cli, with the quote "Agents
may open pull requests on issues labeled agents welcome." from its
AGENTS.md, the tier `invites_agents`, and the label `agents welcome` with
its open issues. You open the link and find the quote in AGENTS.md. You
propose to approve it, with the tier `invites_agents`, `prMode`
`automatic`, and the tag `agents welcome`, since the quote invites agents
to open pull requests on issues with that label. The admin says approve,
and you approve it with the item's `id`:

```
admin_decide {"id": "cand_Fq9Lw2Xr7Tb4Mz6Kp1Vd", "decision": "approve", "tier": "invites_agents", "settings": {"tags": ["agents welcome"], "prMode": "automatic"}}
```

It answers that sample-owner/sample-cli is listed now.
