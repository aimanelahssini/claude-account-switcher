#!/bin/bash
# Ask on my phone: permission prompts go to Telegram (a stand-in here) once you're away, with
# the terminal's options; a tap answers Claude; answered elsewhere or the laptop going to sleep,
# the message loses its buttons and says so. A fake claude, a fake lid, a temp home.
#   tests/test_phone.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
BUSY="$HERE/../claude-busy"
T="$(mktemp -d)"
cleanup() {
    kill $FAKE $API 2>/dev/null
    for f in "$T"/rt/claude-busy/.holder "$T"/rt/claude-busy/.phone "$T"/rt/claude-busy/ask/*.pid; do
        [ -r "$f" ] && kill "$(cat "$f")" 2>/dev/null
    done
    rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/rt" "$T/bin" "$T/home/.claude/accounts" "$T/lid/LID0"
chmod 700 "$T/rt"
echo "state:      open" > "$T/lid/LID0/state"
echo '{"token": "123:abc", "chat": 4242}' > "$T/home/.claude/accounts/.phone"
ln -s "$(command -v bash)" "$T/bin/claude"
python3 "$HERE/fake-telegram.py" "$T/port" "$T/api.log" "$T/updates" & API=$!
for _ in $(seq 30); do [ -s "$T/port" ] && break; sleep 0.1; done
export XDG_RUNTIME_DIR="$T/rt" HOME="$T/home" CLAUDE_BUSY_CHECK=1 CLAUDE_BUSY_ASK_CHECK=1 \
    CLAUDE_BUSY_LID="$T/lid" CLAUDE_BUSY_LOCKED=0 CLAUDE_BUSY_LEDS="$T/none" \
    CLAUDE_PHONE_API="http://127.0.0.1:$(cat "$T/port")" CLAUDE_ACCOUNT_CMD="$HERE/../claude-account" \
    CLAUDE_BUSY_CMD="$BUSY"
D="$T/rt/claude-busy"
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; [ -n "$3" ] && echo "     $3"; fails=$((fails + 1)); fi; }
calls() { grep -c "\"method\": \"$1\"" "$T/api.log" 2>/dev/null || echo 0; }
last() { grep "\"method\": \"$1\"" "$T/api.log" | tail -1; }
lid() { echo "state:      $1" > "$T/lid/LID0/state"; }
helper() { [ -r "$D/.phone" ] && kill -0 "$(cat "$D/.phone")" 2>/dev/null; }
upd=0
tap() {  # tap CHAT DATA
    upd=$((upd + 1))
    echo "{\"update_id\": $upd, \"callback_query\": {\"id\": \"q$upd\", \"from\": {\"id\": $1}, \"data\": \"$2\"}}" >> "$T/updates"
}
nonce() { last sendMessage | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply_markup"]["inline_keyboard"][0][0]["callback_data"].split(":")[0])'; }

mkfifo "$T/cmds"
"$T/bin/claude" -c 'exec 3<>"$0"; while read -r line <&3; do eval "$line"; done' "$T/cmds" & FAKE=$!
sleep 0.2
REQ='"cwd":"'"$T"'/home/Projects/listr","transcript_path":"/t.jsonl","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -f pezei.py"}],"behavior":"allow","destination":"localSettings"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]'
hook() {  # hook COMMAND SESSION FIELDS [&]
    echo "\"$BUSY\" $1 <<< '{\"session_id\":\"$2\",$3}' > \"$T/out-$2\" $4" > "$T/cmds"
    sleep 0.4
}

# At the laptop: nothing goes to the phone.
hook ask s1 "$REQ" '&'
sleep 3
check "at the laptop: the helper waits, nothing sent" "helper && [ \"\$(calls sendMessage)\" = 0 ]"
# Lid closed: it goes out, as the terminal shows it.
lid closed
sleep 3
check "lid closed: sent to your chat" "[ \"\$(calls sendMessage)\" = 1 ] && last sendMessage | grep -q '\"chat_id\": 4242'"
last sendMessage > "$T/msg.json"
check "  the terminal's text, and its options as buttons" "python3 - '$T/msg.json' <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
text = m['text']
labels = [row[0]['text'] for row in m['reply_markup']['inline_keyboard']]
want = ['1. Yes', \"2. Yes, and don't ask again for rm -f pezei.py commands in ~/Projects/listr\", '3. No']
ok = all(x in text for x in ['<b>listr</b>', 'Bash command', '<pre>rm -f pezei.py</pre>', 'Delete pezei.py',
                            'Do you want to proceed?', '1. Yes', '3. No']) and labels == want
sys.exit(0 if ok else 1)
PY" "$(cat "$T/msg.json")"
# Someone else's tap, or a made-up one: ignored.
tap 999 "$(nonce):1"
tap 4242 "abcdef:1"
sleep 2
check "a tap from another chat or an old message: ignored" "[ ! -s '$T/out-s1' ] && ls '$D/ask' | grep -q '^s1\..*json$' && [ \"\$(calls answerCallbackQuery)\" = 2 ]"
# Your tap on option 2.
tap 4242 "$(nonce):2"
sleep 2
check "your tap answers Claude, with the rule" "grep -q '\"behavior\": \"allow\"' '$T/out-s1' && grep -q 'ruleContent' '$T/out-s1' && ! grep -q setMode '$T/out-s1'" "$(cat "$T/out-s1")"
check "  the message keeps the text, loses the buttons, says what you picked" "last editMessageText | grep -q '2. Yes, and don' && ! last editMessageText | grep -q reply_markup && last editMessageText | grep -q 'Bash command'"

# Answered on the laptop instead.
hook ask s2 "$REQ" '&'
sleep 3
check "another prompt: sent" "[ \"\$(calls sendMessage)\" = 2 ]"
hook busy s2 '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}'
sleep 4
check "answered on the laptop: the message says so" "last editMessageText | grep -q 'Answered on the laptop'" "$(last editMessageText)"

# The laptop going to sleep.
hook ask s3 "$REQ" '&'
sleep 3
"$HERE/../claude-account" phone sleeping
check "going to sleep: the message says so, no buttons" "last editMessageText | grep -q 'went to sleep' && ! helper" "$(last editMessageText)"
hook busy s3 '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}'

# Nothing waiting: the helper isn't running.
sleep 1
check "nothing waiting: no helper" "! helper"

# The screen locked with the lid open counts as away too.
lid open
sent=$(calls sendMessage)
echo "\"$BUSY\" ask <<< '{\"session_id\":\"s4\",$REQ}' > \"$T/out-s4\" &" | sed 's/^/CLAUDE_BUSY_LOCKED=1 /' > "$T/cmds"
sleep 4
check "screen locked: sent" "[ \"\$(calls sendMessage)\" = $((sent + 1)) ]"
hook busy s4 '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}'
sleep 3

# A question from Claude: its own choices as buttons; a tap answers it with that choice.
lid closed
QREQ='"cwd":"'"$T"'/home/Projects/listr","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which color do you prefer?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"Warm"},{"label":"Blue","description":"Calm"}]}]}'
hook ask s7 "$QREQ" '&'
sleep 3
last sendMessage > "$T/q.json"
check "a question: Claude's choices as buttons" "python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
labels = [r[0][\"text\"] for r in m[\"reply_markup\"][\"inline_keyboard\"]]
sys.exit(not (labels == [\"1. Red\", \"2. Blue\"] and \"Which color do you prefer?\" in m[\"text\"] and \"Calm\" in m[\"text\"]))' '$T/q.json'" "$(cat "$T/q.json")"
tap 4242 "$(nonce):2"
sleep 2
check "  a tap answers it with that choice" "grep -q '\"answers\": {\"Which color do you prefer?\": \"Blue\"}' '$T/out-s7'" "$(cat "$T/out-s7")"
hook idle s7 '"hook_event_name":"Stop"'

# Nobody answers with the lid closed: when the wait for you runs out (15 minutes, 3 s here) and
# the laptop is about to sleep, the message says so first.
[ -r "$D/.holder" ] && kill "$(cat "$D/.holder")" 2>/dev/null
lid closed
for s in s1 s2 s3 s4; do hook idle $s '"hook_event_name":"Stop"'; done   # those chats are done
echo "CLAUDE_BUSY_NEEDS=3 CLAUDE_BUSY_WAIT=1 \"$BUSY\" ask <<< '{\"session_id\":\"s6\",$REQ}' > \"$T/out-s6\" &" > "$T/cmds"
sleep 9
check "the wait runs out, lid closed: \"went to sleep\" before the laptop sleeps" "last editMessageText | grep -q 'went to sleep' && [ ! -r '$D/.holder' ]" "sent=$(calls sendMessage) files=$(ls -A $D | tr '\n' ' ') needs=$(ls $D/needs | tr '\n' ' ') holder=$(cat $D/.holder 2>/dev/null) out6=$(cat $T/out-s6)"
hook busy s6 '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}'
sleep 1

# Turned off: never sent.
"$HERE/../claude-account" phone off > /dev/null
lid closed
sent=$(calls sendMessage)
hook ask s5 "$REQ" '&'
sleep 3
check "turned off: nothing sent, no helper" "[ \"\$(calls sendMessage)\" = $sent ] && ! helper"
hook busy s5 '"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"rm -f pezei.py","description":"Delete pezei.py"}'
check "every call used the bot's token" "! grep -v '\"token\": \"123:abc\"' '$T/api.log' | grep -q ."
exit $fails
