#!/bin/bash
# claude-busy's waiting period: awake while Claude works (no time limit), then a waiting
# minute (3 s here) that a new request extends. Uses a fake claude process and a temp runtime
# folder; the inhibitors it takes are real but only last a few seconds.
#   tests/test_busy.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
BUSY="$HERE/../claude-busy"
T="$(mktemp -d)"
trap 'kill $FAKE 2>/dev/null; [ -r "$T/rt/claude-busy/.holder" ] && kill "$(cat "$T/rt/claude-busy/.holder")" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/rt" "$T/bin" "$T/home/.claude/accounts"
chmod 700 "$T/rt"
ln -s "$(command -v bash)" "$T/bin/claude"   # a process named claude, like Claude Code
export XDG_RUNTIME_DIR="$T/rt" HOME="$T/home" CLAUDE_BUSY_WAIT=3 CLAUDE_BUSY_CHECK=1
D="$T/rt/claude-busy"
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
holder() { [ -r "$D/.holder" ] && kill -0 "$(cat "$D/.holder")" 2>/dev/null; }
# One long-lived fake claude runs the hooks as its children, like Claude Code does.
mkfifo "$T/cmds"
"$T/bin/claude" -c 'exec 3<>"$0"; while read -r line <&3; do eval "$line"; done' "$T/cmds" & FAKE=$!
sleep 0.2
hook() { echo "\"$BUSY\" $1 <<< '{\"session_id\":\"$2\"}'" > "$T/cmds"; sleep 0.3; }

hook busy s1; sleep 1
check "awake while working" holder
first=$(cat "$D/.holder")
touch -d '-2 hours' "$D/s1"
sleep 2
check "no time limit: a quiet working session keeps it awake" "holder && [ -e '$D/s1' ]"
hook idle s1; sleep 1
check "done: still awake during the waiting period" holder
check "status says so" "\"$BUSY\" status | grep -q 'waiting minute'"
hook busy s1; sleep 2
check "a new request in the waiting period: same lock, keeps going" "holder && [ \"\$(cat '$D/.holder')\" = '$first' ]"
sleep 3
check "still awake while that one works" holder
hook idle s1; sleep 1.5
check "waiting again after it's done" holder
sleep 4
check "a waiting period with nothing new: sleep allowed" "! holder"
check "status: idle" "[ \"\$(\"$BUSY\" status)\" = idle ]"

# A session whose claude is gone is done right away, then the waiting period.
"$T/bin/claude" -c "\"$BUSY\" busy < <(echo '{\"session_id\":\"s2\"}'); sleep 1" ; sleep 0.5
check "crashed claude: session dropped" "sleep 1.5; [ ! -e '$D/s2' ]"
sleep 4
check "crashed claude: sleep allowed after the waiting period" "! holder"

# keep-awake off: no lock at all.
touch "$HOME/.claude/accounts/keep-awake-off"
hook busy s3; sleep 1
check "keep-awake off: no lock" "! holder"
exit $fails
