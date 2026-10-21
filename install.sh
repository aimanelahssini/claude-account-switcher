#!/bin/bash
# Install claude-account + the GNOME top-bar extension.
#   git clone https://github.com/aimanelahssini/claude-account-switcher && cd claude-account-switcher && ./install.sh
set -e
cd "$(dirname "$0")"
UUID=claude-account-switcher@aimanelahssini

install -Dm755 claude-account ~/.local/bin/claude-account
if command -v gnome-shell >/dev/null; then
    mkdir -p ~/.local/share/gnome-shell/extensions
    rm -rf ~/.local/share/gnome-shell/extensions/$UUID
    cp -r extension/$UUID ~/.local/share/gnome-shell/extensions/
    gnome-extensions enable $UUID 2>/dev/null || python3 - "$UUID" <<'PY'
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
cat <<'MSG'

Two accounts are set up: 1 and 2. If Claude Code was already logged in, that login is
account 1. Click an account that says "sign in" in the top bar to sign in to it
(or run: claude-account add 2 --private).
MSG
