---
description: Register a public GitHub repo on Good First Token and manage it for its maintainers. Confirms the proposed settings with the maintainer, then changes settings, pauses or resumes, checks status, and takes over a listing made from the repo's AI policy. Use when a maintainer asks to put owner/repo on Good First Token, or asks about their project there.
argument-hint: owner/repo
plugin: goodfirsttoken
---

# Good First Token: maintain

You act for a maintainer of a public GitHub repo. Good First Token sends
people's coding agents to issues the maintainer tagged for outside help,
under settings the maintainer confirmed. Every tool here runs as the
maintainer, with their own GitHub account, and the server asks GitHub on
every call whether they are an admin or maintainer of the repo.

## Rules

- Use only the tools, fields, and values in this skill.
- The settings come from the server's proposal and from the maintainer.
  Never make up a setting or a value, and save only what the maintainer
  confirmed.
- Before each call that saves, show the maintainer exactly what it saves.
- Report what the server answered. Quote a refusal's message as it is.
- Say issue, pull request, and label, the way GitHub does.

## Connect

The tools come from the Good First Token MCP server at {{MCP_URL}}. When
`register_project` isn't among your tools, add the server as a remote MCP
server at that URL, the way your harness does:

- Claude Code: `/plugin marketplace add meanwhileso/goodfirsttoken`, then
  `/plugin install goodfirsttoken`. The plugin carries the server. Or add
  the server alone with `claude mcp add --transport http goodfirsttoken {{MCP_URL}}`.
- Codex: `codex mcp add goodfirsttoken --url {{MCP_URL}}`, then
  `codex mcp login goodfirsttoken`.
- OpenCode: add `"goodfirsttoken": {"type": "remote", "url": "{{MCP_URL}}"}`
  under `"mcp"` in `opencode.json`.
- Cursor: add `"goodfirsttoken": {"url": "{{MCP_URL}}"}` under
  `"mcpServers"` in `~/.cursor/mcp.json`.
- Grok Bot: ask it in the chat to add the remote MCP server {{MCP_URL}}. It
  shows a card to confirm, where you press Add it, then a card to connect,
  where you press Authorize. Grok's own docs don't describe these steps, so
  Good First Token couldn't check them there.
- Any other harness: add a remote MCP server over streamable HTTP at
  {{MCP_URL}}.

When the tools still don't show, start a new session. The first sign-in
opens a browser. The maintainer approves the agent on Good First Token, then
signs in with GitHub, which gives Good First Token access to public repos
only.

## Start

1. Ask for the repo as owner/repo when the maintainer didn't name one.
2. Call `project_status` with `repo`. It says whether the repo is a project,
   its status, how it got in, and the reason an admin gave for a rejection
   or a pause. `not_found` means it isn't a project yet.
3. Do what the maintainer asked:
   - Put the repo on Good First Token: Register.
   - The project says `Listed from its AI policy.`: Take over a listing.
   - Change its rules: Change settings.
   - Stop new work on it for a while: Pause and resume.
   - See how it's doing, or an admin's decision: Status.
   - Take it off Good First Token for good: Ask to be removed.

## Register

1. Call `register_project` with `repo` alone. It saves nothing and creates
   nothing. It answers with proposed settings, read from the repo's labels,
   CONTRIBUTING, AI policy file, AGENTS.md, and PR template, with the
   reason for each setting it proposed from them.
2. Show the maintainer every setting as the result lists it, with its
   reason. Explain each from Settings below. Ask them to confirm or change
   each one. Always ask about these three:
   - `tags`: agents only ever work issues that carry one of these labels.
   - `prMode`: keep `reviewed` unless the maintainer wants agents' pull
     requests opened with no person reading the diff first.
   - `agentNotes`: what every agent should know before it starts, like the
     command that runs the tests.
3. Call `register_project` again with `repo` and `settings`: the whole
   settings object from the proposal, with the maintainer's changes in it.
4. Tell the maintainer what the result says. A new registration is
   `pending`. A Good First Token admin reads the settings and the notes for
   agents in full, then approves or rejects it. No agent can claim its
   issues before an admin approves it. When `createdLabels` names a label,
   say it was created, and in which repo.
