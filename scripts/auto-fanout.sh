#!/usr/bin/env bash
# The auto-fanout's cron entry point: Claude implements the Nertz issues labelled `auto`, a PR to staging for each
# (.claude/skills/auto-fanout/SKILL.md holds the whole flow).
#
# One run at a time (a lock: a run due while another is going is skipped). First a cheap check, one call to Linear: with
# no Nertz issue labelled `auto` waiting (Backlog or Todo), it stops there, saying nothing and spending no tokens. With
# some, it fetches in the main checkout and runs `claude -p "/auto-fanout"` there, unattended.
#
# Hourly, in root's crontab (`crontab -e`; nothing here installs it):
#   17 * * * * /root/projects/nertz/scripts/auto-fanout.sh
# To stop it, take that line out. A run under way: `pkill -f 'claude -p /auto-fanout'`.
#
# The Linear key: a personal API key (Linear, Settings, Security & access), alone in the file $LINEAR_KEY_FILE,
# ~/.config/linear/api-key unless said (mode 600). Read only for this check, and never printed; the run itself reaches
# Linear through Claude's own linear-personal connection.
#
# Each run is logged, a line at a time with the time it was written, to ~/.local/state/nertz-auto/runs.log: when it
# started, the session (`claude --resume <id>` from the checkout shows all it did), the summary it ends with, and how it ended.
#
# Also from the environment, each optional: NERTZ_REPO (the main checkout, /root/projects/nertz),
# NERTZ_AUTO_BUDGET_USD (what one run may spend at most, 15), NERTZ_AUTO_HOURS (how long one may go on, 3).
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH" # (cron's own is bare: claude lives in ~/.local/bin)
REPO="${NERTZ_REPO:-/root/projects/nertz}"
KEY_FILE="${LINEAR_KEY_FILE:-$HOME/.config/linear/api-key}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/nertz-auto"
LOG="$STATE/runs.log"
mkdir -p "$STATE"

exec 9> "$STATE/lock"
flock -n 9 || exit 0

# Each line of what comes in, written to the log with the time.
stamped() { while IFS= read -r line; do printf '%(%Y-%m-%dT%H:%M:%S%z)T %s\n' -1 "$line"; done >> "$LOG"; }
say() { echo "$*" | stamped; }

[[ -r $KEY_FILE ]] || { say "no Linear key at $KEY_FILE: not checked"; exit 1; }

# The same issues the skill picks up: the team SMI's, in the project Nertz, labelled auto, not yet started.
QUERY='query { issues(first: 1, filter: { team: { key: { eq: "SMI" } }, project: { name: { eq: "Nertz" } }, labels: { some: { name: { eqIgnoreCase: "auto" } } }, state: { type: { in: ["backlog", "unstarted"] } } }) { nodes { identifier } } }'
# (The header from a file descriptor: printf is a builtin, so the key is never in a process's arguments.)
answer=$(curl -sS --max-time 20 https://api.linear.app/graphql -H 'Content-Type: application/json' \
  -H @<(printf 'Authorization: %s\n' "$(tr -d '[:space:]' < "$KEY_FILE")") \
  -d "$(jq -nc --arg q "$QUERY" '{query: $q}')" 2>&1) || { say "Linear did not answer: $answer"; exit 1; }
waiting=$(jq -r 'if .errors then error(.errors[0].message) else .data.issues.nodes | length end' <<< "$answer" 2>&1) || { say "Linear refused the check: $waiting"; exit 1; }
(( waiting > 0 )) || exit 0

cd "$REPO"
[[ -f .claude/skills/auto-fanout/SKILL.md ]] || { say "no .claude/skills/auto-fanout in $REPO (on $(git branch --show-current)): not run"; exit 1; }
git fetch --quiet origin 2>&1 | stamped || true

session=$(uuidgen)
say "run: $(jq -r '.data.issues.nodes[0].identifier' <<< "$answer") is waiting (and maybe more); session $session"
# auto: the classifier approves what is safe, and with no one there to ask, what it would ask about is refused
# (--permission-prompts none) rather than waited on. The budget and the time are the guards on a run (this claude has no
# limit on turns). Its summary, at the end, is what comes out.
set +e
timeout --kill-after=2m "${NERTZ_AUTO_HOURS:-3}h" \
  claude -p "/auto-fanout" --session-id "$session" --name auto-fanout \
  --permission-mode auto --permission-prompts none \
  --max-budget-usd "${NERTZ_AUTO_BUDGET_USD:-15}" < /dev/null 2>&1 | stamped
ended=${PIPESTATUS[0]}
set -e
say "ended: $([[ $ended == 0 ]] && echo done || { [[ $ended == 124 ]] && echo "out of time" || echo "exit $ended"; })"
exit "$ended"
