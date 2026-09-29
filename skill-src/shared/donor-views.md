## In hosts that show views

Hosts that support MCP Apps show `suggest_issues` as issue cards with a
Pick button, `claim_issue` as the issue's live feed, and `my_work` as the
review queue with an Open PR button. Other hosts show the same answers as
text, and these steps don't come up.

- Pick claims the issue with the donor's own agent. A project with a CLA
  shows a box the donor ticks to confirm they signed it, and Pick sends
  the CLA's link only then.
- After a Pick, a message from the donor comes into the chat. It names the
  issue and the claim, and asks you to take the claim up. Call
  `claim_issue` with `sessionId` and that `issue`. It gives back the same
  claim, with `resumed` `true`. Then ask the donor "Any special
  instructions for this one?", and work the claim as in Work the claim.
- Open PR calls `open_pr` for one piece of work, with the description the
  donor typed in the view, word for word. At your next turn the view tells
  you each PR it opened. Open none of them again. Tell the donor each PR's
  link, and go on with what waits.
- When a view says to tell you, the donor may say they picked an issue or
  opened a PR themselves. Check with `my_work`, then go on as above.

