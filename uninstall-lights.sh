#!/bin/bash
# Undo install-lights.sh, as root: the two lights go back to the laptop's own control.
rm -f /etc/udev/rules.d/90-claude-lights.rules /etc/modules-load.d/claude-lights.conf \
    /usr/local/libexec/claude-lights-setup
udevadm control --reload 2>/dev/null
for led in lid_logo_dot power; do
    L=/sys/class/leds/tpacpi::$led
    [ -d "$L" ] || continue
    echo none > "$L/trigger"
    echo 255 > "$L/brightness"
done
true
