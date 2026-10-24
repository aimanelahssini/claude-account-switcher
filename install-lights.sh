#!/bin/bash
# ThinkPad lights for claude-busy, as root: lets one user drive the lid logo dot and the power
# button light through the kernel's pattern trigger, and nothing else. Run once:
#   pkexec ./install-lights.sh      (or sudo)
# Undo with uninstall-lights.sh.
set -e
cd "$(dirname "$0")"
USER_NAME=${1:-$(id -nu "${PKEXEC_UID:-${SUDO_UID:-0}}")}
GROUP=$(id -gn "$USER_NAME")
[ -d /sys/class/leds/tpacpi::lid_logo_dot ] || [ -d /sys/class/leds/tpacpi::power ] ||
    { echo "No ThinkPad lights here, nothing to do"; exit 0; }

install -Dm755 lights-setup /usr/local/libexec/claude-lights-setup
echo ledtrig-pattern > /etc/modules-load.d/claude-lights.conf
cat > /etc/udev/rules.d/90-claude-lights.rules <<RULE
# claude-account-switcher: claude-busy blinks these two ThinkPad lights (install-lights.sh)
ACTION=="add", SUBSYSTEM=="leds", KERNEL=="tpacpi::lid_logo_dot|tpacpi::power", RUN+="/usr/local/libexec/claude-lights-setup %k $GROUP"
RULE
restorecon -F /usr/local/libexec/claude-lights-setup /etc/udev/rules.d/90-claude-lights.rules \
    /etc/modules-load.d/claude-lights.conf 2>/dev/null || true
udevadm control --reload
# Through udev now, the same way as at every boot; directly if that didn't take.
udevadm trigger --action=add --subsystem-match=leds --sysname-match='tpacpi::lid_logo_dot' \
    --sysname-match='tpacpi::power' --settle 2>/dev/null || true
for led in lid_logo_dot power; do
    L=/sys/class/leds/tpacpi::$led
    [ -d "$L" ] || continue
    if [ "$(stat -c %G "$L/pattern" 2>/dev/null)" = "$GROUP" ]; then
        echo "$led: set up by udev"
    else
        /usr/local/libexec/claude-lights-setup "tpacpi::$led" "$GROUP"
        echo "$led: set up directly (udev didn't)"
    fi
done
echo "ThinkPad lights ready for $USER_NAME"
