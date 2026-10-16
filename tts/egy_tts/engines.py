"""TTS engines. Every engine is blocking and returns (mono float32 array, sample_rate); the pipeline decides threading,
timeouts and fallback order. Engines:
    voicetut  mohammedaly22/VoiceTut-TTS (Egyptian Arabic + English code-switching; GPU or CPU)
    edge      Microsoft Edge neural voice ar-EG (needs internet + ffmpeg to decode mp3)
    espeak    espeak-ng Arabic (robotic, but offline, instant, always works)
    fake      a tone with realistic length (tests, UI work, load testing)
"""
import asyncio
import os
import shutil
import subprocess
import tempfile
import threading
import time

import numpy as np

from . import audio


class EngineError(Exception):
    pass


CARD_SPEAKERS = ["Mohamed", "Abdelrahman", "Abdullah", "Kamal", "Hossam", "Omar", "Sayed", "Zaki", "Aly", "Essam", "Ahmed",
                 "Asmaa", "Esraa", "Hanan", "Sarah", "Yasmin", "Omnia"]
FEMALE = {"Asmaa", "Esraa", "Hanan", "Sarah", "Yasmin", "Omnia"}


class Engine:
    name = "base"
    keep_latin = True                # False: the text must be arabized first (the voice cannot read English)
    supports_ref = False

    def __init__(self, cfg): self.cfg = cfg
    def available(self) -> bool: return True
    def synth(self, text, speaker=None, speed=1.0, num_step=None, guidance=None, ref=None):
        raise NotImplementedError
    def signature(self, speaker, speed, num_step, guidance, ref_id) -> str:
        """Everything that changes the audio for the same text (part of the cache key)."""
        return f"{self.name}|{speaker}|{speed}|{num_step}|{guidance}|{ref_id}"
    def info(self) -> dict: return {"name": self.name}


# ------------------------------------------------------------------------------------------------ VoiceTut
class VoiceTutEngine(Engine):
    name = "voicetut"
    supports_ref = True

    def __init__(self, cfg):
        super().__init__(cfg)
        self._tts = None
        self.load_error = None
        self.device = "unknown"
        self.load_seconds = None
        self._load_lock = threading.Lock()
        self._speakers = None

    @property
    def loaded(self): return self._tts is not None

    def available(self): return self.load_error is None

    def reset(self):
        """Drop the loaded model so the next use (or load()) reloads it from scratch."""
        with self._load_lock:
            self._tts, self.load_error, self._speakers = None, None, None

    def load(self):
        with self._load_lock:
            if self._tts is not None:
                return self._tts
            try:
                import torch
                if self.cfg.THREADS:
                    torch.set_num_threads(self.cfg.THREADS)
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
                from voicetut_tts import VoiceTutTTS
                t0 = time.time()
                try:                                                  # the model card documents from_pretrained(repo); device kw is best-effort
                    self._tts = VoiceTutTTS.from_pretrained(self.cfg.REPO, device=self.device)
                except TypeError:
                    self._tts = VoiceTutTTS.from_pretrained(self.cfg.REPO)
                self.load_seconds = round(time.time() - t0, 1)
                self.load_error = None
                return self._tts
            except Exception as e:
                self.load_error = f"{type(e).__name__}: {e}"
                raise EngineError(self.load_error) from e

    def default_steps(self):
        if self.cfg.NUM_STEP != "auto":
            return int(self.cfg.NUM_STEP)
        return 32 if self.device == "cuda" else 12

    def signature(self, speaker, speed, num_step, guidance, ref_id):
        return super().signature(speaker, speed, num_step or self.default_steps(), guidance or self.cfg.GUIDANCE, ref_id)

    def synth(self, text, speaker=None, speed=1.0, num_step=None, guidance=None, ref=None):
        tts = self.load()
        has_text = bool(ref and ref[1] and ref[1].strip(" ."))       # a recording with no transcript: let the model transcribe it itself
        voice = ({"ref_audio": ref[0], **({"ref_text": ref[1]} if has_text else {})} if ref else {"speaker": speaker or self.cfg.SPEAKER})
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out.wav")
            kw = dict(num_step=num_step or self.default_steps(), guidance_scale=guidance or self.cfg.GUIDANCE, speed=speed or self.cfg.SPEED, output=out)
            try:
                try:
                    tts.synthesize(text, **kw, **voice)
                except TypeError as e:
                    if not (ref and not has_text and "ref_text" in str(e)): raise
                    tts.synthesize(text, **kw, ref_audio=ref[0], ref_text=".")      # this model version insists on a transcript
                return audio.read_wav(out)
            except Exception as e:
                raise EngineError(f"{type(e).__name__}: {e}") from e

    def speakers(self):
        if self._speakers is not None:
            return self._speakers
        out = []
        try:
            for s in self.load().list_speakers():
                g = lambda k, d=None: (s.get(k, d) if isinstance(s, dict) else getattr(s, k, d))
                out.append({"name": g("name") or str(s), "gender": g("gender"), "tags": g("tags") or []})
            self._speakers = out
        except Exception:
            return [{"name": n, "gender": "female" if n in FEMALE else "male", "tags": []} for n in CARD_SPEAKERS]
        return out

    def info(self):
        return {"name": self.name, "loaded": self.loaded, "device": self.device, "error": self.load_error,
                "load_seconds": self.load_seconds, "repo": self.cfg.REPO, "num_step": self.default_steps()}


