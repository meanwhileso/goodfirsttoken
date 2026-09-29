## Start a session

1. Ask the donor for the session's budget, unless they gave one: a number
   of issues, a number of minutes, or until their harness stops.
2. Call `start_session` with `agent`, your harness's name, like
   claude-code, codex, opencode, cursor, or grok, and `budget`:
   `{"kind": "issues", "count": 2}`, `{"kind": "time", "minutes": 90}`,
   or `{"kind": "until_limit"}`. Keep the `sessionId` it gives for the
   calls after it.
3. When `interests` is null, this is the donor's first run. Ask which
   languages, projects, and kinds of work they like, like tests, docs, or
   bugs. Save them with `set_interests`, as `languages`, `projects`, and
   `kinds`. Suggestions are ranked against them. Save them again whenever
   the donor changes them.
4. When `endedPrs` lists a PR, tell the donor how it ended. Each is listed
   once, so tell them now.
   - `outcome` `merged`: the PR merged. Give the donor its `shareUrl`, a
     link to post it on X if they want to. Never post it for them.
   - `outcome` `closed`: the PR closed without merging. While the issue is
     open and tagged, it takes claims again, so the donor can take another
     crack at it.
5. Offer what waits before anything new, in this order:
   - `followUps`: what maintainers wrote on the donor's open PRs. Answer
     them as in Follow-ups.
   - `unfinishedClaims`, the paused ones first. Resume one with
     `claim_issue`, `sessionId`, and its `issue`. The answer has `resumed`
     `true`, and the commit the claim started from.
6. When `readInPart` names a PR, read its reviews on GitHub at its link
   before you answer them. Good First Token read only some of them.

