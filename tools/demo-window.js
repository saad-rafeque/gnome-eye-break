// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// A plain document window to sit behind the README screenshots. It is a bare
// Gtk.Window rather than a Gtk.Application, which would wait on the desktop
// portal for several seconds in a fresh test session.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const TEXT = `Weekly planning

Finish the project report and share it with the team.
Review the dashboard and fix the broken chart.
Write up what we learned from Tuesday's meeting.

Keep each work block to about twenty minutes, then look out of the window.`;

Gtk.init();
const loop = new GLib.MainLoop(null, false);
const win = new Gtk.Window({title: 'Notes', default_width: 1100, default_height: 640});
const view = new Gtk.TextView({
    editable: false,
    wrap_mode: Gtk.WrapMode.WORD,
    left_margin: 48,
    right_margin: 48,
    top_margin: 40,
});
view.buffer.text = TEXT;
win.set_child(view);
win.connect('close-request', () => loop.quit());
win.present();
loop.run();
