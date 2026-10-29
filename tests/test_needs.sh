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

# Each waiting prompt has its own name (chat.n); `new_prompt` gives the one just opened.
prompts() { ls "$D/ask" 2>/dev/null | sed -n 's/\.json$//p' | sort; }
seen=""
new_prompt() {  # sets NEW (not in a subshell, so it remembers what it handed out)
    local k
    NEW=
    for k in $(prompts); do case " $seen " in *" $k "*) ;; *) seen="$seen $k"; NEW=$k; return ;; esac; done
}
allow='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
hookto() {  # hookto OUT COMMAND JSON-FIELDS [&]: like hook, output to $T/OUT
    echo "\"$BUSY\" $2 <<< '{\"session_id\":\"s1\",\"cwd\":\"/home/u/Projects/listr\",\"transcript_path\":\"/t/s1.jsonl\",$3}' > \"$T/$1\" $4" > "$T/cmds"
    sleep 0.4
}
ask() { hookto "$1" ask '"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"'"$2"'"}' '&'; }

# A permission prompt answered from the top bar.
hook ask '"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}' '&'
new_prompt; k1=$NEW
check "ask: the prompt is offered to the top bar, under its own name" "[ -n '$k1' ] && [ -p '$D/ask/$k1.fifo' ] && grep -q pezei '$D/ask/$k1.json'" "$k1"
check "  and waits" "[ ! -s '$T/out' ]"
echo "$allow" | "$BUSY" answer "$k1"
sleep 0.5
check "answered from the top bar: Claude Code gets the decision" "grep -q '\"behavior\":\"allow\"' '$T/out'"
check "  prompt files gone, working again" "[ ! -e '$D/ask/$k1.fifo' ] && [ ! -e '$D/needs/s1' ] && [ -e '$D/s1' ]"

# Two prompts open at once in one chat (Claude runs tools side by side): each answer goes to its
# own prompt, and another tool finishing doesn't close a prompt.
ask out-a ls
new_prompt; ka=$NEW
ask out-b pwd
new_prompt; kb=$NEW
check "two prompts at once: two names" "[ -n '$ka' ] && [ -n '$kb' ] && [ '$ka' != '$kb' ]" "$ka $kb"
echo "$allow" | "$BUSY" answer "$kb"
sleep 0.5
check "  answering the second answers the second only" "grep -q allow '$T/out-b' && [ ! -s '$T/out-a' ] && [ -p '$D/ask/$ka.fifo' ]"
hook busy '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"date"}'
sleep 0.3
check "  another tool finishing leaves the first open" "[ -p '$D/ask/$ka.fifo' ] && [ -e '$D/needs/s1' ]"
ka_pid=$(cat "$D/ask/$ka.pid" 2>/dev/null)
hook busy '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}'
sleep 0.3
check "  its own tool running (answered in the terminal) ends it, says nothing" "! kill -0 ${ka_pid:-999999} 2>/dev/null && [ ! -s '$T/out-a' ] && [ ! -e '$D/ask/$ka.json' ] && [ ! -e '$D/needs/s1' ]"

# Typing something new ends every prompt the chat had open.
ask out-c whoami
new_prompt; kc=$NEW
ask out-d id
new_prompt; kd=$NEW
hook busy '"hook_event_name":"UserPromptSubmit"'
sleep 0.3
check "a new message: every open prompt of the chat ends" "[ -z \"\$(prompts)\" ] && [ ! -s '$T/out-c' ] && [ ! -s '$T/out-d' ]"
check "answer for a prompt that's gone: refused" "! echo '$allow' | \"$BUSY\" answer '$kc'"
check "answer with a bad name: refused" "! echo '{}' | \"$BUSY\" answer '../x' && ! echo '{}' | \"$BUSY\" answer '.x'"
check "a log of what happened" "grep -q '$k1: prompt for Bash' '$D/.log' && grep -q '$k1: answered from outside' '$D/.log' && grep -q '$ka: answered in the terminal' '$D/.log' && grep -q '$kc: ended (the chat moved on)' '$D/.log' && grep -q \"$kc: an answer came for a prompt that's gone\" '$D/.log'" "$(cat "$D/.log"; echo "k1=$k1 ka=$ka kc=$kc")"

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
check "claude gone: its waiting prompt ends" "! ls '$D/ask' | grep -q '^s9\\.' && [ ! -e '$D/needs/s9' ]"

# Switches off.
touch "$HOME/.claude/accounts/lights-off"
hook busy '"hook_event_name":"UserPromptSubmit"'
hook needs '"hook_event_name":"Notification","notification_type":"permission_prompt"'
check "lights off: lights stay steady" "[ \"\$(power)\" = \"$STEADY\" ]"
touch "$HOME/.claude/accounts/ask-off"
hook busy '"hook_event_name":"UserPromptSubmit"'
hook ask '"hook_event_name":"PermissionRequest","tool_name":"Bash"'
check "notifications off: ask returns at once, still needs you" "[ -z \"\$(prompts)\" ] && [ -e '$D/needs/s1' ]"
exit $fails
