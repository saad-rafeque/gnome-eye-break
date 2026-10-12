// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// Eye Break: the 20-20-20 rule for GNOME Shell. Every 20 minutes, look at
// something 20 feet away for 20 seconds.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Cycle, Phase} from './cycle.js';
import {Indicator} from './indicator.js';
import {playChime} from './sound.js';
import {BreakBanner, BreakOverlay, destroyFadingActors, formatClock, secondsLeft} from './ui.js';

// If wall-clock time runs this far ahead of the monotonic clock between two
// ticks, the machine was asleep (the monotonic clock stops during suspend).
const SLEEP_GAP_US = 30 * GLib.USEC_PER_SEC;
// If we paused for sleep but never heard the machine wake up, restart after
// this much awake time anyway.
const AWAY_GRACE_MS = 60 * 1000;

const nowMs = () => GLib.get_monotonic_time() / 1000;

export default class EyeBreakExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        // Lives on the instance rather than being reset in enable(), so a manual
        // pause survives locking the screen but not logging out.
        this._paused = false;
    }

    enable() {
        this._settings = this.getSettings();
        this._cycle = new Cycle(this._durations());
        this._breakUi = null;
        this._awayAt = 0;

        const iconsDir = this.dir.get_child('icons');
        this.icons = {
            active: new Gio.FileIcon({file: iconsDir.get_child('eyebreak-symbolic.svg')}),
            paused: new Gio.FileIcon({file: iconsDir.get_child('eyebreak-paused-symbolic.svg')}),
        };

        this._indicator = new Indicator(this);
        // On the left of the top bar, beside the app tray icons.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');

        this._settings.connectObject('changed', (_settings, key) => this._onSettingChanged(key), this);
        global.display.connectObject('in-fullscreen-changed', () => this._tick(), this);
        this._sleepSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [goingToSleep] = params.deepUnpack();
                this._onPrepareForSleep(goingToSleep);
            });

        // GNOME disables extensions while the screen is locked or blanked and
        // enables them again afterwards and at login, so this is where a lock,
        // a blank screen or a logout gives you a fresh cycle.
        this._resetAfterAbsence();

        // A seconds timer lets GLib batch this wakeup with others.
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.source_remove(this._tickId);
        this._tickId = 0;
        Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
        this._sleepSignalId = 0;
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._closeBreakUi(false);
        destroyFadingActors();
        this._indicator.destroy();
        this._indicator = null;

        this.icons = null;
        this._cycle = null;
        this._settings = null;
    }

    // Called from the top bar menu.

    setPaused(paused) {
        if (paused === this._paused)
            return;
        this._paused = paused;
        this._closeBreakUi();
        if (paused)
            this._cycle.pause();
        else
            this._cycle.restart(nowMs());
        this.refresh();
    }

    takeBreakNow() {
        if (this._paused || this._cycle.phase === Phase.BREAK)
            return;
        this._cycle.startBreak(nowMs());
        this._openBreakUi();
        this.refresh();
    }

    setMode(mode) {
        this._settings.set_string('break-mode', mode);
    }

    skipBreak() {
        if (this._cycle.phase !== Phase.BREAK)
            return;
        this._closeBreakUi();
        this._cycle.restart(nowMs());
        this.refresh();
    }

    snoozeBreak() {
        if (this._cycle.phase !== Phase.BREAK)
            return;
        this._closeBreakUi();
        this._cycle.snooze(nowMs());
        this.refresh();
    }

    refresh(now = nowMs()) {
        const phase = this._cycle.phase;
        const remaining = this._cycle.remaining(now);
        const working = phase === Phase.WORK || phase === Phase.HELD;

        this._breakUi?.update(now);

        let statusText, panelText;
        switch (phase) {
        case Phase.WORK:
            statusText = `Next break in ${formatClock(remaining)}`;
            panelText = remaining >= 60000 ? `${Math.ceil(remaining / 60000)}m` : `${secondsLeft(remaining)}s`;
            break;
        case Phase.HELD:
            statusText = 'Break waiting for the fullscreen app to close';
            panelText = '0m';
            break;
        case Phase.BREAK:
            statusText = `On a break, ${secondsLeft(remaining)} s left`;
            panelText = `${secondsLeft(remaining)}s`;
            break;
        default:
            statusText = 'Reminders paused';
            panelText = '';
        }

        this._indicator.update({
            paused: this._paused,
            mode: this._settings.get_string('break-mode'),
            canBreakNow: working,
            statusText,
            panelText: this._settings.get_boolean('show-panel-countdown') ? panelText : '',
        });
    }

    _durations() {
        return {
            workMs: this._settings.get_uint('work-interval') * 1000,
            breakMs: this._settings.get_uint('break-duration') * 1000,
            snoozeMs: this._settings.get_uint('snooze-duration') * 1000,
        };
    }

    _tick() {
        // An error here must never stop the timer, so log it and carry on.
        try {
            if (this._sleptSinceLastTick()) {
                this._resetAfterAbsence();
                return;
            }
            // Paused for sleep, but the wake-up signal never came.
            if (this._cycle.phase === Phase.PAUSED && !this._paused &&
                nowMs() - this._awayAt > AWAY_GRACE_MS) {
                this._resetAfterAbsence();
                return;
            }

            const now = nowMs();
            const holdBreak = this._settings.get_boolean('hold-during-fullscreen') &&
                Main.layoutManager.monitors.some(monitor => monitor.inFullscreen);

            switch (this._cycle.tick(now, {holdBreak})) {
            case 'break-start':
                this._openBreakUi();
                break;
            case 'break-end':
                this._closeBreakUi();
                this._chime('end');
                break;
            }
            this.refresh(now);
        } catch (e) {
            logError(e, 'Eye Break');
        }
    }

    // The machine is about to sleep (true) or has just woken up (false).
    _onPrepareForSleep(goingToSleep) {
        if (!goingToSleep) {
            this._resetAfterAbsence();
            return;
        }
        this._closeBreakUi(false);
        this._cycle.pause();
        this._awayAt = nowMs();
        this.refresh();
    }

    // Start over after the screen was locked or blanked, the machine slept or
    // the user logged in. Time away from the screen counts as rest.
    _resetAfterAbsence() {
        this._closeBreakUi(false);
        if (this._paused)
            this._cycle.pause();
        else
            this._cycle.restart(nowMs());
        this._lastWallUs = GLib.get_real_time();
        this._lastMonoUs = GLib.get_monotonic_time();
        this.refresh();
    }

    _sleptSinceLastTick() {
        const wall = GLib.get_real_time();
        const mono = GLib.get_monotonic_time();
        const gap = (wall - this._lastWallUs) - (mono - this._lastMonoUs);
        this._lastWallUs = wall;
        this._lastMonoUs = mono;
        return gap > SLEEP_GAP_US;
    }

    _openBreakUi() {
        this._closeBreakUi(false);
        const snoozeMs = this._settings.get_uint('snooze-duration') * 1000;
        const params = {
            endsAt: this._cycle.endsAt,
            durationMs: this._cycle.endsAt - this._cycle.startedAt,
            allowSkip: this._settings.get_boolean('allow-skip'),
            snoozeMinutes: Math.max(1, Math.round(snoozeMs / 60000)),
            gicon: this.icons.active,
            onSkip: () => this.skipBreak(),
            onSnooze: () => this.snoozeBreak(),
            // The break UI ticks every 100 ms, so the countdown never skips a
            // second and the break ends right on time.
            onRedraw: () => this._tick(),
        };
        try {
            this._breakUi = this._settings.get_string('break-mode') === 'fullscreen'
                ? new BreakOverlay(params)
                : new BreakBanner(params);
        } catch (e) {
            // The break still runs on the timer; it just isn't shown.
            logError(e, 'Eye Break: could not show the break');
        }
        this._chime('start');
    }

    _closeBreakUi(animate = true) {
        this._breakUi?.close(animate);
        this._breakUi = null;
    }

    _chime(which) {
        if (!this._settings.get_boolean('play-sounds'))
            return;
        playChime(this.dir, this._settings.get_string('chime'), which,
            this._settings.get_double('volume'));
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'work-interval':
        case 'break-duration':
        case 'snooze-duration':
            this._cycle.setDurations(this._durations());
            // A new work interval applies straight away; break and snooze
            // lengths apply from the next break.
            if (key === 'work-interval' && this._cycle.phase === Phase.WORK)
                this._cycle.restart(nowMs());
            break;
        }
        this.refresh();
    }
}
