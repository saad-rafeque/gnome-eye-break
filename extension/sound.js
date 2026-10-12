// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// Plays the bundled chimes. Shared by the extension and the preferences
// window, so it must not import anything that only exists inside the shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CHIMES = [
    ['bell', 'Soft bell'],
    ['wood', 'Wood block'],
    ['glass', 'Glass'],
];

/**
 * @param {Gio.File} extensionDir - the extension's install directory
 * @param {string} chime - one of the CHIMES ids
 * @param {'start'|'end'} which - break start or break end
 * @param {number} volume - 0 to 1
 */
export function playChime(extensionDir, chime, which, volume) {
    const file = extensionDir.get_child('sounds').get_child(`${chime}-${which}.ogg`);
    const path = file.get_path();

    // pw-play and paplay let us set the volume; the shell's sound player can't.
    let argv = null;
    if (GLib.find_program_in_path('pw-play'))
        argv = ['pw-play', `--volume=${volume.toFixed(2)}`, path];
    else if (GLib.find_program_in_path('paplay'))
        argv = ['paplay', `--volume=${Math.round(volume * 65536)}`, path];

    if (argv) {
        try {
            Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            return;
        } catch (e) {
            console.warn(`Eye Break: ${argv[0]} failed: ${e.message}`);
        }
    }

    // `global` only exists inside the shell, not in the preferences window.
    globalThis.global?.display.get_sound_player().play_from_file(file, 'Eye Break', null);
}
