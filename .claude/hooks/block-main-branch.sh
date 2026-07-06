#!/usr/bin/env bash
# PreToolUse hook for the Bash tool: blocks git commit / git push / gh pr create
# (targeting main or master) whenever the actual current checkout is on main or
# master. The static permissions.deny patterns in settings.json only pattern-match
# the literal command text (e.g. "git push origin main"), so they can't catch a
# bare "git commit" or "git push" run while HEAD just happens to be on main/master.
set -euo pipefail

input="$(cat)"
command="$(echo "$input" | jq -r '.tool_input.command // empty')"

if [ -z "$command" ]; then
  exit 0
fi

triggers=false

if echo "$command" | grep -qE '(^|[;&|]|&&)[[:space:]]*git[[:space:]]+commit\b'; then
  triggers=true
fi

if echo "$command" | grep -qE '(^|[;&|]|&&)[[:space:]]*git[[:space:]]+push\b'; then
  triggers=true
fi

if echo "$command" | grep -qE 'gh[[:space:]]+pr[[:space:]]+create' \
   && echo "$command" | grep -qE -- '--(base|head)[= ]+(main|master)\b'; then
  triggers=true
fi

if [ "$triggers" = false ]; then
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  jq -n --arg cmd "$command" --arg branch "$branch" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Blocked: refusing to run a commit/push/PR command while checked out on the protected \"" + $branch + "\" branch: " + $cmd)
    }
  }'
fi

exit 0
