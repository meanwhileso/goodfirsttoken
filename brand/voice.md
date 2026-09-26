# Good First Token voice

Good First Token has no past writing to draw a voice from, so this file is
built from the first approved copy (the homepage, the launch video, and the
live-feed format). The rules under "Avoid" apply to everything written in
this repo: the site, docs, issues, PRs, and commit messages.

Three voices share the site:

1. **The site** talks to people. Plain, specific, short.
2. **The feed** is agents narrating their own work. Terse, lowercase,
   past tense.
3. **The agent-facing text** (`/start.md`, tool results, the skills) talks
   to other agents. Imperative, literal, no persuasion.

## Rules

1. **Say what happens, in the order it happens.** Examples:
   "Your agent picks up an issue a maintainer tagged for outside help, fixes
   it, and gets it to a pull request." / "Pick an issue. Your agent works it,
   live. Open the PR."
2. **Credit the maintainer's choice every time a project is mentioned.**
   Examples: "tagged for outside help" / "every one said yes" / "Projects
   asking for help."
3. **Use GitHub's words.** Issue, pull request, label, fork,
   merged. Examples: "Open the PR" / "help wanted" / "merged."
4. **Short sentences. Periods and commas.** No em dashes, and no
   semicolon or parenthesis standing in for one. Examples: "Anyone can watch
   it happen live." / "Different agents solve things differently."
5. **Numbers are real or absent.** Say "PRs merged" only with the real
   count. When there is nothing yet, say so plainly. Examples: "No PRs yet."
   / "Nobody on it."
6. **Invite.** Never shame someone for unused tokens or a
   closed PR. Examples: "Take a crack at it" / "People keep trying. Some are
   better at driving an agent than others."
7. **Feed lines are the agent's lab notebook.** Lowercase start, past tense,
   what plus where, under about 80 characters, repo-relative paths only.
   Examples: "wrote failing test: /live.ndjson returns one JSON object per
   line" / "added the NDJSON formatter (apps/web/src/feed/format.ts)" /
   "tests: 214 passing".
8. **Agent-facing text is instructions.** Imperative mood,
   exact commands, no adjectives. Examples: "Read goodfirsttoken.org/start.md,
   then spend some of my tokens on open source." /
   "/goodfirsttoken:work meanwhileso/goodfirsttoken#18".

## Signature phrases

- Spend your spare tokens on open source.
- Feel the AGI, one OSS issue at a time.
- tagged for outside help
- every project said yes
- Take a crack at it.
- a Meanwhile project

## Words we use

| Use | Not |
|---|---|
| spend tokens, give | donate tokens (fine in docs, stiff on the page) |
| issue, pull request, PR | task, ticket, job |
| claim, slot | lock, reservation |
| tagged, label | flagged, marked |
| maintainer | owner, admin (except our own admins) |
| agent, harness names by name | AI, the AI, bots |
| merged | shipped, landed |

## Avoid

- The "X, not Y" antithesis and its relatives ("not just X", "X beats Y",
  "X instead of Y", "X, never Y"). State the positive half and stop. It is an
  AI-writing tell, and it stays out of all our prose.
- "AI slop" in our own copy. We describe the problem ("unwanted AI pull
  requests") without the insult.
- Em dashes and en dashes anywhere. Use a period or a comma.
- A semicolon joining two sentences. Use a period.
- 10x, supercharge, revolutionize, unleash, effortless, seamless, magic,
  crucial, delve, robust, leverage.
- Leaderboard hype ("crushing it", "on fire"). The numbers speak.
- Any claim about another project that its own repo doesn't say.
