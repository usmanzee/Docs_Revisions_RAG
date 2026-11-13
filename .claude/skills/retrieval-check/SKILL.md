---
name: retrieval-check
description: Measure retrieval quality safely - check that embeddings are uniform and real (not mock) before running the gold-set evaluation, then compare against the last recorded baseline. Use before quoting or changing any retrieval metric.
argument-hint: [--limit=N]
---
Measure retrieval quality. Extra arguments for the evaluator: $ARGUMENTS

Read the "Gotchas" in CLAUDE.md and section 10 of `docs/project-brief.md`
first.

1. **Node.** If `node -v` is below 22, prefix every command with
   `source ~/.nvm/nvm.sh && nvm use >/dev/null &&`.
2. **Embeddings must be uniform and real.** `npm run db:psql` ignores extra
   arguments, so query with psql directly. Extract only `DATABASE_URL` and
   never print it. Don't `source` `.env`: it isn't valid shell, and sourcing
   it runs words from its values as commands.

   ```bash
   DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
   psql "$DATABASE_URL" -c "SELECT embedding_model, count(*) FROM document_chunks GROUP BY 1;"
   psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE embedding IS NULL) AS unembedded, count(*) AS total FROM document_chunks WHERE is_current;"
   ```

   **Stop and report** if there is more than one model, if any model is
   `deterministic-mock`, or if any current chunk is unembedded. Mixed or mock
   vectors make every quality number meaningless, and nothing else errors.
3. **Gold set.** Confirm `data/evaluation/questions.json` exists and count its
   questions. The `evaluation_questions` table is not on the read path. Don't
   be misled by it being empty.
4. **Run** `npm run eval:retrieval -- $ARGUMENTS`. It calls the embedding API
   and costs money, so it asks for permission. Never pass `--allow-non-semantic`
   to produce numbers for a report.
5. **Compare** against the baseline in brief section 10: Recall@1/3/5, MRR,
   section accuracy, current-revision accuracy, no-answer behaviour, latency.
   Show a table of baseline, now and delta.
6. **Before calling anything a regression**, check the metric: is the expected
   answer in the gold set still right for the current revision? When a metric
   looks wrong, check the metric before changing the system.
