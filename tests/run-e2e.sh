#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Saad Rafique
# Runs the end-to-end tests in a throwaway headless GNOME Shell. Your real
# session is never touched: settings, extensions and the display are private,
# and every process the test starts is stopped at the end.
# Usage: tests/run-e2e.sh [work-dir] [monitor-count]
# Set E2E_DRIVER to run another driver script in the same sandbox
# (tools/screenshots.js uses this).
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${1:-$(mktemp -d)}
MONITORS=${2:-1}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
DISPLAY_NAME=eyebreak-e2e-$$
UNIT=eyebreak-e2e-$$
EXTS="$WORK/data/gnome-shell/extensions"
UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$ROOT/extension/metadata.json")

rm -rf "${WORK:?}/data" "${WORK:?}/config" "${WORK:?}/cache" "${WORK:?}/bin" "${WORK:?}"/*.png "${WORK:?}"/*.log
mkdir -p "$EXTS/eyebreak-testhelper@local" "$WORK/config" "$WORK/cache" "$WORK/bin"
cp -r "$ROOT/extension" "$EXTS/$UUID"
rm -f "$EXTS/$UUID/schemas/gschemas.compiled"
glib-compile-schemas "$EXTS/$UUID/schemas"

# Unsafe mode lets the test drive the shell through org.gnome.Shell.Eval.
cat > "$EXTS/eyebreak-testhelper@local/metadata.json" <<'EOF'
{"uuid": "eyebreak-testhelper@local", "name": "Test helper", "description": "Unsafe mode for tests", "shell-version": ["46"]}
EOF
cat > "$EXTS/eyebreak-testhelper@local/extension.js" <<'EOF'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class TestHelper extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
EOF

# Stand-ins on PATH:
# - ibus-daemon outlives the test shell and spins once orphaned, so skip it.
# - pw-play records each chime it is asked to play, then plays it for real.
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/ibus-daemon"
cat > "$WORK/bin/pw-play" <<EOF
#!/bin/sh
echo "\$@" >> "$WORK/chimes.log"
exec /usr/bin/pw-play "\$@"
EOF
chmod +x "$WORK/bin/ibus-daemon" "$WORK/bin/pw-play"
: > "$WORK/chimes.log"

export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache"
export WAYLAND_DISPLAY=$DISPLAY_NAME PATH="$WORK/bin:$PATH"
unset DISPLAY

# A scope of its own, so everything started inside can be stopped afterwards.
systemd-run --user --scope --quiet --unit="$UNIT" -- \
    dbus-run-session -- gjs -m "${E2E_DRIVER:-$ROOT/tests/e2e.js}" "$WORK" "$MONITORS" 2> "$WORK/bus.log"
status=$?

systemctl --user stop "$UNIT.scope" 2>/dev/null
for pid in $(pgrep -u "$(id -u)"); do
    if { tr '\0' '\n' < "/proc/$pid/environ"; } 2>/dev/null | grep -qx "WAYLAND_DISPLAY=$DISPLAY_NAME"; then
        echo "stopping leftover process $pid: $(tr '\0' ' ' < "/proc/$pid/cmdline")"
        kill "$pid" 2>/dev/null
    fi
done
exit $status
