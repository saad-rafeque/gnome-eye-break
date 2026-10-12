#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Saad Rafique
# Builds the zip for extensions.gnome.org (and GitHub releases) into dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/extension"
mkdir -p "$ROOT/dist"
rm -f "$ROOT"/dist/*.shell-extension.zip
gnome-extensions pack . --force --out-dir="$ROOT/dist" \
    --extra-source=cycle.js \
    --extra-source=indicator.js \
    --extra-source=sound.js \
    --extra-source=ui.js \
    --extra-source=icons \
    --extra-source=sounds

ZIP=$(ls "$ROOT"/dist/*.shell-extension.zip)
# GNOME 44 and later compile schemas themselves; the store asks for the source only.
zip -q -d "$ZIP" 'schemas/gschemas.compiled' > /dev/null 2>&1 || true
echo "Built $ZIP"
unzip -l "$ZIP"
