#!/bin/bash
# Turn off when Claude is done: only once every chat has really finished (not working, not
# running a command, not waiting for you) for a while, after a warning that a chat starting
# again cancels. Fake claudes, Claude Code's session list in a temp folder, a fake power-off;
# 2 s stand in for the 3 minutes and the minute's warning.
#   tests/test_off.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
BUSY="$HERE/../claude-busy"
T="$(mktemp -d)"
PIDS=()
# A process and everything under it.
tree() { local c; for c in $(pgrep -P "$1"); do tree "$c"; done; kill -CONT "$1" 2>/dev/null; kill "$1" 2>/dev/null; }
cleanup() {
    for p in "${PIDS[@]}"; do tree "$p"; done
    [ -r "$T/rt/claude-busy/.holder" ] && kill "$(cat "$T/rt/claude-busy/.holder")" 2>/dev/null
    rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/rt" "$T/bin" "$T/home/.claude/accounts" "$T/sessions" "$T/lid/LID0"
chmod 700 "$T/rt"
echo "state:      closed" > "$T/lid/LID0/state"
ln -s "$(command -v bash)" "$T/bin/claude"
export XDG_RUNTIME_DIR="$T/rt" HOME="$T/home" CLAUDE_BUSY_CHECK=1 CLAUDE_BUSY_QUIET=2 CLAUDE_BUSY_OFF_WARN=2 \
    CLAUDE_SESSIONS="$T/sessions" CLAUDE_BUSY_LID="$T/lid" CLAUDE_BUSY_LEDS="$T/none" \
    CLAUDE_BUSY_POWER_OFF="touch $T/powered-off"
D="$T/rt/claude-busy"
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; [ -n "$3" ] && echo "     $3"; fails=$((fails + 1)); fi; }
off() { [ -e "$T/powered-off" ]; }
holder() { [ -r "$D/.holder" ] && kill -0 "$(cat "$D/.holder")" 2>/dev/null; }
# A chat: a fake claude process and its entry in Claude Code's list. chat NAME STATUS [running]
chat() {
    if [ "$3" = running ]; then
        "$T/bin/claude" -c 'bash -c "sleep 300; true"; true' & p=$!   # a command it started still runs
    else
        "$T/bin/claude" -c 'sleep 300' & p=$!
    fi
    PIDS+=("$p")
    echo "{\"pid\":$p,\"sessionId\":\"$1\",\"cwd\":\"/home/u\",\"status\":\"$2\",\"kind\":\"interactive\"}" > "$T/sessions/$p.json"
    eval "pid_$1=$p"
}
status() { local p; eval "p=\$pid_$1"; sed -i "s/\"status\":\"[a-z]*\"/\"status\":\"$2\"/" "$T/sessions/$p.json"; }
gone() { local p; eval "p=\$pid_$1"; tree "$p"; rm -f "$T/sessions/$p.json"; }

chat a busy
chat b idle
"$BUSY" off-when-done on
sleep 0.5
check "on: the holder keeps the computer on (lid closed too)" "holder && [ \"\$(\"$BUSY\" off-when-done)\" = on ]"
sleep 5
check "a chat working: no warning, not off" "[ ! -e '$D/.off-at' ] && ! off"
status a shell
sleep 4
check "a chat running a command: not off" "[ ! -e '$D/.off-at' ] && ! off"
status a idle
gone a
chat c idle running
sleep 5
check "a command still running in the background: not off" "[ ! -e '$D/.off-at' ] && ! off"
gone c
mkdir -p "$D/needs"
echo -e "\n$(date +%s)\npermission\n/home/u\n/t" > "$D/needs/s9"
sleep 5
check "a chat waiting for you: not off" "[ ! -e '$D/.off-at' ] && ! off"
rm -f "$D/needs/s9"
# A suspended chat (Ctrl+Z) still says busy: it doesn't count.
chat z busy
kill -STOP "$pid_z"
sleep 1.5
check "nothing left: not at once (a pause isn't finished)" "[ ! -e '$D/.off-at' ] && ! off"
sleep 2.5
check "finished for a while: the minute's warning (suspended chat ignored)" "[ -e '$D/.off-at' ] && ! off"
# A chat starting again during the warning starts the wait over.
status b busy
sleep 1.5
check "a chat starts again during the warning: cancelled" "[ ! -e '$D/.off-at' ] && ! off"
status b idle
sleep 6
check "finished again, warning over: off" "off && [ \"\$(\"$BUSY\" off-when-done)\" = off ]"

# Cancel from the warning.
rm -f "$T/powered-off"
"$BUSY" off-when-done on
sleep 4
check "warning again" "[ -e '$D/.off-at' ]"
"$BUSY" off-when-done off
sleep 3
check "Cancel: not off, back to normal" "! off && [ ! -e '$D/.off-at' ]"
# Turn off now, from the warning.
"$BUSY" off-when-done on
sleep 4
"$BUSY" off-when-done now
sleep 1.5
check "Turn off now: off at once" "off"
# Keep-awake turned off doesn't stop it from waiting with the lid closed.
rm -f "$T/powered-off"
[ -r "$D/.holder" ] && kill "$(cat "$D/.holder")" 2>/dev/null
sleep 0.5
touch "$HOME/.claude/accounts/keep-awake-off"
"$BUSY" off-when-done on
sleep 0.5
check "keep-awake off: still kept on until then" "holder"
"$BUSY" off-when-done off
kill -CONT "$pid_z" 2>/dev/null
exit $fails