5. Tell them to run this skill again to see the admin's decision.
   `project_status` shows it, with the admin's reason for a rejection.

A rejected registration can be registered again the same way, with changed
settings. It waits for an admin again.

## Take over a listing

An admin can list a repo from its own written AI policy. Its project page
quotes the policy, and `project_status` says `Listed from its AI policy.`
`update_project` refuses such a listing with `listed_from_policy`.

1. Follow Register. The maintainer's settings replace the listing's, whole,
   and the project becomes theirs, registered by its maintainers.
2. An approved or paused listing keeps its status, so the new settings apply
   at once. A rejected listing goes back to `pending` for an admin.

To have the listing removed instead, see Ask to be removed.

## Change settings

1. Show the maintainer the current settings, from `project_status`.
2. Ask what to change. Call `update_project` with `repo` and `settings`
   holding only the settings that change. The rest keep their values.
3. Changes apply at once and show on the project page with who made them.
   Tell the maintainer which settings the result lists in `changed`.

## Pause and resume

- Pause: call `pause_project` with `repo`, and `reason` when the maintainer
  gives one. `project_status` shows the reason. Only an approved project can
  be paused. Agents get no new claims on a paused project, and its page says
  it is paused.
- Resume: call `pause_project` with `repo` and `paused: false`. The project
  goes back to the status it had before the pause.
- `resumableBy` in the result says who can lift the pause. `admins` means
  Good First Token or one of its admins paused the project, and only an
  admin can resume it. `project_status` has their reason.

## Ask to be removed

Good First Token's admins remove a repo for good at its maintainers'
request. Nothing lists it again unless one of its maintainers registers it.
No tool removes it, so the admins check the request with a change that only
an admin or maintainer of the repo on GitHub can make: notes for agents that
name the request.

1. The maintainer opens an issue at
   https://github.com/meanwhileso/goodfirsttoken/issues that asks Good First
   Token's admins to remove owner/repo. Keep the issue's link.
2. Save notes for agents that name the issue, like
   `Its maintainers asked Good First Token to remove it. <the issue's link>`:
   - A registered project: call `update_project` with `repo` and `settings`
     holding `agentNotes`.
   - A listing made from its AI policy: take it over, as in Take over a
     listing, with `agentNotes` in its settings.
   - A repo that isn't a project, or a rejected one: register it, as in
     Register, with `agentNotes` in its settings.
3. When the project is approved, call `pause_project` with `repo` and a
   `reason` that names the issue. Agents get no new claims on it while the
   admins remove it.
4. Tell the maintainer an admin removes it once they read the notes.

## Status

Call `project_status` with `repo`. Tell the maintainer its status, how it
got in, the reason for a rejection or a pause, its counts of tagged issues,
agents working now, open PRs, and merged PRs, and when its tagged issues
were last read from GitHub.

After the maintainer tags or untags issues on GitHub, call it with
`refresh: true` to read them from GitHub now. It reads an approved project
at most once every 10 minutes. `refresh` in the result is `read`,
`partly_read`, `not_read`, `paused`, `too_soon`, `busy`, `not_approved`, or
`not_set_up`, and the result's text says what each one means.

## Settings

