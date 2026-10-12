// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// End-to-end tests for Eye Break, run by run-e2e.sh inside a throwaway
// headless GNOME Shell. Drives the shell over D-Bus (Eval and Screenshot)
// and uses virtual mouse and keyboard devices for real input.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [WORK, MONITORS = '1'] = ARGV;
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const METADATA = `${GLib.path_get_dirname(HERE)}/extension/metadata.json`;
const UUID = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(METADATA)[1])).uuid;
const EXT_DIR = `${WORK}/data/gnome-shell/extensions/${UUID}`;
const ACTIVE = 1;
const FULL = MONITORS === '1';
// E2E_QUICK=1 skips the slow resource measurements.
const QUICK = GLib.getenv('E2E_QUICK') === '1';

let passes = 0;
let failures = 0;
function check(name, ok, detail = '') {
    if (ok) {
        passes++;
        print(`ok   ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}${detail === '' ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    }
}
const section = title => print(`\n== ${title}`);
const sleep = ms => GLib.usleep(ms * 1000);
const near = (value, target, slack = 2) => typeof value === 'number' && Math.abs(value - target) <= slack;

function call(dest, path, iface, method, args, replyType, timeout = 20000) {
    return Gio.DBus.session.call_sync(dest, path, iface, method, args,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, timeout, null);
}

// Runs `body` inside the shell. `E` is the extension object, `now` is
// monotonic milliseconds, `find` searches an actor tree.
function ev(body) {
    const code = `(async () => {
        const Clutter = imports.gi.Clutter;
        const St = imports.gi.St;
        const ext = Main.extensionManager.lookup('${UUID}');
        const E = ext?.stateObj;
        const now = GLib.get_monotonic_time() / 1000;
        const find = (root, pred) => {
            if (pred(root))
                return root;
            for (const child of root.get_children()) {
                const hit = find(child, pred);
                if (hit)
                    return hit;
            }
            return null;
        };
        ${body}
    })()`;
    const [ok, json] = call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
        new GLib.Variant('(s)', [code]), '(bs)').deepUnpack();
    if (!ok)
        throw new Error(`Eval failed: ${json}`);
    return json === '' ? undefined : JSON.parse(json);
}

function waitFor(fn, timeoutMs = 10000, interval = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            const value = fn();
            if (value)
                return value;
        } catch (e) {
            // Not ready yet.
        }
        sleep(interval);
    }
    return null;
}

const STATE = `
    const ui = E._breakUi;
    const ours = a => [a, ...a.get_children()].some(c => (c.style_class ?? '').includes('eyebreak'));
    const grabbed = global.stage.get_grab_actor();
    return {
        extState: ext.state,
        phase: E._cycle?.phase ?? null,
        rem: E._cycle ? Math.round(E._cycle.remaining(now) / 1000) : null,
        ui: ui ? ui.constructor.name : null,
        grab: grabbed ? (ui && ui.actor.contains(grabbed) ? 'ours' : 'other') : null,
        paused: E._paused,
        label: E._indicator ? (E._indicator._label.visible ? E._indicator._label.text : '') : null,
        indicator: Object.keys(Main.panel.statusArea).filter(k => k === '${UUID}').length,
        actors: Main.layoutManager.uiGroup.get_children().filter(ours).length,
    };`;
const state = () => ev(STATE);

const source = Gio.SettingsSchemaSource.new_from_directory(`${EXT_DIR}/schemas`,
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.eyebreak', false)});

// Writes a setting and gives the shell a moment to see it.
function set(key, value) {
    const type = settings.get_value(key).get_type_string();
    settings.set_value(key, new GLib.Variant(type, value));
    Gio.Settings.sync();
    sleep(400);
}

function screenshot(name) {
    call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
        'Screenshot', new GLib.Variant('(bbs)', [false, false, `${WORK}/${name}.png`]), '(bs)');
}

function click(label) {
    const result = ev(`
        const button = E._breakUi && find(E._breakUi.actor, a => a instanceof St.Button && a.label === '${label}');
        if (!button)
            return 'no button';
        const [x, y] = button.get_transformed_position();
        const [w, h] = button.get_transformed_size();
        const seat = Clutter.get_default_backend().get_default_seat();
        globalThis.__ebPointer ??= seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const t = GLib.get_monotonic_time();
        globalThis.__ebPointer.notify_absolute_motion(t, x + w / 2, y + h / 2);
        globalThis.__ebPointer.notify_button(t + 10, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        globalThis.__ebPointer.notify_button(t + 20, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        return 'clicked';`);
    sleep(500);
    return result;
}

function pressEscape() {
    ev(`
        const seat = Clutter.get_default_backend().get_default_seat();
        globalThis.__ebKeyboard ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const t = GLib.get_monotonic_time();
        globalThis.__ebKeyboard.notify_keyval(t, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        globalThis.__ebKeyboard.notify_keyval(t + 10, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);`);
    sleep(500);
}

const breakNow = () => {
    ev("E._indicator._breakNowItem.activate(null);");
    sleep(600);
};
const restartCycle = () => ev('E._resetAfterAbsence();');
const togglePause = () => ev('E._indicator._pauseItem.toggle();');
const chimes = () => new TextDecoder().decode(GLib.file_get_contents(`${WORK}/chimes.log`)[1]);

function cpuTicks(pid) {
    const stat = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
}

function countPaints(ms) {
    ev(`globalThis.__ebPaints = 0;
        globalThis.__ebPaintId = global.stage.connect('after-paint', () => globalThis.__ebPaints++);`);
    sleep(ms);
    return ev('global.stage.disconnect(globalThis.__ebPaintId); return globalThis.__ebPaints;');
}

function spawn(argv) {
    return Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
}

// Problems in a log that point at Eye Break: JS errors and warnings, our own
// messages, and criticals with our code on the stack trace that follows them.
// Criticals from GNOME's own code are listed separately.
function logProblems(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    const lines = ok ? new TextDecoder().decode(bytes).split('\n') : [];
    const ours = [];
    const gnome = [];
    lines.forEach((line, i) => {
        if (line.includes('Activating service') || line.includes('Successfully activated') ||
            line.includes('Wayland display name'))
            return;
        const stack = lines.slice(i + 1, i + 10).join('\n');
        if (/JS ERROR|JS WARNING|Eye Break|eyebreak/.test(line))
            ours.push(line);
        else if (/-CRITICAL/.test(line))
            (stack.includes(UUID) ? ours : gnome).push(line);
    });
    return {ours, gnome};
}

// ---------------------------------------------------------------------------

const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
shellSettings.set_strv('enabled-extensions', [UUID, 'eyebreak-testhelper@local']);
shellSettings.set_strv('disabled-extensions', []);
shellSettings.set_boolean('disable-user-extensions', false);
settings.set_double('volume', 0);
Gio.Settings.sync();

const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_MERGE});
launcher.set_stdout_file_path(`${WORK}/shell.log`);
const shellArgv = ['gnome-shell', '--headless', '--wayland', '--no-x11',
    '--wayland-display', GLib.getenv('WAYLAND_DISPLAY'), '--virtual-monitor', '1536x864'];
if (!FULL)
    shellArgv.push('--virtual-monitor', '1280x720');
const shell = launcher.spawnv(shellArgv);
const shellPid = Number(shell.get_identifier());

try {
    section('Startup');
    check('shell answers', waitFor(() => ev('return true;') === true, 30000));
    check('extension active', waitFor(() => ev('return ext.state;') === ACTIVE, 10000));
    ev(`Main.overview.hide();
        for (const source of Main.messageTray.getSources())
            source.destroy();`);
    sleep(1500);
    let s = state();
    check('indicator in top bar once', s.indicator === 1, s);
    check('indicator sits on the left of the top bar', ev('return Main.panel._leftBox.contains(E._indicator);'));
    check('starts in a work interval', s.phase === 'work' && near(s.rem, 1200, 5), s);
    check('no countdown label by default', s.label === '', s);
    check('nothing on screen between breaks', s.actors === 0, s);
    check('no input grab', s.grab === null, s);

    if (FULL && !QUICK) {
        section('Resource use');
        const paints = countPaints(10000);
        // A few frames come from GNOME itself (it drew more with Eye Break off).
        check(`no redraws of our own between breaks (${paints} frames in 10 s)`, paints <= 3, paints);

        ev(`Main.extensionManager.disableExtension('${UUID}');`);
        sleep(10000);
        const basePaints = countPaints(10000);
        const cpuOff0 = cpuTicks(shellPid);
        sleep(30000);
        const cpuOff = cpuTicks(shellPid) - cpuOff0;
        ev(`Main.extensionManager.enableExtension('${UUID}');`);
        check('re-enabled', waitFor(() => ev('return ext.state;') === ACTIVE));
        sleep(3000);
        const cpuOn0 = cpuTicks(shellPid);
        sleep(30000);
        const cpuOn = cpuTicks(shellPid) - cpuOn0;
        const tickMs = ev(`
            const t0 = GLib.get_monotonic_time();
            for (let i = 0; i < 1000; i++)
                E._tick();
            return (GLib.get_monotonic_time() - t0) / 1000 / 1000;`);
        print(`     one timer tick costs ${tickMs.toFixed(3)} ms`);
        check('a timer tick is cheap (under 0.2 ms)', tickMs < 0.2, tickMs);
        print(`     shell CPU over 30 s: ${cpuOn * 10} ms with Eye Break, ${cpuOff * 10} ms without`);
        print(`     redraws over 10 s: ${paints} with Eye Break, ${basePaints} without`);
        check('Eye Break adds under 0.5% CPU', (cpuOn - cpuOff) * 10 < 150, {cpuOn, cpuOff});
        const rss = ev("return Number(new TextDecoder().decode(GLib.file_get_contents('/proc/self/statm')[1]).split(' ')[1]) * 4;");
        print(`     shell memory (RSS): ${Math.round(rss / 1024)} MB`);
    }

    section('Banner break, start to finish');
    set('work-interval', 5);
    set('break-duration', 6);
    check('break starts on time', waitFor(() => state().phase === 'break', 8000));
    sleep(300);
    s = state();
    check('banner shown', s.ui === 'BreakBanner', s);
    check('banner does not grab input', s.grab === null, s);
    check('start chime played', waitFor(() => chimes().includes('bell-start.ogg'), 2000), chimes());
    check('chime uses the volume setting', chimes().includes('--volume=0.00'), chimes());
    const counts = [];
    for (let i = 0; i < 18; i++) {
        const text = ev('return E._breakUi?._count.text ?? null;');
        if (text && counts.at(-1) !== text)
            counts.push(text);
        sleep(200);
    }
    const secs = counts.map(t => Number(t.split(':')[1]));
    check(`countdown ticks down one second at a time (${counts.join(' ')})`,
        secs.length >= 3 && secs.every((v, i) => i === 0 || secs[i - 1] - v === 1), counts);
    screenshot('banner');
    check('break ends on time', waitFor(() => state().phase === 'work', 6000));
    sleep(600);
    s = state();
    check('banner removed', s.ui === null && s.actors === 0, s);
    check('next interval scheduled', near(s.rem, 5, 1), s);
    check('end chime played', waitFor(() => chimes().includes('bell-end.ogg'), 2000), chimes());
    set('work-interval', 1200);
    set('break-duration', 20);

    section('Banner buttons (real clicks)');
    breakNow();
    check('Take a break now opens a banner', state().ui === 'BreakBanner');
    const drain = [];
    for (let i = 0; i < 4; i++) {
        drain.push(ev(`
            const bar = find(E._breakUi.actor, a => a.style_class === 'eyebreak-banner-bar');
            return {left: E._cycle.remaining(now) / E._cycle.breakMs,
                    bar: bar.width / Main.layoutManager.primaryMonitor.width};`));
        sleep(1000);
    }
    check(`drain bar matches the time left (${drain.map(d => `${d.bar.toFixed(2)}/${d.left.toFixed(2)}`).join(' ')})`,
        drain.every(d => Math.abs(d.bar - d.left) < 0.05), drain);
    check('click Skip', click('Skip') === 'clicked');
    s = state();
    check('Skip starts a fresh 20 minutes', s.phase === 'work' && near(s.rem, 1200) && s.ui === null, s);
    breakNow();
    check('click Snooze', click('Snooze 5 min') === 'clicked');
    s = state();
    check('Snooze puts the break off 5 minutes', s.phase === 'work' && near(s.rem, 300), s);
    restartCycle();

    section('Menu');
    ev("E._indicator._modeItems.fullscreen.activate(null);");
    sleep(400);
    check('menu switches to fullscreen mode',
        ev("return E._settings.get_string('break-mode') === 'fullscreen' && E._indicator._modeItems.fullscreen._ornament === 1;"));
    check('status line updates when the menu opens',
        ev("E._indicator.menu.open(); const t = E._indicator._status.label.text; E._indicator.menu.close(); return t;")
            .match(/^Next break in (19|20):\d\d$/));

    section('Fullscreen break');
    breakNow();
    s = state();
    check('overlay shown', s.ui === 'BreakOverlay', s);
    check('overlay holds the input grab', s.grab === 'ours', s);
    const cover = ev(`
        const backdrops = E._breakUi.actor.get_children();
        const monitors = Main.layoutManager.monitors;
        return backdrops.length === monitors.length && monitors.every((m, i) =>
            backdrops[i].x === m.x && backdrops[i].y === m.y &&
            backdrops[i].width === m.width && backdrops[i].height === m.height);`);
    check(`overlay covers all ${MONITORS} monitor(s) exactly`, cover);
    check('clicks cannot reach windows underneath', ev(`
        const p = Main.layoutManager.primaryMonitor;
        return E._breakUi.actor.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, p.x + 20, p.y + p.height - 20));`));
    screenshot('overlay');
    pressEscape();
    s = state();
    check('Esc skips the break', s.phase === 'work' && near(s.rem, 1200) && s.ui === null, s);
    check('input grab released', s.grab === null, s);
    sleep(400);
    check('overlay removed', state().actors === 0);
    breakNow();
    click('Snooze 5 min');
    s = state();
    check('overlay Snooze works', s.phase === 'work' && near(s.rem, 300) && s.grab === null, s);
    restartCycle();
    set('break-duration', 3);
    breakNow();
    check('overlay ends by itself', waitFor(() => state().phase === 'work', 5000));
    sleep(500);
    s = state();
    check('grab released after natural end', s.grab === null && s.actors === 0, s);

    if (!FULL) {
        section('Second monitor');
        breakNow();
        ev("E._indicator._modeItems.banner.activate(null);");
        ev('E.skipBreak();');
        breakNow();
        check('banner stays on the primary monitor', ev(`
            const p = Main.layoutManager.primaryMonitor;
            const a = E._breakUi.actor;
            return E._breakUi.constructor.name === 'BreakBanner' && a.x === p.x && a.width === p.width;`));
        ev('E.skipBreak();');
    }

    if (FULL) {
        section('No-skip mode');
        set('allow-skip', false);
        breakNow();
        check('no buttons offered', ev("return find(E._breakUi.actor, a => a instanceof St.Button) === null;"));
        pressEscape();
        check('Esc does not skip', state().phase === 'break');
        check('break still ends by itself', waitFor(() => state().phase === 'work', 5000));
        sleep(500);
        check('grab released', state().grab === null);
        set('break-mode', 'banner');
        breakNow();
        check('banner has no buttons either', ev("return find(E._breakUi.actor, a => a instanceof St.Button) === null;"));
        waitFor(() => state().phase === 'work', 5000);
        set('allow-skip', true);
        set('break-duration', 20);
        set('break-mode', 'fullscreen');

        section('Pause');
        togglePause();
        s = state();
        check('pause stops the cycle', s.paused && s.phase === 'paused', s);
        check('paused icon shown', ev('return E._indicator._icon.gicon === E.icons.paused;'));
        check('Take a break now disabled while paused', ev('return !E._indicator._breakNowItem.getSensitive();'));
        set('work-interval', 5);
        sleep(6500);
        check('no break while paused', state().phase === 'paused');
        togglePause();
        s = state();
        check('resume gives a fresh cycle', !s.paused && s.phase === 'work' && near(s.rem, 5, 1), s);
        set('work-interval', 1200);
        breakNow();
        togglePause();
        s = state();
        check('pausing during a break closes it', s.phase === 'paused' && s.ui === null && s.grab === null, s);
        togglePause();

        section('Lock screen');
        togglePause();
        ev('Main.screenShield.lock(false);');
        check('locking turns the extension off', waitFor(() => ev('return ext.state;') !== ACTIVE, 8000));
        sleep(1200);
        s = ev(`const ours = a => [a, ...a.get_children()].some(c => (c.style_class ?? '').includes('eyebreak'));
                return {actors: Main.layoutManager.uiGroup.get_children().filter(ours)
                            .map(a => [a, ...a.get_children()].map(c => c.style_class).join('+')),
                        indicator: !!Main.panel.statusArea['${UUID}']};`);
        check('nothing left on screen while locked', s.actors.length === 0 && !s.indicator, s);
        ev('Main.screenShield.deactivate(false);');
        check('unlocking turns it back on', waitFor(() => ev('return ext.state;') === ACTIVE, 8000));
        sleep(500);
        check('a manual pause survives a lock', state().paused === true);
        togglePause();
        breakNow();
        ev('Main.screenShield.lock(false);');
        waitFor(() => ev('return ext.state;') !== ACTIVE, 8000);
        check('lock during a fullscreen break drops our grab',
            ev(`const g = global.stage.get_grab_actor();
                return !g || !(g.style_class ?? '').includes('eyebreak');`));
        ev('Main.screenShield.deactivate(false);');
        waitFor(() => ev('return ext.state;') === ACTIVE, 8000);
        sleep(800);
        s = state();
        check('unlock gives a fresh 20 minutes', s.phase === 'work' && near(s.rem, 1200) && s.ui === null, s);
        check('no grab left after unlock', s.grab === null, s);

        section('Sleep');
        ev('E._cycle.restart(now - 600000);');
        ev('E._onPrepareForSleep(true);');
        sleep(2500);
        check('going to sleep pauses the cycle', state().phase === 'paused');
        ev('E._onPrepareForSleep(false);');
        s = state();
        check('waking up gives a fresh 20 minutes', s.phase === 'work' && near(s.rem, 1200), s);
        breakNow();
        ev('E._onPrepareForSleep(true);');
        s = state();
        check('sleep during a break closes it and releases input', s.ui === null && s.grab === null, s);
        ev('E._onPrepareForSleep(false);');
        ev('E._onPrepareForSleep(true); E._awayAt = now - 61000;');
        check('missed wake-up signal recovers by itself', waitFor(() => state().phase === 'work', 3000));
        ev('E._cycle.restart(now - 600000); E._lastWallUs -= 120 * 1e6;');
        sleep(2000);
        check('a jump in wall-clock time (suspend) resets the cycle', near(state().rem, 1200));

        section('Fullscreen apps');
        let win = spawn(['gjs', '-m', `${HERE}/fullscreen-window.js`]);
        check('test window goes fullscreen',
            waitFor(() => ev('return Main.layoutManager.monitors.some(m => m.inFullscreen);'), 8000));
        set('work-interval', 5);
        check('break is held while fullscreen', waitFor(() => state().phase === 'held', 8000));
        check('nothing shown while held', state().ui === null);
        win.force_exit();
        check('break starts when fullscreen ends', waitFor(() => state().phase === 'break', 5000));
        ev('E.skipBreak();');
        set('hold-during-fullscreen', false);
        set('break-mode', 'banner');
        win = spawn(['gjs', '-m', `${HERE}/fullscreen-window.js`]);
        waitFor(() => ev('return Main.layoutManager.monitors.some(m => m.inFullscreen);'), 8000);
        restartCycle();
        check('with hold off, the break starts anyway', waitFor(() => state().phase === 'break', 8000));
        sleep(500);
        check('banner is visible over the fullscreen app', ev('return E._breakUi.actor.mapped && E._breakUi.actor.opacity === 255;'));
        screenshot('banner-over-fullscreen');
        ev('E.skipBreak();');
        win.force_exit();
        set('hold-during-fullscreen', true);
        set('work-interval', 1200);
        sleep(1000);

        section('Live settings');
        set('show-panel-countdown', true);
        check('top bar countdown shows minutes', state().label === '20m', state());
        breakNow();
        check('top bar countdown shows seconds in a break', /^\d+s$/.test(state().label), state());
        set('break-mode', 'fullscreen');
        check('changing mode mid-break keeps the current banner', state().ui === 'BreakBanner');
        ev('E.skipBreak();');
        set('show-panel-countdown', false);
        check('countdown hidden again', state().label === '');
        set('work-interval', 600);
        check('new interval applies at once', near(state().rem, 600));
        set('work-interval', 1200);

        section('Stress and leaks');
        const before = ev('return Main.panel._rightBox.get_n_children();');
        for (let i = 0; i < 40; i++) {
            set('break-mode', i % 2 ? 'banner' : 'fullscreen');
            ev("E._indicator._breakNowItem.activate(null); E.skipBreak();");
        }
        sleep(800);
        s = state();
        check('40 breaks opened and skipped: no grab, no leftovers', s.grab === null && s.actors === 0, s);
        for (let i = 0; i < 25; i++) {
            ev(`Main.extensionManager.disableExtension('${UUID}');`);
            ev(`Main.extensionManager.enableExtension('${UUID}');`);
        }
        sleep(1000);
        const after = ev('return Main.panel._rightBox.get_n_children();');
        check('25 disable/enable rounds leave nothing extra in the top bar', after === before, {before, after});
        s = state();
        check('still exactly one indicator, nothing else on screen', s.indicator === 1 && s.actors === 0, s);

        section('Settings window');
        spawn(['gnome-extensions', 'prefs', UUID]);
        check('settings window opens', waitFor(() => ev(`
            return global.get_window_actors().some(a => a.meta_window.get_title() === 'Eye Break');`), 15000));
        sleep(1000);
        screenshot('prefs');
        ev(`for (const a of global.get_window_actors())
                if (a.meta_window.get_title() === 'Eye Break')
                    a.meta_window.delete(global.get_current_time());`);
        sleep(1000);
        set('break-mode', 'banner');
        set('chime', 'glass');
        sleep(500);

        section('Chimes');
        const players = ['bell', 'wood', 'glass'].flatMap(c => ['start', 'end'].map(w =>
            [`${c}-${w}`, Gio.Subprocess.new(['/usr/bin/pw-play', '--volume=0', `${EXT_DIR}/sounds/${c}-${w}.ogg`],
                Gio.SubprocessFlags.STDERR_SILENCE)]));
        for (const [name, proc] of players) {
            proc.wait(null);
            check(`${name} chime plays`, proc.get_successful());
        }
    }

    section('Logs');
    const shellLog = logProblems(`${WORK}/shell.log`);
    check('no errors or warnings from Eye Break in the shell log', shellLog.ours.length === 0, shellLog.ours.join('\n'));
    for (const line of shellLog.gnome)
        print(`     (GNOME itself, not Eye Break) ${line.slice(0, 150)}`);
    const appLog = logProblems(`${WORK}/bus.log`);
    check('no errors from the settings window', appLog.ours.length === 0, appLog.ours.join('\n'));

    section('Shutdown');
    breakNow();
    // Skip, then disable while the banner or overlay is still fading out.
    ev(`E.skipBreak(); Main.extensionManager.disableExtension('${UUID}');`);
    s = ev(`const ours = a => [a, ...a.get_children()].some(c => (c.style_class ?? '').includes('eyebreak'));
            return {state: ext.state, actors: Main.layoutManager.uiGroup.get_children().filter(ours).length};`);
    check('disable removes everything', s.state !== ACTIVE && s.actors === 0, s);
} catch (e) {
    failures++;
    print(`FAIL test run crashed: ${e.message}\n${e.stack}`);
}

shell.send_signal(15);
shell.wait(null);
print(`\n${passes} passed, ${failures} failed`);
System.exit(failures ? 1 : 0);
