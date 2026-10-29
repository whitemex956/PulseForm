#!/usr/bin/env python3
"""Synthesize three license-free test tracks with known ground truth.

Outputs (in test-audio/):
  ambient.wav   - beatless pads, slow swells (low energy)
  house.wav     - 124 BPM four-on-the-floor with breakdown/build/drop
  energy.wav    - 150 BPM high-energy track with two build/drop cycles
  ground_truth.json - tempo, beat grid, section boundaries and drop times

Everything here is generated from oscillators and noise, so the audio is
original and free to use for testing and demos.

Usage: python3 tools/synth_test_tracks.py [out_dir]
"""
import json
import os
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter

SR = 44100
RNG = np.random.default_rng(1234)


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def lowpass(x, cutoff, order=2):
    b, a = butter(order, min(cutoff / (SR / 2), 0.99), btype="low")
    return lfilter(b, a, x)


def highpass(x, cutoff, order=2):
    b, a = butter(order, min(cutoff / (SR / 2), 0.99), btype="high")
    return lfilter(b, a, x)


def bandpass(x, lo, hi, order=2):
    b, a = butter(order, [lo / (SR / 2), min(hi / (SR / 2), 0.99)], btype="band")
    return lfilter(b, a, x)


def saw(freq, t, detune_cents=(0,)):
    out = np.zeros_like(t)
    for c in detune_cents:
        f = freq * 2 ** (c / 1200)
        phase = RNG.random()
        out += 2 * ((f * t + phase) % 1.0) - 1
    return out / len(detune_cents)


def env_adsr(n, a, d, s, r, sr=SR):
    a_n, d_n, r_n = int(a * sr), int(d * sr), int(r * sr)
    s_n = max(n - a_n - d_n - r_n, 0)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(s_n, s),
        np.linspace(s, 0, r_n),
    ])
    return e[:n] if len(e) >= n else np.pad(e, (0, n - len(e)))


def place(buf, sig, start_s, gain=1.0):
    i = int(round(start_s * SR))
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += gain * sig[: j - i]


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


# ---------- drum voices ----------

def kick(punch=1.0):
    dur = 0.45
    t = t_axis(dur)
    f = 45 + 110 * np.exp(-t * 35)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = highpass(RNG.standard_normal(len(t)), 2000) * np.exp(-t * 300) * 0.3
    return np.tanh((body + click) * 1.6 * punch)


def snare():
    dur = 0.25
    t = t_axis(dur)
    noise = bandpass(RNG.standard_normal(len(t)), 1500, 9000) * np.exp(-t * 18)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
    return 0.8 * noise + 0.4 * tone


def clap():
    dur = 0.3
    t = t_axis(dur)
    n = bandpass(RNG.standard_normal(len(t)), 900, 5000)
    e = np.zeros_like(t)
    for k, off in enumerate([0, 0.011, 0.023]):
        e += np.where(t >= off, np.exp(-(t - off) * (60 if k < 2 else 14)), 0)
    return n * e * 0.6


def hat(open_=False):
    dur = 0.25 if open_ else 0.06
    t = t_axis(dur)
    n = highpass(RNG.standard_normal(len(t)), 7000, order=4)
    return n * np.exp(-t * (12 if open_ else 70)) * 0.35


# ---------- tonal voices ----------

def pad(notes, dur, cutoff=1200, attack=2.0, release=2.0):
    t = t_axis(dur)
    sig = sum(saw(midi(n), t, (-9, -3, 4, 10)) for n in notes) / len(notes)
    sig = lowpass(sig, cutoff, order=2)
    return sig * env_adsr(len(t), attack, 0.5, 0.85, release)


def pluck(note, dur=0.25, cutoff=3000):
    t = t_axis(dur)
    sig = saw(midi(note), t, (-6, 6))
    sig = lowpass(sig, cutoff)
    return sig * np.exp(-t * 9)


def bass(note, dur, drive=1.0):
    t = t_axis(dur)
    f = midi(note)
    sig = np.sin(2 * np.pi * f * t) + 0.5 * saw(f, t)
    sig = lowpass(sig, 400 + 600 * drive)
    return np.tanh(sig * (1 + 2 * drive)) * env_adsr(len(t), 0.005, 0.05, 0.8, 0.03)


def supersaw(notes, dur, cutoff=6000):
    t = t_axis(dur)
    sig = sum(saw(midi(n), t, (-25, -12, -5, 0, 5, 12, 25)) for n in notes) / len(notes)
    return lowpass(sig, cutoff) * env_adsr(len(t), 0.01, 0.1, 0.9, 0.05)


def riser(dur, f0=300, f1=8000):
    t = t_axis(dur)
    n = RNG.standard_normal(len(t))
    out = np.zeros_like(t)
    # piecewise band-passed noise with rising center frequency
    seg = int(0.05 * SR)
    for i in range(0, len(t), seg):
        frac = i / len(t)
        fc = f0 * (f1 / f0) ** frac
        chunk = n[i:i + seg]
        out[i:i + seg] = bandpass(chunk, fc * 0.7, min(fc * 1.4, SR / 2 - 100))
    return out * np.linspace(0.05, 1, len(t)) ** 2


