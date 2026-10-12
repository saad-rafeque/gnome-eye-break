// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// Unit tests for the timer state machine. Run with: gjs -m tests/cycle.test.js
import {Cycle, Phase} from '../extension/cycle.js';

let failures = 0;
function check(name, actual, expected) {
    if (actual === expected) {
        print(`ok   ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: expected ${expected}, got ${actual}`);
    }
}

const MIN = 60000;
const make = () => new Cycle({workMs: 20 * MIN, breakMs: 20000, snoozeMs: 5 * MIN});

{
    const c = make();
    check('starts paused', c.phase, Phase.PAUSED);
    check('paused never fires', c.tick(1e9), null);
}

{
    const c = make();
    c.restart(0);
    check('work runs for 20 minutes', c.tick(20 * MIN - 1), null);
    check('break starts at 20 minutes', c.tick(20 * MIN), 'break-start');
    check('in break', c.phase, Phase.BREAK);
    check('break remaining', c.remaining(20 * MIN + 5000), 15000);
    check('break lasts 20 seconds', c.tick(20 * MIN + 19999), null);
    check('break ends', c.tick(20 * MIN + 20000), 'break-end');
    check('back to work', c.phase, Phase.WORK);
    check('next break 20 minutes later', c.endsAt, 40 * MIN + 20000);
}

{
    const c = make();
    c.restart(0);
    check('fullscreen holds the break', c.tick(20 * MIN, {holdBreak: true}), 'held');
    check('held phase', c.phase, Phase.HELD);
    check('still held', c.tick(30 * MIN, {holdBreak: true}), null);
    check('break starts once fullscreen ends', c.tick(31 * MIN), 'break-start');
    check('held break gets its full length', c.endsAt, 31 * MIN + 20000);
}

{
    const c = make();
    c.restart(0);
    c.tick(20 * MIN);
    c.snooze(20 * MIN + 3000);
    check('snooze returns to work', c.phase, Phase.WORK);
    check('snooze lasts 5 minutes', c.tick(25 * MIN + 2999), null);
    check('break after snooze', c.tick(25 * MIN + 3000), 'break-start');
}

{
    const c = make();
    c.restart(0);
    c.pause();
    check('pause stops the timer', c.tick(1e9), null);
    c.restart(50 * MIN);
    check('resume gives a fresh cycle', c.endsAt, 70 * MIN);
}

{
    const c = make();
    c.restart(0);
    c.setDurations({workMs: 30 * MIN, breakMs: 30000, snoozeMs: MIN});
    check('new durations apply on restart', (c.restart(0), c.endsAt), 30 * MIN);
}

{
    const c = make();
    c.restart(1000);
    check('remaining never negative', c.remaining(1e9), 0);
}

{
    const c = make();
    c.restart(0);
    c.tick(20 * MIN, {holdBreak: true});
    c.pause();
    check('pause while held', c.phase, Phase.PAUSED);
    check('held then paused stays quiet', c.tick(1e9), null);
}

{
    const c = make();
    c.restart(0);
    c.startBreak(5 * MIN);
    check('manual break', c.phase, Phase.BREAK);
    check('manual break ends on time', c.tick(5 * MIN + 20000), 'break-end');
    check('a late tick still ends only once', c.tick(5 * MIN + 20001), null);
}

{
    const c = make();
    c.restart(0);
    // A tick that arrives long after the break was due (a stalled main loop)
    // still starts exactly one break, of full length.
    check('late tick starts break', c.tick(60 * MIN), 'break-start');
    check('late break full length', c.remaining(60 * MIN), 20000);
}

if (failures)
    throw new Error(`${failures} check(s) failed`);
print('all checks passed');