# ------------------------------------------------------------------------------------------------ Edge
class EdgeEngine(Engine):
    name = "edge"
    keep_latin = False

    def available(self):
        try:
            import edge_tts  # noqa: F401
        except ImportError:
            return False
        return shutil.which("ffmpeg") is not None

    def signature(self, speaker, speed, num_step, guidance, ref_id):
        return f"edge|{self.cfg.EDGE_VOICE}|{speed}"

    def synth(self, text, speaker=None, speed=1.0, num_step=None, guidance=None, ref=None):
        import edge_tts
        rate = f"{int(round((float(speed or 1.0) - 1) * 100)):+d}%"

        async def run():
            mp3 = bytearray()
            async for m in edge_tts.Communicate(text, self.cfg.EDGE_VOICE, rate=rate).stream():
                if m["type"] == "audio":
                    mp3.extend(m["data"])
            return bytes(mp3)
        try:
            mp3 = asyncio.run(run())                                   # engines run in worker threads: no running loop here
            if not mp3:
                raise EngineError("edge returned no audio")
            p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "wav", "-ac", "1", "-ar", "24000", "pipe:1"],
                               input=mp3, capture_output=True, timeout=20)
            if p.returncode:
                raise EngineError("ffmpeg: " + p.stderr.decode("utf-8", "ignore")[:160])
            return audio.read_wav(p.stdout)
        except EngineError:
            raise
        except Exception as e:
            raise EngineError(f"{type(e).__name__}: {e}") from e


# ------------------------------------------------------------------------------------------------ espeak
class EspeakEngine(Engine):
    name = "espeak"
    keep_latin = False

    def available(self): return shutil.which("espeak-ng") is not None

    def signature(self, speaker, speed, num_step, guidance, ref_id):
        return f"espeak|{self.cfg.ESPEAK_VOICE}|{speed}"

    def synth(self, text, speaker=None, speed=1.0, num_step=None, guidance=None, ref=None):
        wpm = int(160 * float(speed or 1.0))
        try:
            p = subprocess.run(["espeak-ng", "-v", self.cfg.ESPEAK_VOICE, "-s", str(wpm), "--stdout", text],
                               capture_output=True, timeout=15)
            if p.returncode or len(p.stdout) < 100:
                raise EngineError("espeak-ng failed: " + p.stderr.decode("utf-8", "ignore")[:160])
            return audio.read_wav(p.stdout)
        except EngineError:
            raise
        except Exception as e:
            raise EngineError(f"{type(e).__name__}: {e}") from e


# ------------------------------------------------------------------------------------------------ fake
class FakeEngine(Engine):
    name = "fake"

    def synth(self, text, speaker=None, speed=1.0, num_step=None, guidance=None, ref=None):
        sr = 24000
        dur = max(0.5, 0.06 * len(text)) / float(speed or 1.0)
        time.sleep(dur * self.cfg.FAKE_RTF)                            # pretend to work
        t = np.arange(int(sr * (dur + 0.3))) / sr
        wave = 0.3 * np.sin(2 * np.pi * 180 * t) * (np.sin(2 * np.pi * 3 * t) > -0.3)
        wave[: int(sr * 0.15)] = 0; wave[-int(sr * 0.15):] = 0         # silent edges so the trimmer has something to do
        return wave.astype("float32"), sr


ENGINE_CLASSES = {"voicetut": VoiceTutEngine, "edge": EdgeEngine, "espeak": EspeakEngine, "fake": FakeEngine}
