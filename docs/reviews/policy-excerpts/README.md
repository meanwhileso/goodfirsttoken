# Policy excerpt screenshots

These screenshots show the project page at 390 and 1280 pixels wide in
Chromium, with reduced motion. The page has no horizontal overflow at
either width.

The local site was seeded with its sample projects. Only the local
database's quote for `sample-owner/sample-bundler` was replaced with this
made-up Markdown to check blank lines, list items, and indentation:

```markdown
## AI help is welcome

Agent pull requests are welcome on issues labeled contribution welcome.

- **Disclose it.** Use `Assisted-by: Codex`.
- **Read the diff.** Check the changes before opening a PR.
  Write the PR description yourself.
- **Check for company.** Help on an existing PR or pick another issue.
```

The screenshot check compared the displayed text with that quote before
capturing each image. The sample fixture in the repository is unchanged.

- [Phone, 390 pixels](policy-390.png)
- [Desktop, 1280 pixels](policy-1280.png)
