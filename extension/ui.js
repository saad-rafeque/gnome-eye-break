// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// On-screen pieces: the break banner and the fullscreen break overlay.
// Nothing is on screen between breaks.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// How often the drain bar and ring are redrawn during a break. They are set
// from the clock rather than animated: a long Clutter animation can jump
// ahead when the screen has been idle.
const BREAK_REDRAW_MS = 100;
// Close a break UI on its own this long after it should have ended, so a
// stuck timer can never leave the screen covered.
const FAILSAFE_MS = 5000;

const TIPS = [
    'A window, a far wall or the end of the corridor all work.',
    'Blink slowly a few times while you look away.',
    'Let your shoulders drop and unclench your jaw.',
    'Let your eyes soften. There is nothing to read out there.',
    'Breathe out slowly while you look into the distance.',
];

// Break UIs still fading out after they closed, each with its fallback
// timer. disable() removes them at once.
const fadingActors = new Map();

export function destroyFadingActors() {
    for (const actor of [...fadingActors.keys()])
        actor.destroy();
}

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

const pickTip = () => TIPS[Math.floor(Math.random() * TIPS.length)];

const nowMs = () => GLib.get_monotonic_time() / 1000;

export const secondsLeft = ms => Math.ceil(ms / 1000);

export function formatClock(ms) {
    const total = secondsLeft(ms);
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

// Setting a label's text queues a relayout even when it is unchanged.
export function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

function makeButtons({allowSkip, snoozeMinutes, onSkip, onSnooze}, styleClass) {
    const row = new St.BoxLayout({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    if (!allowSkip)
        return row;

    const snooze = new St.Button({
        style_class: 'eyebreak-button',
        label: `Snooze ${snoozeMinutes} min`,
        can_focus: true,
    });
    snooze.connect('clicked', () => onSnooze());

    const skip = new St.Button({
        style_class: 'eyebreak-button eyebreak-button-primary',
        label: 'Skip',
        can_focus: true,
    });
    skip.connect('clicked', () => onSkip());

    row.add_child(snooze);
    row.add_child(skip);
    return row;
}

// Shared lifetime handling for the banner and the overlay.
class BreakView {
    constructor(params) {
        this._params = params;
        this._closed = false;
        this._failsafeId = 0;
        this._redrawId = 0;
        this.actor = null;
    }

    // Subclasses call this once their actor is on screen.
    _startTimers() {
        this._failsafeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.max(0, this._params.endsAt - nowMs()) + FAILSAFE_MS, () => {
                this._failsafeId = 0;
                this.close(false);
                return GLib.SOURCE_REMOVE;
            });
        // Also lets the owner update the countdown and end the break on time.
        this._redrawId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BREAK_REDRAW_MS, () => {
            this._redraw();
            this._params.onRedraw?.();
            if (this._closed) {
                this._redrawId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Fraction of the break still to go, from 1 down to 0.
    _fractionLeft() {
        return Math.max(0, Math.min(1, (this._params.endsAt - nowMs()) / this._params.durationMs));
    }

    close(animate = true) {
        if (this._closed)
            return;
        this._closed = true;
        for (const id of [this._failsafeId, this._redrawId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._failsafeId = this._redrawId = 0;
        this._release();

        const actor = this.actor;
        if (!actor)
            return;
        if (!animate || !actor.mapped) {
            actor.destroy();
            return;
        }
        // Destroy once the fade ends, or after a second in case the fade
        // never runs (an animation can stall while its actor isn't drawn).
        const fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            fadingActors.set(actor, 0);
            actor.destroy();
            return GLib.SOURCE_REMOVE;
        });
        fadingActors.set(actor, fallbackId);
        actor.connect('destroy', () => {
            const id = fadingActors.get(actor);
            if (id)
                GLib.source_remove(id);
            fadingActors.delete(actor);
        });
        actor.reactive = false;
        actor.ease({
            ...this._hiddenProps(),
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (fadingActors.has(actor))
                    actor.destroy();
            },
        });
    }

    _redraw() {}

    // Undo anything that affects the rest of the desktop (grabs, unredirect).
    _release() {}

    _hiddenProps() {
        return {opacity: 0};
    }
}

// Banner mode: a bar across the top of the primary monitor with the countdown.
export class BreakBanner extends BreakView {
    constructor(params) {
        super(params);
        const monitor = Main.layoutManager.primaryMonitor;

        this.actor = new St.BoxLayout({
            style_class: 'eyebreak-banner',
            vertical: true,
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
        });

        const row = new St.BoxLayout({style_class: 'eyebreak-banner-row', x_expand: true});
        row.add_child(new St.Icon({
            gicon: params.gicon,
            style_class: 'eyebreak-banner-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({
            text: 'Look at something 20 feet (6 m) away',
            style_class: 'eyebreak-banner-title',
        }));
        text.add_child(new St.Label({text: pickTip(), style_class: 'eyebreak-banner-hint'}));
        row.add_child(text);

        this._count = new St.Label({style_class: 'eyebreak-banner-count', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._count);
        row.add_child(makeButtons(params, 'eyebreak-banner-buttons'));
        this.actor.add_child(row);

        // A bar along the bottom edge that drains over the break.
        const track = new St.Widget({style_class: 'eyebreak-banner-track', x_expand: true});
        this._bar = new St.Widget({style_class: 'eyebreak-banner-bar'});
        this._barWidth = monitor.width;
        track.add_child(this._bar);
        this.actor.add_child(track);

        this.actor.set({opacity: 0, translation_y: -40 * scaleFactor()});
        Main.layoutManager.addTopChrome(this.actor);
        // Fill in the countdown and bar only once on the stage, where St can style them.
        this.update(nowMs());
        this._redraw();
        // Keep compositing on so the banner also shows over a fullscreen app.
        Meta.disable_unredirect_for_display(global.display);
        this._unredirectDisabled = true;
        this._startTimers();

        this.actor.ease({opacity: 255, translation_y: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _redraw() {
        const width = Math.round(this._barWidth * this._fractionLeft());
        if (width !== this._bar.width)
            this._bar.width = width;
    }

    update(now) {
        if (!this._closed)
            setText(this._count, formatClock(Math.max(0, this._params.endsAt - now)));
    }

    _release() {
        if (this._unredirectDisabled) {
            Meta.enable_unredirect_for_display(global.display);
            this._unredirectDisabled = false;
        }
    }

    _hiddenProps() {
        return {opacity: 0, translation_y: -40 * scaleFactor()};
    }
}

// Fullscreen mode: dims every monitor and takes the keyboard for the break.
export class BreakOverlay extends BreakView {
    constructor(params) {
        super(params);

        this.actor = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });

        const primary = Main.layoutManager.primaryMonitor;
        for (const monitor of Main.layoutManager.monitors) {
            const backdrop = new St.Widget({
                style_class: 'eyebreak-overlay',
                layout_manager: new Clutter.BinLayout(),
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
            });
            if (monitor === primary)
                backdrop.add_child(this._buildContent(params));
            this.actor.add_child(backdrop);
        }

        this.actor.connect('key-press-event', (_actor, event) => {
            if (params.allowSkip && event.get_key_symbol() === Clutter.KEY_Escape) {
                params.onSkip();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addTopChrome(this.actor);
        this.update(nowMs());
        this._startTimers();
        this.actor.ease({opacity: 255, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        // Grab input last, so nothing above can fail and leave it grabbed.
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        if (this._grab.get_seat_state() !== Clutter.GrabState.ALL) {
            // Another grab is active (a menu, a dialog). Show the overlay anyway;
            // it still catches clicks, just not the keyboard.
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    update(now) {
        if (this._count && !this._closed)
            setText(this._count, String(secondsLeft(Math.max(0, this._params.endsAt - now))));
    }

    _redraw() {
        this._ring?.queue_repaint();
    }

    _buildContent(params) {
        const box = new St.BoxLayout({
            style_class: 'eyebreak-overlay-content',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const dial = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._ring = new St.DrawingArea({style_class: 'eyebreak-ring'});
        this._ring.connect('repaint', area => this._paintRing(area));
        this._ring.connect('destroy', () => (this._ring = null));
        dial.add_child(this._ring);

        const countBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._count = new St.Label({style_class: 'eyebreak-overlay-count', x_align: Clutter.ActorAlign.CENTER});
        countBox.add_child(this._count);
        countBox.add_child(new St.Label({
            text: 'seconds',
            style_class: 'eyebreak-overlay-unit',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        dial.add_child(countBox);
        box.add_child(dial);

        box.add_child(new St.Label({
            text: 'Look at something 20 feet (6 m) away',
            style_class: 'eyebreak-overlay-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: pickTip(),
            style_class: 'eyebreak-overlay-hint',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const buttons = makeButtons(params, 'eyebreak-overlay-buttons');
        buttons.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(buttons);

        if (params.allowSkip) {
            box.add_child(new St.Label({
                text: 'Press Esc to skip',
                style_class: 'eyebreak-overlay-footnote',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        return box;
    }

    _paintRing(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const lineWidth = Math.max(2, width * 0.03);
        const radius = Math.min(width, height) / 2 - lineWidth;
        const cx = width / 2;
        const cy = height / 2;
        const fraction = this._fractionLeft();

        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (fraction > 0) {
            cr.setSourceRGBA(0.37, 0.85, 0.78, 1);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * fraction);
            cr.stroke();
        }
        cr.$dispose();
    }

    _release() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }
}
