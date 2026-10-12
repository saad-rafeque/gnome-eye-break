// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// Takes the README screenshots in the throwaway test shell. Run with:
//   E2E_DRIVER=tools/screenshots.js tests/run-e2e.sh /tmp/eyebreak-shots
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

const [WORK] = ARGV;
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const OUT = `${ROOT}/docs/screenshots`;
const UUID = JSON.parse(new TextDecoder().decode(
    GLib.file_get_contents(`${ROOT}/extension/metadata.json`)[1])).uuid;
const sleep = ms => GLib.usleep(ms * 1000);

function call(dest, path, iface, method, args, replyType) {
    return Gio.DBus.session.call_sync(dest, path, iface, method, args,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, 20000, null);
}

function ev(body) {
    const code = `(async () => {
        const E = Main.extensionManager.lookup('${UUID}')?.stateObj;
        ${body}
    })()`;
    const [ok, json] = call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
        new GLib.Variant('(s)', [code]), '(bs)').deepUnpack();
    if (!ok)
        throw new Error(`Eval failed: ${json}`);
    return json === '' ? undefined : JSON.parse(json);
}

function waitFor(fn, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            if (fn())
                return true;
        } catch (e) {
            // Not ready yet.
        }
        sleep(200);
    }
    throw new Error('timed out');
}

// Saves the whole screen, or the [x, y, width, height] part of it, to docs/screenshots/<name>.png.
function shot(name, crop = null) {
    const full = `${WORK}/${name}-full.png`;
    call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
        'Screenshot', new GLib.Variant('(bbs)', [false, false, full]), '(bs)');
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(full);
    if (crop) {
        const [x, y, w, h] = crop.map(Math.round);
        pixbuf = pixbuf.new_subpixbuf(x, y, Math.min(w, pixbuf.width - x), Math.min(h, pixbuf.height - y));
    }
    pixbuf.savev(`${OUT}/${name}.png`, 'png', [], []);
    print(`saved docs/screenshots/${name}.png`);
}

const source = Gio.SettingsSchemaSource.new_from_directory(
    `${WORK}/data/gnome-shell/extensions/${UUID}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.eyebreak', false)});
settings.set_double('volume', 0);
settings.set_boolean('show-panel-countdown', true);
const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
shellSettings.set_strv('enabled-extensions', [UUID, 'eyebreak-testhelper@local']);
shellSettings.set_strv('disabled-extensions', []);
const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
background.set_string('picture-options', 'none');
background.set_string('primary-color', '#33414e');
background.set_string('color-shading-type', 'solid');
Gio.Settings.sync();

GLib.mkdir_with_parents(OUT, 0o755);
const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_MERGE});
launcher.set_stdout_file_path(`${WORK}/shell.log`);
const shell = launcher.spawnv(['gnome-shell', '--headless', '--wayland', '--no-x11',
    '--wayland-display', GLib.getenv('WAYLAND_DISPLAY'), '--virtual-monitor', '1600x900']);

let status = 0;
try {
    waitFor(() => ev('return true;') === true, 30000);
    waitFor(() => ev('return Main.extensionManager.lookup(\'' + UUID + '\').state;') === 1);
    ev(`Main.overview.hide();
        for (const s of Main.messageTray.getSources())
            s.destroy();`);
    const demo = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_MERGE});
    demo.set_stdout_file_path(`${WORK}/demo.log`);
    demo.spawnv(['gjs', '-m', `${ROOT}/tools/demo-window.js`]);
    waitFor(() => ev("return global.get_window_actors().some(a => a.meta_window.get_title() === 'Notes');"));
    sleep(1500);

    ev('E._indicator.menu.open();');
    sleep(800);
    const menu = ev(`const [x, y] = E._indicator.menu.actor.get_transformed_position();
                     const [w, h] = E._indicator.menu.actor.get_transformed_size();
                     return [x, y, w, h];`);
    shot('menu', [0, 0, menu[0] + menu[2] + 40, menu[1] + menu[3] + 30]);
    ev('E._indicator.menu.close();');
    sleep(500);

    ev('E.takeBreakNow();');
    sleep(2500);
    shot('banner', [0, 0, 1600, 260]);
    ev('E.skipBreak();');
    sleep(600);

    settings.set_string('break-mode', 'fullscreen');
    Gio.Settings.sync();
    sleep(500);
    ev('E.takeBreakNow();');
    sleep(4500);
    shot('fullscreen');
    ev('E.skipBreak();');
    sleep(600);

    ev('E.setPaused(true); E._indicator.menu.open();');
    sleep(800);
    shot('paused', [0, 0, menu[0] + menu[2] + 40, menu[1] + menu[3] + 30]);
    ev('E._indicator.menu.close(); E.setPaused(false);');
    sleep(500);

    Gio.Subprocess.new(['gnome-extensions', 'prefs', UUID], Gio.SubprocessFlags.NONE);
    waitFor(() => ev("return global.get_window_actors().some(a => a.meta_window.get_title() === 'Eye Break');"));
    sleep(2000);
    const frame = ev(`const w = global.get_window_actors().find(a => a.meta_window.get_title() === 'Eye Break').meta_window;
                      const r = w.get_frame_rect();
                      return [r.x, r.y, r.width, r.height];`);
    shot('settings', [frame[0] - 24, frame[1] - 24, frame[2] + 48, frame[3] + 48]);
} catch (e) {
    print(`failed: ${e.message}\n${e.stack}`);
    status = 1;
}

shell.send_signal(15);
shell.wait(null);
System.exit(status);
