---
name: split
description: Split an approved plan into independent tasks and run them in parallel - builder agents in isolated git worktrees, a researcher per open question, then a sceptical review of the combined result.
argument-hint: <path to docs/plans/... file>
disable-model-invocation: true
---
Plan file: $ARGUMENTS

If no path is given, use the newest file in `docs/plans/`. If there is none,
stop and tell me to run `/plan` first.

## 1. Split

Read the plan and CLAUDE.md. Two tasks can run at the same time only if they
own no file in common and neither needs the other's output.

- A **shared surface** task (`migrations/`, `packages/shared`,
  `packages/hcm-contract`) runs first, alone, in the main checkout. Worktrees
  symlink `node_modules`, which resolves those packages to the main checkout's
  build, so a worktree would not see its own changes to them.
- Show me the split as a table: task, files owned, tests, depends on, runs in
  (main / worktree). **Wait for my OK.**

## 2. Run

Worktrees branch from local HEAD, so the plan file must be committed first.
If it is not, say so and stop.

On OK, launch in a single message:
- one `builder` agent per independent task, with `isolation: "worktree"`.
  Pass the plan path **and** the task's section verbatim.
- one `researcher` agent per open question in the plan, if any.

## 3. Check what came back

Don't trust the summaries. For each builder, open its worktree diff and read
its real test output yourself. Check that it stayed inside the files it owned.

Integration tests share one test database and truncate between suites, so
builders run unit tests only. After the worktrees are merged, run the
integration suite once, in the main checkout.

## 4. Review and report

Launch the `reviewer` agent on the combined diff. Then report, per task: what
changed, the real test result, reviewer findings by severity, and anything
still needing my decision. Don't merge any worktree until I say.
