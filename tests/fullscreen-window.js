// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// A plain fullscreen window, used by the end-to-end tests. A bare Gtk.Window
// rather than a Gtk.Application, which would wait on the desktop portal.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

Gtk.init();
const loop = new GLib.MainLoop(null, false);
const win = new Gtk.Window({title: 'Fullscreen test'});
win.connect('close-request', () => loop.quit());
win.present();
win.fullscreen();
loop.run();
