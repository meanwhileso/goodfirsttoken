## Find a named project

When the donor names a project to spend tokens on, keep that project as the
session's choice. Use these steps before offering new issues. Use the site
at your MCP server's origin for the page and JSON reads below.

1. Accept a project name, owner/repo, a GitHub repo URL, or a Good First
   Token project URL. For owner/repo or a repo URL, read
   /<owner>/<repo>.json to check the listing. For a name, read
   /projects.json and follow its next links through the last page. Compare
   repo names without case, spaces, or punctuation, so "Good First Token"
   can match a repo named goodfirsttoken. Use public search or the repo's
   own docs to resolve other names, then check the listing on Good First
   Token. Take the canonical owner/repo from the listing. Never guess the
   owner from the project's name.
2. When several repos could be the project, show their links and ask which
   the donor meant. When no listing matches, say you couldn't find the
   project on Good First Token. A GitHub repo alone doesn't mean it takes
   claims here. When a read fails, say the lookup failed. An unread page
   or a failed search doesn't prove the project is absent.
3. Read the matched project's markdown page using the listing's markdown
   link. A paused project takes no new claims. Otherwise, offer its issues
   tagged for outside help that have room and no open PR. Use the issue
   links to form owner/repo#number, since a project's issues can live in
   another repo and a page can show a ref as #number.
   Read an issue's Good First Token markdown page before offering it.
   Check the Project link against the requested project's canonical
   owner/repo. Skip issues whose page names another project. Two projects
   can share an issue repo, and the server claims a shared issue for the
   oldest eligible project.
   Show the issue links and the details the page supplies, then let the
   donor pick. Claim the pick with `claim_issue`, which checks whether the
   issue still takes the donor's claim. Follow its CLA and other refusals.
   Before cloning or working, compare the returned project's repo with
   the requested project's canonical owner/repo, without case. If it
   returned another project after the page was read, release a
   new claim with `release_claim` and explain that the issue was claimed
   for that other project. Leave a resumed claim as it was. Offer another
   issue in the requested project. Work on the other project only when
   the donor chooses it.
   A released new claim still counts against the issue budget. If that
   spent the budget, explain it and let the donor choose whether to start
   another session before trying another issue.
4. Give the named project priority over saved interests and general
   suggestions. Suggestions from `suggest_issues` are ranked and drawn at
   random. They can include other projects. A batch without the named
   project doesn't prove it has no work. Check its project page before
   offering another project.
5. Keep a choice for this session in the harness. When saving project
   interests with `set_interests`, use the resolved owner/repo and keep
   the donor's other interests. Change saved interests only when the
   donor wants to save or change them. Reuse the project they already
   named when asking about first-run interests.
6. When the project is absent, paused, or has no available work you can
   find, explain which. If the page shows only some issues, say the search
   is incomplete. Offer to look in another project, and wait for the
   donor's choice before claiming elsewhere. Apply this rule to refusals
   and queued picks too. Keep the requested project when finding the next
   issue until the donor changes it.
