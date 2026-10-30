#!/bin/bash
# A chat stopping at the usage limit switches accounts at once (claude-account limit-hit, from
# claude-busy's StopFailure hook), even while the usage check is refused (stale readings).
# Fake accounts in a temp home; nothing real is touched.
#   tests/test_limit.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
ACCT="$HERE/../claude-account"
BUSY="$HERE/../claude-busy"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" XDG_RUNTIME_DIR="$T/rt" CLAUDE_ACCOUNT_CMD="$ACCT" \
    CLAUDE_BUSY_LEDS="$T/leds" CLAUDE_BUSY_LID="$T/lid" CLAUDE_SESSIONS="$T/sessions"
A="$HOME/.claude/accounts"
mkdir -p "$A" "$T/rt" "$T/leds" "$T/sessions"
chmod 700 "$T/rt"
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

later=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%S+00:00)
earlier=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%S+00:00)
setup() {   # $1 = usage.cache contents
    rm -f "$A"/* "$A"/.lock
    for n in - 0 1; do
        echo "{\"credentials\":{\"claudeAiOauth\":{\"accessToken\":\"tok$n\",\"expiresAt\":9999999999999}}}" > "$A/$n.json"
    done
    printf -- '-\n0\n1\n' > "$A/names"
    echo 0 > "$A/active"
    cp "$A/0.json" "$HOME/.claude/.credentials.json"
    echo '{}' > "$HOME/.claude.json"
    echo "$1" > "$A/usage.cache"
}
stop() {    # a transcript whose last entry is a usage-limit stop at time $1 (default now)
    local at=${1:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"go"}}' \
        "{\"type\":\"assistant\",\"timestamp\":\"$at\",\"apiError\":\"usage_limit_reached\",\"error\":\"rate_limit\",\"apiErrorParams\":{\"rate_limit_info\":{\"resetsAt\":$(date -d '+3 hours' +%s),\"rateLimitType\":\"five_hour\"}},\"isApiErrorMessage\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"You've hit your session limit\"}]}}" \
        > "$T/chat.jsonl"
}
active() { cat "$A/active"; }

# All readings stale (the usage check answers 429): the old auto-switch never moved.
setup "{\"-\":{\"pct\":40,\"resets_at\":\"$later\",\"stale\":true},\"0\":{\"pct\":97,\"resets_at\":\"$later\",\"stale\":true},\"1\":{\"pct\":70,\"resets_at\":\"$later\",\"stale\":true}}"
stop
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "limit hit: switches to the account with the most room, stale or not" '[ "$(active)" = - ]'
check "the full account is marked 100% with the error's reset time" \
    "python3 -c 'import json,sys; u=json.load(open(\"$A/usage.cache\"))[\"0\"]; sys.exit(not (u[\"pct\"]==100 and not u.get(\"stale\") and u[\"resets_at\"]))'"
check "history says it was an automatic switch" "tail -1 '$A/history.jsonl' | grep -q '\"switch\":\"-\",\"auto\":\"0\"'"
check "credentials swapped" "grep -q 'tok-' '$HOME/.claude/.credentials.json'"

# A second chat that stopped on the old account before the switch: nothing more happens.
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "an older stop after the switch: no second switch" '[ "$(active)" = - ] && [ "$(grep -c switch "$A/history.jsonl")" = 1 ]'

# Two chats stopping at the same moment: one switch.
setup "{\"-\":{\"pct\":10,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"},\"1\":{\"pct\":20,\"resets_at\":\"$later\"}}"
stop "$(date -u -d '-2 seconds' +%Y-%m-%dT%H:%M:%S.000Z)"
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null & "$ACCT" limit-hit "$T/chat.jsonl" >/dev/null; wait
check "two stops at once: one switch" '[ "$(active)" = - ] && [ "$(grep -c switch "$A/history.jsonl")" = 1 ]'

# An ended window counts as empty; a full one is skipped.
setup "{\"-\":{\"pct\":100,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"},\"1\":{\"pct\":100,\"resets_at\":\"$earlier\"}}"
stop
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "an account whose window ended is used" '[ "$(active)" = 1 ]'

setup "{\"-\":{\"pct\":100,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"},\"1\":{\"pct\":100,\"resets_at\":\"$later\"}}"
stop
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "every account full: stays" '[ "$(active)" = 0 ] && [ ! -e "$A/history.jsonl" ] || ! grep -q switch "$A/history.jsonl"'

setup "{\"-\":{\"pct\":5,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"}}"
touch "$A/auto-switch-off"
stop
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "auto-switch off: stays" '[ "$(active)" = 0 ]'

# Not a limit (another API error): nothing.
setup "{\"-\":{\"pct\":5,\"resets_at\":\"$later\"},\"0\":{\"pct\":30,\"resets_at\":\"$later\"}}"
printf '%s\n' '{"type":"assistant","apiError":"overloaded","message":{"content":[]}}' > "$T/chat.jsonl"
"$ACCT" limit-hit "$T/chat.jsonl" >/dev/null
check "another error: no switch" '[ "$(active)" = 0 ]'

# The hook: claude-busy idle on StopFailure starts it in the background.
setup "{\"-\":{\"pct\":5,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"}}"
stop
echo "{\"session_id\":\"s1\",\"hook_event_name\":\"StopFailure\",\"transcript_path\":\"$T/chat.jsonl\",\"error\":\"rate_limit\"}" | "$BUSY" idle
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(active)" = - ] && break; sleep 0.3; done
check "claude-busy StopFailure hook switches" '[ "$(active)" = - ]'
setup "{\"-\":{\"pct\":5,\"resets_at\":\"$later\"},\"0\":{\"pct\":99,\"resets_at\":\"$later\"}}"
echo "{\"session_id\":\"s1\",\"hook_event_name\":\"Stop\",\"transcript_path\":\"$T/chat.jsonl\"}" | "$BUSY" idle
sleep 1
check "a plain Stop doesn't" '[ "$(active)" = 0 ]'

echo
[ $fails = 0 ] && echo "all passed" || echo "$fails failed"
exit $fails