def normalize(x, peak_db=-1.0):
    peak = np.max(np.abs(x)) + 1e-9
    return x / peak * 10 ** (peak_db / 20)


def to_stereo(x, width_noise=0.0):
    l = x.copy()
    r = x.copy()
    if width_noise:
        d = int(0.012 * SR)
        r = np.concatenate([np.zeros(d), x[:-d]]) * 0.6 + x * 0.4
    return np.stack([l, r], axis=1)


# ---------- tracks ----------

def make_ambient():
    dur = 80.0
    buf = np.zeros(int(dur * SR))
    prog = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]  # Am F C G
    chord_len = 10.0
    for i in range(int(dur / chord_len)):
        start = i * chord_len
        cutoff = 700 + 500 * np.sin(i * 0.9) ** 2
        place(buf, pad(prog[i % 4], chord_len + 3, cutoff=cutoff, attack=3.5, release=3.0), start, 0.5)
    # sparse high bell tones, irregular timing (no steady pulse)
    times = np.cumsum(RNG.uniform(2.3, 5.1, 30))
    for k, tt in enumerate(times):
        if tt > dur - 3:
            break
        t = t_axis(3.0)
        n = [76, 79, 81, 84, 88][k % 5]
        tone = np.sin(2 * np.pi * midi(n) * t) * np.exp(-t * 1.4) * 0.12
        place(buf, tone, tt)
    # wind texture
    wind = lowpass(RNG.standard_normal(len(buf)), 900) * (0.03 + 0.02 * np.sin(2 * np.pi * t_axis(dur) / 17))
    buf += wind
    # global fade in/out and gentle swell
    tt = t_axis(dur)
    buf *= np.clip(tt / 6, 0, 1) * np.clip((dur - tt) / 6, 0, 1) * (0.75 + 0.25 * np.sin(2 * np.pi * tt / 40 - 1.5))
    gt = {
        "name": "ambient",
        "duration": dur,
        "bpm": None,
        "has_pulse": False,
        "sections": [{"start": 0.0, "end": dur, "label": "ambient"}],
        "drops": [],
        "expected": {"energy": "low", "brightness": "dark"},
    }
    return normalize(buf, -6.0), gt


def drum_pattern(buf, start, bars, bpm, kick_on=True, hats=True, clap_on=True, kick_gain=1.0, snare_roll=False):
    beat = 60.0 / bpm
    for b in range(bars):
        bar0 = start + b * 4 * beat
        for q in range(4):
            tq = bar0 + q * beat
            if kick_on:
                place(buf, kick(), tq, 0.9 * kick_gain)
            if hats:
                place(buf, hat(open_=True), tq + beat / 2, 0.5)
                place(buf, hat(), tq + beat / 4, 0.25)
                place(buf, hat(), tq + 3 * beat / 4, 0.25)
            if clap_on and q in (1, 3):
                place(buf, clap(), tq, 0.7)
    if snare_roll:
        total_beats = bars * 4
        # roll accelerates: quarters -> eighths -> sixteenths
        for i in range(total_beats * 4):
            tb = i / 4
            frac = tb / total_beats
            step = 1.0 if frac < 0.25 else (0.5 if frac < 0.5 else 0.25)
            if abs((tb / step) - round(tb / step)) < 1e-6:
                place(buf, snare(), start + tb * beat, 0.25 + 0.6 * frac)