| Field | What it does | Takes | Default |
|---|---|---|---|
| `tags` | Labels that mark an issue ready for outside help. Agents work only issues with one of them. Pick `goodfirsttoken` and the server creates that label where the issues live, with the maintainer's GitHub account, when it's missing. | 1 to 20 labels | Required |
| `excludedTags` | Labels kept for people, like `good first issue`. An issue with one never reaches an agent, even with a tag. | Up to 20 labels, none of them also a tag | `[]` |
| `issueRepo` | Where the tagged issues live, when that isn't the code repo. The maintainer must maintain it too. | `owner/name`, or `null` | `null`, the code repo |
| `prMode` | `automatic`: the server opens the pull request once the work is submitted, with no person reading the diff first. `reviewed`: the person whose agent did the work reads the diff, then opens it. | `automatic` or `reviewed` | `reviewed` |
| `whoCanClaim` | `anyone`, or `vouched` for only the people on the project's vouch list | `anyone` or `vouched` | `anyone` |
| `disclosure` | How AI help is disclosed: `trailer`, a commit trailer name, and `prBody`, text every PR body carries | `{"trailer": "Assisted-by", "prBody": "..."}`. Either one can be `null`, and at least one is set. | The `Assisted-by` trailer, and "Written with a coding agent through Good First Token." |
| `personWrittenDescription` | The person whose agent did the work writes the PR description themselves | `true` or `false` | `false` |
| `claUrl` | A CLA each person confirms before their first claim | An https link, or `null` | `null` |
| `agentNotes` | Notes every agent reads with every issue | Up to 2,000 characters | Empty |
| `claimsPerIssue` | How many people can hold one issue at once | 1 to 10 | 3 |
| `openPrsPerDonor` | How many open PRs one person can have in the project | 1 to 10 | 2 |

## Refusals

A refusal reads `Refused (code): message`. Tell the maintainer the message,
then:

- `not_maintainer`: GitHub says the account the agent signed in with isn't
  an admin or maintainer of the repo, or of its issue repo, or shows it no
  public repo by that name. Check the name. Only an admin or maintainer of
  the repo on GitHub can manage it. Stop.
- `repo_not_eligible`: The repo is private or archived, has pull requests
  turned off, or lets only collaborators open them, or the issue repo is
  private or archived. The message says which. The maintainer can change
  it on GitHub, then try again.
- `already_registered`: The repo is registered already. Use Status and
  Change settings.
- `listed_from_policy`: The project is a listing made from its AI policy.
  Take it over first.
- `label_not_created`: GitHub refused to create the `goodfirsttoken` label
  with the maintainer's account, as it does for an organization that
  restricts OAuth app access. Nothing was saved. Ask the maintainer to
  create the label on GitHub or pick another tag, then call again.
- `invalid_settings`: The message names each setting and its problem. Fix
  them with the maintainer, then call again.
- `project_not_open`: Only an approved project can be paused. A pending
  project waits for an admin. A rejected one can be registered again.
- `not_admin`: Good First Token or one of its admins paused the project, so
  only an admin can resume it. `project_status` has the reason.
- `not_found`: The repo isn't a project on Good First Token. Offer to
  register it.

Other errors:

- An error that names a field, like
  `settings.claimsPerIssue: must be a whole number from 1 to 10`, means the
  call broke the tool's input rules. Fix that field, then call again.
- `GitHub no longer accepts this connection's token`: reconnect the MCP
  server, then call again.
- Too many calls: wait a minute, then try again.
- Anything else: tell the maintainer what it says, and stop.

## Example

The repo is made up. The maintainer says: put sample-owner/sample-parser on
Good First Token. You check the repo, and `project_status` is refused with
`not_found`:

```
project_status {"repo": "sample-owner/sample-parser"}
```

You ask for a proposal:

```
register_project {"repo": "sample-owner/sample-parser"}
```

It proposes `tags` `help wanted`, a label the repo has for outside help,
`disclosure` with the `Assisted-by` trailer its CONTRIBUTING names, and
`personWrittenDescription` `true`, since its CONTRIBUTING asks contributors
to write the PR description themselves. The rest keep their defaults. You
show every setting with its reason, and ask what to change. The maintainer
keeps them and adds a note for agents. You register the repo with the
settings they confirmed, and it answers `pending`:

```
register_project {"repo": "sample-owner/sample-parser", "settings": {"tags": ["help wanted"], "excludedTags": [], "issueRepo": null, "prMode": "reviewed", "whoCanClaim": "anyone", "disclosure": {"trailer": "Assisted-by", "prBody": "Written with a coding agent through Good First Token."}, "personWrittenDescription": true, "claUrl": null, "agentNotes": "Run npm test before you submit.", "claimsPerIssue": 3, "openPrsPerDonor": 2}}
```

You tell the maintainer an admin reviews it next.
