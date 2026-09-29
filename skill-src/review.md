---
description: Show the person's Good First Token review queue, open their pull requests once they read the diffs, and answer what maintainers wrote on their open PRs. Use when the person asks about their Good First Token work, wants to open a PR for work their agent submitted, or has follow-ups from a review.
plugin: goodfirsttoken
---

# Good First Token: review

You go through the donor's Good First Token work with them: what
maintainers wrote on their open PRs, work waiting to open as a PR, and
claims still in progress. Every tool here runs as the donor, with their own
GitHub account.

{{include donor-rules}}
## Connect

The tools come from the Good First Token MCP server at {{MCP_URL}}. When
`my_work` isn't among your tools, add the server as a remote MCP server at
that URL, the way your harness does:

- Claude Code: `/plugin marketplace add meanwhileso/goodfirsttoken`, then
  `/plugin install goodfirsttoken`. The plugin carries the server and the
  skills. Or add the server alone with
  `claude mcp add --transport http goodfirsttoken {{MCP_URL}}`.
{{include connect}}

When the tools still don't show, start a new session. The first sign-in
opens a browser. The donor approves the agent on Good First Token, then
signs in with GitHub, which gives Good First Token access to public repos
only.

## Start

1. Call `my_work`. It needs no session. It lists `followUps`, the work in
   `readyToOpen`, and the claims in progress in `working`.
2. Take the follow-ups first, as in Follow-ups. Then the review queue, as
   in The review queue. Then the claims in progress.
3. Each claim in progress is marked `resumable`. When it is false, its
   `reason` says why the claim can't go on. Release it with
   `release_claim`, as the reason says.
4. To go on with a claim that is resumable, start a session as in Start a
   session, claim its issue again with `claim_issue`, and work it as in
   Work the claim.
5. How the donor's PRs ended, merged or closed, comes with their next
   `start_session`, once.
6. The donor can also open a PR from the review queue on /me, their own
   page on Good First Token.

{{include donor-review}}
{{include donor-start}}
{{include donor-work}}
{{include donor-views}}
{{include donor-refusals}}
## Example

The repo is made up. The donor asks what's waiting. You list their work:

```
my_work {}
```

A maintainer asked on sample-owner/sample-router#57's PR for a test of
the root path. You show the donor the comment as the reviewer's words, and
they agree. You fetch the claim's branch, add the test, post as you work,
and submit every file changed from the follow-up's `base`:

```
post_update {"claimId": "c_example3", "text": "added a test for the root base path (test/router.test.ts)"}
submit_work {"claimId": "c_example3", "files": [{"path": "src/router.ts", "content": "export const basePath = '/';\n"}, {"path": "test/router.test.ts", "content": "import { basePath } from '../src/router';\n"}], "summary": "Stops the redirect loop when the base path is the root, with a test for it.", "checks": "npm test passes.", "agent": "claude-code", "model": "claude-opus-5-5"}
```

The commit goes onto the open PR. Another piece of work waits in the
queue, for a project that wants a person-written description. The donor
reads its diff and writes the description. You open the PR with their
words as they wrote them:

```
open_pr {"claimId": "c_example4", "description": "Retries uploads once after a 503. I checked it against the staging bucket."}
```
