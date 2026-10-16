#!/usr/bin/env python3
"""Validate Cairo-TTS the DEFAULT way (real model via CairoTTS.from_pretrained(), no mock, no offline stub), then the HTTP service.

  python cairo/validate.py                          # model check, using ../chat/voice/my-voice.wav as the clone
  python cairo/validate.py --url http://127.0.0.1:7860   # ALSO test a running service (what the chat server talks to)
  python cairo/validate.py --threads 1 2 4           # real-time factor per thread count (finds the best budget)

Each generated clip is analysed for the faults seen so far: a faint lead-in before the sentence, a dead/short result,
clipping, a loudness collapse. Exit code 1 if anything fails. Clips are written to ./validate_out/ so you can listen.
"""
import argparse, base64, io, json, os, sys, time, urllib.request, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SENTENCES = [
    "اهلا بيكم في اللايف، النهارده هنتكلم عن حاجات حلوة قوي.",
    "الـ meeting بتاعنا بكرة الصبح الساعة تسعة، متنساش.",
    "ازيك يا صاحبي؟ عامل ايه النهارده؟ يارب تكون كويس.",
]


def analyse(x, sr):
    """-> (problems list, stats dict) for a float32 mono clip."""
    probs = []
    if x.size < sr * 0.8:
        return ["clip shorter than 0.8 s"], {}
    hop = int(sr * 0.02); n = x.size // hop
    env = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12); top = env.max()
    if top < 0.01:
        probs.append("almost silent")
    if np.mean(np.abs(x) > 0.999) > 0.001:
        probs.append("clipping")
    quiet = env < top * 0.004
    # lead-in: first sound block, then a gap >= 250 ms, much quieter than the rest
    first = int(np.argmax(~quiet)); run = 0; start = None
    for i in range(first, n):
        if quiet[i]:
            run += 1
            if run >= 13 and start is None: start = i - run + 1
        else:
            if start is not None:
                rest, lead = env[i:], env[first:start]
                if lead.size > 3 and rest.size > 50:
                    d = 20 * np.log10(np.percentile(rest[rest > top * .004], 90) / max(np.percentile(lead[lead > top * .004], 90), 1e-9))
                    if d >= 9 and start * 0.02 < 3.0: probs.append(f"faint lead-in {first*20}-{start*20} ms, {d:.0f} dB below the sentence")
                break
    # loudness collapse: last third much quieter than the middle
    t = n // 3
    if t > 10:
        a, b = np.percentile(env[t:2 * t], 90), np.percentile(env[2 * t:], 90)
        if b < a * 0.1 and env[2 * t:].max() > top * 0.004: probs.append("loudness collapse toward the end")
    return probs, {"sec": round(x.size / sr, 2), "peak": round(float(np.abs(x).max()), 3)}


def read_wav_bytes(b):
    with wave.open(io.BytesIO(b)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype("float32") / 32768, w.getframerate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url"); ap.add_argument("--token", default=os.environ.get("VOICETUT_TOKEN", ""))
    ap.add_argument("--voice", default=os.path.join(HERE, "..", "chat", "voice", "my-voice.wav"))
    ap.add_argument("--threads", type=int, nargs="*", default=[])
    a = ap.parse_args()
    os.makedirs("validate_out", exist_ok=True)
    failed = 0
    import soundfile as sf

    from cairo_tts import CairoTTS                       # the real package ...
    t0 = time.time(); tts = CairoTTS.from_pretrained()   # ... and the DEFAULT load path (hub download/cache, default repo, cpu)
    print(f"loaded {tts!r} in {time.time()-t0:.1f}s, sr={tts.sample_rate}, presets={[v['id'] for v in tts.voices()][:6]}...")
    voices = [("preset-default", None)]
    if os.path.exists(a.voice): voices.append(("my-voice-clone", a.voice))
    else: print("NOTE: no", a.voice, "- skipping the clone test")
    for label, v in voices:
        for i, s in enumerate(SENTENCES):
            t = time.time(); x = tts.generate(s, v); took = time.time() - t
            probs, st = analyse(x, tts.sample_rate)
            sf.write(f"validate_out/{label}-{i}.wav", x, tts.sample_rate)
            print(("FAIL " if probs else "ok   ") + f"{label} #{i}: {st} RTF={took/max(st.get('sec',1),.01):.2f} {probs}")
            failed += bool(probs)
    for n in a.threads:
        import torch; torch.set_num_threads(n); t = time.time(); x = tts.generate(SENTENCES[0], None)
        print(f"threads={n}: {len(x)/tts.sample_rate/(time.time()-t):.2f}x real time")

    if a.url:
        def call(path, body=None, method=None):
            h = {"Content-Type": "application/json"}; h.update({"Authorization": "Bearer " + a.token} if a.token else {})
            r = urllib.request.Request(a.url.rstrip("/") + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
            return urllib.request.urlopen(r, timeout=120)
        print("health:", json.loads(call("/health").read()))
        ref = "a1b2c3d4e5f6a7b8"
        if os.path.exists(a.voice):
            call("/ref/" + ref, {"audio_b64": base64.b64encode(open(a.voice, "rb").read()).decode()}, "PUT")
        for i, s in enumerate(SENTENCES):
            r = call("/tts", {"text": s, **({"ref_id": ref} if os.path.exists(a.voice) else {})})
            x, sr = read_wav_bytes(r.read()); probs, st = analyse(x, sr)
            print(("FAIL " if probs else "ok   ") + f"service #{i}: {st} lead-trim={r.headers['X-Trim-Lead-Ms']}ms {probs}")
            failed += bool(probs)
    print("RESULT:", "FAILED" if failed else "all clips clean")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
