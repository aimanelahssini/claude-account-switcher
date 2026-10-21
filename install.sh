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
