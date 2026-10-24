#!/bin/bash
# Install claude-account + the GNOME top-bar extension.
#   git clone https://github.com/aimanelahssini/claude-account-switcher && cd claude-account-switcher && ./install.sh
set -e
cd "$(dirname "$0")"
UUID=claude-account-switcher@aimanelahssini

install -Dm755 claude-account ~/.local/bin/claude-account
install -Dm755 claude-busy ~/.local/bin/claude-busy
install -Dm755 claude-tabs ~/.local/bin/claude-tabs
# Claude Code hooks that tell claude-busy when a session works and when it's done. Replaces
# earlier claude-busy hooks and leaves every other setting and hook as it is.
python3 - <<'PY'
import json, os
path = os.path.expanduser('~/.claude/settings.json')
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
hooks = settings.setdefault('hooks', {})
for event in list(hooks):
    hooks[event] = [g for g in hooks[event] if not any('claude-busy' in h.get('command', '') for h in g.get('hooks', []))]
    if not hooks[event]:
        del hooks[event]
def add(event, arg, matcher=None, timeout=None):
    hook = {'type': 'command', 'command': f'~/.local/bin/claude-busy {arg}'}
    if timeout:
        hook['timeout'] = timeout
    group = {'hooks': [hook]}
    if matcher:
        group['matcher'] = matcher
    hooks.setdefault(event, []).append(group)
for event in ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied',
              'PreCompact', 'SubagentStart']:
    add(event, 'busy')
for event in ['Stop', 'StopFailure', 'SessionEnd']:
    add(event, 'idle')
add('Notification', 'idle', 'idle_prompt')  # waiting for you (also after you stop it with Esc)
add('Notification', 'needs', 'permission_prompt|elicitation_dialog')  # a prompt or question
# A permission prompt, also offered as a notification; it waits (without CPU) for an answer
# there until you answer in the terminal, so its time limit is a day.
add('PermissionRequest', 'ask', timeout=86400)
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
if command -v gnome-shell >/dev/null; then
    mkdir -p ~/.local/share/gnome-shell/extensions
    rm -rf ~/.local/share/gnome-shell/extensions/$UUID
    cp -r extension/$UUID ~/.local/share/gnome-shell/extensions/
    # Only add to GNOME's enabled list. (gnome-extensions enable can rewrite the list from the
    # running shell's view and drop other extensions.)
    python3 - "$UUID" <<'PY'
import ast, subprocess, sys
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True)
l = ast.literal_eval(cur.replace('@as ', ''))
if sys.argv[1] not in l:
    l.append(sys.argv[1])
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(l)], check=True)
PY
    echo "Extension installed. Log out and back in once so GNOME loads it."
fi
~/.local/bin/claude-account init
