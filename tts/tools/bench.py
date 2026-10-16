"""Measure real-time factor (RTF = seconds to generate / seconds of audio) of the real model on THIS machine, sweeping num_step.
RTF < 1 means faster than real time. On CPU you want the smallest num_step that still sounds good.
usage:  python tools/bench.py [--steps 6 8 12 16 32] [--speaker Mohamed] [--save out_dir]"""
import argparse, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from egy_tts.config import Config
from egy_tts.engines import VoiceTutEngine
from egy_tts import audio

TEXTS = ["أهلا بيكم في اللايف", "عندي meeting بكرة الساعة تلاتة ونص، متنساش تيجي", "السعر خمسين جنيه بس والعرض لسه شغال لحد بكرة، اطلب دلوقتي"]
ap = argparse.ArgumentParser(); ap.add_argument("--steps", type=int, nargs="+", default=[6, 8, 12, 16, 32]); ap.add_argument("--speaker", default=None); ap.add_argument("--save")
a = ap.parse_args()
cfg = Config(); eng = VoiceTutEngine(cfg)
t0 = time.time(); eng.load(); print(f"loaded on {eng.device} in {time.time() - t0:.1f}s")
eng.synth("تمام", speaker=a.speaker, num_step=8)                       # warm-up: first call compiles
print(f"{'steps':>5} {'chars':>5} {'audio_s':>8} {'took_s':>7} {'RTF':>6}")
for n in a.steps:
    for i, t in enumerate(TEXTS):
        t1 = time.time(); data, sr = eng.synth(t, speaker=a.speaker, num_step=n); dt = time.time() - t1
        print(f"{n:>5} {len(t):>5} {data.size / sr:>8.2f} {dt:>7.2f} {dt / (data.size / sr):>6.2f}")
        if a.save:
            os.makedirs(a.save, exist_ok=True)
            open(os.path.join(a.save, f"steps{n}_{i}.wav"), "wb").write(audio.to_wav_bytes(data, sr))