def make_house():
    bpm = 124.0
    beat = 60.0 / bpm
    bar = 4 * beat
    layout = [("intro", 8), ("groove", 16), ("breakdown", 8), ("build", 8), ("drop", 16), ("outro", 8)]
    total_bars = sum(b for _, b in layout)
    dur = total_bars * bar + 2.0
    buf = np.zeros(int(dur * SR))
    prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
    bass_notes = [45, 41, 36, 43]
    sections = []
    cur = 0.0
    for name, bars in layout:
        start = cur
        for b in range(bars):
            b0 = start + b * bar
            ch = (b // 2) % 4
            if name in ("groove", "drop"):
                for q in range(4):
                    place(buf, bass(bass_notes[ch], beat * 0.45, drive=1.0 if name == "drop" else 0.5), b0 + q * beat + beat / 2, 0.55)
                for s in (0.5, 1.5, 2.75):
                    for n in prog[ch]:
                        place(buf, pluck(n + 12, 0.22, 2500 if name == "groove" else 5000), b0 + s * beat, 0.18)
            if name in ("breakdown", "build"):
                if b % 2 == 0:
                    place(buf, pad(prog[ch], 2 * bar + 1, cutoff=900 if name == "breakdown" else 900 + 3000 * b / bars, attack=0.8, release=1.0), b0, 0.35)
        if name == "intro":
            drum_pattern(buf, start, bars, bpm, clap_on=False)
        elif name == "groove":
            drum_pattern(buf, start, bars, bpm)
        elif name == "breakdown":
            pass
        elif name == "build":
            drum_pattern(buf, start, bars, bpm, kick_on=False, hats=True, clap_on=False, snare_roll=True)
            place(buf, riser(bars * bar), start, 0.35)
        elif name == "drop":
            drum_pattern(buf, start, bars, bpm, kick_gain=1.1)
        elif name == "outro":
            drum_pattern(buf, start, bars, bpm, clap_on=False)
        cur += bars * bar
        sections.append({"start": round(start, 4), "end": round(cur, 4), "label": name})
    tt = t_axis(dur)
    buf *= np.clip((sections[-1]["end"] - tt) / 4 + 1, 0, 1)
    drop_t = [s["start"] for s in sections if s["label"] == "drop"]
    gt = {
        "name": "house",
        "duration": dur,
        "bpm": bpm,
        "first_beat": 0.0,
        "has_pulse": True,
        "sections": sections,
        "drops": drop_t,
        "expected": {"energy": "medium", "brightness": "medium"},
    }
    return normalize(buf, -1.0), gt


def make_energy():
    bpm = 150.0
    beat = 60.0 / bpm
    bar = 4 * beat
    layout = [("intro", 8), ("build", 8), ("drop", 16), ("breakdown", 8), ("build", 8), ("drop", 16), ("outro", 4)]
    total_bars = sum(b for _, b in layout)
    dur = total_bars * bar + 2.0
    buf = np.zeros(int(dur * SR))
    prog = [[62, 65, 69, 74], [58, 62, 65, 70], [60, 64, 67, 72], [57, 61, 64, 69]]  # Dm Bb C A
    bass_notes = [38, 34, 36, 33]
    sections = []
    cur = 0.0
    for name, bars in layout:
        start = cur
        for b in range(bars):
            b0 = start + b * bar
            ch = b % 4
            if name == "drop":
                place(buf, supersaw(prog[ch], bar * 0.98), b0, 0.4)
                for e in range(8):
                    place(buf, bass(bass_notes[ch], beat * 0.4, drive=2.0), b0 + e * beat / 2 + beat / 4, 0.5)
            elif name in ("intro", "breakdown"):
                for e in range(8):
                    n = prog[ch][e % 4] + 12
                    place(buf, pluck(n, 0.18, 2200 if name == "intro" else 4000), b0 + e * beat / 2, 0.22)
            elif name == "build":
                for e in range(8):
                    n = prog[ch][e % 4] + 12
                    place(buf, pluck(n, 0.15, 2000 + 6000 * b / bars), b0 + e * beat / 2, 0.25)
        if name == "intro":
            drum_pattern(buf, start, bars, bpm, kick_on=True, hats=False, clap_on=False, kick_gain=0.6)
        elif name == "build":
            drum_pattern(buf, start, bars, bpm, kick_on=False, hats=True, clap_on=False, snare_roll=True)
            place(buf, riser(bars * bar, 200, 10000), start, 0.45)
        elif name == "drop":
            drum_pattern(buf, start, bars, bpm, kick_gain=1.3)
            place(buf, highpass(RNG.standard_normal(int(1.5 * SR)), 3000) * np.exp(-t_axis(1.5) * 3), start, 0.4)  # impact crash
        elif name == "breakdown":
            drum_pattern(buf, start, bars, bpm, kick_on=False, hats=True, clap_on=False)
        elif name == "outro":
            drum_pattern(buf, start, bars, bpm, clap_on=False, kick_gain=0.8)
        cur += bars * bar
        sections.append({"start": round(start, 4), "end": round(cur, 4), "label": name})
    buf = np.tanh(buf * 1.4)
    drop_t = [s["start"] for s in sections if s["label"] == "drop"]
    gt = {
        "name": "energy",
        "duration": dur,
        "bpm": bpm,
        "first_beat": 0.0,
        "has_pulse": True,
        "sections": sections,
        "drops": drop_t,
        "expected": {"energy": "high", "brightness": "bright"},
    }
    return normalize(buf, -0.5), gt


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "test-audio")
    os.makedirs(out, exist_ok=True)
    truth = {}
    for fn, maker in (("ambient", make_ambient), ("house", make_house), ("energy", make_energy)):
        audio, gt = maker()
        stereo = to_stereo(audio, width_noise=0.3)
        wavfile.write(os.path.join(out, f"{fn}.wav"), SR, (stereo * 32767).astype(np.int16))
        truth[fn] = gt
        print(f"wrote {fn}.wav  {gt['duration']:.1f}s  bpm={gt['bpm']}")
    with open(os.path.join(out, "ground_truth.json"), "w") as f:
        json.dump(truth, f, indent=2)


if __name__ == "__main__":
    main()
