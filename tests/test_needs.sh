#!/bin/bash
# claude-busy's "waits for you" state, permission prompts answered from the top bar, the
# 15-minute rule (3 s here) and the ThinkPad lights, with a fake claude, fake lights and a
# fake lid in a temp folder. The inhibitors it takes are real but only last a few seconds.
#   tests/test_needs.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
BUSY="$HERE/../claude-busy"
T="$(mktemp -d)"
cleanup() {
    kill $FAKE 2>/dev/null
    for f in "$T"/rt/claude-busy/.holder "$T"/rt/claude-busy/ask/*.pid; do
        [ -r "$f" ] && kill "$(cat "$f")" 2>/dev/null
    done
    rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/rt" "$T/bin" "$T/home/.claude/accounts" "$T/lid/LID0"
chmod 700 "$T/rt"
for led in lid_logo_dot power; do
    mkdir -p "$T/leds/tpacpi::$led"
    touch "$T/leds/tpacpi::$led/pattern" "$T/leds/tpacpi::$led/repeat"
done
echo "state:      open" > "$T/lid/LID0/state"
ln -s "$(command -v bash)" "$T/bin/claude"   # a process named claude, like Claude Code
export XDG_RUNTIME_DIR="$T/rt" HOME="$T/home" CLAUDE_BUSY_WAIT=2 CLAUDE_BUSY_CHECK=1 \
    CLAUDE_BUSY_NEEDS=3 CLAUDE_BUSY_ASK_CHECK=1 CLAUDE_BUSY_LEDS="$T/leds" CLAUDE_BUSY_LID="$T/lid"
D="$T/rt/claude-busy"
WORKING="0 360 0 0 255 720 255 0 0 360 0 0"
NEEDS="255 150 255 0 0 150 0 0 255 150 255 0 0 1800 0 0"
STEADY="255 1000 255 1000"
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
holder() { [ -r "$D/.holder" ] && kill -0 "$(cat "$D/.holder")" 2>/dev/null; }
dot() { cat "$T/leds/tpacpi::lid_logo_dot/pattern"; }
power() { cat "$T/leds/tpacpi::power/pattern"; }
lid() { echo "state:      $1" > "$T/lid/LID0/state"; }

# One long-lived fake claude runs the hooks as its children, like Claude Code does; a hook's
# output goes to $T/out.
mkfifo "$T/cmds"
"$T/bin/claude" -c 'exec 3<>"$0"; while read -r line <&3; do eval "$line"; done' "$T/cmds" & FAKE=$!
sleep 0.2
hook() {  # hook COMMAND JSON-FIELDS [&]
    echo "\"$BUSY\" $1 <<< '{\"session_id\":\"s1\",\"cwd\":\"/home/u/Projects/listr\",\"transcript_path\":\"/t/s1.jsonl\",$2}' > \"$T/out\" $3" > "$T/cmds"
    sleep 0.4
}

hook busy '"hook_event_name":"UserPromptSubmit"'
check "working, lid open: lights steady" "[ \"\$(dot)\" = \"$STEADY\" ] || [ -z \"\$(dot)\" ]"
lid closed; sleep 1.5
check "working, lid closed: the dot blinks with the spinner" "[ \"\$(dot)\" = \"$WORKING\" ]"
check "  the power light stays steady" "[ \"\$(power)\" != \"$NEEDS\" ]"

hook needs '"hook_event_name":"Notification","notification_type":"permission_prompt"'
check "needs you: listed, no longer working" "[ -e '$D/needs/s1' ] && [ ! -e '$D/s1' ]"
check "  kind and project kept" "[ \"\$(sed -n 3p '$D/needs/s1')\" = permission ] && [ \"\$(sed -n 4p '$D/needs/s1')\" = /home/u/Projects/listr ]"
check "  both lights blink twice and pause (lid closed)" "[ \"\$(dot)\" = \"$NEEDS\" ] && [ \"\$(power)\" = \"$NEEDS\" ]"
check "  repeating" "[ \"\$(cat '$T/leds/tpacpi::power/repeat')\" = -1 ]"
lid open; sleep 1.5
check "needs you, lid open: only the power light" "[ \"\$(dot)\" = \"$STEADY\" ] && [ \"\$(power)\" = \"$NEEDS\" ]"
hook idle '"hook_event_name":"Notification","notification_type":"idle_prompt"'
check "\"waiting for your input\" during a prompt: still needs you" "[ -e '$D/needs/s1' ]"
hook busy '"hook_event_name":"PostToolUse","tool_name":"Bash"'
check "answered in the terminal: working again, lights steady" "[ ! -e '$D/needs/s1' ] && [ -e '$D/s1' ] && [ \"\$(power)\" = \"$STEADY\" ]"
check "  steady plays once" "[ \"\$(cat '$T/leds/tpacpi::power/repeat')\" = 1 ]"

hook busy '"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"'
check "a question: needs you (question)" "[ \"\$(sed -n 3p '$D/needs/s1')\" = question ] && [ ! -e '$D/s1' ]"
hook busy '"hook_event_name":"PostToolUse","tool_name":"AskUserQuestion"'

# A permission prompt answered from the top bar.
hook ask '"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}' '&'
check "ask: the prompt is offered to the top bar" "[ -p '$D/ask/s1.fifo' ] && grep -q pezei '$D/ask/s1.json'"
check "  and waits" "[ ! -s '$T/out' ]"
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' | "$BUSY" answer s1
sleep 0.5
check "answered from the top bar: Claude Code gets the decision" "grep -q '\"behavior\":\"allow\"' '$T/out'"
check "  prompt files gone, working again" "[ ! -e '$D/ask/s1.fifo' ] && [ ! -e '$D/needs/s1' ] && [ -e '$D/s1' ]"

# The same prompt answered in the terminal instead: the next hook ends the waiting one.
hook ask '"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}' '&'
ask_pid=$(cat "$D/ask/s1.pid" 2>/dev/null)
hook busy '"hook_event_name":"PostToolUse","tool_name":"Bash"'
sleep 0.3
check "answered in the terminal: the waiting prompt ends, says nothing" "! kill -0 ${ask_pid:-999999} 2>/dev/null && [ ! -s '$T/out' ] && [ ! -e '$D/ask/s1.json' ]"
check "answer for a prompt that's gone: refused" "! echo '{}' | \"$BUSY\" answer s1"
check "answer with a bad session name: refused" "! echo '{}' | \"$BUSY\" answer '../x'"

# Waiting for you keeps the computer awake 3 s ("15 minutes"), then the waiting minute (2 s).
hook busy '"hook_event_name":"Stop"'
hook needs '"hook_event_name":"Notification","notification_type":"permission_prompt"'
sleep 2
check "waiting for you: awake" holder
sleep 4.5
check "after 15 minutes and the waiting minute: sleep allowed" "! holder"
check "  still shown as waiting for you" "[ -e '$D/needs/s1' ] && \"$BUSY\" status | grep -q 'waiting for you'"

# A claude that quits while a prompt waits: the prompt ends by itself.
( "$T/bin/claude" -c "\"$BUSY\" ask <<< '{\"session_id\":\"s9\",\"hook_event_name\":\"PermissionRequest\"}' > /dev/null &
    sleep 0.5; kill -9 \$\$" ) 2>/dev/null
sleep 2.5
check "claude gone: its waiting prompt ends" "[ ! -e '$D/ask/s9.pid' ] && [ ! -e '$D/needs/s9' ]"

# Switches off.
touch "$HOME/.claude/accounts/lights-off"
hook busy '"hook_event_name":"UserPromptSubmit"'
hook needs '"hook_event_name":"Notification","notification_type":"permission_prompt"'
check "lights off: lights stay steady" "[ \"\$(power)\" = \"$STEADY\" ]"
touch "$HOME/.claude/accounts/ask-off"
hook busy '"hook_event_name":"UserPromptSubmit"'
hook ask '"hook_event_name":"PermissionRequest","tool_name":"Bash"'
check "notifications off: ask returns at once, still needs you" "[ ! -e '$D/ask/s1.fifo' ] && [ -e '$D/needs/s1' ]"
exit $fails
