#!/usr/bin/env bash
# Tells Brian a PR is ready, as BinaryBot: a thread in #nertz-feedback, on the report's own post where there is one,
# with a message in it that tags him (whoever owns the BinaryMile server). Used by the auto-fanout (.claude/skills/auto-fanout).
#   scripts/feedback-thread.sh [--dry-run] <where> <issue url> <PR url> <what it does, in a few words>
# says, in a thread named "SMI-N · <what it does>":
#   @Brian [PR #131](<PR url>) for [SMI-187](<issue url>) is ready for you: <what it does>
# (the links on the words, the URLs never shown, and no previews). <where> is one of:
#   a Discord message id (digits): the post, as the issue's `**Discord:**` line gives it;
#   a report id (12 hex digits, the issue's `**Report:**` line): the post is found by its embed's footer, among the
#     channel's last 500 messages;
#   -: there is no post (an issue nobody reported): the thread goes on a fresh message in the channel,
#     "[SMI-N](<issue url>): <what it does>".
# A post that cannot be found gets a fresh message too, and one that has a thread already (an earlier PR for the same
# report) has the message put in that thread. --dry-run looks everything up and says what it would post, posting nothing.
# Prints the thread's address. Token: ~/.config/discord/binarybot-bot-token (DISCORD_TOKEN_FILE overrides); never printed.
set -euo pipefail

API="https://discord.com/api/v10"
TOKEN_FILE="${DISCORD_TOKEN_FILE:-$HOME/.config/discord/binarybot-bot-token}"
GUILD="${NERTZ_FEEDBACK_GUILD:-1504711608142790719}" # BinaryMile
CHANNEL_NAME="${NERTZ_FEEDBACK_CHANNEL:-nertz-feedback}"

dry=0
[[ ${1:-} == --dry-run ]] && { dry=1; shift; }
(( $# == 4 )) || { sed -n '2,15p' "$0" >&2; exit 1; }
where=$1 issue_url=$2 pr_url=$3 what=$4
[[ $issue_url =~ ^https://linear\.app/[^/]+/issue/([A-Z]+-[0-9]+)(/|$) ]] || { echo "Not a Linear issue's address: $issue_url" >&2; exit 1; }
issue=${BASH_REMATCH[1]}
[[ $pr_url =~ ^https://github\.com/[^/]+/[^/]+/pull/([0-9]+)$ ]] || { echo "Not a GitHub PR's address: $pr_url" >&2; exit 1; }
pr=${BASH_REMATCH[1]}
name="$issue · $what"
name=${name:0:100}
[[ -r $TOKEN_FILE ]] || { echo "No token at $TOKEN_FILE" >&2; exit 1; }

# One call to Discord: its answer on stdout, also when it refuses (and then a non-zero status).
api() {
  local method=GET args=()
  [[ $1 == -X ]] && { method=$2; shift 2; }
  [[ -n ${2:-} ]] && args=(-H "Content-Type: application/json" -d "$2")
  # (The header from a file descriptor: printf is a builtin, so the token is never in a process's arguments.)
  curl -sS --fail-with-body --max-time 20 -X "$method" -H @<(printf 'Authorization: Bot %s\n' "$(tr -d '[:space:]' < "$TOKEN_FILE")") \
    ${args[@]+"${args[@]}"} "$API/$1"
}

owner=$(api "guilds/$GUILD" | jq -r .owner_id)
channel=$(api "guilds/$GUILD/channels" | jq -r --arg n "$CHANNEL_NAME" 'map(select(.type == 0 and .name == $n))[0].id // empty')
[[ -n $channel ]] || { echo "No #$CHANNEL_NAME in guild $GUILD" >&2; exit 1; }

# The post the thread goes on: empty for a fresh message.
post=
if [[ $where =~ ^[0-9]{17,20}$ ]]; then
  if api "channels/$channel/messages/$where" > /dev/null 2>&1; then post=$where; else echo "No message $where in #$CHANNEL_NAME: a fresh one instead" >&2; fi
elif [[ $where =~ ^[0-9a-f]{12}$ ]]; then
  before=
  for _ in 1 2 3 4 5; do
    page=$(api "channels/$channel/messages?limit=100${before:+&before=$before}")
    post=$(jq -r --arg r "$where" 'map(select(any(.embeds[]?; .footer.text == $r)))[0].id // empty' <<< "$page")
    before=$(jq -r 'last.id // empty' <<< "$page")
    [[ -n $post || -z $before ]] && break
  done
  [[ -n $post ]] || echo "No post of report $where in #$CHANNEL_NAME: a fresh message instead" >&2
elif [[ $where != - ]]; then
  echo "Not a message id, a report id or -: $where" >&2
  exit 1
fi

# (flags 4: the links show no previews.)
text="<@$owner> [PR #$pr]($pr_url) for [$issue]($issue_url) is ready for you: $what"
say=$(jq -nc --arg c "$text" --arg o "$owner" '{content: $c, allowed_mentions: {users: [$o]}, flags: 4}')
fresh="[$issue]($issue_url): $what"
if (( dry )); then
  echo "would open a thread \"$name\" on ${post:-a fresh message, \"$fresh\",} in #$CHANNEL_NAME ($channel), and say: $text"
  exit 0
fi

if [[ -z $post ]]; then
  post=$(api -X POST "channels/$channel/messages" "$(jq -nc --arg c "$fresh" '{content: $c, allowed_mentions: {parse: []}, flags: 4}')" | jq -r .id)
fi
# A thread opened on a message has the message's id; Discord refuses a second one on it (code 160004).
if made=$(api -X POST "channels/$channel/messages/$post/threads" "$(jq -nc --arg n "$name" '{name: $n, auto_archive_duration: 10080}')"); then
  thread=$(jq -r .id <<< "$made")
elif jq -e '.code == 160004' <<< "$made" > /dev/null 2>&1; then
  thread=$post
else
  echo "Discord would not open the thread: $made" >&2
  exit 1
fi
api -X POST "channels/$thread/messages" "$say" > /dev/null
echo "https://discord.com/channels/$GUILD/$thread"
