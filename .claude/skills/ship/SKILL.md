---
name: ship
description: Commit the reviewed work on a feature branch with a message that explains why, then push and open a PR only after I confirm.
argument-hint: [short description of the change]
disable-model-invocation: true
---
Ship the current changes. Context from me: $ARGUMENTS

1. **Check the tree.** Run `git status` and `git diff --stat`. List what will be
   committed. Never stage `.env*`, `storage/`, `data/evaluation/*.json` or
   anything else in `.gitignore`. If there are unrelated changes, ask which to
   include.
2. **Branch.** If on `main`, create `<type>/<short-slug>` first (type: feat,
   fix, docs, chore, refactor). Never commit straight to `main`.
3. **Verify.** Run `npm run typecheck` and the tests that cover the change
   (prefix with `source ~/.nvm/nvm.sh && nvm use >/dev/null &&` if
   `node -v` < 22). If anything fails, stop and show the real output. Don't
   commit red.
4. **Commit.** Stage files by name, not `git add -A`. The message has an
   imperative subject of 72 characters or fewer, then a body saying why the
   change was made and what was decided, not a list of files. Commits are mine
   alone: no `Co-Authored-By`, no "Generated with Claude Code" line, and no
   other AI attribution in the commit or the PR body. Use my git identity as
   configured. Never pass `--author`, never set `user.name`/`user.email`, and
   never change git config or credentials.
5. **Show me** the commit (`git show --stat HEAD`) and stop. Ask before pushing.
6. **On my OK, push** with `git push -u origin <branch>`. Never force-push.
7. **PR.** If `gh` is installed, run `gh pr create`. If not, print the compare
   URL (`https://github.com/<owner>/<repo>/compare/<branch>?expand=1`, taken
   from `git remote get-url origin`) and the PR body for me to paste:
   - **What and why** - two or three sentences.
   - **Decisions** - with links to `docs/plans/` or `docs/decisions/` if any.
   - **Tests** - the commands run and their real results.
   - **Risks / follow-ups** - what could break and what was deliberately left out.
