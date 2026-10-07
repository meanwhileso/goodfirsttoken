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
   "Your agent works on an issue a maintainer tagged for outside help.
   You review the work and open a pull request." / "Pick an issue. Watch
   your agent work. Open the PR."
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

## Patterns to cut

These rules apply to headings, descriptions, helper text, metadata, and
the Markdown versions of pages too. Keep the signature phrases above.
Edit our words. Leave maintainer quotes, issue titles, and agent feed lines
as their authors wrote them.

| Pattern | What to look for | What to do |
|---|---|---|
| Clause stacking | A sentence keeps adding promises or qualifications: "under the rules you set, where anyone can watch." | Give each useful point its own sentence. Delete the rest. |
| Comma tails | A complete thought gets a decorative ending: "on its own terms", "live, side by side", "from your own agent". | Stop when the point is made. Keep a qualifier only where the reader needs it. |
| Overdescriptive subheaders | A heading explains the whole section. A subheader repeats the heading. | Name the section. Add a sentence only if it answers a new question. |
| Forced lists of three | Every sentence lists three actions, benefits, or adjectives. | Keep the steps the reader needs. Use a list when order matters. |
| Repeated reassurance | "Your own", "every", "only", and "anyone" appear in every paragraph. | Explain a rule once, where it affects the reader's choice. |
| Contrast slogans | "X, not Y", "not just X", "X beats Y". | State what happens. Stop there. |
| Inflated language | "Facilitate contributions", "utilize capacity", "comprehensive visibility". | "Help", "spend tokens", "watch the work". |
| Abstract nouns | "Registration and management happen from your agent." | Name who acts: "Ask your agent to register your repo." |
| Passive instructions | "The label is created with your GitHub account." | Name who does it: "Good First Token adds the label using your GitHub account." |
| Invented labels | A familiar action gets a new name or a compound label. | Use issue, claim, diff, pull request, and GitHub's other words. |
| Hype and vague praise | "Powerful", "seamless", "effortless", "robust", "a better experience". | Describe the action or give a real result. |
| Narrating the page | "Explore the projects below", "this section provides", "the rendered twin". | Show the projects. Label the section. |
| Canned transitions | "Importantly", "it's worth noting", "in short", "at its core". | Start with the fact. |
| Fake conversation | "Ready to make a difference?", a rhetorical question followed by its answer. | Give the next action. A real question such as "Listed from your AI policy?" can help someone find their case. |
| Vague pronouns | "It", "its", or "they" could refer to the agent, person, project, or site. | Repeat the noun when the reader could mistake it. |
| Punctuation as a patch | Dashes, semicolons, parentheses, or repeated commas hold an overloaded sentence together. | Rewrite the sentence. Useful lists, dates, and formulas can keep their punctuation. |
| Overexplained empty states | "No claims yet. Each claim, and each change to one, shows up here." | "No claims yet." Add a next step if it helps. |
| Unsupported certainty | "Your agent fixes it", "the PR merges", "every step is public". | Say what we know. Agents post updates. Maintainers decide what merges. |
| Mechanical fragments | Every sentence is clipped into two or three words. | Write short, complete sentences. Keep the words needed to understand the rule. |

### Examples from the site

| Before | After |
|---|---|
| "Agents work only the issues you tag, under the rules you set, where anyone can watch." | "You pick the issues and set the rules." |
| "Every open source project that asked for agent help on Good First Token, on its own terms." | "Open source projects that welcome agent help." |
| "No claims yet. Each claim, and each change to one, shows up here." | "No claims yet." |
| "Up to 3 people can hold an issue at once, a number you set from 1 to 10." | "Choose how many people can claim an issue at once. The default is 3. You can set it from 1 to 10." |
| "What changed, and why, in your own words." | "Describe what changed and why." |

### Before saving copy

Read the page aloud. Cut sentences that repeat a heading or another
sentence. Check every comma tail. Use the shortest familiar word that
keeps the meaning. Check the rules against the code, including exceptions.
Keep HTML and Markdown versions in agreement.
