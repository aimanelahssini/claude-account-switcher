#!/bin/bash
# Remove claude-account, claude-busy, their Claude Code hooks and the top-bar extension.
# Saved logins in ~/.claude/accounts stay; delete that folder yourself to forget them too.
set -e
UUID=claude-account-switcher@aimanelahssini

if command -v gsettings >/dev/null; then
    python3 - "$UUID" <<'PY'
import ast, subprocess, sys
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True)
l = [u for u in ast.literal_eval(cur.replace('@as ', '')) if u != sys.argv[1]]
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(l)], check=True)
PY
fi
rm -rf ~/.local/share/gnome-shell/extensions/$UUID
rm -f ~/.local/bin/claude-account ~/.local/bin/claude-busy ~/.local/bin/claude-tabs
# Only the claude-busy hooks; every other setting and hook stays.
python3 - <<'PY'
import json, os
path = os.path.expanduser('~/.claude/settings.json')
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    raise SystemExit
hooks = settings.get('hooks', {})
for event in list(hooks):
    hooks[event] = [g for g in hooks[event] if not any('claude-busy' in h.get('command', '') for h in g.get('hooks', []))]
    if not hooks[event]:
        del hooks[event]
if not hooks:
    settings.pop('hooks', None)
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
echo "Removed. Your saved accounts are still in ~/.claude/accounts."
