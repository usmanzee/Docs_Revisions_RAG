---
name: sceptic-review
description: Sceptical review of the uncommitted changes against CLAUDE.md - correctness, failure cases, writes that could run twice, missing tests, security - with real test results. Use before committing.
---
Review the uncommitted changes (git diff) against CLAUDE.md.
Check correctness, failure cases, writes that could run twice, missing tests and security.
Run the relevant tests and report the real result, not what you expect.
List problems by severity with file and line. Don't fix anything yet.

How:

1. Read `git status`, `git diff` and the untracked files. Read the code around
   each change, not just the hunk.
2. In parallel, launch the `reviewer` agent on the same diff. Give it the diff
   and CLAUDE.md, not your conclusions, so its read is not anchored on yours.
3. Run the tests that cover the changed code. If `node -v` is below 22, prefix
   with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`. Quote the real pass/fail
   counts. If a suite could not run, say so and why.
4. Merge your findings with the reviewer's. Verify each one against the code
   before reporting it; drop anything you cannot reproduce or point to.
5. Report: **High / Medium / Low**, each with `file:line`, the concrete failure
   scenario, and whether it came from you, the reviewer, or both.
