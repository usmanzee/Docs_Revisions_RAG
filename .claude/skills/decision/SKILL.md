---
name: decision
description: Record a decision as a short numbered record in docs/decisions/ - context, options considered, what was chosen, consequences. Use after a real trade-off is settled, so the reason survives the session.
argument-hint: <what was decided>
---
Record this decision: $ARGUMENTS

If nothing is given, use the decision just made in this conversation. If there
isn't one, ask what to record and stop.

1. Find the next number in `docs/decisions/` (start at `0001`). File name:
   `NNNN-<short-slug>.md`.
2. Write it in plain English, under one screen:

   ```
   # NNNN. <Title>

   Date: YYYY-MM-DD · Status: Accepted

   ## Context
   What forced a decision. Facts and measurements, with file:line where relevant.

   ## Options
   Each option considered, with its main trade-off.

   ## Decision
   What we chose, and the reason in one or two sentences.

   ## Consequences
   What this makes easier, what it makes harder, what we will have to watch.
   ```

3. Only write what was actually said or measured. Don't invent options that
   were never on the table, or numbers that weren't run.
4. If it supersedes an earlier record, set that one's status to
   `Superseded by NNNN`. Don't rewrite its content.
5. If the decision changes behaviour, check whether README "Known limitations"
   or `docs/project-brief.md` need updating, and say which.
