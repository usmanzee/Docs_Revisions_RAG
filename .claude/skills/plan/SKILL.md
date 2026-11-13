---
name: plan
description: Turn a rough brief into a decision-ready plan before any code is written - challenge the brief, give options with trade-offs, list failure cases, recommend one. Use for anything bigger than a small fix.
argument-hint: <the brief>
---
Read CLAUDE.md and the code related to this brief: $ARGUMENTS

If no brief is given, ask for one and stop.

Do not write code yet.
1. Restate the goal. Point out anything unclear, risky or wrong in the brief.
2. Give 2 or 3 options with trade-offs.
3. List the failure cases and what must not happen.
4. Recommend one option, with the files you'd change and the tests you'd add.
Then wait for my decision.

## After I decide

Write the chosen plan to `docs/plans/YYYY-MM-DD-<short-slug>.md`. This file is
what builders work from, so it must stand on its own:

- **Goal** - one paragraph, and who it is for.
- **Decision** - the option chosen, the ones rejected and why.
- **Must not happen** - the failure cases from step 3, as checkable statements.
- **Tasks** - numbered. For each: the files it owns, the tests it adds, and
  "done when". Mark any task that touches `migrations/`, `packages/shared` or
  `packages/hcm-contract` as **shared surface** (it runs first, alone).
- **Open questions** - anything that needs research before building.

Still no code until I say build. If the decision was a real trade-off, suggest
recording it with `/decision`.
