#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Saad Rafique
# Installs Eye Break for the current user. No sudo needed.
#
#   ./install.sh               install, or update an existing install
#   ./install.sh --uninstall   remove it
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/extension"
UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$SRC/metadata.json")
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
UUID_RE=${UUID//./\\.}

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "${DEST:?}"
    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    gsettings set org.gnome.shell enabled-extensions \
        "$(sed -e "s/'$UUID_RE', //; s/, '$UUID_RE'//; s/'$UUID_RE'//" <<< "$enabled")"
    echo "Eye Break removed. Your settings are kept; to clear them too, run:"
    echo "  dconf reset -f /org/gnome/shell/extensions/eyebreak/"
    exit 0
fi

if ! command -v gnome-shell > /dev/null; then
    echo "GNOME Shell isn't installed, and Eye Break is a GNOME Shell extension." >&2
    exit 1
fi
version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [[ "$version" != 46 ]]; then
    echo "Note: Eye Break is made for GNOME 46 and you have GNOME $version." >&2
    echo "GNOME may refuse to load it, or parts may not work." >&2
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "${DEST:?}"
cp -r "$SRC" "$DEST"
rm -f "$DEST/schemas/gschemas.compiled"
glib-compile-schemas "$DEST/schemas"

# Add it to the enabled list, so GNOME turns it on at the next login and every login after.
enabled=$(gsettings get org.gnome.shell enabled-extensions)
if [[ "$enabled" != *"'$UUID'"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        enabled="['$UUID']"
    else
        enabled="${enabled%]}, '$UUID']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$enabled"
fi

if [[ "$(gsettings get org.gnome.shell disable-user-extensions)" == "true" ]]; then
    echo "Note: user extensions are switched off. Turn them on in the Extensions app."
fi

echo "Eye Break is installed in $DEST"
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    echo "Press Alt+F2, type r and press Enter to restart GNOME Shell and start it."
else
    echo "Log out and back in to start it (GNOME on Wayland only loads extensions at login)."
fi
