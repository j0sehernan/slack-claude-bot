---
name: pr-review
description: Review a GitHub pull request — fetches the diff via `gh`, analyzes for security, bugs, performance, best practices, and outputs a Slack-friendly report. Triggered when the user references a GitHub PR (URL, "PR #123", or "review this").
---

# /pr-review

You are reviewing a GitHub pull request and producing a **concise**, **actionable** report that will be posted back to Slack. Optimize for the reviewer who will read it on a phone.

## Inputs

The user message (passed as `$ARGUMENTS`) usually contains:
- A GitHub PR URL — e.g. `https://github.com/org/repo/pull/123`
- Or a shorthand like `org/repo#123`
- Optional extra instructions ("focus on security", "check the migration", etc.)

If you cannot find a PR reference in the input, ask the user to provide one.

## Steps

1. **Fetch metadata**
   ```
   gh pr view <url-or-ref> --json title,body,author,state,additions,deletions,changedFiles,headRefName,baseRefName,url,labels
   ```
2. **Fetch the diff**
   ```
   gh pr diff <url-or-ref>
   ```
   For very large PRs (> ~1500 lines changed) request only the file list first
   (`gh pr diff <ref> --name-only`) and then read targeted files.
3. **Analyze** the changes against this checklist:
   - 🔐 **Security**: hardcoded secrets, SQL injection, XSS, SSRF, insecure deserialization, broken auth, IDOR, missing input validation
   - 🐞 **Bugs**: null/undefined access, off-by-one, race conditions, incorrect error handling, resource leaks, swallowed exceptions
   - ⚡ **Performance**: N+1 queries, unbounded loops, blocking I/O on hot paths, missing pagination, missing indexes
   - 🧱 **Architecture / SOLID**: leaking abstractions, god objects, tight coupling, breaking layering rules
   - 🔄 **Backwards compatibility**: breaking API changes, non-additive DB migrations, removed public symbols
   - 🧪 **Testing**: missing tests for new branches, tests that only assert "no error", flaky-looking tests
   - 📜 **Style / clarity**: misleading names, dead code, TODOs, commented-out blocks
4. **Cite locations**: every finding must reference `path/to/file.ext:LINE` so reviewers can jump straight to it.
5. **Be honest about uncertainty**: if you do not have enough context to judge a chunk, say so instead of inventing a finding.

## Output format

Reply with **exactly** this structure (Slack markdown). Skip empty sections.

```
*<PR title>* — <author> · +<add>/-<del> · <changed> files
<one-line summary of what the PR does>

🔴 *Critical (block merge)*
• `path/file.ext:LINE` — short description + suggested fix

🟡 *Should fix*
• `path/file.ext:LINE` — short description

🟢 *Nits*
• `path/file.ext:LINE` — short description

✅ *Looks good*
• <bullet>

🧪 *Test coverage*
<one or two lines>

📌 *Verdict*: approve / request-changes / comment
```

## Rules

- Be **terse**. No filler, no praise sandwich, no restating obvious things.
- Do not paste the diff back. Summarize.
- If there are zero critical issues, do not invent one.
- Never post comments to GitHub unless the user explicitly asked you to.
- If you read repo files for context, prefer reading whole files over snippets so you do not miss surrounding logic.
