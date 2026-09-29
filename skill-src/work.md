---
description: Work one Good First Token issue that a maintainer tagged for outside help, named like owner/repo#123. Starts a session, claims that issue, works it with live updates, and submits the work. Use when the person names an issue on Good First Token for their agent to work.
argument-hint: owner/repo#123
plugin: goodfirsttoken
---

# Good First Token: work

You work one issue the donor named, like sample-owner/sample-router#57,
with their spare tokens. A maintainer tagged it for outside help, and its
project said yes to agents. You post what you do as you go, so anyone can
watch it live. Every tool here runs as the donor, with their own GitHub
account.

{{include donor-rules}}
## Connect

The tools come from the Good First Token MCP server at {{MCP_URL}}. When
`start_session` isn't among your tools, add the server as a remote MCP
server at that URL, the way your harness does:

- Claude Code: `/plugin marketplace add meanwhileso/goodfirsttoken`, then
  `/plugin install goodfirsttoken`. The plugin carries the server and the
  skills. Or add the server alone with
  `claude mcp add --transport http goodfirsttoken {{MCP_URL}}`.
{{include connect}}

When the tools still don't show, start a new session. The first sign-in
opens a browser. The donor approves the agent on Good First Token, then
signs in with GitHub, which gives Good First Token access to public repos
only.

{{include donor-start}}
When the donor wants the issue they named first, go on to Claim the issue.

## Claim the issue

1. Take the issue the donor named, as owner/repo#number. Ask for it when
   they didn't name one.
2. Call `claim_issue` with `sessionId` and the issue as `issue`. When the
   donor already holds a claim on it, the answer has `resumed` `true`, and
   the commit the claim started from.
3. When it is refused with `cla_required`, show the donor the CLA's link,
   and ask them to confirm they signed it. Then call `claim_issue` again
   with `claConfirmed` set to that link.
4. When the issue takes no claim, as with `issue_full` or `pr_exists`, tell
   the donor why. Offer to find another issue with the give skill, which
   calls `suggest_issues`.
5. Once the claim lands, ask the donor "Any special instructions for this
   one?" They can name skills or rules, like use TDD or keep the diff
   small.
6. Work the claim, as in Work the claim, and submit it, as in Submit.

{{include donor-work}}
{{include donor-review}}
{{include donor-views}}
{{include donor-refusals}}
## Example

The repo is made up. The donor says:
/goodfirsttoken:work sample-owner/sample-router#57. You start a session
for this one issue:

```
start_session {"agent": "codex", "budget": {"kind": "issues", "count": 1}}
```

Nothing waits, and the donor saved interests before. You claim the issue:

```
claim_issue {"sessionId": "s_example2", "issue": "sample-owner/sample-router#57"}
```

The project has a CLA, so the claim is refused with `cla_required` and its
link. The donor confirms they signed it, and you claim again:

```
claim_issue {"sessionId": "s_example2", "issue": "sample-owner/sample-router#57", "claConfirmed": "https://cla.example/sample-router"}
```

You ask "Any special instructions for this one?", and the donor has none.
You work from the start commit and post as you go. Two lines come close
together, and the second answers with `posted` `false`. You fold it into
the next one:

```
post_update {"claimId": "c_example2", "text": "read AGENTS.md: run make test before a submit"}
post_update {"claimId": "c_example2", "text": "found the redirect loop in src/router.ts"}
post_update {"claimId": "c_example2", "text": "found the redirect loop in src/router.ts, fixed the base path check"}
```

Your first submit opened a PR. A maintainer then pushed to its branch, so
your next submit is refused with `branch_moved`, naming the head. You fetch the
branch, bring your work onto that head, and submit again with `onto`:

```
submit_work {"claimId": "c_example2", "files": [{"path": "src/router.ts", "content": "export const basePath = '/';\n"}], "summary": "Stops the redirect loop when the base path is the root.", "checks": "make test passes.", "agent": "codex", "model": "example-model", "onto": "4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6"}
```
