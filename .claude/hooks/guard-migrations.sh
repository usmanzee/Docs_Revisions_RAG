#!/usr/bin/env bash
# PreToolUse guard for Edit|Write|MultiEdit.
#
# CLAUDE.md: "Never edit an existing migration. Add a new numbered one."
# Migrations are checksummed by the migrator, so editing an applied one breaks
# every database that already ran it. A rule in a prompt is a request; this
# makes it a rule. New (untracked) migration files are allowed.
#
# Exit 2 blocks the tool call and feeds stderr back to Claude.

file=$(jq -r '.tool_input.file_path // empty')
[ -z "$file" ] && exit 0

case "$file" in
  */migrations/*.sql | migrations/*.sql) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
rel="${file#"$PWD"/}"

if git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
  last=$(ls migrations/*.sql 2>/dev/null | sed -E 's#.*/([0-9]{4})_.*#\1#' | sort | tail -1)
  next=$(printf '%04d' $((10#${last:-0} + 1)))
  echo "Blocked: $rel is a committed migration and must not be edited (CLAUDE.md rule)." >&2
  echo "Add a new migration instead: migrations/${next}_<description>.sql" >&2
  exit 2
fi

exit 0
