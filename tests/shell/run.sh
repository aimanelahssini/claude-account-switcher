#!/bin/bash
# Runs the extension with a test driver in a throwaway headless GNOME Shell, with made-up
# accounts and usage. Settings go to a keyfile in a temp folder, never to the real dconf.
#   tests/shell/run.sh [OUT_DIR]     results.txt, screenshots and breath frames land in OUT_DIR
#   TEST_ONLY=tokens-panel run.sh    only the history panel in tokens
#   TEST_ONLY=needs run.sh           only "Claude needs you": top bar, click, notifications, lights
#   TEST_ONLY=tabs run.sh            only the row of chats under the mascot's hover text
#   TEST_ONLY=edge run.sh            only: the top bar buttons answer up to the screen edge
#   TEST_ONLY=switch run.sh          only: sliding from one account's history onto another
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UUID=claude-account-switcher@aimanelahssini
T="$(mktemp -d)"
OUT="$(mkdir -p "${1:-$T/out}" && cd "${1:-$T/out}" && pwd)"
mkdir -p "$T"/{home/.claude/accounts,config/glib-2.0/settings,data/gnome-shell/extensions,state,cache,rt}
chmod 700 "$T/rt"
cp -r "$REPO/extension/$UUID" "$HERE/claude-test@tests" "$T/data/gnome-shell/extensions/"
A="$T/home/.claude/accounts"
printf '1\n2\n' > "$A/names"
echo 1 > "$A/active"
echo '{}' > "$A/1.json"
echo '{}' > "$A/2.json"
python3 "$HERE/fake-history.py" "$A/history.jsonl"
# Stand-in ThinkPad lights, claude-busy where the extension calls it, and a chat transcript.
for led in lid_logo_dot power; do
    mkdir -p "$T/leds/tpacpi::$led"
    touch "$T/leds/tpacpi::$led/pattern" "$T/leds/tpacpi::$led/repeat"
done
install -Dm755 "$REPO/claude-busy" "$T/home/.local/bin/claude-busy"
echo '{"type":"summary","aiTitle":"Fix the poster upload"}' > "$T/home/chat.jsonl"
echo '{"spinnerVerbs": {"mode": "replace", "verbs": ["Choreographing"]}}' > "$T/home/.claude/settings.json"
RESET="$(date -u -d '+72 min' +%Y-%m-%dT%H:%M:%SZ)"
echo "{\"1\": {\"pct\": 53, \"resets_at\": \"$RESET\"}, \"2\": {\"pct\": 11, \"resets_at\": \"$RESET\"}}" > "$A/usage.cache"
cat > "$T/config/glib-2.0/settings/keyfile" <<KEYS
[org/gnome/shell]
enabled-extensions=['$UUID', 'claude-test@tests']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'
enable-hot-corners=false
clock-format='24h'
KEYS
dconf dump / > "$T/dconf-before.txt"
env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
    XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/rt" GSETTINGS_BACKEND=keyfile TEST_OUT="$OUT" TEST_ONLY="${TEST_ONLY:-}" \
    CLAUDE_BUSY_LEDS="$T/leds" TEST_WINDOW="$HERE/window.py" CLAUDE_TABS_CMD="$T/home/tabs-stub" \
    dbus-run-session -- timeout 120 gnome-shell --headless --wayland --virtual-monitor 1440x900 \
    > "$OUT/shell.log" 2>&1 || true
dconf dump / > "$T/dconf-after.txt"
if diff "$T/dconf-before.txt" "$T/dconf-after.txt" | grep -q 'enabled-extensions'; then
    echo "REAL DCONF CHANGED"
else
    echo "real dconf: unchanged"
fi
grep -E 'JS ERROR|TypeError|ReferenceError' "$OUT/shell.log" | head -5 || true
cat "$OUT/results.txt" 2>/dev/null
rm -rf "$T"
