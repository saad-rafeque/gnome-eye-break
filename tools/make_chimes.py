#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Saad Rafique
"""Synthesises the bundled chimes into extension/sounds/ as small Ogg
Vorbis files. Needs ffmpeg (with libvorbis) for the encoding step.

Each style has a 'start' chime (notes fall: time to relax) and an 'end'
chime (notes rise: back to work).
"""
import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "extension" / "sounds"

# Partials as (frequency ratio, amplitude, decay time in seconds).
STYLES = {
    "bell": {
        "partials": [(1.0, 1.0, 0.9), (2.0, 0.45, 0.55), (3.01, 0.2, 0.35), (4.2, 0.1, 0.22), (5.4, 0.05, 0.15)],
        "start": [880.0, 659.26],
        "end": [659.26, 880.0, 1108.73],
        "gap": 0.17,
    },
    "wood": {
        "partials": [(1.0, 1.0, 0.28), (3.93, 0.35, 0.06), (9.8, 0.08, 0.02)],
        "start": [783.99, 587.33],
        "end": [587.33, 783.99, 987.77],
        "gap": 0.13,
    },
    "glass": {
        "partials": [(1.0, 1.0, 1.3), (1.003, 0.6, 1.3), (2.0, 0.12, 0.5)],
        "start": [1046.5, 783.99],
        "end": [783.99, 1046.5, 1318.51],
        "gap": 0.2,
    },
}


def render(style, notes):
    gap = style["gap"]
    tail = max(decay for _, _, decay in style["partials"]) * 3
    length = int((gap * (len(notes) - 1) + tail) * RATE)
    samples = [0.0] * length
    attack = int(0.004 * RATE)

    for index, freq in enumerate(notes):
        offset = int(index * gap * RATE)
        for ratio, amp, decay in style["partials"]:
            omega = 2 * math.pi * freq * ratio / RATE
            for n in range(length - offset):
                env = math.exp(-n / (decay * RATE))
                if env < 1e-4:
                    break
                if n < attack:
                    env *= n / attack
                samples[offset + n] += amp * env * math.sin(omega * n)

    # Normalise to -6 dBFS and fade the last 50 ms so nothing clicks.
    peak = max(abs(s) for s in samples) or 1.0
    fade = int(0.05 * RATE)
    for n in range(fade):
        samples[length - 1 - n] *= n / fade
    return [s / peak * 0.5 for s in samples]


def write_wav(path, samples):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in samples))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for name, style in STYLES.items():
            for which in ("start", "end"):
                wav = Path(tmp) / f"{name}-{which}.wav"
                write_wav(wav, render(style, style[which]))
                path = OUT / f"{name}-{which}.ogg"
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav),
                                "-c:a", "libvorbis", "-q:a", "4", str(path)], check=True)
                print(path.relative_to(OUT.parent.parent))


if __name__ == "__main__":
    main()
