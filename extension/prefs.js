// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// The settings window, opened from the top bar menu or the Extensions app.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CHIMES, playChime} from './sound.js';

const MODES = [
    ['banner', 'Banner'],
    ['fullscreen', 'Fullscreen'],
];

export default class EyeBreakPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 760);
        // Handlers on `settings` that touch widgets must go when the window does.
        const handlerIds = [];
        window.connect('close-request', () => handlerIds.forEach(id => settings.disconnect(id)));

        const page = new Adw.PreferencesPage();
        window.add(page);

        const timing = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'The 20-20-20 rule: every 20 minutes, look at something 20 feet away for 20 seconds.',
        });
        timing.add(spinRow(settings, 'work-interval', 'Time between breaks', 'Minutes', 60, 1, 120));
        timing.add(spinRow(settings, 'break-duration', 'Break length', 'Seconds', 1, 5, 300));
        timing.add(spinRow(settings, 'snooze-duration', 'Snooze length', 'Minutes', 60, 1, 30));
        page.add(timing);

        const look = new Adw.PreferencesGroup({
            title: 'Reminders',
            description: 'Banner shows a bar at the top of the screen. Fullscreen covers the screen.',
        });
        look.add(comboRow(settings, 'break-mode', 'Break style', null, MODES, handlerIds));
        look.add(switchRow(settings, 'show-panel-countdown', 'Countdown in top bar',
            'Show the minutes left next to the icon'));
        page.add(look);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(switchRow(settings, 'hold-during-fullscreen', 'Wait for fullscreen apps',
            'Hold the break until videos, games or presentations leave fullscreen'));
        behaviour.add(switchRow(settings, 'allow-skip', 'Allow skip and snooze',
            'Turn off to make every break run its full length'));
        behaviour.add(new Adw.ActionRow({
            title: 'Starts at login',
            subtitle: 'Eye Break runs whenever the extension is on. Locking the screen, sleeping or logging out starts a fresh cycle.',
        }));
        page.add(behaviour);

        const sound = new Adw.PreferencesGroup({title: 'Sound'});
        sound.add(switchRow(settings, 'play-sounds', 'Chimes',
            'Play a chime when a break starts and when it ends'));

        const chimeRow = comboRow(settings, 'chime', 'Chime sound', null, CHIMES, handlerIds);
        const preview = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            tooltip_text: 'Play',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        preview.connect('clicked', () => playChime(this.dir, settings.get_string('chime'), 'start',
            settings.get_double('volume')));
        chimeRow.add_suffix(preview);
        sound.add(chimeRow);

        const volumeRow = new Adw.ActionRow({title: 'Volume'});
        const volume = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1, step_increment: 0.05, page_increment: 0.1}),
            draw_value: false,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200,
        });
        settings.bind('volume', volume.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        volumeRow.add_suffix(volume);
        sound.add(volumeRow);

        for (const row of [chimeRow, volumeRow])
            settings.bind('play-sounds', row, 'sensitive', Gio.SettingsBindFlags.GET);
        page.add(sound);
    }
}

// The setting is stored in seconds; `unit` converts it to what the row shows.
function spinRow(settings, key, title, subtitle, unit, min, max) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 5}),
    });
    row.value = Math.round(settings.get_uint(key) / unit);
    row.connect('notify::value', () => settings.set_uint(key, Math.round(row.value) * unit));
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// A dropdown for a string setting. `choices` is a list of [value, label] pairs.
function comboRow(settings, key, title, subtitle, choices, handlerIds) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    if (subtitle)
        row.subtitle = subtitle;

    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    // The break style can also change from the top bar menu.
    handlerIds.push(settings.connect(`changed::${key}`, sync));
    row.connect('notify::selected', () => {
        const value = choices[row.selected][0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}
