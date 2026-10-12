// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// The 20-20-20 state machine. It has no GNOME imports so it can be
// unit-tested with plain gjs; all times are milliseconds on a monotonic clock.

export const Phase = Object.freeze({
    WORK: 'work',
    // Work time is up, but a fullscreen app is holding the break back.
    HELD: 'held',
    BREAK: 'break',
    PAUSED: 'paused',
});

export class Cycle {
    constructor(durations) {
        this.setDurations(durations);
        this.pause();
    }

    setDurations({workMs, breakMs, snoozeMs}) {
        this.workMs = workMs;
        this.breakMs = breakMs;
        this.snoozeMs = snoozeMs;
    }

    // Starts a fresh work interval. Also used to reset after a lock, sleep or skip.
    restart(now) {
        this._enter(Phase.WORK, now, this.workMs);
    }

    startBreak(now) {
        this._enter(Phase.BREAK, now, this.breakMs);
    }

    snooze(now) {
        this._enter(Phase.WORK, now, this.snoozeMs);
    }

    pause() {
        this._enter(Phase.PAUSED, 0, 0);
    }

    // Moves the machine forward. Returns 'break-start', 'break-end', 'held'
    // or null, depending on what changed.
    tick(now, {holdBreak = false} = {}) {
        switch (this.phase) {
        case Phase.WORK:
            if (now < this.endsAt)
                return null;
            if (holdBreak) {
                this.phase = Phase.HELD;
                return 'held';
            }
            this.startBreak(now);
            return 'break-start';
        case Phase.HELD:
            if (holdBreak)
                return null;
            this.startBreak(now);
            return 'break-start';
        case Phase.BREAK:
            if (now < this.endsAt)
                return null;
            this.restart(now);
            return 'break-end';
        default:
            return null;
        }
    }

    remaining(now) {
        return Math.max(0, this.endsAt - now);
    }

    _enter(phase, now, durationMs) {
        this.phase = phase;
        this.startedAt = now;
        this.endsAt = now + durationMs;
    }
}
